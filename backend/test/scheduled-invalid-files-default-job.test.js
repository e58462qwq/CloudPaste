/**
 * cleanup_invalid_files 默认调度作业的初始化回归测试
 *
 * 背景：任务 handler 注册进 registry 只会在「可执行任务列表」里出现类型，
 * 若不写入默认 scheduled_jobs 行，用户不手动创建就永远不会被定时触发。
 * 两条路径都要覆盖：
 * - 存量库升级：migrations.js 的 case 35
 * - 全新库初始化：seed.js 的 initDefaultSettings（initDatabase 会预标记 app-v01..vNN，
 *   case 35 不会执行，所以必须由 seed 写入）
 *
 * 运行：node --test --test-concurrency=1 test/scheduled-invalid-files-default-job.test.js
 */

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { runLegacyMigrationByVersion } from "../src/db/migrations/sqlite/engine/migrations.js";
import { initDatabase } from "../src/db/migrations/sqlite/engine/initDatabase.js";

function createD1Shim(sqlite) {
  return {
    prepare(sql) {
      const statement = sqlite.prepare(String(sql));
      const stmt = {
        _params: [],
        bind(...args) {
          this._params = args;
          return this;
        },
        async all() {
          return { results: statement.all(...this._params), success: true, meta: {} };
        },
        async first() {
          return statement.get(...this._params) ?? null;
        },
        async run() {
          const info = statement.run(...this._params);
          const changes = Number(info?.changes ?? 0);
          return { success: true, meta: { changes }, changes };
        },
      };
      return stmt;
    },
  };
}

function readJob(sqlite, taskId) {
  const row = sqlite.prepare("SELECT * FROM scheduled_jobs WHERE task_id = ?").get(taskId);
  return row ?? null;
}

test("迁移 case 35：存量库升级后自动获得 cleanup_invalid_files 默认作业", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE scheduled_jobs (
      task_id TEXT PRIMARY KEY,
      handler_id TEXT,
      name TEXT,
      description TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      schedule_type TEXT NOT NULL DEFAULT 'interval',
      interval_sec INTEGER,
      cron_expression TEXT,
      run_count INTEGER DEFAULT 0,
      failure_count INTEGER DEFAULT 0,
      last_run_status TEXT,
      last_run_started_at DATETIME,
      last_run_finished_at DATETIME,
      next_run_after DATETIME,
      lock_until DATETIME,
      config_json TEXT NOT NULL DEFAULT '{}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 模拟一个已经有其他默认作业的存量库
  sqlite
    .prepare(
      `INSERT INTO scheduled_jobs (task_id, handler_id, name, enabled, schedule_type, interval_sec, config_json)
       VALUES (?, ?, ?, 1, 'interval', ?, '{}')`,
    )
    .run("cleanup_upload_sessions", "cleanup_upload_sessions", "清理分片上传会话（默认）", 86400);

  const db = createD1Shim(sqlite);
  await runLegacyMigrationByVersion(db, 35);

  const job = readJob(sqlite, "cleanup_invalid_files");
  assert.ok(job, "迁移 35 之后必须存在 cleanup_invalid_files 作业");
  assert.equal(job.handler_id, "cleanup_invalid_files");
  assert.equal(job.enabled, 1);
  assert.equal(job.schedule_type, "interval");
  assert.equal(Number(job.interval_sec), 86400);
  assert.ok(job.next_run_after, "必须写入 next_run_after，否则不会被到期扫描捡到");

  const config = JSON.parse(job.config_json);
  // 默认必须是试运行，避免升级后立刻删数据
  assert.equal(config.dryRun, true);
  assert.equal(config.batchSize, 100);
  assert.equal(config.maxBatches, 5);
  assert.equal(config.deleteExpired, true);
  assert.equal(config.deleteViewsExhausted, true);
  assert.equal(config.deleteStorageObject, false);

  // 幂等：再跑一次不应重复插入，也不应改动已有记录
  await runLegacyMigrationByVersion(db, 35);
  const count = Number(sqlite.prepare("SELECT COUNT(*) AS c FROM scheduled_jobs").get().c);
  assert.equal(count, 2);
});

test("全新库初始化：initDatabase 也要写入 cleanup_invalid_files 默认作业", async () => {
  const sqlite = new DatabaseSync(":memory:");
  await initDatabase(createD1Shim(sqlite));

  const job = readJob(sqlite, "cleanup_invalid_files");
  assert.ok(job, "全新库必须自带 cleanup_invalid_files 默认作业（case 35 不会执行）");
  assert.equal(Number(job.interval_sec), 86400);
  assert.equal(JSON.parse(job.config_json).dryRun, true);

  // 另外两个既有默认作业不受影响
  assert.ok(readJob(sqlite, "cleanup_upload_sessions"));
  assert.ok(readJob(sqlite, "refresh_storage_usage_snapshots"));
});
