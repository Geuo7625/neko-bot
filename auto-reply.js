// ============================================================
// 自动接话编排：decide() === "auto" 之后的全流程。
// 组 prompt（按需带图）→ 调 core 引擎 → [[SKIP]] 检查 → 发送 → 更新冷却/意愿。
// 模块级只依赖 config.js；core/bot-qq/ws 动态导入，避免循环依赖并保持可离线单测。
// ============================================================
import { RUNTIME_CONFIG, AUTO_TOOLS } from "./config.js";

let depsPromise = null;
function loadDeps() {
  if (!depsPromise) {
    depsPromise = Promise.all([
      import("./core.js"),
      import("./bot-qq.js"),
      import("ws"),
    ]).then(([core, qq, wsModule]) => ({ core, qq, WS: wsModule.default }));
  }
  return depsPromise;
}

function resolveScanCount() {
  const configured = Number(RUNTIME_CONFIG.autoImageScanMessageCount);
  return Math.max(1, Number.isFinite(configured) ? configured : 5);
}

function resolveMaxImages() {
  const configured = Number(RUNTIME_CONFIG.autoMaxPromptImages);
  return Math.max(0, Number.isFinite(configured) ? configured : 3);
}

// 从最近群消息里挑选要随 prompt 附带的图片：有图才带，最多 maxImages 张。
// messages 需按“最新在前”排序，每项含 hasImage。
export function pickRecentPromptImages(messages, options = {}) {
  const scanCount = Math.max(1, Number(options.scanCount ?? resolveScanCount()) || 5);
  const maxImages = Math.max(0, Number(options.maxImages ?? resolveMaxImages()) || 0);
  if (!maxImages) return [];
  return (Array.isArray(messages) ? messages : [])
    .slice(0, scanCount)
    .filter((item) => item?.hasImage)
    .slice(0, maxImages);
}

// 自动接话的群聊参考材料：群历史 + 话题记忆 + 接话人设与静默规则。
export function buildAutoContextPrompt({ groupContext = "", memoryPrompt = "", skipMarker = "" } = {}) {
  return `${groupContext}\n${memoryPrompt}\n你是群里的普通聊天成员。专业或技术问题、需要严谨知识的问题、与当前话题无关的内容，或回复可能答错、添乱、打断交流时，只输出${skipMarker}。轻松玩笑和日常闲聊可以自然接梗；其他情况下结合当前消息口语化回复，最多40字，不要@任何人。`;
}

// 识图不是工具：取最近群消息里的图片作为视觉上下文，失败只告警不阻塞。
async function collectRecentPromptImages(qq, groupId) {
  const scanCount = resolveScanCount();
  const maxImages = resolveMaxImages();
  if (!maxImages) return [];
  try {
    const messages = await qq.fetchRecentGroupMessages(groupId, { scanCount });
    const picked = pickRecentPromptImages(messages, { scanCount, maxImages });
    const images = [];
    for (const item of picked) {
      const image = await qq.extractImageFromMessage(item.message);
      if (image) {
        images.push({ label: `【群聊近期图片】来自群友「${item.senderName}」`, image, source: null });
      }
    }
    return images;
  } catch (error) {
    console.warn(`[群聊自动] 近期图片获取失败 group=${String(groupId)}: ${error.message}`);
    return [];
  }
}

async function runAutoReplyWithDeps({ core, qq, WS }, ws, payload, state) {
  const { groupId, selfId, botName, senderId, messageId, text, score, valueResult, messageVector, clearGeneration } = payload;
  const { coreProcessChat, AUTO_SKIP_MARKER } = core;
  const speechVersion = state.speechVersion;
  const scoreText = Number(score || 0).toFixed(3);
  const triggerText = () => JSON.stringify(Array.from(String(text ?? "")).slice(0, 60).join(""));

  if (!ws || ws.readyState !== WS.OPEN) return;

  const groupContext = await qq.fetchGroupHistory(groupId, messageId, selfId);
  if (qq.getGroupHistoryGeneration(groupId) !== clearGeneration) return;
  if (state.speechVersion !== speechVersion) return;
  const memoryPrompt = qq.getGroupTopicMemoryPrompt(groupId, messageVector);
  // 识图不是工具：这里决定是否随 prompt 附带近期群聊图片（有图才带，最多 3 张）。
  const extraVisionImages = await collectRecentPromptImages(qq, groupId);
  const contextPrompt = buildAutoContextPrompt({
    groupContext,
    memoryPrompt,
    skipMarker: AUTO_SKIP_MARKER,
  });

  const result = await coreProcessChat(
    `qq_group_${String(groupId)}_auto`,
    text,
    undefined,
    {
      isOwner: false,
      isGroup: true,
      userId: String(senderId),
      botId: String(selfId),
      botName,
      searchText: null,
      thinkingText: null,
      contextPrompt,
      contextKey: `group:${String(groupId)}`,
      allowTools: Boolean(RUNTIME_CONFIG.stickerEnabled && RUNTIME_CONFIG.stickerAutoSendEnabled),
      // 自动接话永远不暴露画图/视频等重工具，只允许发表情包。
      toolAllowlist: AUTO_TOOLS,
      extraVisionImages,
      requestPriority: "auto",
      isContextCurrent: () => qq.getGroupHistoryGeneration(groupId) === clearGeneration,
      historyTextEntry: text,

      qqWs: ws,
      qqTargetId: groupId,
      qqIsGroup: true,
    },
  );
  if (qq.getGroupHistoryGeneration(groupId) !== clearGeneration) return;
  if (state.speechVersion !== speechVersion) return;

  // [[SKIP]] 否决由本模块负责：模型选择静默时直接结束，不发送、不记冷却。
  if (result?.type === "skipped" || String(result?.content ?? "").includes(AUTO_SKIP_MARKER)) {
    console.log(`[群聊自动] skip group=${groupId} score=${scoreText} text=${triggerText()}`);
    return;
  }
  if (result?.type !== "text" || !String(result.content ?? "").trim()) return;
  const reply = Array.from(String(result.content).trim())
    .slice(0, Math.max(1, Number(RUNTIME_CONFIG.autoReplyMaxChars) || 40))
    .join("");
  if (!reply || reply.includes(AUTO_SKIP_MARKER)) return;

  await qq.sendAiTextMessages(ws, groupId, true, reply, [], { trackGroupSpeech: true });
  qq.recordAutoTalk(state, Date.now());
  console.log(`[群聊自动] sent group=${groupId} vector=${Number.isFinite(valueResult?.score) ? valueResult.score.toFixed(3) : "—"} willingness=${state.willingness.toFixed(3)} score=${scoreText} text=${triggerText()}`);
}

// bot-qq.js 在 decide() === "auto" 之后调用。
export async function runAutoReply(ws, payload = {}) {
  let state = null;
  try {
    const deps = await loadDeps();
    state = deps.qq.getGroupTalkState(payload.groupId);
    await runAutoReplyWithDeps(deps, ws, payload, state);
  } catch (error) {
    console.error(`[群聊自动] 失败 group=${payload?.groupId}: ${error.message}`);
  } finally {
    if (state) state.autoReplyInFlight = false;
  }
}