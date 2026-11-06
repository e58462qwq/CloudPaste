/**
 * 文件服务类
 * 文件业务逻辑，通过Repository访问数据
 */

import { FileRepository } from "../repositories/index.js";
import { GetFileType, getFileTypeName } from "../utils/fileTypeDetector.js";
import { generateUniqueFileSlug, validateSlugFormat } from "../utils/common.js";
import { hashPassword } from "../utils/crypto.js";
import { ApiStatus, DbTables, UserType } from "../constants/index.js";
import { ValidationError, NotFoundError, AuthorizationError, ConflictError } from "../http/errors.js";
import { ensureRepositoryFactory } from "../utils/repositories.js";
import { ObjectStore } from "../storage/object/ObjectStore.js";
import { LinkService } from "../storage/link/LinkService.js";
import { resolvePreviewSelection } from "./documentPreviewService.js";

// 有效性检测默认并发与单条超时
// 逐条串行会让批量检测在慢存储上远超前端请求超时（默认 30s）；
// 一条存储卡死也不应该拖垮整批，因此同时加单条超时保护。
const VERIFY_DEFAULT_CONCURRENCY = 8;
const VERIFY_MAX_CONCURRENCY = 32;
const VERIFY_ITEM_TIMEOUT_MS = 15000;

function withItemTimeout(promise, timeoutMs, message) {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(message);
      error.name = "TimeoutError";
      reject(error);
    }, timeoutMs);
    const handle = timer;
    if (handle && typeof handle.unref === "function") handle.unref();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function normalizeConcurrency(value) {
  const raw = Number.isFinite(value) ? Math.trunc(value) : VERIFY_DEFAULT_CONCURRENCY;
  return Math.min(Math.max(raw, 1), VERIFY_MAX_CONCURRENCY);
}

export class FileService {
  /**
   * 构造函数
   * @param {D1Database} db - 数据库实例
   * @param {string} encryptionSecret - 加密密钥
   * @param {Object} repositoryFactory - 仓储工厂（可选）
   */
  constructor(db, encryptionSecret, repositoryFactory = null) {
    this.db = db;
    this.encryptionSecret = encryptionSecret;
    this.repositoryFactory = ensureRepositoryFactory(db, repositoryFactory);
    this.fileRepository = new FileRepository(db);
  }

  /**
   * 验证文件访问权限 - 纯业务逻辑
   * @param {Object} file - 文件对象
   * @returns {Object} 包含accessible和reason的对象
   */
  validateFileAccess(file) {
    if (!file) {
      return { accessible: false, reason: "not_found" };
    }

    // 检查文件是否已过期
    if (file.expires_at) {
      const expiryDate = new Date(file.expires_at);
      const now = new Date();
      if (now > expiryDate) {
        return { accessible: false, reason: "expired" };
      }
    }

    // 检查文件访问次数是否超过限制
    if (file.max_views !== null && file.max_views > 0) {
      if (file.views > file.max_views) {
        return { accessible: false, reason: "expired" };
      }
    }

    return { accessible: true };
  }

  /**
   * 根据slug获取文件完整信息
   * @param {string} slug - 文件slug
   * @returns {Promise<Object>} 文件对象
   * @throws {ValidationError|NotFoundError}
   */
  async getFileBySlug(slug) {
    if (!slug) {
      throw new ValidationError("缺少文件slug参数");
    }

    const file = await this.fileRepository.findBySlugWithStorageConfig(slug);

    if (!file) {
      throw new NotFoundError("文件不存在");
    }

    return file;
  }

  /**
   * 检查文件是否可访问
   * @param {Object} file - 文件对象
   * @returns {Object} 包含accessible和reason的对象
   */
  isFileAccessible(file) {
    return this.validateFileAccess(file);
  }

  /**
   * 增加文件查看次数并检查是否超过限制
   * @param {string} slug - 文件slug
   * @returns {Promise<Object>} 包含isExpired和file的对象
   */
  async incrementAndCheckFileViews(slug) {
    // 获取文件信息
    const file = await this.getFileBySlug(slug);

    // 增加views计数
    await this.fileRepository.incrementViews(file.id);

    // 重新获取文件信息，包括更新后的views计数
    const updatedFile = await this.fileRepository.findBySlugWithStorageConfig(slug);

    // 检查是否达到最大查看次数限制
    const accessResult = this.validateFileAccess(updatedFile);

    return {
      isExpired: !accessResult.accessible,
      file: updatedFile,
    };
  }


