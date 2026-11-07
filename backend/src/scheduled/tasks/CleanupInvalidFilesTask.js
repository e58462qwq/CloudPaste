import { DbTables } from "../../constants/index.js";
import { RepositoryFactory } from "../../repositories/index.js";
import { ObjectStore } from "../../storage/object/ObjectStore.js";
import { StorageFactory } from "../../storage/factory/StorageFactory.js";
import { invalidateFsCache } from "../../cache/invalidation.js";
import { isCloudflareWorkerEnvironment } from "../../utils/environmentUtils.js";

/**
 * CleanupInvalidFilesTask
 * - 批量清理「失效 / 过期」的文件记录，与文件管理页的「检测有效性 + 一键选择失效文件」口径保持一致
 *
 * 判定口径分两层：
 * - 记录层（默认开启）：过期（expires_at 早于当前时间）、次数用尽（views > max_views）
 * - 存储层（verifyStorage，默认关闭）：逐个回源确认对象是否还存在，
 *   能发现「记录还在、对象已被外部删除」的文件（即「检测有效性」里的 missing_object）
 *
 * 为什么不默认访问存储：
 * - 存储侧校验（对象是否真的还在）每个文件都要一次网络请求；在 Cloudflare Workers 上
 *   subrequest 有硬上限，定时任务跑满一次就会整批失败。所以本任务默认只做记录层判定，
 *   存储对象是否残留由「文件管理 → 检测有效性」按需确认；需要时把 verifyStorage 打开，
 *   并用 maxStorageChecks 限制单次校验条数。
 * - 需要连存储对象一起清理时，把 deleteStorageObject 打开，并用 maxStorageDeletes 限制单次条数。
 *
 * 安全性：
 * - dryRun 默认 true，第一次执行只统计不删除，确认口径无误后再关掉。
 * - 开启 deleteStorageObject 时，存储删除失败的文件记录会被跳过（不删记录），
 *   避免留下无法再定位的孤儿对象。
 */

function nowMs() {
  return Date.now();
}

function clampInt(value, { min, max, fallback }) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return fallback;
}

function getEncryptionSecretFromEnv(env) {
  const secret =
    (env && env.ENCRYPTION_SECRET) ||
    (typeof process !== "undefined" ? process.env?.ENCRYPTION_SECRET : null);
  if (!secret) {
    throw new Error("ENCRYPTION_SECRET 未配置，无法清理失效文件");
  }
  return secret;
}

/**
 * 有界并发执行：存储校验是网络请求，串行太慢，全并发又会打穿 Workers 的 subrequest 配额
 */
async function runWithConcurrency(items, concurrency, fn) {
  const limit = Math.max(1, Math.min(8, Math.trunc(Number(concurrency) || 1)));
  const queue = items.slice();
  const results = [];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      // eslint-disable-next-line no-await-in-loop
      results.push(await fn(item));
    }
  });
  await Promise.all(workers);
  return results;
}

/** Workers 下 subrequest 有硬上限，存储校验条数必须收敛 */
const WORKER_MAX_STORAGE_CHECKS = 20;
const STORAGE_CHECK_CONCURRENCY = 4;

