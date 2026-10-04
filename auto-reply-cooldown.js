// ============================================================
// 自动接话冷却判定：唯一来源。
// inFlight 并发保护与 hourly 上限永远生效；
// “距上次发言不足冷却时长”这一条可被追问窗口豁免。
// ============================================================
import { RUNTIME_CONFIG } from "./config.js";

export function isGroupCoolingDown(state, now = Date.now(), { ignoreRecentTalk = false } = {}) {
  const cooldownMs = Math.max(0, Number(RUNTIME_CONFIG.autoTalkCooldownMs) || 180000);
  const hourlyWindowMs = Math.max(60000, Number(RUNTIME_CONFIG.autoTalkHourlyWindowMs) || 3600000);
  const hourlyLimit = Math.max(1, Number(RUNTIME_CONFIG.autoTalkHourlyLimit) || 3);
  state.autoTalkTimes = state.autoTalkTimes.filter((at) => now - at < hourlyWindowMs);
  return state.autoReplyInFlight ||
    (!ignoreRecentTalk && now - state.lastAutoTalkAt < cooldownMs) ||
    state.autoTalkTimes.length >= hourlyLimit;
}