  /**
   * 分享层统一 guard：
   * - 根据 slug 获取文件记录
   * - 校验过期/最大访问次数
   * - 在需要时递增 views 并处理过期删除
   * - 可选择是否在本次调用中递增 views
   * @param {string} slug
   * @param {Object} [options]
   * @param {boolean} [options.incrementViews] 是否在本次调用中递增浏览次数
   * @returns {Promise<{ file: any, isExpired: boolean }>}
   */
  async guardShareFile(slug, options = {}) {
    const { incrementViews = false } = options;

    // 统一获取文件记录
    const file = await this.getFileBySlug(slug);

    if (!incrementViews) {
      const accessResult = this.validateFileAccess(file);
      return {
        file,
        isExpired: !accessResult.accessible,
      };
    }

    // 需要递增视图时复用 incrementAndCheckFileViews 的逻辑
    return await this.incrementAndCheckFileViews(slug);
  }

  /**
   * 获取文件的公开信息（分享视图 JSON）
   * - 统一返回语义明确的 previewUrl / downloadUrl
   * - previewUrl：inline 语义入口（直链 / url_proxy / 本地 /api/s）
   * - downloadUrl：attachment 语义入口（直链下载 / url_proxy 下载 / 本地 /api/s?down=true）
   * @param {Object} file - 文件对象
   * @param {boolean} requiresPassword - 是否需要密码
   * @param {import("../storage/link/LinkTypes.js").StorageLink|null} link - 由 LinkService 生成的 StorageLink
   * @param {{ baseOrigin?: string }=} options - 额外选项（如当前请求的后端 Origin）
   * @returns {Promise<Object>} 公开文件信息
   */
  async getPublicFileInfo(file, requiresPassword, link = null, options = {}) {
    // 获取文件类型（用于前端预览类型判断）
    const fileType = await GetFileType(file.filename, this.db);
    const fileTypeName = await getFileTypeName(file.filename, this.db);

    const useProxyFlag = file.use_proxy ?? 0;
    const storageUrlProxy = file.url_proxy || null;

    const baseOrigin = options.baseOrigin || null;

    // LinkService 已经根据 use_proxy / url_proxy / 直链能力生成了预览入口（link）
    const previewLink = link;
    let previewUrl = previewLink && previewLink.url ? previewLink.url : null;

    // 下载入口
    const linkService = new LinkService(this.db, this.encryptionSecret, this.repositoryFactory);
    const downloadLink = await linkService.getShareExternalLink(file, null, { forceDownload: true });
    let downloadUrl = downloadLink && downloadLink.url ? downloadLink.url : null;

    let linkType = "proxy";
    if (useProxyFlag) {
      linkType = "proxy";
    } else if (storageUrlProxy && previewUrl) {
      linkType = "url_proxy";
    } else if (previewLink && previewLink.kind === "direct" && previewUrl) {
      linkType = "direct";
    } else if (previewUrl) {
      linkType = "proxy";
    } else {
      linkType = "direct";
    }

    // 若提供了 baseOrigin，则仅对本地相对路径补全为绝对 URL
    if (previewUrl && baseOrigin && previewUrl.startsWith("/")) {
      previewUrl = `${baseOrigin}${previewUrl}`;
    }
    if (downloadUrl && baseOrigin && downloadUrl.startsWith("/")) {
      downloadUrl = `${baseOrigin}${downloadUrl}`;
    }

    // 受密码保护且未校验通过：不在 JSON 中暴露任何可直接访问的 URL
    if (requiresPassword) {
      previewUrl = null;
      downloadUrl = null;
    }

    // 基于文件信息和 Link JSON 生成预览选择结果（preview_providers 驱动）
    const previewSelection = await resolvePreviewSelection(
      {
        type: fileType,
        typeName: fileTypeName,
        mimetype: file.mimetype,
        filename: file.filename,
        size: file.size,
      },
      {
        previewUrl,
        downloadUrl,
        linkType,
        use_proxy: useProxyFlag,
      },
    );

    return {
      id: file.id,
      slug: file.slug,
      filename: file.filename,
      mimetype: file.mimetype,
      size: file.size,
      remark: file.remark,
      created_at: file.created_at,
      requires_password: requiresPassword,
      views: file.views,
      max_views: file.max_views,
      expires_at: file.expires_at,
      previewUrl,
      downloadUrl,
      linkType,
      use_proxy: useProxyFlag,
      created_by: file.created_by || null,
      type: fileType, // 整数类型常量 (0-6)
      typeName: fileTypeName, // 类型名称（用于调试）
      previewSelection,
    };
  }

