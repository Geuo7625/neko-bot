// 第一部分自测：表情包私聊修复。
// 通过 loader 钩子注入离线依赖桩，加载真实 bot-qq.js，并拦截 handleMfaceMessage 记录调用。
// 因此无需 node_modules，可在任意环境运行：node stage6-sticker-private-test.mjs
import { register } from "node:module";

const dataUrl = (source) => "data:text/javascript," + encodeURIComponent(source);

// 行为桩：ws（保留 EventEmitter 语义，暴露 handlers 供测试驱动事件）。
const wsStubUrl = dataUrl(`
import { EventEmitter } from "node:events";
class WebSocket extends EventEmitter {
  constructor(url) { super(); this.url = url; this.readyState = WebSocket.OPEN; WebSocket.last = this; queueMicrotask(() => this.emit("open")); }
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

// 行为桩：axios（记录出站调用，供断言回复内容）。
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

// 通用桩：其余外部依赖（@lancedb/lancedb、@huggingface/transformers、playwright 等）。
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

// 收集器 spy：只拦截 bot-qq.js 对 ./sticker-collector.js 的引用，避免写生产表情包库。
const collectorHref = new URL("./sticker-collector.js", import.meta.url).href;
const spyUrl = dataUrl(`
import * as real from ${JSON.stringify(collectorHref)};
export const handleMfaceMessage = (seg, senderId, groupId, isOwner) => {
  (globalThis.__mfaceCalls ||= []).push({ senderId, groupId, isOwner });
  return Promise.resolve();
};
export const approveSticker = real.approveSticker;
export const STICKERS_DIR = real.STICKERS_DIR;
`);

const hookUrl = dataUrl(`
import { builtinModules } from "node:module";
const builtins = new Set([...builtinModules, ...builtinModules.map((m) => "node:" + m)]);
const WS = ${JSON.stringify(wsStubUrl)};
const AX = ${JSON.stringify(axiosStubUrl)};
const GEN = ${JSON.stringify(genericStubUrl)};
const SPY = ${JSON.stringify(spyUrl)};
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "./sticker-collector.js" && context.parentURL && context.parentURL.endsWith("/bot-qq.js")) {
    return { url: SPY, shortCircuit: true };
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

const WS = (await import("ws")).default;
const axiosStub = (await import("axios")).default;
const { handleQqWs } = await import("./bot-qq.js");
const { runStickerSelfTest } = await import("./sticker-sender.js");

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name} (期望 ${expected}, 实际 ${actual})`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

handleQqWs().catch(() => {});
for (let i = 0; i < 100 && !WS.handlers.message; i++) await sleep(20);
check("消息处理器已注册", typeof WS.handlers.message, "function");

const OWNER = "1036618389";
const mfaceSeg = { type: "mface", data: { emoji_package_id: 1, emoji_id: 2, key: "k", summary: "A" } };
const repliedWithCollect = () => axiosStub.calls.some((call) =>
  Array.isArray(call.params?.message) &&
  call.params.message.some((seg) => seg.type === "text" && String(seg.data?.text || "").includes("表情包已收藏")),
);

// 私聊主人发纯 mface → 触发收集，并直接回复“已收藏”。
globalThis.__mfaceCalls = [];
axiosStub.calls.length = 0;
const privateOwnerEvent = {
  post_type: "message", message_type: "private", user_id: OWNER, self_id: "999000",
  message_id: 1, time: Math.floor(Date.now() / 1000), message: [mfaceSeg],
};
await WS.handlers.message(Buffer.from(JSON.stringify(privateOwnerEvent)));
await sleep(50);

check("私聊主人 mface 触发收集", globalThis.__mfaceCalls.length, 1);
check("私聊收集 groupId=null", globalThis.__mfaceCalls[0]?.groupId, null);
check("私聊收集 isOwner=true", globalThis.__mfaceCalls[0]?.isOwner, true);
check("私聊纯 mface 回复已收藏", repliedWithCollect(), true);

// 带文字的私聊 mface 不走短路（应该进入 LLM 流程）。
globalThis.__mfaceCalls = [];
axiosStub.calls.length = 0;
const withText = {
  ...privateOwnerEvent, message_id: 2,
  message: [{ type: "text", data: { text: "看看这张" } }, mfaceSeg],
};
await WS.handlers.message(Buffer.from(JSON.stringify(withText)));
await sleep(50);
check("带文字 mface 不走收藏短路", repliedWithCollect(), false);

// 修复1：测试指令在私聊时不再被私聊发送开关拦截。
const selfTest = await runStickerSelfTest({}, OWNER, false);
check("表情包测试私聊不再 FAIL 私聊门控", String(selfTest).includes("私聊"), false);
console.log(`   （表情包测试返回：${selfTest}）`);

console.log(`\n结果：${failures === 0 ? "全部通过" : failures + " 项失败"}`);
process.exit(failures === 0 ? 0 : 1);