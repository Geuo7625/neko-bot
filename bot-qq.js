// bot-qq.js
import axios from "axios";
import WebSocket from "ws";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { NAPCAT_WS_URL, NAPCAT_HTTP_URL, NAPCAT_TOKEN, RUNTIME_CONFIG } from "./config.js";
import { coreProcessChat, clearHistory, clearAllHistories, clearContextRequests, AUTO_SKIP_MARKER } from "./core.js";
import { embedText } from "./memory.js";
import { sendSpecialContent } from "./special-content.js";
import { handleControlCommand } from "./control.js";
import { getServerStatus, checkServerStatusRateLimit } from "./server-status.js";
import { IMAGE_SOURCE } from "./image-provenance.js";
import { scoreMessage } from "./value-score.js";
import {
  cleanValueText,
  decide,
  isHardVetoMessage,
  isTechnicalQuestion,
  scoreContent,
  shouldEvaluateMessage,
} from "./message-value.js";

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
const recentUsers = new Map();
const privateTypingCounts = new Map();
const privateTypingTimers = new Map();
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
    fs.writeFileSync(
      GROUP_HISTORY_CLEAR_PATH,
      JSON.stringify({
        globalTime: globalGroupHistoryClearTime,
        groups: Object.fromEntries(groupHistoryClearPoints),
      }),
      "utf8",
    );
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

  if (state.cooldownUntil > now) return { allowed: false, type: "cooldown" };

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
  const text = type === "cooldown" ? "有点累了…让我歇会" : "慢点…我跟不上了";
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
  isGroup, groupId, userId, imageContent,
  sourceImageUrl = null, messageId, messageTime,
}) {
  if (!imageContent) return;
  recentImageContexts.set(getRecentImageContextKey(isGroup, groupId, userId), {
    imageContent,
    sourceImageUrl: sourceImageUrl || null,
    messageId: messageId ?? null,
    messageTime: Number(messageTime || 0),
    senderId: String(userId),
    savedAt: Date.now(),
  });
}

function getRecentImageContext({ isGroup, groupId, userId, currentMessageId = null }) {
  const key = getRecentImageContextKey(isGroup, groupId, userId);
  const context = recentImageContexts.get(key);
  if (!context) return null;
  if (Date.now() - context.savedAt > RECENT_IMAGE_CONTEXT_TTL_MS) {
    recentImageContexts.delete(key);
    return null;
  }
  if (
    currentMessageId !== null && currentMessageId !== undefined &&
    context.messageId !== null &&
    String(context.messageId) === String(currentMessageId)
  ) return null;
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
      lastAutoTalkAt: 0, autoTalkTimes: [],
      autoReplyInFlight: false,
      speechVersion: 0,
      messageVectors: [],
      recentSpeech: [],
      willingness: 0,
      lastWillingnessAt: Date.now(),
    };
    groupTalkStates.set(key, state);
  }
  return state;
}

function recordAutoTalk(state, at = Date.now()) {
  state.autoTalkTimes.push(at);
}

function isGroupCoolingDown(state, now = Date.now()) {
  const cooldownMs = Math.max(0, Number(RUNTIME_CONFIG.autoTalkCooldownMs) || 180000);
  const hourlyWindowMs = Math.max(60000, Number(RUNTIME_CONFIG.autoTalkHourlyWindowMs) || 3600000);
  const hourlyLimit = Math.max(1, Number(RUNTIME_CONFIG.autoTalkHourlyLimit) || 3);
  state.autoTalkTimes = state.autoTalkTimes.filter((at) => now - at < hourlyWindowMs);
  return state.autoReplyInFlight ||
    now - state.lastAutoTalkAt < cooldownMs ||
    state.autoTalkTimes.length >= hourlyLimit;
}

function decayWillingness(state, now = Date.now()) {
  const interval = Math.max(1, Number(RUNTIME_CONFIG.willingnessDecayIntervalMs) || 15000);
  const elapsedIntervals = Math.floor((now - state.lastWillingnessAt) / interval);
  if (elapsedIntervals <= 0) return;
  const decay = Math.max(0, Math.min(1, Number(RUNTIME_CONFIG.willingnessDecayFactor) || 0.9));
  state.willingness *= decay ** elapsedIntervals;
  state.lastWillingnessAt += elapsedIntervals * interval;
}

setInterval(() => {
  const now = Date.now();
  for (const state of groupTalkStates.values()) {
    const before = state.willingness;
    decayWillingness(state, now);
    if (before !== state.willingness) console.log(`[群聊意愿] willingness=${state.willingness.toFixed(3)}`);
  }
}, Math.max(1000, Number(RUNTIME_CONFIG.willingnessDecayIntervalMs) || 15000));

function updateGroupWillingness(groupId, { mentionedBot = false, pureSticker = false } = {}) {
  const state = getGroupTalkState(groupId);
  const now = Date.now();
  decayWillingness(state, now);
  if (mentionedBot) {
    state.willingness += Number(RUNTIME_CONFIG.willingnessMentionGain) || 0.9;
  } else if (pureSticker) {
    state.willingness *= Math.max(0, Math.min(1, Number(RUNTIME_CONFIG.willingnessStickerMultiplier) || 0.35));
  } else {
    state.willingness += Number(RUNTIME_CONFIG.willingnessMessageGain) || 0.1;
  }
  state.willingness = Math.min(Number(RUNTIME_CONFIG.willingnessMax) || 3, Math.max(0, state.willingness));
  return state;
}

