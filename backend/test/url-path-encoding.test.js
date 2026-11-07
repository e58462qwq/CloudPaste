/**
 * 直链路径编码回归测试
 *
 * 背景：对象 key 里允许出现 `#`、`?`、`%`、空格、中文、emoji。
 * 这些字符若原样拼进 URL，浏览器会把 `#` 当成 fragment 起点，链接从 `#` 处被截断，
 * 用户拿到的是"看起来一样但打不开"的直链（真实故障：文件名 `藏好了吗🩸... #万圣节 ... - 1.mp4`）。
 *
 * 本测试锁定：
 * - encodePathSegments / joinUrlWithEncodedPath 的逐段百分号编码口径
 * - S3 custom_host 直链（path_style true/false）
 * - ObjectLinkStrategy（对象视图）与 StorageStrategy（挂载视图）的 custom_host 口径一致
 *
 * 运行：node --test --test-concurrency=1 test/url-path-encoding.test.js
 */

import test from "node:test";
import assert from "node:assert/strict";

import { encodePathSegments, joinUrlWithEncodedPath } from "../src/storage/utils/PathCodec.js";
import { generateCustomHostDirectUrl, buildS3Url } from "../src/storage/drivers/s3/utils/s3Utils.js";
import { resolveStorageLinks as resolveObjectLinks } from "../src/storage/object/ObjectLinkStrategy.js";
import { resolveStorageLinks as resolveMountLinks } from "../src/storage/utils/StorageStrategy.js";
import { buildProxyPath, safeDecodeProxyPath } from "../src/constants/proxy.js";

const NASTY_NAME = "藏好了吗🩸我来抓你咯👻😈 #万圣节 #万圣节氛围到位了 #藏好别被我发现 #甜酷辣妹 #暗黑系穿搭 - 1.mp4";
const NASTY_KEY = `tmp/${NASTY_NAME}`;

test("encodePathSegments：`#` 必须编码为 %23，结果中不能残留裸 #", () => {
  const encoded = encodePathSegments(NASTY_KEY);
  assert.ok(!encoded.includes("#"), `编码后仍残留裸 #：${encoded}`);
  assert.ok(encoded.includes("%23"), "`#` 应被编码为 %23");
});

test("encodePathSegments：保留 `/` 作为路径分隔，中文与 emoji 逐段百分号编码", () => {
  const encoded = encodePathSegments("tmp/中文/👻.mp4");
  assert.equal(encoded.split("/").length, 3);
  assert.ok(encoded.startsWith("tmp/"));
  assert.ok(!encoded.includes("中"));
  assert.ok(!encoded.includes("👻"));
  assert.match(encoded, /^tmp\/%E4%B8%AD%E6%96%87\/%F0%9F%91%BB\.mp4$/);
});

test("encodePathSegments：`?` `%` 空格等同样不得原样保留", () => {
  const encoded = encodePathSegments("a/b?c%d e.txt");
  assert.ok(!encoded.includes("?"));
  assert.ok(!encoded.includes(" "));
  // `%` 自身必须编码成 %25，否则解码端会把它当转义引导符
  assert.ok(!/%[^0-9A-Fa-f]/.test(encoded.replace(/%[0-9A-Fa-f]{2}/g, "")));
  assert.equal(encoded, "a/b%3Fc%25d%20e.txt");
});

test("encodePathSegments：unreserved 字符与已有合法结构保持原样（不做二次编码）", () => {
  assert.equal(encodePathSegments("a-b_c.d~/e/f.mp4"), "a-b_c.d~/e/f.mp4");
  assert.equal(encodePathSegments(""), "");
});

test("joinUrlWithEncodedPath：base 末尾斜杠、path 前导斜杠都不产生双斜杠", () => {
  assert.equal(joinUrlWithEncodedPath("https://cdn.example.com/", "/tmp/a.png"), "https://cdn.example.com/tmp/a.png");
  assert.equal(joinUrlWithEncodedPath("https://cdn.example.com", "tmp/a.png"), "https://cdn.example.com/tmp/a.png");
  assert.equal(joinUrlWithEncodedPath("https://cdn.example.com/", ""), "https://cdn.example.com");
});

