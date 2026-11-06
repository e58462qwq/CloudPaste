/**
 * FS 搜索方言单测（node:test）
 *
 * 覆盖：
 * 1) 注册表：名称归一化 / 未知回退 sqlite / env 推导
 * 2) 最小查询长度：sqlite=3，postgres/mysql=1
 * 3) LIKE 转义：% _ # 被转义，contains 与 pathPrefix 各自动生成
 * 4) 三种方言的 SQL 形态与 bind 顺序（含 cursor keyset、空 allowedMountIds）
 * 5) 游标跨方言通用性：sqlite 生成的 cursor 能被 postgres/mysql 复用
 * 6) 子目录聚合 SQL 的方言差异（substr/instr vs POSITION vs LOCATE）
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  createSearchDialect,
  getSearchMinQueryLength,
  isSearchQueryLongEnough,
  normalizeSearchDialectName,
  resolveSearchDialectName,
  SEARCH_DIALECT_NAMES,
  DEFAULT_SEARCH_MIN_QUERY_LENGTH,
} from "../src/storage/fs/search/dialects/index.js";
import {
  buildContainsLikePattern,
  buildPathPrefixLikePattern,
  escapeLikePattern,
  LIKE_ESCAPE_CHAR,
} from "../src/storage/fs/search/dialects/common.js";
import { createSqliteFts5TrigramDialect } from "../src/storage/fs/search/dialects/sqliteFts5TrigramDialect.js";

const cursorObj = { modifiedMs: 1700000000000, fsPath: "/docs/a", id: 42 };

function baseParams(overrides = {}) {
  return {
    query: "report",
    allowedMountIds: ["m1", "m2"],
    scope: "mount",
    mountId: "m1",
    pathPrefix: "/docs",
    cursorObj: null,
    ...overrides,
  };
}

test("注册表：三种方言可用，名称归一化与别名", () => {
  assert.deepEqual(SEARCH_DIALECT_NAMES.sort(), ["mysql", "postgres", "sqlite"]);
  assert.equal(normalizeSearchDialectName("SQLite"), "sqlite");
  assert.equal(normalizeSearchDialectName(" pg "), "postgres");
  assert.equal(normalizeSearchDialectName("postgresql"), "postgres");
  assert.equal(normalizeSearchDialectName("MariaDB"), "mysql");
  assert.equal(normalizeSearchDialectName("oracle"), null);
  assert.equal(normalizeSearchDialectName(undefined), null);
});

test("注册表：未知 / 缺失回退 sqlite（不以抛错破坏线上）", () => {
  assert.equal(createSearchDialect("oracle").id, "sqlite-fts5-trigram");
  assert.equal(createSearchDialect(undefined).id, "sqlite-fts5-trigram");
  assert.equal(createSearchDialect(null).id, "sqlite-fts5-trigram");
});

test("env 推导：DB_PROVIDER / DB_DIALECT，未知回退 sqlite", () => {
  assert.equal(resolveSearchDialectName({}), "sqlite");
  assert.equal(resolveSearchDialectName({ DB_PROVIDER: "PostgreSQL" }), "postgres");
  assert.equal(resolveSearchDialectName({ DB_DIALECT: "mysql" }), "mysql");
  assert.equal(resolveSearchDialectName({ DB_PROVIDER: "oracle" }), "sqlite");
});

test("最小查询长度按方言区分", () => {
  assert.equal(getSearchMinQueryLength({}), 3);
  assert.equal(getSearchMinQueryLength({ DB_PROVIDER: "sqlite" }), 3);
  assert.equal(getSearchMinQueryLength({ DB_PROVIDER: "postgres" }), 1);
  assert.equal(getSearchMinQueryLength({ DB_PROVIDER: "mysql" }), 1);
  assert.equal(DEFAULT_SEARCH_MIN_QUERY_LENGTH, 3);

  assert.equal(isSearchQueryLongEnough("ab", {}), false);
  assert.equal(isSearchQueryLongEnough("abc", {}), true);
  assert.equal(isSearchQueryLongEnough("a", { DB_PROVIDER: "postgres" }), true);
  assert.equal(isSearchQueryLongEnough("   ", { DB_PROVIDER: "postgres" }), false);
});

test("LIKE 转义：通配符与转义符自身", () => {
  assert.equal(LIKE_ESCAPE_CHAR, "#");
  assert.equal(escapeLikePattern("50%_x"), "50#%#_x");
  assert.equal(escapeLikePattern("a#b"), "a##b");
  assert.equal(buildContainsLikePattern("  report  "), "%report%");
  assert.equal(buildContainsLikePattern("50%"), "%50#%%");
  assert.equal(buildPathPrefixLikePattern("/a/b/"), "/a/b/%");
  assert.equal(buildPathPrefixLikePattern("/"), "/%");
  assert.equal(buildPathPrefixLikePattern(""), "/%");
  assert.equal(buildPathPrefixLikePattern("/a_1"), "/a#_1/%");
});

test("sqlite 方言：FTS5 MATCH + 表别名，bind 顺序与历史基线一致", () => {
  const dialect = createSearchDialect("sqlite");
  assert.equal(dialect.id, "sqlite-fts5-trigram");
  assert.equal(dialect.minQueryLength, 3);

  const { sql, bind } = dialect.buildSearchSql(baseParams({ query: "report" }));
  assert.match(sql, /FROM fs_search_index_fts f/);
  assert.match(sql, /JOIN fs_search_index_entries e ON e\.id = f\.rowid/);
  assert.match(sql, /fs_search_index_fts MATCH \?/);
  assert.match(sql, /ORDER BY e\.modified_ms DESC, e\.fs_path ASC, e\.id DESC/);
  assert.match(sql, /LIMIT \?/);

  assert.deepEqual(bind, ["m1", "m2", "m1", "/docs/%", '"report"']);
});

test("sqlite 方言：cursor keyset 三组条件带 6 个 bind", () => {
  const dialect = createSearchDialect("sqlite");
  const { sql, bind } = dialect.buildSearchSql(baseParams({ cursorObj }));

  assert.match(sql, /e\.modified_ms < \?/);
  assert.match(sql, /e\.modified_ms = \? AND e\.fs_path > \?/);
  assert.match(sql, /e\.fs_path = \? AND e\.id < \?/);
  assert.deepEqual(bind.slice(-7), [
    1700000000000,
    1700000000000,
    "/docs/a",
    1700000000000,
    "/docs/a",
    42,
    '"report"',
  ]);
});

test("sqlite 方言：FTS5 查询串用双引号包裹并转义内部引号", () => {
  const dialect = createSearchDialect("sqlite");
  const { bind } = dialect.buildSearchSql(baseParams({ query: 'he said "hi"' }));
  assert.equal(bind[bind.length - 1], '"he said ""hi"""');
});

test("postgres 方言：$n 递增占位符 + ILIKE ESCAPE + 单表扫描", () => {
  const dialect = createSearchDialect("postgres");
  assert.equal(dialect.id, "postgres-like-contains");
  assert.equal(dialect.minQueryLength, 1);
  assert.equal(dialect.containsMode, "ilike");

  const { sql, bind } = dialect.buildSearchSql(baseParams({ query: "50%_x" }));

  assert.doesNotMatch(sql, /fs_search_index_fts/);
  assert.match(sql, /FROM fs_search_index_entries e/);
  assert.match(sql, /e\.name ILIKE \$\d+ ESCAPE '#'/);
  assert.match(sql, /e\.fs_path ILIKE \$\d+ ESCAPE '#'/);
  assert.match(sql, /LIMIT \$\d+/);

  // $1,$2=allowedMountIds → $3=mountId → $4=pathPrefix → $5,$6=两个 ILIKE → $7=LIMIT
  assert.deepEqual(bind, ["m1", "m2", "m1", "/docs/%", "%50#%#_x%", "%50#%#_x%"]);
  assert.match(sql, /e\.name ILIKE \$5 ESCAPE '#'/);
  assert.match(sql, /e\.fs_path ILIKE \$6 ESCAPE '#'/);
  assert.match(sql, /LIMIT \$7/);

  const placeholders = [...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
  assert.equal(Math.max(...placeholders), bind.length + 1);
});

test("postgres 方言：cursor 条件也走 $n，且 bind 数量与占位符总数对齐", () => {
  const dialect = createSearchDialect("postgres");
  const { sql, bind } = dialect.buildSearchSql(baseParams({ cursorObj }));

  // $1,$2 IN → $3 mountId → $4 pathPrefix → $5..$10 cursor → $11,$12 match → $13 LIMIT
  assert.match(sql, /e\.modified_ms < \$5/);
  const placeholders = [...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
  assert.equal(Math.max(...placeholders), bind.length + 1);
  assert.deepEqual(bind.slice(0, 4), ["m1", "m2", "m1", "/docs/%"]);
});

test("mysql 方言：? 占位符 + LIKE ESCAPE + 单表扫描", () => {
  const dialect = createSearchDialect("mysql");
  assert.equal(dialect.id, "mysql-like-contains");
  assert.equal(dialect.minQueryLength, 1);
  assert.equal(dialect.containsMode, "like");

  const { sql, bind } = dialect.buildSearchSql(baseParams({ query: "report" }));

  assert.doesNotMatch(sql, /fs_search_index_fts/);
  assert.match(sql, /e\.name LIKE \? ESCAPE '#'/);
  assert.match(sql, /e\.fs_path LIKE \? ESCAPE '#'/);
  assert.match(sql, /LIMIT \?/);
  assert.doesNotMatch(sql, /\$\d/);

  assert.deepEqual(bind, ["m1", "m2", "m1", "/docs/%", "%report%", "%report%"]);

  const qMarks = (sql.match(/\?/g) || []).length;
  assert.equal(qMarks, bind.length + 1);
});

test("count SQL：三方言都是 COUNT(1) AS total，且 bind 不含 LIMIT 位", () => {
  for (const name of ["sqlite", "postgres", "mysql"]) {
    const dialect = createSearchDialect(name);
    const search = dialect.buildSearchSql(baseParams());
    const count = dialect.buildCountSql(baseParams());
    assert.match(count.sql, /SELECT COUNT\(1\) AS total/);
    // LIMIT 的值由 store 侧额外 bind，不进入方言返回的 bind，因此两者等长
    assert.deepEqual(count.bind, search.bind);
    assert.doesNotMatch(count.sql, /LIMIT/);
  }
});

test("空 allowedMountIds：不产出 IN () 语法错，改为 1 = 0 恒假", () => {
  for (const name of ["sqlite", "postgres", "mysql"]) {
    const dialect = createSearchDialect(name);
    const { sql, bind } = dialect.buildSearchSql(baseParams({ allowedMountIds: [] }));
    assert.match(sql, /1 = 0/);
    assert.doesNotMatch(sql, /IN \(\)/);
    // scope=mount 仍会追加 mountId，所以只剩它 + pathPrefix + 匹配表达式
    assert.equal(bind[0], "m1");
    assert.equal(bind[1], "/docs/%");
  }
});

test("global scope 不追加 mountId 条件", () => {
  for (const name of ["postgres", "mysql"]) {
    const dialect = createSearchDialect(name);
    const mount = dialect.buildSearchSql(baseParams({ scope: "mount" }));
    const global = dialect.buildSearchSql(baseParams({ scope: "global" }));
    assert.ok(mount.bind.length > global.bind.length);
    assert.doesNotMatch(global.sql, /e\.mount_id = \$3/);
  }
});

test("游标跨方言通用：同一 cursorObj 在三方言下产生等价边界", () => {
  const expected = [1700000000000, 1700000000000, "/docs/a", 1700000000000, "/docs/a", 42];

  for (const name of ["sqlite", "postgres", "mysql"]) {
    const { bind } = createSearchDialect(name).buildSearchSql(baseParams({ cursorObj }));
    const start = bind.indexOf(1700000000000);
    assert.ok(start >= 0, `${name} 未生成 cursor 边界`);
    // 三方言的 cursor 六元组必须完全一致，差异只在匹配表达式（sqlite 1 个 / pg|mysql 2 个）
    assert.deepEqual(bind.slice(start, start + 6), expected, name);
  }
});

test("子目录聚合：sqlite 用 substr/instr，postgres 用 POSITION，mysql 用 LOCATE + CONCAT", () => {
  const sqlite = createSqliteFts5TrigramDialect();
  const pg = createSearchDialect("postgres");
  const my = createSearchDialect("mysql");

  const s = sqlite.buildChildDirectoryAggregatesSql("m1", "/docs");
  const p = pg.buildChildDirectoryAggregatesSql("m1", "/docs");
  const m = my.buildChildDirectoryAggregatesSql("m1", "/docs");

  assert.match(s.sql, /instr\(rel, '\/'\)/);
  assert.doesNotMatch(s.sql, /POSITION|LOCATE/);
  assert.equal(s.bind[1], "m1");
  assert.equal(s.bind[2], "/docs/%");
  assert.equal(s.bind[3], "/docs/");

  assert.match(p.sql, /POSITION\('\/' IN rel\)/);
  assert.doesNotMatch(p.sql, /instr|LOCATE/);
  assert.equal(p.bind[0], s.bind[0]);
  assert.equal(p.bind[3], "/docs/");

  assert.match(m.sql, /LOCATE\('\/', rel\)/);
  assert.match(m.sql, /CONCAT\(\?, SUBSTRING/);
  assert.doesNotMatch(m.sql, /instr/);

  // 三种方言的 startPos / mountId / likePrefix / parent 完全一致，便于跨库回填
  assert.deepEqual(p.bind, s.bind);
  assert.deepEqual(m.bind, s.bind);
});

test("子目录聚合：空路径返回 null（由 store 侧转成空数组）", () => {
  for (const name of ["sqlite", "postgres", "mysql"]) {
    const dialect = createSearchDialect(name);
    assert.equal(dialect.buildChildDirectoryAggregatesSql("m1", ""), null);
    assert.equal(dialect.buildChildDirectoryAggregatesSql("m1", "   "), null);
  }
});

test("状态方法与方言无关：store 不把 dialect 用进 upsert/delete", async () => {
  const { FsSearchIndexStore } = await import("../src/storage/fs/search/FsSearchIndexStore.js");
  const store = new FsSearchIndexStore({ prepare: () => { throw new Error("should not touch db"); } }, {
    dialectName: "postgres",
  });
  assert.equal(store.dialect.id, "postgres-like-contains");
  assert.throws(() => new FsSearchIndexStore(null), /缺少 db/);
});

test("store：仅给 env 也能解析出方言（路由层漏传 dialect 时不退化成 sqlite）", async () => {
  const { FsSearchIndexStore } = await import("../src/storage/fs/search/FsSearchIndexStore.js");
  const noDb = { prepare: () => { throw new Error("should not touch db"); } };

  assert.equal(new FsSearchIndexStore(noDb, { env: { DB_PROVIDER: "postgres" } }).dialect.id, "postgres-like-contains");
  assert.equal(new FsSearchIndexStore(noDb, { env: { DB_DIALECT: "mysql" } }).dialect.id, "mysql-like-contains");
  assert.equal(new FsSearchIndexStore(noDb, { env: {} }).dialect.id, "sqlite-fts5-trigram");
  assert.equal(new FsSearchIndexStore(noDb).dialect.id, "sqlite-fts5-trigram");

  // 显式 dialect 优先级最高
  const explicit = createSearchDialect("mysql");
  assert.equal(new FsSearchIndexStore(noDb, { dialect: explicit, env: { DB_PROVIDER: "postgres" } }).dialect, explicit);
});

test("store：query 过短时的报错文案跟随方言最小长度", async () => {
  const { FsSearchIndexStore } = await import("../src/storage/fs/search/FsSearchIndexStore.js");
  const storeFor = (name) =>
    new FsSearchIndexStore({ prepare: () => { throw new Error("should not touch db"); } }, { dialectName: name });

  await assert.rejects(() => storeFor("sqlite").search({ query: "ab", allowedMountIds: ["m1"] }), /至少需要3个字符/);
  // postgres/mysql 只要求 1 个字符，会继续往下走到 db（这里故意让 db 抛错以证明已通过长度校验）
  await assert.rejects(
    () => storeFor("postgres").search({ query: "a", allowedMountIds: ["m1"] }),
    (err) => !/至少需要3个字符/.test(err.message)
  );
});

test("路径前缀通配符：三方言都转义 % 和 _，避免目录名被当成 LIKE 模式", () => {
  // 目录名里带 % 或 _ 是合法的（例如 "/100%_done"），不能让它变成通配符
  assert.equal(buildPathPrefixLikePattern("/100%_done"), "/100#%#_done/%");
  assert.equal(buildPathPrefixLikePattern("/"), "/%");
  assert.equal(buildPathPrefixLikePattern("/a/"), "/a/%");
  assert.equal(buildPathPrefixLikePattern(""), "/%");

  const params = { query: "report", allowedMountIds: ["m1"], pathPrefix: "/100%_done" };
  for (const name of ["sqlite", "postgres", "mysql"]) {
    const dialect = createSearchDialect(name);
    const { sql, bind } = dialect.buildSearchSql(params);
    assert.match(sql, /e\.fs_path LIKE [^)]*ESCAPE '#'/);
    const prefixBind = bind.find((v) => typeof v === "string" && v.includes("100"));
    assert.equal(prefixBind, "/100#%#_done/%");
  }
});

test("sqlite 方言与 common 的转义规则一致（LIKE ESCAPE 不漏）", () => {
  const dialect = createSearchDialect("sqlite");
  const withPrefix = dialect.buildSearchSql({ query: "abc", allowedMountIds: ["m1"], pathPrefix: "/a_b" });
  assert.match(withPrefix.sql, /e\.fs_path LIKE \? ESCAPE '#'/);
  assert.ok(withPrefix.bind.includes("/a#_b/%"));

  const noPrefix = dialect.buildSearchSql({ query: "abc", allowedMountIds: ["m1"] });
  assert.doesNotMatch(noPrefix.sql, /ESCAPE/);
});
