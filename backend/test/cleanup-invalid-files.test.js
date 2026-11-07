/**
 * CleanupInvalidFilesTask 回归测试
 *
 * 覆盖点：
 * - 过期判定与 FileService.validateFileAccess 一致（expires_at 早于当前；views 严格大于 max_views）
 * - views === max_views 时不算失效（还能再看一次，不能被清掉）
 * - dryRun 默认只统计不删除
 * - 分批 + maxBatches 上限
 * - deleteStorageObject 打开时：存储删除失败的文件记录必须保留（不产生孤儿对象）
 *
 * 运行：node --test --test-concurrency=1 test/cleanup-invalid-files.test.js
 */

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { CleanupInvalidFilesTask } from "../src/scheduled/tasks/CleanupInvalidFilesTask.js";
import { ObjectStore } from "../src/storage/object/ObjectStore.js";

/**
 * 把 node:sqlite 包成 D1 的最小兼容层：只实现 prepare/bind/all/first/run
 */
function createD1Shim() {
  const sqlite = new DatabaseSync(":memory:");

  return {
    sqlite,
    prepare(sql) {
      const statement = sqlite.prepare(String(sql));
      const stmt = {
        _params: [],
        bind(...args) {
          this._params = args;
          return this;
        },
        async all() {
          const rows = statement.all(...this._params);
          return { results: rows, success: true, meta: {} };
        },
        async first() {
          const row = statement.get(...this._params);
          return row ?? null;
        },
        async run() {
          const info = statement.run(...this._params);
          return {
            success: true,
            meta: { changes: Number(info?.changes ?? 0) },
            changes: Number(info?.changes ?? 0),
          };
        },
      };
      return stmt;
    },
  };
}

