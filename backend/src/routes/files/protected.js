import { ApiStatus, UserType } from "../../constants/index.js";
import {
  getAdminFileList,
  getAdminFileDetail,
  getUserFileList,
  getUserFileDetail,
  updateFile,
  verifyFiles,
} from "../../services/fileService.js";
import { invalidateFsCache } from "../../cache/invalidation.js";
import { useRepositories } from "../../utils/repositories.js";
import { ValidationError } from "../../http/errors.js";
import { getEncryptionSecret, isCloudflareWorkerEnvironment } from "../../utils/environmentUtils.js";
import { getPagination, jsonOk } from "../../utils/common.js";
import { usePolicy } from "../../security/policies/policies.js";
import { resolvePrincipal } from "../../security/helpers/principal.js";

const requireFilesAccess = usePolicy("files.manage");

const getFilesPrincipal = (c) => resolvePrincipal(c, { allowedTypes: [UserType.ADMIN, UserType.API_KEY] });

// 单次检测的条数上限
// - 常规部署（Docker/Node）：200 条，受限于单请求耗时
// - Cloudflare Workers：subrequest 有硬上限（免费 50 / 付费 1000），
//   批量查库后每个文件仍要一次存储请求，再叠加鉴权等开销，
//   200 条必然触发 "Too many subrequests by single Worker invocation"，
//   因此收紧到 20 条，超出时明确提示而不是让整批变成"无法判定"。
const VERIFY_MAX_IDS = 200;
const VERIFY_MAX_IDS_WORKER = 20;

const resolveVerifyMaxIds = () => (isCloudflareWorkerEnvironment() ? VERIFY_MAX_IDS_WORKER : VERIFY_MAX_IDS);

