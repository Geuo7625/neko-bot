// ============================================================
// 表情包视觉理解：调用 vision 模型生成一句话描述
// 生成失败只返回空串，由调用方决定是否保持待审核。
// ============================================================
import fs from "node:fs";
import axios from "axios";
import { AI_URL, AI_API_KEY, MODEL } from "./config.js";

const DESCRIPTION_PROMPT =
  "这是一张聊天表情包。请用一句话概括三件事：画面里是什么、图上有没有文字、适合在什么聊天场景发送。" +
  "只输出这一句话，不要换行、不要解释、不要分点，不超过 60 字。";

function mimeFor(filePath) {
  const ext = String(filePath || "").toLowerCase();
  if (ext.endsWith(".png")) return "image/png";
  if (ext.endsWith(".jpg") || ext.endsWith(".jpeg")) return "image/jpeg";
  if (ext.endsWith(".gif")) return "image/gif";
  if (ext.endsWith(".webp")) return "image/webp";
  return "image/png";
}

export async function generateStickerDescription(imagePath) {
  const file = String(imagePath || "").trim();
  if (!file || !fs.existsSync(file) || !AI_API_KEY) return "";
  try {
    const buffer = await fs.promises.readFile(file);
    if (!buffer.length) return "";
    const dataUrl = `data:${mimeFor(file)};base64,${buffer.toString("base64")}`;
    const response = await axios.post(
      AI_URL,
      {
        model: MODEL,
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: dataUrl } },
              { type: "text", text: DESCRIPTION_PROMPT },
            ],
          },
        ],
        max_tokens: 200,
        stream: false,
      },
      {
        headers: { Authorization: `Bearer ${AI_API_KEY}`, "Content-Type": "application/json" },
        timeout: 30000,
      },
    );
    const text = response?.data?.choices?.[0]?.message?.content;
    return String(text || "").trim().replace(/\s+/g, " ").slice(0, 120);
  } catch (error) {
    console.warn(`[表情包] vision 描述失败: ${error.message}`);
    return "";
  }
}