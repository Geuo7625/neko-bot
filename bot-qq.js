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
import { getServerStatus, checkServerStatusRateLimit } from "./server-status.js";
import {
  IMAGE_SOURCE,
  rememberOutboundImage,
  getOutboundImageSource,
  isHistoricalImageSource,
} from "./image-provenance.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BOT_CONFIG_PATH = path.join(__dirname, "bot-config.json");

let botConfig = loadBotConfig();
let botConfigMtime = getConfigMtime();

const groupLastRandomTalk = new Map();
const userLastPokeTime = new Map();
const recentUsers = new Map();
const groupHistoryClearPoints = new Map();

let globalGroupHistoryClearTime = 0;
let lastRandomPokeTime = 0;

// ===== 最近图片上下文 =====
// 图片消息不一定会触发机器人，所以图片到达时先暂存，
// 后续机器人消息可把它作为候选视觉上下文交给大模型自行判断。
// 群聊按 (群, 用户) 缓存，私聊按用户缓存，默认 120 秒有效。

const RECENT_IMAGE_CONTEXT_TTL_MS = 120_000;
const recentImageContexts = new Map();

function getRecentImageContextKey(isGroup, groupId, userId) {
  return isGroup
    ? `group:${String(groupId)}:${String(userId)}`
    : `private:${String(userId)}`;
}

function saveRecentImageContext({ isGroup, groupId, userId, imageContent, messageId, messageTime }) {
  if (!imageContent) return;
  const key = getRecentImageContextKey(isGroup, groupId, userId);
  recentImageContexts.set(key, {
    imageContent,
    messageId: messageId ?? null,
    messageTime: Number(messageTime || 0),
    senderId: String(userId),
    savedAt: Date.now(),
  });
  console.log(`[QQ图片] 缓存最近图片 | key=${key} | sender=${userId} | message_id=${messageId ?? "unknown"}`);
}

function getRecentImageContext({ isGroup, groupId, userId, currentMessageId = null }) {
  const key = getRecentImageContextKey(isGroup, groupId, userId);
  const context = recentImageContexts.get(key);
  if (!context) return null;

  const age = Date.now() - context.savedAt;
  if (age > RECENT_IMAGE_CONTEXT_TTL_MS) {
    recentImageContexts.delete(key);
    console.log(`[QQ图片] 最近图片已过期 | key=${key} | age=${Math.round(age / 1000)}s`);
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
    nickname: source.nickname !== undefined ? String(source.nickname) : "Yuragi",
    blacklistQQ: Array.isArray(source.blacklistQQ) ? source.blacklistQQ.map(String) : [],
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
    console.log("[Bot配置] 配置文件已重新加载");
  } catch (error) {
    console.error(`[Bot配置] 热加载失败，继续使用旧配置: ${error.message}`);
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
      console.log("[控制指令] 主重启，进程正在退出以被 Docker 重启...");
      process.exit(0);
    }, 1000);
    return "…";
  }

  return null;
}

// ===== QQ 消息段 =====

function buildQqTextSegments(text) {
  const segments = [];
  const pattern = /\[CQ:at,qq=(\d{5,12}|all)\]|@(\d{5,12})/g;
  let lastIndex = 0;

  for (let match; (match = pattern.exec(text)) !== null; ) {
    const index = match.index;
    if (index > lastIndex) {
      const plainText = text.slice(lastIndex, index);
      if (plainText) segments.push({ type: "text", data: { text: plainText } });
    }
    const qq = match[1] || match[2];
    segments.push({ type: "at", data: { qq: String(qq) } });
    lastIndex = index + match[0].length;
  }

  if (lastIndex < text.length) {
    const remaining = text.slice(lastIndex);
    if (remaining) segments.push({ type: "text", data: { text: remaining } });
  }

  if (!segments.length) return [{ type: "text", data: { text } }];
  return segments;
}

async function sendQqMsg(ws, targetId, isGroup, text = null, imgUrl = null, imageSource = null) {
  const action = isGroup ? "send_group_msg" : "send_private_msg";
  const params = { [isGroup ? "group_id" : "user_id"]: targetId };
  const messageChain = [];

  if (text) {
    const cleanText = sanitizeOutput(text);
    if (cleanText) messageChain.push(...buildQqTextSegments(cleanText));
  }
  if (imgUrl) messageChain.push({ type: "image", data: { file: imgUrl } });
  if (messageChain.length === 0) return;

  params.message = messageChain;
  console.log(`[QQ发送] 正在发送消息给 ${targetId}...`);

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error("NapCat WebSocket 当前未连接");
  }

  ws.send(JSON.stringify({ action, params }));
}