test("generateCustomHostDirectUrl（path_style=false）：`#` 必须编码，URL 不会被截断", () => {
  const url = generateCustomHostDirectUrl(
    { custom_host: "https://cp.s3.example.com/", bucket_name: "bucket", path_style: 0 },
    NASTY_KEY,
  );

  assert.ok(url.startsWith("https://cp.s3.example.com/tmp/"));
  assert.ok(!url.includes("#"), `直链里残留裸 #，浏览器会截断：${url}`);
  assert.ok(url.includes("%23%E4%B8%87%E5%9C%A3%E8%8A%82"), "`#万圣节` 应编码为 %23%E4%B8%87%E5%9C%A3%E8%8A%82");

  // 用真实 URL 解析器复核：路径完整、没有 fragment
  const parsed = new URL(url);
  assert.equal(parsed.hash, "", "直链不应带 fragment（否则后续内容会被浏览器丢弃）");
  assert.equal(decodeURIComponent(parsed.pathname), `/tmp/${NASTY_NAME}`, "解码后必须还原出原始 key");
});

test("generateCustomHostDirectUrl（path_style=true）：bucket 与 key 都要编码", () => {
  const url = generateCustomHostDirectUrl(
    { custom_host: "https://cp.s3.example.com", bucket_name: "my bucket", path_style: 1 },
    `/${NASTY_KEY}`,
  );

  assert.ok(url.startsWith("https://cp.s3.example.com/my%20bucket/tmp/"));
  const parsed = new URL(url);
  assert.equal(parsed.hash, "");
  assert.equal(decodeURIComponent(parsed.pathname), `/my bucket/tmp/${NASTY_NAME}`);
});

test("buildS3Url（上传返回的 publicUrl）：key 同样要逐段编码，否则一样会被 `#` 截断", () => {
  const pathStyle = buildS3Url(
    { bucket_name: "bucket", endpoint_url: "https://s3.example.com", path_style: 1 },
    NASTY_KEY,
  );
  assert.ok(!pathStyle.includes("#"), `路径样式 publicUrl 残留裸 #：${pathStyle}`);
  assert.equal(decodeURIComponent(new URL(pathStyle).pathname), `/bucket/${NASTY_KEY}`);

  const vhost = buildS3Url(
    { bucket_name: "bucket", endpoint_url: "https://s3.example.com", path_style: 0 },
    `/${NASTY_KEY}`,
  );
  assert.ok(!vhost.includes("#"), `虚拟主机样式 publicUrl 残留裸 #：${vhost}`);
  assert.equal(decodeURIComponent(new URL(vhost).pathname), `/${NASTY_KEY}`);
});

test("ObjectLinkStrategy：storage-first 直链同样逐段编码（与 S3 custom_host 一致）", async () => {
  const driver = { hasCapability: () => false };
  const links = await resolveObjectLinks({
    driver,
    storageConfig: { custom_host: "https://cp.s3.example.com" },
    path: NASTY_KEY,
  });

  assert.equal(links.preview.type, "custom_host");
  assert.ok(!links.preview.url.includes("#"), `预览直链残留裸 #：${links.preview.url}`);
  assert.ok(!links.download.url.includes("#"), `下载直链残留裸 #：${links.download.url}`);
  assert.equal(decodeURIComponent(new URL(links.preview.url).pathname), `/${NASTY_KEY}`);
});

test("StorageStrategy（挂载视图）：custom_host 直链与对象视图同口径", async () => {
  const driver = { type: "S3", hasCapability: () => false };
  const links = await resolveMountLinks({
    driver,
    storageConfig: { custom_host: "https://cp.s3.example.com/", storage_type: "S3" },
    path: `/${NASTY_KEY}`,
  });

  assert.equal(links.preview.type, "custom_host");
  assert.ok(!links.preview.url.includes("#"));
  assert.equal(decodeURIComponent(new URL(links.preview.url).pathname), `/${NASTY_KEY}`);
});

test("buildProxyPath：本地 /api/p 代理入口同样要编码，且能被 safeDecodeProxyPath 原样还原", () => {
  const fsPath = `/mount/${NASTY_KEY}`;
  const proxyPath = buildProxyPath(fsPath, false);

  assert.ok(proxyPath.startsWith("/api/p/mount/tmp/"), `代理路径前缀不对：${proxyPath}`);
  assert.ok(!proxyPath.includes("#"), `代理路径残留裸 #，链接会在 # 处被截断：${proxyPath}`);

  // 入口侧依赖 safeDecodeProxyPath 还原；这里验证往返一致（否则代理会 404）
  const rawPath = new URL(proxyPath, "http://localhost").pathname.replace(/^\/api\/p/, "") || "/";
  assert.equal(safeDecodeProxyPath(rawPath), fsPath);

  const downloadPath = buildProxyPath(fsPath, true);
  assert.ok(downloadPath.endsWith("?download=true"));
  assert.ok(!downloadPath.split("?")[0].includes("#"));
});
