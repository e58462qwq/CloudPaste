/**
 * 文件有效性检测回归测试
 *
 * 覆盖 FileService.verifyFiles 的状态判定：
 * - 记录存在但对象缺失 → missing_object
 * - 存储不可达/鉴权失败 → error（不得误判为文件丢失）
 * - 记录过期 → expired
 * - 记录本身不存在 → missing_record
 * - 对象存在且大小一致 → valid
 *
 * 运行：node --test --test-concurrency=1 test/file-verify.test.js
 */

import test from "node:test";
import assert from "node:assert/strict";

import { FileService } from "../src/services/fileService.js";
import { ObjectStore } from "../src/storage/object/ObjectStore.js";
import { NotFoundError } from "../src/http/errors.js";
import { UserType } from "../src/constants/index.js";

/**
 * 构造一个只提供存储层行为的 FileService：
 * - fileRepository 用桩替代，避免依赖真实数据库
 * - ObjectStore.getInfoByStoragePath 用桩替代，避免依赖真实存储服务
 */
function createService({ records = [], storageBehavior = () => ({ size: 10 }) } = {}) {
  const service = new FileService({ prepare: () => ({ bind: () => ({ first: async () => null }) }) }, "test-secret", null);

  service.fileRepository = {
    async findByIdWithStorageConfig(id) {
      return records.find((row) => row.id === id) || null;
    },
    async findByIdAndCreator(id, ownerId) {
      return records.find((row) => row.id === id && row.created_by === ownerId) || null;
    },
  };

  const original = ObjectStore.prototype.getInfoByStoragePath;
  const calls = [];
  ObjectStore.prototype.getInfoByStoragePath = async function (storageConfigId, key) {
    calls.push({ storageConfigId, key });
    return await storageBehavior(storageConfigId, key);
  };

  return {
    service,
    calls,
    restore() {
      ObjectStore.prototype.getInfoByStoragePath = original;
    },
  };
}

const baseRecord = {
  id: "f1",
  filename: "a.txt",
  size: 10,
  storage_config_id: "sc1",
  storage_path: "path/a.txt",
  storage_type: "S3",
  file_path: null,
  expires_at: null,
  max_views: null,
  views: 0,
  created_by: "admin-1",
};

test("对象存在且大小一致 → valid", async () => {
  const ctx = createService({ records: [baseRecord], storageBehavior: () => ({ size: 10, mimetype: "text/plain" }) });
  try {
    const { results, summary } = await ctx.service.verifyFiles(["f1"]);

    assert.equal(results.length, 1);
    assert.equal(results[0].status, "valid");
    assert.equal(results[0].size_mismatch, false);
    assert.equal(results[0].storage_size, 10);
    assert.equal(summary.valid, 1);
    assert.equal(summary.invalid, 0);
    assert.deepEqual(ctx.calls, [{ storageConfigId: "sc1", key: "path/a.txt" }]);
  } finally {
    ctx.restore();
  }
});

test("对象存在但大小不符 → valid 且标记 size_mismatch", async () => {
  const ctx = createService({ records: [baseRecord], storageBehavior: () => ({ size: 999 }) });
  try {
    const { results } = await ctx.service.verifyFiles(["f1"]);
    assert.equal(results[0].status, "valid");
    assert.equal(results[0].size_mismatch, true);
    assert.equal(results[0].storage_size, 999);
  } finally {
    ctx.restore();
  }
});

test("对象缺失（NotFoundError）→ missing_object 并计入 invalid", async () => {
  const ctx = createService({
    records: [baseRecord],
    storageBehavior: () => {
      throw new NotFoundError("文件不存在");
    },
  });
  try {
    const { results, summary } = await ctx.service.verifyFiles(["f1"]);
    assert.equal(results[0].status, "missing_object");
    assert.equal(results[0].message, "存储中已找不到该文件对象");
    assert.equal(summary.invalid, 1);
    assert.equal(summary.error, 0);
  } finally {
    ctx.restore();
  }
});

test("存储不可达（普通异常）→ error，不得误判为文件丢失", async () => {
  const ctx = createService({
    records: [baseRecord],
    storageBehavior: () => {
      throw new Error("connect ETIMEDOUT");
    },
  });
  try {
    const { results, summary } = await ctx.service.verifyFiles(["f1"]);
    assert.equal(results[0].status, "error");
    assert.equal(results[0].message, "connect ETIMEDOUT");
    assert.equal(summary.invalid, 0);
    assert.equal(summary.error, 1);
  } finally {
    ctx.restore();
  }
});

test("记录已过期 → expired，且不触发存储检查", async () => {
  const expired = { ...baseRecord, expires_at: new Date(Date.now() - 60_000).toISOString() };
  const ctx = createService({ records: [expired] });
  try {
    const { results, summary } = await ctx.service.verifyFiles(["f1"]);
    assert.equal(results[0].status, "expired");
    assert.equal(summary.expired, 1);
    assert.equal(ctx.calls.length, 0);
  } finally {
    ctx.restore();
  }
});

test("记录不存在 → missing_record", async () => {
  const ctx = createService({ records: [] });
  try {
    const { results, summary } = await ctx.service.verifyFiles(["nope"]);
    assert.equal(results[0].status, "missing_record");
    assert.equal(summary.invalid, 1);
  } finally {
    ctx.restore();
  }
});

