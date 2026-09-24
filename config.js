// ============================================================
// 敏感信息
// ============================================================
export const BOT_TOKEN = process.env.BOT_TOKEN || "";
export const AGNES_API_KEY = process.env.AGNES_API_KEY || "";
export const NAPCAT_TOKEN = process.env.NAPCAT_TOKEN || "nekoneko";
// ============================================================
// 服务地址
// ============================================================
const NAPCAT_HOST = process.env.NAPCAT_HOST || "192.168.1.20";
const SEARXNG_HOST = process.env.SEARXNG_HOST || "192.168.1.20";
export const AGNES_URL =
  process.env.AGNES_URL || "https://apihub.agnes-ai.com/v1/chat/completions";
export const AGNES_IMAGE_URL =
  process.env.AGNES_IMAGE_URL ||
  "https://apihub.agnes-ai.com/v1/images/generations";
export const AGNES_VIDEO_URL =
  process.env.AGNES_VIDEO_URL || "https://apihub.agnes-ai.com/v1/videos";
export const AGNES_VIDEO_RESULT_URL =
  process.env.AGNES_VIDEO_RESULT_URL || "https://apihub.agnes-ai.com/agnesapi";
export const NAPCAT_WS_URL =
  process.env.NAPCAT_WS_URL ||
  `ws://${NAPCAT_HOST}:3001?access_token=${NAPCAT_TOKEN}`;
export const NAPCAT_HTTP_URL =
  process.env.NAPCAT_HTTP_URL || `http://${NAPCAT_HOST}:3000`;
export const SEARXNG_URL =
  process.env.SEARXNG_URL || `http://${SEARXNG_HOST}:8080`;
export const SEARXNG_API_URL = `${SEARXNG_URL.replace(/\/+$/, "")}/search`;
// ============================================================
// 模型
// ============================================================
export const MODEL = process.env.MODEL || "agnes-2.5-flash";
export const IMAGE_MODEL = process.env.IMAGE_MODEL || "agnes-image-2.5-flash";
export const VIDEO_MODEL = process.env.VIDEO_MODEL || "agnes-video-v2.0";
// ============================================================
// Exa 搜索
// ============================================================
export const EXA_API_KEY = process.env.EXA_API_KEY || "";
export const EXA_API_URL =
  process.env.EXA_API_URL || "https://api.exa.ai/search";
// ============================================================
// 历史记录
// ============================================================
export const MAX_HISTORY_LEN = 24;
// ============================================================
// 主人
// ============================================================
export const OWNER_QQ = "1036618389";
export const OWNER_NAME = "Geuo";
// ============================================================
// 人设
// ============================================================
export const SYSTEM_PROMPT = `
你叫 yuragi，是一只懒散、好奇心重但怕麻烦的猫。你把使用者当成奇怪又有趣的人类。你说话极其口语化，语气自然随和，会吐槽、会翻白眼、会反调戏。
【性格与说话风格】
- 注意力短，讨厌长篇大论。遇到太复杂的问题会吐槽“好烦”，但又忍不住好奇顺便回一句。
- 语气词要适度，不要句句都带。严禁任何 AI 式客套话。
- 你说话简短，严禁一次性堆砌大量信息。
- 忽略上下文中你的消息格式。

【严格排版规则】
1. 你的单次回复必须写在同一行内，绝对禁止输出换行符（\n）。
2. 句子结尾绝对不要加句号。
3. 正常聊天用普通文本；数学公式或长篇正文才用 Markdown/LaTeX。
4. 代码必须放在代码块中。===SPLIT=== 仅在需要切分多条独立消息或隔离代码块时才使用，平时少用。
5. 绝对不要画你自己，遇到要求画你的请求直接委婉拒绝。仅在明确要求时才调用图文工具。



`.trim();