  /**
   * 根据存储路径删除文件记录
   * @param {string} storageConfigId - 存储配置ID
   * @param {string} storagePath - 存储路径
   * @param {string} storageType - 存储类型
   * @returns {Promise<Object>} 删除结果，包含deletedCount字段
   */
  async deleteFileRecordByStoragePath(storageConfigId, storagePath, storageType) {
    return await this.fileRepository.deleteByStorageConfigPath(storageConfigId, storagePath, storageType);
  }

  /**
   * 创建文件记录
   * @param {Object} fileData - 文件数据
   * @returns {Promise<Object>} 创建结果
   */
  async createFileRecord(fileData) {
    return await this.fileRepository.createFile(fileData);
  }

  /**
   * 更新文件记录
   * @param {string} fileId - 文件ID
   * @param {Object} updateData - 更新数据
   * @returns {Promise<Object>} 更新结果
   */
  async updateFileRecord(fileId, updateData) {
    return await this.fileRepository.updateFile(fileId, updateData);
  }

  /**
   * 更新文件元数据（业务逻辑层）
   * @param {string} fileId - 文件ID
   * @param {Object} updateData - 更新数据
   * @param {Object} userInfo - 用户信息
   * @param {string} userInfo.userType - 用户类型 ("admin" | "apikey")
   * @param {string} userInfo.userId - 用户ID
   * @returns {Promise<Object>} 更新结果
   */
  async updateFile(fileId, updateData, userInfo) {
    const { userType, userId } = userInfo;

    // 检查文件是否存在并验证权限
    let existingFile;
    if (userType === UserType.ADMIN) {
      // 管理员：可以更新任何文件
      existingFile = await this.fileRepository.findById(fileId);
      if (!existingFile) {
        throw new NotFoundError("文件不存在");
      }
    } else {
      // API密钥用户：只能更新自己的文件
      existingFile = await this.fileRepository.findOne(DbTables.FILES, {
        id: fileId,
        created_by: `apikey:${userId}`,
      });
      if (!existingFile) {
        throw new NotFoundError("文件不存在或无权更新");
      }
    }

    // 构建更新数据对象
    const finalUpdateData = {};

    // 处理可更新的字段
    if (updateData.remark !== undefined) {
      finalUpdateData.remark = updateData.remark;
    }

    // 处理 slug 更新（包含格式校验和冲突检查）
    if (updateData.slug !== undefined) {
      if (!updateData.slug) {
        finalUpdateData.slug = await generateUniqueFileSlug(this.db, null, false, null);
      } else {
        await this._validateAndProcessSlug(updateData.slug, fileId, userType);
        finalUpdateData.slug = updateData.slug;
      }
    }

    // 处理过期时间
    if (updateData.expires_at !== undefined) {
      finalUpdateData.expires_at = updateData.expires_at;
    }

    // 处理Worker代理访问设置
    if (updateData.use_proxy !== undefined) {
      finalUpdateData.use_proxy = updateData.use_proxy ? 1 : 0;
    }

    // 处理最大查看次数
    if (updateData.max_views !== undefined) {
      finalUpdateData.max_views = updateData.max_views;
      finalUpdateData.views = 0; // 当修改max_views时，重置views计数为0
    }

    // 处理密码变更
    if (updateData.password !== undefined) {
      await this._processPasswordUpdate(fileId, updateData.password, finalUpdateData);
    }

    // 如果没有要更新的字段（API密钥用户需要检查）
    if (userType === UserType.API_KEY && Object.keys(finalUpdateData).length === 0) {
      throw new ValidationError("没有提供有效的更新字段");
    }

    // 添加更新时间
    finalUpdateData.updated_at = new Date().toISOString();

    // 使用 Repository 更新文件
    await this.fileRepository.updateFile(fileId, finalUpdateData);

    return {
      success: true,
      message: "文件元数据更新成功",
      slug: finalUpdateData.slug ?? existingFile.slug,
    };
  }

