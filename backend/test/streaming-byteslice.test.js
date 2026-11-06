/**
 * 流式层回归测试：ByteSliceStream 软件切片 + 响应头
 *
 * 覆盖 UPSTREAM_AUDIT.md 的三个发现：
 *  - A（致命）：start > 0 时 pull() 空手 return，ReadableStream 不会自动重拉 → 流永久挂起
 *  - B（高）： 上游提前 EOF 时无条件 close，不校验已交付字节数 → 静默截断
 *  - C（高）： size 未知时仍声明 Accept-Ranges: bytes
 *
 * 运行：node --test --test-concurrency=1 test/streaming-byteslice.test.js
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

import {
  wrapStreamWithByteSlice,
  wrapNodeStreamWithByteSlice,
  smartWrapStreamWithByteSlice,
} from "../src/storage/streaming/ByteSliceStream.js";
import { buildResponseHeaders } from "../src/storage/streaming/utils.js";

/** 用固定分块构造 Web ReadableStream（用于模拟上游分块投递） */
function webStreamFromChunks(chunks) {
  const queue = chunks.slice();
  return new ReadableStream({
    pull(controller) {
      if (!queue.length) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(queue.shift()));
    },
  });
}

/** 把 Web 流整体读出（带超时，用于判断是否挂起） */
async function readAll(stream, timeoutMs = 1500) {
  const reader = stream.getReader();
  const out = [];
  const readLoop = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      out.push(value);
    }
  })();

  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("HUNG: 读取超时，流没有推进")), timeoutMs);
  });

  try {
    await Promise.race([readLoop, timeout]);
  } finally {
    clearTimeout(timer);
  }
  return Uint8Array.from(out.flatMap((c) => Array.from(c)));
}

const range = (n) => Array.from({ length: n }, (_, i) => i % 251);

// ---------------------------------------------------------------- 发现 A

test("A: start > 0 时不会挂起（丢弃前缀块后继续读）", async () => {
  const data = range(1000);
  // 每块 100 字节：start=350 落在第 4 块内部，前面 3 块整块被丢弃
  const chunks = [];
  for (let i = 0; i < data.length; i += 100) chunks.push(data.slice(i, i + 100));

  const sliced = wrapStreamWithByteSlice(webStreamFromChunks(chunks), 350, 549);
  const got = await readAll(sliced);

  assert.equal(got.length, 200, "应交付 200 字节");
  assert.deepEqual(Array.from(got), data.slice(350, 550));
});

test("A: start 远超单块时仍然推进（多块被丢弃）", async () => {
  const data = range(4096);
  const chunks = [];
  for (let i = 0; i < data.length; i += 64) chunks.push(data.slice(i, i + 64));

  const sliced = wrapStreamWithByteSlice(webStreamFromChunks(chunks), 4000, 4095);
  const got = await readAll(sliced);

  assert.deepEqual(Array.from(got), data.slice(4000, 4096));
});

test("A: start = 0 行为不变（首块直接命中）", async () => {
  const data = range(300);
  const sliced = wrapStreamWithByteSlice(webStreamFromChunks([data.slice(0, 100), data.slice(100, 300)]), 0, 99);
  const got = await readAll(sliced);
  assert.deepEqual(Array.from(got), data.slice(0, 100));
});

// ---------------------------------------------------------------- 发现 B

test("B: 上游提前 EOF 必须报错，而不是静默少给", async () => {
  const data = range(200);
  // 承诺 0-499（500 字节），上游只有 200 字节
  const sliced = wrapStreamWithByteSlice(webStreamFromChunks([data]), 0, 499);
  await assert.rejects(() => readAll(sliced), /byte slice ended at 200 bytes but 500 bytes were promised/);
});

test("B: 上游恰好给够时不报错（边界不误伤）", async () => {
  const data = range(200);
  const sliced = wrapStreamWithByteSlice(webStreamFromChunks([data]), 0, 199);
  const got = await readAll(sliced);
  assert.deepEqual(Array.from(got), data);
});

test("B: Node 版提前 EOF 同样报错", async () => {
  const data = range(120);
  const nodeStream = Readable.from([Buffer.from(data)]);
  const sliced = wrapNodeStreamWithByteSlice(nodeStream, 0, 299);
  await assert.rejects(() => readAll(sliced), /byte slice ended at 120 bytes but 300 bytes were promised/);
});

test("B: Node 版正常切片（start > 0）", async () => {
  const data = range(600);
  const nodeStream = Readable.from([Buffer.from(data.slice(0, 250)), Buffer.from(data.slice(250))]);
  const sliced = wrapNodeStreamWithByteSlice(nodeStream, 100, 399);
  const got = await readAll(sliced);
  assert.deepEqual(Array.from(got), data.slice(100, 400));
});

// ---------------------------------------------------------------- 发现 C

test("C: size 未知时不发 Accept-Ranges（也不再发长度头）", () => {
  const headers = buildResponseHeaders({ contentType: "video/mp4", size: null }, null, "fs-web");
  assert.equal(headers.get("Accept-Ranges"), null, "size 未知不应声明支持 Range");
  assert.equal(headers.get("Content-Length"), null);
  assert.equal(headers.get("Content-Range"), null);
});

test("C: size 已知时正常声明 Accept-Ranges 与 Content-Length", () => {
  const headers = buildResponseHeaders({ contentType: "video/mp4", size: 1024 }, null, "fs-web");
  assert.equal(headers.get("Accept-Ranges"), "bytes");
  assert.equal(headers.get("Content-Length"), "1024");
});

test("C: 206 场景 Content-Range 使用真实总长", () => {
  const headers = buildResponseHeaders({ contentType: "video/mp4", size: 1024 }, { start: 100, end: 199 }, "fs-web");
  assert.equal(headers.get("Content-Length"), "100");
  assert.equal(headers.get("Content-Range"), "bytes 100-199/1024");
});

// ---------------------------------------------------------------- 分派

test("smartWrapStreamWithByteSlice: Node 流走 Node 分支且不挂起", async () => {
  const data = range(300);
  const sliced = smartWrapStreamWithByteSlice(Readable.from([Buffer.from(data)]), 50, 149);
  const got = await readAll(sliced);
  assert.deepEqual(Array.from(got), data.slice(50, 150));
});

test("smartWrapStreamWithByteSlice: 未知类型抛错（不静默降级）", () => {
  assert.throws(() => smartWrapStreamWithByteSlice({}, 0, 1), /不支持的流类型/);
});
