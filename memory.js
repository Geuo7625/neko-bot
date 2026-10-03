import axios from "axios";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as lancedb from "@lancedb/lancedb";

// ============================================================
// QQ 结构化长期记忆 v10
// ============================================================
//
// 核心设计：
// 1. memory_state：每个 uid + key 只有一个当前状态，作为真正的 upsert 表。
// 2. memory_history：只保存被替换/删除的旧快照，状态为 superseded / deleted。
// 3. 正常检索只看 memory_state.status = active。
// 4. history 是否检索由模型通过 search_memory 的 scope 决定，本地不猜测用户意图。
// 5. 模型只负责抽取 key/value/category/entity + 判断 replace/append/delete。
// 6. UID、status、version、时间、embedding 元数据全部由本地代码控制。
// 7. 写入串行化，避免同一进程内并发 upsert/建表竞争。
// 8. 敏感信息只做硬拒绝，不做“半保存/脱敏保存”。
// 9. embedding 模型 + 维度持久化，切换模型时拒绝混用旧向量。
// 10. 保存不做本地敏感信息推断；是否值得保存由模型判断。
//
// 默认：
//   MEMORY_DB_PATH=memory_db（相对于 memory.js 所在目录）
//   MEMORY_EMBEDDING_MODE=local
//   MEMORY_EMBEDDING_MODEL=Xenova/bge-small-zh-v1.5
//
// 可选：
//   MEMORY_TOP_K=8
//   MEMORY_HISTORY_TOP_K=6
//   MEMORY_MAX_CONTEXT_ITEMS=12
// ============================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MEMORY_ENABLED = process.env.MEMORY_ENABLED !== "0";
const MEMORY_DB_PATH = process.env.MEMORY_DB_PATH?.trim()
  ? path.resolve(process.cwd(), process.env.MEMORY_DB_PATH.trim())
  : path.join(__dirname, "memory_db");

const MEMORY_STATE_TABLE = "memory_state";
const MEMORY_HISTORY_TABLE = "memory_history";
const MEMORY_LEGACY_TABLE = "memories";
const MEMORY_META_FILE = path.join(MEMORY_DB_PATH, "memory_meta.json");
const MEMORY_SCHEMA_VERSION = 5;

const MEMORY_EMBEDDING_MODE = String(
  process.env.MEMORY_EMBEDDING_MODE || "local",
).toLowerCase();
const MEMORY_EMBEDDING_MODEL = String(
  process.env.MEMORY_EMBEDDING_MODEL || "Xenova/bge-small-zh-v1.5",
).trim();
const MEMORY_EMBEDDING_URL = String(
  process.env.MEMORY_EMBEDDING_URL || "",
).trim();
const MEMORY_EMBEDDING_API_KEY = String(
  process.env.MEMORY_EMBEDDING_API_KEY || "",
).trim();

const MEMORY_QUERY_INSTRUCTION =
  process.env.MEMORY_QUERY_INSTRUCTION ||
  "为这个句子生成表示以用于检索相关文章：";

const MEMORY_TOP_K = clampInt(process.env.MEMORY_TOP_K, 8, 1, 16);
const MEMORY_MAX_KEY_LENGTH = 128;
const MEMORY_MAX_VALUE_LENGTH = 1000;
const MEMORY_MAX_ENTITY_LENGTH = 96;
const MEMORY_MAX_CATEGORY_LENGTH = 40;
const MEMORY_EMBED_CACHE_SIZE = 128;
const MEMORY_CONTEXT_VALUE_LIMIT = 280;

let dbPromise = null;
let stateTablePromise = null;
let historyTablePromise = null;
let localEmbedderPromise = null;
let metaPromise = null;
let embeddingDimension = null;
let writeQueue = Promise.resolve();
const embeddingCache = new Map();

function clampInt(raw, fallback, min, max) {
  const value = Number.parseInt(raw ?? "", 10);
  if (!Number.isInteger(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function withWriteLock(task) {
  const run = writeQueue.then(task, task);
  writeQueue = run.catch(() => {});
  return run;
}

function normalizeUid(uid) {
  const value = String(uid ?? "").trim();
  return /^\d{5,12}$/.test(value) ? value : "";
}

function normalizeKey(key) {
  return String(key ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\u3000\t\r\n]+/g, " ")
    .trim()
    .replace(/\s+/g, ".")
    .slice(0, MEMORY_MAX_KEY_LENGTH);
}

function normalizeValue(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u3000\s]+/g, " ")
    .trim()
    .slice(0, MEMORY_MAX_VALUE_LENGTH);
}

function normalizeEntity(entity) {
  return String(entity ?? "")
    .normalize("NFKC")
    .replace(/[\u3000\s]+/g, " ")
    .trim()
    .slice(0, MEMORY_MAX_ENTITY_LENGTH);
}

function normalizeCategory(category) {
  const raw = String(category ?? "")
    .normalize("NFKC")
    .replace(/[\u3000\s]+/g, " ")
    .trim()
    .slice(0, MEMORY_MAX_CATEGORY_LENGTH);

  return raw || "other";
}

