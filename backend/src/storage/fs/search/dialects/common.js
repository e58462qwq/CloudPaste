/**
 * FS 搜索方言共用工具（Postgres / MySQL 共用）
 *
 * 约定：
 * - 排序键统一为 modified_ms DESC, fs_path ASC, id DESC（游标跨方言通用）
 * - LIKE 统一使用 `ESCAPE '#'`，避免依赖 backslash 转义（MySQL 的
 *   NO_BACKSLASH_ESCAPES / Postgres 的 standard_conforming_strings 都不会踩坑）
 * - 占位符由调用方注入：SQLite/MySQL 用 `?`，Postgres 用 `$n`
 */

export const LIKE_ESCAPE_CHAR = "#";

export function normalizeSearchQuery(q) {
  return String(q ?? "").trim();
}

/**
 * 转义 LIKE 通配符（% _）与转义符自身
 * @param {string} raw
 */
export function escapeLikePattern(raw) {
  return String(raw ?? "").replace(/[#%_]/g, (ch) => `${LIKE_ESCAPE_CHAR}${ch}`);
}

/**
 * contains 语义：%keyword%
 * @param {string} raw
 */
export function buildContainsLikePattern(raw) {
  return `%${escapeLikePattern(normalizeSearchQuery(raw))}%`;
}

/**
 * 路径前缀过滤（目录搜索）：/a/b → /a/b/%
 * - 只转义前缀本身，末尾的 % 作为通配符保留
 * @param {string|null|undefined} pathPrefix
 */
export function buildPathPrefixLikePattern(pathPrefix) {
  const prefix = String(pathPrefix ?? "").replace(/\/+$/g, "") || "/";
  if (prefix === "/") return "/%";
  return `${escapeLikePattern(prefix)}/%`;
}

/**
 * 统一形参归一化
 * @param {any} p
 */
export function normalizeSearchParams(p) {
  return {
    query: normalizeSearchQuery(p?.query),
    allowedMountIds: Array.isArray(p?.allowedMountIds) ? p.allowedMountIds.filter(Boolean).map(String) : [],
    scope: p?.scope || "global",
    mountId: p?.mountId ? String(p.mountId) : "",
    pathPrefix: p?.pathPrefix ? String(p.pathPrefix) : "",
    cursorObj: p?.cursorObj || null,
  };
}

/**
 * 构造 WHERE 子句（Postgres / MySQL 共用，占位符由 ph 决定）
 *
 * @param {any} p 查询参数
 * @param {(value:any)=>string} ph 占位符工厂（会同时把值推进 bind 数组）
 * @param {{ matchExpression: (ph:(value:any)=>string, query:string)=>string }} options
 * @returns {string} `WHERE ...`
 */
export function buildWhereSql(p, ph, options) {
  const params = normalizeSearchParams(p);
  const where = [];

  // 权限约束：只允许 allowedMountIds 内的挂载点
  if (params.allowedMountIds.length === 0) {
    where.push(`1 = 0`);
  } else {
    where.push(`e.mount_id IN (${params.allowedMountIds.map((id) => ph(id)).join(", ")})`);
  }

  if ((params.scope === "mount" || params.scope === "directory") && params.mountId) {
    where.push(`e.mount_id = ${ph(params.mountId)}`);
  }

  if (params.pathPrefix) {
    where.push(`e.fs_path LIKE ${ph(buildPathPrefixLikePattern(params.pathPrefix))} ESCAPE '${LIKE_ESCAPE_CHAR}'`);
  }

  // keyset 分页：modified_ms DESC, fs_path ASC, id DESC
  if (params.cursorObj) {
    const c = params.cursorObj;
    const modifiedMs = Number(c.modifiedMs) || 0;
    const fsPath = String(c.fsPath || "");
    const id = Number(c.id) || 0;
    where.push(
      `(e.modified_ms < ${ph(modifiedMs)}` +
        ` OR (e.modified_ms = ${ph(modifiedMs)} AND e.fs_path > ${ph(fsPath)})` +
        ` OR (e.modified_ms = ${ph(modifiedMs)} AND e.fs_path = ${ph(fsPath)} AND e.id < ${ph(id)}))`,
    );
  }

  where.push(options.matchExpression(ph, params.query));

  return `WHERE ${where.join(" AND ")}`;
}

/**
 * 子目录聚合 SQL 的公共 SELECT 尾部（Postgres / MySQL 各自覆写函数部分）
 */
export function normalizeParentDir(parentDirFsPath) {
  let parent = String(parentDirFsPath ?? "").trim();
  if (!parent) return null;
  if (parent !== "/" && !parent.endsWith("/")) parent = `${parent}/`;
  return parent;
}