function setupDb() {
  const db = createD1Shim();
  db.sqlite.exec(`
    CREATE TABLE files (
      id TEXT PRIMARY KEY,
      slug TEXT,
      filename TEXT NOT NULL,
      storage_config_id TEXT,
      storage_type TEXT,
      storage_path TEXT,
      file_path TEXT,
      mimetype TEXT,
      size INTEGER DEFAULT 0,
      expires_at TEXT,
      max_views INTEGER,
      views INTEGER DEFAULT 0,
      created_by TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.sqlite.exec(`
    CREATE TABLE file_passwords (
      file_id TEXT PRIMARY KEY,
      plain_password TEXT NOT NULL
    );
  `);
  return db;
}

function insertFile(db, row) {
  db.sqlite
    .prepare(
      `INSERT INTO files (id, slug, filename, storage_config_id, storage_type, storage_path, file_path, mimetype, size, expires_at, max_views, views, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.id,
      row.slug ?? row.id,
      row.filename ?? `${row.id}.txt`,
      row.storage_config_id ?? "sc1",
      row.storage_type ?? "S3",
      row.storage_path ?? `path/${row.id}`,
      row.file_path ?? null,
      row.mimetype ?? "text/plain",
      row.size ?? 10,
      row.expires_at ?? null,
      row.max_views ?? null,
      row.views ?? 0,
      row.created_by ?? "admin-1"
    );
}

function countFiles(db) {
  return Number(db.sqlite.prepare("SELECT COUNT(*) AS c FROM files").get().c) || 0;
}

const NOW = "2026-01-01T00:00:00.000Z";

test("dryRun 默认：只统计命中数量，不删除任何记录", async () => {
  const db = setupDb();
  insertFile(db, { id: "expired", expires_at: "2020-01-01T00:00:00.000Z" });
  insertFile(db, { id: "exhausted", max_views: 3, views: 4 });
  insertFile(db, { id: "healthy" });

  const task = new CleanupInvalidFilesTask();
  const result = await task.run({ db, env: {}, now: NOW, config: {} });

  assert.equal(result.dryRun, true);
  assert.equal(result.matched, 2);
  assert.equal(result.deletedRecords, 0);
  assert.equal(countFiles(db), 3);
});

test("关掉 dryRun：过期与次数用尽都被删除，附带的 file_passwords 一并清理", async () => {
  const db = setupDb();
  insertFile(db, { id: "expired", expires_at: "2020-01-01T00:00:00.000Z" });
  insertFile(db, { id: "exhausted", max_views: 3, views: 4 });
  insertFile(db, { id: "healthy" });
  db.sqlite.prepare("INSERT INTO file_passwords (file_id, plain_password) VALUES (?, ?)").run("expired", "1234");

  const task = new CleanupInvalidFilesTask();
  const result = await task.run({ db, env: {}, now: NOW, config: { dryRun: false } });

  assert.equal(result.deletedRecords, 2);
  assert.equal(result.deletedPasswords, 1);
  assert.equal(countFiles(db), 1);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS c FROM file_passwords").get().c, 0);
});

test("views === max_views 不算失效（还能再看一次，不得被清理）", async () => {
  const db = setupDb();
  insertFile(db, { id: "boundary", max_views: 3, views: 3 });

  const task = new CleanupInvalidFilesTask();
  const result = await task.run({ db, env: {}, now: NOW, config: { dryRun: false } });

  assert.equal(result.matched, 0);
  assert.equal(countFiles(db), 1);
});

test("只启用其中一个条件时，另一个条件的记录不受影响", async () => {
  const db = setupDb();
  insertFile(db, { id: "expired", expires_at: "2020-01-01T00:00:00.000Z" });
  insertFile(db, { id: "exhausted", max_views: 1, views: 2 });

  const task = new CleanupInvalidFilesTask();
  const result = await task.run({
    db,
    env: {},
    now: NOW,
    config: { dryRun: false, deleteViewsExhausted: false },
  });

  assert.equal(result.deletedRecords, 1);
  assert.equal(countFiles(db), 1);
  assert.equal(db.sqlite.prepare("SELECT id FROM files").get().id, "exhausted");
});

test("batchSize 与 maxBatches 生效：单次运行不会清空全部命中项", async () => {
  const db = setupDb();
  for (let i = 0; i < 7; i += 1) {
    insertFile(db, { id: `exp-${i}`, expires_at: "2020-01-01T00:00:00.000Z" });
  }

  const task = new CleanupInvalidFilesTask();
  const result = await task.run({
    db,
    env: {},
    now: NOW,
    config: { dryRun: false, batchSize: 2, maxBatches: 2 },
  });

  assert.equal(result.matched, 4);
  assert.equal(result.deletedRecords, 4);
  assert.equal(result.batches, 2);
  assert.equal(countFiles(db), 3);
});

test("deleteStorageObject：存储删除失败的文件记录必须保留（不产生孤儿对象）", async () => {
  const db = setupDb();
  insertFile(db, { id: "keep-on-failure", expires_at: "2020-01-01T00:00:00.000Z" });

  const task = new CleanupInvalidFilesTask();
  const original = ObjectStoreDeleteSpy.install(() => {
    throw new Error("Access Denied");
  });

  try {
    const result = await task.run({
      db,
      env: { ENCRYPTION_SECRET: "test-secret" },
      now: NOW,
      config: { dryRun: false, deleteStorageObject: true },
    });

    assert.equal(result.storageDeleteFailures, 1);
    assert.equal(result.deletedRecords, 0);
    assert.equal(countFiles(db), 1);
  } finally {
    original();
  }
});

test("deleteStorageObject：对象已被上游删除（NotFound）时仍应清理记录", async () => {
  const db = setupDb();
  insertFile(db, { id: "gone-upstream", expires_at: "2020-01-01T00:00:00.000Z" });

  const task = new CleanupInvalidFilesTask();
  const original = ObjectStoreDeleteSpy.install(() => {
    const error = new Error("文件不存在");
    error.name = "NotFoundError";
    throw error;
  });

  try {
    const result = await task.run({
      db,
      env: { ENCRYPTION_SECRET: "test-secret" },
      now: NOW,
      config: { dryRun: false, deleteStorageObject: true },
    });

    assert.equal(result.storageDeleteFailures, 0);
    assert.equal(result.deletedRecords, 1);
    assert.equal(countFiles(db), 0);
  } finally {
    original();
  }
});

test("两个清理条件都关闭时直接返回，不访问数据库", async () => {
  const db = setupDb();
  insertFile(db, { id: "expired", expires_at: "2020-01-01T00:00:00.000Z" });

  const task = new CleanupInvalidFilesTask();
  const result = await task.run({
    db,
    env: {},
    now: NOW,
    config: { dryRun: false, deleteExpired: false, deleteViewsExhausted: false },
  });

  assert.equal(result.matched, 0);
  assert.equal(countFiles(db), 1);
});

test("verifyStorage：记录还在但对象已被外部删除的文件也应被识别并清理", async () => {
  const db = setupDb();
  // 记录层完全正常（未过期、次数未用尽），只有对象丢了
  insertFile(db, { id: "object-gone" });
  insertFile(db, { id: "object-ok" });

  const task = new CleanupInvalidFilesTask();
  const original = ObjectStoreInfoSpy.install((row) => {
    if (row === "path/object-gone") {
      const error = new Error("文件不存在");
      error.name = "NotFoundError";
      throw error;
    }
    return { size: 10 };
  });

  try {
    const result = await task.run({
      db,
      env: { ENCRYPTION_SECRET: "test-secret" },
      now: NOW,
      config: { dryRun: false, deleteExpired: false, deleteViewsExhausted: false, verifyStorage: true },
    });

    assert.equal(result.storageChecked, 2);
    assert.equal(result.storageMissing, 1);
    assert.equal(result.deletedRecords, 1);
    assert.equal(countFiles(db), 1);
    assert.equal(db.sqlite.prepare("SELECT id FROM files").get().id, "object-ok");
  } finally {
    original();
  }
});

test("verifyStorage + dryRun：只统计存储层命中数，不删除任何记录", async () => {
  const db = setupDb();
  insertFile(db, { id: "object-gone" });
  insertFile(db, { id: "expired", expires_at: "2020-01-01T00:00:00.000Z" });

  const task = new CleanupInvalidFilesTask();
  const original = ObjectStoreInfoSpy.install(() => {
    const error = new Error("文件不存在");
    error.name = "NotFoundError";
    throw error;
  });

  try {
    const result = await task.run({
      db,
      env: { ENCRYPTION_SECRET: "test-secret" },
      now: NOW,
      config: { dryRun: true, verifyStorage: true },
    });

    assert.equal(result.dryRun, true);
    assert.equal(result.recordLevelMatched, 1);
    assert.equal(result.storageMissing, 1);
    assert.equal(result.matched, 2);
    assert.equal(result.deletedRecords, 0);
    assert.equal(countFiles(db), 2);
  } finally {
    original();
  }
});

test("verifyStorage：存储不可达（非 NotFound）不算文件丢失，记录必须保留", async () => {
  const db = setupDb();
  insertFile(db, { id: "unreachable" });

  const task = new CleanupInvalidFilesTask();
  const original = ObjectStoreInfoSpy.install(() => {
    throw new Error("connect ECONNREFUSED");
  });

  try {
    const result = await task.run({
      db,
      env: { ENCRYPTION_SECRET: "test-secret" },
      now: NOW,
      config: { dryRun: false, deleteExpired: false, deleteViewsExhausted: false, verifyStorage: true },
    });

    assert.equal(result.storageChecked, 1);
    assert.equal(result.storageMissing, 0);
    assert.equal(result.storageUnreachable, 1);
    assert.equal(result.deletedRecords, 0);
    assert.equal(countFiles(db), 1);
  } finally {
    original();
  }
});

/**
 * 只替换 ObjectStore.prototype.getInfoByStoragePath，避免真连存储
 * impl 收到 storagePath，可抛 NotFoundError（对象已丢失）或返回 { size }
 */
const ObjectStoreInfoSpy = {
  install(impl) {
    const proto = ObjectStore.prototype;
    const originalDescriptor = Object.getOwnPropertyDescriptor(proto, "getInfoByStoragePath");
    proto.getInfoByStoragePath = async function (_storageConfigId, key) {
      return await impl(key);
    };
    return () => {
      if (originalDescriptor) {
        Object.defineProperty(proto, "getInfoByStoragePath", originalDescriptor);
      } else {
        delete proto.getInfoByStoragePath;
      }
    };
  },
};

/**
 * 只替换 ObjectStore.prototype.deleteByStoragePath，避免真连存储
 */
const ObjectStoreDeleteSpy = {
  install(impl) {
    const proto = ObjectStore.prototype;
    const originalDescriptor = Object.getOwnPropertyDescriptor(proto, "deleteByStoragePath");
    proto.deleteByStoragePath = async function () {
      return await impl();
    };
    return () => {
      if (originalDescriptor) {
        Object.defineProperty(proto, "deleteByStoragePath", originalDescriptor);
      } else {
        delete proto.deleteByStoragePath;
      }
    };
  },
};
