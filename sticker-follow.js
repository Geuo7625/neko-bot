// ============================================================
// 表情包“跟队形”：同群同一张 mface 短时间内被多人发出时，bot 原样跟一张。
// 判定只用图片指纹 + 计数，零 token、零 LLM；不涉及入库/审核。
// 只处理 mface，face（系统黄豆表情）不参与；失败只打日志，不阻塞主流程。
// ============================================================
import { RUNTIME_CONFIG } from "./config.js";
import { hashFromMfaceData } from "./sticker-hash.js";
import { checkGroupStickerLimit } from "./sticker-limit.js";

// 延迟加载发送器，避免本模块顶层的重依赖（离线自测可注入 send）。
async function defaultSend(ws, groupId, segment) {
  const { sendQqSticker } = await import("./bot-qq.js");
  return sendQqSticker(ws, groupId, true, [segment]);
}

// 每群状态：窗口内观测队列 + 已跟过的指纹（带过期）+ 上次跟队形时间。
const groupFollowStates = new Map();

function getGroupState(groupId) {
  let state = groupFollowStates.get(groupId);
  if (!state) {
    state = { sightings: [], followed: new Map(), lastFollowAt: 0 };
    groupFollowStates.set(groupId, state);
  }
  return state;
}

function pruneState(state, now, windowMs) {
  const cutoff = now - windowMs;
  if (state.sightings.length) {
    state.sightings = state.sightings.filter((item) => item.ts > cutoff);
  }
  for (const [hash, expireAt] of state.followed) {
    if (expireAt <= now) state.followed.delete(hash);
  }
}

// bot-qq.js 收到群 mface 时调用（fire-and-forget）。返回是否真的跟了队形。
export async function maybeFollowMemePattern({ seg, senderId, groupId, selfId, ws, send = defaultSend }) {
  if (!RUNTIME_CONFIG.stickerEnabled || !RUNTIME_CONFIG.stickerFollowEnabled) return false;
  if (!groupId || !seg) return false;
  // bot 自己发的 mface 不计入，也不会触发跟队形。
  if (senderId === undefined || senderId === null || String(senderId) === String(selfId)) return false;

  let hash;
  try { hash = hashFromMfaceData(seg.data); } catch { return false; }

  const now = Date.now();
  const windowMs = Math.max(1, Number(RUNTIME_CONFIG.stickerFollowWindowSeconds) || 30) * 1000;
  const threshold = Math.max(2, Number(RUNTIME_CONFIG.stickerFollowThreshold) || 3);
  const requireDistinct = RUNTIME_CONFIG.stickerFollowDistinctUsers !== false;
  const cooldownMs = Math.max(0, Number(RUNTIME_CONFIG.stickerFollowCooldownMs) || 0);

  const state = getGroupState(groupId);
  pruneState(state, now, windowMs);
  state.sightings.push({ hash, senderId: String(senderId), ts: now });

  const sameHash = state.sightings.filter((item) => item.hash === hash);
  if (sameHash.length < threshold) return false;

  const senders = new Set(sameHash.map((item) => item.senderId));
  if (requireDistinct && senders.size < 2) return false;
  if (state.followed.has(hash)) return false;
  if (cooldownMs && now - state.lastFollowAt < cooldownMs) return false;
  if (!checkGroupStickerLimit(groupId)) return false;

  try {
    // 原样回发当前这张 mface，不查库、不调向量。
    await send(ws, String(groupId), JSON.parse(JSON.stringify(seg)));
  } catch (error) {
    console.warn(`[表情包] 跟队形发送失败 group=${String(groupId)}: ${error.message}`);
    return false;
  }

  state.followed.set(hash, now + windowMs);
  state.lastFollowAt = now;
  console.log(`[表情包] 跟队形 hash=${hash.slice(0, 8)} senders=${senders.size}`);
  return true;
}