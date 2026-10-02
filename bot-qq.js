// bot-qq.js
import axios from "axios";
import WebSocket from "ws";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { NAPCAT_WS_URL, NAPCAT_HTTP_URL, NAPCAT_TOKEN, RUNTIME_CONFIG } from "./config.js";
import { coreProcessChat, clearHistory, clearAllHistories, clearContextRequests } from "./core.js";
import { sendSpecialContent } from "./special-content.js";
import { handleControlCommand } from "./control.js";
import {
  getServerStatus,
  checkServerStatusRateLimit,
} from "./server-status.js";
import { IMAGE_SOURCE } from "./image-provenance.js";
import { scoreMessage } from "./value-score.js";
import { cleanValueText, shouldEvaluateMessage, shouldAskAiAboutMessage, evaluateMessageValue, combineMessageValue } from "./message-value.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BOT_CONFIG_PATH = path.join(__dirname, "bot-config.json");
const GROUP_HISTORY_CLEAR_PATH = path.join(__dirname, "group-history-clear.json");

let botConfig = loadBotConfig();
let botConfigMtime = getConfigMtime();

const groupTalkStates = new Map();
const userLastPokeTime = new Map();
const pokeStreakStates = new Map();
const POKE_STREAK_WINDOW_MS = 60_000;
const POKE_STREAK_THRESHOLD = 3;

// 以下自动接话、上下文、评分阈值和 API 限速参数统一从 config.js 的 RUNTIME_CONFIG 读取，支持热重载。
const AUTO_CHIME_SILENCE_TOKEN = "§NO_CHIME_7F31§";
const recentUsers = new Map();
const recentBotGroupReplies = new Map();
const privateTypingStates = new Map();
const botSessionClearGenerations = new Map();
let botGlobalClearGeneration = 0;
const groupHistoryClearPoints = new Map();
const groupHistoryClearVersions = new Map();
let globalGroupHistoryClearVersion = 0;
let globalGroupHistoryClearTime = 0;

function loadGroupHistoryClearState() {
  try {
    const saved = JSON.parse(fs.readFileSync(GROUP_HISTORY_CLEAR_PATH, "utf8"));
    globalGroupHistoryClearTime = Number(saved?.globalTime) || 0;
    if (saved?.groups && typeof saved.groups === "object") {
      for (const [groupId, time] of Object.entries(saved.groups)) {
        groupHistoryClearPoints.set(String(groupId), Number(time) || 0);
      }
    }
  } catch {}
}

function saveGroupHistoryClearState() {
  try {
    const payload = {
      globalTime: globalGroupHistoryClearTime,
      groups: Object.fromEntries(groupHistoryClearPoints),
    };
    fs.writeFileSync(GROUP_HISTORY_CLEAR_PATH, JSON.stringify(payload), "utf8");
  } catch (error) {
    console.error(`[群历史] 保存清除边界失败：${error.message}`);
  }
}

loadGroupHistoryClearState();

// ===== QQ 用户限速 =====
const RATE_LIMIT_MIN_INTERVAL_MS = 2000;
const RATE_LIMIT_MAX_IN_FLIGHT = 3;
const RATE_LIMIT_TRIGGER_WINDOW_MS = 10_000;
const RATE_LIMIT_TRIGGER_THRESHOLD = 10;
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const RATE_LIMIT_NOTICE_SUPPRESS_MS = 10_000;
const userRateStates = new Map();

function getUserRateState(userId) {
  const key = String(userId);
  let state = userRateStates.get(key);
  if (!state) {
    state = {
      lastMessageAt: 0,
      inFlight: 0,
      triggerTimes: [],
      cooldownUntil: 0,
      lastNoticeType: null,
      lastNoticeAt: 0,
    };
    userRateStates.set(key, state);
  }
  return state;
}

function checkUserRateLimit(userId) {
  const now = Date.now();
  const state = getUserRateState(userId);
  state.triggerTimes = state.triggerTimes.filter(
    (time) => now - time <= RATE_LIMIT_TRIGGER_WINDOW_MS,
  );

  if (state.cooldownUntil > now) {
    return { allowed: false, type: "cooldown" };
  }

  const tooFast =
    state.lastMessageAt > 0 &&
    now - state.lastMessageAt < RATE_LIMIT_MIN_INTERVAL_MS;
  const tooManyInFlight = state.inFlight >= RATE_LIMIT_MAX_IN_FLIGHT;
  state.lastMessageAt = now;

  if (!tooFast && !tooManyInFlight) return { allowed: true };

  state.triggerTimes.push(now);
  if (state.triggerTimes.length >= RATE_LIMIT_TRIGGER_THRESHOLD) {
    state.cooldownUntil = now + RATE_LIMIT_COOLDOWN_MS;
    state.triggerTimes = [];
    return { allowed: false, type: "cooldown" };
  }

  return { allowed: false, type: "slow" };
}

function beginUserApiRequest(userId) {
  getUserRateState(userId).inFlight++;
}

function endUserApiRequest(userId) {
  const state = getUserRateState(userId);
  state.inFlight = Math.max(0, state.inFlight - 1);
}

function shouldSendRateLimitNotice(userId, type) {
  const now = Date.now();
  const state = getUserRateState(userId);
  if (
    state.lastNoticeType === type &&
    now - state.lastNoticeAt < RATE_LIMIT_NOTICE_SUPPRESS_MS
  ) {
    return false;
  }
  state.lastNoticeType = type;
  state.lastNoticeAt = now;
  return true;
}

function cleanupUserRateStates() {
  const now = Date.now();
  for (const [key, state] of userRateStates) {
    state.triggerTimes = state.triggerTimes.filter(
      (time) => now - time <= RATE_LIMIT_TRIGGER_WINDOW_MS,
    );
    if (
      state.inFlight === 0 &&
      state.cooldownUntil <= now &&
      state.triggerTimes.length === 0 &&
      (state.lastMessageAt === 0 ||
        now - state.lastMessageAt > RATE_LIMIT_TRIGGER_WINDOW_MS)
    ) {
      userRateStates.delete(key);
    }
  }
}

setInterval(cleanupUserRateStates, 30_000);
setInterval(() => {
  const now = Date.now();
  for (const [key, state] of pokeStreakStates) {
    if (now - state.lastAt > POKE_STREAK_WINDOW_MS) pokeStreakStates.delete(key);
  }
  for (const [key, entry] of forwardContextCache) {
    if (!entry || now - entry.savedAt > FORWARD_CONTEXT_TTL_MS) forwardContextCache.delete(key);
  }
  for (const [key, entry] of recentBotGroupReplies) {
    if (!entry || now - entry.at > RUNTIME_CONFIG.botFollowupWindowMs) recentBotGroupReplies.delete(key);
  }
}, 60_000);

function getPokeStreakKey(userId, groupId = null) {
  return `${groupId === null || groupId === undefined ? "private" : `group:${String(groupId)}`}::${String(userId)}`;
}

function resetPokeStreak(userId, groupId = null) {
  pokeStreakStates.delete(getPokeStreakKey(userId, groupId));
}

// 前 3 次正常回复；之后第 4、6、8……次只直接回戳，不请求模型。
function shouldSkipPokeApi(userId, groupId = null) {
  const key = getPokeStreakKey(userId, groupId);
  const now = Date.now();
  let state = pokeStreakStates.get(key);

  if (!state || now - state.lastAt > POKE_STREAK_WINDOW_MS) {
    state = { count: 0, lastAt: now };
  }

  state.count++;
  state.lastAt = now;
  pokeStreakStates.set(key, state);

  return state.count > POKE_STREAK_THRESHOLD &&
    (state.count - POKE_STREAK_THRESHOLD) % 2 === 1;
}

async function sendUserRateLimitReply(ws, targetId, isGroup, userId, type) {
  if (!shouldSendRateLimitNotice(userId, type)) return;
  const text =
    type === "cooldown" ? "有点累了…让我歇会" : "慢点…我跟不上了";
  await sendQqMsg(ws, targetId, isGroup, text);
}

let lastRandomPokeTime = 0;

// ===== 最近图片上下文 =====
const RECENT_IMAGE_CONTEXT_TTL_MS = 120_000;
const recentImageContexts = new Map();

function getRecentImageContextKey(isGroup, groupId, userId) {
  return isGroup
    ? `group:${String(groupId)}:${String(userId)}`
    : `private:${String(userId)}`;
}

function saveRecentImageContext({
  isGroup,
  groupId,
  userId,
  imageContent,
  sourceImageUrl = null,
  messageId,
  messageTime,
}) {
  if (!imageContent) return;
  const key = getRecentImageContextKey(isGroup, groupId, userId);
  recentImageContexts.set(key, {
    imageContent,
    sourceImageUrl: sourceImageUrl || null,
    messageId: messageId ?? null,
    messageTime: Number(messageTime || 0),
    senderId: String(userId),
    savedAt: Date.now(),
  });
}

function getRecentImageContext({
  isGroup,
  groupId,
  userId,
  currentMessageId = null,
}) {
  const key = getRecentImageContextKey(isGroup, groupId, userId);
  const context = recentImageContexts.get(key);
  if (!context) return null;

  const age = Date.now() - context.savedAt;
  if (age > RECENT_IMAGE_CONTEXT_TTL_MS) {
    recentImageContexts.delete(key);
    return null;
  }

  if (
    currentMessageId !== null &&
    currentMessageId !== undefined &&
    context.messageId !== null &&
    String(context.messageId) === String(currentMessageId)
  ) {
    return null;
  }

  return context;
}

function cleanupRecentImageContexts() {
  const now = Date.now();
  for (const [key, context] of recentImageContexts) {
    if (!context || now - context.savedAt > RECENT_IMAGE_CONTEXT_TTL_MS) {
      recentImageContexts.delete(key);
    }
  }
}
setInterval(cleanupRecentImageContexts, 30_000);

function getGroupTalkState(groupId) {
  const key = String(groupId);
  let state = groupTalkStates.get(key);
  if (!state) {
    state = {
      messages: [],
      lastMessageAt: 0,
      lastMessageId: null,
      lastAutoTalkAt: 0,
      idleTimer: null,
      activeChimeTimer: null,
      activeChimeForce: false,
      pendingHighValue: null,
      pendingHighValueTimer: null,
      pendingImplicitReply: null,
      lastForcedChimeAt: 0,
      lastChimeCheckAt: 0,
      autoTalkInFlight: false,
    };
    groupTalkStates.set(key, state);
  }
  return state;
}

function getRecentBotGroupReply(groupId) {
  const key = String(groupId);
  const entry = recentBotGroupReplies.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > RUNTIME_CONFIG.botFollowupWindowMs) {
    recentBotGroupReplies.delete(key);
    return null;
  }
  return entry;
}

function noteBotGroupReply(groupId, text) {
  if (groupId === null || groupId === undefined) return;
  const clean = String(text ?? "").trim();
  if (!clean) return;
  recentBotGroupReplies.set(String(groupId), { at: Date.now(), text: clean.slice(0, 1200) });
}

function drainPendingGroupTasks(ws, state) {
  const now = Date.now();
  const implicit = state.pendingImplicitReply;
  if (implicit) {
    state.pendingImplicitReply = null;
    if (now - Number(implicit.createdAt || now) <= RUNTIME_CONFIG.botFollowupMaxPendingAgeMs) {
      setTimeout(() => { void performImplicitBotFollowup(ws, implicit); }, 180);
    } else {
      console.log(`[群聊隐式回复] 排队超时，忽略 group=${implicit.groupId} msg=${implicit.messageId ?? "?"}`);
    }
    return;
  }
  const pending = state.pendingHighValue;
  if (pending && !state.pendingHighValueTimer) {
    state.pendingHighValue = null;
    if (now - Number(pending.createdAt || now) <= RUNTIME_CONFIG.autoChimeMaxPendingAgeMs) {
      setTimeout(() => { void performGroupConversationChime(ws, pending); }, 180);
    } else {
      console.log(`[群聊接话] 高价值候选过期，忽略 group=${pending.groupId}`);
    }
  }
}

function clearGroupIdleTimer(state) {
  if (state?.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }
}

function clearGroupChimeTimer(state) {
  if (state?.activeChimeTimer) {
    clearTimeout(state.activeChimeTimer);
    state.activeChimeTimer = null;
  }
  if (state) state.activeChimeForce = false;
}

