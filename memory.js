// memory.js
import * as lancedb from "@lancedb/lancedb";
import axios from "axios";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import * as CONFIG from "./config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// 配置
// ============================================================

const EMBEDDING_API_URL =
  CONFIG.EMBEDDING_API_URL ||
  process.env.EMBEDDING_API_URL ||
  "https://api.openai.com/v1/embeddings";

const EMBEDDING_API_KEY =
  CONFIG.EMBEDDING_API_KEY || process.env.EMBEDDING_API_KEY || "";

const EMBEDDING_MODEL =
  CONFIG.EMBEDDING_MODEL ||
  process.env.EMBEDDING_MODEL ||
  "text-embedding-3-small";

const EMBEDDING_DIM = Number(
  CONFIG.EMBEDDING_DIM || process.env.EMBEDDING_DIM || 1536,
);

// 数据库本地目录：./memory_db
const MEMORY_DB_DIR = path.join(__dirname, "memory_db");
const TABLE_NAME = "memories";

const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 10;
const MAX_CONTENT_LEN = 2000;
const MAX_MEMORY_PER_USER = 500;

const EMBEDDING_TIMEOUT_MS = 15000;
const EMBEDDING_MAX_INPUT_LEN = 4000;

const MEMORY_TYPES = [
  "fact",
  "preference",
  "event",
  "plan",
  "relationship",
  "other",
];

// ============================================================
// 状态（懒初始化）
// ============================================================

let dbInstance = null;
let tableInstance = null;
let initPromise = null;

// ============================================================
// 工具函数
// ============================================================

function sanitizeUserId(userId) {
  if (userId === null || userId === undefined) return "";
  return String(userId).trim().slice(0, 64);
}

function escapeSqlString(value) {
  return String(value).replace(/'/g, "''");
}

function truncateContent(text) {
  const str = String(text || "").trim();
  if (str.length <= MAX_CONTENT_LEN) return str;
  return str.slice(0, MAX_CONTENT_LEN);
}

function normalizeLimit(limit) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TOP_K;
  return Math.min(Math.max(Math.floor(n), 1), MAX_TOP_K);
}

function normalizeType(type) {
  const t = String(type || "fact").trim().toLowerCase();
  return MEMORY_TYPES.includes(t) ? t : "other";
}

// ============================================================
// Embedding
// ============================================================