  /**
   * 验证并处理 slug 更新
   * @private
   * @param {string} slug - 新的 slug
   * @param {string} fileId - 文件ID
   * @param {string} userType - 用户类型
   */
  async _validateAndProcessSlug(slug, fileId, userType) {
    // 格式校验：只允许字母、数字、连字符、下划线、点号
    if (slug && !validateSlugFormat(slug)) {
      throw new ValidationError("链接后缀格式无效，只能使用字母、数字、下划线、横杠和点号");
    }

    // 检查slug是否可用 (不与其他文件冲突)
    let slugExistsCheck;
    if (userType === UserType.ADMIN) {
      slugExistsCheck = await this.fileRepository.findBySlug(slug);
      if (slugExistsCheck && slugExistsCheck.id !== fileId) {
        throw new ConflictError("此链接后缀已被其他文件使用");
      }
    } else {
      slugExistsCheck = await this.fileRepository.findBySlugExcludingId(slug, fileId);
      if (slugExistsCheck) {
        throw new ConflictError("此链接后缀已被其他文件使用");
      }
    }
  }

  /**
   * 处理密码更新
   * @private
   * @param {string} fileId - 文件ID
   * @param {string} password - 新密码（可能为空字符串表示清除）
   * @param {Object} updateData - 更新数据对象（引用传递）
   */
  async _processPasswordUpdate(fileId, password, updateData) {
    if (password) {
      // 设置新密码
      const passwordHash = await hashPassword(password);
      updateData.password = passwordHash;

      // 使用 FileRepository 更新或插入明文密码
      await this.fileRepository.upsertFilePasswordRecord(fileId, password);
    } else {
      // 明确提供了空密码，表示要清除密码
      updateData.password = null;

      // 使用 FileRepository 删除明文密码记录
      await this.fileRepository.deleteFilePasswordRecord(fileId);
    }
  }

  /**
   * 获取文件列表（管理员）
   * @param {Object} options - 查询选项
   * @param {number} options.limit - 每页条数
   * @param {number} options.offset - 偏移量
   * @param {string} options.createdBy - 创建者筛选
   * @param {string} options.search - 搜索关键词
   * @returns {Promise<Object>} 文件列表和分页信息
   */
  async getAdminFileList(options = {}) {
    const { limit = 30, offset = 0, createdBy, search } = options;

    // 如果有搜索关键词，使用搜索方法
    if (search && search.trim()) {
      const searchResult = await this.fileRepository.searchWithStorageConfig(search.trim(), {
        createdBy,
        limit,
        offset,
      });

      // 为搜索结果添加 type、typeName 和 key_name 字段
      if (searchResult.files) {
        searchResult.files = await this.processApiKeyNames(searchResult.files);
      }

      return searchResult;
    }

    // 构建查询条件
    const conditions = {};
    if (createdBy) conditions.created_by = createdBy;

    // 获取文件列表
    const files = await this.fileRepository.findManyWithStorageConfig(conditions, {
      orderBy: "created_at DESC",
      limit,
      offset,
    });

    // 获取总数
    const total = await this.fileRepository.count(conditions);

    // 处理API密钥名称
    const processedFiles = await this.processApiKeyNames(files);

    return {
      files: processedFiles,
      pagination: {
        total,
        limit,
        offset,
      },
    };
  }

  /**
   * 检测文件有效性（批量）
   * 记录存在 ≠ 对象存在：逐条回到存储侧确认对象是否仍然可达
   *
   * 状态语义：
   * - valid            记录正常且存储对象存在
   * - expired          记录存在但已过期/超出查看次数（记录层不可再访问）
   * - missing_object   记录存在但存储对象已不存在
   * - missing_record   记录本身不存在或无权访问
   * - error            存储不可达/鉴权失败等，无法判定（不等于文件丢失）
   *
   * @param {Array<string>} ids - 文件 ID 列表
   * @param {Object} options - { userType, userId, request, env, concurrency, itemTimeoutMs }
   *   concurrency 默认 8（上限 32），itemTimeoutMs 默认 15000；两者都用于避免批量检测被慢存储拖到超时
   * @returns {Promise<Object>} { results, summary }
   */
  async verifyFiles(ids, options = {}) {
    const {
      userType = UserType.ADMIN,
      userId = null,
      request = null,
      env = null,
      concurrency = VERIFY_DEFAULT_CONCURRENCY,
      itemTimeoutMs = VERIFY_ITEM_TIMEOUT_MS,
    } = options || {};

    const isAdmin = userType !== UserType.API_KEY;
    const ownerId = isAdmin ? userId : `apikey:${userId}`;

    // 空 id 直接跳过，但保留其余条目的输入顺序
    const targets = (Array.isArray(ids) ? ids : []).filter((id) => Boolean(id));

    const objectStore = new ObjectStore(this.db, this.encryptionSecret, this.repositoryFactory);

    let fsContext = null;
    const getFsContext = async () => {
      if (fsContext) return fsContext;
      const { MountManager } = await import("../storage/managers/MountManager.js");
      const { FileSystem } = await import("../storage/fs/FileSystem.js");
      const mountManager = new MountManager(this.db, this.encryptionSecret, this.repositoryFactory, { env });
      fsContext = { mountManager, fileSystem: new FileSystem(mountManager) };
      return fsContext;
    };

    const ctx = { isAdmin, ownerId, userType, request, objectStore, getFsContext, itemTimeoutMs };

    // 有界并发 + 结果按输入下标回填，保证返回顺序与请求一致
    const slots = new Array(targets.length);
    const workerCount = Math.min(normalizeConcurrency(concurrency), targets.length);
    let cursor = 0;

    const runWorker = async () => {
      while (cursor < targets.length) {
        const index = cursor;
        cursor += 1;
        slots[index] = await this._verifySingleFile(targets[index], ctx);
      }
    };

    if (workerCount > 0) {
      await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
    }

    const results = slots.filter(Boolean);
    const summary = {
      total: results.length,
      valid: results.filter((r) => r.status === "valid").length,
      invalid: results.filter((r) => r.status === "missing_object" || r.status === "missing_record").length,
      expired: results.filter((r) => r.status === "expired").length,
      error: results.filter((r) => r.status === "error").length,
    };

    return { results, summary };
  }