async function performGroupAutoTalk(
  ws,
  { groupId, selfId, botName, mode = "idle", excludeMessageId = null },
) {
  if (groupId === null || groupId === undefined) return;
  if (isNoRandomTalkGroup(groupId)) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const state = getGroupTalkState(groupId);
  if (state.autoTalkInFlight) return;
  const clearGeneration = getGroupHistoryGeneration(groupId);

  const now = Date.now();
  if (now - state.lastAutoTalkAt < RUNTIME_CONFIG.autoTalkCooldownMs) return;

  if (mode === "idle" && state.lastMessageAt && now - state.lastMessageAt < RUNTIME_CONFIG.autoTalkIdleMs) {
    return;
  }

  state.autoTalkInFlight = true;
  clearGroupIdleTimer(state);
  const sessionId = `qq_group_${String(groupId)}_auto`;

  try {
    const groupContextPrompt = await fetchGroupHistory(
      groupId,
      excludeMessageId,
      selfId,
      true,
      { maxAgeMs: mode === "idle" ? RUNTIME_CONFIG.groupIdleHistoryMaxAgeMs : RUNTIME_CONFIG.groupAutoHistoryMaxAgeMs, limit: RUNTIME_CONFIG.maxGroupContextMessages },
    );
    if (getGroupHistoryGeneration(groupId) !== clearGeneration) return;
    if (!String(groupContextPrompt || "").trim()) return;

    const modePrompt = buildGroupReplyDecisionPrompt({ mode });
    const contextPrompt = groupContextPrompt;

    const res = await coreProcessChat(sessionId, modePrompt, undefined, {
      isOwner: false,
      isGroup: true,
      userId: null,
      botId: String(selfId),
      botName,
      searchText: null,
      thinkingText: null,
      contextPrompt,
      contextKey: `group:${String(groupId)}`,
      allowTools: true,
      toolAllowlist: ["get_recent_group_image", "quote_group_message"],
      getGroupImage: ({ messageId } = {}) => fetchRecentGroupImage(groupId, messageId),
      isContextCurrent: () => getGroupHistoryGeneration(groupId) === clearGeneration,
      requestPriority: "auto",
      historyTextEntry: "[自动接话]",
    });

    if (getGroupHistoryGeneration(groupId) !== clearGeneration) return;
    if (res?.type === "text" && res.content) {
      if (isNoChimeResponse(res.content)) {
        console.log(`[群聊自动接话] AI 判断无需回应 group=${groupId} mode=${mode}`);
        return;
      }
      await sendAiTextMessages(ws, groupId, true, res.content, res.mentionQqs, res.quoteMessageId);
      state.lastAutoTalkAt = Date.now();
    }
  } catch (error) {
    console.error(`[群聊自动接话] 失败 group=${groupId}: ${error.message}`);
  } finally {
    state.autoTalkInFlight = false;
    clearHistory(sessionId); // 自动接话的临时判断不进入下一轮历史，群聊上下文每次从 QQ 重新读取。
    drainPendingGroupTasks(ws, state);
  }
}

function isNoChimeResponse(text) {
  // 模型即使多带了换行或解释，只要出现控制符就绝不发到 QQ。
  return String(text ?? "").trim().includes(AUTO_CHIME_SILENCE_TOKEN);
}

function buildGroupReplyDecisionPrompt({ mode = "conversation", highValue = false, triggerText = "", triggerReasons = [] } = {}) {
  const situation = mode === "idle"
    ? "群聊已经安静了一段时间。不要把较早的话题重新捡起来继续；只有在确实能自然开启一个全新、轻松话题时才开口，否则静默。"
    : mode === "active"
      ? "群聊正在进行。可以补充一个有意义的观点、回应未解决的问题，或自然接续当前话题。"
      : "判断最近的群聊是否存在值得你加入的自然切入点。";
  triggerText = String(triggerText || "");
  triggerReasons = Array.isArray(triggerReasons) ? triggerReasons : [];
  const ambiguousCallHint = triggerReasons.some((reason) => ["bot-name", "bot-topic", "short-bot-topic"].includes(reason))
    && Array.from(triggerText).length <= 40
    ? "如果触发消息很短，只提到 AI、机器人或你的名字，且你无法确定是不是在叫你，不要直接静默；可以自然地问一句‘你是在叫我吗？可以说清楚一点喵。’如果明显是在讨论第三方或泛泛讨论 AI，则不要误认为是在叫你。"
    : "";
  return `【任务：判断是否有必要参与群聊】
你是群里自然聊天的一员，不是消息播报器。最后一条 user 消息是本次当前消息，必须以它为主要判断对象；群聊历史只是帮助理解语境、指代、参与者关系和话题走向的参考，不要只抓住某一条较早的发言或引用反复回应。参考最近最多 20 条群聊记录（优先最近 3 分钟），结合前后多条消息判断当前消息是否值得回应，以及问题是否已经得到回答。${situation}
${highValue ? "本地价值评分只表示这段消息值得交给你判断，不代表必须回复；不要为了迎合评分而硬接话。" : "不要为了保持活跃而硬找话题。"}
${ambiguousCallHint}
特别注意时效：只回应最近几条消息仍在讨论的内容。若话题在较早消息中已经结束、被回答、被转移到其他话题，绝不能把旧问题重新捡起来；不要因为上下文里还出现过一个问题就突然回答它。若最近消息不足以确认话题仍在继续，优先静默。
以下情况通常不回复：只是简短附和/刷表情/重复内容；话题已结束；问题已被群友充分回答；上下文不足；插话会打断别人；消息明显是在对其他人说而你没有可补充的内容；近期有人直接 @ 机器人且正在等待它的正常回复。
若没有自然、有内容的回应必要，只输出这个特殊符号，不能加引号、标点、解释或 Markdown：${AUTO_CHIME_SILENCE_TOKEN}
若值得回应，直接输出一条简短、自然、贴合上下文的中文消息。不要提到评分、筛选、自动接话或你正在做判断，不要 @ 任何人。不要复述整段聊天，也不要凭空编造事实。若上下文含有图片标记，只有图片确实有助于理解时才调用 get_recent_group_image。`;
}

async function performGroupConversationChime(
  ws,
  { groupId, selfId, botName, force = false, triggerText = "", triggerReasons = [], triggerMessageId = null, triggerHasImage = false, createdAt = Date.now() },
) {
  if (groupId === null || groupId === undefined) return;
  if (isNoRandomTalkGroup(groupId)) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const state = getGroupTalkState(groupId);
  const clearGeneration = getGroupHistoryGeneration(groupId);
  const now = Date.now();
  if (state.autoTalkInFlight) {
    // 高价值触发不能因为另一轮普通接话正在运行而丢失，结束后补跑一次。
    if (force) {
      const previousAt = Number(state.pendingHighValue?.createdAt || 0);
      if (!previousAt || createdAt >= previousAt) {
        state.pendingHighValue = { groupId, selfId, botName, force: true, triggerText, triggerReasons, triggerMessageId, triggerHasImage, createdAt };
      }
    }
    return;
  }
  // 普通语义判断每群限频。冷却期间不排队旧候选，避免话题结束后又翻出来回复；下一条新消息会重新评估。
  if (!force && now - state.lastChimeCheckAt < RUNTIME_CONFIG.autoChimeCheckCooldownMs) return;
  // 自动插话不是直接向机器人提问：冷却期间直接忽略，不把旧候选延迟到话题过期后再回复。
  if (force && now - state.lastForcedChimeAt < RUNTIME_CONFIG.autoChimeForceCooldownMs) {
    console.log(`[群聊接话] 高价值候选处于冷却，忽略 group=${groupId}`);
    return;
  }
  if (force) state.lastForcedChimeAt = now;

  state.messages = state.messages.filter(
    (item) => now - item.at <= RUNTIME_CONFIG.autoTalkActiveWindowMs,
  );
  const uniqueUsers = new Set(state.messages.map((item) => item.userId));
  const hasMention = state.messages.some((item) => item.hasMention);
  // 一般候选消息已在入口清洗过滤；不再要求群里凑够固定消息数。
  // 最近有人 @ 机器人时仍让正常回复路径优先处理，除非这是显式高价值触发。
  if (!force && hasMention) return;

  state.autoTalkInFlight = true;
  state.lastChimeCheckAt = now;
  const sessionId = `qq_group_${String(groupId)}_chime_${Date.now()}`;

  try {
    // 把触发消息作为真正的当前 user 消息；历史只承担上下文参考，避免 AI 只围绕某条旧发言作答。
    const cleanTriggerText = String(triggerText || "").trim();
    let groupContextPrompt = await fetchGroupHistory(
      groupId,
      triggerHasImage ? null : triggerMessageId,
      selfId,
      true,
      { maxAgeMs: RUNTIME_CONFIG.groupAutoHistoryMaxAgeMs, limit: RUNTIME_CONFIG.maxGroupContextMessages },
    );
    if (getGroupHistoryGeneration(groupId) !== clearGeneration) return;
    if (!String(groupContextPrompt || "").trim()) groupContextPrompt = "[近期群聊历史暂时不可用]";

    const taskPrompt = buildGroupReplyDecisionPrompt({ mode: "conversation", highValue: force, triggerText, triggerReasons });
    const triggerMeta = force
      ? `\n【本次触发线索】${(triggerReasons || []).join(", ") || "消息价值判断建议交给 AI 评估"}。这只是唤醒原因，不代表必须回复。`
      : "";
    const contextPrompt = `${groupContextPrompt}\n\n【自动接话判断要求】${taskPrompt}${triggerMeta}`;
    const primaryMessage = cleanTriggerText || "请根据最近群聊判断是否适合自然接话。";

    const res = await coreProcessChat(
      sessionId,
      primaryMessage,
      undefined,
      {
        isOwner: false,
        isGroup: true,
        userId: null,
        botId: String(selfId),
        botName,
        searchText: null,
        thinkingText: null,
        contextPrompt,
        contextKey: `group:${String(groupId)}`,
        allowTools: true,
        toolAllowlist: ["send_multiple_messages", "get_recent_group_image", "quote_group_message"],
        getGroupImage: ({ messageId } = {}) => fetchRecentGroupImage(groupId, messageId),
        isContextCurrent: () => getGroupHistoryGeneration(groupId) === clearGeneration,
        requestPriority: "auto",
        historyTextEntry: "[群聊观察任务]",
      },
    );

    let outgoing = [];
    if (res?.type === "text" && res.content) {
      const text = String(res.content).trim();
      if (isNoChimeResponse(text)) {
        console.log(`[群聊接话判断] AI 判断无需回应 group=${groupId} mode=${force ? "high-value" : "normal"}`);
        return;
      }
      if (text) outgoing = [text];
    } else if (res?.type === "multi_text_pending" && Array.isArray(res.messages)) {
      outgoing = res.messages.map((item) => String(item ?? "").trim()).filter(Boolean);
      if (!outgoing.length || outgoing.some(isNoChimeResponse)) {
        console.log(`[群聊接话判断] AI 判断无需回应 group=${groupId} mode=${force ? "high-value" : "normal"}`);
        return;
      }
    }

    if (!outgoing.length) {
      if (res?.type === "skipped") {
        console.log(`[群聊接话判断] 全局限速，忽略低优先级插话 group=${groupId}`);
        return;
      }
      console.warn(`[群聊接话判断] 模型未返回可发送文本 group=${groupId} mode=${force ? "high-value" : "normal"} type=${res?.type || "empty"}`);
      return;
    }
    if (getGroupHistoryGeneration(groupId) !== clearGeneration) return;

    for (let i = 0; i < outgoing.length; i++) {
      if (getGroupHistoryGeneration(groupId) !== clearGeneration) return;
      await sendAiTextMessages(ws, groupId, true, outgoing[i], [], i === 0 ? res.quoteMessageId : null);
      if (i < outgoing.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 180));
      }
    }

    state.lastAutoTalkAt = Date.now();
    console.log(`[群聊接话判断] 已接话 group=${groupId} messages=${outgoing.length}`);
  } catch (error) {
    console.error(`[群聊接话判断] 失败 group=${groupId}: ${error.message}`);
  } finally {
    state.autoTalkInFlight = false;
    clearHistory(sessionId); // 每次只使用 QQ 群历史，避免把静默符号或旧判断留在模型会话里。
    drainPendingGroupTasks(ws, state);
  }
}