test("缺少存储路径 → error（无法定位对象）", async () => {
  const noPath = { ...baseRecord, storage_config_id: null, storage_path: null, file_path: null };
  const ctx = createService({ records: [noPath] });
  try {
    const { results } = await ctx.service.verifyFiles(["f1"]);
    assert.equal(results[0].status, "error");
    assert.equal(results[0].message, "记录缺少存储路径，无法定位对象");
  } finally {
    ctx.restore();
  }
});

test("API_KEY 只能检测自己创建的文件", async () => {
  const other = { ...baseRecord, id: "f2", created_by: "apikey:other" };
  const ctx = createService({ records: [other] });
  try {
    const { results } = await ctx.service.verifyFiles(["f2"], { userType: UserType.API_KEY, userId: "me" });
    assert.equal(results[0].status, "missing_record");
  } finally {
    ctx.restore();
  }
});

test("summary 汇总各状态数量", async () => {
  const records = [
    { ...baseRecord, id: "ok", storage_path: "p/ok" },
    { ...baseRecord, id: "gone", storage_path: "p/gone" },
    { ...baseRecord, id: "expired", expires_at: new Date(Date.now() - 1000).toISOString() },
  ];
  const ctx = createService({
    records,
    storageBehavior: (_cfg, key) => {
      if (key === "p/gone") throw new NotFoundError("文件不存在");
      return { size: 10 };
    },
  });
  try {
    const { summary } = await ctx.service.verifyFiles(["ok", "gone", "expired", "missing"]);
    assert.deepEqual(summary, { total: 4, valid: 1, invalid: 2, expired: 1, error: 0 });
  } finally {
    ctx.restore();
  }
});

test("批量检测保留输入顺序且忽略空 id", async () => {
  const records = [
    { ...baseRecord, id: "b", storage_path: "p/b" },
    { ...baseRecord, id: "a", storage_path: "p/a" },
  ];
  const ctx = createService({ records });
  try {
    const { results } = await ctx.service.verifyFiles(["b", null, "a"]);
    assert.deepEqual(
      results.map((r) => r.id),
      ["b", "a"]
    );
  } finally {
    ctx.restore();
  }
});

// ---------------------------------------------------------------------------
// ObjectStore.getInfoByStoragePath：storage-first 校验的 ctx 构造
// - storage-first 没有挂载点，必须给驱动一个只读 mount 桩，否则 S3 等驱动在
//   `if (db && mount.id)` 处会抛 TypeError（把"能校验"变成"必然异常"）
// - 桩的 id 必须为 null，避免驱动把"校验"变成一次挂载最后使用时间的写库
// ---------------------------------------------------------------------------

import { StorageFactory } from "../src/storage/factory/StorageFactory.js";

function createObjectStore({ storageConfig = { id: "sc1", storage_type: "S3", bucket_name: "b" } } = {}) {
  const repositoryFactory = {
    getStorageConfigRepository: () => ({
      async findByIdWithSecrets() {
        return storageConfig;
      },
      async findById() {
        return storageConfig;
      },
    }),
  };
  return new ObjectStore({}, "test-secret", repositoryFactory);
}

function stubCreateDriver(driver) {
  const original = StorageFactory.createDriver;
  StorageFactory.createDriver = async () => driver;
  return () => {
    StorageFactory.createDriver = original;
  };
}

test("getInfoByStoragePath 给驱动传入只读 mount 桩（id 为 null，不写挂载时间）", async () => {
  const seen = [];
  const driver = {
    async getFileInfo(key, ctx) {
      seen.push({ key, ctx });
      return { size: 42 };
    },
  };
  const restore = stubCreateDriver(driver);
  try {
    const store = createObjectStore();
    const info = await store.getInfoByStoragePath("sc1", "path/a.txt");

    assert.equal(info.size, 42);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].key, "path/a.txt");

    const { ctx } = seen[0];
    assert.equal(ctx.path, "path/a.txt");
    assert.equal(ctx.subPath, "path/a.txt");
    assert.ok(ctx.mount, "storage-first 校验必须提供 mount 桩");
    assert.equal(ctx.mount.id, null, "mount.id 必须为 null，避免驱动写回挂载使用时间");
    assert.equal(ctx.mount.storage_type, "S3");
    assert.equal(ctx.mount.storage_config_id, "sc1");
  } finally {
    restore();
  }
});

test("驱动只有 exists 时：不存在抛 NotFoundError，存在返回骨架信息", async () => {
  const driver = {
    async exists() {
      return false;
    },
  };
  let restore = stubCreateDriver(driver);
  try {
    const store = createObjectStore();
    await assert.rejects(() => store.getInfoByStoragePath("sc1", "p/x"), (error) => {
      assert.equal(error.name, "NotFoundError");
      return true;
    });
  } finally {
    restore();
  }

  const driver2 = {
    async exists() {
      return true;
    },
  };
  restore = stubCreateDriver(driver2);
  try {
    const store = createObjectStore();
    const info = await store.getInfoByStoragePath("sc1", "p/x");
    assert.equal(info.path, "p/x");
    assert.equal(info.size, null, "exists 只能证明存在，不能伪造 size");
    assert.equal(info.isDirectory, false);
  } finally {
    restore();
  }
});

test("驱动既无 getFileInfo 也无 exists → ValidationError（不谎报有效/失效）", async () => {
  const restore = stubCreateDriver({});
  try {
    const store = createObjectStore();
    await assert.rejects(() => store.getInfoByStoragePath("sc1", "p/x"), (error) => {
      assert.equal(error.name, "ValidationError");
      assert.equal(error.message, "当前驱动不支持按存储路径校验");
      return true;
    });
  } finally {
    restore();
  }
});
