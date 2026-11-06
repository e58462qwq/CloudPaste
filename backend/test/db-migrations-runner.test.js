/**
 * 迁移运行器回归测试
 *
 * 覆盖 PR #219 的改动：把「每条迁移一次 SELECT」改成「循环前一次性读取」，
 * 同时保留 adopt/baseline 在 up() 内批量写 schema_migrations 的正确性。
 *
 * 运行：node --test --test-concurrency=1 test/db-migrations-runner.test.js
 */

import test from "node:test";
import assert from "node:assert/strict";

import { applyMigrations, getAppliedMigrationIds } from "../src/db/migrations/runner.js";

/**
 * 极简 D1 兼容假数据库：只认 SELECT id FROM schema_migrations / CREATE TABLE / INSERT
 * 记录 prepare 次数，用来断言「不再逐条 SELECT」。
 */
function createFakeDb(initialIds = []) {
  const applied = new Set(initialIds);
  const stats = { selectAll: 0, insert: 0 };

  return {
    stats,
    applied,
    prepare(sql) {
      const text = String(sql);
      const stmt = {
        _binds: [],
        bind(...args) {
          this._binds = args;
          return this;
        },
        async run() {
          if (/CREATE TABLE/i.test(text)) return { success: true, meta: { changes: 0 } };
          if (/INSERT/i.test(text)) {
            stats.insert += 1;
            applied.add(this._binds[0]);
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 1 } };
        },
        async all() {
          if (/SELECT\s+id\s+FROM\s+schema_migrations/i.test(text)) {
            stats.selectAll += 1;
            return { results: Array.from(applied).map((id) => ({ id })) };
          }
          return { results: [] };
        },
        async first() {
          return null;
        },
      };
      return stmt;
    },
  };
}

const migration = (id, fn) => ({ id, up: fn ?? (async () => true) });

test("已完成迁移的库：只查一次 schema_migrations（不再逐条 SELECT）", async () => {
  const ids = Array.from({ length: 35 }, (_, i) => `m${i}`);
  const db = createFakeDb(ids);
  let upCalls = 0;

  await applyMigrations(
    { db, dialect: null, env: {}, providerName: "sqlite" },
    ids.map((id) => migration(id, async () => void (upCalls += 1))),
  );

  assert.equal(upCalls, 0, "已应用的迁移不应再执行 up()");
  assert.equal(db.stats.selectAll, 1, "热路径只应有 1 次查询");
  assert.equal(db.stats.insert, 0);
});

test("空库：按顺序执行全部迁移并逐条写入记录", async () => {
  const db = createFakeDb([]);
  const order = [];

  await applyMigrations(
    { db, dialect: null, env: {}, providerName: "sqlite" },
    ["a", "b", "c"].map((id) => migration(id, async () => void order.push(id))),
  );

  assert.deepEqual(order, ["a", "b", "c"]);
  assert.equal(db.stats.insert, 3);
  assert.deepEqual(Array.from(db.applied).sort(), ["a", "b", "c"]);
});

test("up() 内部批量写入 schema_migrations 后，后续迁移不会被重复执行", async () => {
  const db = createFakeDb([]);
  const executed = [];

  const migrations = [
    // 模拟 adopt/baseline：一次性把 b、c 也标记为已应用
    migration("a", async () => {
      executed.push("a");
      db.applied.add("b");
      db.applied.add("c");
    }),
    migration("b", async () => void executed.push("b")),
    migration("c", async () => void executed.push("c")),
    migration("d", async () => void executed.push("d")),
  ];

  await applyMigrations({ db, dialect: null, env: {}, providerName: "sqlite" }, migrations);

  assert.deepEqual(executed, ["a", "d"], "b/c 已被 up() 批量标记，不应重复执行");
  assert.deepEqual(Array.from(db.applied).sort(), ["a", "b", "c", "d"]);
});

test("重复 migration id 直接报错（防止静默漏执行）", async () => {
  const db = createFakeDb([]);
  await assert.rejects(
    () =>
      applyMigrations({ db, dialect: null, env: {}, providerName: "sqlite" }, [
        migration("x"),
        migration("x"),
      ]),
    /重复的 id/,
  );
});

test("getAppliedMigrationIds 返回去重后的 id 集合", async () => {
  const db = createFakeDb(["p", "q"]);
  const set = await getAppliedMigrationIds(db);
  assert.ok(set instanceof Set);
  assert.deepEqual(Array.from(set).sort(), ["p", "q"]);
});