export const registerFilesProtectedRoutes = (router) => {
  router.get("/api/files", requireFilesAccess, async (c) => {
    const db = c.env.DB;
    const { type: userType, userId, apiKeyInfo } = getFilesPrincipal(c);

    let result;

    if (userType === UserType.ADMIN) {
      const { limit, offset } = getPagination(c, { limit: 30 });
      const search = c.req.query("search");
      const createdBy = c.req.query("created_by");

      const options = { limit, offset };
      if (search) options.search = search;
      if (createdBy) options.createdBy = createdBy;

      result = await getAdminFileList(db, options);
    } else {
      const { limit, offset } = getPagination(c, { limit: 30 });
      const search = c.req.query("search");

      const options = { limit, offset };
      if (search) options.search = search;

      result = await getUserFileList(db, userId, options);
    }

    const data = userType === UserType.API_KEY ? { ...result, key_info: apiKeyInfo } : result;
    return jsonOk(c, data, "获取文件列表成功");
  });

  router.get("/api/files/:id", requireFilesAccess, async (c) => {
    const db = c.env.DB;
    const { type: userType, userId } = getFilesPrincipal(c);
    const { id } = c.req.param();
    const encryptionSecret = getEncryptionSecret(c);
    const include = c.req.query("include");
    const linksFlag = c.req.query("links");
    const includeLinks = include === "links" || linksFlag === "true";
    const detailOptions = includeLinks ? { includeLinks: true } : {};

    let result;
    if (userType === UserType.ADMIN) {
      result = await getAdminFileDetail(db, id, encryptionSecret, c.req.raw, detailOptions);
    } else {
      result = await getUserFileDetail(db, id, userId, encryptionSecret, c.req.raw, detailOptions);
    }

    return jsonOk(c, result, "获取文件成功");
  });

  router.delete("/api/files/batch-delete", requireFilesAccess, async (c) => {
    const db = c.env.DB;
    const { type: userType, userId } = getFilesPrincipal(c);
    const body = await c.req.json();
    const ids = body.ids;
    const deleteMode = body.delete_mode || "both";

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      throw new ValidationError("请提供有效的文件ID数组");
    }

    if (!["record_only", "both"].includes(deleteMode)) {
      throw new ValidationError("删除模式必须是 'record_only' 或 'both'");
    }

    const result = { success: 0, failed: [] };
    const storageConfigIds = new Set();
    const encryptionSecret = getEncryptionSecret(c);
    const repositoryFactory = useRepositories(c);
    const fileRepository = repositoryFactory.getFileRepository();

    for (const id of ids) {
    await (async () => {
      let file;

      if (userType === UserType.ADMIN) {
        file = await fileRepository.findByIdWithStorageConfig(id);
        if (!file) {
          result.failed.push({ id, error: "文件不存在" });
          return;
        }
      } else {
        file = await fileRepository.findByIdAndCreator(id, `apikey:${userId}`);
        if (!file) {
          result.failed.push({ id, error: "文件不存在或无权删除" });
          return;
        }
      }

      if (file.storage_config_id) {
        storageConfigIds.add(file.storage_config_id);
      }

      await (async () => {
        if (deleteMode === "both" && file.file_path) {
          const { MountManager } = await import("../../storage/managers/MountManager.js");
          const { FileSystem } = await import("../../storage/fs/FileSystem.js");

          const mountManager = new MountManager(db, encryptionSecret, repositoryFactory, { env: c.env });
          const fileSystem = new FileSystem(mountManager);

          await fileSystem
            .batchRemoveItems([file.file_path], userType === UserType.ADMIN ? userId : `apikey:${userId}`, userType)
            .catch((fsError) => {
              console.error(`删除文件系统文件失败 (ID: ${id}):`, fsError);
            });
        }

        // storage-first 或无 file_path 时，直接按存储配置删除对象（通过 ObjectStore 统一封装）
        if (deleteMode === "both" && file.storage_path && file.storage_config_id) {
          try {
            const { ObjectStore } = await import("../../storage/object/ObjectStore.js");
            const objectStore = new ObjectStore(db, encryptionSecret, repositoryFactory);
            await objectStore.deleteByStoragePath(file.storage_config_id, file.storage_path, { db });
          } catch (deleteError) {
            console.error(`删除存储文件失败 (ID: ${id}):`, deleteError);
          }
        }
      })().catch((deleteError) => {
        console.error(`删除文件存储失败 (ID: ${id}):`, deleteError);
      });

      if (userType === UserType.ADMIN) {
        await fileRepository.deleteFilePasswordRecord(id);
      }
      await fileRepository.deleteFile(id);

      result.success++;
    })().catch((error) => {
      console.error(`删除文件失败 (ID: ${id}):`, error);
      result.failed.push({ id, error: error.message || "删除失败" });
    });
  }

  for (const storageConfigId of storageConfigIds) {
    invalidateFsCache({ storageConfigId, reason: "files-batch-delete", db });
  }

    return jsonOk(c, result, `批量删除完成，成功: ${result.success}，失败: ${result.failed.length}`);
  });

  /**
   * 批量检测文件有效性
   * - 逐条回到存储侧确认对象是否仍存在，区分“对象缺失”与“存储不可达”
   * - 只读接口，不修改任何记录
   */
  router.post("/api/files/verify", requireFilesAccess, async (c) => {
    const db = c.env.DB;
    const { type: userType, userId } = getFilesPrincipal(c);
    const body = await c.req.json().catch(() => ({}));
    const ids = body?.ids;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      throw new ValidationError("请提供有效的文件ID数组");
    }

    const maxIds = resolveVerifyMaxIds();
    if (ids.length > maxIds) {
      // Worker 上不能只提示“太多”，要让调用方知道如何分批：给明确上限与建议
      throw new ValidationError(
        `单次最多检测 ${maxIds} 个文件${maxIds < VERIFY_MAX_IDS ? "（Cloudflare Workers 单次请求 subrequest 配额有限，请分批检测）" : ""}`
      );
    }

    const encryptionSecret = getEncryptionSecret(c);
    const repositoryFactory = useRepositories(c);

    const result = await verifyFiles(db, ids, encryptionSecret, {
      userType,
      userId,
      request: c.req.raw,
      env: c.env,
      repositoryFactory,
    });

    const { summary } = result;
    return jsonOk(
      c,
      result,
      `检测完成，共 ${summary.total} 个：正常 ${summary.valid}，失效 ${summary.invalid}，过期 ${summary.expired}，异常 ${summary.error}`
    );
  });

  router.put("/api/files/:id", requireFilesAccess, async (c) => {
    const db = c.env.DB;
    const { type: userType, userId } = getFilesPrincipal(c);
    const { id } = c.req.param();
    const body = await c.req.json();

    const result = await updateFile(db, id, body, { userType, userId });
    return jsonOk(c, result, result.message);
  });
};
