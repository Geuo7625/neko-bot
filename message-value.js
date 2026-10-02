import { RUNTIME_CONFIG } from "./config.js";

// 群消息清洗、筛选、规则加分与向量分融合。
// 不依赖 QQ/NapCat；供 bot-qq.js 与 value-score.js 共用。

const CQ_CODE_PATTERN = /\[CQ:[^\]]*\]/giu;
const TEXT_MENTION_PATTERN = /@(?:全体成员|全体|[1-9]\d{4,11})(?!\d)/gu;
const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>]+/giu;
const CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;
const QUESTION_PATTERN = /[?？]/u;
const QUESTION_END_PATTERN = /(?:吗|呢)[?？!！。…~～]*$/u;
const QUESTION_START_PATTERN = /^(?:怎么|为什么|为何|如何|什么|为啥|多少|能不能|可不可以|是不是|有没有|哪(?:个|些|里|种|位|家)?|谁|何时|几时|咋|咋办)/u;
const HELP_PATTERN = /帮我|帮忙|请问|请教|麻烦(?:你|帮我)?|翻译(?:一下|下)?|总结(?:一下|下)?|概括一下|写一个|写一份|生成一个|推荐(?:一下|几个|一些)?|怎么办|怎么做|教我|解释一下|查一下|分析一下|修一下|看看(?:这个|这段|下)?|能否帮|可否帮|求助/u;
const BOT_TERM_PATTERN = /机器人|人工智能|智能助手|助手|小猫|猫娘|(?:^|[^a-z0-9_])ai(?:$|[^a-z0-9_])|(?:^|[^a-z0-9_])bot(?:$|[^a-z0-9_])|(?:^|[^a-z0-9_])llm(?:$|[^a-z0-9_])/iu;
const LOW_SIGNAL_PATTERN = /^(?:嗯+|呃+|额+|哦+|噢+|啊+|唉+|诶+|好+|好的|行|可以|收到|懂了|知道了|ok+|kk+|yep|yeah|哈哈+|呵呵+|嘻嘻+|嘿嘿+|笑死|草+|绝了|牛+|6+|666+|？+|\?+|。+|！+|!+|…+|\.{2,})[。！!？?…~～]*$/iu;
const PLACEHOLDER_PATTERN = /^\[(?:图片|含图片|视频消息|语音消息|文件消息|QQ表情|QQ商城表情|收到特殊QQ消息|收到一条QQ特殊消息)[^\]]*\]$/u;
const BOT_NAME_WEIGHT = 0.82;
const SHORT_BOT_TOPIC_BONUS = 0.30;
const SHORT_BOT_TOPIC_MAX_CHARS = 36;
const MAX_TEXT_CHARS = 600;

export function cleanValueText(input) {
  let text = String(input ?? "").normalize("NFKC");
  text = text
    .replace(CQ_CODE_PATTERN, " ")
    .replace(CONTROL_PATTERN, " ")
    .replace(TEXT_MENTION_PATTERN, " ")
    .replace(URL_PATTERN, " [链接] ")
    .replace(/[\u200B-\u200D\uFEFF]/gu, "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+/gu, " ")
    .replace(/\s*\n\s*/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const chars = Array.from(text);
  if (chars.length > MAX_TEXT_CHARS) text = chars.slice(0, MAX_TEXT_CHARS).join("");
  return text;
}

function normalizeName(input) {
  return cleanValueText(input)
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s_]+/gu, "");
}

function levenshteinAtMostOne(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  if (i < a.length || j < b.length) edits++;
  return edits <= 1;
}

function hasBotName(text, botName) {
  const normalizedText = normalizeName(text);
  const names = [...new Set(["Yuragi", "ゆらぎ", botName].map(normalizeName).filter((name) => name.length >= 2))];
  if (names.some((name) => normalizedText.includes(name))) return true;

  // 拉丁字母昵称允许一个字符的轻微拼写差异（如 Yuragii / Yuragi）。
  const words = cleanValueText(text).toLocaleLowerCase().match(/[a-z][a-z0-9]{3,}/gu) || [];
  const latinNames = names.filter((name) => /^[a-z][a-z0-9]{4,}$/u.test(name));
  return words.some((word) => latinNames.some((name) => levenshteinAtMostOne(word, name)));
}

export function shouldEvaluateMessage(input) {
  const text = cleanValueText(input);
  if (!text) return { eligible: false, reason: "empty", text };
  if (PLACEHOLDER_PATTERN.test(text)) return { eligible: false, reason: "media-placeholder", text };
  if (/^(?:\[链接\]|链接|https?:\/\/\S+|www\.\S+)$/iu.test(text)) {
    return { eligible: false, reason: "link-only", text };
  }
  if (/^[\p{P}\p{S}\s]+$/u.test(text)) return { eligible: false, reason: "symbols-only", text };
  if (/^(?:\/[\w\p{L}-]+|！?\/[^\s]{1,40})$/u.test(text)) {
    return { eligible: false, reason: "command", text };
  }
  if (LOW_SIGNAL_PATTERN.test(text)) return { eligible: false, reason: "low-signal", text };
  if (Array.from(text.replace(/\[链接\]/gu, "").trim()).length < 2) {
    return { eligible: false, reason: "too-short", text };
  }
  if (/^(.)\1{7,}$/u.test(text)) return { eligible: false, reason: "repeated-character", text };
  return { eligible: true, reason: null, text };
}

