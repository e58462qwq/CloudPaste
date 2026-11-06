/**
 * WebDAV 驱动的 UTF-8 Basic Auth（对应上游 PR #171）
 *
 * 背景：webdav 客户端内部用 `base-64` 库编码 `username:password`，该库只接受 Latin1，
 * 中文用户名/密码会抛 “The string to be encoded contains characters outside of the Latin1 range”。
 * 驱动因此改为自己生成 Authorization 头（Buffer + utf8）。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { WebDavStorageDriver } from "../src/storage/drivers/webdav/WebDavStorageDriver.js";

function decodeBasic(header) {
  assert.match(header, /^Basic /);
  return Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
}

function createDriver(config = {}) {
  return new WebDavStorageDriver({
    endpoint_url: "https://dav.example.com/remote.php/dav/files/demo/",
    username: "用户",
    password: "encrypted-placeholder",
    ...config,
  });
}

test("_basicAuthHeader：中文凭据按 UTF-8 编码，可原样解回", () => {
  const driver = createDriver();
  driver.decryptedPassword = "密码123";

  const header = driver._basicAuthHeader();
  assert.equal(decodeBasic(header), "用户:密码123");
  // 与标准 base64(utf8) 一致，可被任何按 RFC 7617 解析的服务端还原
  assert.equal(header.slice("Basic ".length), Buffer.from("用户:密码123", "utf8").toString("base64"));
});

test("_basicAuthHeader：纯 ASCII 凭据与旧实现等价", () => {
  const driver = createDriver({ username: "alice" });
  driver.decryptedPassword = "s3cret";

  const header = driver._basicAuthHeader();
  assert.equal(header, `Basic ${Buffer.from("alice:s3cret").toString("base64")}`);
  assert.equal(decodeBasic(header), "alice:s3cret");
});

test("_basicAuthHeader：passwordOverride 优先于已解密密码（initialize 传明文用）", () => {
  const driver = createDriver({ username: "alice" });
  driver.decryptedPassword = "stale";

  assert.equal(decodeBasic(driver._basicAuthHeader("前台密码")), "alice:前台密码");
});

test("_basicAuthHeader：密码缺失时只编码用户名与冒号，不产出 undefined", () => {
  const driver = createDriver({ username: "alice" });
  driver.decryptedPassword = null;

  const header = driver._basicAuthHeader();
  assert.equal(decodeBasic(header), "alice:");
  assert.doesNotMatch(header, /undefined/);
});

test("构造函数：range_fallback_policy 缺省 full，可被存储配置覆盖", () => {
  assert.equal(createDriver().rangeFallbackPolicy, "full");
  assert.equal(createDriver({ range_fallback_policy: "software" }).rangeFallbackPolicy, "software");
  assert.equal(createDriver({ range_fallback_policy: "  FULL " }).rangeFallbackPolicy, "full");
  assert.equal(createDriver({ range_fallback_policy: "garbage" }).rangeFallbackPolicy, "full");
});
