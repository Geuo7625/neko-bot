// ============================================================
// 表情包存储层（SQLite）
// 只负责持久化，不含任何聊天/网络逻辑。
// 数据库位于 memory_db/stickers.sqlite（与 memory_db 其余库同目录）。
// ============================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { RUNTIME_CONFIG, onRuntimeConfigReload } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATABASE_PATH = path.join(__dirname, "memory_db", "stickers.sqlite");

export const STICKER_STATUS = {
  OBSERVED: "observed", // 只记录到有人发过，还没达到入库门槛
  PENDING: "pending", // 已入库，等待主人审核转正
  APPROVED: "approved", // 已转正，可被检索发送
};

let database = null;
let cleanupTimer = null;

function getDatabase() {
  if (database) return database;
  fs.mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });
  database = new DatabaseSync(DATABASE_PATH);
  database.exec(`
    CREATE TABLE IF NOT EXISTS stickers (
      hash TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      embedding TEXT NOT NULL DEFAULT '',
      image_path TEXT NOT NULL DEFAULT '',
      mface_data TEXT NOT NULL DEFAULT '',
      senders TEXT NOT NULL DEFAULT '[]',
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      approved_at INTEGER NOT NULL DEFAULT 0,
      send_count INTEGER NOT NULL DEFAULT 0,
      last_used_at INTEGER NOT NULL DEFAULT 0,
      fail_count INTEGER NOT NULL DEFAULT 0,
      fail_reported_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_stickers_status ON stickers (status);
    CREATE INDEX IF NOT EXISTS idx_stickers_last_seen ON stickers (last_seen_at);
  `);
  return database;
}

function normalizeVector(input) {
  if (!Array.isArray(input) || input.length === 0) return null;
  const vector = input.map(Number);
  return vector.every(Number.isFinite) ? vector : null;
}

