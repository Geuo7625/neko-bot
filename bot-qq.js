// bot-qq.js
import axios from "axios";
import WebSocket from "ws";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { NAPCAT_WS_URL, NAPCAT_HTTP_URL, NAPCAT_TOKEN } from "./config.js";
import { coreProcessChat, clearHistory, clearAllHistories } from "./core.js";
import { sendSpecialContent } from "./special-content.js";
import { handleControlCommand } from "./control.js";
import {
  getServerStatus,
  checkServerStatusRateLimit,
} from "./server-status.js";
import { IMAGE_SOURCE } from "./image-provenance.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BOT_CONFIG_PATH = path.join(__dirname, "bot-config.json");

let botConfig = loadBotConfig();
let botConfigMtime = getConfigMtime();

const groupLastRandomTalk = new Map();
const userLastPokeTime = new Map();
const recentUsers = new Map();
const groupHistoryClearPoints = new Map();

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

async function sendUserRateLimitReply(ws, targetId, isGroup, userId, type) {
  if (!shouldSendRateLimitNotice(userId, type)) return;
  const text =
    type === "cooldown" ? "有点累了…让我歇会" : "慢点…我跟不上了";
  await sendQqMsg(ws, targetId, isGroup, text);
}

let globalGroupHistoryClearTime = 0;
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

function clearGroupHistory(groupId, time) {
  if (groupId === null || groupId === undefined) return;
  groupHistoryClearPoints.set(String(groupId), Number(time) || 0);
}