function normalizeComparable(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u3000\s]+/g, "")
    .replace(/[，。！？、；：‘’“”"'（）()【】\[\]{}<>《》…·,.:;!?]/g, "");
}

function normalizeList(values) {
  const result = [];
  const seen = new Set();

  for (const value of Array.isArray(values) ? values : []) {
    const normalized = normalizeValue(value);
    if (!normalized) continue;

    const comparable = normalizeComparable(normalized);
    if (!comparable || seen.has(comparable)) continue;

    seen.add(comparable);
    result.push(normalized);
  }

  return result;
}

function valueToStored(value, valueType = "scalar") {
  if (valueType === "list") {
    const values = normalizeList(value);
    return {
      value: values.join("、"),
      value_json: JSON.stringify(values),
      value_type: "list",
    };
  }

  const normalized = normalizeValue(value);
  return {
    value: normalized,
    value_json: JSON.stringify(normalized),
    value_type: "scalar",
  };
}

function readStoredValue(row) {
  if (String(row?.value_type || "scalar") === "list") {
    try {
      const parsed = JSON.parse(String(row?.value_json || "[]"));
      return normalizeList(parsed);
    } catch {
      const fallback = String(row?.value || "")
        .split(/[、,，]/)
        .map(normalizeValue)
        .filter(Boolean);
      return normalizeList(fallback);
    }
  }

  return normalizeValue(row?.value || "");
}

function escapeSqlString(value) {
  return String(value).replace(/'/g, "''");
}

function hashText(...parts) {
  return crypto
    .createHash("sha256")
    .update(parts.join("\n"), "utf8")
    .digest("hex");
}

function makeUidKey(uid, key) {
  return hashText(uid, key);
}

function makeVersionId(uid, key, version, value) {
  return hashText(
    uid,
    key,
    String(version),
    normalizeComparable(value),
    String(Date.now()),
    crypto.randomUUID(),
  );
}

function makeEmbeddingProfile(dimension) {
  return [
    `schema=${MEMORY_SCHEMA_VERSION}`,
    `mode=${MEMORY_EMBEDDING_MODE}`,
    `model=${MEMORY_EMBEDDING_MODEL}`,
    `dim=${dimension}`,
    "pooling=mean",
    "normalize=true",
    "metric=cosine",
  ].join("|");
}

function cacheGet(key) {
  if (!embeddingCache.has(key)) return null;
  const value = embeddingCache.get(key);
  embeddingCache.delete(key);
  embeddingCache.set(key, value);
  return value;
}

function cacheSet(key, value) {
  embeddingCache.set(key, value);
  while (embeddingCache.size > MEMORY_EMBED_CACHE_SIZE) {
    const oldest = embeddingCache.keys().next().value;
    embeddingCache.delete(oldest);
  }
}

async function getDb() {
  if (!MEMORY_ENABLED) return null;

  if (!dbPromise) {
    dbPromise = fs.promises
      .mkdir(MEMORY_DB_PATH, { recursive: true })
      .then(() => lancedb.connect(MEMORY_DB_PATH))
      .catch((error) => {
        dbPromise = null;
        throw error;
      });
  }

  return dbPromise;
}

async function openTable(tableName) {
  const db = await getDb();
  if (!db) return null;

  try {
    return await db.openTable(tableName);
  } catch (error) {
    if (
      /not found|does not exist|table.*exist|no such table/i.test(
        String(error?.message || ""),
      )
    ) {
      return null;
    }
    throw error;
  }
}

async function openStateTable() {
  if (!stateTablePromise) {
    stateTablePromise = openTable(MEMORY_STATE_TABLE).catch((error) => {
      stateTablePromise = null;
      throw error;
    });
  }
  return stateTablePromise;
}

async function openHistoryTable() {
  if (!historyTablePromise) {
    historyTablePromise = openTable(MEMORY_HISTORY_TABLE).catch((error) => {
      historyTablePromise = null;
      throw error;
    });
  }
  return historyTablePromise;
}

async function createOrGetStateTable(row) {
  const existing = await openStateTable();
  if (existing) return existing;

  const db = await getDb();
  try {
    const table = await db.createTable(MEMORY_STATE_TABLE, [row], {
      mode: "create",
    });
    stateTablePromise = Promise.resolve(table);
    return table;
  } catch (error) {
    stateTablePromise = null;
    const retry = await openStateTable();
    if (retry) return retry;
    throw error;
  }
}

async function createOrGetHistoryTable(row) {
  const existing = await openHistoryTable();
  if (existing) return existing;

  const db = await getDb();
  try {
    const table = await db.createTable(MEMORY_HISTORY_TABLE, [row], {
      mode: "create",
    });
    historyTablePromise = Promise.resolve(table);
    return table;
  } catch (error) {
    historyTablePromise = null;
    const retry = await openHistoryTable();
    if (retry) return retry;
    throw error;
  }
}

async function getFirstRow(table, columns) {
  if (!table) return null;
  const rows = await table.query().select(columns).limit(1).toArray();
  return rows?.[0] || null;
}

async function loadEmbeddingMeta() {
  if (!metaPromise) {
    metaPromise = (async () => {
      try {
        const raw = await fs.promises.readFile(MEMORY_META_FILE, "utf8");
        return JSON.parse(raw);
      } catch {
        return null;
      }
    })().catch((error) => {
      metaPromise = null;
      throw error;
    });
  }

  return metaPromise;
}

async function saveEmbeddingMeta(meta) {
  await fs.promises.mkdir(MEMORY_DB_PATH, { recursive: true });
  const temp = `${MEMORY_META_FILE}.tmp-${process.pid}-${Date.now()}`;
  await fs.promises.writeFile(temp, JSON.stringify(meta, null, 2), "utf8");
  await fs.promises.rename(temp, MEMORY_META_FILE);
  metaPromise = Promise.resolve(meta);
}

async function ensureEmbeddingProfile(vector, { createMeta = false } = {}) {
  const dimension = Array.isArray(vector) ? vector.length : 0;
  if (!dimension) throw new Error("Embedding 向量为空，无法确定维度");

  if (embeddingDimension && embeddingDimension !== dimension) {
    throw new Error(
      `Embedding 维度不一致：进程=${embeddingDimension}，当前=${dimension}。`,
    );
  }
  embeddingDimension = dimension;

  let meta = await loadEmbeddingMeta();

  if (!meta) {
    const stateTable = await openStateTable();
    const row = await getFirstRow(stateTable, [
      "embedding_model",
      "embedding_dim",
      "embedding_profile",
      "schema_version",
    ]);

    if (row?.embedding_profile) {
      meta = {
        schema_version: Number(row.schema_version || MEMORY_SCHEMA_VERSION),
        embedding_mode: MEMORY_EMBEDDING_MODE,
        embedding_model: String(row.embedding_model || MEMORY_EMBEDDING_MODEL),
        embedding_dim: Number(row.embedding_dim || dimension),
        embedding_profile: String(row.embedding_profile),
      };
      await saveEmbeddingMeta(meta);
    }
  }

  const expected = makeEmbeddingProfile(dimension);

  if (meta) {
    const storedDim = Number(meta.embedding_dim || 0);
    const storedProfile = String(meta.embedding_profile || "");

    if (storedDim !== dimension || storedProfile !== expected) {
      throw new Error(
        `Embedding 配置不兼容：数据库=${storedProfile || `dim=${storedDim}`}，当前=${expected}。` +
          "请保持原 Embedding 模型，或使用新的 MEMORY_DB_PATH 后重新建立索引。",
      );
    }

    return meta;
  }

  if (createMeta) {
    const next = {
      schema_version: MEMORY_SCHEMA_VERSION,
      embedding_mode: MEMORY_EMBEDDING_MODE,
      embedding_model: MEMORY_EMBEDDING_MODEL,
      embedding_dim: dimension,
      embedding_profile: expected,
      created_at: new Date().toISOString(),
    };
    await saveEmbeddingMeta(next);
    return next;
  }

  return null;
}

async function getLocalEmbedder() {
  if (!localEmbedderPromise) {
    localEmbedderPromise = import("@huggingface/transformers")
      .then(({ pipeline }) =>
        pipeline("feature-extraction", MEMORY_EMBEDDING_MODEL, {
          dtype: "q8",
        }),
      )
      .catch((error) => {
        localEmbedderPromise = null;
        throw error;
      });
  }

  return localEmbedderPromise;
}

function tensorToVector(output) {
  if (output && typeof output.tolist === "function") {
    const list = output.tolist();
    if (Array.isArray(list?.[0])) return list[0].map(Number);
    if (Array.isArray(list)) return list.map(Number);
  }

  if (output?.data && typeof output.data.length === "number") {
    return Array.from(output.data, Number);
  }

  throw new Error("Embedding 模型没有返回可用向量");
}

async function embedLocal(text, { isQuery = false } = {}) {
  const cacheKey = `local|${MEMORY_EMBEDDING_MODEL}|${isQuery ? "q" : "d"}|${text}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const extractor = await getLocalEmbedder();
  const inputText = isQuery ? `${MEMORY_QUERY_INSTRUCTION}${text}` : text;
  const output = await extractor(inputText, {
    pooling: "mean",
    normalize: true,
  });

  const vector = tensorToVector(output);
  if (!vector.length || vector.some((value) => !Number.isFinite(value))) {
    throw new Error("本地 Embedding 返回了无效向量");
  }

  cacheSet(cacheKey, vector);
  return vector;
}

async function embedOpenAI(text) {
  const cacheKey = `openai|${MEMORY_EMBEDDING_URL}|${MEMORY_EMBEDDING_MODEL}|${text}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  if (!MEMORY_EMBEDDING_URL) {
    throw new Error(
      "MEMORY_EMBEDDING_MODE=openai 时必须设置 MEMORY_EMBEDDING_URL",
    );
  }

  const headers = { "Content-Type": "application/json" };
  if (MEMORY_EMBEDDING_API_KEY) {
    headers.Authorization = `Bearer ${MEMORY_EMBEDDING_API_KEY}`;
  }

  const response = await axios.post(
    MEMORY_EMBEDDING_URL,
    {
      model: MEMORY_EMBEDDING_MODEL,
      input: text,
    },
    {
      headers,
      timeout: 30_000,
    },
  );

  const vector =
    response?.data?.data?.[0]?.embedding || response?.data?.embedding || null;

  if (!Array.isArray(vector) || !vector.length) {
    throw new Error("OpenAI-compatible Embedding API 没有返回 embedding");
  }

  const normalized = vector.map(Number);
  if (normalized.some((value) => !Number.isFinite(value))) {
    throw new Error("OpenAI-compatible Embedding 返回了无效向量");
  }

  cacheSet(cacheKey, normalized);
  return normalized;
}

async function embed(text, { isQuery = false } = {}) {
  if (MEMORY_EMBEDDING_MODE === "openai") {
    return embedOpenAI(text);
  }
  return embedLocal(text, { isQuery });
}

export async function embedText(text) {
  return embed(String(text ?? ""));
}

function buildStateRow({
  uid,
  key,
  value,
  valueType,
  category,
  entity,
  status,
  version,
  versionId,
  createdAt,
  updatedAt,
  operation,
  vector,
}) {
  const storedValue = valueToStored(value, valueType);

  return {
    id: makeUidKey(uid, key),
    uid,
    uid_key: makeUidKey(uid, key),
    key,
    value: storedValue.value,
    value_json: storedValue.value_json,
    value_type: storedValue.value_type,
    category,
    entity,
    status,
    version,
    version_id: versionId,
    created_at: createdAt,
    updated_at: updatedAt,
    operation,
    source: "save_memory",
    schema_version: MEMORY_SCHEMA_VERSION,
    embedding_model: MEMORY_EMBEDDING_MODEL,
    embedding_dim: vector.length,
    embedding_profile: makeEmbeddingProfile(vector.length),
    normalized_hash: hashText(uid, key, storedValue.value_json),
    vector,
  };
}

function buildHistoryRow({ state, archivedStatus, supersededBy, archivedAt }) {
  return {
    id: hashText(
      state.uid,
      state.key,
      String(state.version),
      String(state.version_id),
      archivedStatus,
      String(archivedAt),
    ),
    uid: state.uid,
    uid_key: state.uid_key,
    key: state.key,
    value: state.value,
    value_json: state.value_json,
    value_type: state.value_type,
    category: state.category,
    entity: state.entity,
    status: archivedStatus,
    version: state.version,
    version_id: state.version_id,
    superseded_by: supersededBy || "",
    created_at: state.created_at,
    archived_at: archivedAt,
    operation: state.operation,
    source: state.source || "save_memory",
    schema_version: MEMORY_SCHEMA_VERSION,
    embedding_model: state.embedding_model,
    embedding_dim: state.embedding_dim,
    embedding_profile: state.embedding_profile,
    normalized_hash: state.normalized_hash,
    vector: state.vector,
  };
}

function formatSafeLogValue(value, max = 120) {
  return String(value ?? "")
    .slice(0, max)
    .replace(/[\r\n]/g, " ");
}

export const SAVE_MEMORY_TOOL = {
  type: "function",
  function: {
    name: "save_memory",
    description:
      "保存用户明确说出的长期信息。保存前先 search_memory，复用已有 key；不要补充、推测或猜测。用户明确修改已有信息时使用原 key。",
    parameters: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["replace", "append"],
          description: "replace=修改原值；append=增加并存值。",
        },
        key: {
          type: "string",
          minLength: 1,
          maxLength: MEMORY_MAX_KEY_LENGTH,
          description:
            "优先复用 search_memory 返回的原 key，不要凭空另造同义 key。",
        },
        value: {
          type: "string",
          maxLength: MEMORY_MAX_VALUE_LENGTH,
          description: "只填写用户明确说出的值。",
        },
        category: {
          type: "string",
          maxLength: MEMORY_MAX_CATEGORY_LENGTH,
          description: "可选宽泛标签。",
        },
        entity: {
          type: "string",
          maxLength: MEMORY_MAX_ENTITY_LENGTH,
          description: "可选主题实体。",
        },
      },
      required: ["operation", "key", "value"],
      additionalProperties: false,
    },
  },
};

