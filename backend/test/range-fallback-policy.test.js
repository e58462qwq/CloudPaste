/**
 * Range 降级策略（发现 G）单元测试
 *
 * 覆盖：
 * 1) normalizeRangeFallbackPolicy 的白名单归一与默认值回落
 * 2) StorageFactory WEBDAV 的 configSchema / configProjector 已暴露该字段
 * 3) 历史行为兼容：未配置时 WebDAV 仍回落 full（不是全局默认 software）
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  RANGE_FALLBACK_POLICIES,
  DEFAULT_RANGE_FALLBACK_POLICY,
  normalizeRangeFallbackPolicy,
} from "../src/storage/streaming/rangeFallbackPolicy.js";
import { StorageFactory } from "../src/storage/factory/StorageFactory.js";

test("normalizeRangeFallbackPolicy：只接受 software / full", () => {
  assert.deepEqual([...RANGE_FALLBACK_POLICIES], ["software", "full"]);
  assert.equal(DEFAULT_RANGE_FALLBACK_POLICY, "software");

  assert.equal(normalizeRangeFallbackPolicy("software"), "software");
  assert.equal(normalizeRangeFallbackPolicy("full"), "full");
});

test("normalizeRangeFallbackPolicy：大小写与空白都会被归一", () => {
  assert.equal(normalizeRangeFallbackPolicy("  FULL  "), "full");
  assert.equal(normalizeRangeFallbackPolicy("Software"), "software");
});

test("normalizeRangeFallbackPolicy：脏值回落默认值，不会把流式层带进未定义分支", () => {
  for (const dirty of [undefined, null, "", "  ", "FULLSCAN", "1", 0, {}, []]) {
    assert.equal(normalizeRangeFallbackPolicy(dirty), DEFAULT_RANGE_FALLBACK_POLICY, `dirty=${String(dirty)}`);
  }
});

test("normalizeRangeFallbackPolicy：可显式指定 fallback（WebDAV 用 full 兼容历史行为）", () => {
  assert.equal(normalizeRangeFallbackPolicy(undefined, "full"), "full");
  assert.equal(normalizeRangeFallbackPolicy("bogus", "full"), "full");
  assert.equal(normalizeRangeFallbackPolicy("software", "full"), "software");
});

test("StorageFactory：WEBDAV configSchema 暴露 range_fallback_policy，默认 full", () => {
  const meta = StorageFactory.getTypeMetadata("WEBDAV");
  assert.ok(meta?.configSchema?.fields, "WEBDAV 应有 configSchema");

  const field = meta.configSchema.fields.find((f) => f.name === "range_fallback_policy");
  assert.ok(field, "应存在 range_fallback_policy 字段");
  assert.equal(field.type, "enum");
  assert.equal(field.required, false);
  assert.equal(field.defaultValue, "full");
  assert.deepEqual(
    field.enumValues.map((v) => v.value),
    ["full", "software"],
  );
  // 每个枚举值都要有 i18n labelKey，否则前端下拉是空白
  for (const v of field.enumValues) {
    assert.match(v.labelKey, /^admin\.storage\.rangeFallbackPolicy\./);
  }
  assert.equal(field.ui?.descriptionKey, "admin.storage.description.range_fallback_policy");
});

test("StorageFactory：applyConfigJsonDefaultValues 会用 schema 默认值补齐 full", () => {
  const cfg = { endpoint_url: "https://dav.example.com", username: "u" };
  StorageFactory.applyConfigJsonDefaultValues("WEBDAV", cfg);
  assert.equal(cfg.range_fallback_policy, "full");
});

test("StorageFactory：configProjector 输出归一后的 range_fallback_policy", () => {
  const legacy = StorageFactory.projectConfig("WEBDAV", { endpoint_url: "https://x", username: "u" });
  assert.equal(legacy.range_fallback_policy, "full", "存量配置无该字段时应回落 full（历史行为不变）");

  const software = StorageFactory.projectConfig("WEBDAV", { range_fallback_policy: "software" });
  assert.equal(software.range_fallback_policy, "software");

  const dirty = StorageFactory.projectConfig("WEBDAV", { range_fallback_policy: "huh" });
  assert.equal(dirty.range_fallback_policy, "full", "脏值应回落 WebDAV 的 full 而非全局 software");
});

test("StorageFactory：其它驱动不受影响，不会凭空出现 range_fallback_policy", () => {
  const s3 = StorageFactory.projectConfig("S3", { provider_type: "AWS S3", bucket_name: "b" });
  assert.equal(Object.prototype.hasOwnProperty.call(s3, "range_fallback_policy"), false);
});
