/**
 * MySQL dialect：LIKE contains（不依赖 FULLTEXT 索引）
 *
 * 为什么不是 MATCH ... AGAINST：
 * - FULLTEXT 的分词/最小词长（innodb_ft_min_token_size 默认 3）会让短词整段失效，
 *   且自然语言模式是“按词命中”，无法表达“子串包含”（与 SQLite trigram 语义不一致）
 * - FULLTEXT 还需要在建表时声明索引，属于 schema 变更；当前 MySQL 迁移系统尚未实现
 *
 * 因此选择 LIKE contains：
 * - 语义与 sqlite trigram contains、postgres ILIKE contains 对齐
 * - 排序键与其它方言一致（modified_ms DESC, fs_path ASC, id DESC）
 * - 占位符用 `?`（MySQL 原生风格）
 *
 * 注意：
 * - MySQL 的 `||` 是逻辑或而非拼接，子目录聚合里必须用 CONCAT()
 * - `ESCAPE '#'` 不受 NO_BACKSLASH_ESCAPES 影响
 */

import { DbTables } from "../../../../constants/index.js";
import { buildContainsLikePattern, buildWhereSql, LIKE_ESCAPE_CHAR, normalizeParentDir } from "./common.js";

/**
 * 子串匹配表达式：name 或 fs_path 包含 query
 * - MySQL 无 ILIKE；默认 collation（*_ci）即大小写不敏感
 * @param {(value:any)=>string} ph
 * @param {string} query
 */
function buildMatchExpression(ph, query) {
  const pattern = buildContainsLikePattern(query);
  return (
    `(e.name LIKE ${ph(pattern)} ESCAPE '${LIKE_ESCAPE_CHAR}'` +
    ` OR e.fs_path LIKE ${ph(pattern)} ESCAPE '${LIKE_ESCAPE_CHAR}')`
  );
}

function buildWhereAndBind(p) {
  const bind = [];
  const ph = (value) => {
    bind.push(value);
    return "?";
  };
  // 一次求值：ph 在生成占位符的同时按顺序收集 bind
  const whereSql = buildWhereSql(p, ph, { matchExpression: buildMatchExpression });
  return { whereSql, bind };
}

export function createMysqlDialect() {
  return {
    id: "mysql-like-contains",
    // LIKE contains 无 trigram 的 3 字符约束
    minQueryLength: 1,
    containsMode: "like",

    buildSearchSql(p) {
      const { whereSql, bind } = buildWhereAndBind(p);
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
        LIMIT ?
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
     * - LOCATE('/', rel) 取代 instr(rel, '/')
     * - CONCAT() 取代 `||`（MySQL 的 `||` 默认是 OR）
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
            SUBSTRING(fs_path, ?) AS rel
          FROM ${DbTables.FS_SEARCH_INDEX_ENTRIES}
          WHERE mount_id = ? AND fs_path LIKE ?
        )
        SELECT
          CONCAT(?, SUBSTRING(rel, 1, LOCATE('/', rel))) AS dir_path,
          COALESCE(SUM(CASE WHEN is_dir = FALSE THEN 0 ELSE size END), 0) AS total_size,
          COALESCE(MAX(modified_ms), 0) AS latest_modified_ms,
          COUNT(*) AS entry_count
        FROM scoped
        WHERE LOCATE('/', rel) > 0
        GROUP BY dir_path
      `;
      return { sql, bind: [startPos, String(mountId || ""), likePrefix, parent] };
    },
  };
}
