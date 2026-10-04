// ============================================================
// 表情包发送：LLM 只判断“配不配发”，发哪张由向量检索决定。
// 相似度不足、超频、私聊（默认）等情况一律不发，并回报原因。
// ============================================================
import { getApprovedStickersWithEmbeddings, updateSticker } from "./sticker-memory.js";
import { embedText } from "./memory.js";
import { sendQqSticker } from "./bot-qq.js";
import { RUNTIME_CONFIG } from "./config.js";
import { checkGroupStickerLimit } from "./sticker-limit.js";

function cosineSimilarity(vec1, vec2) {
  if (!vec1 || !vec2 || vec1.length !== vec2.length) return 0;
  let dot = 0;
  let norm1 = 0;
  let norm2 = 0;
  for (let i = 0; i < vec1.length; i++) {
    dot += vec1[i] * vec2[i];
    norm1 += vec1[i] * vec1[i];
    norm2 += vec2[i] * vec2[i];
  }
  if (!norm1 || !norm2) return 0;
  return dot / Math.sqrt(norm1 * norm2);
}

function isSendable(sticker, now = Date.now()) {
  const cooldown = Math.max(0, Number(RUNTIME_CONFIG.stickerSendCooldownMs) || 0);
  if (cooldown && sticker.last_used_at && now - sticker.last_used_at < cooldown) return false;
  const failBlock = Math.max(0, Number(RUNTIME_CONFIG.stickerFailedRetryAfterMs) || 0);
  if (sticker.fail_count > 0 && failBlock && now - sticker.fail_reported_at < failBlock) return false;
  return true;
}

function pickSticker(queryEmbedding) {
  const approved = getApprovedStickersWithEmbeddings();
  const now = Date.now();
  const minSimilarity = Math.max(0, Math.min(1, Number(RUNTIME_CONFIG.stickerMinSimilarity) || 0.7));
  let best = null;
  let bestSimilarity = minSimilarity;
  for (const sticker of approved) {
    if (!isSendable(sticker, now)) continue;
    let vector;
    try { vector = JSON.parse(sticker.embedding); } catch { continue; }
    if (!Array.isArray(vector) || vector.length !== queryEmbedding.length) continue;
    const similarity = cosineSimilarity(queryEmbedding, vector);
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      best = sticker;
    }
  }
  return best ? { sticker: best, similarity: bestSimilarity } : null;
}

function parseSegments(mfaceData) {
  let segments;
  try { segments = JSON.parse(mfaceData); } catch { return null; }
  const list = Array.isArray(segments) ? segments : [segments];
  const valid = list.filter((seg) => seg && typeof seg === "object" && seg.type);
  return valid.length ? valid : null;
}

async function sendStickerSegments(ws, targetId, isGroup, sticker) {
  const segments = parseSegments(sticker.mface_data);
  if (!segments) throw new Error("入库的 mface 数据不可用");
  await sendQqSticker(ws, targetId, isGroup, segments);
}

function markSent(sticker) {
  updateSticker(sticker.hash, {
    last_used_at: Date.now(),
    fail_count: 0,
    fail_reported_at: 0,
    send_count: (sticker.send_count || 0) + 1,
  });
}

function markFailed(sticker) {
  updateSticker(sticker.hash, {
    fail_count: (sticker.fail_count || 0) + 1,
    fail_reported_at: Date.now(),
  });
}

export async function sendStickerTool(toolCall, ws, targetId, isGroup) {
  if (!RUNTIME_CONFIG.stickerEnabled || !RUNTIME_CONFIG.stickerSendEnabled) {
    return { type: "tool_code", result: "表情包功能当前已关闭" };
  }

  let args = {};
  const rawArgs = toolCall?.function?.arguments;
  try { args = typeof rawArgs === "string" ? JSON.parse(rawArgs || "{}") : (rawArgs || {}); } catch { args = {}; }
  const query = String(args.query || "").trim();
  if (!query) return { type: "tool_code", result: "缺少表情包意图描述，未发送" };

  if (!isGroup && !RUNTIME_CONFIG.stickerPrivateChatEnabled) {
    return { type: "tool_code", result: "私聊默认不发送表情包" };
  }

  if (isGroup && !checkGroupStickerLimit(targetId)) {
    return { type: "tool_code", result: "本群表情包发送太频繁了，等会再发" };
  }

  try {
    if (!getApprovedStickersWithEmbeddings().length) {
      return { type: "tool_code", result: "目前还没有可用的表情包" };
    }
    const queryEmbedding = await embedText(query);
    if (!Array.isArray(queryEmbedding) || !queryEmbedding.length) {
      return { type: "tool_code", result: "无法理解表情包意图，未发送" };
    }
    const picked = pickSticker(queryEmbedding);
    if (!picked) return { type: "tool_code", result: "没有找到足够贴合的表情包" };

    try {
      await sendStickerSegments(ws, targetId, isGroup, picked.sticker);
      markSent(picked.sticker);
      return { type: "tool_code", result: "已发送表情包" };
    } catch (sendError) {
      markFailed(picked.sticker);
      console.warn(`[表情包] 发送失败 hash=${picked.sticker.hash.slice(0, 8)}: ${sendError.message}`);
      return { type: "tool_code", result: `表情包发送失败：${sendError.message}` };
    }
  } catch (error) {
    console.error(`[表情包] 发送流程异常: ${error.message}`);
    return { type: "tool_code", result: `表情包发送失败：${error.message}` };
  }
}

// 主人指令“表情包测试”：一键验证发送链路。
export async function runStickerSelfTest(ws, targetId, isGroup) {
  if (!RUNTIME_CONFIG.stickerEnabled) return "FAIL：表情包功能已关闭";
  if (!isGroup && !RUNTIME_CONFIG.stickerPrivateChatEnabled) return "FAIL：私聊发送已关闭";
  const approved = getApprovedStickersWithEmbeddings();
  if (!approved.length) return "FAIL：还没有已转正的表情包（先发几张 mface 再审核通过）";
  const sticker = approved[approved.length - 1];
  try {
    await sendStickerSegments(ws, targetId, isGroup, sticker);
    markSent(sticker);
    return `PASS：已发送表情包 ${sticker.hash.slice(0, 8)}`;
  } catch (error) {
    markFailed(sticker);
    return `FAIL：发送链路错误 ${error.message}`;
  }
}