function clearAllGroupHistory(time) {
  globalGroupHistoryClearTime = Number(time) || 0;
  groupHistoryClearPoints.clear();
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
    clearHistory(sessionId);
    if (isGroup) clearGroupHistory(groupId, messageTime);
    return "好";
  }

  if (command.action === "clear_all") {
    clearAllHistories();
    clearAllGroupHistory(messageTime);
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

// ===== AI 消息拆分 =====

function splitQqMessages(text) {
  return String(text)
    .split(/===SPLIT===/g)
    .map((part) => part.trim())
    .filter(Boolean);
}

async function sendAiTextMessages(ws, targetId, isGroup, text, mentionQqs = []) {
  const messages = splitQqMessages(text);
  const mentions = Array.isArray(mentionQqs)
    ? [
        ...new Set(
          mentionQqs
            .map((value) => String(value ?? "").trim())
            .filter((value) => value === "all" || /^\d{5,12}$/.test(value)),
        ),
      ]
    : [];

  if (!messages.length && !mentions.length) return;

  let mentionsAttached = false;

  for (let i = 0; i < messages.length; i++) {
    const message = sanitizeOutput(messages[i]);
    if (!message) continue;

    if (!mentionsAttached && mentions.length) {
      await sendQqMsg(ws, targetId, isGroup, message, null, null, mentions);
      mentionsAttached = true;
    } else {
      await sendSpecialContent(targetId, isGroup, message);
    }

    if (i < messages.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
  }

  if (!mentionsAttached && mentions.length) {
    await sendQqMsg(ws, targetId, isGroup, null, null, null, mentions);
  }
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
    } else {
      parts.push(`[${segType || "未知消息"}]`);
    }
  }
  return parts.join("").trim();
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

function buildQuotedMessageContext(message, { selfId = null } = {}) {
  if (!message || typeof message !== "object") return "";

  const senderId = String(message.user_id ?? "未知");
  const sender =
    message.sender && typeof message.sender === "object" ? message.sender : {};
  const isSelf =
    selfId !== null && selfId !== undefined && senderId === String(selfId);
  const senderName = sender.card || sender.nickname || senderId;
  const label = isSelf ? "你（机器人）" : `群友「${senderName}」`;
  const text = messageSegmentsToText(message.message || []).trim();
  const hasImage =
    Array.isArray(message.message) &&
    message.message.some((seg) => seg?.type === "image");

  if (!text && !hasImage) return "";

  const parts = [`[引用消息]\n发送者：${label} [QQ:${senderId}]`];
  if (text) parts.push(`内容：${text}`);
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

async function fetchGroupHistory(groupId, currentMessageId = null, selfId = null) {
  if (!NAPCAT_HTTP_URL || !NAPCAT_TOKEN) return "";
  const url = NAPCAT_HTTP_URL.replace(/\/+$/, "") + "/get_group_msg_history";

  try {
    const response = await httpClient.post(
      url,
      { group_id: groupId, count: 15, message_seq: 0 },
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

    for (const m of msgs) {
      if (!m || typeof m !== "object") continue;

      if (
        currentMessageId !== null &&
        currentMessageId !== undefined &&
        String(m.message_id) === String(currentMessageId)
      ) {
        continue;
      }

      if (clearTime > 0 && Number(m.time || 0) <= clearTime) continue;
      if (isBlacklisted(m.user_id)) continue;

      const sender = m.sender && typeof m.sender === "object" ? m.sender : {};
      const senderId = String(m.user_id ?? "未知");
      const isSelf =
        selfId !== null && selfId !== undefined && senderId === String(selfId);
      const sName = sender.card || sender.nickname || senderId;

      let rawTxt = messageSegmentsToText(m.message || []).trim();
      if (!rawTxt) continue;

      let cleanRaw = sanitizeInput(rawTxt);
      if (!cleanRaw) continue;

      cleanRaw = cleanRaw.slice(0, 100);
      formattedMsgs.push(
        isSelf
          ? `你（机器人） [QQ:${senderId}]: ${cleanRaw}`
          : `群友「${sName}」 [QQ:${senderId}]: ${cleanRaw}`,
      );
    }

    if (!formattedMsgs.length) return "";
    const finalMsgs = formattedMsgs.slice(-15);
    return "\n[群聊历史，仅供上下文参考]\n" + finalMsgs.join("\n") + "\n";
  } catch (error) {
    console.error(`[QQ历史] 获取群历史异常: ${error.message}`);
    return "";
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

      console.log(`[QQ] 被戳 from=${senderId}`);

      const isGroup = groupId !== null && groupId !== undefined;
      const targetReplyId = isGroup ? groupId : senderId;
      const sessionId = isGroup ? `qq_${groupId}_${senderId}` : `qq_${senderId}`;
      const isOwner = isOwnerQQ(senderId);

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
        await sendQqMsg(ws, targetReplyId, isGroup, res.content);
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
  let targetAvatarQq = null;
  let replyMessageId = null;
  let quotedMessageContext = "";
  let hasUnsupportedContent = false;

  const segments = Array.isArray(event.message) ? event.message : [];

  if (!Array.isArray(event.message) && event.message) {
    userText = String(event.raw_message || event.message);
  }

  for (const seg of segments) {
    if (!seg || typeof seg !== "object") continue;
    const segType = seg.type;
    const segData = seg.data && typeof seg.data === "object" ? seg.data : {};

    if (segType === "at") {
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
      userText += "[转发消息]";
      hasUnsupportedContent = true;
    } else if (segType === "share") {
      userText += segData.title ? `[分享:${segData.title}]` : "[链接分享]";
      hasUnsupportedContent = true;
    } else if (
      segType === "json" ||
      segType === "xml" ||
      segType === "markdown" ||
      segType === "card"
    ) {
      userText += `[特殊消息:${segType}]`;
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

  userText = sanitizeInput(userText);

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

    if (res?.type === "text")
      await sendQqMsg(ws, targetId, isGroup, res.content);
    return;
  }

  // ----- 群聊回复判断 -----
  let autoTalk = false;
  if (isGroup) {
    const currentTime = Date.now() / 1000;
    const lastTalk = groupLastRandomTalk.get(String(groupId)) || 0;
    const containsName = ["猫猫", "猫娘"].some((name) =>
      userText.toLowerCase().includes(name),
    );

    let shouldReply = false;

    if (isMentioned) {
      shouldReply = true;
    } else if (isNoRandomTalkGroup(groupId)) {
      shouldReply = false;
    } else if (containsName) {
      if (currentTime - lastTalk > 180 && Math.random() < 0.3) {
        shouldReply = true;
        autoTalk = true;
      }
    } else if (currentTime - lastTalk > 600 && Math.random() < 0.005) {
      shouldReply = true;
      autoTalk = true;
    }

    if (!shouldReply && !(!userText && hasImageSegment && isMentioned)) return;
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

  if (autoTalk) {
    groupLastRandomTalk.set(String(groupId), Date.now() / 1000);
  }

  // 自动接话只看群聊上下文，不针对当前这条消息。

  // ----- 记录最近活跃用户 -----
  const userKey = isGroup
    ? `${groupId}_${String(senderId)}`
    : `private_${String(senderId)}`;
  recentUsers.set(userKey, {
    groupId: isGroup ? groupId : null,
    userId: String(senderId),
  });

  // ----- 引用消息 -----
  if (!autoTalk && replyMessageId) {
    const repliedMessage = await fetchQqMessage(replyMessageId);
    if (repliedMessage) {
      quotedMessageContext = buildQuotedMessageContext(repliedMessage, {
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
  if (!autoTalk && imageSegmentData && !imageContent) {
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

  // 自动接话不带入当前图片、当前引用，也不使用当前消息触发搜索。
  if (autoTalk) {
    imageContent = null;
    imageSourceUrl = null;
    quotedMessageContext = "";
  }

  // ----- 头像 -----
  const avatarKeywords = ["头像", "看头像", "长什么样"];
  if (!autoTalk && avatarKeywords.some((kw) => userText.includes(kw))) {
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
  if (!autoTalk && !imageContent) {
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
  if (!autoTalk && !userText && !imageContent && !quotedMessageContext) {
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

      if (res?.type === "text")
        await sendQqMsg(ws, targetId, isGroup, res.content);
    }
    return;
  }

  // ----- 群聊历史 -----
  let groupContextPrompt = "";
  if (isGroup) {
    groupContextPrompt = await fetchGroupHistory(groupId, messageId, selfId);
  }

  // ----- 构造 AI 上下文 -----
  const promptParts = [];
  if (groupContextPrompt) promptParts.push(groupContextPrompt);

  if (autoTalk) {
    promptParts.push(
      "\n[群聊自动接话]\n只根据上面最近几条群聊消息，概括大家正在聊什么，然后自然、简短地接一句。不要针对某一个人的单条消息回复，不要点名，不要逐条复述，不要搜索，不要调用工具，也不要提及这是群聊历史。尽量只说一句话。",
    );
  } else {
    if (quotedMessageContext) promptParts.push(`\n${quotedMessageContext}\n`);

    if (recentImageContext && !replyMessageId) {
      promptParts.push(
        "\n[最近图片：候选视觉上下文；仅在与当前输入相关时使用，否则忽略，不要主动提及。]\n",
      );
    }

    if (imageContent && !recentImageContext && !replyMessageId) {
      promptParts.push(
        "\n[当前图片：按当前输入判断是否需要分析，不要无关展开。]\n",
      );
    }

    if (userText) promptParts.push(userText);
  }

  const finalPrompt = promptParts.join("");

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
    const cleanUserHistoryEntry = autoTalk
      ? "[自动接话]"
      : imageContent
        ? `${historyQuotePrefix}${recentImageContext ? "[本轮引用了最近图片上下文]" : "[当前用户发送了一张图片]"}${userText ? `\n${userText}` : ""}`
        : `${historyQuotePrefix}${userText}`;

    res = await coreProcessChat(sessionId, finalPrompt, imageContent, {
    isOwner,
    isGroup,
    userId: String(senderId),
    botId: String(selfId),
    botName,
    searchText: autoTalk ? null : userText,
    thinkingText: userText,
    imageSourceUrl,
    historyTextEntry: cleanUserHistoryEntry,

    onThinkingStart: async () => {
      console.log(`[QQ] 开始思考 session=${sessionId}`);
      await sendQqMsg(ws, targetId, isGroup, "让我想想…");
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
  } finally {
    endUserApiRequest(senderId);
  }

  // ----- 输出处理 -----
  if (res?.type === "text") {
    await sendAiTextMessages(
      ws,
      targetId,
      isGroup,
      res.content || "",
      Array.isArray(res.mentionQqs) ? res.mentionQqs : [],
    );
  } else if (res?.type === "video_pending") {
    const cleanContent = sanitizeOutput(res.content || "");
    if (cleanContent) {
      await sendQqMsg(
        ws,
        targetId,
        isGroup,
        cleanContent,
        null,
        null,
        Array.isArray(res.mentionQqs) ? res.mentionQqs : [],
      );
    } else if (Array.isArray(res.mentionQqs) && res.mentionQqs.length) {
      await sendQqMsg(ws, targetId, isGroup, null, null, null, res.mentionQqs);
    }
  } else if (res?.type === "image_pending") {
    const cleanContent = sanitizeOutput(res.content || "");
    if (cleanContent) {
      await sendQqMsg(
        ws,
        targetId,
        isGroup,
        cleanContent,
        null,
        null,
        Array.isArray(res.mentionQqs) ? res.mentionQqs : [],
      );
    } else if (Array.isArray(res.mentionQqs) && res.mentionQqs.length) {
      await sendQqMsg(ws, targetId, isGroup, null, null, null, res.mentionQqs);
    }
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
  isOwnerQQ,
  isBlacklisted,
  isNoRandomTalkGroup,
};