async function performImplicitBotFollowup(ws, args) {
  const {
    groupId, senderId, messageId, selfId, botName, messageText, senderName,
    lastBotText, clearGeneration, createdAt = Date.now(),
  } = args || {};
  if (groupId === null || groupId === undefined || isNoRandomTalkGroup(groupId) || isBlacklisted(senderId)) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (getGroupHistoryGeneration(groupId) !== clearGeneration) return;
  if (Date.now() - Number(createdAt || Date.now()) > RUNTIME_CONFIG.botFollowupMaxPendingAgeMs) {
    console.log(`[群聊隐式回复] 候选已过期，忽略 group=${groupId} msg=${messageId ?? "?"}`);
    return;
  }

  const state = getGroupTalkState(groupId);
  if (state.autoTalkInFlight) {
    const previousAt = Number(state.pendingImplicitReply?.createdAt || 0);
    if (!previousAt || createdAt >= previousAt) state.pendingImplicitReply = args;
    console.log(`[群聊隐式回复] 正在处理其他任务，暂存最新消息 group=${groupId} msg=${messageId ?? "?"}`);
    return;
  }

  state.autoTalkInFlight = true;
  const sessionId = `qq_group_${String(groupId)}_implicit_${String(messageId ?? Date.now())}`;
  try {
    // 排除当前消息，让它作为真正的最后一条 user 消息；最近机器人发言仅作为线索之一。
    const groupContextPrompt = await fetchGroupHistory(
      groupId,
      messageId,
      selfId,
      true,
      { maxAgeMs: RUNTIME_CONFIG.botFollowupWindowMs, limit: RUNTIME_CONFIG.maxGroupContextMessages },
    );
    if (getGroupHistoryGeneration(groupId) !== clearGeneration) return;

    const cleanText = cleanValueText(messageText) || String(messageText || "").trim();
    const contextPrompt = `【任务：理解当前群友消息】
最后一条 user 消息才是需要优先处理的当前消息。先判断它本身在说什么，再结合前后多条群聊记录理解指代、话题变化和参与者关系。不要因为机器人刚说过话，就默认当前消息一定是在回复机器人；机器人上一条发言只是参考线索，不能盖过当前消息的实际内容。如果当前消息在回应其他群友或开启新话题，应按当前消息本身处理，不要强行续接机器人的旧话题。
【机器人最近一条发言，仅供判断上下文】${String(lastBotText || "").slice(0, 800) || "无"}
【最近群聊记录】
${groupContextPrompt || "[群聊历史暂时不可用]"}
若当前消息很可能是在回应、追问机器人，可以自然接话；若明显是群友之间交流、与机器人无关或没有必要回应，返回静默符号 ${AUTO_CHIME_SILENCE_TOKEN}。如果短句只提到 AI、机器人或昵称且无法确定是否在叫你，可以简短确认是否在叫你。若需要回应较早的具体消息，可使用 quote_group_message，但引用只是辅助，不要只围绕引用消息回答。`;

    const res = await coreProcessChat(sessionId, cleanText || String(messageText || ""), undefined, {
      isOwner: false,
      isGroup: true,
      userId: String(senderId),
      botId: String(selfId),
      botName,
      userNickname: senderName || null,
      searchText: null,
      thinkingText: null,
      contextPrompt,
      contextKey: `group:${String(groupId)}`,
      allowTools: true,
      toolAllowlist: ["quote_group_message", "get_recent_group_image"],
      getGroupImage: ({ messageId: imageMessageId } = {}) => fetchRecentGroupImage(groupId, imageMessageId),
      isContextCurrent: () => getGroupHistoryGeneration(groupId) === clearGeneration,
      requestPriority: "followup",
      historyTextEntry: "[群聊隐式回复判断]",
    });
    if (getGroupHistoryGeneration(groupId) !== clearGeneration) return;
    if (res?.type === "skipped") {
      console.log(`[群聊隐式回复] API 限速且请求过期，忽略 group=${groupId} msg=${messageId ?? "?"}`);
      return;
    }

    let outgoing = [];
    if (res?.type === "text" && res.content) {
      const text = String(res.content).trim();
      if (isNoChimeResponse(text)) {
        console.log(`[群聊隐式回复] AI 判断不是对机器人的回应 group=${groupId} msg=${messageId ?? "?"}`);
        return;
      }
      if (text) outgoing = [text];
    } else if (res?.type === "multi_text_pending" && Array.isArray(res.messages)) {
      outgoing = res.messages.map((item) => String(item ?? "").trim()).filter(Boolean);
      if (!outgoing.length || outgoing.some(isNoChimeResponse)) return;
    }

    for (let i = 0; i < outgoing.length; i++) {
      if (getGroupHistoryGeneration(groupId) !== clearGeneration) return;
      await sendAiTextMessages(ws, groupId, true, outgoing[i], i === 0 ? (res.mentionQqs || []) : [], i === 0 ? res.quoteMessageId : null);
      if (i < outgoing.length - 1) await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (outgoing.length) state.lastAutoTalkAt = Date.now();
  } catch (error) {
    console.error(`[群聊隐式回复] 失败 group=${groupId}: ${error.message}`);
  } finally {
    state.autoTalkInFlight = false;
    clearHistory(sessionId);
    drainPendingGroupTasks(ws, state);
  }
}

function recordGroupTalkActivity(
  ws,
  { groupId, senderId, messageId, messageTime, selfId, botName, hasMention = false, suppressAutoTalk = false, suppressAutoChime = false, aiCandidate = false, blockedByValue = false, valueScore = null, highValue = false, valueReasons = [], messageText = "", hasImageForAutoTalk = false, suppressMediaAutoTalk = false },
) {
  if (groupId === null || groupId === undefined) return;
  if (isNoRandomTalkGroup(groupId)) return;
  if (isBlacklisted(senderId) || String(senderId) === String(selfId)) return;

  const state = getGroupTalkState(groupId);
  if (blockedByValue) {
    clearGroupIdleTimer(state);
    if (!state.activeChimeForce) clearGroupChimeTimer(state);
    state.lastMessageAt = Date.now();
    state.lastMessageId = messageId ?? null;
    return;
  }
  if (suppressAutoTalk) return;
  if (suppressMediaAutoTalk) {
    clearGroupIdleTimer(state);
    if (!state.activeChimeForce) clearGroupChimeTimer(state);
    state.lastMessageAt = Date.now();
    state.lastMessageId = messageId ?? null;
    return;
  }
  const now = Date.now();
  const at = Number.isFinite(Number(messageTime)) && Number(messageTime) > 0
    ? Number(messageTime) * 1000
    : now;

  state.messages.push({ at, userId: String(senderId), messageId, hasMention: Boolean(hasMention), valueScore, highValue: Boolean(highValue), valueReasons, messageText: String(messageText || "") });
  state.messages = state.messages.filter((item) => now - item.at <= RUNTIME_CONFIG.autoTalkActiveWindowMs);
  state.lastMessageAt = at;
  state.lastMessageId = messageId ?? null;

  clearGroupIdleTimer(state);
  state.idleTimer = setTimeout(() => {
    void performGroupAutoTalk(ws, {
      groupId,
      selfId,
      botName,
      mode: "idle",
      excludeMessageId: null,
    });
  }, RUNTIME_CONFIG.autoTalkIdleMs);

  const forceHighValueChime = Boolean(highValue) && !hasMention;
  const normalChimeEligible = Boolean(aiCandidate) || (
    !hasMention && state.messages.length >= RUNTIME_CONFIG.autoChimeMinMessages &&
    new Set(state.messages.map((item) => item.userId)).size >= RUNTIME_CONFIG.autoTalkActiveMinUsers
  );

  if (suppressAutoChime) {
    // 这条消息会走“是否在回应机器人”的专门判断，避免和群聊旁观判断重复请求。
    clearGroupChimeTimer(state);
    return;
  }

  if (forceHighValueChime) {
    // 高价值定时器优先级最高；后续普通消息不得把它清掉，只允许更新为更新的高价值消息。
    clearGroupChimeTimer(state);
    state.activeChimeForce = true;
    state.activeChimeTimer = setTimeout(() => {
      state.activeChimeTimer = null;
      state.activeChimeForce = false;
      void performGroupConversationChime(ws, {
        groupId,
        selfId,
        botName,
        force: true,
        triggerText: String(messageText || "").trim(),
        triggerReasons: Array.isArray(valueReasons) ? valueReasons : [],
        triggerMessageId: messageId ?? null,
        triggerHasImage: Boolean(hasImageForAutoTalk),
        createdAt: Date.now(),
      });
    }, RUNTIME_CONFIG.autoChimeDebounceMs);
    console.log(`[群聊接话触发] 高价值消息 group=${groupId} score=${Number(valueScore).toFixed(3)}`);
  } else if (!state.activeChimeForce) {
    clearGroupChimeTimer(state);
    if (normalChimeEligible) {
      state.activeChimeTimer = setTimeout(() => {
        state.activeChimeTimer = null;
        void performGroupConversationChime(ws, {
          groupId,
          selfId,
          botName,
          force: false,
          triggerText: String(messageText || "").trim(),
          triggerReasons: Array.isArray(valueReasons) ? valueReasons : [],
          triggerMessageId: messageId ?? null,
          createdAt: Date.now(),
        });
      }, RUNTIME_CONFIG.autoChimeDebounceMs);
    }
  }

}

// ===== HTTP =====
const httpClient = axios.create({ timeout: 5000 });

// ===== 配置 =====

function normalizeBotConfig(config) {
  const source = config && typeof config === "object" ? config : {};
  const sensitiveWords =
    source.sensitiveWords && typeof source.sensitiveWords === "object"
      ? source.sensitiveWords
      : {};

  return {
    ownerQQ: source.ownerQQ !== undefined ? String(source.ownerQQ) : "",
    nickname:
      source.nickname !== undefined ? String(source.nickname) : "Yuragi",
    blacklistQQ: Array.isArray(source.blacklistQQ)
      ? source.blacklistQQ.map(String)
      : [],
    noRandomTalkGroups: Array.isArray(source.noRandomTalkGroups)
      ? source.noRandomTalkGroups.map(String)
      : [],
    sensitiveWords: {
      input: Array.isArray(sensitiveWords.input)
        ? sensitiveWords.input.map(String).filter(Boolean)
        : [],
      output: Array.isArray(sensitiveWords.output)
        ? sensitiveWords.output.map(String).filter(Boolean)
        : [],
    },
  };
}

function loadBotConfig() {
  try {
    const text = fs.readFileSync(BOT_CONFIG_PATH, "utf8");
    return normalizeBotConfig(JSON.parse(text));
  } catch (error) {
    throw new Error(`配置文件读取或解析失败: ${error.message}`);
  }
}

function getConfigMtime() {
  try {
    return fs.statSync(BOT_CONFIG_PATH).mtimeMs;
  } catch {
    return 0;
  }
}

function reloadBotConfigIfChanged() {
  const currentMtime = getConfigMtime();
  if (currentMtime === 0 || currentMtime === botConfigMtime) return;

  try {
    botConfig = loadBotConfig();
    botConfigMtime = currentMtime;
    for (const [key, info] of recentUsers) {
      if (isBlacklisted(info.userId)) recentUsers.delete(key);
    }
    console.log("[配置] 已重新加载");
  } catch (error) {
    console.error(`[配置] 热加载失败，沿用旧配置: ${error.message}`);
  }
}

fs.watchFile(BOT_CONFIG_PATH, { interval: 1000 }, () =>
  reloadBotConfigIfChanged(),
);

function getBotConfig() {
  reloadBotConfigIfChanged();
  return botConfig;
}

function isOwnerQQ(userId) {
  return String(userId) === getBotConfig().ownerQQ;
}

function isBlacklisted(userId) {
  return getBotConfig().blacklistQQ.includes(String(userId));
}

function isNoRandomTalkGroup(groupId) {
  if (groupId === null || groupId === undefined) return false;
  return getBotConfig().noRandomTalkGroups.includes(String(groupId));
}

// ===== 敏感词 =====

function sanitizeText(text, sensitiveWords) {
  if (!text || !Array.isArray(sensitiveWords) || sensitiveWords.length === 0) {
    return text || "";
  }
  for (const word of sensitiveWords) {
    if (!word) continue;
    const pattern = [...word].map((char) => escapeRegExp(char)).join("\\s*");
    text = text.replace(new RegExp(pattern, "gi"), "");
  }
  return text.trim();
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeInput(text) {
  return sanitizeText(text, getBotConfig().sensitiveWords.input);
}

function sanitizeOutput(text) {
  return sanitizeText(text, getBotConfig().sensitiveWords.output);
}

// ===== 控制指令 =====

function getBotClearGeneration(sessionId) {
  return `${botGlobalClearGeneration}:${botSessionClearGenerations.get(String(sessionId)) || 0}`;
}

function getGroupHistoryGeneration(groupId) {
  return `${globalGroupHistoryClearVersion}:${groupHistoryClearVersions.get(String(groupId)) || 0}`;
}

function clearGroupHistory(groupId, time) {
  if (groupId === null || groupId === undefined) return;
  const key = String(groupId);
  groupHistoryClearPoints.set(key, Number(time) || 0);
  groupHistoryClearVersions.set(key, (groupHistoryClearVersions.get(key) || 0) + 1);
  clearHistory(`qq_group_${key}_auto`);
  clearContextRequests(`group:${key}`);
  forwardContextCache.clear();
  for (const imageKey of recentImageContexts.keys()) {
    if (imageKey.startsWith(`group:${key}:`)) recentImageContexts.delete(imageKey);
  }
  saveGroupHistoryClearState();
  const state = groupTalkStates.get(key);
  if (state) {
    clearGroupIdleTimer(state);
    clearGroupChimeTimer(state);
    state.pendingHighValue = null;
    state.messages = [];
    state.lastMessageAt = Date.now();
  }
}

function clearAllGroupHistory(time) {
  globalGroupHistoryClearTime = Number(time) || 0;
  globalGroupHistoryClearVersion++;
  groupHistoryClearPoints.clear();
  groupHistoryClearVersions.clear();
  saveGroupHistoryClearState();
  for (const state of groupTalkStates.values()) {
    clearGroupIdleTimer(state);
    clearGroupChimeTimer(state);
    state.pendingHighValue = null;
    state.messages = [];
    state.lastMessageAt = Date.now();
  }
}

function getGroupHistoryClearTime(groupId) {
  const globalTime = globalGroupHistoryClearTime;
  if (groupId === null || groupId === undefined) return globalTime;
  const localTime = groupHistoryClearPoints.get(String(groupId)) || 0;
  return Math.max(globalTime, localTime);
}

function handleBotControlCommand({ command, sessionId, groupId, isGroup, messageTime }) {
  if (!command) return null;

  if (command.action === "clear") {
    const key = String(sessionId);
    botSessionClearGenerations.set(key, (botSessionClearGenerations.get(key) || 0) + 1);
    clearHistory(sessionId);
    if (isGroup) {
      clearGroupHistory(groupId, messageTime);
    } else {
      recentImageContexts.delete(getRecentImageContextKey(false, null, sessionId.replace(/^qq_/, "")));
    }
    return "好";
  }

  if (command.action === "clear_all") {
    botGlobalClearGeneration++;
    botSessionClearGenerations.clear();
    clearAllHistories();
    clearAllGroupHistory(messageTime);
    recentImageContexts.clear();
    forwardContextCache.clear();
    return "好";
  }

  if (command.action === "reboot") {
    setTimeout(() => {
      console.log("[控制] 主重启，进程退出");
      process.exit(0);
    }, 1000);
    return "…";
  }

  return null;
}

// ===== QQ 消息段 =====

function buildQqTextSegments(text) {
  const value = String(text || "");
  return value ? [{ type: "text", data: { text: value } }] : [];
}

async function sendQqMsg(
  ws,
  targetId,
  isGroup,
  text = null,
  imgUrl = null,
  imageSource = null,
  mentionQqs = [],
) {
  const action = isGroup ? "send_group_msg" : "send_private_msg";
  const params = { [isGroup ? "group_id" : "user_id"]: targetId };
  const messageChain = [];

  for (const qq of Array.isArray(mentionQqs) ? mentionQqs : []) {
    const value = String(qq ?? "").trim();
    if (!value) continue;
    if (value === "all" || /^\d{5,12}$/.test(value)) {
      messageChain.push({ type: "at", data: { qq: value } });
    }
  }

  if (text) {
    const cleanText = sanitizeOutput(text);
    if (cleanText) messageChain.push(...buildQqTextSegments(cleanText));
  }
  if (imgUrl) messageChain.push({ type: "image", data: { file: imgUrl } });
  if (messageChain.length === 0) return;

  params.message = messageChain;

  if (NAPCAT_HTTP_URL && NAPCAT_TOKEN) {
    const result = await callNapCatHttp(action, params);
    if (result) return true;
  }

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error("NapCat WebSocket 当前未连接");
  }

  ws.send(JSON.stringify({ action, params }));
  return true;
}

// ===== AI 消息拆分 / 特殊内容统一路由 =====

async function sendNativeQuotedGroupMessage(ws, groupId, text, mentionQqs, replyMessageId) {
  const cleanText = sanitizeOutput(String(text ?? ""));
  const id = String(replyMessageId ?? "").trim();
  if (!cleanText || !/^\d{1,30}$/.test(id)) return false;
  const message = [{ type: "reply", data: { id } }];
  for (const value of Array.isArray(mentionQqs) ? mentionQqs : []) {
    const qq = String(value ?? "").trim();
    if (qq === "all" || /^\d{5,12}$/.test(qq)) message.push({ type: "at", data: { qq } });
  }
  message.push({ type: "text", data: { text: cleanText } });
  const params = { group_id: groupId, message };
  if (NAPCAT_HTTP_URL && NAPCAT_TOKEN) {
    const result = await callNapCatHttp("send_group_msg", params);
    if (result) return true;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("NapCat WebSocket 当前未连接");
  ws.send(JSON.stringify({ action: "send_group_msg", params }));
  return true;
}

function canUseNativeQuote(text) {
  const value = String(text ?? "");
  return value.length <= 1200 &&
    !/```|\\\(|\\\[|\\begin\{|===SPLIT===|^\s*(?:#{1,6}\s|\|.*\|\s*$)/mu.test(value) &&
    !/\n\s*\n/u.test(value);
}

async function sendAiTextMessages(ws, targetId, isGroup, text, mentionQqs = [], replyMessageId = null) {
  const message = sanitizeOutput(String(text ?? ""));
  if (!message) return;

  const mentions = isGroup && Array.isArray(mentionQqs)
    ? [...new Set(mentionQqs
        .map((value) => String(value ?? "").trim())
        .filter((value) => value === "all" || /^\d{5,12}$/.test(value)))]
    : [];

  // 原生 QQ 引用只用于普通短文本；代码、LaTeX、拆分消息仍交给特殊内容渲染器。
  if (isGroup && replyMessageId && canUseNativeQuote(message)) {
    await sendNativeQuotedGroupMessage(ws, targetId, message, mentions, replyMessageId);
  } else {
    await sendSpecialContent(targetId, isGroup, message, mentions);
  }
  if (isGroup) noteBotGroupReply(targetId, message);
}


// ===== QQ 真实 @ =====

async function sendQqMention(ws, groupId, userId) {
  if (groupId === null || groupId === undefined) {
    console.error("[QQ@] 私聊无法发送群 @");
    return false;
  }

  const qq = String(userId).trim();
  if (qq !== "all" && !/^\d{5,12}$/.test(qq)) {
    console.error(`[QQ@] 无效 QQ 号: ${qq}`);
    return false;
  }

  const params = { group_id: groupId, message: [{ type: "at", data: { qq } }] };

  if (NAPCAT_HTTP_URL && NAPCAT_TOKEN) {
    const result = await callNapCatHttp("send_group_msg", params);
    if (result) return true;
  }

  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ action: "send_group_msg", params }));
      return true;
    } catch (error) {
      console.error(`[QQ@] WS 发送失败: ${error.message}`);
    }
  }

  console.error(`[QQ@] HTTP/WS 均无法发送 @ -> ${qq}`);
  return false;
}

// ===== NapCat HTTP =====

async function setPrivateTypingStatus(userId, isTyping) {
  if (!NAPCAT_HTTP_URL || !NAPCAT_TOKEN || userId === null || userId === undefined) return false;
  const url = NAPCAT_HTTP_URL.replace(/\/+$/, "") + "/set_input_status";
  try {
    const response = await httpClient.post(
      url,
      { user_id: String(userId), event_type: isTyping ? 1 : 0 },
      {
        headers: {
          Authorization: `Bearer ${NAPCAT_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 1500,
      },
    );
    return response?.data?.retcode === undefined || Number(response.data.retcode) === 0;
  } catch {
    // 旧版或不支持此扩展的 NapCat 静默降级，不影响消息发送。
    return false;
  }
}

