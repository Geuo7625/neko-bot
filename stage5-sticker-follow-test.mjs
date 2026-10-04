// 表情包“跟队形”离线自测：不连 NapCat，用注入的 send 收集发送动作。
// 运行：node stage5-sticker-follow-test.mjs
import { RUNTIME_CONFIG } from "./config.js";
import { maybeFollowMemePattern } from "./sticker-follow.js";

const sent = [];
const fakeWs = {};
const send = async (ws, groupId, segment) => {
  sent.push({ groupId, segment });
};

const mface = (summary) => ({ type: "mface", data: { emoji_package_id: 1, emoji_id: 2, key: "k", summary } });
const segA = mface("A");
const segB = mface("B");

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name} (期望 ${expected}, 实际 ${actual})`);
}

const selfId = "999000";

// 场景1：同群 30 秒内 3 个不同用户发同一 mface → 第 3 次触发跟随。
const g1 = "g-follow";
check("3人同图第1次不触发", await maybeFollowMemePattern({ seg: segA, senderId: "u1", groupId: g1, selfId, ws: fakeWs, send }), false);
check("3人同图第2次不触发", await maybeFollowMemePattern({ seg: segA, senderId: "u2", groupId: g1, selfId, ws: fakeWs, send }), false);
check("3人同图第3次触发", await maybeFollowMemePattern({ seg: segA, senderId: "u3", groupId: g1, selfId, ws: fakeWs, send }), true);
check("已跟过的同图不再触发", await maybeFollowMemePattern({ seg: segA, senderId: "u4", groupId: g1, selfId, ws: fakeWs, send }), false);
const last = sent[sent.length - 1];
check("原样回发原始 mface", JSON.stringify(last.segment) === JSON.stringify(segA), true);
check("回发目标为该群", last.groupId === g1, true);

// 场景2：同一用户连发 3 次 → distinctUsers=true 不触发。
const g2 = "g-same-user";
check("同人连发第3次不触发", await maybeFollowMemePattern({ seg: segB, senderId: "u1", groupId: g2, selfId, ws: fakeWs, send }), false);

// 场景3：同群已有一次队形后，10 分钟内换另一张图再组队形 → 冷却不触发。
const g3 = "g-cooldown";
const segC = mface("C");
const segD = mface("D");
await maybeFollowMemePattern({ seg: segC, senderId: "u1", groupId: g3, selfId, ws: fakeWs, send });
await maybeFollowMemePattern({ seg: segC, senderId: "u2", groupId: g3, selfId, ws: fakeWs, send });
check("冷却前首次队形触发", await maybeFollowMemePattern({ seg: segC, senderId: "u3", groupId: g3, selfId, ws: fakeWs, send }), true);
await maybeFollowMemePattern({ seg: segD, senderId: "u1", groupId: g3, selfId, ws: fakeWs, send });
await maybeFollowMemePattern({ seg: segD, senderId: "u2", groupId: g3, selfId, ws: fakeWs, send });
check("10分钟内第二次队形不触发", await maybeFollowMemePattern({ seg: segD, senderId: "u3", groupId: g3, selfId, ws: fakeWs, send }), false);

// 场景4：bot 自己发的 mface 不计入（3 次自己 + 2 个真人 = 只算 2 次）。
const g4 = "g-self";
const segE = mface("E");
await maybeFollowMemePattern({ seg: segE, senderId: selfId, groupId: g4, selfId, ws: fakeWs, send });
await maybeFollowMemePattern({ seg: segE, senderId: selfId, groupId: g4, selfId, ws: fakeWs, send });
await maybeFollowMemePattern({ seg: segE, senderId: selfId, groupId: g4, selfId, ws: fakeWs, send });
await maybeFollowMemePattern({ seg: segE, senderId: "u1", groupId: g4, selfId, ws: fakeWs, send });
check("bot自己发的mface不计入", await maybeFollowMemePattern({ seg: segE, senderId: "u2", groupId: g4, selfId, ws: fakeWs, send }), false);

// 场景5：总开关关闭时完全不跟。
RUNTIME_CONFIG.stickerFollowEnabled = false;
const g5 = "g-disabled";
const segF = mface("F");
await maybeFollowMemePattern({ seg: segF, senderId: "u1", groupId: g5, selfId, ws: fakeWs, send });
await maybeFollowMemePattern({ seg: segF, senderId: "u2", groupId: g5, selfId, ws: fakeWs, send });
check("总开关关闭不触发", await maybeFollowMemePattern({ seg: segF, senderId: "u3", groupId: g5, selfId, ws: fakeWs, send }), false);
RUNTIME_CONFIG.stickerFollowEnabled = true;

console.log(`\n结果：${failures === 0 ? "全部通过" : failures + " 项失败"}；共发送 ${sent.length} 次`);
process.exit(failures === 0 ? 0 : 1);