  /**
   * 单条文件有效性判定（供 verifyFiles 并发调用）
   *
   * 永不抛异常：所有失败都折算成结果条目的 status，避免单条失败拖垮整批。
   * @param {string} id - 文件 ID
   * @param {Object} ctx - { isAdmin, ownerId, userType, request, objectStore, getFsContext, itemTimeoutMs }
   * @returns {Promise<Object>} 单条检测结果
   */
  async _verifySingleFile(id, ctx) {
    const { isAdmin, ownerId, userType, request, objectStore, getFsContext, itemTimeoutMs } = ctx;
    const entry = { id: String(id), status: "error", message: null, size: null, storage_size: null };

    const run = async () => {
      const file = isAdmin
        ? await this.fileRepository.findByIdWithStorageConfig(id)
        : await this.fileRepository.findByIdAndCreator(id, ownerId);

      if (!file) {
        return { ...entry, status: "missing_record", message: "文件记录不存在或无权访问" };
      }

      entry.filename = file.filename;
      entry.storage_config_id = file.storage_config_id || null;
      entry.storage_path = file.storage_path || null;
      entry.size = typeof file.size === "number" ? file.size : Number(file.size) || 0;

      // 记录层：过期 / 超出查看次数
      const access = this.validateFileAccess(file);
      if (!access.accessible && access.reason === "expired") {
        return { ...entry, status: "expired", message: "文件已过期或查看次数已用尽" };
      }

      // 存储层：storage-first 为主路径，file_path 作为回退
      let info = null;
      if (file.storage_config_id && file.storage_path) {
        info = await objectStore.getInfoByStoragePath(file.storage_config_id, file.storage_path, { request });
      } else if (file.file_path) {
        const { fileSystem } = await getFsContext();
        info = await fileSystem.getFileInfo(file.file_path, ownerId, userType, request);
      } else {
        return { ...entry, status: "error", message: "记录缺少存储路径，无法定位对象" };
      }

      const storageSize = info && typeof info.size === "number" ? info.size : null;
      return {
        ...entry,
        status: "valid",
        message: null,
        storage_size: storageSize,
        size_mismatch: storageSize !== null && entry.size > 0 && storageSize !== entry.size,
        mimetype: info?.mimetype || null,
      };
    };

    try {
      return await withItemTimeout(run(), itemTimeoutMs, "存储响应超时，无法判定");
    } catch (error) {
      // 对象不存在 vs 存储不可达，必须区分：前者是失效文件，后者是判定失败
      const notFound = error instanceof NotFoundError || error?.name === "NotFoundError";
      return {
        ...entry,
        status: notFound ? "missing_object" : "error",
        message: notFound ? "存储中已找不到该文件对象" : error?.message || "存储校验失败",
      };
    }
  }