// ===== AI 消息拆分 =====
// 只按 ===SPLIT=== 拆分，空行不再拆分。

function splitQqMessages(text) {
  return String(text)
    .split(/===SPLIT===/g)
    .map((part) => part.trim())
    .filter(Boolean);
}

// ===== 发送 AI 文本 =====

async function sendAiTextMessages(ws, targetId, isGroup, text) {
  const messages = splitQqMessages(text);
  if (!messages.length) return;

  for (let i = 0; i < messages.length; i++) {
    const message = sanitizeOutput(messages[i]);
    if (!message) continue;

    const hasRawAt = /(?:\[CQ:at,qq=\d{5,12}\]|@\d{5,12})/.test(message);
    if (hasRawAt) {
      await sendQqMsg(ws, targetId, isGroup, message);
    } else {
      await sendSpecialContent(targetId, isGroup, message);
    }

    if (i < messages.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
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
  console.log(`[QQ@] 准备真实 @ -> group_id=${groupId}, qq=${qq}`);

  if (NAPCAT_HTTP_URL && NAPCAT_TOKEN) {
    const result = await callNapCatHttp("send_group_msg", params);
    if (result) {
      console.log(`[QQ@] 已通过 NapCat HTTP 发送真实 @ -> ${qq}`);
      return true;
    }
  }

  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ action: "send_group_msg", params }));
      console.log(`[QQ@] 已通过 NapCat WebSocket 发送真实 @ -> ${qq}`);
      return true;
    } catch (error) {
      console.error(`[QQ@] WebSocket 发送失败: ${error.name}: ${error.message}`);
    }
  }

  console.error(`[QQ@] HTTP 和 WebSocket 都无法发送真实 @ -> ${qq}`);
  return false;
}

// ===== NapCat HTTP 调用 =====

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
    console.error(`[NapCat HTTP] ${action} 调用失败: ${error.name}: ${error.message}`);
    return null;
  }
}

// ===== QQ 视频 =====

async function sendQqVideo(ws, targetId, isGroup, videoUrl) {
  if (!videoUrl) {
    console.error("[QQ视频] 视频 URL 为空，无法发送");
    return false;
  }

  const action = isGroup ? "send_group_msg" : "send_private_msg";
  const params = {
    [isGroup ? "group_id" : "user_id"]: targetId,
    message: [{ type: "video", data: { file: videoUrl } }],
  };

  console.log(`[QQ视频] 准备主动发送视频 -> ${targetId}`);
  console.log(`[QQ视频] URL: ${videoUrl}`);

  if (NAPCAT_HTTP_URL && NAPCAT_TOKEN) {
    const result = await callNapCatHttp(action, params);
    if (result) {
      console.log(`[QQ视频] 已通过 NapCat HTTP 提交视频发送任务 -> ${targetId}`);
      return true;
    }
  }

  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ action, params }));
      console.log(`[QQ视频] 已通过 WebSocket 发送视频 -> ${targetId}`);
      return true;
    } catch (error) {
      console.error(`[QQ视频] WebSocket 发送失败: ${error.name}: ${error.message}`);
    }
  }

  console.error(`[QQ视频] HTTP 和 WebSocket 都无法发送视频 -> ${targetId}`);
  return false;
}

// ===== QQ 戳戳 =====

async function sendQqPoke(ws, userId, groupId = null) {
  const hasGroup = groupId !== null && groupId !== undefined;
  const action = hasGroup ? "group_poke" : "friend_poke";
  const params = { user_id: userId };
  if (hasGroup) params.group_id = groupId;

  try {
    console.log(`[QQ戳戳] ${hasGroup ? "群聊" : "私聊"} -> user_id=${userId}`);

    if (NAPCAT_HTTP_URL && NAPCAT_TOKEN) {
      const result = await callNapCatHttp(action, params);
      if (result) {
        console.log(`[QQ戳戳] 已通过 NapCat HTTP 发送 -> user_id=${userId}`);
        return true;
      }
    }

    if (!ws || ws.readyState !== WebSocket.OPEN) return false;

    ws.send(JSON.stringify({ action, params }));
    console.log(`[QQ戳戳] 已通过 NapCat WebSocket 发送 -> user_id=${userId}`);
    return true;
  } catch (error) {
    console.error(`[QQ戳戳] 发送失败: ${error.name}: ${error.message}`);
    return false;
  }
}

