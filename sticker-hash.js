// ============================================================
// mface 指纹：按元数据同步计算，无需下载图片，供收集与跟队形共用。
// 依赖为零，便于离线自测。
// ============================================================
import crypto from "node:crypto";

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function hashFromMfaceData(data) {
  const key = [
    data?.emoji_package_id,
    data?.emoji_id,
    data?.key,
    data?.summary,
  ].filter((value) => value !== undefined && value !== null && value !== "").join("|");
  const basis = key || JSON.stringify(data || {});
  return sha256(Buffer.from(String(basis), "utf8"));
}

export { sha256 };