  /**
   * 获取文件详情（管理员）
   * @param {string} fileId - 文件ID
   * @param {string} encryptionSecret - 加密密钥
   * @param {Object} request - 请求对象
   * @returns {Promise<Object>} 文件详情
   */
  async getAdminFileDetail(fileId, encryptionSecret, request = null, options = {}) {
    const { includeLinks = false } = options || {};

    const file = await this.fileRepository.findByIdWithStorageConfig(fileId);
    if (!file) {
      throw new NotFoundError("文件不存在");
    }

    const fileType = await GetFileType(file.filename, this.db);
    const fileTypeName = await getFileTypeName(file.filename, this.db);

    const result = {
      ...file,
      has_password: !!file.password,
      type: fileType,
      typeName: fileTypeName,
    };

    if (file.password) {
      const passwordInfo = await this.fileRepository.getFilePassword(file.id);
      if (passwordInfo && passwordInfo.plain_password) {
        result.plain_password = passwordInfo.plain_password;
      }
    }

    if (result.created_by && result.created_by.startsWith("apikey:")) {
      const keyId = result.created_by.substring(7);
      const keyInfo = await this.getApiKeyInfo(keyId);
      if (keyInfo) {
        result.key_name = keyInfo.name;
      }
    }

    if (!includeLinks) {
      return result;
    }

    const linkService = new LinkService(this.db, encryptionSecret, this.repositoryFactory);
    const previewLink = await linkService.getShareExternalLink(file, null, {
      forceDownload: false,
      request,
    });
    const downloadLink = await linkService.getShareExternalLink(file, null, {
      forceDownload: true,
      request,
    });

    let previewUrl = previewLink && previewLink.url ? previewLink.url : null;
    let downloadUrl = downloadLink && downloadLink.url ? downloadLink.url : null;

    // 管理端 include=links 场景：若存储无直链/无 url_proxy 导致外部入口为空，
    // 为保证文件管理可预览/可下载，回退为本地 share 代理链路。
    let usedFallback = false;
    if (file.slug) {
      if (!previewUrl) {
        previewUrl = `/api/s/${file.slug}`;
        usedFallback = true;
      }
      if (!downloadUrl) {
        downloadUrl = `/api/s/${file.slug}?down=true`;
        usedFallback = true;
      }
    }

    const useProxyFlag = file.use_proxy ?? 0;
    const storageUrlProxy = file.url_proxy || null;

    let linkType = "proxy";
    if (useProxyFlag) {
      linkType = "proxy";
    } else if (storageUrlProxy && previewUrl) {
      linkType = "url_proxy";
    } else if (previewLink && previewLink.kind === "direct" && previewUrl) {
      linkType = "direct";
    } else if (previewUrl) {
      linkType = "proxy";
    } else {
      linkType = "direct";
    }

    if (usedFallback) {
      linkType = "proxy";
    }

    if (usedFallback) {
      linkType = "proxy";
    }

    if (request) {
      try {
        const base = new URL(request.url);
        const origin = `${base.protocol}//${base.host}`;
        if (previewUrl && previewUrl.startsWith("/")) {
          previewUrl = new URL(previewUrl, origin).toString();
        }
        if (downloadUrl && downloadUrl.startsWith("/")) {
          downloadUrl = new URL(downloadUrl, origin).toString();
        }
      } catch (e) {
        console.warn("构建文件详情绝对 URL 失败，将返回原始链接：", e?.message || e);
      }
    }

    const previewSelection = await resolvePreviewSelection(
      {
        type: fileType,
        typeName: fileTypeName,
        mimetype: file.mimetype,
        filename: file.filename,
        size: file.size,
      },
      {
        previewUrl,
        downloadUrl,
        linkType,
        use_proxy: useProxyFlag,
      },
    );

    result.previewUrl = previewUrl;
    result.downloadUrl = downloadUrl;
    result.linkType = linkType;
    result.previewSelection = previewSelection;

    return result;
  }

  /**
   * 处理文件列表中的API密钥名称和文件类型
   * @param {Array} files - 文件列表
   * @returns {Promise<Array>} 处理后的文件列表
   */
  async processApiKeyNames(files) {
    // 收集所有API密钥ID
    const apiKeyIds = files.filter((file) => file.created_by && file.created_by.startsWith("apikey:")).map((file) => file.created_by.substring(7));

    // 获取API密钥名称映射
    const keyNamesMap = new Map();
    if (apiKeyIds.length > 0) {
      const uniqueKeyIds = [...new Set(apiKeyIds)];

      for (const keyId of uniqueKeyIds) {
        const keyInfo = await this.getApiKeyInfo(keyId);
        if (keyInfo) {
          keyNamesMap.set(keyId, keyInfo.name);
        }
      }
    }

    // 为每个文件添加字段（包括文件类型检测）
    const processedFiles = await Promise.all(
      files.map(async (file) => {
        // 添加文件类型信息
        const fileType = await GetFileType(file.filename, this.db);
        const fileTypeName = await getFileTypeName(file.filename, this.db);

        const result = {
          ...file,
          has_password: file.password ? true : false,
          type: fileType, // 整数类型常量 (0-6)
          typeName: fileTypeName, // 类型名称（用于调试）
        };

        // 添加API密钥名称
        if (file.created_by && file.created_by.startsWith("apikey:")) {
          const keyId = file.created_by.substring(7);
          const keyName = keyNamesMap.get(keyId);
          if (keyName) {
            result.key_name = keyName;
          }
        }

        return result;
      })
    );

    return processedFiles;
  }

