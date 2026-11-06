/**
 * Range 降级策略（上游忽略 Range 时如何响应）
 *
 * 背景：
 * - 部分上游（尤其 WebDAV，及 Cloudflare → Cloudflare 的转发链）会忽略 Range 头，直接返回 200 全量。
 * - 此时有两种兜底：
 *   - `software`：用 ByteSliceStream 边读边丢弃前缀，凑出 206（兼容性最好，但大 offset 会读掉大量字节）
 *   - `full`：直接返回 200 全量，让客户端自己处理（避免“看似 206 但一直加载/黑屏”）
 *
 * 该文件不引入任何依赖，供驱动层、工厂层、流式层共用，避免循环引用。
 */

export const RANGE_FALLBACK_POLICIES = Object.freeze(["software", "full"]);

/** 全局默认策略 */
export const DEFAULT_RANGE_FALLBACK_POLICY = "software";

/**
 * 归一化策略取值：仅接受白名单，其余（含 undefined/null/大小写混写）回落默认值。
 * @param {unknown} value
 * @param {"software" | "full"} [fallback]
 * @returns {"software" | "full"}
 */
export function normalizeRangeFallbackPolicy(value, fallback = DEFAULT_RANGE_FALLBACK_POLICY) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (RANGE_FALLBACK_POLICIES.includes(normalized)) return normalized;
  return fallback;
}
