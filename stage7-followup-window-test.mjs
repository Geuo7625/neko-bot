// 第二部分自测：自动回复追问窗口。
// 直接测试真实模块：message-value.js（looksLikeQuestion/scoreContent/decide）
// 与 auto-reply-cooldown.js（isGroupCoolingDown）。零外部依赖。
// 运行：node stage7-followup-window-test.mjs
import { RUNTIME_CONFIG } from "./config.js";
import { looksLikeQuestion, scoreContent, decide } from "./message-value.js";
import { isGroupCoolingDown } from "./auto-reply-cooldown.js";

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name} (期望 ${expected}, 实际 ${actual})`);
}

// ---- 1. looksLikeQuestion 抽取后行为 ----
check("疑问词识别", looksLikeQuestion("为什么会这样"), true);
check("吗/呢结尾识别", looksLikeQuestion("你今天在吗"), true);
check("问号识别", looksLikeQuestion("什么意思？"), true);
check("假问题-这什么", looksLikeQuestion("这什么"), false);
check("闲聊非疑问", looksLikeQuestion("今天天气不错啊"), false);
check("纯语气非疑问", looksLikeQuestion("哈哈哈哈哈"), false);

// scoreContent 行为保持一致（疑问加 0.15）。
check("scoreContent 疑问仍加 0.15", scoreContent("为什么会这样"), 0.15);
check("scoreContent 闲聊不加分", scoreContent("今天天气不错啊"), 0);

// ---- 2. 追问窗口 + 冷却 + decide 打分 ----
// 与 bot-qq.js 中 isFollowUp 表达式一致（复用真实 looksLikeQuestion 与配置）。
function computeIsFollowUp(groupState, now, scoreText) {
  const configured = Number(RUNTIME_CONFIG.autoFollowUpWindowMs);
  const windowMs = Number.isFinite(configured) ? Math.max(0, configured) : 90000;
  return Boolean(groupState.lastAutoTalkAt > 0 &&
    (now - groupState.lastAutoTalkAt) < windowMs &&
    looksLikeQuestion(scoreText));
}

const newState = (overrides = {}) => ({
  lastAutoTalkAt: 0, autoTalkTimes: [], autoReplyInFlight: false, ...overrides,
});

const now = Date.now();
const question = "为什么会这样";
const chitchat = "今天天气不错啊";

// 2a. bot 刚发完言，来一条问题消息 → 不冷却（跳过发言冷却）。
let state = newState({ lastAutoTalkAt: now });
let isFollowUp = computeIsFollowUp(state, now, question);
check("刚发言后的追问 isFollowUp=true", isFollowUp, true);
check("刚发言后的追问 coolingDown=false", isGroupCoolingDown(state, now, { ignoreRecentTalk: isFollowUp }), false);

// decide() 在冷却被豁免后正常打分：无加成时 0.60 低于阈值，有加成 0.68 过阈值。
const signals = { valueScore: 0.6, topicContinuity: 0.6, willingness: 0.6, contentScore: 0.6 };
const claim = () => true;
const ctxNoBonus = { direct: false, hardVeto: false, coolingDown: false, isFollowUp: false, recentSpeech: [], claimAuto: claim, ...signals };
const dNoBonus = decide(question, ctxNoBonus);
check("追问无加成时分数=0.600", Number(ctxNoBonus.score.toFixed(3)), 0.6);
check("追问无加成低于阈值→ignore", dNoBonus, "ignore");

const ctxBonus = { direct: false, hardVeto: false, coolingDown: false, isFollowUp: true, recentSpeech: [], claimAuto: claim, ...signals };
const dBonus = decide(question, ctxBonus);
check("追问加成后分数=0.680", Number(ctxBonus.score.toFixed(3)), 0.68);
check("追问加成后正常打分→auto", dBonus, "auto");

// 2b. 刚发言后来一条非问题闲聊 → 仍然冷却。
state = newState({ lastAutoTalkAt: now });
isFollowUp = computeIsFollowUp(state, now, chitchat);
check("闲聊 isFollowUp=false", isFollowUp, false);
check("刚发言后的闲聊 coolingDown=true", isGroupCoolingDown(state, now, { ignoreRecentTalk: isFollowUp }), true);

// 2c. 上次发言已过 120 秒（超出 90 秒窗口）的问题消息 → 仍然冷却。
state = newState({ lastAutoTalkAt: now - 120000 });
isFollowUp = computeIsFollowUp(state, now, question);
check("超窗追问 isFollowUp=false", isFollowUp, false);
check("超窗追问 coolingDown=true", isGroupCoolingDown(state, now, { ignoreRecentTalk: isFollowUp }), true);

// 2d. 追问只豁免发言冷却，不豁免 hourly 上限与 inFlight。
state = newState({ lastAutoTalkAt: now, autoTalkTimes: [now, now, now] });
check("追问不豁免 hourly 上限", isGroupCoolingDown(state, now, { ignoreRecentTalk: true }), true);
state = newState({ lastAutoTalkAt: now, autoReplyInFlight: true });
check("追问不豁免 inFlight", isGroupCoolingDown(state, now, { ignoreRecentTalk: true }), true);

// 2e. 窗口配成 0 时关闭。
const savedWindow = RUNTIME_CONFIG.autoFollowUpWindowMs;
RUNTIME_CONFIG.autoFollowUpWindowMs = 0;
state = newState({ lastAutoTalkAt: now });
check("窗口=0 时功能关闭", isGroupCoolingDown(state, now, { ignoreRecentTalk: computeIsFollowUp(state, now, question) }), true);
RUNTIME_CONFIG.autoFollowUpWindowMs = savedWindow;

console.log(`\n结果：${failures === 0 ? "全部通过" : failures + " 项失败"}`);
process.exit(failures === 0 ? 0 : 1);