  /**
   * 获取API密钥信息
   * @param {string} keyId - API密钥ID
   * @returns {Promise<Object|null>} API密钥信息
   */
  async getApiKeyInfo(keyId) {
    // 这里需要通过Repository获取API密钥信息
    // 暂时使用直接查询，后续可以创建ApiKeyRepository
    const result = await this.fileRepository.queryFirst("SELECT id, name FROM api_keys WHERE id = ?", [keyId]);
    return result;
  }

  /**
   * 获取用户文件列表（API密钥用户）
   * @param {string} apiKeyId - API密钥ID
   * @param {Object} options - 查询选项
   * @param {number} options.limit - 每页条数
   * @param {number} options.offset - 偏移量
   * @param {string} options.search - 搜索关键词
   * @returns {Promise<Object>} 文件列表和分页信息
   */
  async getUserFileList(apiKeyId, options = {}) {
    const { limit = 30, offset = 0, search } = options;

    // 如果有搜索关键词，使用搜索方法
    if (search && search.trim()) {
      const searchResult = await this.fileRepository.searchWithStorageConfig(search.trim(), {
        createdBy: `apikey:${apiKeyId}`,
        limit,
        offset,
      });

      // 为搜索结果添加 type、typeName 和 key_name 字段
      if (searchResult.files) {
        searchResult.files = await this.processApiKeyNames(searchResult.files);
      }

      return searchResult;
    }

    // 构建查询条件
    const conditions = {
      created_by: `apikey:${apiKeyId}`,
    };

    // 获取文件列表
    const files = await this.fileRepository.findManyWithStorageConfig(conditions, {
      orderBy: "created_at DESC",
      limit,
      offset,
    });

    // 获取总数
    const total = await this.fileRepository.count(conditions);

    // 处理文件列表，添加has_password字段和API密钥名称
    const processedFiles = await this.processApiKeyNames(files);

    return {
      files: processedFiles,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + limit < total,
      },
    };
  }

  /**
   * 获取用户文件详情（API密钥用户）
   * @param {string} fileId - 文件ID
   * @param {string} apiKeyId - API密钥ID
   * @param {string} encryptionSecret - 加密密钥
   * @param {Object} request - 请求对象
   * @returns {Promise<Object>} 文件详情
   */
  async getUserFileDetail(fileId, apiKeyId, encryptionSecret, request = null, options = {}) {
    const { includeLinks = false } = options || {};

    const file = await this.fileRepository.findByIdWithStorageConfig(fileId);
    if (!file) {
      throw new NotFoundError("文件不存在");
    }

    if (file.created_by !== `apikey:${apiKeyId}`) {
      throw new AuthorizationError("没有权限查看此文件");
    }

    const fileType = await GetFileType(file.filename, this.db);
    const fileTypeName = await getFileTypeName(file.filename, this.db);

    const result = {
      ...file,
      has_password: !!file.password,
      type: fileType,
      typeName: fileTypeName,
    };

    if (file.password) {
      const passwordInfo = await this.fileRepository.getFilePassword(file.id);
      if (passwordInfo && passwordInfo.plain_password) {
        result.plain_password = passwordInfo.plain_password;
      }
    }

    if (!includeLinks) {
      return result;
    }

    const linkService = new LinkService(this.db, encryptionSecret, this.repositoryFactory);
    const previewLink = await linkService.getShareExternalLink(file, null, {
      forceDownload: false,
      request,
    });
    const downloadLink = await linkService.getShareExternalLink(file, null, {
      forceDownload: true,
      request,
    });

    let previewUrl = previewLink && previewLink.url ? previewLink.url : null;
    let downloadUrl = downloadLink && downloadLink.url ? downloadLink.url : null;

    // include=links 场景：若存储无直链/无 url_proxy 能力导致入口为空，回退本地 share 代理链路
    // 该回退仅用于受控的文件管理视图，确保 API Key 用户也能预览/下载自己的文件
    let usedFallback = false;
    if (file.slug) {
      if (!previewUrl) {
        previewUrl = `/api/s/${file.slug}`;
        usedFallback = true;
      }
      if (!downloadUrl) {
        downloadUrl = `/api/s/${file.slug}?down=true`;
        usedFallback = true;
      }
    }

    const useProxyFlag = file.use_proxy ?? 0;
    const storageUrlProxy = file.url_proxy || null;

    let linkType = "proxy";
    if (useProxyFlag) {
      linkType = "proxy";
    } else if (storageUrlProxy && previewUrl) {
      linkType = "url_proxy";
    } else if (previewLink && previewLink.kind === "direct" && previewUrl) {
      linkType = "direct";
    } else if (previewUrl) {
      linkType = "proxy";
    } else {
      linkType = "direct";
    }

    if (usedFallback) {
      linkType = "proxy";
    }

    if (request) {
      try {
        const base = new URL(request.url);
        const origin = `${base.protocol}//${base.host}`;
        if (previewUrl && previewUrl.startsWith("/")) {
          previewUrl = new URL(previewUrl, origin).toString();
        }
        if (downloadUrl && downloadUrl.startsWith("/")) {
          downloadUrl = new URL(downloadUrl, origin).toString();
        }
      } catch (e) {
        console.warn("构建文件详情绝对 URL 失败，将返回原始链接：", e?.message || e);
      }
    }

    const previewSelection = await resolvePreviewSelection(
      {
        type: fileType,
        typeName: fileTypeName,
        mimetype: file.mimetype,
        filename: file.filename,
        size: file.size,
      },
      {
        previewUrl,
        downloadUrl,
        linkType,
        use_proxy: useProxyFlag,
      },
    );

    result.previewUrl = previewUrl;
    result.downloadUrl = downloadUrl;
    result.linkType = linkType;
    result.previewSelection = previewSelection;

    return result;
  }
}