async function callNapCatHttp(action, params) {
  if (!NAPCAT_HTTP_URL || !NAPCAT_TOKEN) return null;
  const url = NAPCAT_HTTP_URL.replace(/\/+$/, "") + "/" + action;

  try {
    const response = await httpClient.post(url, params, {
      headers: {
        Authorization: `Bearer ${NAPCAT_TOKEN}`,
        "Content-Type": "application/json",
      },
      timeout: 10000,
    });

    const result = response.data;
    if (result && result.retcode !== undefined && Number(result.retcode) !== 0) {
      throw new Error(
        `NapCat retcode=${result.retcode}` +
          (result.message ? `: ${result.message}` : ""),
      );
    }
    return result;
  } catch (error) {
    console.error(`[NapCat] ${action} 失败: ${error.message}`);
    return null;
  }
}

// ===== QQ 视频 =====

async function sendQqVideo(ws, targetId, isGroup, videoUrl) {
  if (!videoUrl) {
    console.error("[QQ视频] URL 为空，无法发送");
    return false;
  }

  const action = isGroup ? "send_group_msg" : "send_private_msg";
  const params = {
    [isGroup ? "group_id" : "user_id"]: targetId,
    message: [{ type: "video", data: { file: videoUrl } }],
  };

  if (NAPCAT_HTTP_URL && NAPCAT_TOKEN) {
    const result = await callNapCatHttp(action, params);
    if (result) return true;
  }

  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ action, params }));
      return true;
    } catch (error) {
      console.error(`[QQ视频] WS 发送失败: ${error.message}`);
    }
  }

  console.error(`[QQ视频] HTTP/WS 均无法发送 -> ${targetId}`);
  return false;
}

// ===== QQ 戳戳 =====

async function sendQqPoke(ws, userId, groupId = null) {
  const hasGroup = groupId !== null && groupId !== undefined;
  const action = hasGroup ? "group_poke" : "friend_poke";
  const params = { user_id: userId };
  if (hasGroup) params.group_id = groupId;

  try {
    if (NAPCAT_HTTP_URL && NAPCAT_TOKEN) {
      const result = await callNapCatHttp(action, params);
      if (result) return true;
    }

    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify({ action, params }));
    return true;
  } catch (error) {
    console.error(`[QQ戳戳] 失败: ${error.message}`);
    return false;
  }
}

// ===== QQ 头像 =====

function getUserAvatarUrl(qq) {
  return `https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=640`;
}

// ===== 消息段 -> 文本 =====

const FORWARD_CONTEXT_TTL_MS = 60_000;
const forwardContextCache = new Map();
const MAX_FORWARD_DEPTH = 2;
const MAX_FORWARD_NODES = 8;