export class CleanupInvalidFilesTask {
  constructor() {
    /** @type {string} 任务唯一标识 */
    this.id = "cleanup_invalid_files";

    /** @type {string} 任务显示名称 */
    this.name = "清理失效/过期文件";

    /** @type {string} 任务描述 */
    this.description =
      "按记录层口径清理已过期或查看次数已用尽的文件，可选连带删除存储对象；与文件管理页「选择失效文件」口径一致。";

    /** @type {"maintenance" | "business"} 任务类别 */
    this.category = "maintenance";

    /**
     * 配置参数 Schema
     * @type {Array<{
     *   name: string,
     *   label: string,
     *   type: "string" | "number" | "boolean" | "select" | "textarea",
     *   defaultValue: any,
     *   required: boolean,
     *   min?: number,
     *   max?: number,
     *   description?: string
     * }>}
     */
    this.configSchema = [
      {
        name: "dryRun",
        label: "试运行（只统计不删除）",
        type: "boolean",
        defaultValue: true,
        required: true,
        description: "开启时只统计命中数量并输出，不执行任何删除。确认口径无误后再关闭。",
      },
      {
        name: "batchSize",
        label: "每批处理条数",
        type: "number",
        defaultValue: 100,
        required: true,
        min: 1,
        max: 500,
        description: "分批处理，避免单次 DELETE 过重或 IN 参数过长。",
      },
      {
        name: "maxBatches",
        label: "单次最多处理批数",
        type: "number",
        defaultValue: 5,
        required: true,
        min: 1,
        max: 100,
        description: "限制单次运行的总量，剩余的下次继续，避免长时间占用与超时。",
      },
      {
        name: "deleteExpired",
        label: "清理已过期文件",
        type: "boolean",
        defaultValue: true,
        required: true,
        description: "expires_at 已早于当前时间的文件。",
      },
      {
        name: "deleteViewsExhausted",
        label: "清理次数已用尽的文件",
        type: "boolean",
        defaultValue: true,
        required: true,
        description: "max_views 非空且 views 已超过 max_views 的文件。",
      },
      {
        name: "deleteStorageObject",
        label: "连带删除存储对象",
        type: "boolean",
        defaultValue: false,
        required: true,
        description: "开启后会回源删除存储中的对象；需网络请求，Workers 上有 subrequest 配额，请配合下面的条数上限。",
      },
      {
        name: "maxStorageDeletes",
        label: "单次最多删除存储对象数",
        type: "number",
        defaultValue: 50,
        required: false,
        min: 1,
        max: 500,
        description: "仅在开启「连带删除存储对象」时生效。Cloudflare Workers 免费版 subrequest 上限为 50，建议不超过 20。",
      },
      {
        name: "verifyStorage",
        label: "校验存储层（发现对象已丢失的文件）",
        type: "boolean",
        defaultValue: false,
        required: true,
        description:
          "开启后会逐个回源确认对象是否还存在，从而发现「记录还在、对象已被外部删除」的失效文件（即「检测有效性」里的 missing_object）。需要网络请求，请配合下面的校验条数上限。",
      },
      {
        name: "maxStorageChecks",
        label: "单次最多校验文件数",
        type: "number",
        defaultValue: 50,
        required: false,
        min: 1,
        max: 500,
        description: "仅在开启「校验存储层」时生效。每个文件一次存储请求；Cloudflare Workers 部署会自动收敛到 20 以内。",
      },
    ];
  }

