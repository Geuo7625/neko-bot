import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { RUNTIME_CONFIG, onRuntimeConfigReload } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATABASE_PATH = path.join(__dirname, "memory_db", "group-topic-memory.sqlite");
let database = null;
let cleanupTimer = null;

function getDatabase() {
  if (database) return database;
  fs.mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });
  database = new DatabaseSync(DATABASE_PATH);
  database.exec(`
    CREATE TABLE IF NOT EXISTS group_topic_memory (
      id INTEGER PRIMARY KEY,
      group_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      summary TEXT NOT NULL,
      embedding TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_group_topic_memory_group_created
      ON group_topic_memory (group_id, created_at DESC);
  `);
  return database;
}

function normalizedVector(input) {
  if (!Array.isArray(input) || input.length === 0) return null;
  const vector = input.map(Number);
  return vector.every(Number.isFinite) ? vector : null;
}

function cosineSimilarity(left, right) {
  if (!left.length || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (!leftNorm || !rightNorm) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

export function cleanupGroupTopicMemory(now = Date.now()) {
  try {
    const db = getDatabase();
    const retentionDays = Math.max(1, Number(RUNTIME_CONFIG.topicMemoryRetentionDays) || 7);
    const maxPerGroup = Math.max(1, Number(RUNTIME_CONFIG.topicMemoryMaxPerGroup) || 50);
    const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
    let deleted = Number(db.prepare("DELETE FROM group_topic_memory WHERE created_at < ?").run(cutoff).changes || 0);
    const groups = db.prepare("SELECT DISTINCT group_id FROM group_topic_memory").all();
    const trimGroup = db.prepare(`
      DELETE FROM group_topic_memory
      WHERE id IN (
        SELECT id FROM group_topic_memory
        WHERE group_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT -1 OFFSET ?
      )
    `);
    for (const { group_id: groupId } of groups) {
      deleted += Number(trimGroup.run(groupId, maxPerGroup).changes || 0);
    }
    return deleted;
  } catch (error) {
    console.warn(`[群聊记忆] 清理失败: ${error.message}`);
    return 0;
  }
}

export function storeGroupTopicSummary(groupId, summary, embedding, createdAt = Date.now()) {
  try {
    const id = String(groupId ?? "").trim();
    const text = Array.from(String(summary ?? "").trim()).slice(0, 200).join("");
    const vector = normalizedVector(embedding);
    if (!id || !text || !vector) return false;
    getDatabase().prepare(
      "INSERT INTO group_topic_memory (group_id, created_at, summary, embedding) VALUES (?, ?, ?, ?)",
    ).run(id, Number(createdAt) || Date.now(), text, JSON.stringify(vector));
    cleanupGroupTopicMemory();
    return true;
  } catch (error) {
    console.warn(`[群聊记忆] 写入失败 group=${String(groupId)}: ${error.message}`);
    return false;
  }
}

export function clearGroupTopicMemory(groupId = null) {
  try {
    const db = getDatabase();
    if (groupId === null || groupId === undefined) {
      db.prepare("DELETE FROM group_topic_memory").run();
    } else {
      db.prepare("DELETE FROM group_topic_memory WHERE group_id = ?").run(String(groupId));
    }
    return true;
  } catch (error) {
    console.warn(`[群聊记忆] 清空失败 group=${groupId ?? "all"}: ${error.message}`);
    return false;
  }
}

export function retrieveGroupTopicSummaries(groupId, queryEmbedding, limit = RUNTIME_CONFIG.topicMemoryTopK) {
  try {
    if (!RUNTIME_CONFIG.topicMemoryEnabled) return [];
    const id = String(groupId ?? "").trim();
    const queryVector = normalizedVector(queryEmbedding);
    if (!id || !queryVector) return [];
    const retentionDays = Math.max(1, Number(RUNTIME_CONFIG.topicMemoryRetentionDays) || 7);
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const maxPerGroup = Math.max(1, Number(RUNTIME_CONFIG.topicMemoryMaxPerGroup) || 50);
    const rows = getDatabase().prepare(`
      SELECT summary, embedding, created_at
      FROM group_topic_memory
      WHERE group_id = ? AND created_at >= ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(id, cutoff, maxPerGroup);
    return rows
      .map((row) => {
        let vector;
        try { vector = normalizedVector(JSON.parse(row.embedding)); } catch { vector = null; }
        if (!vector || vector.length !== queryVector.length) return null;
        return {
          summary: String(row.summary),
          createdAt: Number(row.created_at),
          similarity: cosineSimilarity(queryVector, vector),
        };
      })
      .filter(Boolean)
      .sort((left, right) => right.similarity - left.similarity)
      .slice(0, Math.max(1, Number(limit) || 3));
  } catch (error) {
    console.warn(`[群聊记忆] 检索失败 group=${String(groupId)}: ${error.message}`);
    return [];
  }
}

function restartCleanupTimer() {
  if (cleanupTimer) clearInterval(cleanupTimer);
  const interval = Math.max(60000, Number(RUNTIME_CONFIG.topicMemoryCleanupIntervalMs) || 3600000);
  cleanupTimer = setInterval(() => cleanupGroupTopicMemory(), interval);
  cleanupTimer.unref?.();
}

restartCleanupTimer();
onRuntimeConfigReload(restartCleanupTimer);