export const SEARCH_MEMORY_TOOL = {
  type: "function",
  function: {
    name: "search_memory",
    description:
      "查询当前用户过去的信息。保存或修改前先用它查找已有 key；topic 用于获取同一主题的多项属性。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 1,
          maxLength: 300,
          description: "要找的信息。",
        },
        scope: {
          type: "string",
          enum: ["active", "history", "both"],
          description: "可选；默认 active。",
        },
        mode: {
          type: "string",
          enum: ["relevant", "topic"],
          description: "可选；topic 获取整组主题信息。",
        },
        entity: {
          type: "string",
          maxLength: MEMORY_MAX_ENTITY_LENGTH,
          description: "可选主题实体。",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
};

export const FORGET_MEMORY_TOOL = {
  type: "function",
  function: {
    name: "forget_memory",
    description: "移除当前用户不想保留的记忆；历史归档仍保留。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 1,
          maxLength: 300,
          description: "要忘掉的内容。",
        },
        key: {
          type: "string",
          maxLength: MEMORY_MAX_KEY_LENGTH,
          description: "可选；精确指定记忆键。",
        },
        value: {
          type: "string",
          maxLength: MEMORY_MAX_VALUE_LENGTH,
          description: "可选；只删除该键中的这个值。",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
};

async function findCurrentState(table, uid, key) {
  if (!table) return null;

  const uidValue = escapeSqlString(uid);
  const keyHash = escapeSqlString(makeUidKey(uid, key));
  const rows = await table
    .query()
    .where(`uid = '${uidValue}' AND uid_key = '${keyHash}'`)
    .select([
      "id",
      "uid",
      "uid_key",
      "key",
      "value",
      "value_json",
      "value_type",
      "category",
      "entity",
      "status",
      "version",
      "version_id",
      "created_at",
      "updated_at",
      "operation",
      "source",
      "schema_version",
      "embedding_model",
      "embedding_dim",
      "embedding_profile",
      "normalized_hash",
      "vector",
    ])
    .limit(1)
    .toArray();

  return rows?.[0] || null;
}

async function upsertState(table, row) {
  if (!table) throw new Error("memory_state 表不可用");

  await table
    .mergeInsert(["uid", "key"])
    .whenMatchedUpdateAll()
    .whenNotMatchedInsertAll()
    .execute([row]);
}

async function appendHistory(historyTable, row) {
  if (!historyTable) {
    await createOrGetHistoryTable(row);
    return;
  }
  await historyTable.add([row]);
}

async function applyReplace({
  stateTable,
  historyTable,
  uid,
  key,
  value,
  category,
  entity,
  vector,
  now,
}) {
  const current = await findCurrentState(stateTable, uid, key);
  const nextVersion = Number(current?.version || 0) + 1;
  const versionId = makeVersionId(uid, key, nextVersion, value);

  const nextState = buildStateRow({
    uid,
    key,
    value,
    valueType: "scalar",
    category: category || current?.category || "other",
    entity: entity || current?.entity || "",
    status: "active",
    version: nextVersion,
    versionId,
    createdAt: current?.created_at || now,
    updatedAt: now,
    operation: "replace",
    vector,
  });

  if (
    current?.status === "active" &&
    normalizeComparable(current?.value) === normalizeComparable(nextState.value)
  ) {
    return {
      ok: true,
      saved: false,
      duplicate: true,
      operation: "replace",
      content: "同一 key 的当前值已经是这个内容，没有重复写入。",
    };
  }

  await upsertState(stateTable, nextState);

  if (current) {
    const archivedAt = now;
    const historyRow = buildHistoryRow({
      state: current,
      archivedStatus: current.status === "deleted" ? "deleted" : "superseded",
      supersededBy: versionId,
      archivedAt,
    });
    await appendHistory(historyTable, historyRow);
  }

  console.log(
    `[Memory] replace | uid=${uid} | key=${formatSafeLogValue(key)} | version=${nextVersion}`,
  );

  return {
    ok: true,
    saved: true,
    operation: "replace",
    key,
    version: nextVersion,
    content: "已更新当前长期记忆。",
  };
}

async function applyAppend({
  stateTable,
  historyTable,
  uid,
  key,
  value,
  category,
  entity,
  vector,
  now,
}) {
  const current = await findCurrentState(stateTable, uid, key);
  const inputValue = normalizeValue(value);
  if (!inputValue) {
    return {
      ok: false,
      saved: false,
      operation: "append",
      content: "append 缺少有效的记忆值，没有写入。",
    };
  }

  if (current?.status === "active" && current.value_type !== "list") {
    const forcedVector = await embed(
      [category, entity, key, inputValue].filter(Boolean).join(" | "),
    );
    await ensureEmbeddingProfile(forcedVector, { createMeta: true });
    const forced = await applyReplace({
      stateTable,
      historyTable,
      uid,
      key,
      value: inputValue,
      category,
      entity,
      vector: forcedVector,
      now,
    });
    return {
      ...forced,
      requestedOperation: "append",
      forcedReplace: true,
      content: "当前 key 是单值属性，已直接替换原值。",
    };
  }

  const currentValues =
    current?.status === "active" ? readStoredValue(current) : [];
  const values = normalizeList([
    ...(Array.isArray(currentValues) ? currentValues : [currentValues]),
    inputValue,
  ]);

  const beforeComparable = new Set(
    (Array.isArray(currentValues) ? currentValues : [currentValues])
      .filter(Boolean)
      .map(normalizeComparable),
  );

  if (beforeComparable.has(normalizeComparable(inputValue))) {
    return {
      ok: true,
      saved: false,
      duplicate: true,
      operation: "append",
      content: "这个值已经存在于当前记忆中，没有重复添加。",
    };
  }

  const nextVersion = Number(current?.version || 0) + 1;
  const versionId = makeVersionId(uid, key, nextVersion, values.join("、"));
  const normalizedIncomingCategory = normalizeCategory(category);
  const normalizedIncomingEntity = normalizeEntity(entity);
  const categoryConflict = Boolean(
    current?.category &&
    normalizedIncomingCategory &&
    current.category !== "other" &&
    normalizedIncomingCategory !== "other" &&
    current.category !== normalizedIncomingCategory,
  );
  const entityConflict = Boolean(
    current?.entity &&
    normalizedIncomingEntity &&
    normalizeComparable(current.entity) !==
      normalizeComparable(normalizedIncomingEntity),
  );
  const nextCategory =
    current?.category && current.category !== "other"
      ? current.category
      : normalizedIncomingCategory;
  const nextEntity = current?.entity || normalizedIncomingEntity;
  // append 后 state 的向量必须代表“完整的新状态”，而不是只代表本次追加值。
  // 这样后续搜索同一个 key 的任意值时都能命中这个聚合后的状态。
  const nextEmbeddingText = [nextCategory, nextEntity, key, values.join("、")]
    .filter(Boolean)
    .join(" | ");
  const nextVector = await embed(nextEmbeddingText);
  await ensureEmbeddingProfile(nextVector, { createMeta: true });

  const nextState = buildStateRow({
    uid,
    key,
    value: values,
    valueType: "list",
    category: nextCategory,
    entity: nextEntity,
    status: "active",
    version: nextVersion,
    versionId,
    createdAt: current?.created_at || now,
    updatedAt: now,
    operation: "append",
    vector: nextVector,
  });

  await upsertState(stateTable, nextState);

  if (current) {
    await appendHistory(
      historyTable,
      buildHistoryRow({
        state: current,
        archivedStatus: current.status === "active" ? "superseded" : "deleted",
        supersededBy: versionId,
        archivedAt: now,
      }),
    );
  }

  console.log(
    `[Memory] append | uid=${uid} | key=${formatSafeLogValue(key)} | version=${nextVersion} | values=${values.length}`,
  );

  return {
    ok: true,
    saved: true,
    operation: "append",
    key,
    version: nextVersion,
    conflict: categoryConflict || entityConflict,
    content:
      categoryConflict || entityConflict
        ? "已追加；既有 key 的类别/实体保持不变。"
        : "已追加到当前长期记忆。",
  };
}

async function applyDelete({
  stateTable,
  historyTable,
  uid,
  key,
  value,
  vector,
  now,
}) {
  const current = await findCurrentState(stateTable, uid, key);
  if (!current || current.status !== "active") {
    return {
      ok: true,
      saved: false,
      operation: "delete",
      content: "当前没有可删除的有效记忆。",
    };
  }

  const requestedValue = normalizeValue(value);
  let nextValue;
  let nextType;
  let deletedWholeKey = false;

  if (current.value_type === "list") {
    const values = readStoredValue(current);
    if (!requestedValue) {
      nextValue = [];
      nextType = "list";
      deletedWholeKey = true;
    } else {
      const target = normalizeComparable(requestedValue);
      const filtered = values.filter(
        (item) => normalizeComparable(item) !== target,
      );

      if (filtered.length === values.length) {
        return {
          ok: true,
          saved: false,
          operation: "delete",
          content: "当前 key 中没有找到需要删除的这个值。",
        };
      }

      nextValue = filtered;
      nextType = filtered.length ? "list" : "list";
      deletedWholeKey = filtered.length === 0;
    }
  } else {
    if (
      requestedValue &&
      normalizeComparable(current.value) !== normalizeComparable(requestedValue)
    ) {
      return {
        ok: true,
        saved: false,
        operation: "delete",
        content: "当前 key 的值与要删除的值不一致，没有删除。",
      };
    }

    nextValue = "";
    nextType = "scalar";
    deletedWholeKey = true;
  }

  const nextVersion = Number(current.version || 0) + 1;
  const versionId = makeVersionId(
    uid,
    key,
    nextVersion,
    deletedWholeKey ? "<deleted>" : nextValue.join("、"),
  );

  if (deletedWholeKey) {
    const tombstone = buildStateRow({
      uid,
      key,
      value: "",
      valueType: "scalar",
      category: current.category,
      entity: current.entity,
      status: "deleted",
      version: nextVersion,
      versionId,
      createdAt: current.created_at || now,
      updatedAt: now,
      operation: "delete",
      vector,
    });

    await upsertState(stateTable, tombstone);
  } else {
    const nextEmbeddingText = [
      current.category,
      current.entity,
      key,
      nextValue.join("、"),
    ]
      .filter(Boolean)
      .join(" | ");
    const remainingVector = await embed(nextEmbeddingText);
    await ensureEmbeddingProfile(remainingVector, { createMeta: true });

    const nextState = buildStateRow({
      uid,
      key,
      value: nextValue,
      valueType: nextType,
      category: current.category,
      entity: current.entity,
      status: "active",
      version: nextVersion,
      versionId,
      createdAt: current.created_at || now,
      updatedAt: now,
      operation: "delete",
      vector: remainingVector,
    });
    await upsertState(stateTable, nextState);
  }

  await appendHistory(
    historyTable,
    buildHistoryRow({
      state: current,
      archivedStatus: deletedWholeKey ? "deleted" : "superseded",
      supersededBy: versionId,
      archivedAt: now,
    }),
  );

  console.log(
    `[Memory] delete | uid=${uid} | key=${formatSafeLogValue(key)} | version=${nextVersion} | whole=${deletedWholeKey}`,
  );

  return {
    ok: true,
    saved: true,
    operation: "delete",
    key,
    version: nextVersion,
    content: deletedWholeKey
      ? "已删除当前长期记忆，但历史归档仍保留。"
      : "已删除这个值，其他并存值保留；旧版本已归档。",
  };
}

export async function saveMemory(uid, memory) {
  const normalizedUid = normalizeUid(uid);
  const operation = String(memory?.operation || "")
    .trim()
    .toLowerCase();
  const key = normalizeKey(memory?.key);
  const value = normalizeValue(memory?.value);
  const category = normalizeCategory(memory?.category);
  const entity = normalizeEntity(memory?.entity);

  if (!MEMORY_ENABLED) {
    return {
      ok: false,
      saved: false,
      content: "长期记忆功能当前已关闭。",
    };
  }

  if (!normalizedUid) {
    return {
      ok: false,
      saved: false,
      content: "当前 QQ UID 无效，本次没有保存。",
    };
  }

  if (!["replace", "append", "delete"].includes(operation)) {
    return {
      ok: false,
      saved: false,
      content: "不支持的记忆操作。只能使用 replace、append 或 delete。",
    };
  }

  if (!key) {
    return {
      ok: false,
      saved: false,
      content: "缺少有效的 memory key。",
    };
  }

  if ((operation === "replace" || operation === "append") && !value) {
    return {
      ok: false,
      saved: false,
      content: `${operation} 操作必须提供有效的 value。`,
    };
  }

  const embeddingText =
    operation === "delete"
      ? [key, currentDeleteEmbeddingText(value)].filter(Boolean).join("：")
      : [category, entity, key, value].filter(Boolean).join(" | ");

  try {
    console.log(
      `[Memory] 写入开始 | uid=${normalizedUid} | operation=${operation} | key=${formatSafeLogValue(key)}`,
    );

    const vector = await embed(embeddingText);
    await ensureEmbeddingProfile(vector, { createMeta: true });

    return await withWriteLock(async () => {
      const now = new Date().toISOString();

      let stateTable = await openStateTable();

      // 第一次写入时不能先把 seed row 放进去再调用 apply*，否则 apply* 会把它误判为旧版本。
      // delete 在没有任何 current state 时直接 no-op，不创建无意义的 tombstone。
      if (!stateTable) {
        if (operation === "delete") {
          return {
            ok: true,
            saved: false,
            operation: "delete",
            content: "当前没有可删除的有效记忆。",
          };
        }

        const firstValue = operation === "append" ? [value] : value;
        const firstType = operation === "append" ? "list" : "scalar";
        const firstVersionId = makeVersionId(
          normalizedUid,
          key,
          1,
          operation === "append" ? [value].join("、") : value,
        );

        const firstState = buildStateRow({
          uid: normalizedUid,
          key,
          value: firstValue,
          valueType: firstType,
          category,
          entity,
          status: "active",
          version: 1,
          versionId: firstVersionId,
          createdAt: now,
          updatedAt: now,
          operation,
          vector,
        });

        stateTable = await createOrGetStateTable(firstState);

        console.log(
          `[Memory] ${operation} | uid=${normalizedUid} | key=${formatSafeLogValue(key)} | version=1 | initial=true`,
        );

        return {
          ok: true,
          saved: true,
          operation,
          key,
          version: 1,
          content:
            operation === "append"
              ? "已添加到当前长期记忆。"
              : "已保存当前长期记忆。",
        };
      }

      const historyTable = await openHistoryTable();

      if (operation === "replace") {
        return applyReplace({
          stateTable,
          historyTable,
          uid: normalizedUid,
          key,
          value,
          category,
          entity,
          vector,
          now,
        });
      }

      if (operation === "append") {
        return applyAppend({
          stateTable,
          historyTable,
          uid: normalizedUid,
          key,
          value,
          category,
          entity,
          vector,
          now,
        });
      }

      return applyDelete({
        stateTable,
        historyTable,
        uid: normalizedUid,
        key,
        value,
        vector,
        now,
      });
    });
  } catch (error) {
    console.error(
      `[Memory] 写入失败 | uid=${normalizedUid} | operation=${operation} | key=${formatSafeLogValue(key)} | ${error.name}: ${error.message}`,
    );

    return {
      ok: false,
      saved: false,
      content: "长期记忆写入失败，但不会阻塞当前正常对话。",
    };
  }
}

function currentDeleteEmbeddingText(value) {
  return value ? `删除记忆值 ${value}` : "删除记忆";
}

function prepareSearchText(text) {
  return String(text || "")
    .normalize("NFKC")
    .trim()
    .slice(0, 300);
}

function extractModelKeywords(text) {
  const source = String(text || "").normalize("NFKC");
  const matches =
    source.match(
      /\b(?:[A-Za-z]{1,12}[\s_-]?\d{3,8}[A-Za-z0-9_-]*|\d{3,8}[A-Za-z]{1,12}[A-Za-z0-9_-]*|\d{4,8})\b/g,
    ) || [];
  return [
    ...new Set(
      matches
        .map((item) => normalizeComparable(item))
        .filter((item) => item.length >= 3),
    ),
  ];
}

function rowSearchText(row) {
  return normalizeComparable(
    [row?.key, row?.value, row?.entity, row?.category]
      .filter(Boolean)
      .join(" "),
  );
}

async function searchLexicalModelRows({
  table,
  uid,
  query,
  limit,
  where,
  historical = false,
}) {
  const keywords = extractModelKeywords(query);
  if (!table || !keywords.length) return [];

  const finalWhere = where
    ? `uid = '${escapeSqlString(uid)}' AND ${where}`
    : `uid = '${escapeSqlString(uid)}'`;

  const rows = await table
    .query()
    .where(finalWhere)
    .select([
      "id",
      "uid",
      "uid_key",
      "key",
      "value",
      "value_json",
      "value_type",
      "category",
      "entity",
      "status",
      "version",
      "version_id",
      "created_at",
      historical ? "archived_at" : "updated_at",
    ])
    .limit(512)
    .toArray();

  const ranked = [];
  for (const row of rows) {
    const text = rowSearchText(row);
    const matched = keywords.filter((keyword) => text.includes(keyword));
    if (!matched.length) continue;
    ranked.push({
      ...row,
      _memory_scope: historical ? "history" : "active",
      _memory_lexical: true,
      _memory_lexical_count: matched.length,
    });
  }

  ranked.sort((a, b) => {
    const countDiff =
      Number(b._memory_lexical_count || 0) -
      Number(a._memory_lexical_count || 0);
    if (countDiff) return countDiff;
    return String(b.updated_at || b.archived_at || "").localeCompare(
      String(a.updated_at || a.archived_at || ""),
    );
  });

  return ranked.slice(0, limit);
}

async function searchTable({
  table,
  uid,
  query,
  limit,
  where,
  historical = false,
}) {
  if (!table) return [];

  const vector = await embed(query, { isQuery: true });
  await ensureEmbeddingProfile(vector, { createMeta: false });

  const uidFilter = `uid = '${escapeSqlString(uid)}'`;
  const finalWhere = where ? `${uidFilter} AND ${where}` : uidFilter;
  const selectedColumns = [
    "id",
    "uid",
    "uid_key",
    "key",
    "value",
    "value_json",
    "value_type",
    "category",
    "entity",
    "status",
    "version",
    "version_id",
    "created_at",
    historical ? "archived_at" : "updated_at",
  ];

  const vectorRows = await table
    .vectorSearch(vector)
    .distanceType("cosine")
    .where(finalWhere)
    .select(selectedColumns)
    .limit(limit)
    .toArray();

  const lexicalRows = await searchLexicalModelRows({
    table,
    uid,
    query,
    limit,
    where,
    historical,
  });

  const merged = [];
  const seen = new Set();
  for (const row of [...lexicalRows, ...vectorRows]) {
    const id = String(row?.id || "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    merged.push(row);
    if (merged.length >= limit) break;
  }

  return merged.map((row) => ({
    ...row,
    _memory_scope: historical ? "history" : "active",
  }));
}

function keyPrefix(key) {
  const value = String(key || "").trim();
  const index = value.indexOf(".");
  return index > 0 ? value.slice(0, index) : "";
}

async function expandTopicRows({
  table,
  uid,
  seedRows = [],
  limit,
  entity = "",
}) {
  if (!table) return seedRows;

  const normalizedEntity = normalizeEntity(entity);
  const seedPrefixes = new Set(
    seedRows.map((row) => keyPrefix(row.key)).filter(Boolean),
  );
  const seedEntities = new Set(
    seedRows.map((row) => normalizeEntity(row.entity)).filter(Boolean),
  );
  if (normalizedEntity) seedEntities.add(normalizedEntity);

  const uidFilter = `uid = '${escapeSqlString(uid)}' AND status = 'active'`;
  let siblings = [];

  try {
    siblings = await table
      .query()
      .where(uidFilter)
      .select([
        "id",
        "uid",
        "uid_key",
        "key",
        "value",
        "value_json",
        "value_type",
        "category",
        "entity",
        "status",
        "version",
        "version_id",
        "created_at",
        "updated_at",
      ])
      .limit(256)
      .toArray();
  } catch (error) {
    console.warn(
      `[Memory] topic 补齐失败 | uid=${uid} | ${error.name}: ${error.message}`,
    );
    return seedRows;
  }

  const selected = [];
  const seen = new Set(seedRows.map((row) => String(row.id || "")));
  for (const row of siblings) {
    const rowId = String(row.id || "");
    if (!rowId || seen.has(rowId)) continue;

    const rowEntity = normalizeEntity(row.entity);
    const rowPrefix = keyPrefix(row.key);
    const related =
      (normalizedEntity && rowEntity && rowEntity === normalizedEntity) ||
      (rowEntity && seedEntities.has(rowEntity)) ||
      (rowPrefix && seedPrefixes.has(rowPrefix));

    if (!related) continue;
    selected.push({ ...row, _memory_scope: "active", _memory_related: true });
    seen.add(rowId);
    if (seedRows.length + selected.length >= limit) break;
  }

  return [...seedRows, ...selected].slice(0, limit);
}

export async function searchMemories(uid, query, options = {}) {
  const opts = typeof options === "number" ? { limit: options } : options || {};
  const normalizedUid = normalizeUid(uid);
  const normalizedQuery = prepareSearchText(query);
  const scope = ["active", "history", "both"].includes(opts?.scope)
    ? opts.scope
    : "active";
  const mode = ["relevant", "topic"].includes(opts?.mode)
    ? opts.mode
    : "relevant";
  const outputLimit = clampInt(opts?.limit, mode === "topic" ? 20 : 10, 4, 24);
  const entity = normalizeEntity(opts?.entity);

  if (!MEMORY_ENABLED || !normalizedUid || !normalizedQuery) return [];

  const startedAt = Date.now();
  console.log(
    `[Memory] 检索开始 | uid=${normalizedUid} | scope=${scope} | mode=${mode} | query_len=${normalizedQuery.length}` +
      (entity ? ` | entity=${formatSafeLogValue(entity, 60)}` : ""),
  );

  try {
    const results = [];

    if (scope === "active" || scope === "both") {
      const stateTable = await openStateTable();
      if (stateTable) {
        const activeRows = await searchTable({
          table: stateTable,
          uid: normalizedUid,
          query: normalizedQuery,
          limit: outputLimit,
          where: `status = 'active'`,
          historical: false,
        });

        const expandedRows =
          mode === "topic"
            ? await expandTopicRows({
                table: stateTable,
                uid: normalizedUid,
                seedRows: activeRows,
                limit: outputLimit,
                entity,
              })
            : activeRows;

        results.push(...expandedRows);
      }
    }

    if (scope === "history" || scope === "both") {
      const historyTable = await openHistoryTable();
      if (historyTable) {
        results.push(
          ...(await searchTable({
            table: historyTable,
            uid: normalizedUid,
            query: normalizedQuery,
            limit: outputLimit,
            where: `status IN ('superseded', 'deleted')`,
            historical: true,
          })),
        );
      }
    }

    console.log(
      `[Memory] 检索结束 | uid=${normalizedUid} | scope=${scope} | mode=${mode} | hits=${results.length} | elapsed=${Date.now() - startedAt}ms`,
    );
    for (const row of results) {
      console.log(
        `[Memory] 命中 | uid=${normalizedUid} | scope=${row._memory_scope} | key=${formatSafeLogValue(row.key)} | entity=${formatSafeLogValue(row.entity, 60)} | related=${Boolean(row._memory_related)}`,
      );
    }

    return results;
  } catch (error) {
    console.error(
      `[Memory] 检索失败 | uid=${normalizedUid}: ${error.name}: ${error.message}`,
    );
    return [];
  }
}

export async function forgetMemory(uid, request = {}) {
  const normalizedUid = normalizeUid(uid);
  const query = prepareSearchText(request?.query);
  const key = normalizeKey(request?.key);
  const value = normalizeValue(request?.value);

  if (!MEMORY_ENABLED || !normalizedUid || !query) {
    return {
      ok: false,
      saved: false,
      operation: "forget",
      content: "没有找到可忘记的有效记忆。",
    };
  }

  try {
    if (key) {
      const result = await saveMemory(normalizedUid, {
        operation: "delete",
        key,
        value,
      });
      return { ...result, operation: "forget", matchedKey: key };
    }

    const rows = await searchMemories(normalizedUid, query, {
      scope: "active",
      mode: "relevant",
      limit: 3,
    });
    if (!rows.length) {
      return {
        ok: true,
        saved: false,
        operation: "forget",
        content: "没有找到需要忘记的当前记忆。",
      };
    }

    const target = rows[0];
    const result = await saveMemory(normalizedUid, {
      operation: "delete",
      key: target.key,
      value,
    });
    return { ...result, operation: "forget", matchedKey: target.key };
  } catch (error) {
    console.error(
      `[Memory] 忘记失败 | uid=${normalizedUid} | ${error.name}: ${error.message}`,
    );
    return {
      ok: false,
      saved: false,
      operation: "forget",
      content: "忘记记忆失败，但不会阻塞当前对话。",
    };
  }
}

function compactValueForContext(row) {
  if (row.value_type === "list") {
    const values = readStoredValue(row)
      .map((value) => value.slice(0, MEMORY_CONTEXT_VALUE_LIMIT))
      .slice(0, 5);
    return values.join("、");
  }

  return String(row.value || "").slice(0, MEMORY_CONTEXT_VALUE_LIMIT);
}

function compactKeyForContext(key, entity = "") {
  const rawKey = String(key || "").trim();
  const entityValue = normalizeEntity(entity);
  if (entityValue && rawKey.startsWith(`${entityValue}.`)) {
    return rawKey.slice(entityValue.length + 1);
  }
  const prefix = keyPrefix(rawKey);
  if (prefix && rawKey.startsWith(`${prefix}.`))
    return rawKey.slice(prefix.length + 1);
  return rawKey;
}

function groupMemoryRows(rows) {
  const groups = new Map();

  for (const row of rows) {
    const entity = normalizeEntity(row.entity);
    const prefix = keyPrefix(row.key);
    const groupId =
      entity || prefix || normalizeCategory(row.category) || "other";

    if (!groups.has(groupId)) {
      groups.set(groupId, {
        entity: entity || prefix || "",
        category: normalizeCategory(row.category),
        rows: [],
      });
    }

    const group = groups.get(groupId);
    const existing = group.rows.find(
      (item) => String(item.key) === String(row.key),
    );
    if (!existing) group.rows.push(row);
  }

  return groups;
}

function renderFormattedMemoryGroups(groups, historical) {
  const lines = [];
  let count = 0;

  for (const group of groups.values()) {
    if (count >= 16) break;

    const heading = group.entity ? group.entity : group.category || "其他";
    lines.push(`【${heading}】`);

    for (const row of group.rows) {
      if (count >= 16) break;
      const key = String(row.key || "").trim();
      const value = compactValueForContext(row);
      lines.push(`- ${key}：${value}`);
      count++;
    }
  }

  return lines;
}

function formatMemorySearchResults(rows, scope = "active") {
  if (!Array.isArray(rows) || !rows.length) return "没有找到相关长期记忆。";

  const currentRows = rows.filter((row) => row?._memory_scope === "active");
  const historyRows = rows.filter((row) => row?._memory_scope === "history");
  const sections = [];

  if (scope !== "history" && currentRows.length) {
    const groups = groupMemoryRows(currentRows);
    sections.push(
      ["【当前长期记忆】", ...renderFormattedMemoryGroups(groups, false)].join(
        "\n",
      ),
    );
  }

  if (scope !== "active" && historyRows.length) {
    const groups = groupMemoryRows(historyRows);
    sections.push(
      [
        "【长期记忆·历史归档】",
        ...renderFormattedMemoryGroups(groups, true),
      ].join("\n"),
    );
  }

  return sections.join("\n\n") || "没有找到相关长期记忆。";
}

export function formatMemorySearchResult(rows, scope = "active") {
  return formatMemorySearchResults(rows, scope);
}

// 保留这个导出用于旧脚本/测试；core 不再自动预检索，是否查询由模型通过 search_memory 决定。
export async function buildMemoryContext(uid, query) {
  const rows = await searchMemories(uid, query, {
    scope: "active",
    mode: "relevant",
    limit: MEMORY_TOP_K,
  });
  return rows.length ? formatMemorySearchResults(rows, "active") : "";
}

export async function listUserMemories(uid, { history = false } = {}) {
  const normalizedUid = normalizeUid(uid);
  if (!normalizedUid) return [];

  const table = history ? await openHistoryTable() : await openStateTable();
  if (!table) return [];

  const where = history
    ? `uid = '${escapeSqlString(normalizedUid)}'`
    : `uid = '${escapeSqlString(normalizedUid)}' AND status = 'active'`;

  return table
    .query()
    .where(where)
    .select([
      "uid",
      "key",
      "value",
      "value_type",
      "category",
      "entity",
      "status",
      "version",
      "created_at",
      history ? "archived_at" : "updated_at",
    ])
    .toArray();
}

export async function clearUserMemories(uid) {
  const normalizedUid = normalizeUid(uid);
  if (!MEMORY_ENABLED || !normalizedUid) return false;

  try {
    await withWriteLock(async () => {
      const stateTable = await openStateTable();
      if (stateTable) {
        await stateTable.delete(`uid = '${escapeSqlString(normalizedUid)}'`);
      }

      const historyTable = await openHistoryTable();
      if (historyTable) {
        await historyTable.delete(`uid = '${escapeSqlString(normalizedUid)}'`);
      }
    });

    console.log(`[Memory] 已永久清空用户记忆与历史归档 | uid=${normalizedUid}`);
    return true;
  } catch (error) {
    console.error(
      `[Memory] 清空失败 | uid=${normalizedUid}: ${error.name}: ${error.message}`,
    );
    return false;
  }
}

export async function migrateLegacyMemories() {
  if (!MEMORY_ENABLED) return { ok: false, imported: 0 };

  const legacy = await openTable(MEMORY_LEGACY_TABLE);
  if (!legacy) {
    return { ok: true, imported: 0, message: "没有发现旧版 memories 表。" };
  }

  const rows = await legacy.query().select(["uid", "fact"]).toArray();
  let imported = 0;
  let skipped = 0;

  for (const row of rows) {
    const uid = normalizeUid(row?.uid);
    const fact = normalizeValue(row?.fact);
    if (!uid || !fact) {
      skipped++;
      continue;
    }

    const key = `legacy.${hashText(uid, fact).slice(0, 16)}`;
    const result = await saveMemory(uid, {
      operation: "replace",
      key,
      value: fact,
      category: "other",
      entity: "",
    });

    if (result.saved || result.duplicate) imported++;
    else skipped++;
  }

  return {
    ok: true,
    imported,
    skipped,
    message:
      "旧版自由文本记忆已按 legacy key 导入；之后可由新结构化记忆逐步替换。",
  };
}

export async function initMemory() {
  if (!MEMORY_ENABLED) {
    console.log("[Memory] 长期记忆功能已关闭");
    return;
  }

  try {
    const db = await getDb();
    const names = await db.tableNames();
    const stateReady = names.includes(MEMORY_STATE_TABLE);
    const historyReady = names.includes(MEMORY_HISTORY_TABLE);

    console.log(
      `[Memory] LanceDB 已连接 | path=${MEMORY_DB_PATH} | state=${stateReady ? "ready" : "empty"} | history=${historyReady ? "ready" : "empty"} | embedding=${MEMORY_EMBEDDING_MODE}:${MEMORY_EMBEDDING_MODEL}`,
    );

    const meta = await loadEmbeddingMeta();
    if (meta) {
      console.log(
        `[Memory] Embedding 配置 | dim=${meta.embedding_dim} | profile=${formatSafeLogValue(meta.embedding_profile, 180)}`,
      );
    }

    if (names.includes(MEMORY_LEGACY_TABLE)) {
      console.log(
        `[Memory] 检测到旧版 memories 表；不会自动迁移。需要时调用 migrateLegacyMemories()。`,
      );
    }
  } catch (error) {
    console.error(`[Memory] 初始化失败: ${error.name}: ${error.message}`);
  }
}

void initMemory();
