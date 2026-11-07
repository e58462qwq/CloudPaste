/**
 * URL 路径编码工具
 *
 * 为什么需要它：
 * 对象 key（storage_path）里允许出现 `#`、`?`、空格、中文、emoji 等字符。
 * 这些字符一旦原样拼进 URL：
 * - `#` 会被浏览器当成 fragment 起点，链接从 `#` 处被截断，后面的内容全部丢失；
 * - `?` 会被当成 query 起点，路径被截断；
 * - `%` 会触发非法转义解析；
 * - 空格/中文/emoji 在部分客户端直接失败。
 * 所以生成"直链"时必须逐段编码，而存储里的 key 本身保持不变（绝不能把编码后的串写回数据库）。
 *
 * 编码口径：与 AWS SDK 生成 SigV4 规范 URI 时一致 —— 只保留 RFC 3986 unreserved 字符
 * （A-Z a-z 0-9 - _ . ~）与路径分隔符 `/`，其余一律百分号编码。
 * 这样 S3 及其兼容后端（以及各类 CDN 回源）按标准百分号解码后都能还原出原始 key。
 *
 * @module storage/utils/PathCodec
 */

// RFC 3986 unreserved
const UNRESERVED = /[A-Za-z0-9\-_.~]/;

/**
 * 编码单个路径段
 * @param {string} segment
 * @returns {string}
 */
function encodeSegment(segment) {
  const raw = String(segment ?? "");
  if (raw === "") return "";

  let out = "";
  for (const ch of raw) {
    if (UNRESERVED.test(ch)) {
      out += ch;
      continue;
    }
    // encodeURIComponent 对多字节字符（中文/emoji）会给出一段 %XX%XX，循环里逐码点处理即可
    out += encodeURIComponent(ch);
  }
  return out;
}

/**
 * 逐段编码对象 key，保留 `/` 作为路径分隔符
 *
 * 例：
 *   encodePathSegments("tmp/a #b.mp4")      -> "tmp/a%20%23b.mp4"
 *   encodePathSegments("/tmp/藏好了吗👻.mp4") -> "/tmp/%E8%97%8F%E5%A5%BD%E4%BA%86%E5%90%97%F0%9F%91%BB.mp4"
 *
 * @param {string} path - 原始对象 key（未编码）
 * @returns {string} 编码后的路径
 */
export function encodePathSegments(path) {
  const raw = String(path ?? "");
  if (raw === "") return "";
  return raw.split("/").map(encodeSegment).join("/");
}

/**
 * 把对象 key 拼到 base URL 后面，逐段编码
 *
 * @param {string} base - 基础地址（如 custom_host），末尾斜杠可有可无
 * @param {string} path - 原始对象 key（未编码），前导斜杠可有可无
 * @returns {string} 完整直链
 */
export function joinUrlWithEncodedPath(base, path) {
  const origin = String(base ?? "").replace(/\/+$/, "");
  const normalized = String(path ?? "").replace(/^\/+/, "");
  const encoded = encodePathSegments(normalized);
  if (!encoded) return origin;
  return `${origin}/${encoded}`;
}

export default { encodePathSegments, joinUrlWithEncodedPath };