function noteGroupBotSpeech(groupId) {
  if (groupId === null || groupId === undefined) return;
  const state = getGroupTalkState(groupId);
  const now = Date.now();
  decayWillingness(state, now);
  state.willingness = Math.max(0, state.willingness - (Number(RUNTIME_CONFIG.willingnessReplyPenalty) || 2));
  state.lastAutoTalkAt = now;
  state.speechVersion++;
  state.recentSpeech.push({ at: now, isBot: true });
  const presenceWindowMs = Math.max(10000, Number(RUNTIME_CONFIG.autoPresenceWindowMs) || 300000);
  state.recentSpeech = state.recentSpeech.filter((entry) => now - entry.at <= presenceWindowMs);
}

function isPureStickerMessage(segments, text) {
  const content = String(text ?? "").trim();
  const textSegments = segments.filter((segment) => segment?.type === "text");
  const visibleText = textSegments.map((segment) => String(segment?.data?.text ?? "")).join("").trim();
  // 含文字或数字的消息不是纯表情包。
  if (/[\p{L}\p{N}]/u.test(visibleText)) return false;
  const hasSticker = segments.some((segment) => ["face", "mface"].includes(segment?.type));
  // QQ 表情段或只有图形 emoji 的文本按纯表情消息衰减意愿。
  return hasSticker || (content.length > 0 && /\p{Extended_Pictographic}/u.test(content) && !/[\p{L}\p{N}]/u.test(content));
}

function isRepeatedSpam(state, senderId, text, now = Date.now()) {
  const normalized = cleanValueText(text).toLocaleLowerCase();
  if (!normalized) return false;
  const windowMs = Math.max(1000, Number(RUNTIME_CONFIG.autoSpamWindowMs) || 60000);
  const repeatCount = Math.max(2, Number(RUNTIME_CONFIG.autoSpamRepeatCount) || 3);
  state.messages = state.messages.filter((item) => now - item.at <= windowMs);
  return state.messages.filter((item) => item.userId === String(senderId) && item.text === normalized).length + 1 >= repeatCount;
}

function rememberGroupMessage(state, senderId, text, vector = null, now = Date.now()) {
  state.recentSpeech.push({ at: now, isBot: false });
  const presenceWindowMs = Math.max(10000, Number(RUNTIME_CONFIG.autoPresenceWindowMs) || 300000);
  state.recentSpeech = state.recentSpeech.filter((entry) => now - entry.at <= presenceWindowMs);
  const normalized = cleanValueText(text).toLocaleLowerCase();
  if (!normalized) return;
  state.messages.push({ at: now, userId: String(senderId), text: normalized });
  const windowMs = Math.max(1000, Number(RUNTIME_CONFIG.autoSpamWindowMs) || 60000);
  state.messages = state.messages.filter((item) => now - item.at <= windowMs);
  if (vector?.length) {
    state.messageVectors.push({ at: now, vector });
    const maxVectors = Math.max(1, Number(RUNTIME_CONFIG.autoTopicRecentMessageCount) || 5);
    state.messageVectors = state.messageVectors.slice(-maxVectors);
  }
}

function scoreTopicContinuity(vector, history) {
  if (!vector?.length || !history.length) return 0;
  const mean = Array.from({ length: vector.length }, (_, index) =>
    history.reduce((sum, item) => sum + (Number(item.vector[index]) || 0), 0) / history.length,
  );
  const dot = vector.reduce((sum, value, index) => sum + value * mean[index], 0);
  const vectorNorm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  const meanNorm = Math.sqrt(mean.reduce((sum, value) => sum + value * value, 0));
  if (!vectorNorm || !meanNorm) return 0;
  return Math.max(0, Math.min(1, dot / (vectorNorm * meanNorm)));
}

async function generateAutoReply(ws, {
  groupId, selfId, botName, senderId, messageId, text, score, valueResult, clearGeneration,
}) {
  const state = getGroupTalkState(groupId);
  const speechVersion = state.speechVersion;
  try {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const groupContext = await fetchGroupHistory(groupId, messageId, selfId, false);
    if (getGroupHistoryGeneration(groupId) !== clearGeneration) return;
    if (state.speechVersion !== speechVersion) return;
    const contextPrompt = `${groupContext}\n你是群里的普通聊天成员。专业或技术问题、需要严谨知识的问题、与当前话题无关的内容，或回复可能答错、添乱、打断交流时，只输出${AUTO_SKIP_MARKER}。轻松玩笑和日常闲聊可以自然接梗；其他情况下结合当前消息口语化回复，最多40字，不要@任何人。`;
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
        allowTools: false,
        autoSkipMarker: true,
        requestPriority: "auto",
        isContextCurrent: () => getGroupHistoryGeneration(groupId) === clearGeneration,
        historyTextEntry: text,
      },
    );
    if (getGroupHistoryGeneration(groupId) !== clearGeneration) return;
    if (state.speechVersion !== speechVersion) return;
    if (result?.type === "skipped") {
      const triggerText = Array.from(String(text ?? "")).slice(0, 60).join("");
      console.log(`[群聊自动] skip group=${groupId} score=${score.toFixed(3)} text=${JSON.stringify(triggerText)}`);
      return;
    }
    if (result?.type !== "text" || !String(result.content ?? "").trim()) return;
    const reply = Array.from(String(result.content).trim())
      .slice(0, Math.max(1, Number(RUNTIME_CONFIG.autoReplyMaxChars) || 40))
      .join("");
    if (!reply || reply.includes(AUTO_SKIP_MARKER)) return;
    await sendAiTextMessages(ws, groupId, true, reply, [], { trackGroupSpeech: true });
    recordAutoTalk(state, Date.now());
    const triggerText = Array.from(String(text ?? "")).slice(0, 60).join("");
    console.log(`[群聊自动] sent group=${groupId} vector=${Number.isFinite(valueResult?.score) ? valueResult.score.toFixed(3) : "—"} willingness=${state.willingness.toFixed(3)} score=${score.toFixed(3)} text=${JSON.stringify(triggerText)}`);
  } catch (error) {
    console.error(`[群聊自动] 失败 group=${groupId}: ${error.message}`);
  } finally {
    state.autoReplyInFlight = false;
  }
}