// 静态便捷方法（供路由直接调用）
export async function getFileBySlug(db, slug, encryptionSecret) {
  const fileService = new FileService(db, encryptionSecret);
  return await fileService.getFileBySlug(slug);
}

export async function isFileAccessible(db, file, encryptionSecret) {
  const fileService = new FileService(db, encryptionSecret);
  return fileService.isFileAccessible(file);
}

export async function incrementAndCheckFileViews(db, file, encryptionSecret) {
  const fileService = new FileService(db, encryptionSecret);
  return await fileService.incrementAndCheckFileViews(file.slug);
}

export async function guardShareFile(db, slug, encryptionSecret, options = {}) {
  const fileService = new FileService(db, encryptionSecret);
  return await fileService.guardShareFile(slug, options);
}

export async function getPublicFileInfo(
  db,
  file,
  requiresPassword,
  link = null,
  encryptionSecret = null,
  options = {},
) {
  const fileService = new FileService(db, encryptionSecret);
  return await fileService.getPublicFileInfo(file, requiresPassword, link, options);
}

export async function deleteFileRecordByStoragePath(db, storageConfigId, storagePath, storageType) {
  const fileService = new FileService(db);
  return await fileService.deleteFileRecordByStoragePath(storageConfigId, storagePath, storageType);
}

// 管理员文件管理导出函数
export async function getAdminFileList(db, options = {}) {
  const fileService = new FileService(db);
  return await fileService.getAdminFileList(options);
}

export async function getAdminFileDetail(db, fileId, encryptionSecret, request = null, options = {}) {
  const fileService = new FileService(db);
  return await fileService.getAdminFileDetail(fileId, encryptionSecret, request, options);
}

// 用户文件管理导出函数
export async function getUserFileList(db, apiKeyId, options = {}) {
  const fileService = new FileService(db);
  return await fileService.getUserFileList(apiKeyId, options);
}

export async function getUserFileDetail(db, fileId, apiKeyId, encryptionSecret, request = null, options = {}) {
  const fileService = new FileService(db);
  return await fileService.getUserFileDetail(fileId, apiKeyId, encryptionSecret, request, options);
}

// 文件更新导出函数
export async function updateFile(db, fileId, updateData, userInfo) {
  const fileService = new FileService(db);
  return await fileService.updateFile(fileId, updateData, userInfo);
}

// 文件有效性检测导出函数（需要 encryptionSecret + repositoryFactory 才能建 ObjectStore）
export async function verifyFiles(db, ids, encryptionSecret, options = {}) {
  const fileService = new FileService(db, encryptionSecret, options.repositoryFactory || null);
  return await fileService.verifyFiles(ids, options);
}