  /**
   * 执行清理逻辑
   * @param {{ db: D1Database, env: any, now: string, config: any, scheduledJobId?: string }} ctx
   */
  async run(ctx) {
    const { db } = ctx || {};
    const env = ctx?.env || {};
    const config = ctx?.config || {};
    const nowIso = ctx?.now || new Date().toISOString();

    const dryRun = toBool(config.dryRun, true);
    const batchSize = clampInt(config.batchSize, { min: 1, max: 500, fallback: 100 });
    const maxBatches = clampInt(config.maxBatches, { min: 1, max: 100, fallback: 5 });
    const deleteExpired = toBool(config.deleteExpired, true);
    const deleteViewsExhausted = toBool(config.deleteViewsExhausted, true);
    const deleteStorageObject = toBool(config.deleteStorageObject, false);
    const maxStorageDeletes = clampInt(config.maxStorageDeletes, { min: 1, max: 500, fallback: 50 });
    const verifyStorage = toBool(config.verifyStorage, false);
    const maxStorageChecksRequested = clampInt(config.maxStorageChecks, { min: 1, max: 500, fallback: 50 });
    // Workers 的 subrequest 是硬上限，存储校验会逐文件发一次请求，必须收敛
    const maxStorageChecks = isCloudflareWorkerEnvironment()
      ? Math.min(maxStorageChecksRequested, WORKER_MAX_STORAGE_CHECKS)
      : maxStorageChecksRequested;

    if (!deleteExpired && !deleteViewsExhausted && !verifyStorage) {
      return {
        summary: "未启用任何清理条件（已过期 / 次数用尽 / 存储层校验都关闭），本次未做任何处理",
        matched: 0,
        deletedRecords: 0,
        deletedStorageObjects: 0,
        dryRun,
      };
    }

    const startedMs = nowMs();

    const getChanges = (result) => {
      if (!result) return 0;
      if (typeof result.meta?.changes === "number") return result.meta.changes;
      if (typeof result.changes === "number") return result.changes;
      return 0;
    };

    // 命中条件：与 FileService.validateFileAccess 的 expired 判定保持一致
    const conditions = [];
    const conditionParams = [];
    if (deleteExpired) {
      conditions.push("(expires_at IS NOT NULL AND expires_at < ?)");
      conditionParams.push(nowIso);
    }
    if (deleteViewsExhausted) {
      conditions.push("(max_views IS NOT NULL AND max_views > 0 AND views > max_views)");
    }
    const whereClause = conditions.join(" OR ");

    const readCounts = async () => {
      const row = await db
        .prepare(
          `
          SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN expires_at IS NOT NULL THEN 1 ELSE 0 END) AS with_expires_count,
            SUM(CASE WHEN expires_at IS NOT NULL AND expires_at < ? THEN 1 ELSE 0 END) AS expired_count,
            SUM(CASE WHEN max_views IS NOT NULL AND max_views > 0 AND views > max_views THEN 1 ELSE 0 END) AS views_count
          FROM ${DbTables.FILES}
        `,
        )
        .bind(nowIso)
        .first();

      return {
        total: Number(row?.total) || 0,
        withExpiresAt: Number(row?.with_expires_count) || 0,
        expired: Number(row?.expired_count) || 0,
        viewsExhausted: Number(row?.views_count) || 0,
      };
    };

    const beforeCounts = await readCounts();

    // 命中总数：单次 COUNT，用于 dryRun 与统计（不必为了估算总量去反复取同一批行）
    const countCandidates = async () => {
      // 只开了存储层校验时没有记录层条件，SQL 里不能出现空 WHERE
      if (conditions.length === 0) return 0;
      const row = await db
        .prepare(`SELECT COUNT(*) AS cnt FROM ${DbTables.FILES} WHERE ${whereClause}`)
        .bind(...conditionParams)
        .first();
      return Number(row?.cnt) || 0;
    };

    // 被跳过（存储删除失败 / 超出单次上限）的记录必须在后续批次里排除，
    // 否则每轮都会重新取到同一批行，导致重复计数与空转。
    const excludeIds = [];

    const pickCandidates = async () => {
      // 只开了存储层校验时没有任何记录层条件，此时不存在记录层候选
      if (conditions.length === 0) return [];
      const excludeClause = excludeIds.length
        ? ` AND id NOT IN (${excludeIds.map(() => "?").join(", ")})`
        : "";
      const res = await db
        .prepare(
          `
          SELECT id, filename, storage_config_id, storage_type, storage_path, file_path,
                 expires_at, max_views, views
          FROM ${DbTables.FILES}
          WHERE (${whereClause})${excludeClause}
          ORDER BY created_at ASC
          LIMIT ?
        `,
        )
        .bind(...conditionParams, ...excludeIds, batchSize)
        .all();
      return res?.results || [];
    };

    /**
     * 取「尚未被记录层命中」的记录作为存储层校验对象：
     * 记录层已命中的会在清理阶段直接删掉，不必再花 subrequest 去回源确认。
     */
    const pickStorageCheckTargets = async (limit, alreadyUsedIds) => {
      const filters = ["storage_config_id IS NOT NULL", "storage_path IS NOT NULL"];
      const params = [];
      if (whereClause) {
        filters.push(`NOT (${whereClause})`);
        params.push(...conditionParams);
      }
      if (alreadyUsedIds.length > 0) {
        filters.push(`id NOT IN (${alreadyUsedIds.map(() => "?").join(", ")})`);
        params.push(...alreadyUsedIds);
      }
      const res = await db
        .prepare(
          `
          SELECT id, filename, storage_config_id, storage_type, storage_path, file_path,
                 expires_at, max_views, views
          FROM ${DbTables.FILES}
          WHERE ${filters.join(" AND ")}
          ORDER BY created_at ASC
          LIMIT ?
        `,
        )
        .bind(...params, limit)
        .all();
      return res?.results || [];
    };

    let matched = 0;
    let deletedRecords = 0;
    let deletedPasswords = 0;
    let deletedStorageObjects = 0;
    let storageDeleteFailures = 0;
    let skippedForStorage = 0;
    let batches = 0;
    const touchedStorageConfigIds = new Set();

    let objectStore = null;
    const ensureObjectStore = () => {
      if (objectStore) return objectStore;
      const encryptionSecret = getEncryptionSecretFromEnv(env);
      const repositoryFactory = new RepositoryFactory(db, { env });
      objectStore = new ObjectStore(db, encryptionSecret, repositoryFactory);
      return objectStore;
    };

    /**
     * 存储层校验（可选）：找出「记录还在、对象已被外部删除」的文件
     * - 只校验记录层没命中的记录，避免为即将删除的记录白花 subrequest
     * - 有界并发；Workers 下条数已收敛到 WORKER_MAX_STORAGE_CHECKS
     */
    let storageChecked = 0;
    let storageMissing = 0;
    let storageUnreachable = 0;
    const storageMissingIds = [];

    const runStorageCheck = async () => {
      if (!verifyStorage) return;
      const targets = await pickStorageCheckTargets(maxStorageChecks, excludeIds);
      if (targets.length === 0) return;

      await runWithConcurrency(targets, STORAGE_CHECK_CONCURRENCY, async (row) => {
        storageChecked += 1;
        try {
          await ensureObjectStore().getInfoByStoragePath(row.storage_config_id, row.storage_path, { db });
        } catch (error) {
          const notFound = error?.name === "NotFoundError" || error?.status === 404;
          if (notFound) {
            storageMissing += 1;
            if (row?.id) storageMissingIds.push(row.id);
            return;
          }
          // 存储不可达不等于文件丢失，绝不能据此删除记录
          storageUnreachable += 1;
          console.warn("[CleanupInvalidFilesTask] 存储校验失败，无法判定（不会删除该记录）:", {
            fileId: row?.id,
            storageConfigId: row?.storage_config_id,
            storagePath: row?.storage_path,
            error: error?.message || error,
          });
        }
      });
    };

    await runStorageCheck();

    // 试运行：只统计，不写库
    if (dryRun) {
      const recordLevelTotal = await countCandidates();
      const total = recordLevelTotal + storageMissingIds.length;
      const afterCounts = await readCounts();
      const durationMs = nowMs() - startedMs;

      const parts = [`试运行：命中失效/过期文件 ${total} 条（未删除）`];
      parts.push(`记录层 ${recordLevelTotal} 条`);
      if (verifyStorage) {
        parts.push(`存储层已丢失 ${storageMissingIds.length} 条（已校验 ${storageChecked} 条）`);
        if (storageUnreachable > 0) parts.push(`存储不可达 ${storageUnreachable} 条（无法判定，不计入）`);
      }
      parts.push(`当前文件总数 ${afterCounts.total} 条`);
      parts.push(`用时 ${durationMs}ms`);

      return {
        summary: parts.join("，"),
        dryRun: true,
        matched: total,
        recordLevelMatched: recordLevelTotal,
        storageChecked,
        storageMissing: storageMissingIds.length,
        storageUnreachable,
        deletedRecords: 0,
        deletedPasswords: 0,
        deletedStorageObjects: 0,
        storageDeleteFailures: 0,
        skippedForStorage: 0,
        batches: 0,
        totalFiles: afterCounts.total,
        stats: {
          before: beforeCounts,
          after: afterCounts,
          deleteExpired,
          deleteViewsExhausted,
          verifyStorage,
          maxStorageChecks,
          deleteStorageObject,
          maxStorageDeletes,
          batchSize,
          maxBatches,
          durationMs,
        },
      };
    }

    // 分批处理：每批都是「独立的一次 SELECT + 若干次 DELETE」，避免长事务与 IN 参数爆炸
    while (batches < maxBatches) {
      const rows = await pickCandidates();
      if (rows.length === 0) break;

      batches += 1;
      matched += rows.length;

      const deletableIds = [];
      // 本批无法推进的记录（存储删除失败 / 超出单次上限）要排除掉，否则下一轮会重复取到它们
      const skippedIds = [];

      // 1) 可选：先删存储对象。存储删除失败的文件记录会被跳过，避免留下孤儿对象
      if (deleteStorageObject) {
        for (const row of rows) {
          const storageConfigId = row?.storage_config_id;
          const storagePath = row?.storage_path;
          if (!storageConfigId || !storagePath) {
            // 没有 storage_path 的记录无法回源删除，直接按记录清理
            deletableIds.push(row.id);
            continue;
          }

          if (deletedStorageObjects >= maxStorageDeletes) {
            // 达到单次上限，剩余记录留到下次运行
            skippedForStorage += 1;
            if (row?.id) skippedIds.push(row.id);
            continue;
          }

          try {
            // eslint-disable-next-line no-await-in-loop
            await ensureObjectStore().deleteByStoragePath(storageConfigId, storagePath, { db });
            deletedStorageObjects += 1;
            touchedStorageConfigIds.add(String(storageConfigId));
            deletableIds.push(row.id);
          } catch (error) {
            // 对象可能已被上游生命周期策略删除（NotFound），这种情况也应允许清理记录
            const notFound = error?.name === "NotFoundError" || error?.status === 404;
            if (notFound) {
              deletableIds.push(row.id);
              continue;
            }
            storageDeleteFailures += 1;
            if (row?.id) skippedIds.push(row.id);
            console.warn("[CleanupInvalidFilesTask] 删除存储对象失败，跳过该记录:", {
              fileId: row?.id,
              storageConfigId,
              storagePath,
              error: error?.message || error,
            });
          }
        }
      } else {
        for (const row of rows) {
          if (row?.id) deletableIds.push(row.id);
        }
      }

      // 跳过的记录加入排除列表，保证循环能推进到下一批，而不是在同一批上空转
      for (const id of skippedIds) excludeIds.push(id);

      if (deletableIds.length === 0) {
        // 本批无可删除记录：若还有被排除的跳过项，继续取下一批；否则已无进展，退出避免死循环
        if (skippedIds.length === 0) break;
        console.warn("[CleanupInvalidFilesTask] 本批无可删除记录，已排除跳过项后继续下一批");
        continue;
      }

      const placeholders = deletableIds.map(() => "?").join(", ");

      // 2) 先删附属表 file_passwords，再删主表（显式顺序，不依赖外键级联）
      const delPasswordRes = await db
        .prepare(`DELETE FROM ${DbTables.FILE_PASSWORDS} WHERE file_id IN (${placeholders})`)
        .bind(...deletableIds)
        .run();
      deletedPasswords += getChanges(delPasswordRes);

      const delFileRes = await db
        .prepare(`DELETE FROM ${DbTables.FILES} WHERE id IN (${placeholders})`)
        .bind(...deletableIds)
        .run();
      deletedRecords += getChanges(delFileRes);
    }

    // 存储层校验命中的记录（对象已被外部删除）不满足记录层条件，需要单独删除
    let storageMissingDeleted = 0;
    if (storageMissingIds.length > 0) {
      // 按 batchSize 切片，避免 IN 参数过长
      for (let start = 0; start < storageMissingIds.length; start += batchSize) {
        const slice = storageMissingIds.slice(start, start + batchSize);
        const placeholders = slice.map(() => "?").join(", ");
        // eslint-disable-next-line no-await-in-loop
        const delPasswordRes = await db
          .prepare(`DELETE FROM ${DbTables.FILE_PASSWORDS} WHERE file_id IN (${placeholders})`)
          .bind(...slice)
          .run();
        deletedPasswords += getChanges(delPasswordRes);

        // eslint-disable-next-line no-await-in-loop
        const delFileRes = await db
          .prepare(`DELETE FROM ${DbTables.FILES} WHERE id IN (${placeholders})`)
          .bind(...slice)
          .run();
        const removed = getChanges(delFileRes);
        deletedRecords += removed;
        storageMissingDeleted += removed;
      }
      matched += storageMissingIds.length;
    }

    // 存储对象有变动时，让 FS 视图缓存失效，避免列表继续展示已删除项
    for (const storageConfigId of touchedStorageConfigIds) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await invalidateFsCache({
          storageConfigId,
          reason: "scheduled-cleanup-invalid-files",
          db,
        });
      } catch (error) {
        console.warn("[CleanupInvalidFilesTask] 失效 FS 缓存失败:", {
          storageConfigId,
          error: error?.message || error,
        });
      }
    }

    const afterCounts = await readCounts();
    const durationMs = nowMs() - startedMs;

    const summaryParts = [];
    summaryParts.push(`清理文件记录 ${deletedRecords} 条`);
    summaryParts.push(`连带删除口令记录 ${deletedPasswords} 条`);
    if (verifyStorage) {
      summaryParts.push(`存储层校验 ${storageChecked} 条，其中对象已丢失 ${storageMissing} 条`);
      if (storageUnreachable > 0) summaryParts.push(`存储不可达 ${storageUnreachable} 条（无法判定，已保留记录）`);
    }
    if (deleteStorageObject) {
      summaryParts.push(`删除存储对象 ${deletedStorageObjects} 个`);
      if (storageDeleteFailures > 0) summaryParts.push(`存储删除失败 ${storageDeleteFailures} 个（已保留记录）`);
      if (skippedForStorage > 0) summaryParts.push(`超出单次上限待下次处理 ${skippedForStorage} 条`);
    }
    summaryParts.push(`处理 ${batches} 批`);
    summaryParts.push(`用时 ${durationMs}ms`);

    return {
      summary: summaryParts.join("，"),
      dryRun: false,
      matched,
      recordLevelMatched: matched - storageMissingDeleted,
      deletedRecords,
      deletedPasswords,
      deletedStorageObjects,
      storageDeleteFailures,
      skippedForStorage,
      storageChecked,
      storageMissing,
      storageMissingDeleted,
      storageUnreachable,
      batches,
      totalFiles: afterCounts.total,
      stats: {
        before: beforeCounts,
        after: afterCounts,
        deleteExpired,
        deleteViewsExhausted,
        verifyStorage,
        maxStorageChecks,
        deleteStorageObject,
        maxStorageDeletes,
        batchSize,
        maxBatches,
        durationMs,
      },
    };
  }
}
