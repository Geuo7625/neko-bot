// ============================================================
// 每群表情包小时发送计数：send_sticker 与跟队形共用同一份计数。
// 依赖为零，便于离线自测。
// ============================================================
import { RUNTIME_CONFIG } from "./config.js";

const HOUR_MS = 3600000;

// 每群表情包发送计数（独立于文本回复频控）。
const groupStickerSendCounts = new Map();

export function checkGroupStickerLimit(groupId) {
  const limit = Math.max(1, Number(RUNTIME_CONFIG.stickerHourlyLimitPerGroup) || 5);
  const now = Date.now();
  const hourBucket = Math.floor(now / HOUR_MS);
  let buckets = groupStickerSendCounts.get(groupId);
  if (!buckets) {
    buckets = new Map();
    groupStickerSendCounts.set(groupId, buckets);
  }
  const count = buckets.get(hourBucket) || 0;
  if (count >= limit) return false;
  buckets.set(hourBucket, count + 1);
  for (const bucket of buckets.keys()) {
    if (bucket < hourBucket - 1) buckets.delete(bucket);
  }
  return true;
}