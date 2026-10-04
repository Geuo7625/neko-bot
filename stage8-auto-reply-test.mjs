// 自动接话编排拆分自测：
// 1) 工具权限矩阵集中且不重叠（auto 不含画图/视频）
// 2) auto prompt 带图逻辑：有图才带、最多 3 张、只回看近 5 条
// 3) 带图走 vision.js 消息格式
// 4) bot-qq 接线回归：direct 仍走 core 引擎且拿全量工具
// auto-reply.js 模块级只依赖 config.js，可离线运行：node stage8-auto-reply-test.mjs
import fs from "node:fs";
import { register } from "node:module";
import { RUNTIME_CONFIG, DIRECT_TOOLS, AUTO_TOOLS } from "./config.js";
import { pickRecentPromptImages, buildAutoContextPrompt, runAutoReply } from "./auto-reply.js";
import { createVisionMessage } from "./vision.js";

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name} (期望 ${JSON.stringify(expected)}, 实际 ${JSON.stringify(actual)})`);
}

// ---- 1. 工具权限矩阵 ----
check("AUTO_TOOLS 仅含 send_sticker", AUTO_TOOLS, ["send_sticker"]);
check("AUTO_TOOLS 不含 generate_image", AUTO_TOOLS.includes("generate_image"), false);
check("AUTO_TOOLS 不含 generate_video", AUTO_TOOLS.includes("generate_video"), false);
check("DIRECT_TOOLS 含 generate_image", DIRECT_TOOLS.includes("generate_image"), true);
check("DIRECT_TOOLS 含 generate_video", DIRECT_TOOLS.includes("generate_video"), true);
check("DIRECT_TOOLS 含 send_sticker", DIRECT_TOOLS.includes("send_sticker"), true);

// 矩阵覆盖 core 引擎里定义的每个工具，防止漏配。
const coreSource = fs.readFileSync(new URL("./core.js", import.meta.url), "utf8");
const autoReplySource = fs.readFileSync(new URL("./auto-reply.js", import.meta.url), "utf8");
const missing = DIRECT_TOOLS.filter((name) => !coreSource.includes(`name: "${name}"`));
check("DIRECT_TOOLS 覆盖 core 全部工具", missing, []);
check("core 不再残留取图工具", coreSource.includes("get_recent_group_image"), false);
check("core 不再残留 autoSkipMarker", coreSource.includes("autoSkipMarker"), false);
check("auto 路径使用 AUTO_TOOLS", autoReplySource.includes("toolAllowlist: AUTO_TOOLS"), true);
check("auto 路径自己负责 [[SKIP]] 检查", autoReplySource.includes("AUTO_SKIP_MARKER"), true);

// ---- 2. auto prompt 带图逻辑 ----
// 最新在前；第 6 条超出「近 5 条」扫描范围。
const messages = [
  { messageId: "1", hasImage: true, senderName: "A" },
  { messageId: "2", hasImage: false, senderName: "B" },
  { messageId: "3", hasImage: true, senderName: "C" },
  { messageId: "4", hasImage: true, senderName: "D" },
  { messageId: "5", hasImage: true, senderName: "E" },
  { messageId: "6", hasImage: true, senderName: "F" },
];
const ids = (list) => list.map((item) => item.messageId);

check("默认窗口内最多 3 张", ids(pickRecentPromptImages(messages)), ["1", "3", "4"]);
check("maxImages=2 时取 2 张", ids(pickRecentPromptImages(messages, { maxImages: 2 })), ["1", "3"]);
check("扫描窗口=2 时只看前 2 条", ids(pickRecentPromptImages(messages, { scanCount: 2 })), ["1"]);
check("没有图片时一张都不带", pickRecentPromptImages([{ messageId: "1", hasImage: false }]), []);
check("maxImages=0 时关闭带图", pickRecentPromptImages(messages, { maxImages: 0 }), []);
check("空列表安全", pickRecentPromptImages([]), []);
check("配置默认值为 5/3", [RUNTIME_CONFIG.autoImageScanMessageCount, RUNTIME_CONFIG.autoMaxPromptImages], [5, 3]);
check("挑中的确实是含图消息", pickRecentPromptImages(messages).every((item) => item.hasImage), true);

// ---- 3. 带图沿用 vision.js 消息格式 ----
const vision = createVisionMessage("https://example.com/a.png", "看看这个");
check("vision 格式含 image_url", vision.content.some((part) => part.type === "image_url"), true);
check("vision 格式含 text", vision.content.some((part) => part.type === "text"), true);

const prompt = buildAutoContextPrompt({ groupContext: "【群聊历史】", memoryPrompt: "【摘要】", skipMarker: "[[SKIP]]" });
check("auto 上下文含群历史", prompt.includes("【群聊历史】"), true);
check("auto 上下文含静默标记", prompt.includes("[[SKIP]]"), true);

// ---- 4. bot-qq 接线回归（loader 注入离线依赖桩，加载真实 bot-qq.js）----
const dataUrl = (source) => "data:text/javascript," + encodeURIComponent(source);

const wsStubUrl = dataUrl(`
import { EventEmitter } from "node:events";
class WebSocket extends EventEmitter {
  constructor(url) { super(); this.url = url; this.readyState = WebSocket.OPEN; queueMicrotask(() => this.emit("open")); }
  send() {}
  close() { this.readyState = WebSocket.CLOSED; }
  on(event, cb) { WebSocket.handlers[event] = cb; return super.on(event, cb); }
  once(event, cb) { WebSocket.handlers[event] = cb; return super.once(event, cb); }
  off(event, cb) { if (WebSocket.handlers[event] === cb) delete WebSocket.handlers[event]; return super.off(event, cb); }
}
WebSocket.handlers = {};
WebSocket.OPEN = 1; WebSocket.CONNECTING = 0; WebSocket.CLOSING = 2; WebSocket.CLOSED = 3;
export default WebSocket;
`);

const axiosStubUrl = dataUrl(`
const calls = [];
const axios = {
  calls,
  async post(url, params) { calls.push({ url, params }); return { data: { retcode: 0, status: "ok" } }; },
  async get() { return { data: {}, headers: {} }; },
  create() { return axios; },
};
export default axios;
export { calls };
`);

const genericStubUrl = dataUrl(`
const target = function () {};
const generic = new Proxy(target, {
  get(t, p) { if (p === "then") return undefined; if (p === "default") return generic; if (!(p in t)) t[p] = generic; return t[p]; },
  set() { return true; },
  apply() { return generic; },
  construct() { return generic; },
});
export default generic;
export const env = {};
export const pipeline = async () => (async () => []);
export const connect = async () => ({ tableNames: async () => [], openTable: async () => ({}) });
export const chromium = { launch: async () => ({ newPage: async () => ({}), close: async () => {} }) };
`);

// 只拦截 bot-qq.js 对 ./special-content.js 的引用，记录真正发出的文本（内部走全球 fetch，离线不可用）。
const specialSpyUrl = dataUrl(`
export const sendSpecialContent = async (targetId, isGroup, message, mentions) => {
  (globalThis.__specialSends ||= []).push({ targetId, isGroup, message, mentions });
};
`);

// 只拦截 bot-qq.js / auto-reply.js 对 ./core.js 的引用，记录进入引擎的选项。
const coreSpyUrl = dataUrl(`
export * from ${JSON.stringify(new URL("./core.js", import.meta.url).href)};
export const coreProcessChat = async (sessionId, userText, imageContent, options = {}) => {
  (globalThis.__coreCalls ||= []).push({ sessionId, options });
  const content = globalThis.__coreResult ?? "（测试桩回复）";
  return content === null ? { type: "skipped", content: "" } : { type: "text", content };
};
`);

const hookUrl = dataUrl(`
import { builtinModules } from "node:module";
const builtins = new Set([...builtinModules, ...builtinModules.map((m) => "node:" + m)]);
const WS = ${JSON.stringify(wsStubUrl)};
const AX = ${JSON.stringify(axiosStubUrl)};
const GEN = ${JSON.stringify(genericStubUrl)};
const CORE_SPY = ${JSON.stringify(coreSpyUrl)};
const SPECIAL_SPY = ${JSON.stringify(specialSpyUrl)};
const fromBotQq = (context) => Boolean(context.parentURL && context.parentURL.endsWith("/bot-qq.js"));
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "./core.js" && context.parentURL &&
      (fromBotQq(context) || context.parentURL.endsWith("/auto-reply.js"))) {
    return { url: CORE_SPY, shortCircuit: true };
  }
  if (specifier === "./special-content.js" && fromBotQq(context)) {
    return { url: SPECIAL_SPY, shortCircuit: true };
  }
  if (builtins.has(specifier) || specifier.startsWith(".") || specifier.startsWith("/") ||
      specifier.startsWith("data:") || specifier.startsWith("file:")) {
    return nextResolve(specifier, context);
  }
  if (specifier === "ws") return { url: WS, shortCircuit: true };
  if (specifier === "axios") return { url: AX, shortCircuit: true };
  return { url: GEN, shortCircuit: true };
}
`);
register(hookUrl, import.meta.url);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const WS = (await import("ws")).default;
const { handleQqWs } = await import("./bot-qq.js");

handleQqWs().catch(() => {});
for (let i = 0; i < 100 && !WS.handlers.message; i++) await sleep(20);
check("bot-qq 消息处理器已注册", typeof WS.handlers.message, "function");

globalThis.__coreCalls = [];
await WS.handlers.message(Buffer.from(JSON.stringify({
  post_type: "message", message_type: "private", user_id: "222333444", self_id: "999000",
  message_id: 9, time: Math.floor(Date.now() / 1000),
  message: [{ type: "text", data: { text: "你好呀今天过得怎么样" } }],
})));
await sleep(80);

const directCall = globalThis.__coreCalls.find((call) => call.sessionId === "qq_222333444");
check("direct 私聊仍走 core 引擎", Boolean(directCall), true);
check("direct 工具白名单=DIRECT_TOOLS 全量", directCall?.options?.toolAllowlist, DIRECT_TOOLS);
check("core 不再收到 autoSkipMarker 选项", directCall?.options?.autoSkipMarker, undefined);

// ---- 5. auto 全流程：[[SKIP]] 不发送，正常文本才发送并记冷却 ----
const qq = await import("./bot-qq.js");
const groupId = "888777666";
const ws = new WS("ws://stub");
const sentToGroup = () => (globalThis.__specialSends || []).some((send) => String(send.targetId) === groupId);
const autoPayload = () => ({
  groupId, selfId: "999000", botName: "Yuragi", senderId: "123456",
  messageId: "1", text: "今天天气不错", score: 0.7,
  valueResult: { score: 0.7 }, messageVector: null,
  clearGeneration: qq.getGroupHistoryGeneration(groupId),
});

globalThis.__coreCalls = [];
globalThis.__coreResult = "[[SKIP]]";
globalThis.__specialSends = [];
qq.getGroupTalkState(groupId).autoReplyInFlight = true;
await runAutoReply(ws, autoPayload());
check("auto 走 core 引擎（会话带 _auto）", globalThis.__coreCalls[0]?.sessionId, `qq_group_${groupId}_auto`);
check("auto 工具白名单=AUTO_TOOLS", globalThis.__coreCalls[0]?.options?.toolAllowlist, AUTO_TOOLS);
check("auto 命中 [[SKIP]] 不发送", sentToGroup(), false);
check("auto 结束后释放 inFlight", qq.getGroupTalkState(groupId).autoReplyInFlight, false);
check("auto 静默不记冷却", qq.getGroupTalkState(groupId).lastAutoTalkAt, 0);

globalThis.__coreResult = "哈哈是啊";
globalThis.__specialSends = [];
qq.getGroupTalkState(groupId).autoReplyInFlight = true;
await runAutoReply(ws, autoPayload());
check("auto 正常文本已发送", sentToGroup(), true);
check("auto 发送内容正确", globalThis.__specialSends[0]?.message, "哈哈是啊");
check("auto 正常文本记录冷却", qq.getGroupTalkState(groupId).lastAutoTalkAt > 0, true);

console.log(`\n结果：${failures === 0 ? "全部通过" : failures + " 项失败"}`);
process.exit(failures === 0 ? 0 : 1);