async function embed(text) {
  const input = String(text || "")
    .trim()
    .slice(0, EMBEDDING_MAX_INPUT_LEN);

  if (!input) throw new Error("embed: 文本为空");
  if (!EMBEDDING_API_KEY) throw new Error("embed: 未配置 EMBEDDING_API_KEY");

  const response = await axios.post(
    EMBEDDING_API_URL,
    { model: EMBEDDING_MODEL, input },
    {
      headers: {
        Authorization: `Bearer ${EMBEDDING_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: EMBEDDING_TIMEOUT_MS,
    },
  );

  const vector = response?.data?.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error("embed: embedding 返回异常");
  }
  return vector;
}

// ============================================================
// 表初始化
// ============================================================

async function ensureTable(sampleVector = null) {
  if (tableInstance) return tableInstance;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    if (!fs.existsSync(MEMORY_DB_DIR)) {
      fs.mkdirSync(MEMORY_DB_DIR, { recursive: true });
    }

    dbInstance = await lancedb.connect(MEMORY_DB_DIR);

    const tableNames = await dbInstance.tableNames();
    if (tableNames.includes(TABLE_NAME)) {
      tableInstance = await dbInstance.openTable(TABLE_NAME);
      return tableInstance;
    }

    const dim =
      Array.isArray(sampleVector) && sampleVector.length > 0
        ? sampleVector.length
        : EMBEDDING_DIM;

    // 用一条 seed 行创建表结构，随后立刻删除
    const seedRow = {
      id: "__seed__",
      userId: "__seed__",
      content: "__seed__",
      type: "seed",
      timestamp: 0,
      vector: new Array(dim).fill(0),
    };

    tableInstance = await dbInstance.createTable(TABLE_NAME, [seedRow]);

    try {
      await tableInstance.delete(`id = '__seed__'`);
    } catch (err) {
      console.warn("[Memory] 删除 seed 记录失败（忽略）:", err.message);
    }

    return tableInstance;
  })();

  try {
    return await initPromise;
  } catch (error) {
    initPromise = null;
    tableInstance = null;
    throw error;
  }
}

// ============================================================
// 核心：保存记忆
// ============================================================

export async function saveMemory({
  userId,
  content,
  type = "fact",
}) {
  const uid = sanitizeUserId(userId);
  if (!uid) throw new Error("saveMemory: userId 不能为空");

  const text = truncateContent(content);
  if (!text) throw new Error("saveMemory: content 不能为空");

  const vector = await embed(text);
  const tbl = await ensureTable(vector);

  const record = {
    id: crypto.randomUUID(),
    userId: uid,
    content: text,
    type: normalizeType(type),
    timestamp: Date.now(),
    vector,
  };

  await tbl.add([record]);

  // 超过上限时裁剪最旧的记忆
  try {
    await pruneUserMemories(tbl, uid, MAX_MEMORY_PER_USER);
  } catch (err) {
    console.warn("[Memory] 裁剪失败:", err.message);
  }

  return {
    id: record.id,
    userId: record.userId,
    content: record.content,
    type: record.type,
    timestamp: record.timestamp,
  };
}

// ============================================================
// 核心：向量检索（严格按 userId 隔离）
// ============================================================

export async function searchMemories({
  userId,
  query,
  limit = DEFAULT_TOP_K,
  minScore = 0,
}) {
  const uid = sanitizeUserId(userId);
  if (!uid) return [];

  const q = String(query || "").trim();
  if (!q) return [];

  const topK = normalizeLimit(limit);

  const vector = await embed(q);
  const tbl = await ensureTable(vector);

  const safeUid = escapeSqlString(uid);

  let rows;
  try {
    rows = await tbl
      .vectorSearch(vector)
      .where(`userId = '${safeUid}'`)
      .limit(topK)
      .toArray();
  } catch (err) {
    console.error("[Memory] 向量检索失败:", err.message);
    return [];
  }

  return rows
    .map((row) => {
      const distance = Number(row._distance ?? 0);
      const score = 1 - distance;
      return {
        id: row.id,
        userId: row.userId,
        content: row.content,
        type: row.type,
        timestamp: row.timestamp,
        score,
      };
    })
    .filter((m) => m.score >= minScore);
}

// ============================================================
// 列出用户全部记忆（无向量查询）
// ============================================================

export async function listUserMemories(userId, { limit = 50 } = {}) {
  const uid = sanitizeUserId(userId);
  if (!uid) return [];

  const tbl = await ensureTable();
  const safeUid = escapeSqlString(uid);

  let rows;
  try {
    rows = await tbl.query().where(`userId = '${safeUid}'`).toArray();
  } catch (err) {
    console.error("[Memory] 列出记忆失败:", err.message);
    return [];
  }

  rows.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  return rows.slice(0, limit).map((r) => ({
    id: r.id,
    content: r.content,
    type: r.type,
    timestamp: r.timestamp,
  }));
}

// ============================================================
// 删除单条 / 清空用户记忆
// ============================================================

export async function deleteMemory(userId, memoryId) {
  const uid = sanitizeUserId(userId);
  const mid = String(memoryId || "").trim();
  if (!uid || !mid) return false;

  const tbl = await ensureTable();
  const safeUid = escapeSqlString(uid);
  const safeMid = escapeSqlString(mid);

  try {
    await tbl.delete(`userId = '${safeUid}' AND id = '${safeMid}'`);
    return true;
  } catch (err) {
    console.error("[Memory] 删除记忆失败:", err.message);
    return false;
  }
}

export async function clearUserMemories(userId) {
  const uid = sanitizeUserId(userId);
  if (!uid) return false;

  const tbl = await ensureTable();
  const safeUid = escapeSqlString(uid);

  try {
    await tbl.delete(`userId = '${safeUid}'`);
    return true;
  } catch (err) {
    console.error("[Memory] 清空用户记忆失败:", err.message);
    return false;
  }
}

// ============================================================
// 内部：裁剪最旧记忆
// ============================================================

async function pruneUserMemories(tbl, userId, max) {
  const safeUid = escapeSqlString(userId);

  const rows = await tbl.query().where(`userId = '${safeUid}'`).toArray();
  if (rows.length <= max) return;

  rows.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  const overflow = rows.slice(0, rows.length - max);

  const idList = overflow
    .map((r) => `'${escapeSqlString(r.id)}'`)
    .join(",");

  if (idList) {
    await tbl.delete(`id IN (${idList})`);
  }
}

// ============================================================
// Tool 定义
// ============================================================

export const MEMORY_TOOLS = [
  {
    type: "function",
    function: {
      name: "save_memory",
      description:
        "把值得长期记住的信息保存到当前用户的长期记忆里。仅当用户明确要求记住某事，或出现重要的稳定个人信息（称呼、偏好、身份、长期计划等）时调用。不要保存临时闲聊。content 用简洁的第三人称陈述句。",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "要记住的内容，简洁明了、第三人称陈述句。",
          },
          type: {
            type: "string",
            enum: MEMORY_TYPES,
            description:
              "记忆类型：fact(事实)、preference(偏好)、event(事件)、plan(计划)、relationship(关系)、other(其他)。",
          },
        },
        required: ["content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "recall_memory",
      description:
        "检索当前用户的长期记忆。当需要回忆用户此前提过的信息、偏好或经历时调用。只返回当前用户自己的记忆。",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "用于语义检索的自然语言查询。",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: MAX_TOP_K,
            description: `返回条数，1-${MAX_TOP_K}，默认 ${DEFAULT_TOP_K}。`,
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
];

// ============================================================
// Tool 执行器
// ============================================================

export async function executeSaveMemoryTool({ args, userId }) {
  const uid = sanitizeUserId(userId);
  if (!uid) {
    return { ok: false, content: "无法确定当前用户，记忆未保存。" };
  }

  const content = String(args?.content || "").trim();
  if (!content) {
    return { ok: false, content: "记忆内容为空，未保存。" };
  }

  try {
    const saved = await saveMemory({
      userId: uid,
      content,
      type: args?.type,
    });
    return {
      ok: true,
      content: `已保存记忆（${saved.type}）：${saved.content}`,
    };
  } catch (error) {
    console.error("[Memory] save_memory 失败:", error.message);
    return { ok: false, content: `记忆保存失败：${error.message}` };
  }
}

export async function executeRecallMemoryTool({ args, userId }) {
  const uid = sanitizeUserId(userId);
  if (!uid) {
    return { ok: false, content: "无法确定当前用户，未检索记忆。" };
  }

  const query = String(args?.query || "").trim();
  if (!query) {
    return { ok: false, content: "查询词为空，未检索记忆。" };
  }

  try {
    const memories = await searchMemories({
      userId: uid,
      query,
      limit: args?.limit,
    });

    if (!memories.length) {
      return { ok: true, content: "（当前用户没有相关记忆）" };
    }

    const lines = memories.map((m, i) => {
      const scoreText =
        typeof m.score === "number" ? ` 相似度 ${m.score.toFixed(3)}` : "";
      return `${i + 1}. [${m.type}${scoreText}] ${m.content}`;
    });

    return {
      ok: true,
      content: `检索到 ${memories.length} 条记忆：\n${lines.join("\n")}`,
    };
  } catch (error) {
    console.error("[Memory] recall_memory 失败:", error.message);
    return { ok: false, content: `记忆检索失败：${error.message}` };
  }
}

// ============================================================
// 便捷：把记忆列表格式化成 prompt
// ============================================================

export function formatMemoriesForPrompt(memories) {
  if (!Array.isArray(memories) || !memories.length) return "";
  const lines = memories.map((m) => `- [${m.type}] ${m.content}`);
  return `【长期记忆】\n${lines.join("\n")}`;
}