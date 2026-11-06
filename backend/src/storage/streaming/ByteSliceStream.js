/**
 * ByteSliceStream - 软件层面的字节切片流
 *
 * 当上游存储不支持 HTTP Range 请求（返回 200 而非 206）时，
 * 使用此 TransformStream 在内存中实现字节范围切片。
 *
 * - 跳过前 `start` 个字节
 * - 输出从 start 到 end 的字节
 * - 到达 end 后立即关闭流
 *
 * - WebDAV 服务器不支持 Range 请求
 * - 任何返回完整流但需要部分内容的场景
 * - 对于大文件前部偏移量较大的情况，仍需读取并丢弃大量数据
 * - 建议优先使用驱动原生 Range 支持，此类作为降级方案
 */

/**
 * 创建字节切片 TransformStream
 * @param {number} start - 起始字节（包含）
 * @param {number} end - 结束字节（包含）
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
export function createByteSliceStream(start, end) {
  let position = 0;
  let finished = false;

  return new TransformStream({
    transform(chunk, controller) {
      if (finished) {
        // 已完成，忽略后续数据
        return;
      }

      const chunkStart = position;
      const chunkEnd = position + chunk.byteLength - 1;
      position += chunk.byteLength;

      // 情况1：整个 chunk 在范围之前，跳过
      if (chunkEnd < start) {
        return;
      }

      // 情况2：整个 chunk 在范围之后，结束
      if (chunkStart > end) {
        finished = true;
        controller.terminate();
        return;
      }

      // 情况3：chunk 与范围有交集，计算需要输出的部分
      const sliceStart = Math.max(0, start - chunkStart);
      const sliceEnd = Math.min(chunk.byteLength, end - chunkStart + 1);

      if (sliceStart < sliceEnd) {
        const slice = chunk.subarray(sliceStart, sliceEnd);
        controller.enqueue(slice);
      }

      // 检查是否已到达结束位置
      if (chunkEnd >= end) {
        finished = true;
        controller.terminate();
      }
    },

    flush(controller) {
      // 流正常结束时无需额外操作
    },
  });
}

/**
 * 将完整流包装为范围流
 * @param {ReadableStream<Uint8Array>} fullStream - 完整文件流
 * @param {number} start - 起始字节（包含）
 * @param {number} end - 结束字节（包含）
 * @returns {ReadableStream<Uint8Array>} 切片后的流
 */
export function wrapStreamWithByteSlice(fullStream, start, end) {
  const reader = fullStream.getReader();
  let position = 0;
  let finished = false;

  const closeUpstream = async () => {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  };

  return new ReadableStream({
    async pull(controller) {
      if (finished) return;
      try {
        // 关键：一次 pull 必须“产出结果”（enqueue / close / error），不能空手返回。
        // ReadableStream 的 pull 既不 enqueue 也不 close 时，运行时不会自动再次调用 pull，
        // 整条流会永久挂起 —— start > 0 丢弃前缀块就是这条路径。
        // 因此这里用 for (;;)：continue 跳过前缀块，return 表示本次 pull 已交付。
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            finished = true;
            // 上游提前 EOF：承诺的字节没读够时必须报错，而不是静默 close，
            // 否则响应体已声明 Content-Length，消费方会把残缺内容当成完整文件。
            if (position <= end) {
              controller.error(new Error(`byte slice ended at ${position} bytes but ${end + 1} bytes were promised`));
            } else {
              controller.close();
            }
            return;
          }

          const data = value instanceof Uint8Array ? value : new Uint8Array(value);
          const chunkStart = position;
          const chunkEnd = position + data.byteLength - 1;
          position += data.byteLength;

          // 整个 chunk 在范围之前：跳过并继续读（continue，绝不 return）
          if (chunkEnd < start) {
            continue;
          }

          if (chunkStart > end) {
            finished = true;
            await closeUpstream();
            controller.close();
            return;
          }

          const sliceStart = Math.max(0, start - chunkStart);
          const sliceEnd = Math.min(data.byteLength, end - chunkStart + 1);
          if (sliceStart < sliceEnd) {
            controller.enqueue(data.subarray(sliceStart, sliceEnd));
          }

          if (chunkEnd >= end) {
            finished = true;
            await closeUpstream();
            controller.close();
          }
          return;
        }
      } catch (e) {
        finished = true;
        await closeUpstream();
        controller.error(e);
      }
    },
    async cancel() {
      finished = true;
      await closeUpstream();
    },
  });
}

