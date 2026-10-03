import { RUNTIME_CONFIG } from "./config.js";

// 群消息清洗与自动仲裁硬过滤；正向意愿只在 decide() 中融合。
// 不依赖 QQ/NapCat；供 bot-qq.js 与 value-score.js 共用。

const CQ_CODE_PATTERN = /\[CQ:[^\]]*\]/giu;
const TEXT_MENTION_PATTERN = /@(?:全体成员|全体|[1-9]\d{4,11})(?!\d)/gu;
const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>]+/giu;
const CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;
// 仅用于识别需硬否决的专业求助，不参与普通消息的加分。
const TECHNICAL_REQUEST_PATTERN = /[?？]|(?:怎么|为什么|为何|如何|什么|为啥|多少|能不能|可不可以|是不是|有没有|咋办|怎么办|求助|请教|帮我)/u;
export const TECH_KEYWORDS = /代码|编程|报错|bug|error|异常|堆栈|stack\s*trace|traceback|部署|服务器|api|接口|数据库|git|python|docker|算法|模型|显存|编译|配置|依赖|程序|脚本|终端|linux|windows|容器|网络|端口|日志|崩溃|安装|运行|npm|node(?:\.js)?|javascript|typescript|java|rust|golang|sql|框架|前端|后端|命令|包管理/iu;
// 明显辱骂只作为硬否决，不用于打分。
const PROFANITY_PATTERN = /(?:操你|草泥马|傻[逼屄]|他妈|妈的|fuck|shit|bitch)/iu;
// 明显导流和促销信息只作为硬否决，不用于打分。
const ADVERTISEMENT_PATTERN = /(?:加群|扫码|推广|广告|返利|优惠券|加微信|微信号|vx号|代购|接单)/iu;
// 低信号/重复刷屏及占位媒体不进入自动仲裁，也供冻结的 KNN 过滤入口复用。
const LOW_SIGNAL_PATTERN = /^(?:嗯+|呃+|额+|哦+|噢+|啊+|唉+|诶+|好+|好的|行|可以|收到|懂了|知道了|ok+|kk+|yep|yeah|哈哈+|呵呵+|嘻嘻+|嘿嘿+|笑死|草+|绝了|牛+|6+|666+|？+|\?+|。+|！+|!+|…+|\.{2,})[。！!？?…~～]*$/iu;
const PLACEHOLDER_PATTERN = /^\[(?:图片|含图片|视频消息|语音消息|文件消息|QQ表情|QQ商城表情|收到特殊QQ消息|收到一条QQ特殊消息)[^\]]*\]$/u;
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

export function isTechnicalQuestion(input) {
  const text = cleanValueText(input);
  if (!TECH_KEYWORDS.test(text)) return false;
  return TECHNICAL_REQUEST_PATTERN.test(text);
}

export function isHardVetoMessage(input, { sensitiveWords = [] } = {}) {
  const text = cleanValueText(input);
  if (isTechnicalQuestion(text) || PROFANITY_PATTERN.test(text) || ADVERTISEMENT_PATTERN.test(text)) return true;
  const normalized = text.toLocaleLowerCase().replace(/\s+/gu, "");
  return sensitiveWords.some((word) => {
    const term = String(word ?? "").toLocaleLowerCase().replace(/\s+/gu, "");
    return term && normalized.includes(term);
  });
}