function decodeMarkupEntities(value) {
  return String(value ?? "")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function compactContextText(value, maxLength = 500) {
  const text = decodeMarkupEntities(String(value ?? ""))
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

const CARD_FIELD_LABELS = {
  title: "标题", prompt: "提示", desc: "简介", description: "简介",
  summary: "摘要", text: "正文", content: "内容", url: "链接",
  jumpurl: "跳转链接", jump_url: "跳转链接", shareurl: "分享链接",
  share_url: "分享链接", groupname: "群名", group_name: "群名",
  groupid: "群号", group_id: "群号", inviter: "邀请人",
  invitor: "邀请人", nickname: "昵称", nick: "昵称", detail: "详情",
  source: "来源", name: "名称", appname: "应用", file_name: "文件名",
};
const CARD_FIELD_KEYS = new Set(Object.keys(CARD_FIELD_LABELS));

function parseJsonMaybe(value) {
  if (value && typeof value === "object") return value;
  const text = String(value ?? "").trim();
  if (!text || !/^[{[]/.test(text)) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractStructuredFields(value, options = {}) {
  const fields = [];
  const seenValues = new Set();
  const maxFields = options.maxFields ?? 10;
  const maxDepth = options.maxDepth ?? 5;

  function add(label, raw) {
    if (raw === null || raw === undefined || typeof raw === "object") return;
    const valueText = compactContextText(raw, label === "链接" || label === "跳转链接" || label === "分享链接" ? 350 : 220);
    if (!valueText || seenValues.has(`${label}:${valueText}`)) return;
    seenValues.add(`${label}:${valueText}`);
    fields.push(`${label}：${valueText}`);
  }

  function visit(item, depth = 0) {
    if (item === null || item === undefined || depth > maxDepth || fields.length >= maxFields) return;
    if (typeof item === "string") {
      const parsed = parseJsonMaybe(item);
      if (parsed) {
        visit(parsed, depth + 1);
      } else {
        const decoded = decodeMarkupEntities(item);
        const tagPattern = /<(title|prompt|desc|description|summary|text|content|url|jumpurl|jump_url|shareurl|share_url|groupname|group_name|groupid|group_id|inviter|invitor|nickname|nick|detail|name)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
        let match;
        while ((match = tagPattern.exec(decoded)) && fields.length < maxFields) {
          const key = match[1].toLowerCase();
          add(CARD_FIELD_LABELS[key] || key, match[2]);
        }
        const attrPattern = /\b(url|jumpurl|jump_url|shareurl|share_url|groupid|group_id|groupname|group_name)\s*=\s*["']([^"']+)["']/gi;
        while ((match = attrPattern.exec(decoded)) && fields.length < maxFields) {
          const key = match[1].toLowerCase();
          add(CARD_FIELD_LABELS[key] || key, match[2]);
        }
        if (!fields.length) {
          const urls = decoded.match(/https?:\/\/[^\s"'<>]+/gi) || [];
          for (const url of urls.slice(0, 3)) add("链接", url.replace(/&amp;/gi, "&"));
        }
      }
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item.slice(0, 10)) visit(child, depth + 1);
      return;
    }
    if (typeof item !== "object") return;

    for (const [key, child] of Object.entries(item)) {
      if (fields.length >= maxFields) break;
      const normalized = key.toLowerCase();
      if (CARD_FIELD_KEYS.has(normalized)) {
        if (typeof child === "string" || typeof child === "number") {
          add(CARD_FIELD_LABELS[normalized], child);
        } else if (child && typeof child === "object") {
          visit(child, depth + 1);
        }
      } else if (child && typeof child === "object") {
        visit(child, depth + 1);
      } else if (typeof child === "string" && /^(meta|news|detail|app|data|config|extra)$/i.test(key)) {
        visit(child, depth + 1);
      }
    }
  }

  visit(value);
  return fields;
}

function summarizeSpecialSegment(segType, data = {}) {
  if (segType === "share") {
    const fields = [];
    const title = data.title || data.prompt;
    const desc = data.content || data.desc || data.description || data.summary;
    const url = data.url || data.jumpUrl || data.jump_url || data.shareUrl;
    if (title) fields.push(`标题：${compactContextText(title, 220)}`);
    if (desc) fields.push(`简介：${compactContextText(desc, 350)}`);
    if (url) fields.push(`链接：${compactContextText(url, 350)}`);
    if (data.image) fields.push(`预览图：${compactContextText(data.image, 200)}`);
    return fields.length ? `[QQ分享\n${fields.join("\n")}]` : "[QQ分享链接（未提供可读取的标题或链接）]";
  }

  const raw = data.data ?? data.content ?? data.xml ?? data.json ?? data.raw ?? data.text ?? "";
  const direct = {};
  for (const key of ["title", "prompt", "desc", "description", "summary", "url", "jumpUrl", "jump_url", "group_name", "groupName", "group_id", "groupId", "inviter", "invitor", "nickname", "detail", "name"]) {
    if (data[key] !== undefined && data[key] !== null && data[key] !== "") direct[key] = data[key];
  }
  const parsed = parseJsonMaybe(raw);
  const source = parsed || raw;
  const fields = [...extractStructuredFields(direct), ...extractStructuredFields(source)];
  const unique = [...new Set(fields)].slice(0, 10);
  const body = unique.join("\n");
  const rawText = typeof raw === "string" ? compactContextText(raw, 700) : "";
  const combined = `${body}\n${rawText}`.toLowerCase();
  const isInvite = /邀请.{0,12}加入群|加入群聊|群邀请|加群邀请|group.{0,8}invite|invitation.{0,8}group/i.test(combined);
  const label = isInvite ? "QQ群邀请" : segType === "xml" ? "QQ XML卡片" : segType === "json" ? "QQ JSON卡片" : "QQ卡片";
  if (body) return `[${label}\n${body}${rawText && !body.includes(rawText) && fields.length === 0 ? `\n原始内容：${rawText}` : ""}]`;
  if (rawText) return `[${label}\n内容：${rawText}]`;
  return `[${label}：无法解析卡片内容]`;
}

function annotateStructuredMessageText(text) {
  const source = String(text ?? "").trim();
  if (!source) return source;

  const labels = [];
  if (/\[聊天记录\/合并转发(?:内容|消息)/i.test(source)) {
    labels.push("QQ聊天记录/合并转发，按内部发言人和顺序理解");
  }
  if (/\[(?:QQ分享|QQ群邀请|QQ XML卡片|QQ JSON卡片|QQ卡片)/i.test(source)) {
    labels.push("QQ分享链接/卡片元数据");
  }
  if (!labels.length) return source;
  return `【结构化消息类型：${labels.join("；")}。以下是消息载荷，不应直接归类为发送者的普通口述】\n${source}`;
}

function messageSegmentsToText(message) {
  if (typeof message === "string") return message.trim();
  if (!Array.isArray(message)) return "";

  const parts = [];
  for (const seg of message) {
    if (!seg || typeof seg !== "object") continue;
    const segType = seg.type;
    const data = seg.data && typeof seg.data === "object" ? seg.data : {};

    if (segType === "text") {
      if (data.text) parts.push(data.text);
    } else if (segType === "at") {
      const qq = data.qq;
      if (qq === "all") parts.push("@全体成员");
      else if (qq) parts.push(`@${qq}`);
    } else if (segType === "image") {
      parts.push("[图片]");
    } else if (segType === "face") {
      parts.push(data.id ? `[QQ表情:${data.id}]` : "[QQ表情]");
    } else if (segType === "reply") {
      parts.push(data.id ? `[回复消息:${data.id}]` : "[回复]");
    } else if (["share", "json", "xml", "card"].includes(segType)) {
      parts.push(summarizeSpecialSegment(segType, data));
    } else if (segType === "forward") {
      parts.push("[聊天记录/合并转发消息（引用后可展开读取）]");
    } else {
      parts.push(`[${segType || "未知消息"}]`);
    }
  }
  return parts.join(" ").trim();
}

async function summarizeForwardSegment(data = {}, depth = 0) {
  const forwardId = String(data.id || data.resid || data.resource_id || data.resId || "").trim();
  if (!forwardId) return "[聊天记录/合并转发消息：缺少转发 ID]";
  if (depth >= MAX_FORWARD_DEPTH) return "[聊天记录/合并转发消息：已达到展开层数限制]";

  const cached = forwardContextCache.get(forwardId);
  if (cached && Date.now() - cached.savedAt < FORWARD_CONTEXT_TTL_MS) return cached.text;

  try {
    const result = await callNapCatHttp("get_forward_msg", { id: forwardId });
    const payload = result?.data && typeof result.data === "object" ? result.data : result;
    const messages = Array.isArray(payload?.messages) ? payload.messages : Array.isArray(payload) ? payload : [];
    if (!messages.length) return `[聊天记录/合并转发消息：已获取引用 ID ${forwardId}，但接口没有返回消息正文]`;

    const lines = [];
    for (const node of messages.slice(0, MAX_FORWARD_NODES)) {
      const sender = node?.sender && typeof node.sender === "object" ? node.sender : {};
      const name = compactContextText(sender.card || sender.nickname || node?.user_id || "未知发送者", 80);
      const content = await messageSegmentsToTextAsync(node?.message ?? node?.content ?? [], depth + 1);
      if (content) lines.push(`${name}：${content}`);
    }
    const extra = messages.length > MAX_FORWARD_NODES ? `\n（其余 ${messages.length - MAX_FORWARD_NODES} 条未展开）` : "";
    const text = `[聊天记录/合并转发内容，共 ${messages.length} 条：\n${lines.join("\n")}${extra}]`;
    forwardContextCache.set(forwardId, { text, savedAt: Date.now() });
    return text;
  } catch (error) {
    console.warn(`[QQ引用] 展开聊天记录失败: ${error.message}`);
    return `[聊天记录/合并转发消息：读取失败，引用 ID ${forwardId}]`;
  }
}

async function messageSegmentsToTextAsync(message, depth = 0) {
  if (typeof message === "string") return message.trim();
  if (!Array.isArray(message)) return "";

  const parts = [];
  for (const seg of message) {
    if (!seg || typeof seg !== "object") continue;
    const type = seg.type;
    const data = seg.data && typeof seg.data === "object" ? seg.data : {};
    if (type === "text") {
      if (data.text) parts.push(data.text);
    } else if (type === "at") {
      parts.push(data.qq === "all" ? "@全体成员" : data.qq ? `@${data.qq}` : "[@用户]");
    } else if (type === "image") {
      parts.push("[图片]");
    } else if (type === "face") {
      parts.push(data.id ? `[QQ表情:${data.id}]` : "[QQ表情]");
    } else if (type === "reply") {
      parts.push(data.id ? `[回复消息:${data.id}]` : "[回复]");
    } else if (type === "forward") {
      parts.push(await summarizeForwardSegment(data, depth));
    } else if (["share", "json", "xml", "card"].includes(type)) {
      parts.push(summarizeSpecialSegment(type, data));
    } else if (type) {
      parts.push(`[${type}消息]`);
    }
  }
  return parts.join(" ").trim();
}

// ===== 下载图片 =====

function getImageMimeType(source, contentType = "") {
  const type = String(contentType || "").toLowerCase();
  if (type.includes("png")) return "image/png";
  if (type.includes("webp")) return "image/webp";
  if (type.includes("gif")) return "image/gif";
  if (type.includes("bmp")) return "image/bmp";
  if (type.includes("avif")) return "image/avif";

  const ext = String(source || "").split(/[?#]/)[0].toLowerCase();
  if (ext.endsWith(".png")) return "image/png";
  if (ext.endsWith(".webp")) return "image/webp";
  if (ext.endsWith(".gif")) return "image/gif";
  if (ext.endsWith(".bmp")) return "image/bmp";
  if (ext.endsWith(".avif")) return "image/avif";
  return "image/jpeg";
}

async function downloadImageAsBase64(imgUrl, timeout = 10000) {
  if (!imgUrl) return null;
  const source = String(imgUrl).trim();
  if (!source) return null;

  if (/^data:image\//i.test(source)) return source;

  if (/^base64:\/\//i.test(source)) {
    const base64 = source.slice("base64://".length).trim();
    return base64 ? `data:image/png;base64,${base64}` : null;
  }

  try {
    let localPath = null;
    if (/^file:\/\//i.test(source)) {
      try {
        localPath = fileURLToPath(source);
      } catch {
        localPath = null;
      }
    } else if (path.isAbsolute(source)) {
      localPath = source;
    }

    if (localPath && fs.existsSync(localPath)) {
      const buffer = await fs.promises.readFile(localPath);
      if (!buffer.length) return null;
      const mimeType = getImageMimeType(localPath);
      return `data:${mimeType};base64,${buffer.toString("base64")}`;
    }

    if (!/^https?:\/\//i.test(source)) return null;

    const response = await httpClient.get(source, {
      timeout,
      responseType: "arraybuffer",
      maxContentLength: 15 * 1024 * 1024,
      maxBodyLength: 15 * 1024 * 1024,
      headers: {
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
    });

    const buffer = Buffer.from(response.data || []);
    if (!buffer.length) return null;

    const mimeType = getImageMimeType(source, response.headers["content-type"]);
    return `data:${mimeType};base64,${buffer.toString("base64")}`;
  } catch (error) {
    console.error(`[QQ图片] 下载失败: ${error.message}`);
    return null;
  }
}

// ===== 获取指定 QQ 消息 =====

function extractImageSourceFromMessage(message) {
  if (!message || typeof message !== "object") return null;
  const segments = Array.isArray(message.message) ? message.message : [];
  for (const seg of segments) {
    if (!seg || typeof seg !== "object" || seg.type !== "image") continue;
    const data = seg.data && typeof seg.data === "object" ? seg.data : {};
    const source = data.url || data.file;
    if (source) return String(source);
  }
  return null;
}

async function fetchQqMessage(messageId) {
  if (!NAPCAT_HTTP_URL || !NAPCAT_TOKEN) return null;
  if (messageId === null || messageId === undefined) return null;

  const url = NAPCAT_HTTP_URL.replace(/\/+$/, "") + "/get_msg";
  try {
    const response = await httpClient.post(
      url,
      { message_id: messageId },
      {
        headers: {
          Authorization: `Bearer ${NAPCAT_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 8000,
      },
    );

    if (response.status !== 200) return null;
    const result = response.data;
    if ((result?.retcode ?? 0) !== 0) return null;

    const data = result?.data;
    if (!data || typeof data !== "object") return null;
    return data;
  } catch (error) {
    console.error(`[QQ引用] 获取消息异常: ${error.message}`);
    return null;
  }
}

async function buildQuotedMessageContext(message, { selfId = null } = {}) {
  if (!message || typeof message !== "object") return "";

  const senderId = String(message.user_id ?? "未知");
  const sender =
    message.sender && typeof message.sender === "object" ? message.sender : {};
  const isSelf =
    selfId !== null && selfId !== undefined && senderId === String(selfId);
  const senderName = sender.card || sender.nickname || senderId;
  const label = isSelf ? "你（机器人）" : `群友「${senderName}」`;
  const text = await messageSegmentsToTextAsync(message.message || []);
  const hasImage =
    Array.isArray(message.message) &&
    message.message.some((seg) => seg?.type === "image");

  if (!text && !hasImage) return "";

  const parts = [`[引用消息]\n发送者：${label} [QQ:${senderId}]`];
  if (text) parts.push(`内容：${annotateStructuredMessageText(text)}`);
  if (hasImage) parts.push("内容中包含图片。");
  return parts.join("\n");
}

// ===== 从消息中提取图片 =====

async function getImageResourceFromNapCat(file) {
  if (!file || !NAPCAT_HTTP_URL || !NAPCAT_TOKEN) return null;

  const result = await callNapCatHttp("get_image", { file: String(file) });
  const data =
    result?.data && typeof result.data === "object" ? result.data : result;
  if (!data || typeof data !== "object") return null;

  return data.url || data.file || data.path || null;
}

async function downloadImageReference(data, timeout = 15000) {
  const direct = data?.url || null;
  const file = data?.file || null;

  if (direct) {
    const imageContent = await downloadImageAsBase64(direct, timeout);
    if (imageContent) return imageContent;
  }

  if (file) {
    try {
      const resolved = await getImageResourceFromNapCat(file);
      if (resolved) {
        const imageContent = await downloadImageAsBase64(resolved, timeout);
        if (imageContent) return imageContent;
      }
    } catch (error) {
      console.warn(`[QQ图片] get_image 回退失败: ${error.message}`);
    }
  }

  if (file && file !== direct) {
    const imageContent = await downloadImageAsBase64(file, timeout);
    if (imageContent) return imageContent;
  }

  return null;
}

async function extractImageFromMessage(message) {
  if (!message || typeof message !== "object") return null;
  const segments = Array.isArray(message.message) ? message.message : [];
  for (const seg of segments) {
    if (!seg || typeof seg !== "object" || seg.type !== "image") continue;
    const data = seg.data && typeof seg.data === "object" ? seg.data : {};
    const imageContent = await downloadImageReference(data, 10000);
    if (imageContent) return imageContent;
  }
  return null;
}

// ===== 获取群聊历史 =====

async function fetchGroupHistory(groupId, currentMessageId = null, selfId = null, includeImageToolHints = false, options = {}) {
  if (!NAPCAT_HTTP_URL || !NAPCAT_TOKEN) return "";
  const url = NAPCAT_HTTP_URL.replace(/\/+$/, "") + "/get_group_msg_history";

  try {
    const response = await httpClient.post(
      url,
      { group_id: groupId, count: RUNTIME_CONFIG.maxGroupHistoryFetchCount, message_seq: 0 },
      {
        headers: {
          Authorization: `Bearer ${NAPCAT_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 3000,
      },
    );

    if (response.status !== 200) return "";
    const result = response.data;
    if (result?.status !== undefined && result.status !== "ok") return "";
    if ((result?.retcode ?? 0) !== 0) return "";

    const data = result.data;
    let msgs = [];
    if (data && typeof data === "object" && !Array.isArray(data))
      msgs = data.messages || [];
    else if (Array.isArray(data)) msgs = data;
    if (!msgs.length) return "";

    const clearTime = getGroupHistoryClearTime(groupId);
    const formattedMsgs = [];
    const maxAgeMs = Number(options?.maxAgeMs) > 0 ? Number(options.maxAgeMs) : 0;
    const oldestAllowedTime = maxAgeMs > 0 ? Date.now() / 1000 - maxAgeMs / 1000 : 0;
    const timestampOf = (message) => {
      const value = Number(message?.time || 0);
      return value > 1e12 ? value / 1000 : value; // 兼容秒与毫秒时间戳。
    };
    // NapCat 的历史返回顺序不应被假定；统一按时间升序，避免 slice(-N) 取错“最近”消息。
    const orderedMessages = [...msgs].sort((a, b) => timestampOf(a) - timestampOf(b));

    for (const m of orderedMessages) {
      if (!m || typeof m !== "object") continue;

      if (
        currentMessageId !== null &&
        currentMessageId !== undefined &&
        String(m.message_id) === String(currentMessageId)
      ) {
        continue;
      }

      const messageTimestamp = timestampOf(m);
      if (clearTime > 0 && messageTimestamp <= clearTime) continue;
      // 自动接话只使用能确认时间且足够新的消息；缺失时间戳时不让未知旧消息混入上下文。
      if (oldestAllowedTime > 0 && (!messageTimestamp || messageTimestamp < oldestAllowedTime)) continue;
      if (isBlacklisted(m.user_id)) continue;
      if (Array.isArray(m.message) && m.message.some((seg) => ["video", "record"].includes(seg?.type))) continue;
      const hasImage = Array.isArray(m.message) && m.message.some((seg) => seg?.type === "image");

      const sender = m.sender && typeof m.sender === "object" ? m.sender : {};
      const senderId = String(m.user_id ?? "未知");
      const isSelf =
        selfId !== null && selfId !== undefined && senderId === String(selfId);
      const sName = sender.card || sender.nickname || senderId;

      let rawTxt = await messageSegmentsToTextAsync(m.message || []);
      rawTxt = rawTxt.trim();
      if (!rawTxt) continue;

      let cleanRaw = sanitizeInput(rawTxt);
      if (!cleanRaw) continue;

      cleanRaw = annotateStructuredMessageText(cleanRaw);
      const isStructured = /【结构化消息类型：/.test(cleanRaw);
      cleanRaw = cleanRaw.slice(0, isStructured ? 500 : 150);
      const imageHint = hasImage && includeImageToolHints
        ? ` [含图片；可按需调用 get_recent_group_image，message_id=${String(m.message_id)}]`
        : hasImage
          ? " [含图片]"
          : "";
      formattedMsgs.push(
        isSelf
          ? `[消息ID:${String(m.message_id)}] 你（机器人） [QQ:${senderId}]: ${cleanRaw}${imageHint}`
          : `[消息ID:${String(m.message_id)}] 群友「${sName}」 [QQ:${senderId}]: ${cleanRaw}${imageHint}`,
      );
    }

    if (!formattedMsgs.length) return "";
    const historyLimit = Number.isInteger(Number(options?.limit)) && Number(options.limit) > 0
      ? Math.min(100, Number(options.limit))
      : RUNTIME_CONFIG.maxGroupContextMessages;
    const finalMsgs = formattedMsgs.slice(-historyLimit);
    const ageHint = maxAgeMs > 0 ? `，仅最近 ${Math.round(maxAgeMs / 60000)} 分钟` : "";
    const header = `[最近群聊历史，仅供上下文参考；最多 ${historyLimit} 条${ageHint}，按时间顺序排列]`;
    const maxChars = Math.max(500, Number(RUNTIME_CONFIG.maxGroupContextChars) || 6000);
    const selected = [];
    let usedChars = Array.from(header).length + 2;
    // 从最新消息向前纳入上下文，达到字数上限后停止；最终仍按时间升序提交。
    for (let i = finalMsgs.length - 1; i >= 0; i--) {
      const line = finalMsgs[i];
      const length = Array.from(line).length + 1;
      if (usedChars + length > maxChars && selected.length) break;
      selected.unshift(line);
      usedChars += length;
      if (usedChars >= maxChars) break;
    }
    const contextText = `\n${header}\n${selected.join("\n")}\n`;
    if (finalMsgs.length > selected.length) console.log(`[QQ历史] 上下文已裁剪 ${finalMsgs.length}->${selected.length} 条，约 ${usedChars} 字`);
    return contextText;
  } catch (error) {
    console.error(`[QQ历史] 获取群历史异常: ${error.message}`);
    return "";
  }
}

// 自动接话只有在模型主动调用工具时才下载图片；只访问近期、未被清除的群消息。
async function fetchRecentGroupImage(groupId, requestedMessageId = null) {
  if (!NAPCAT_HTTP_URL || !NAPCAT_TOKEN || groupId === null || groupId === undefined) return null;
  const url = NAPCAT_HTTP_URL.replace(/\/+$/, "") + "/get_group_msg_history";
  try {
    const response = await httpClient.post(
      url,
      { group_id: groupId, count: RUNTIME_CONFIG.maxGroupHistoryFetchCount, message_seq: 0 },
      {
        headers: {
          Authorization: `Bearer ${NAPCAT_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 4000,
      },
    );
    const result = response?.data;
    if (response.status !== 200 || (result?.status !== undefined && result.status !== "ok") || (result?.retcode ?? 0) !== 0) return null;
    const data = result.data;
    const messages = data && typeof data === "object" && !Array.isArray(data)
      ? data.messages || []
      : Array.isArray(data) ? data : [];
    const clearTime = getGroupHistoryClearTime(groupId);
    const candidates = messages
      .filter((item) => {
        if (!item || typeof item !== "object") return false;
        if (clearTime > 0 && Number(item.time || 0) <= clearTime) return false;
        if (isBlacklisted(item.user_id)) return false;
        if (item.group_id !== undefined && String(item.group_id) !== String(groupId)) return false;
        if (!Array.isArray(item.message) || !item.message.some((seg) => seg?.type === "image")) return false;
        return requestedMessageId === null || requestedMessageId === undefined || String(item.message_id) === String(requestedMessageId);
      })
      .sort((a, b) => Number(b.time || 0) - Number(a.time || 0));
    const message = candidates[0];
    if (!message) return null;
    const imageContent = await extractImageFromMessage(message);
    if (!imageContent) return null;
    const sender = message.sender && typeof message.sender === "object" ? message.sender : {};
    const text = (await messageSegmentsToTextAsync(message.message || []))
      .replace(/\[图片\]/g, "")
      .trim();
    return {
      imageContent,
      messageId: String(message.message_id ?? ""),
      senderName: String(sender.card || sender.nickname || message.user_id || "群友"),
      text: text.slice(0, 500),
    };
  } catch (error) {
    console.warn(`[群聊图片工具] 读取近期图片失败：${error.message}`);
    return null;
  }
}

// ===== 主动戳戳 =====

async function randomPokeLoop(ws, signal) {
  console.log("[主动戳戳] 已启动");

  while (!signal.aborted) {
    try {
      await sleepWithSignal(60_000, signal);
      if (signal.aborted || recentUsers.size === 0) continue;

      const now = Date.now() / 1000;
      if (now - lastRandomPokeTime < 300) continue;
      if (Math.random() > 0.015) continue;

      const candidates = [];
      for (const [key, info] of recentUsers) {
        const { groupId, userId } = info;
        if (isOwnerQQ(userId) || isBlacklisted(userId)) continue;
        const lastPoke = userLastPokeTime.get(key) || 0;
        if (now - lastPoke < 1800) continue;
        candidates.push({ key, groupId, userId });
      }
      if (!candidates.length) continue;

      const selected = candidates[Math.floor(Math.random() * candidates.length)];

      await sendQqPoke(ws, selected.userId, selected.groupId);
      lastRandomPokeTime = now;
      userLastPokeTime.set(selected.key, now);
    } catch (error) {
      if (signal.aborted) break;
      console.error(`[主动戳戳] 异常: ${error.message}`);
    }
  }

  console.log("[主动戳戳] 已停止");
}

function sleepWithSignal(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();

    let timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      resolve();
    };

    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      timer = null;
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// ===== QQ WebSocket 主循环 =====

async function handleQqWs() {
  while (true) {
    let ws = null;
    let pokeController = null;

    try {
      console.log(`[QQ] 连接 ${NAPCAT_WS_URL}`);
      ws = new WebSocket(NAPCAT_WS_URL);
      await waitForWebSocketOpen(ws);
      console.log("[QQ] 已连接");

      pokeController = new AbortController();
      randomPokeLoop(ws, pokeController.signal).catch((error) => {
        if (!pokeController.signal.aborted) {
          console.error("[主动戳戳] 崩溃:", error);
        }
      });

      await new Promise((resolve, reject) => {
        let settled = false;

        const cleanup = () => {
          ws.off("close", onClose);
          ws.off("error", onError);
        };

        const onClose = () => {
          if (settled) return;
          settled = true;
          console.log("[QQ] 连接断开");
          cleanup();
          resolve();
        };

        const onError = (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };

        ws.on("message", async (data) => {
          try {
            const event = JSON.parse(data.toString());
            await handleQqEvent(ws, event);
          } catch (error) {
            console.error(`[QQ] 消息处理异常: ${error.message}`);
          }
        });

        ws.once("close", onClose);
        ws.once("error", onError);
      });
    } catch (error) {
      console.error(`[QQ] 连接失败，5秒后重连: ${error.message}`);
    } finally {
      if (pokeController) {
        pokeController.abort();
        pokeController = null;
      }
      if (ws && ws.readyState !== WebSocket.CLOSED) {
        try {
          ws.close();
        } catch {}
      }
    }

    await sleep(5000);
  }
}

// ===== QQ 事件分发 =====

async function handleQqEvent(ws, event) {
  const isPrivateMessage = event?.post_type === "message" && event?.message_type === "private";
  const userId = event?.user_id;
  if (!isPrivateMessage || isBlacklisted(userId) || String(userId) === String(event?.self_id)) {
    return handleQqEventInternal(ws, event);
  }

  const key = String(userId);
  let state = privateTypingStates.get(key);
  if (!state) {
    state = {
      activeRequests: 0,
      timer: null,
      typingShown: false,
      statusPromise: Promise.resolve(false),
    };
    privateTypingStates.set(key, state);
  }
  state.activeRequests++;
  let leaseReleased = false;

  const releaseTypingLease = async () => {
    if (leaseReleased) return;
    leaseReleased = true;
    state.activeRequests = Math.max(0, state.activeRequests - 1);

    if (state.activeRequests !== 0) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    const shouldStop = state.typingShown;
    state.typingShown = false;
    if (privateTypingStates.get(key) === state) privateTypingStates.delete(key);

    if (shouldStop) {
      // 确保“结束输入”排在“开始输入”之后；不会在最终消息发出后继续显示输入状态。
      try { await state.statusPromise; } catch {}
      await setPrivateTypingStatus(userId, false);
    }
  };

  // 只在收到消息满 1 秒仍未完成时显示输入状态；短请求不会闪一下。
  if (state.activeRequests === 1) {
    state.timer = setTimeout(() => {
      state.timer = null;
      if (state.activeRequests <= 0 || privateTypingStates.get(key) !== state) return;
      state.typingShown = true;
      state.statusPromise = setPrivateTypingStatus(userId, true);
    }, 1000);
  }

  try {
    return await handleQqEventInternal(ws, event, { onCoreComplete: releaseTypingLease });
  } finally {
    // 若请求在调用模型前就结束，也要释放；若已在 SSE 完成时释放则此处是空操作。
    await releaseTypingLease();
  }
}

async function handleQqEventInternal(ws, event, lifecycle = {}) {
  const onCoreComplete = typeof lifecycle?.onCoreComplete === "function"
    ? lifecycle.onCoreComplete
    : null;
  const postType = event?.post_type;
  const botName = getBotConfig().nickname;

  // ----- Notice 分支 -----
  if (postType === "notice") {
    const noticeType = event.notice_type;
    const subType = event.sub_type;
    const targetId = event.target_id;
    const senderId = event.user_id;
    const groupId = event.group_id;
    const selfId = event.self_id;

    if (
      noticeType === "notify" &&
      subType === "poke" &&
      String(targetId) === String(selfId)
    ) {
      if (isBlacklisted(senderId)) return;

      const isGroup = groupId !== null && groupId !== undefined;
      const targetReplyId = isGroup ? groupId : senderId;
      const sessionId = isGroup ? `qq_${groupId}_${senderId}` : `qq_${senderId}`;
      const isOwner = isOwnerQQ(senderId);
      const skipApi = shouldSkipPokeApi(senderId, isGroup ? groupId : null);

      if (skipApi) {
        console.log(`[QQ戳戳限速] 连续戳戳，跳过 API 并直接回戳 user=${senderId} group=${groupId ?? "private"}`);
        await sendQqPoke(ws, senderId, groupId);
        return;
      }

      console.log(`[QQ] 被戳 from=${senderId}`);

      const pokePrompt = isOwner
        ? "[事件] 主人戳了你一下。亲切的回应"
        : "[事件] 对方戳了你一下。自然的回应";

      const res = await coreProcessChat(sessionId, pokePrompt, undefined, {
        isOwner,
        isGroup,
        userId: String(senderId),
        botId: String(selfId),
        botName,
        searchText: null,
      });

      if (res?.type === "text") {
        await sendAiTextMessages(ws, targetReplyId, isGroup, res.content, res.mentionQqs);
      }
      await sendQqPoke(ws, senderId, groupId);
    }
    return;
  }

  if (postType !== "message") return;

  const messageType = event.message_type;
  const senderId = event.user_id;
  const groupId = event.group_id;
  const selfId = event.self_id;
  const messageId = event.message_id;
  const messageTime = Number(event.time || Date.now() / 1000);
  const isGroup = messageType === "group";
  const targetId = isGroup ? groupId : senderId;
  const sessionId = isGroup ? `qq_${groupId}_${senderId}` : `qq_${senderId}`;
  const responseClearGeneration = getBotClearGeneration(sessionId);
  const groupContextGeneration = isGroup ? getGroupHistoryGeneration(groupId) : null;
  resetPokeStreak(senderId, isGroup ? groupId : null);

  if (isBlacklisted(senderId)) return;
  if (String(senderId) === String(selfId)) return;

  const isOwner = isOwnerQQ(senderId);

  let userText = "";
  let imageContent = null;
  let imageSourceUrl = null;
  let imageSegmentData = null;
  let hasImageSegment = false;
  let isMentioned = false;
  let isAtAll = false;
  let hasAnyMention = false;
  let targetAvatarQq = null;
  let replyMessageId = null;
  let quotedMessageContext = "";
  let repliedMessageData = null;
  let replyMessageFetched = false;
  let isReplyToBot = false;
  let hasUnsupportedContent = false;
  let blockedByValueScore = false;

  const segments = Array.isArray(event.message) ? event.message : [];

  if (!Array.isArray(event.message) && event.message) {
    userText = String(event.raw_message || event.message);
  }

  for (const seg of segments) {
    if (!seg || typeof seg !== "object") continue;
    const segType = seg.type;
    const segData = seg.data && typeof seg.data === "object" ? seg.data : {};

    if (segType === "at") {
      hasAnyMention = true;
      const targetQq = String(segData.qq ?? "");
      if (targetQq === "all") isAtAll = true;
      else if (targetQq === String(selfId)) isMentioned = true;
      else targetAvatarQq = targetQq;
    } else if (segType === "text") {
      userText += segData.text || "";
    } else if (segType === "image") {
      hasImageSegment = true;
      if (!imageSegmentData) {
        const imgUrl = segData.url || segData.file;
        if (imgUrl) {
          imageSegmentData = segData;
          imageSourceUrl = segData.url || segData.file || null;
        }
      }
    } else if (segType === "reply") {
      replyMessageId = segData.id;
    } else if (segType === "face") {
      const faceId = segData.id ?? "";
      userText += faceId !== "" ? `[QQ表情:${faceId}]` : "[QQ表情]";
      hasUnsupportedContent = true;
    } else if (segType === "mface") {
      const summary = segData.summary || segData.key || "QQ商城表情";
      userText += `[QQ商城表情:${summary}]`;
      hasUnsupportedContent = true;
    } else if (segType === "dice") {
      userText += `[骰子:${segData.result ?? "未知"}]`;
      hasUnsupportedContent = true;
    } else if (segType === "rps") {
      userText += `[石头剪刀布:${segData.result ?? "未知"}]`;
      hasUnsupportedContent = true;
    } else if (segType === "record") {
      userText += "[语音消息]";
      hasUnsupportedContent = true;
    } else if (segType === "video") {
      userText += "[视频消息]";
      hasUnsupportedContent = true;
    } else if (segType === "file") {
      userText += "[文件消息]";
      hasUnsupportedContent = true;
    } else if (segType === "forward") {
      userText += await summarizeForwardSegment(segData);
      hasUnsupportedContent = true;
    } else if (["share", "json", "xml", "card"].includes(segType)) {
      userText += summarizeSpecialSegment(segType, segData);
      hasUnsupportedContent = true;
    } else if (segType === "markdown") {
      userText += summarizeSpecialSegment(segType, segData);
      hasUnsupportedContent = true;
    } else if (segType) {
      userText += `[${segType}消息]`;
      hasUnsupportedContent = true;
    }
  }

  if (!userText.trim() && segments.length) {
    const specialTypes = [
      ...new Set(
        segments
          .map((seg) => (seg && typeof seg === "object" ? String(seg.type || "") : ""))
          .filter(
            (type) => type && !["text", "at", "image", "reply"].includes(type),
          ),
      ),
    ];
    if (specialTypes.length) {
      userText = `[收到特殊QQ消息:${specialTypes.join(",")}]`;
      hasUnsupportedContent = true;
    }
  }

  if (!userText.trim() && event.raw_message) {
    const raw = String(event.raw_message);
    userText = raw.trim() || "[收到一条QQ特殊消息]";
    hasUnsupportedContent = true;
  }

  if (isAtAll) return;

  // 清洗后，昵称由独立价值评分模块加分；仅真实 QQ @ 才走直接回复通道。
  userText = sanitizeInput(userText);

  // 先读取引用目标，群聊中引用了机器人的发言即使没有 @ 也应触发回复。
  if (replyMessageId) {
    repliedMessageData = await fetchQqMessage(replyMessageId);
    replyMessageFetched = true;
    const quotedSenderId =
      repliedMessageData?.user_id ??
      repliedMessageData?.sender?.user_id ??
      repliedMessageData?.sender?.uin;
    isReplyToBot =
      quotedSenderId !== null &&
      quotedSenderId !== undefined &&
      String(quotedSenderId) === String(selfId);
  }

  // ----- 控制 / 公开指令 -----
  const controlCommand = handleControlCommand(userText, senderId);

  if (controlCommand?.type === "owner") {
    const controlReply = handleBotControlCommand({
      command: controlCommand,
      sessionId,
      groupId,
      isGroup,
      messageTime,
    });

    if (controlReply) await sendQqMsg(ws, targetId, isGroup, controlReply);
    return;
  }

  if (controlCommand?.type === "public") {
    if (controlCommand.action === "server_status") {
      const rateLimit = checkServerStatusRateLimit(senderId);
      if (!rateLimit.allowed) {
        const seconds = Math.ceil(rateLimit.remainingMs / 1000);
        await sendQqMsg(
          ws,
          targetId,
          isGroup,
          `服务器状态查得太频繁啦，${seconds} 秒后再查吧。`,
        );
        return;
      }

      try {
        const statusText = await getServerStatus();
        await sendQqMsg(ws, targetId, isGroup, statusText);
      } catch (error) {
        console.error(`[服务器状态] 失败: ${error.message}`);
        await sendQqMsg(
          ws,
          targetId,
          isGroup,
          "唔……服务器状态接口暂时连不上了喵。",
        );
      }
      return;
    }
    return;
  }

  if (controlCommand?.type === "unauthorized") {
    const unauthorizedPrompt =
      `[系统提示：对方无权执行机器人控制指令「${controlCommand.command}」。` +
      "委婉拒绝请求，不要声称已执行。]";

    const res = await coreProcessChat(sessionId, unauthorizedPrompt, undefined, {
      isOwner: false,
      isGroup,
      userId: String(senderId),
      botId: String(selfId),
      botName,
      searchText: null,
    });
    if (onCoreComplete) await onCoreComplete();

    if (res?.type === "text")
      await sendAiTextMessages(ws, targetId, isGroup, res.content, res.mentionQqs);
    return;
  }

  // 广义候选判断：有意义的句子交给现有 API 结合上下文判断，不再要求本地样例命中。
  const hasImageForAutoTalk = hasImageSegment;
  const hasUnsupportedAutoMedia = segments.some((seg) => ["video", "record"].includes(seg?.type));
  const recentBotReplyAtMessage = isGroup && !hasAnyMention && !isReplyToBot ? getRecentBotGroupReply(groupId) : null;
  const textFilter = shouldEvaluateMessage(userText);
  const implicitFollowupCandidate = Boolean(
    recentBotReplyAtMessage && !hasImageForAutoTalk && !hasUnsupportedAutoMedia && textFilter.eligible
  );
  let aiCandidateAssessment = null;
  let messageValueAssessment = null;
  if (isGroup && !hasAnyMention && !isReplyToBot && !hasUnsupportedAutoMedia) {
    const scoreText = cleanValueText(userText);
    if (implicitFollowupCandidate) {
      const ruleResult = evaluateMessageValue(scoreText, botName);
      messageValueAssessment = combineMessageValue(ruleResult, null);
      messageValueAssessment.highValue = true;
      messageValueAssessment.combinedScore = Math.max(0.5, messageValueAssessment.combinedScore);
      messageValueAssessment.reasons = [...new Set([...(messageValueAssessment.reasons || []), "recent-bot-reply"] )];
      console.log(`[群消息价值] group=${groupId} bypass=recent-bot-reply auto=ai-followup text=${JSON.stringify(scoreText.slice(0, 80))}`);
    } else if (hasImageForAutoTalk) {
      // 图片不送入文本嵌入；直接唤醒 AI 判断，只有需要看图时才调用图片工具.
      messageValueAssessment = {
        text: scoreText,
        eligible: true,
        filterReason: null,
        ruleScore: 1,
        reasons: ["image-bypass"],
        isBotNameCall: false,
        combinedScore: 1,
        highValue: true,
        bypass: true,
      };
      console.log(`[群消息价值] group=${groupId} mode=${RUNTIME_CONFIG.valueScoreMode} bypass=image auto=yes`);
    } else if (RUNTIME_CONFIG.valueScoreMode !== "off" && scoreText) {
      const ruleResult = evaluateMessageValue(scoreText, botName);
      if (!ruleResult.eligible) {
        messageValueAssessment = combineMessageValue(ruleResult, null);
        blockedByValueScore = RUNTIME_CONFIG.valueScoreMode === "block";
        console.log(`[群消息价值] group=${groupId} filter=${ruleResult.filterReason || "low-signal"} auto=no text=${JSON.stringify(scoreText.slice(0, 80))}`);
      } else {
        const valueResult = await scoreMessage(scoreText, RUNTIME_CONFIG.valueScoreMode);
        messageValueAssessment = combineMessageValue(ruleResult, valueResult);
        const confidentVector = !valueResult.lowConfidence && Number.isFinite(valueResult.topSimilarity) && Number.isFinite(valueResult.score);
        blockedByValueScore = RUNTIME_CONFIG.valueScoreMode === "block" && Boolean(valueResult.blocked) && confidentVector && messageValueAssessment.combinedScore < RUNTIME_CONFIG.autoChimeScoreThreshold;
        const vectorText = Number.isFinite(valueResult.score) ? valueResult.score.toFixed(3) : "—";
        const combinedText = Number.isFinite(messageValueAssessment.combinedScore) ? messageValueAssessment.combinedScore.toFixed(3) : "—";
        const ruleText = Number.isFinite(messageValueAssessment.ruleScore) ? messageValueAssessment.ruleScore.toFixed(3) : "—";
        const topValue = Number.isFinite(valueResult.topSimilarity) ? valueResult.topSimilarity.toFixed(3) : "—";
        console.log(`[群消息价值] group=${groupId} mode=${RUNTIME_CONFIG.valueScoreMode} vector=${vectorText} rule=${ruleText} combined=${combinedText} top=${topValue} reasons=${messageValueAssessment.reasons.join(",") || "none"} auto=${messageValueAssessment.highValue ? "yes" : "no"} ${blockedByValueScore ? "blocked" : "allowed"}`);
      }
    }
  }
  aiCandidateAssessment = shouldAskAiAboutMessage(userText, {
    recentBotReply: Boolean(recentBotReplyAtMessage),
    vectorHighValue: Boolean(messageValueAssessment?.highValue),
  });

  // ----- 群聊自动接话 / 直接回复判断 -----
  if (isGroup) {
    recordGroupTalkActivity(ws, {
      groupId,
      senderId,
      messageId,
      messageTime,
      selfId,
      botName,
      hasMention: hasAnyMention,
      suppressAutoTalk: isReplyToBot,
      blockedByValue: blockedByValueScore,
      valueScore: messageValueAssessment?.combinedScore ?? null,
      highValue: Boolean(messageValueAssessment?.highValue) && !blockedByValueScore,
      valueReasons: messageValueAssessment?.reasons || evaluateMessageValue(userText, botName).reasons,
      messageText: userText || (hasImageForAutoTalk ? "[群友发送了一张图片]" : userText),
      hasImageForAutoTalk,
      suppressAutoChime: implicitFollowupCandidate,
      aiCandidate: aiCandidateAssessment.candidate && !hasAnyMention && !isReplyToBot,
      suppressMediaAutoTalk: hasUnsupportedAutoMedia,
    });

    if (implicitFollowupCandidate) {
      const followupArgs = {
        groupId,
        senderId: String(senderId),
        messageId,
        selfId: String(selfId),
        botName,
        messageText: userText,
        senderName: String(event.sender?.card || event.sender?.nickname || senderId),
        lastBotText: recentBotReplyAtMessage?.text || "",
        clearGeneration: groupContextGeneration,
        createdAt: Date.now(),
      };
      void performImplicitBotFollowup(ws, followupArgs);
      return;
    }
    if (!isMentioned && !isReplyToBot) return;
  }

  // 只有确定这条消息会被机器人处理时，才检查用户限速。
  // 普通未 @ 机器人的群消息会在这里之前直接结束，不会触发限速提示。
  const rateLimit = checkUserRateLimit(senderId);
  if (!rateLimit.allowed) {
    const rateTargetId = isGroup ? groupId : senderId;
    try {
      await sendUserRateLimitReply(
        ws,
        rateTargetId,
        isGroup,
        senderId,
        rateLimit.type,
      );
    } catch (error) {
      console.error(`[QQ限速] 提示发送失败: ${error.message}`);
    }
    return;
  }

  // ----- 记录最近活跃用户 -----
  const userKey = isGroup
    ? `${groupId}_${String(senderId)}`
    : `private_${String(senderId)}`;
  recentUsers.set(userKey, {
    groupId: isGroup ? groupId : null,
    userId: String(senderId),
  });

  // ----- 引用消息 -----
  if (replyMessageId) {
    const repliedMessage = replyMessageFetched
      ? repliedMessageData
      : await fetchQqMessage(replyMessageId);
    if (repliedMessage) {
      quotedMessageContext = await buildQuotedMessageContext(repliedMessage, {
        selfId,
      });
      const repliedImageSource = extractImageSourceFromMessage(repliedMessage);

      if (!imageSegmentData && !imageContent) {
        const repliedImage = await extractImageFromMessage(repliedMessage);
        if (repliedImage) {
          imageContent = repliedImage;
          imageSourceUrl = repliedImageSource;
        }
      }
    }
  }

  // ----- 当前图片 -----
  if (imageSegmentData && !imageContent) {
    imageContent = await downloadImageReference(imageSegmentData, 10000);
    if (imageContent) {
      saveRecentImageContext({
        isGroup,
        groupId,
        userId: senderId,
        imageContent,
        sourceImageUrl: imageSourceUrl,
        messageId,
        messageTime,
      });
    }
  }

  // ----- 头像 -----
  const avatarKeywords = ["头像", "看头像", "长什么样"];
  if (avatarKeywords.some((kw) => userText.includes(kw))) {
    if (userText.includes("我") || userText.includes("自己")) {
      targetAvatarQq = String(senderId);
    } else if (
      !targetAvatarQq &&
      (userText.includes("你") || userText.includes("猫娘"))
    ) {
      targetAvatarQq = String(selfId);
    }

    if (targetAvatarQq && !imageContent && !isBlacklisted(targetAvatarQq)) {
      const avatarUrl = getUserAvatarUrl(targetAvatarQq);
      try {
        imageSourceUrl = avatarUrl;
        imageContent = await downloadImageAsBase64(avatarUrl, 3000);
      } catch (error) {
        console.error(`[QQ] 头像下载失败: ${error.message}`);
      }
    }
  }

  // ----- 最近图片视觉上下文 -----
  let recentImageContext = null;
  if (!imageContent) {
    recentImageContext = getRecentImageContext({
      isGroup,
      groupId,
      userId: senderId,
      currentMessageId: messageId,
    });

    if (recentImageContext) {
      imageContent = recentImageContext.imageContent;
      imageSourceUrl = recentImageContext.sourceImageUrl || null;
    }
  }

  // ----- 空消息 -----
  if (!userText && !imageContent && !quotedMessageContext) {
    if (isMentioned) {
      const emptyAtPrompt = isOwner
        ? "[事件] 主人@了你但未发言。亲切回应"
        : "[事件] 对方@了你但未发言。自然回应";

      const res = await coreProcessChat(sessionId, emptyAtPrompt, undefined, {
        isOwner,
        isGroup,
        userId: String(senderId),
        botId: String(selfId),
        botName,
        searchText: null,
      });
      if (onCoreComplete) await onCoreComplete();

      if (res?.type === "text")
        await sendAiTextMessages(ws, targetId, isGroup, res.content, res.mentionQqs);
    }
    return;
  }

  // ----- 群聊历史 -----
  let groupContextPrompt = "";
  if (isGroup) {
    groupContextPrompt = await fetchGroupHistory(groupId, messageId, selfId);
  }

  // ----- 构造 AI 上下文 -----
  const contextParts = [];
  if (groupContextPrompt) contextParts.push(groupContextPrompt);
  if (quotedMessageContext) contextParts.push(quotedMessageContext);

  if (recentImageContext && !replyMessageId) {
    contextParts.push(
      "[最近图片：仅在与当前消息相关时使用，否则忽略。]",
    );
  }

  if (imageContent && !recentImageContext && !replyMessageId) {
    contextParts.push("[当前图片：结合当前消息判断是否需要分析。]");
  }

  const contextPrompt = contextParts.join("\n");
  const finalPrompt =
    isReplyToBot && !userText.trim()
      ? "[群友引用了你（机器人）之前的消息，请结合引用内容自然回应。]"
      : userText;

  console.log(
    `[QQ] 收到 msg=${messageId ?? "?"} 群=${isGroup ? groupId : "私聊"} 用户=${senderId} 主人=${isOwner} 图=${Boolean(imageContent)} 引用=${Boolean(replyMessageId)} 长度=${finalPrompt.length}`,
  );

  // ----- 调用 Core -----
  beginUserApiRequest(senderId);
  let res;
  try {
    const historyQuotePrefix = quotedMessageContext
      ? `${quotedMessageContext}\n`
      : "";
    const cleanUserHistoryEntry = imageContent
      ? `${historyQuotePrefix}${recentImageContext ? "[本轮引用了最近图片上下文]" : "[当前用户发送了一张图片]"}${finalPrompt ? `\n${finalPrompt}` : ""}`
      : `${historyQuotePrefix}${finalPrompt}`;

    res = await coreProcessChat(sessionId, finalPrompt, imageContent, {
      isOwner,
      isGroup,
      userId: String(senderId),
      botId: String(selfId),
      botName,
      searchText: userText || null,
      thinkingText: finalPrompt,
      imageSourceUrl,
      contextPrompt,
      historyTextEntry: cleanUserHistoryEntry,
      contextKey: isGroup ? `group:${String(groupId)}` : null,
      isContextCurrent: () => !isGroup || getGroupHistoryGeneration(groupId) === groupContextGeneration,

      onThinkingStart: async () => {
      console.log(`[QQ] 开始思考 session=${sessionId}`);
      if (isGroup) await sendQqMsg(ws, targetId, true, "让我想想…");
    },

    onImageReady: async (image) => {
      await sendQqMsg(
        ws,
        targetId,
        isGroup,
        "好了喵",
        image.img_url,
        IMAGE_SOURCE.GENERATED,
      );
    },

    onImageError: async ({ error }) => {
      console.error(`[QQ图片] 后台失败: ${error?.message || error}`);
      try {
        await sendQqMsg(
          ws,
          targetId,
          isGroup,
          "唔……图片生成失败了，这次没画出来喵。",
        );
      } catch (sendError) {
        console.error(`[QQ图片] 通知发送失败: ${sendError.message}`);
      }
    },

    onVideoReady: async (video) => {
      await sendQqMsg(ws, targetId, isGroup, "好了喵");
      const sent = await sendQqVideo(ws, targetId, isGroup, video.video_url);
      if (!sent) console.error(`[QQ视频] 主动发送失败 video=${video.video_id}`);
    },

    onVideoError: async ({ error, userMessage }) => {
      console.error(`[QQ视频] 后台失败: ${error?.message || error}`);
      try {
        await sendQqMsg(
          ws,
          targetId,
          isGroup,
          userMessage || "视频服务刚刚出了点小状况，这次没生成出来喵。",
        );
      } catch (sendError) {
        console.error(`[QQ视频] 通知发送失败: ${sendError.message}`);
      }
    },

    onPokeUser: async (userId) => {
      return await sendQqPoke(ws, userId, groupId);
    },
  });
    if (onCoreComplete) await onCoreComplete();
  } finally {
    endUserApiRequest(senderId);
  }

  if (
    getBotClearGeneration(sessionId) !== responseClearGeneration ||
    (isGroup && getGroupHistoryGeneration(groupId) !== groupContextGeneration)
  ) {
    res = { type: "cleared", content: "" };
  }

  // ----- 输出处理 -----
  if (res?.type === "multi_text_pending") {
    const messages = Array.isArray(res.messages) ? res.messages : [];
    const mentions = Array.isArray(res.mentionQqs) ? res.mentionQqs : [];

    console.log(`[QQ] 发送多条消息 count=${messages.length} target=${targetId}`);

    for (let i = 0; i < messages.length; i++) {
      const message = String(messages[i] ?? "").trim();
      if (!message) continue;

      try {
        // 每一条仍经过特殊内容解析；真实 @ 只附加到第一条有效消息。
        await sendAiTextMessages(
          ws,
          targetId,
          isGroup,
          message,
          i === 0 ? mentions : [],
          i === 0 ? res.quoteMessageId : null,
        );
      } catch (error) {
        console.error(`[QQ] 多条消息发送失败 index=${i + 1}/${messages.length}: ${error.message}`);
      }

      if (i < messages.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
  } else if (res?.type === "text" || res?.type === "video_pending" || res?.type === "image_pending") {
    await sendAiTextMessages(
      ws,
      targetId,
      isGroup,
      res.content || "",
      Array.isArray(res.mentionQqs) ? res.mentionQqs : [],
      res.quoteMessageId,
    );
  }
}

// ===== WebSocket 工具 =====

function waitForWebSocketOpen(ws) {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }

    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      ws.off("open", onOpen);
      ws.off("error", onError);
    };

    ws.once("open", onOpen);
    ws.once("error", onError);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export {
  handleQqWs,
  sendQqMsg,
  sendQqVideo,
  sendQqPoke,
  sendQqMention,
  sanitizeInput,
  sanitizeOutput,
  messageSegmentsToText,
  downloadImageAsBase64,
  fetchQqMessage,
  buildQuotedMessageContext,
  extractImageFromMessage,
  extractImageSourceFromMessage,
  fetchGroupHistory,
  fetchRecentGroupImage,
  isOwnerQQ,
  isBlacklisted,
  isNoRandomTalkGroup,
};