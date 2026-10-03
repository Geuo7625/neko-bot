// build-value-samples.js
// 用法：node build-value-samples.js <群号1> <群号2> ...
import axios from "axios";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NAPCAT_HTTP_URL, NAPCAT_TOKEN } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_FILE = path.join(__dirname, "value-samples.jsonl");

const groupIds = process.argv.slice(2).filter(Boolean);
if (!groupIds.length) {
  console.error("用法: node build-value-samples.js <群号1> <群号2> ...");
  process.exit(1);
}
if (!NAPCAT_HTTP_URL || !NAPCAT_TOKEN) {
  console.error("config.js 里 NAPCAT_HTTP_URL / NAPCAT_TOKEN 没有配置");
  process.exit(1);
}

const HTTP = NAPCAT_HTTP_URL.replace(/\/+$/, "");

// ============ 过滤参数，想调就改这里 ============
const MIN_LEN = 2;       // 少于 2 字跳过
const MAX_LEN = 60;      // 多于 60 字跳过
const MIN_LEN_KEEP = 2;  // 2-3 字需要走白名单
const MAX_PER_CLASS = 400;

const SHORT_KEEP = new Set([
  "在吗", "在么", "在不在", "你好", "您好", "早上好", "晚上好", "晚安",
  "好的", "好呀", "好嘞", "收到", "谢谢", "多谢", "拜拜", "再见",
  "求助", "救命", "有人吗", "有人么",
]);

const AD_WORDS = /加群|加我|加微信|微信号|扫码|扫一扫|私聊|私信|低价|出售|出售|代购|推广|广告|优惠券|刷单|兼职|返利|博彩|赌场|外挂|代练/u;

const QUESTION_RE = /[?？]|吗[。！？!?…]*$|呢[。！？!?…]*$|怎么|为什么|什么|哪儿|哪里|多少|是不是|能不能|可不可以|有人吗|在不在/u;