// ===== HTTP =====
const httpClient = axios.create({ timeout: 5000 });

// ===== 配置 =====
function normalizeBotConfig(config) {
  const source = config && typeof config === "object" ? config : {};
  const sensitiveWords =
    source.sensitiveWords && typeof source.sensitiveWords === "object"
      ? source.sensitiveWords : {};

  return {
    ownerQQ: source.ownerQQ !== undefined ? String(source.ownerQQ) : "",
    nickname: source.nickname !== undefined ? String(source.nickname) : "Yuragi",
    blacklistQQ: Array.isArray(source.blacklistQQ) ? source.blacklistQQ.map(String) : [],
    noRandomTalkGroups: Array.isArray(source.noRandomTalkGroups)
      ? source.noRandomTalkGroups.map(String) : [],
    groupWhitelist: Array.isArray(source.groupWhitelist)
      ? [...new Set(source.groupWhitelist.map((id) => String(id).trim()).filter(Boolean))] : [],
    userWhitelist: Array.isArray(source.userWhitelist)
      ? [...new Set(source.userWhitelist.map((id) => String(id).trim()).filter(Boolean))] : [],
    sensitiveWords: {
      input: Array.isArray(sensitiveWords.input) ? sensitiveWords.input.map(String).filter(Boolean) : [],
      output: Array.isArray(sensitiveWords.output) ? sensitiveWords.output.map(String).filter(Boolean) : [],
    },
  };
}

function loadBotConfig() {
  try {
    return normalizeBotConfig(JSON.parse(fs.readFileSync(BOT_CONFIG_PATH, "utf8")));
  } catch (error) {
    throw new Error(`配置文件读取或解析失败: ${error.message}`);
  }
}

function getConfigMtime() {
  try { return fs.statSync(BOT_CONFIG_PATH).mtimeMs; } catch { return 0; }
}

function reloadBotConfigIfChanged() {
  const currentMtime = getConfigMtime();
  if (currentMtime === 0 || currentMtime === botConfigMtime) return;
  try {
    botConfig = loadBotConfig();
    botConfigMtime = currentMtime;
    for (const [key, info] of recentUsers) {
      if (isBlacklisted(info.userId) || !isAllowedByWhitelist(info.userId, info.groupId)) {
        recentUsers.delete(key);
      }
    }
    console.log("[配置] 已重新加载");
  } catch (error) {
    console.error(`[配置] 热加载失败，沿用旧配置: ${error.message}`);
  }
}

fs.watchFile(BOT_CONFIG_PATH, { interval: 1000 }, () => reloadBotConfigIfChanged());

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
function isAllowedByWhitelist(userId, groupId = null) {
  const config = getBotConfig();
  const groupAllowed = groupId === null || groupId === undefined ||
    config.groupWhitelist.length === 0 || config.groupWhitelist.includes(String(groupId));
  const userAllowed = config.userWhitelist.length === 0 || config.userWhitelist.includes(String(userId));
  return groupAllowed && userAllowed;
}
function isNoRandomTalkGroup(groupId) {
  if (groupId === null || groupId === undefined) return false;
  return getBotConfig().noRandomTalkGroups.includes(String(groupId));
}

// ===== 敏感词 =====
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeText(text, sensitiveWords) {
  if (!text || !Array.isArray(sensitiveWords) || sensitiveWords.length === 0) return text || "";
  for (const word of sensitiveWords) {
    if (!word) continue;
    const pattern = [...word].map((char) => escapeRegExp(char)).join("\\s*");
    text = text.replace(new RegExp(pattern, "gi"), "");
  }
  return text.trim();
}

function sanitizeInput(text) { return sanitizeText(text, getBotConfig().sensitiveWords.input); }
function sanitizeOutput(text) { return sanitizeText(text, getBotConfig().sensitiveWords.output); }

function containsBotNameCall(text) {
  const source = String(text ?? "");
  if (!source) return false;
  const names = [...new Set(["Yuragi", getBotConfig().nickname]
    .map((name) => String(name ?? "").trim())
    .filter(Boolean))];
  return names.some((name) => {
    const pattern = [...name].map(escapeRegExp).join("[\\s._-]*");
    return new RegExp(`(^|[^a-z0-9_])${pattern}(?=$|[^a-z0-9_])`, "i").test(source);
  });
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
    state.messages = [];
    state.messageVectors = [];
    state.recentSpeech = [];
    state.willingness = 0;
    state.lastWillingnessAt = Date.now();
  }
}

function clearAllGroupHistory(time) {
  globalGroupHistoryClearTime = Number(time) || 0;
  globalGroupHistoryClearVersion++;
  groupHistoryClearPoints.clear();
  groupHistoryClearVersions.clear();
  saveGroupHistoryClearState();
  for (const state of groupTalkStates.values()) {
    state.messages = [];
    state.messageVectors = [];
    state.recentSpeech = [];
    state.willingness = 0;
    state.lastWillingnessAt = Date.now();
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
    if (isGroup) clearGroupHistory(groupId, messageTime);
    else recentImageContexts.delete(getRecentImageContextKey(false, null, sessionId.replace(/^qq_/, "")));
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
    setTimeout(() => { console.log("[控制] 主重启，进程退出"); process.exit(0); }, 1000);
    return "…";
  }
  return null;
}

// ===== QQ 消息段 =====
function buildQqTextSegments(text) {
  const value = String(text || "");
  return value ? [{ type: "text", data: { text: value } }] : [];
}