export function evaluateMessageValue(input, botName = "") {
  const text = cleanValueText(input);
  const filter = shouldEvaluateMessage(text);
  const reasons = [];
  let ruleScore = 0;

  const isQuestion = QUESTION_PATTERN.test(text) || QUESTION_END_PATTERN.test(text) || QUESTION_START_PATTERN.test(text);
  if (isQuestion) {
    ruleScore += 0.25;
    reasons.push("question");
  }

  const isHelpRequest = HELP_PATTERN.test(text);
  if (isHelpRequest) {
    ruleScore += 0.52;
    reasons.push("help");
  }

  const mentionsBotTopic = BOT_TERM_PATTERN.test(text);
  if (mentionsBotTopic) {
    ruleScore += 0.32;
    reasons.push("bot-topic");
    // 简短的 AI / bot / 机器人相关消息也交给 AI 判断是否是在叫它。
    if (Array.from(text).length <= SHORT_BOT_TOPIC_MAX_CHARS) {
      ruleScore += SHORT_BOT_TOPIC_BONUS;
      reasons.push("short-bot-topic");
    }
  }

  const isBotNameCall = hasBotName(text, botName);
  if (isBotNameCall) {
    ruleScore += BOT_NAME_WEIGHT;
    reasons.push("bot-name");
  }

  ruleScore = Math.min(1, Number(ruleScore.toFixed(4)));
  return {
    text,
    eligible: filter.eligible,
    filterReason: filter.reason,
    ruleScore,
    reasons,
    isQuestion,
    isHelpRequest,
    mentionsBotTopic,
    isBotNameCall,
  };
}

export function combineMessageValue(ruleResult, vectorResult = null) {
  const ruleScore = Math.max(0, Math.min(1, Number(ruleResult?.ruleScore) || 0));
  const vectorScore = Number(vectorResult?.score);
  const topSimilarity = Number(vectorResult?.topSimilarity);
  const vectorConfident =
    vectorResult?.lowConfidence !== true &&
    Number.isFinite(vectorScore) &&
    Number.isFinite(topSimilarity) &&
    topSimilarity >= 0.5;

  // 样例匹配可信时，沿用 KNN 投票分并叠加规则信号；低置信度时只看规则分。
  const combinedScore = ruleResult?.eligible === false
    ? 0
    : vectorConfident
      // 明确求助/点名等规则信号不能被低 KNN 投票压没；规则分同时提供有限加成。
      ? Math.min(1, Math.max(0, vectorScore, ruleScore) + Math.min(0.2, ruleScore * 0.2))
      : ruleScore;
  const normalizedScore = Number(combinedScore.toFixed(4));

  return {
    ...ruleResult,
    vectorScore: Number.isFinite(vectorScore) ? vectorScore : null,
    topSimilarity: Number.isFinite(topSimilarity) ? topSimilarity : null,
    vectorConfident,
    combinedScore: normalizedScore,
    highValue: ruleResult?.eligible !== false && normalizedScore >= (Number.isFinite(Number(RUNTIME_CONFIG.autoChimeScoreThreshold)) ? Number(RUNTIME_CONFIG.autoChimeScoreThreshold) : 0.5),
  };
}

/**
 * Decide whether a cleaned message deserves a contextual LLM check.
 * This is intentionally broad: local rules filter obvious noise, while the LLM
 * decides semantic relevance. API traffic is bounded by the per-group cooldown
 * and debounce in bot-qq.js.
 */
export function shouldAskAiAboutMessage(input, { recentBotReply = false, vectorHighValue = false } = {}) {
  const filtered = shouldEvaluateMessage(input);
  if (!filtered.eligible) return { candidate: false, reason: filtered.reason, text: filtered.text };
  const text = filtered.text;
  const chars = Array.from(text).length;
  if (recentBotReply) return { candidate: true, reason: "recent-bot-reply", text };
  if (vectorHighValue) return { candidate: true, reason: "vector-or-rule-high-value", text };
  // Any meaningful sentence can be evaluated; there is no need to enumerate every
  // possible question wording. Very short messages only pass if the existing rules
  // found a question/request/bot reference.
  const hasExplicitSignal = /[?？]/u.test(text) || QUESTION_END_PATTERN.test(text) ||
    QUESTION_START_PATTERN.test(text) || HELP_PATTERN.test(text) || BOT_TERM_PATTERN.test(text);
  if (chars >= 3 || hasExplicitSignal) {
    return { candidate: true, reason: hasExplicitSignal ? "explicit-signal" : "substantive-text", text };
  }
  return { candidate: false, reason: "too-short-for-llm-check", text };
}