function parseJsonArray(text) {
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function toStickerObject(row) {
  if (!row) return null;
  const senders = parseJsonArray(row.senders);
  return {
    hash: String(row.hash),
    status: String(row.status),
    summary: String(row.summary || ""),
    description: String(row.description || ""),
    embedding: String(row.embedding || ""),
    image_path: String(row.image_path || ""),
    mface_data: String(row.mface_data || ""),
    senders,
    sender_count: senders.length,
    first_seen_at: Number(row.first_seen_at) || 0,
    last_seen_at: Number(row.last_seen_at) || 0,
    approved_at: Number(row.approved_at) || 0,
    send_count: Number(row.send_count) || 0,
    last_used_at: Number(row.last_used_at) || 0,
    fail_count: Number(row.fail_count) || 0,
    fail_reported_at: Number(row.fail_reported_at) || 0,
  };
}

export function getStickerById(hash) {
  try {
    const id = String(hash ?? "").trim();
    if (!id) return null;
    const row = getDatabase().prepare("SELECT * FROM stickers WHERE hash = ?").get(id);
    return toStickerObject(row);
  } catch (error) {
    console.warn(`[表情包] 读取失败 hash=${String(hash)}: ${error.message}`);
    return null;
  }
}

export function getStickerByHash(hash) {
  return getStickerById(hash);
}

export function countStickers(status = null) {
  try {
    const db = getDatabase();
    if (status) {
      const row = db.prepare("SELECT COUNT(*) AS n FROM stickers WHERE status = ?").get(String(status));
      return Number(row?.n) || 0;
    }
    const row = db.prepare("SELECT COUNT(*) AS n FROM stickers").get();
    return Number(row?.n) || 0;
  } catch (error) {
    console.warn(`[表情包] 统计失败: ${error.message}`);
    return 0;
  }
}

// 记录一次“有人在群里发了这张 mface”。返回是否新建、是否新增发送者。
export function upsertStickerSighting({ hash, senderId, mfaceData, imagePath, summary }, now = Date.now()) {
  const id = String(hash ?? "").trim();
  if (!id) return null;
  const sender = String(senderId ?? "").trim();
  const db = getDatabase();
  const existing = toStickerObject(db.prepare("SELECT * FROM stickers WHERE hash = ?").get(id));

  if (!existing) {
    db.prepare(`
      INSERT INTO stickers
        (hash, status, summary, image_path, mface_data, senders, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      STICKER_STATUS.OBSERVED,
      String(summary ?? ""),
      String(imagePath ?? ""),
      JSON.stringify(mfaceData ?? null),
      JSON.stringify(sender ? [sender] : []),
      Number(now) || Date.now(),
      Number(now) || Date.now(),
    );
    return { created: true, addedSender: Boolean(sender), sticker: getStickerById(id) };
  }

  const senders = existing.senders.slice();
  const addedSender = Boolean(sender) && !senders.includes(sender);
  if (addedSender) senders.push(sender);

  const patch = {
    senders: JSON.stringify(senders),
    last_seen_at: Number(now) || Date.now(),
  };
  // 首次记录的原始 mface 数据/图片优先保留；缺失时补全。
  if (!existing.mface_data && mfaceData) patch.mface_data = JSON.stringify(mfaceData);
  if (!existing.image_path && imagePath) patch.image_path = String(imagePath);
  if (!existing.summary && summary) patch.summary = String(summary);

  updateSticker(id, patch);
  return { created: false, addedSender, sticker: getStickerById(id) };
}

const COLUMN_MAP = {
  status: "status",
  summary: "summary",
  description: "description",
  embedding: "embedding",
  image_path: "image_path",
  mface_data: "mface_data",
  senders: "senders",
  first_seen_at: "first_seen_at",
  last_seen_at: "last_seen_at",
  approved_at: "approved_at",
  send_count: "send_count",
  last_used_at: "last_used_at",
  fail_count: "fail_count",
  fail_reported_at: "fail_reported_at",
};

// 局部更新。JSON 字段传入对象/数组会自动序列化。
export function updateSticker(hash, fields = {}) {
  const id = String(hash ?? "").trim();
  if (!id || !fields || typeof fields !== "object") return false;
  const assignments = [];
  const values = [];
  for (const [key, raw] of Object.entries(fields)) {
    const column = COLUMN_MAP[key];
    if (!column) continue;
    let value = raw;
    if (key === "senders" && !Array.isArray(value)) value = parseJsonArray(value);
    if (["senders", "mface_data", "embedding"].includes(key) && typeof value !== "string") {
      value = JSON.stringify(value);
    }
    assignments.push(`${column} = ?`);
    values.push(value === undefined || value === null ? "" : value);
  }
  if (!assignments.length) return false;
  try {
    values.push(id);
    getDatabase()
      .prepare(`UPDATE stickers SET ${assignments.join(", ")} WHERE hash = ?`)
      .run(...values);
    return true;
  } catch (error) {
    console.warn(`[表情包] 更新失败 hash=${id}: ${error.message}`);
    return false;
  }
}

export function setStickerStatus(hash, status, extra = {}) {
  const allowed = Object.values(STICKER_STATUS);
  if (!allowed.includes(status)) return false;
  const patch = { ...extra, status };
  if (status === STICKER_STATUS.APPROVED && !patch.approved_at) patch.approved_at = Date.now();
  if (status === STICKER_STATUS.APPROVED) {
    patch.fail_count = 0;
    patch.fail_reported_at = 0;
  }
  return updateSticker(hash, patch);
}

export function getApprovedStickersWithEmbeddings() {
  try {
    const rows = getDatabase()
      .prepare("SELECT * FROM stickers WHERE status = ? AND embedding != ''")
      .all(STICKER_STATUS.APPROVED);
    return rows.map(toStickerObject).filter((item) => item.embedding);
  } catch (error) {
    console.warn(`[表情包] 检索库读取失败: ${error.message}`);
    return [];
  }
}

export function getPendingStickers(limit = 10) {
  try {
    const rows = getDatabase()
      .prepare("SELECT * FROM stickers WHERE status = ? ORDER BY first_seen_at ASC LIMIT ?")
      .all(STICKER_STATUS.PENDING, Math.max(1, Number(limit) || 10));
    return rows.map(toStickerObject);
  } catch (error) {
    console.warn(`[表情包] 待审核读取失败: ${error.message}`);
    return [];
  }
}

export function deleteSticker(hash) {
  try {
    const id = String(hash ?? "").trim();
    if (!id) return false;
    const result = getDatabase().prepare("DELETE FROM stickers WHERE hash = ?").run(id);
    return Number(result?.changes || 0) > 0;
  } catch (error) {
    console.warn(`[表情包] 删除失败 hash=${String(hash)}: ${error.message}`);
    return false;
  }
}

// 冷门淘汰：清理长期没人再发的观察项；已转正项按总量封顶淘汰最冷门的。
export function cleanupStickers(now = Date.now()) {
  try {
    const db = getDatabase();
    const retentionDays = Math.max(1, Number(RUNTIME_CONFIG.stickerUnpopularRetentionDays) || 30);
    const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
    let deleted = Number(
      db.prepare("DELETE FROM stickers WHERE status = ? AND last_seen_at < ?")
        .run(STICKER_STATUS.OBSERVED, cutoff).changes || 0,
    );

    const cap = Math.max(1, Number(RUNTIME_CONFIG.stickerTotalCap) || 1000);
    const approvedCount = countStickers(STICKER_STATUS.APPROVED);
    if (approvedCount > cap) {
      const excess = approvedCount - cap;
      deleted += Number(
        db.prepare(`
          DELETE FROM stickers WHERE hash IN (
            SELECT hash FROM stickers
            WHERE status = ?
            ORDER BY send_count ASC, last_used_at ASC, first_seen_at ASC
            LIMIT ?
          )
        `).run(STICKER_STATUS.APPROVED, excess).changes || 0,
      );
    }
    return deleted;
  } catch (error) {
    console.warn(`[表情包] 清理失败: ${error.message}`);
    return 0;
  }
}

function restartCleanupTimer() {
  if (cleanupTimer) clearInterval(cleanupTimer);
  cleanupTimer = setInterval(() => cleanupStickers(), 6 * 60 * 60 * 1000);
  cleanupTimer.unref?.();
}

restartCleanupTimer();
onRuntimeConfigReload(restartCleanupTimer);