async function sendQqMsg(ws, targetId, isGroup, text = null, imgUrl = null, imageSource = null, mentionQqs = []) {
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
    if (result) {
      if (isGroup) noteGroupBotSpeech(targetId);
      return true;
    }
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error("NapCat WebSocket 当前未连接");
  }
  ws.send(JSON.stringify({ action, params }));
  if (isGroup) noteGroupBotSpeech(targetId);
  return true;
}

async function sendAiTextMessages(ws, targetId, isGroup, text, mentionQqs = [], { trackGroupSpeech = false } = {}) {
  const message = sanitizeOutput(String(text ?? ""));
  if (!message) return;
  const mentions = isGroup && Array.isArray(mentionQqs)
    ? [...new Set(mentionQqs
        .map((value) => String(value ?? "").trim())
        .filter((value) => value === "all" || /^\d{5,12}$/.test(value)))]
    : [];
  // 特殊内容模块负责按 ===SPLIT=== 拆分，并将首个真实 @ 与正文放进同一条消息。
  await sendSpecialContent(targetId, isGroup, message, mentions);
  if (trackGroupSpeech && isGroup) noteGroupBotSpeech(targetId);
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
    try { ws.send(JSON.stringify({ action: "send_group_msg", params })); return true; }
    catch (error) { console.error(`[QQ@] WS 发送失败: ${error.message}`); }
  }
  console.error(`[QQ@] HTTP/WS 均无法发送 @ -> ${qq}`);
  return false;
}

// ===== NapCat 私聊输入状态 =====
// NapCat 语义：event_type = 1 → “正在输入中”；event_type = 0 → “正在说话”。
// 处理期间：开始前发一次 1，之后每 4 秒重发一次 1 维持状态；
// 处理结束不发 0（否则会先闪一下“正在说话”），由真正发出的消息让 QQ 自动清掉状态。
const PRIVATE_TYPING_HEARTBEAT_MS = 4000;

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

function startPrivateTypingHeartbeat(userId) {
  const key = String(userId);
  const existing = privateTypingTimers.get(key);
  if (existing) clearInterval(existing);
  const timer = setInterval(() => { void setPrivateTypingStatus(userId, true); }, PRIVATE_TYPING_HEARTBEAT_MS);
  privateTypingTimers.set(key, timer);
}