// ===== 判断用户是否要求拍自己 =====

function wantsPokeSelf(text) {
  if (!text) return false;
  text = text.trim().toLowerCase();
  const patterns = [
    /戳我/,
    /戳一下我/,
    /戳我一下/,
    /你戳我/,
    /你戳一下我/,
    /你戳我一下/,
    /拍我/,
    /拍一下我/,
    /拍我一下/,
    /你拍我/,
    /你拍一下我/,
    /你拍我一下/,
  ];
  return patterns.some((pattern) => pattern.test(text));
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

async function downloadImageAsBase64(imgUrl, timeout = 5000) {
  if (!imgUrl) return null;
  try {
    const response = await httpClient.get(imgUrl, {
      timeout,
      responseType: "arraybuffer",
    });
    const contentType = String(response.headers["content-type"] || "").toLowerCase();
    let mimeType = "image/jpeg";
    if (contentType.includes("png")) mimeType = "image/png";
    else if (contentType.includes("webp")) mimeType = "image/webp";
    else if (contentType.includes("gif")) mimeType = "image/gif";

    const base64Img = Buffer.from(response.data).toString("base64");
    return `data:${mimeType};base64,${base64Img}`;
  } catch (error) {
    console.error(`[QQ图片] 图片下载失败: ${error.name}: ${error.message}`);
    return null;
  }
}

// ===== 获取指定 QQ 消息 =====

async function fetchQqMessage(messageId) {
  if (!NAPCAT_HTTP_URL || !NAPCAT_TOKEN) return null;
  if (messageId === null || messageId === undefined) return null;

  const url = NAPCAT_HTTP_URL.replace(/\/+$/, "") + "/get_msg";
  try {
    console.log(`[QQ引用] 正在获取被引用消息: ${messageId}`);
    const response = await httpClient.post(
      url,
      { message_id: messageId },
      {
        headers: {
          Authorization: `Bearer ${NAPCAT_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 4000,
      },
    );

    if (response.status !== 200) return null;
    const result = response.data;
    if ((result?.retcode ?? 0) !== 0) return null;

    const data = result?.data;
    if (!data || typeof data !== "object") return null;
    return data;
  } catch (error) {
    console.error(`[QQ引用] 获取消息异常: ${error.name}: ${error.message}`);
    return null;
  }
}

// ===== 从消息中提取图片 =====

async function extractImageFromMessage(message, { selfId = null } = {}) {
  if (!message || typeof message !== "object") return null;

  const senderId = String(message.user_id ?? "");

  if (selfId !== null && selfId !== undefined && senderId === String(selfId)) {
    const source = getOutboundImageSource(message.message_id);
    // 只有历史图片才允许重新进入视觉上下文
    if (!isHistoricalImageSource(source)) {
      console.log(
        `[QQ引用] 忽略机器人非历史图片 | message_id=${message.message_id} | source=${source ?? "unknown"}`,
      );
      return null;
    }
  }

  const segments = message.message;
  if (!Array.isArray(segments)) return null;

  for (const seg of segments) {
    if (!seg || typeof seg !== "object" || seg.type !== "image") continue;
    const data = seg.data && typeof seg.data === "object" ? seg.data : {};
    const imgUrl = data.url || data.file;
    if (!imgUrl) continue;

    const imageContent = await downloadImageAsBase64(imgUrl, 5000);
    if (imageContent) return imageContent;
  }
  return null;
}

// ===== 获取群聊历史 =====

async function fetchGroupHistory(groupId, currentMessageId = null) {
  if (!NAPCAT_HTTP_URL || !NAPCAT_TOKEN) return "";
  const url = NAPCAT_HTTP_URL.replace(/\/+$/, "") + "/get_group_msg_history";

  try {
    console.log(`[QQ历史] 请求群历史: group_id=${groupId}`);
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
    if (data && typeof data === "object" && !Array.isArray(data)) msgs = data.messages || [];
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
      const sName = sender.card || sender.nickname || String(m.user_id ?? "未知");

      let rawTxt = messageSegmentsToText(m.message || []).trim();
      if (!rawTxt) continue;

      let cleanRaw = sanitizeInput(rawTxt);
      if (!cleanRaw) continue;

      cleanRaw = cleanRaw.slice(0, 100);
      formattedMsgs.push(`${sName} [QQ:${m.user_id}]: ${cleanRaw}`);
    }

    if (!formattedMsgs.length) return "";
    const finalMsgs = formattedMsgs.slice(-15);
    return "\n[群聊历史，仅供上下文参考]\n" + finalMsgs.join("\n") + "\n";
  } catch (error) {
    console.error(`[QQ历史] 获取群历史异常: ${error.name}: ${error.message}`);
    return "";
  }
}

// ===== 主动戳戳 =====

async function randomPokeLoop(ws, signal) {
  console.log("[QQ主动戳戳] 后台任务已启动");

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
      console.log(
        `[QQ主动戳戳] 随机选择用户: user_id=${selected.userId}, group_id=${selected.groupId}`,
      );

      await sendQqPoke(ws, selected.userId, selected.groupId);
      lastRandomPokeTime = now;
      userLastPokeTime.set(selected.key, now);
    } catch (error) {
      if (signal.aborted) break;
      console.error(`[QQ主动戳戳] 后台任务异常: ${error.name}: ${error.message}`);
    }
  }

  console.log("[QQ主动戳戳] 后台任务已停止");
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
      console.log(`[QQ] 正在连接 NapCat WebSocket: ${NAPCAT_WS_URL} ...`);
      ws = new WebSocket(NAPCAT_WS_URL);
      await waitForWebSocketOpen(ws);
      console.log("已成功连接到 NapCat QQ 服务喵！");

      pokeController = new AbortController();
      randomPokeLoop(ws, pokeController.signal).catch((error) => {
        if (!pokeController.signal.aborted) {
          console.error("[QQ主动戳戳] 后台任务崩溃:", error);
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
          console.log("[QQ] NapCat WebSocket 已断开");
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
            console.error(`[QQ] 消息处理异常: ${error.name}: ${error.message}`);
          }
        });

        ws.once("close", onClose);
        ws.once("error", onError);
      });
    } catch (error) {
      console.error(`[QQ] WebSocket 连接断开，5秒后尝试重连: ${error.message}`);
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

    console.log("[QQ] 5秒后重新连接 NapCat...");
    await sleep(5000);
  }
}

// ===== QQ 事件分发 =====

async function handleQqEvent(ws, event) {
  const postType = event?.post_type;

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

      console.log(`[QQ事件] 收到来自 ${senderId} 的戳一戳`);

      const isGroup = groupId !== null && groupId !== undefined;
      const targetReplyId = isGroup ? groupId : senderId;
      const sessionId = isGroup ? `qq_${groupId}_${senderId}` : `qq_${senderId}`;
      const isOwner = isOwnerQQ(senderId);

      const pokePrompt = isOwner
        ? "[事件] 主人戳了你一下。亲切的回应"
        : "[事件] 对方戳了你一下。自然的回应";

      const res = await coreProcessChat(sessionId, pokePrompt, undefined, {
        isOwner,
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

  // 黑名单
  if (isBlacklisted(senderId)) return;

  // 不处理机器人自己发出的消息（防止自己图片再次进入最近图片上下文）
  if (String(senderId) === String(selfId)) return;

  const isOwner = isOwnerQQ(senderId);

  // ----- 解析消息段 -----
  let userText = "";
  let imageContent = null;
  let isMentioned = false;
  let isAtAll = false;
  let targetAvatarQq = null;
  let replyMessageId = null;

  const segments = Array.isArray(event.message) ? event.message : [];

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
      const imgUrl = segData.url || segData.file;
      if (imgUrl) {
        console.log("[QQ] 当前消息包含图片");
        imageContent = await downloadImageAsBase64(imgUrl, 4000);

        // 关键：图片到达即缓存，即使本条消息不会触发机器人回复
        if (imageContent) {
          saveRecentImageContext({
            isGroup,
            groupId,
            userId: senderId,
            imageContent,
            messageId,
            messageTime,
          });
        }
      }
    } else if (segType === "reply") {
      replyMessageId = segData.id;
    }
  }

  // 全体 @ 忽略（图片缓存已在上方完成）
  if (isAtAll) return;

  userText = sanitizeInput(userText);

  // ----- 控制 / 公开指令 -----
  const controlCommand = handleControlCommand(userText, senderId);

  // 主人专用指令
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

  // 公开指令
  if (controlCommand?.type === "public") {
    if (controlCommand.action === "server_status") {
      const rateLimit = checkServerStatusRateLimit(senderId);
      if (!rateLimit.allowed) {
        const seconds = Math.ceil(rateLimit.remainingMs / 1000);
        await sendQqMsg(ws, targetId, isGroup, `服务器状态查得太频繁啦，${seconds} 秒后再查吧。`);
        return;
      }

      try {
        console.log(
          `[服务器状态] 查询 | user=${senderId} | group=${isGroup ? groupId : "private"}`,
        );
        const statusText = await getServerStatus();
        await sendQqMsg(ws, targetId, isGroup, statusText);
      } catch (error) {
        console.error(`[服务器状态] 查询失败: ${error.name}: ${error.message}`);
        await sendQqMsg(ws, targetId, isGroup, "唔……服务器状态接口暂时连不上了喵。");
      }
      return;
    }
    return;
  }

  // 未授权主人指令
  if (controlCommand?.type === "unauthorized") {
    const unauthorizedPrompt =
      `[系统提示：对方无权执行机器人控制指令「${controlCommand.command}」。` +
      "委婉拒绝请求，不要声称已执行。]";

    const res = await coreProcessChat(sessionId, unauthorizedPrompt, undefined, {
      isOwner: false,
      searchText: null,
    });

    if (res?.type === "text") await sendQqMsg(ws, targetId, isGroup, res.content);
    return;
  }

  // ----- 记录最近活跃用户 -----
  const userKey = isGroup ? `${groupId}_${String(senderId)}` : `private_${String(senderId)}`;
  recentUsers.set(userKey, { groupId: isGroup ? groupId : null, userId: String(senderId) });

  // ----- 用户要求拍自己 -----
  if (wantsPokeSelf(userText)) {
    console.log(`[QQ戳戳] 用户主动要求拍自己: user_id=${senderId}, group_id=${groupId}`);
    await sendQqPoke(ws, senderId, groupId);
    return;
  }

  // ----- 引用消息：优先取引用消息中的图片 -----
  if (replyMessageId && !imageContent) {
    const repliedMessage = await fetchQqMessage(replyMessageId);
    if (repliedMessage) {
      const repliedImage = await extractImageFromMessage(repliedMessage, { selfId });
      if (repliedImage) imageContent = repliedImage;
    }
  }

  // ----- 群聊回复判断 -----
  if (isGroup) {
    const currentTime = Date.now() / 1000;
    const lastTalk = groupLastRandomTalk.get(String(groupId)) || 0;
    const containsName = ["猫猫", "猫娘"].some((name) => userText.toLowerCase().includes(name));

    let shouldReply = false;

    if (isMentioned) {
      shouldReply = true;
    } else if (isNoRandomTalkGroup(groupId)) {
      shouldReply = false;
    } else if (containsName) {
      if (currentTime - lastTalk > 180 && Math.random() < 0.3) {
        groupLastRandomTalk.set(String(groupId), currentTime);
        shouldReply = true;
      }
    } else if (currentTime - lastTalk > 600 && Math.random() < 0.005) {
      groupLastRandomTalk.set(String(groupId), currentTime);
      shouldReply = true;
    }

    if (!shouldReply && !(!userText && imageContent && isMentioned)) return;
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
        imageContent = await downloadImageAsBase64(avatarUrl, 3000);
      } catch (error) {
        console.error(`[QQ] 头像下载失败: ${error.message}`);
      }
    }
  }

  // ----- 最近图片视觉上下文（当前无图无引用时才考虑） -----
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
      console.log(
        `[QQ图片] 使用最近图片上下文 | sender=${recentImageContext.senderId} | message_id=${
          recentImageContext.messageId ?? "unknown"
        }`,
      );
    }
  }

  // ----- 没有文字也没有图片 -----
  if (!userText && !imageContent) {
    if (isMentioned) {
      const emptyAtPrompt = isOwner
        ? "[事件] 主人@了你但未发言。亲切回应"
        : "[事件] 对方@了你但未发言。自然回应";

      const res = await coreProcessChat(sessionId, emptyAtPrompt, undefined, {
        isOwner,
        searchText: null,
      });

      if (res?.type === "text") await sendQqMsg(ws, targetId, isGroup, res.content);
    }
    return;
  }

  // ----- 群聊历史 -----
  let groupContextPrompt = "";
  if (isGroup) {
    groupContextPrompt = await fetchGroupHistory(groupId, messageId);
  }

  // ----- 构造 AI 上下文 -----
  const promptParts = [];
  if (groupContextPrompt) promptParts.push(groupContextPrompt);
  if (replyMessageId) promptParts.push("\n[引用消息]\n");

  // 最近图片：只是候选视觉上下文，让模型自行判断是否使用
  if (recentImageContext && !replyMessageId) {
    promptParts.push(
      "\n[最近图片：候选视觉上下文；仅在与当前输入相关时使用，否则忽略，不要主动提及。]\n",
    );
  }

  // 当前消息直接带图时，也约束一下，避免无关展开
  if (imageContent && !recentImageContext && !replyMessageId) {
    promptParts.push("\n[当前图片：按当前输入判断是否需要分析，不要无关展开。]\n");
  }

  if (userText) promptParts.push(userText);
  const finalPrompt = promptParts.join("");

  console.log(
    `[Core] 请求, Prompt长度: ${finalPrompt.length}, 是否带图: ${Boolean(
      imageContent,
    )}, 是否最近图片: ${Boolean(recentImageContext)}, 是否主人: ${isOwner}, 是否引用消息: ${Boolean(
      replyMessageId,
    )}`,
  );

  // ----- 调用 Core -----
  const res = await coreProcessChat(sessionId, finalPrompt, imageContent, {
    isOwner,
    isGroup,
    searchText: userText,
    thinkingText: userText,

    onThinkingStart: async () => {
      console.log(`[QQ思考] AI 已开始 Thinking | session=${sessionId}`);
      await sendQqMsg(ws, targetId, isGroup, "已开始思考");
    },

    onImageReady: async (image) => {
      console.log(`[QQ图片] Core 通知图片已完成 | session=${sessionId}`);
      await sendQqMsg(ws, targetId, isGroup, "画好了喵", image.img_url, IMAGE_SOURCE.GENERATED);
    },

    onImageError: async ({ sessionId: imageSessionId, error }) => {
      console.error(`[QQ图片] 后台图片生成失败 | session=${imageSessionId}`, error);
      try {
        await sendQqMsg(ws, targetId, isGroup, "唔……图片生成失败了，这次没画出来喵。");
      } catch (sendError) {
        console.error(`[QQ图片] 发送失败通知失败: ${sendError.message}`);
      }
    },

    onVideoReady: async (video) => {
      console.log(
        `[QQ视频] Core 通知视频已完成 | session=${sessionId} | video_id=${video.video_id}`,
      );
      await sendQqMsg(ws, targetId, isGroup, "生成好了喵");
      const sent = await sendQqVideo(ws, targetId, isGroup, video.video_url);
      if (!sent) console.error(`[QQ视频] 主动发送失败 | session=${sessionId}`);
    },

    onVideoError: async ({ sessionId: videoSessionId, error }) => {
      console.error(`[QQ视频] 后台视频生成失败 | session=${videoSessionId}`, error);
      try {
        await sendQqMsg(ws, targetId, isGroup, "唔……视频生成失败了，这次没生成出来喵。");
      } catch (sendError) {
        console.error(`[QQ视频] 发送失败通知失败: ${sendError.message}`);
      }
    },

    onMentionUser: async (userId) => {
      if (!isGroup) return false;
      return await sendQqMention(ws, groupId, userId);
    },

    onPokeUser: async (userId) => {
      return await sendQqPoke(ws, userId, groupId);
    },
  });

  // ----- 输出处理 -----
  if (res?.type === "text") {
    await sendAiTextMessages(ws, targetId, isGroup, res.content || "");
  } else if (res?.type === "video_pending") {
    const cleanContent = sanitizeOutput(res.content || "");
    console.log(
      `[QQ视频] 视频任务已经提交后台生成 | ` + `video_id=${res.video_id} | ` + `task_id=${res.task_id}`,
    );
    if (cleanContent) await sendQqMsg(ws, targetId, isGroup, cleanContent);
  } else if (res?.type === "image_pending") {
    const cleanContent = sanitizeOutput(res.content || "");
    console.log(`[QQ图片] 图片任务已经提交后台生成 | ` + `ratio=${res.ratio}`);
    if (cleanContent) await sendQqMsg(ws, targetId, isGroup, cleanContent);
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

// ===== 导出 =====

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
  extractImageFromMessage,
  fetchGroupHistory,
  isOwnerQQ,
  isBlacklisted,
  isNoRandomTalkGroup,
};