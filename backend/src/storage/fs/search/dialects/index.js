/**
 * FS 搜索方言语义注册表
 *
 * 设计目标：
 * - 让 FsSearchIndexStore 不再硬编码 sqlite FTS5，改为按方言对象注入
 * - 未知 / 缺失配置一律回退 sqlite（与 db/providers、db/dialects 的降级策略保持一致），
 *   避免一个写错的 DB_PROVIDER 直接把搜索打挂
 *
 * 支持：
 * - sqlite：FTS5 trigram（Workers D1 / Docker SQLiteAdapter 主线）
 * - postgres：LIKE contains（$n 占位符 + ESCAPE '#'）
 * - mysql：LIKE contains（? 占位符 + ESCAPE '#'）
 */

import { createSqliteFts5TrigramDialect } from "./sqliteFts5TrigramDialect.js";
import { createPostgresDialect } from "./postgresDialect.js";
import { createMysqlDialect } from "./mysqlDialect.js";
import { normalizeSearchQuery } from "./common.js";

/** 默认最小查询长度（trigram contains 与 LIKE 扫描的公共下限） */
export const DEFAULT_SEARCH_MIN_QUERY_LENGTH = 3;

const SEARCH_DIALECT_FACTORIES = {
  sqlite: createSqliteFts5TrigramDialect,
  postgres: createPostgresDialect,
  mysql: createMysqlDialect,
};

export const SEARCH_DIALECT_NAMES = Object.keys(SEARCH_DIALECT_FACTORIES);

/**
 * 归一化方言名（未知返回 null，由调用方决定回退）
 * @param {any} name
 * @returns {string|null}
 */
export function normalizeSearchDialectName(name) {
  const key = String(name ?? "")
    .trim()
    .toLowerCase();
  if (!key) return null;
  if (SEARCH_DIALECT_FACTORIES[key]) return key;
  // 常见别名：pg / postgresql、mariadb
  if (key === "pg" || key === "postgresql") return "postgres";
  if (key === "mariadb") return "mysql";
  return null;
}

/**
 * 从 env（Worker bindings / Node process.env）推导搜索方言名
 * - 与 db/runtime.js 的 detectDbProviderName 保持同一语义，但本模块不依赖 db 层，
 *   避免 storage/fs 反向依赖 db provider 装配
 * @param {any} env
 * @returns {"sqlite"|"postgres"|"mysql"}
 */
export function resolveSearchDialectName(env = {}) {
  const explicit =
    env?.DB_PROVIDER ||
    env?.DB_DIALECT ||
    (typeof process !== "undefined" ? process.env?.DB_PROVIDER || process.env?.DB_DIALECT : null);
  return normalizeSearchDialectName(explicit) || "sqlite";
}

/**
 * 按名称创建搜索方言对象
 * @param {any} name 方言名；缺失或未知回退 sqlite
 */
export function createSearchDialect(name) {
  const normalized = normalizeSearchDialectName(name);
  const factory = SEARCH_DIALECT_FACTORIES[normalized || "sqlite"];
  return factory();
}

/**
 * 最小查询长度（供路由 / FileSystem 做入参校验，与 store 内部校验共用同一来源）
 * @param {any} env
 */
export function getSearchMinQueryLength(env = {}) {
  const dialect = createSearchDialect(resolveSearchDialectName(env));
  return Number(dialect?.minQueryLength) || DEFAULT_SEARCH_MIN_QUERY_LENGTH;
}

/**
 * 构造“查询过短”的统一提示，避免文案与方言常量脱节
 * @param {any} env
 */
export function buildSearchQueryTooShortMessage(env = {}) {
  return `搜索查询至少需要${getSearchMinQueryLength(env)}个字符`;
}

/**
 * 入参校验：查询非空且达到方言最小长度
 * @param {any} query
 * @param {any} env
 * @returns {boolean}
 */
export function isSearchQueryLongEnough(query, env = {}) {
  return normalizeSearchQuery(query).length >= getSearchMinQueryLength(env);
}
