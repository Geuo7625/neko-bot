// ============================================================
// 表情包收集流水线
// 监听群里的 mface：下载图片 -> 按图去重 -> 统计发送者 ->
// 达门槛（或小概率）入库待审核 -> 主人确认后转正（生成描述+向量）。
// face（系统黄豆表情）完全不处理。
// 任何失败只打日志，不影响正常聊天。
// ============================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import axios from "axios";
import { RUNTIME_CONFIG } from "./config.js";
import { sha256, hashFromMfaceData } from "./sticker-hash.js";
import {
  STICKER_STATUS,
  upsertStickerSighting,
  getStickerById,
  setStickerStatus,
  cleanupStickers,
} from "./sticker-memory.js";
import { generateStickerDescription } from "./vision-utils.js";
import { embedText } from "./memory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STICKERS_DIR = path.join(__dirname, "stickers");
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function guessExtension(contentType, source) {
  const type = String(contentType || "").toLowerCase();
  if (type.includes("png")) return "png";
  if (type.includes("jpeg") || type.includes("jpg")) return "jpg";
  if (type.includes("gif")) return "gif";
  if (type.includes("webp")) return "webp";
  const match = String(source || "").match(/\.(png|jpe?g|gif|webp|bmp)(?:\?|#|$)/i);
  return match ? match[1].toLowerCase().replace("jpeg", "jpg") : "png";
}

async function fetchStickerImage(data) {
  const source = String(data?.url || data?.file || "").trim();
  if (!source) return null;
  try {
    if (/^base64:\/\//i.test(source)) {
      const buffer = Buffer.from(source.slice("base64://".length).trim(), "base64");
      if (!buffer.length) return null;
      return { buffer, ext: guessExtension("", source) };
    }
    if (/^data:image\//i.test(source)) {
      const match = source.match(/^data:(image\/[^;]+);base64,(.*)$/s);
      if (!match) return null;
      const buffer = Buffer.from(match[2], "base64");
      if (!buffer.length) return null;
      return { buffer, ext: guessExtension(match[1], "") };
    }
    let localPath = null;
    if (/^file:\/\//i.test(source)) {
      try { localPath = fileURLToPath(source); } catch { localPath = null; }
    } else if (path.isAbsolute(source)) {
      localPath = source;
    }
    if (localPath && fs.existsSync(localPath)) {
      const buffer = await fs.promises.readFile(localPath);
      if (!buffer.length) return null;
      return { buffer, ext: guessExtension("", localPath) };
    }
    if (!/^https?:\/\//i.test(source)) return null;
    const response = await axios.get(source, {
      timeout: 10000,
      responseType: "arraybuffer",
      maxContentLength: MAX_IMAGE_BYTES,
      maxBodyLength: MAX_IMAGE_BYTES,
      headers: { Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8" },
    });
    const buffer = Buffer.from(response.data || []);
    if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) return null;
    return { buffer, ext: guessExtension(response.headers?.["content-type"], source) };
  } catch (error) {
    console.warn(`[表情包] 图片下载失败: ${error.message}`);
    return null;
  }
}

function persistImage(hash, image) {
  if (!image) return "";
  try {
    fs.mkdirSync(STICKERS_DIR, { recursive: true });
    const filePath = path.join(STICKERS_DIR, `${hash}.${image.ext}`);
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, image.buffer);
    return filePath;
  } catch (error) {
    console.warn(`[表情包] 图片写入失败 hash=${hash}: ${error.message}`);
    return "";
  }
}

// 转正：生成一句话描述并向量化。描述/向量任一失败则保持待审核，等待重试。
export async function approveSticker(hash, { description = "", embedding = null } = {}) {
  const sticker = getStickerById(hash);
  if (!sticker) return { ok: false, reason: "表情包不存在" };

  let finalDescription = String(description || sticker.description || "").trim();
  let finalEmbedding = Array.isArray(embedding) ? embedding : null;
  if (!finalEmbedding && sticker.embedding) {
    try { finalEmbedding = JSON.parse(sticker.embedding); } catch { finalEmbedding = null; }
  }

  if ((!finalDescription || !finalEmbedding) && RUNTIME_CONFIG.stickerDescriptionEnabled) {
    try {
      const generated = await generateStickerDescription(sticker.image_path);
      if (generated) finalDescription = generated;
      if (finalDescription) {
        const vector = await embedText(finalDescription);
        if (Array.isArray(vector) && vector.length) finalEmbedding = vector;
      }
    } catch (error) {
      console.warn(`[表情包] 描述生成失败 hash=${hash}: ${error.message}`);
    }
  }

  if (!finalDescription || !finalEmbedding?.length) {
    setStickerStatus(hash, STICKER_STATUS.PENDING);
    return { ok: false, reason: "缺少可用的图片或描述，暂时无法转正" };
  }

  setStickerStatus(hash, STICKER_STATUS.APPROVED, {
    description: finalDescription,
    embedding: finalEmbedding,
  });
  cleanupStickers();
  return { ok: true, description: finalDescription };
}

// bot-qq.js 在收到群 mface 时调用（fire-and-forget）。
export async function handleMfaceMessage(seg, senderId, groupId, isOwner = false) {
  if (!RUNTIME_CONFIG.stickerEnabled || !RUNTIME_CONFIG.stickerCollectEnabled) return;
  try {
    const data = seg?.data && typeof seg.data === "object" ? seg.data : {};
    const image = await fetchStickerImage(data);
    const hash = image ? sha256(image.buffer) : hashFromMfaceData(data);
    const imagePath = persistImage(hash, image);

    const result = upsertStickerSighting({
      hash,
      senderId,
      mfaceData: seg,
      imagePath,
      summary: String(data.summary || ""),
    });
    if (!result?.sticker) return;

    if (isOwner) {
      if (result.sticker.status !== STICKER_STATUS.APPROVED && imagePath) {
        await approveSticker(hash);
      }
      return;
    }

    // 已达门槛的再次出现不必反复判断；只有观察项才做入库判定。
    if (result.sticker.status !== STICKER_STATUS.OBSERVED) return;
    const minUsers = Math.max(1, Number(RUNTIME_CONFIG.stickerMinCollectedUsers) || 2);
    const ratio = Math.max(0, Math.min(1, Number(RUNTIME_CONFIG.stickerRandomCollectRatio) || 0));
    if (result.sticker.sender_count >= minUsers) {
      setStickerStatus(hash, STICKER_STATUS.PENDING);
      console.log(`[表情包] 入库待审核 hash=${hash.slice(0, 8)} senders=${result.sticker.sender_count}`);
    } else if (Math.random() < ratio) {
      setStickerStatus(hash, STICKER_STATUS.PENDING);
      console.log(`[表情包] 随机入库待审核 hash=${hash.slice(0, 8)}`);
    }
  } catch (error) {
    console.warn(`[表情包] 收集失败 group=${String(groupId)}: ${error.message}`);
  }
}

export { STICKERS_DIR };