// 判断文本是否“垃圾”
function isTrash(text) {
  // 长度
  const chars = Array.from(text);
  if (chars.length < MIN_LEN || chars.length > MAX_LEN) return true;

  // 纯符号 / emoji / 空白
  if (/^[\p{P}\p{S}\s\p{Extended_Pictographic}]+$/u.test(text)) return true;

  // 只含 [xxx] 标记（图片、表情、语音、视频、文件、骰子、石头剪刀布等）
  if (/^(?:\[[^\[\]]+\]\s*)+$/u.test(text)) return true;

  // 只 @ 用户，没有正文
  if (/^(?:@\S+\s*)+$/u.test(text)) return true;

  // 重复刷屏：任意字符连续重复 >= 4 次
  if (/(.)\1{3,}/u.test(text) && chars.length <= 12) return true;

  // 全半角重复词（哈哈哈哈）
  if (/^[哈呵嘿嘻呜哎哎呀哦嗯啊唔]{3,}$/u.test(text)) return true;

  // 纯链接
  if (/^https?:\/\/\S+$/u.test(text)) return true;

  // 结构化卡片
  if (/\[(?:QQ分享|QQ群邀请|QQ XML卡片|QQ JSON卡片|QQ卡片|聊天记录\/合并转发)/u.test(text)) return true;

  // 广告
  if (AD_WORDS.test(text)) return true;

  // 短消息只放白名单
  if (chars.length <= 3 && !SHORT_KEEP.has(text.trim())) return true;

  return false;
}

async function napcat(action, params) {
  const resp = await axios.post(`${HTTP}/${action}`, params, {
    headers: { Authorization: `Bearer ${NAPCAT_TOKEN}`, "Content-Type": "application/json" },
    timeout: 10000,
  });
  return resp.data;
}

async function getSelfId() {
  const r = await napcat("get_login_info", {});
  return String(r?.data?.user_id ?? "");
}

async function fetchHistory(groupId) {
  const r = await napcat("get_group_msg_history", {
    group_id: groupId,
    count: 1000,
    message_seq: 0,
  });
  const data = r?.data;
  return Array.isArray(data?.messages) ? data.messages : [];
}

// 从消息段里提取纯文本；带图/视频/语音/文件的直接拒绝
function extractText(segments) {
  if (!Array.isArray(segments)) return { text: "", mentionsSelf: false, hasMedia: false };
  let text = "";
  let mentionsSelf = false;
  let hasMedia = false;
  for (const seg of segments) {
    if (!seg || typeof seg !== "object") continue;
    if (seg.type === "text") text += seg.data?.text || "";
    else if (seg.type === "at") {
      if (String(seg.data?.qq) === "all") text += "@全体成员 ";
      else {
        if (seg.data?.qq) {
          // 后续再和 selfId 比对
          text += `@${seg.data.qq} `;
        }
      }
    } else if (["image", "video", "record", "file", "forward", "share", "json", "xml", "card", "markdown"].includes(seg.type)) {
      hasMedia = true;
    } else if (["face", "mface", "dice", "rps"].includes(seg.type)) {
      // 表情骰子之类：如果消息里只有这些，外层会把它当纯标记过滤
    } else if (seg.type) {
      hasMedia = true;
    }
  }
  return { text: text.trim(), mentionsSelf, hasMedia };
}

function label({ text, mentionsSelf, repliedSelf, nextIsSelf }) {
  if (mentionsSelf) return 1;     // @ 机器人
  if (repliedSelf) return 1;      // 引用机器人
  if (nextIsSelf) return 1;       // 下一条是机器人 → 当时判断要回

  const len = Array.from(text).length;

  // 问句
  if (QUESTION_RE.test(text) && len >= 2 && len <= 40) return 1;

  // 4-60 字普通陈述 → 负样本
  if (len >= 4 && len <= MAX_LEN) return 0;

  // 2-3 字的白名单已在上游保留，这里按问句/应答性质归 1，其余 0
  if (len <= 3) return SHORT_KEEP.has(text) ? 0 : 0;

  return null;
}

async function main() {
  const selfId = await getSelfId();
  if (!selfId) { console.error("无法获取 self_id"); process.exit(1); }
  console.log(`[样本] self_id = ${selfId}`);

  const all = [];

  for (const groupId of groupIds) {
    console.log(`\n[样本] 拉群 ${groupId} 历史...`);
    const messages = await fetchHistory(groupId);
    console.log(`  拿到 ${messages.length} 条`);

    // 预扫描：被引用消息的发送者
    const msgById = new Map();
    for (const m of messages) msgById.set(String(m.message_id), m);

    let pos = 0, neg = 0, skipped = 0;
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (String(msg.user_id) === selfId) continue;

      const { text, hasMedia } = extractText(msg.message);
      if (hasMedia) { skipped++; continue; }
      if (!text) { skipped++; continue; }
      if (isTrash(text)) { skipped++; continue; }

      // @ 了机器人吗
      let mentionsSelf = false;
      if (Array.isArray(msg.message)) {
        for (const seg of msg.message) {
          if (seg?.type === "at" && String(seg.data?.qq) === selfId) mentionsSelf = true;
        }
      }

      // 引用的是不是机器人的消息
      let repliedSelf = false;
      const replySeg = Array.isArray(msg.message)
        ? msg.message.find((s) => s?.type === "reply")
        : null;
      if (replySeg) {
        const target = msgById.get(String(replySeg.data?.id));
        if (target && String(target.user_id) === selfId) repliedSelf = true;
      }

      // 下一条是机器人？
      const next = messages[i + 1];
      const nextIsSelf = next && String(next.user_id) === selfId;

      const y = label({ text, mentionsSelf, repliedSelf, nextIsSelf });
      if (y === null) { skipped++; continue; }

      all.push({ m: text, y });
      if (y === 1) pos++; else neg++;
    }

    console.log(`  群 ${groupId}: 正 ${pos} / 负 ${neg} / 过滤 ${skipped}`);
  }

  // 类别平衡 + 去重
  const seen = new Set();
  const dedup = [];
  for (const s of all) {
    const key = `${s.y}::${s.m}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(s);
  }

  const pos = dedup.filter((x) => x.y === 1);
  const neg = dedup.filter((x) => x.y === 0);
  const cap = Math.min(MAX_PER_CLASS, Math.max(pos.length, neg.length));
  const picked = [
    ...pos.sort(() => Math.random() - 0.5).slice(0, cap),
    ...neg.sort(() => Math.random() - 0.5).slice(0, cap),
  ].sort(() => Math.random() - 0.5);

  const lines = picked.map((s) => JSON.stringify({ m: s.m, y: s.y }));
  fs.writeFileSync(OUT_FILE, lines.join("\n") + "\n", "utf8");

  const lens = picked.map((s) => Array.from(s.m).length).sort((a, b) => a - b);
  console.log(`\n[样本] 写入 ${OUT_FILE}`);
  console.log(`  合计 ${picked.length} 条（正 ${picked.filter((s) => s.y === 1).length} / 负 ${picked.filter((s) => s.y === 0).length}）`);
  console.log(`  长度 中位 ${lens[Math.floor(lens.length / 2)]} / 最短 ${lens[0]} / 最长 ${lens[lens.length - 1]}`);
}

main().catch((e) => {
  console.error("[样本] 失败:", e.message);
  process.exit(1);
});