function stopPrivateTypingHeartbeat(userId) {
  const key = String(userId);
  const timer = privateTypingTimers.get(key);
  if (timer) { clearInterval(timer); privateTypingTimers.delete(key); }
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
        `NapCat retcode=${result.retcode}` + (result.message ? `: ${result.message}` : ""),
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
  if (!videoUrl) { console.error("[QQ视频] URL 为空，无法发送"); return false; }
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
    try { ws.send(JSON.stringify({ action, params })); return true; }
    catch (error) { console.error(`[QQ视频] WS 发送失败: ${error.message}`); }
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
    .replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function compactContextText(value, maxLength = 500) {
  const text = decodeMarkupEntities(String(value ?? ""))
    .replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ")
    .replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
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
  try { return JSON.parse(text); } catch { return null; }
}

function extractStructuredFields(value, options = {}) {
  const fields = [];
  const seenValues = new Set();
  const maxFields = options.maxFields ?? 10;
  const maxDepth = options.maxDepth ?? 5;

  function add(label, raw) {
    if (raw === null || raw === undefined || typeof raw === "object") return;
    const valueText = compactContextText(
      raw,
      label === "链接" || label === "跳转链接" || label === "分享链接" ? 350 : 220,
    );
    if (!valueText || seenValues.has(`${label}:${valueText}`)) return;
    seenValues.add(`${label}:${valueText}`);
    fields.push(`${label}：${valueText}`);
  }

  function visit(item, depth = 0) {
    if (item === null || item === undefined || depth > maxDepth || fields.length >= maxFields) return;
    if (typeof item === "string") {
      const parsed = parseJsonMaybe(item);
      if (parsed) { visit(parsed, depth + 1); return; }
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
    if (segType === "text") { if (data.text) parts.push(data.text); }
    else if (segType === "at") {
      const qq = data.qq;
      if (qq === "all") parts.push("@全体成员");
      else if (qq) parts.push(`@${qq}`);
    } else if (segType === "image") parts.push("[图片]");
    else if (segType === "face") parts.push(data.id ? `[QQ表情:${data.id}]` : "[QQ表情]");
    else if (segType === "reply") parts.push(data.id ? `[回复消息:${data.id}]` : "[回复]");
    else if (["share", "json", "xml", "card"].includes(segType)) parts.push(summarizeSpecialSegment(segType, data));
    else if (segType === "forward") parts.push("[聊天记录/合并转发消息（引用后可展开读取）]");
    else parts.push(`[${segType || "未知消息"}]`);
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
    if (type === "text") { if (data.text) parts.push(data.text); }
    else if (type === "at") parts.push(data.qq === "all" ? "@全体成员" : data.qq ? `@${data.qq}` : "[@用户]");
    else if (type === "image") parts.push("[图片]");
    else if (type === "face") parts.push(data.id ? `[QQ表情:${data.id}]` : "[QQ表情]");
    else if (type === "reply") parts.push(data.id ? `[回复消息:${data.id}]` : "[回复]");
    else if (type === "forward") parts.push(await summarizeForwardSegment(data, depth));
    else if (["share", "json", "xml", "card"].includes(type)) parts.push(summarizeSpecialSegment(type, data));
    else if (type) parts.push(`[${type}消息]`);
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
      try { localPath = fileURLToPath(source); } catch { localPath = null; }
    } else if (path.isAbsolute(source)) {
      localPath = source;
    }
    if (localPath && fs.existsSync(localPath)) {
      const buffer = await fs.promises.readFile(localPath);
      if (!buffer.length) return null;
      return `data:${getImageMimeType(localPath)};base64,${buffer.toString("base64")}`;
    }
    if (!/^https?:\/\//i.test(source)) return null;

    const response = await httpClient.get(source, {
      timeout, responseType: "arraybuffer",
      maxContentLength: 15 * 1024 * 1024,
      maxBodyLength: 15 * 1024 * 1024,
      headers: { Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8" },
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
    return data && typeof data === "object" ? data : null;
  } catch (error) {
    console.error(`[QQ引用] 获取消息异常: ${error.message}`);
    return null;
  }
}

async function buildQuotedMessageContext(message, { selfId = null } = {}) {
  if (!message || typeof message !== "object") return "";
  const senderId = String(message.user_id ?? "未知");
  const sender = message.sender && typeof message.sender === "object" ? message.sender : {};
  const isSelf = selfId !== null && selfId !== undefined && senderId === String(selfId);
  const senderName = sender.card || sender.nickname || senderId;
  const label = isSelf ? "你（机器人）" : `群友「${senderName}」`;
  const text = await messageSegmentsToTextAsync(message.message || []);
  const hasImage = Array.isArray(message.message) && message.message.some((seg) => seg?.type === "image");
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
  const data = result?.data && typeof result.data === "object" ? result.data : result;
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
async function fetchGroupHistory(groupId, currentMessageId = null, selfId = null, includeImageToolHints = false) {
  if (!NAPCAT_HTTP_URL || !NAPCAT_TOKEN) return "";
  const url = NAPCAT_HTTP_URL.replace(/\/+$/, "") + "/get_group_msg_history";
  try {
    const response = await httpClient.post(
      url,
      { group_id: groupId, count: 20, message_seq: 0 },
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
    if (data && typeof data === "object" && !Array.isArray(data)) msgs = data.messages || [];
    else if (Array.isArray(data)) msgs = data;
    if (!msgs.length) return "";

    const clearTime = getGroupHistoryClearTime(groupId);
    const formattedMsgs = [];

    for (const m of msgs) {
      if (!m || typeof m !== "object") continue;
      if (currentMessageId !== null && currentMessageId !== undefined &&
          String(m.message_id) === String(currentMessageId)) continue;
      if (clearTime > 0 && Number(m.time || 0) <= clearTime) continue;
      if (isBlacklisted(m.user_id)) continue;
      if (Array.isArray(m.message) && m.message.some((seg) => ["video", "record"].includes(seg?.type))) continue;
      const hasImage = Array.isArray(m.message) && m.message.some((seg) => seg?.type === "image");

      const sender = m.sender && typeof m.sender === "object" ? m.sender : {};
      const senderId = String(m.user_id ?? "未知");
      const isSelf = selfId !== null && selfId !== undefined && senderId === String(selfId);
      const sName = sender.card || sender.nickname || senderId;

      let rawTxt = (await messageSegmentsToTextAsync(m.message || [])).trim();
      if (!rawTxt) continue;
      let cleanRaw = sanitizeInput(rawTxt);
      if (!cleanRaw) continue;

      cleanRaw = annotateStructuredMessageText(cleanRaw);
      const isStructured = /【结构化消息类型：/.test(cleanRaw);
      cleanRaw = cleanRaw.slice(0, isStructured ? 500 : 100);
      const imageHint = hasImage && includeImageToolHints
        ? ` [含图片；可按需调用 get_recent_group_image，message_id=${String(m.message_id)}]`
        : hasImage ? " [含图片]" : "";
      formattedMsgs.push(
        isSelf
          ? `你（机器人） [QQ:${senderId}]: ${cleanRaw}${imageHint}`
          : `群友「${sName}」 [QQ:${senderId}]: ${cleanRaw}${imageHint}`,
      );
    }

    if (!formattedMsgs.length) return "";
    const finalMsgs = formattedMsgs.slice(-20);
    return "\n[群聊历史，仅供上下文参考]\n" + finalMsgs.join("\n") + "\n";
  } catch (error) {
    console.error(`[QQ历史] 获取群历史异常: ${error.message}`);
    return "";
  }
}

// 自动接话只有在模型主动调用工具时才下载图片；只允许访问最近 20 条、未被清除的群消息。
async function fetchRecentGroupImage(groupId, requestedMessageId = null) {
  if (!NAPCAT_HTTP_URL || !NAPCAT_TOKEN || groupId === null || groupId === undefined) return null;
  const url = NAPCAT_HTTP_URL.replace(/\/+$/, "") + "/get_group_msg_history";
  try {
    const response = await httpClient.post(
      url,
      { group_id: groupId, count: 20, message_seq: 0 },
      {
        headers: {
          Authorization: `Bearer ${NAPCAT_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 4000,
      },
    );
    const result = response?.data;
    if (response.status !== 200 ||
        (result?.status !== undefined && result.status !== "ok") ||
        (result?.retcode ?? 0) !== 0) return null;

    const data = result.data;
    const messages = data && typeof data === "object" && !Array.isArray(data)
      ? data.messages || [] : Array.isArray(data) ? data : [];
    const clearTime = getGroupHistoryClearTime(groupId);
    const candidates = messages
      .filter((item) => {
        if (!item || typeof item !== "object") return false;
        if (clearTime > 0 && Number(item.time || 0) <= clearTime) return false;
        if (isBlacklisted(item.user_id)) return false;
        if (item.group_id !== undefined && String(item.group_id) !== String(groupId)) return false;
        if (!Array.isArray(item.message) || !item.message.some((seg) => seg?.type === "image")) return false;
        return requestedMessageId === null || requestedMessageId === undefined ||
          String(item.message_id) === String(requestedMessageId);
      })
      .sort((a, b) => Number(b.time || 0) - Number(a.time || 0));
    const message = candidates[0];
    if (!message) return null;
    const imageContent = await extractImageFromMessage(message);
    if (!imageContent) return null;
    const sender = message.sender && typeof message.sender === "object" ? message.sender : {};
    const text = (await messageSegmentsToTextAsync(message.message || [])).replace(/\[图片\]/g, "").trim();
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
    let timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => { cleanup(); resolve(); };
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
        if (!pokeController.signal.aborted) console.error("[主动戳戳] 崩溃:", error);
      });

      await new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => { ws.off("close", onClose); ws.off("error", onError); };
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
      if (pokeController) { pokeController.abort(); pokeController = null; }
      if (ws && ws.readyState !== WebSocket.CLOSED) {
        try { ws.close(); } catch {}
      }
    }
    await sleep(5000);
  }
}

// ===== QQ 事件分发 =====
async function handleQqEvent(ws, event) {
  const isPrivateMessage = event?.post_type === "message" && event?.message_type === "private";
  const userId = event?.user_id;
  if (
    !isPrivateMessage ||
    isBlacklisted(userId) ||
    !isAllowedByWhitelist(userId) ||
    String(userId) === String(event?.self_id)
  ) {
    return handleQqEventInternal(ws, event);
  }

  const key = String(userId);
  const count = privateTypingCounts.get(key) || 0;
  privateTypingCounts.set(key, count + 1);
  if (count === 0) {
    await setPrivateTypingStatus(userId, true);
    startPrivateTypingHeartbeat(userId);
  }
  try {
    return await handleQqEventInternal(ws, event);
  } finally {
    const remaining = Math.max(0, (privateTypingCounts.get(key) || 1) - 1);
    if (remaining === 0) {
      privateTypingCounts.delete(key);
      stopPrivateTypingHeartbeat(userId);
      // 不发送停止信号：NapCat 的 event_type=0 会显示成“正在说话”，
      // 而机器人真正发出消息后，QQ 会自动清除“正在输入中”状态。
    } else {
      privateTypingCounts.set(key, remaining);
    }
  }
}

async function handleQqEventInternal(ws, event) {
  const postType = event?.post_type;
  if (
    (postType === "message" || postType === "notice") &&
    !isAllowedByWhitelist(event?.user_id, event?.group_id)
  ) {
    console.log(`[白名单] 已拒绝 user=${event?.user_id ?? "unknown"} group=${event?.group_id ?? "private"}`);
    return;
  }
  const botName = getBotConfig().nickname;

  // ----- Notice 分支 -----
  if (postType === "notice") {
    const noticeType = event.notice_type;
    const subType = event.sub_type;
    const targetId = event.target_id;
    const senderId = event.user_id;
    const groupId = event.group_id;
    const selfId = event.self_id;

    if (noticeType === "notify" && subType === "poke" && String(targetId) === String(selfId)) {
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
        isOwner, isGroup,
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
  let isMentioned = false;
  let isAtAll = false;
  let hasAnyMention = false;
  let targetAvatarQq = null;
  let replyMessageId = null;
  let quotedMessageContext = "";
  let repliedMessageData = null;
  let replyMessageFetched = false;
  let isReplyToBot = false;

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
    } else if (segType === "mface") {
      userText += `[QQ商城表情:${segData.summary || segData.key || "QQ商城表情"}]`;
    } else if (segType === "dice") {
      userText += `[骰子:${segData.result ?? "未知"}]`;
    } else if (segType === "rps") {
      userText += `[石头剪刀布:${segData.result ?? "未知"}]`;
    } else if (segType === "record") {
      userText += "[语音消息]";
    } else if (segType === "video") {
      userText += "[视频消息]";
    } else if (segType === "file") {
      userText += "[文件消息]";
    } else if (segType === "forward") {
      userText += await summarizeForwardSegment(segData);
    } else if (["share", "json", "xml", "card", "markdown"].includes(segType)) {
      userText += summarizeSpecialSegment(segType, segData);
    } else if (segType) {
      userText += `[${segType}消息]`;
    }
  }

  if (!userText.trim() && segments.length) {
    const specialTypes = [...new Set(
      segments
        .map((seg) => (seg && typeof seg === "object" ? String(seg.type || "") : ""))
        .filter((type) => type && !["text", "at", "image", "reply"].includes(type)),
    )];
    if (specialTypes.length) userText = `[收到特殊QQ消息:${specialTypes.join(",")}]`;
  }

  if (!userText.trim() && event.raw_message) {
    userText = String(event.raw_message).trim() || "[收到一条QQ特殊消息]";
  }

  if (isAtAll) return;

  // 名字触发在输入清洗前后都检查，避免清洗规则删掉称呼后漏判。
  const rawUserText = userText;
  const calledByNameBeforeSanitize = isGroup && containsBotNameCall(userText);
  userText = sanitizeInput(userText);
  if (isGroup && (calledByNameBeforeSanitize || containsBotNameCall(userText))) {
    isMentioned = true;
    hasAnyMention = true;
  }

  // 先读取引用目标，群聊中引用了机器人的发言即使没有 @ 也应触发回复。
  if (replyMessageId) {
    repliedMessageData = await fetchQqMessage(replyMessageId);
    replyMessageFetched = true;
    const quotedSenderId =
      repliedMessageData?.user_id ??
      repliedMessageData?.sender?.user_id ??
      repliedMessageData?.sender?.uin;
    isReplyToBot = quotedSenderId !== null && quotedSenderId !== undefined &&
      String(quotedSenderId) === String(selfId);
  }

  // ----- 控制 / 公开指令 -----
  const controlCommand = handleControlCommand(userText, senderId);

  if (controlCommand?.type === "owner") {
    const controlReply = handleBotControlCommand({
      command: controlCommand, sessionId, groupId, isGroup, messageTime,
    });
    if (controlReply) await sendQqMsg(ws, targetId, isGroup, controlReply);
    return;
  }

  if (controlCommand?.type === "public") {
    if (controlCommand.action === "server_status") {
      const rateLimit = checkServerStatusRateLimit(senderId);
      if (!rateLimit.allowed) {
        const seconds = Math.ceil(rateLimit.remainingMs / 1000);
        await sendQqMsg(ws, targetId, isGroup, `服务器状态查得太频繁啦，${seconds} 秒后再查吧。`);
        return;
      }
      try {
        await sendQqMsg(ws, targetId, isGroup, await getServerStatus());
      } catch (error) {
        console.error(`[服务器状态] 失败: ${error.message}`);
        await sendQqMsg(ws, targetId, isGroup, "唔……服务器状态接口暂时连不上了喵。");
      }
      return;
    }
    return;
  }

  if (controlCommand?.type === "unauthorized") {
    const res = await coreProcessChat(
      sessionId,
      `[系统提示：对方无权执行机器人控制指令「${controlCommand.command}」。委婉拒绝请求，不要声称已执行。]`,
      undefined,
      { isOwner: false, isGroup, userId: String(senderId), botId: String(selfId), botName, searchText: null },
    );
    if (res?.type === "text") {
      await sendAiTextMessages(ws, targetId, isGroup, res.content, res.mentionQqs, { trackGroupSpeech: true });
    }
    return;
  }

  // direct 优先；其他群消息先收集硬否决与上下文信号，再交给唯一 decide()。
  const hasInlineMedia = segments.some((seg) => ["image", "video", "record"].includes(seg?.type));
  const direct = !isGroup || isMentioned || isReplyToBot;
  const scoreText = cleanValueText(rawUserText);
  const groupState = isGroup
    ? updateGroupWillingness(groupId, {
        mentionedBot: isMentioned,
        pureSticker: isPureStickerMessage(segments, rawUserText),
      })
    : null;
  const hasOtherMention = hasAnyMention && !isMentioned;
  const repeatedSpam = isGroup && isRepeatedSpam(groupState, senderId, scoreText);
  const filteredMessage = !shouldEvaluateMessage(scoreText).eligible;
  const technicalVeto = isTechnicalQuestion(rawUserText);
  const contentVeto = isHardVetoMessage(rawUserText, { sensitiveWords: getBotConfig().sensitiveWords.input });
  const hardVeto = isGroup && !direct && (
    hasOtherMention || hasInlineMedia || isNoRandomTalkGroup(groupId) || repeatedSpam || filteredMessage || contentVeto
  );

  let vector = null;
  let topicContinuity = 0;
  let valueResult = null;
  const now = Date.now();
  const coolingDown = Boolean(groupState && !direct && isGroupCoolingDown(groupState, now));

  if (isGroup && !hardVeto && !filteredMessage && scoreText) {
    try {
      vector = await embedText(scoreText);
      topicContinuity = scoreTopicContinuity(vector, groupState.messageVectors);
    } catch (error) {
      console.warn(`[群聊仲裁] embedding 失败 group=${groupId}: ${error.message}`);
    }
    if (!direct && !coolingDown) valueResult = await scoreMessage(scoreText, RUNTIME_CONFIG.valueScoreMode);
  }
  if (groupState) rememberGroupMessage(groupState, senderId, scoreText, vector, now);

  const decisionContext = {
    direct,
    hardVeto: hardVeto || Boolean(valueResult?.blocked),
    coolingDown,
    valueScore: Number.isFinite(valueResult?.score) ? valueResult.score : 0,
    valueAbstain: Boolean(valueResult?.lowConfidence),
    topicContinuity,
    contentScore: direct ? undefined : scoreContent(scoreText, { direct: false, botName }),
    willingness: groupState
      ? groupState.willingness / Math.max(1, Number(RUNTIME_CONFIG.willingnessMax) || 3)
      : 0,
    recentSpeech: groupState?.recentSpeech,
    claimAuto: groupState
      ? () => {
          if (isGroupCoolingDown(groupState)) return false;
          groupState.autoReplyInFlight = true;
          return true;
        }
      : null,
  };
  const decision = decide(scoreText, decisionContext);

  if (isGroup && !direct) {
    const vectorValue = Number.isFinite(valueResult?.score) ? valueResult.score.toFixed(3) : "—";
    const topValue = Number.isFinite(valueResult?.topSimilarity) ? valueResult.topSimilarity.toFixed(3) : "—";
    const ruleValue = hasOtherMention ? "mention-veto"
      : technicalVeto ? "technical-veto"
        : contentVeto ? "content-veto"
          : repeatedSpam ? "spam-veto"
            : hasInlineMedia ? "media-ignore"
              : isNoRandomTalkGroup(groupId) ? "group-disabled"
                : filteredMessage ? "filtered"
                  : valueResult?.blocked ? "knn-block" : "pass";
    console.log(`[群消息价值] group=${groupId} mode=${RUNTIME_CONFIG.valueScoreMode} vector=${vectorValue} content=${Number(decisionContext.contentScore || 0).toFixed(3)} rule=${ruleValue} top=${topValue} willingness=${decisionContext.willingness.toFixed(3)} topic=${topicContinuity.toFixed(3)} presence=${Number(decisionContext.presencePenalty || 0).toFixed(3)} score=${Number(decisionContext.score || 0).toFixed(3)} decision=${decision}`);
  }

  if (decision === "ignore") return;
  if (decision === "auto") {
    await generateAutoReply(ws, {
      groupId,
      selfId,
      botName,
      senderId,
      messageId,
      text: scoreText,
      score: Number(decisionContext.score || 0),
      valueResult,
      clearGeneration: groupContextGeneration,
    });
    return;
  }

  // 只有确定这条消息会被机器人处理时，才检查用户限速。
  const rateLimit = checkUserRateLimit(senderId);
  if (!rateLimit.allowed) {
    const rateTargetId = isGroup ? groupId : senderId;
    try {
      await sendUserRateLimitReply(ws, rateTargetId, isGroup, senderId, rateLimit.type);
    } catch (error) {
      console.error(`[QQ限速] 提示发送失败: ${error.message}`);
    }
    return;
  }

  // ----- 记录最近活跃用户 -----
  recentUsers.set(
    isGroup ? `${groupId}_${String(senderId)}` : `private_${String(senderId)}`,
    { groupId: isGroup ? groupId : null, userId: String(senderId) },
  );

  // ----- 引用消息 -----
  if (replyMessageId) {
    const repliedMessage = replyMessageFetched ? repliedMessageData : await fetchQqMessage(replyMessageId);
    if (repliedMessage) {
      quotedMessageContext = await buildQuotedMessageContext(repliedMessage, { selfId });
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
        isGroup, groupId, userId: senderId,
        imageContent, sourceImageUrl: imageSourceUrl, messageId, messageTime,
      });
    }
  }

  // ----- 头像 -----
  const avatarKeywords = ["头像", "看头像", "长什么样"];
  if (avatarKeywords.some((kw) => userText.includes(kw))) {
    if (userText.includes("我") || userText.includes("自己")) {
      targetAvatarQq = String(senderId);
    } else if (!targetAvatarQq && (userText.includes("你") || userText.includes("猫娘"))) {
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
      isGroup, groupId, userId: senderId, currentMessageId: messageId,
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
        isOwner, isGroup,
        userId: String(senderId), botId: String(selfId), botName,
        searchText: null,
      });
      if (res?.type === "text") {
        await sendAiTextMessages(ws, targetId, isGroup, res.content, res.mentionQqs, { trackGroupSpeech: true });
      }
    }
    return;
  }

  // ----- 群聊历史 -----
  const groupContextPrompt = isGroup
    ? await fetchGroupHistory(groupId, messageId, selfId)
    : "";

  // ----- 构造 AI 上下文 -----
  const contextParts = [];
  if (groupContextPrompt) contextParts.push(groupContextPrompt);
  if (quotedMessageContext) contextParts.push(quotedMessageContext);
  if (recentImageContext && !replyMessageId) {
    contextParts.push("[最近图片：仅在与当前消息相关时使用，否则忽略。]");
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
    const historyQuotePrefix = quotedMessageContext ? `${quotedMessageContext}\n` : "";
    const cleanUserHistoryEntry = imageContent
      ? `${historyQuotePrefix}${recentImageContext ? "[本轮引用了最近图片上下文]" : "[当前用户发送了一张图片]"}${finalPrompt ? `\n${finalPrompt}` : ""}`
      : `${historyQuotePrefix}${finalPrompt}`;

    res = await coreProcessChat(sessionId, finalPrompt, imageContent, {
      isOwner, isGroup,
      userId: String(senderId), botId: String(selfId), botName,
      searchText: userText || null,
      thinkingText: finalPrompt,
      imageSourceUrl,
      contextPrompt,
      historyTextEntry: cleanUserHistoryEntry,
      contextKey: isGroup ? `group:${String(groupId)}` : null,
      isContextCurrent: () => !isGroup || getGroupHistoryGeneration(groupId) === groupContextGeneration,

      // 思维链不再额外发 “让我想想…”；有思考就让 SSE 走完直接发最终回复。
      onThinkingStart: async () => {
        console.log(`[QQ] 开始思考 session=${sessionId}`);
      },

      onImageReady: async (image) => {
        await sendQqMsg(ws, targetId, isGroup, "好了喵", image.img_url, IMAGE_SOURCE.GENERATED);
      },

      onImageError: async ({ error }) => {
        console.error(`[QQ图片] 后台失败: ${error?.message || error}`);
        try {
          await sendQqMsg(ws, targetId, isGroup, "唔……图片生成失败了，这次没画出来喵。");
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
            ws, targetId, isGroup,
            userMessage || "视频服务刚刚出了点小状况，这次没生成出来喵。",
          );
        } catch (sendError) {
          console.error(`[QQ视频] 通知发送失败: ${sendError.message}`);
        }
      },

      onPokeUser: async (userId) => await sendQqPoke(ws, userId, groupId),
    });
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
        await sendAiTextMessages(ws, targetId, isGroup, message, i === 0 ? mentions : [], { trackGroupSpeech: true });
      } catch (error) {
        console.error(`[QQ] 多条消息发送失败 index=${i + 1}/${messages.length}: ${error.message}`);
      }
      if (i < messages.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
  } else if (res?.type === "text" || res?.type === "video_pending" || res?.type === "image_pending") {
    await sendAiTextMessages(
      ws, targetId, isGroup,
      res.content || "",
      Array.isArray(res.mentionQqs) ? res.mentionQqs : [],
      { trackGroupSpeech: true },
    );
  }
}

// ===== WebSocket 工具 =====
function waitForWebSocketOpen(ws) {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    const onOpen = () => { cleanup(); resolve(); };
    const onError = (error) => { cleanup(); reject(error); };
    const cleanup = () => { ws.off("open", onOpen); ws.off("error", onError); };
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