export function shouldEvaluateMessage(input) {
  const text = cleanValueText(input);
  if (!text) return { eligible: false, reason: "empty", text };
  // 占位媒体和非文本消息由 direct/media 路由处理，不进入自动文本接话。
  if (PLACEHOLDER_PATTERN.test(text)) return { eligible: false, reason: "media-placeholder", text };
  // 单独的链接没有足够上下文供主动回复。
  if (/^(?:\[链接\]|链接|https?:\/\/\S+|www\.\S+)$/iu.test(text)) {
    return { eligible: false, reason: "link-only", text };
  }
  // 纯符号、命令、低信号短语和重复字符属于硬过滤，不是评分加分项。
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

export function scoreContent(input, { direct = false, botName = "" } = {}) {
  const text = cleanValueText(input);
  const chars = Array.from(text).length;
  let score = 0;

  // 常见疑问词直接表明有问题；“什么”排除无实际提问的固定口语。
  const hasQuestionWord = /怎么|如何|为什么|有没有/u.test(text) ||
    (/什么/u.test(text) && !/(?:没什么|这什么|那什么)/u.test(text));
  const endsWithQuestionParticle = chars >= 4 && chars <= 80 && /(?:吗|呢)[？?!！。…~～]*$/u.test(text);
  const hasQuestionMark = chars >= 4 && chars <= 120 && /[？?]/u.test(text);
  if (hasQuestionWord || endsWithQuestionParticle || hasQuestionMark) score += 0.15;

  const explicitHelp = /帮我|帮忙|请问|可以吗|要不要/u.test(text) ||
    (direct ? /能不能/u.test(text) : /^能不能/u.test(text));
  const contextualHelp = direct && /需要|求|看看|试试/u.test(text);
  if (explicitHelp || contextualHelp) score += 0.20;

  const asksOpinion = /你觉得|你认为|咋看|有什么建议|你怎么看|怎么看你/u.test(text);
  const mentionsBotName = String(botName ?? "").trim() &&
    text.toLocaleLowerCase().includes(String(botName).trim().toLocaleLowerCase());
  if (asksOpinion && (direct || mentionsBotName)) score += 0.20;

  if (LOW_SIGNAL_PATTERN.test(text)) score -= 0.25;
  return Math.max(0, Math.min(1, Number(score.toFixed(4))));
}

export function decide(message, context = {}) {
  // 明确呼叫优先，直达原有生成/媒体流程且不受自动冷却影响。
  if (context.direct) return "direct";
  // 硬否决和冷却只拦截自动接话；不进入灰度评分或云端调用。
  if (context.hardVeto || context.coolingDown || !shouldEvaluateMessage(message).eligible) return "ignore";

  const signals = [];
  const addSignal = (value, weight, abstain = false) => {
    if (abstain || value === null || value === undefined || !Number.isFinite(Number(value))) return;
    signals.push({ value: clampScore(value), weight: Math.max(0, Number(weight) || 0) });
  };
  addSignal(context.valueScore, RUNTIME_CONFIG.autoValueScoreWeight, context.valueAbstain === true);
  addSignal(context.topicContinuity, RUNTIME_CONFIG.autoTopicContinuityWeight);
  addSignal(context.willingness, RUNTIME_CONFIG.autoWillingnessWeight);
  addSignal(context.contentScore, RUNTIME_CONFIG.autoContentScoreWeight);
  const weightTotal = signals.reduce((total, signal) => total + Math.max(0, signal.weight), 0);
  const weightedScore = weightTotal > 0
    ? signals.reduce((total, signal) => total + signal.value * Math.max(0, signal.weight), 0) / weightTotal
    : 0;
  const speech = Array.isArray(context.recentSpeech) ? context.recentSpeech : [];
  const botRatio = speech.length
    ? speech.filter((entry) => entry?.isBot === true).length / speech.length
    : 0;
  const configuredSoftRatio = Number(RUNTIME_CONFIG.autoPresenceSoftRatio);
  const configuredMaxRatio = Number(RUNTIME_CONFIG.autoPresenceMaxRatio);
  const configuredMaxPenalty = Number(RUNTIME_CONFIG.autoPresenceMaxPenalty);
  const softRatio = Number.isFinite(configuredSoftRatio) ? configuredSoftRatio : 0.25;
  const maxRatio = Number.isFinite(configuredMaxRatio) ? configuredMaxRatio : 0.6;
  const maxPenalty = Number.isFinite(configuredMaxPenalty) ? configuredMaxPenalty : 0.25;
  const presencePenalty = botRatio <= softRatio || maxRatio <= softRatio
    ? 0
    : Math.min(maxPenalty, Math.max(0, (botRatio - softRatio) / (maxRatio - softRatio)) * maxPenalty);
  const score = Math.max(0, Math.min(1, weightedScore - presencePenalty));
  context.score = score;
  context.presencePenalty = presencePenalty;
  // 过阈值后原子占位，防止并发消息重复启动 auto 生成。
  if (score < Number(RUNTIME_CONFIG.autoDecisionThreshold)) return "ignore";
  if (typeof context.claimAuto === "function" && !context.claimAuto()) return "ignore";
  return "auto";
}

function clampScore(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}
