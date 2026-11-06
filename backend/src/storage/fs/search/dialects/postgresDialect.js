/**
 * Postgres dialect：LIKE contains（不依赖 pg_trgm 扩展）
 *
 * 为什么不是 tsvector / pg_trgm：
 * - pg_trgm 需要 `CREATE EXTENSION pg_trgm`（需要 superuser 或预装），在托管 PG 上
 *   不一定拿得到；搜索是可选能力，不应该因为扩展缺失就整体不可用
 * - tsvector 是分词全文检索（词干/停用词），与 SQLite FTS5 trigram 的
 *   “子串包含”语义不同：搜 "port" 命中 "report" 在 trigram 下成立、在 tsvector 下不成立，
 *   跨方言行为会漂移
 * - 因此这里选择 ILIKE contains：语义与 trigram contains 对齐，代价是全表扫描
 *   （索引规模受 fs_search_index_entries 约束，且已按 mount_id 收敛）
 *
 * 与 sqlite 方言的一致性：
 * - 排序键完全相同（modified_ms DESC, fs_path ASC, id DESC）→ cursor 跨方言可复用
 * - 匹配列相同（name + fs_path）
 * - 占位符用 $n（Postgres 原生风格），由共用 buildWhereSql 的 ph 工厂生成
 */

import { DbTables } from "../../../../constants/index.js";
import { buildContainsLikePattern, buildWhereSql, LIKE_ESCAPE_CHAR, normalizeParentDir } from "./common.js";

/**
 * 子串匹配表达式：name 或 fs_path 包含 query（大小写不敏感）
 * @param {(value:any)=>string} ph
 * @param {string} query
 */
function buildMatchExpression(ph, query) {
  const pattern = buildContainsLikePattern(query);
  return (
    `(e.name ILIKE ${ph(pattern)} ESCAPE '${LIKE_ESCAPE_CHAR}'` +
    ` OR e.fs_path ILIKE ${ph(pattern)} ESCAPE '${LIKE_ESCAPE_CHAR}')`
  );
}

/**
 * 构造 WHERE + bind（$n 递增）
 * @param {any} p
 */
function buildWhereAndBind(p) {
  const bind = [];
  let index = 0;
  const ph = (value) => {
    bind.push(value);
    index += 1;
    return `$${index}`;
  };

  const whereSql = buildWhereSql(p, ph, { matchExpression: buildMatchExpression });
  return { whereSql, bind, nextPlaceholder: () => `$${index + 1}` };
}

export function createPostgresDialect() {
  return {
    id: "postgres-like-contains",
    // ILIKE contains 没有 trigram 的 3 字符硬约束，1 字符即可查
    minQueryLength: 1,
    containsMode: "ilike",

    buildSearchSql(p) {
      const { whereSql, bind, nextPlaceholder } = buildWhereAndBind(p);
      const sql = `
        SELECT
          e.id,
          e.mount_id,
          e.fs_path,
          e.name,
          e.is_dir,
          e.size,
          e.modified_ms,
          e.mimetype
        FROM ${DbTables.FS_SEARCH_INDEX_ENTRIES} e
        ${whereSql}
        ORDER BY e.modified_ms DESC, e.fs_path ASC, e.id DESC
        LIMIT ${nextPlaceholder()}
      `;
      return { sql, bind };
    },

    buildCountSql(p) {
      const { whereSql, bind } = buildWhereAndBind(p);
      const sql = `
        SELECT COUNT(1) AS total
        FROM ${DbTables.FS_SEARCH_INDEX_ENTRIES} e
        ${whereSql}
      `;
      return { sql, bind };
    },

    /**
     * 子目录聚合（替代 SQLite 的 substr/instr）
     * - POSITION('/' IN rel) 取代 instr(rel, '/')
     * - substr 三方言同为 1-based，startPos 计算可复用
     */
    buildChildDirectoryAggregatesSql(mountId, parentDirFsPath) {
      const parent = normalizeParentDir(parentDirFsPath);
      if (!parent) return null;

      const startPos = parent.length + 1;
      const likePrefix = `${parent}%`;

      const sql = `
        WITH scoped AS (
          SELECT
            fs_path,
            is_dir,
            size,
            modified_ms,
            substr(fs_path, $1) AS rel
          FROM ${DbTables.FS_SEARCH_INDEX_ENTRIES}
          WHERE mount_id = $2 AND fs_path LIKE $3
        )
        SELECT
          ($4 || substr(rel, 1, POSITION('/' IN rel))) AS dir_path,
          COALESCE(SUM(CASE WHEN is_dir = FALSE THEN size ELSE 0 END), 0) AS total_size,
          COALESCE(MAX(modified_ms), 0) AS latest_modified_ms,
          COUNT(*) AS entry_count
        FROM scoped
        WHERE POSITION('/' IN rel) > 0
        GROUP BY dir_path
      `;
      return { sql, bind: [startPos, String(mountId || ""), likePrefix, parent] };
    },
  };
}
