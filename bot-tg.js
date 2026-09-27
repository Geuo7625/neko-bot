import { Bot } from "grammy";
import { BOT_TOKEN } from "./config.js";
import { coreProcessChat } from "./core.js";
// ============================================================
// Telegram Markdown 安全发送
// ============================================================
async function safeReplyText(ctx, text) {
  try {
    await ctx.reply(text, {
      parse_mode: "Markdown",
    });
  } catch (error) {
    console.warn(
      `[Warning] Markdown 解析失败 (${error})，正在使用纯文本回退发送。`,
    );
    try {
      await ctx.reply(text);
    } catch (innerError) {
      console.error(`[Error] 纯文本发送亦失败: ${innerError}`);
    }
  }
}
// ============================================================
// Telegram 消息处理
// ============================================================
async function chat(ctx) {
  try {
    if (!ctx.message) {
      return;
    }
    // 与 Python 版保持一致
    const chatId = `tg_${ctx.chat.id}`;
    const userText = (ctx.message.text || ctx.message.caption || "").trim();
    // ========================================================
    // 获取图片
    // ========================================================
    let imageContent = null;
    if (ctx.message.photo) {
      try {
        // Telegram 会提供多个不同尺寸的 photo
        // 最后一张通常是最大尺寸
        const photo = ctx.message.photo[ctx.message.photo.length - 1];
        const file = await ctx.api.getFile(photo.file_id);
        // 获取 Telegram 文件下载地址
        const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
        const response = await fetch(fileUrl);
        if (!response.ok) {
          throw new Error(`Telegram 图片下载失败: HTTP ${response.status}`);
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        const base64Image = buffer.toString("base64");
        imageContent = `data:image/jpeg;base64,${base64Image}`;
      } catch (error) {
        console.error(`[TG 图片] 下载图片失败: ${error}`);
      }
    }
    // ========================================================
    // 没有文字也没有图片
    // ========================================================
    if (!userText && !imageContent) {
      return;
    }
    // ========================================================
    // 调用核心 AI
    // ========================================================
    const res = await coreProcessChat(chatId, userText, imageContent);
    // ========================================================
    // 普通文字回复
    // ========================================================
    if (res.type === "text") {
      await safeReplyText(ctx, res.content);
    }
    // ========================================================
    // AI 画图
    // ========================================================
    else if (res.type === "draw") {
      // 先发送“正在画”的回复
      const statusMsg = await ctx.reply(res.cat_reply);
      // Markdown 代码格式显示提示词
      const captionText = `好了喵\n\`提示词：${res.prompt}\``;
      // 删除之前的状态消息
      try {
        await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id);
      } catch {
        // 删除失败就忽略
      }
      // ====================================================
      // 发送图片
      // ====================================================
      try {
        await ctx.replyWithPhoto(res.img_url, {
          caption: captionText,
          parse_mode: "Markdown",
        });
      } catch {
        // Markdown 解析失败时纯文本回退
        await ctx.replyWithPhoto(res.img_url, {
          caption: `好了喵\n提示词：${res.prompt}`,
        });
      }
    }
  } catch (error) {
    console.error(`[TG 全局捕获] 处理消息出错:`, error);
    try {
      await ctx.reply("唔……连接或者格式出了点小问题喵。");
    } catch {
      // 连错误消息都发送失败就忽略
    }
  }
}
// ============================================================
// 创建 Telegram Bot
// ============================================================
function buildTgApp() {
  if (!BOT_TOKEN) {
    return null;
  }
  const bot = new Bot(BOT_TOKEN);
  // 文字消息
  bot.on("message:text", chat);
  // 图片消息
  // photo + caption 也会进入这里
  bot.on("message:photo", chat);
  return bot;
}
export { safeReplyText, chat, buildTgApp };