/**
 * 为 Node.js Readable 流创建字节切片包装
 * 返回 Web ReadableStream 以保持 API 一致性
 * @param {import('stream').Readable} nodeStream - Node.js 可读流
 * @param {number} start - 起始字节（包含）
 * @param {number} end - 结束字节（包含）
 * @returns {ReadableStream<Uint8Array>} 切片后的 Web ReadableStream
 */
export function wrapNodeStreamWithByteSlice(nodeStream, start, end) {
  let position = 0;
  let finished = false;

  return new ReadableStream({
    async start(controller) {
      nodeStream.on("data", (chunk) => {
        if (finished) {
          return;
        }

        // 确保 chunk 是 Uint8Array
        const data = typeof chunk === "string" ? Buffer.from(chunk) : chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);

        const chunkStart = position;
        const chunkEnd = position + data.byteLength - 1;
        position += data.byteLength;

        // 整个 chunk 在范围之前，跳过
        if (chunkEnd < start) {
          return;
        }

        // 整个 chunk 在范围之后，结束
        if (chunkStart > end) {
          finished = true;
          nodeStream.destroy();
          controller.close();
          return;
        }

        // chunk 与范围有交集
        const sliceStart = Math.max(0, start - chunkStart);
        const sliceEnd = Math.min(data.byteLength, end - chunkStart + 1);

        if (sliceStart < sliceEnd) {
          const slice = data.subarray(sliceStart, sliceEnd);
          controller.enqueue(slice);
        }

        // 检查是否已到达结束位置
        if (chunkEnd >= end) {
          finished = true;
          nodeStream.destroy();
          controller.close();
          return;
        }

        // 背压：队列已满时暂停上游，等下游 pull 时再恢复。
        // 不加这一段时 "data" 事件会持续把大文件塞进内存队列。
        if (typeof nodeStream.pause === "function" && controller.desiredSize !== null && controller.desiredSize <= 0) {
          nodeStream.pause();
        }
      });

      nodeStream.on("end", () => {
        if (finished) {
          return;
        }
        finished = true;
        // 与 Web 版一致：上游提前 EOF 且字节没给够时必须报错，不能静默 close。
        if (position <= end) {
          controller.error(new Error(`byte slice ended at ${position} bytes but ${end + 1} bytes were promised`));
        } else {
          controller.close();
        }
      });

      nodeStream.on("error", (err) => {
        finished = true;
        controller.error(err);
      });
    },

    // 下游消费后再恢复上游读取，形成背压闭环
    pull() {
      if (!finished && typeof nodeStream.resume === "function") {
        nodeStream.resume();
      }
    },

    cancel(reason) {
      finished = true;
      nodeStream.destroy();
    },
  });
}

/**
 * 智能包装流以支持字节切片
 * 自动检测流类型（Web ReadableStream 或 Node.js Readable）并应用切片
 * @param {ReadableStream<Uint8Array> | import('stream').Readable} stream - 输入流
 * @param {number} start - 起始字节（包含）
 * @param {number} end - 结束字节（包含）
 * @returns {ReadableStream<Uint8Array>} 切片后的流
 */
export function smartWrapStreamWithByteSlice(stream, start, end) {
  // 检测是否为 Web ReadableStream
  if (stream && typeof stream.getReader === "function") {
    return wrapStreamWithByteSlice(stream, start, end);
  }

  // 检测是否为 Node.js Readable
  if (stream && typeof stream.pipe === "function" && typeof stream.on === "function") {
    return wrapNodeStreamWithByteSlice(stream, start, end);
  }

  // 未知类型，抛出错误
  throw new Error("不支持的流类型，无法应用字节切片");
}
