import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env, pipeline } from "@huggingface/transformers";
import { RUNTIME_CONFIG, onRuntimeConfigReload } from "./config.js";
import { cleanValueText, shouldEvaluateMessage } from "./message-value.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODEL_ID = "Xenova/bge-small-zh-v1.5";
const QUERY_PREFIX = "为这个句子生成表示以用于检索相关文章：";
const K = 5;
const SIMILARITY_POWER = 8;
const SAMPLE_FILE = path.join(__dirname, "value-samples.jsonl");
const DEFAULT_SAMPLE_FILE = path.join(__dirname, "value-default-samples.jsonl");
const CACHE_DIR = path.join(__dirname, ".cache", "transformers");


// Transformers.js 会自动缓存 tokenizer、配置和 ONNX 权重；默认走 hf-mirror。
fs.mkdirSync(CACHE_DIR, { recursive: true });
env.remoteHost = process.env.HF_ENDPOINT || "https://hf-mirror.com";
env.cacheDir = CACHE_DIR;
env.useFSCache = true;

// 自定义样例与默认样例分开保存，评分时合并读取，不改写两个源文件。

let extractorPromise = null;
let samples = [];
const sampleMtimes = new Map();
let reloadPromise = null;
let watchTimer = null;
let lastFailureLogAt = 0;

function logFailureAtMostOncePerMinute(message) {
  const now = Date.now();
  if (now - lastFailureLogAt < 60_000) return;
  lastFailureLogAt = now;
  console.error(message);
}

function normalizeMode(mode) {
  const value = String(mode || "log").trim().toLowerCase();
  return ["off", "log", "block"].includes(value) ? value : "log";
}

async function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = pipeline("feature-extraction", MODEL_ID, { dtype: "int8" });
    extractorPromise.catch(() => { extractorPromise = null; });
  }
  return extractorPromise;
}

async function embed(text, isQuery = false) {
  const extractor = await getExtractor();
  const input = isQuery ? `${QUERY_PREFIX}${text}` : text;
  const output = await extractor(input, { pooling: "cls", normalize: true });
  return Array.from(output.data, Number);
}

function dotSimilarity(a, b) {
  const length = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < length; i++) sum += a[i] * b[i];
  return sum;
}

async function reloadSamples(force = false) {
  if (reloadPromise) {
    if (!force) return reloadPromise;
    return reloadPromise.then(() => reloadSamples(true));
  }

  reloadPromise = (async () => {
    const sampleFiles = [SAMPLE_FILE, DEFAULT_SAMPLE_FILE];
    const stats = await Promise.all(
      sampleFiles.map((file) => fs.promises.stat(file).catch(() => null))
    );
    const unchanged = stats.every((stat, index) => {
      const currentMtime = stat?.mtimeMs ?? -1;
      return currentMtime === (sampleMtimes.get(sampleFiles[index]) ?? -1);
    });
    if (!force && unchanged) return;

    const parsed = [];
    for (let fileIndex = 0; fileIndex < sampleFiles.length; fileIndex++) {
      const file = sampleFiles[fileIndex];
      if (!stats[fileIndex]) continue;

      const text = await fs.promises.readFile(file, "utf8");
      for (const [index, line] of text.split(/\r?\n/).entries()) {
        if (!line.trim()) continue;
        try {
          const item = JSON.parse(line);
          const m = typeof item?.m === "string" ? cleanValueText(item.m) : "";
          const y = Number(item?.y);
          if (!m || ![0, 1].includes(y)) {
            console.warn(`[价值评分] 跳过无效样例（${path.basename(file)}），第 ${index + 1} 行`);
            continue;
          }
          parsed.push({ m, y });
        } catch {
          console.warn(`[价值评分] 跳过无法解析的样例（${path.basename(file)}），第 ${index + 1} 行`);
        }
      }
    }

    // 先计算到临时数组，全部完成后再替换，避免文件编辑期间留下半套向量。
    const vectors = [];
    if (parsed.length) {
      const extractor = await getExtractor();
      const batchSize = 16;
      for (let start = 0; start < parsed.length; start += batchSize) {
        const batch = parsed.slice(start, start + batchSize);
        const output = await extractor(batch.map((item) => item.m), {
          pooling: "cls",
          normalize: true,
        });
        const rows = typeof output.tolist === "function" ? output.tolist() : null;
        if (Array.isArray(rows) && Array.isArray(rows[0])) {
          for (let i = 0; i < batch.length; i++) {
            vectors.push({ ...batch[i], vector: rows[i].map(Number) });
          }
        } else {
          const flat = Array.from(output.data, Number);
          const width = Math.floor(flat.length / batch.length);
          for (let i = 0; i < batch.length; i++) {
            vectors.push({ ...batch[i], vector: flat.slice(i * width, (i + 1) * width) });
          }
        }
      }
    }

    samples = vectors;
    for (let index = 0; index < sampleFiles.length; index++) {
      sampleMtimes.set(sampleFiles[index], stats[index]?.mtimeMs ?? -1);
    }
    console.log(`[价值评分] 样例向量已加载：${samples.length} 条`);
  })().finally(() => {
    reloadPromise = null;
  });

  return reloadPromise;
}


export async function initializeValueScorer() {
  await reloadSamples(true);
  return { model: MODEL_ID, samples: samples.length };
}

export async function scoreMessage(message, mode = RUNTIME_CONFIG.valueScoreMode || "log") {
  const selectedMode = normalizeMode(mode);
  if (selectedMode === "off") {
    return { allow: true, blocked: false, mode: selectedMode, score: null, topSimilarity: null };
  }

  const filtered = shouldEvaluateMessage(message);
  const text = filtered.text;
  if (!filtered.eligible) {
    return { allow: true, blocked: false, mode: selectedMode, score: null, topSimilarity: null, lowConfidence: true, filtered: true, filterReason: filtered.reason };
  }

  try {
    await reloadSamples();
    if (!samples.length) {
      return { allow: true, blocked: false, mode: selectedMode, score: null, topSimilarity: null };
    }

    const vector = await embed(text, true);
    const neighbors = samples
      .map((sample) => ({
        m: sample.m,
        y: sample.y,
        similarity: dotSimilarity(vector, sample.vector),
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, K)
      .map((item) => ({
        ...item,
        weight: Math.max(0, item.similarity) ** SIMILARITY_POWER,
      }));

    const topSimilarity = neighbors[0]?.similarity ?? 0;
    const confidenceThreshold = Number.isFinite(Number(RUNTIME_CONFIG.vectorConfidenceThreshold)) ? Number(RUNTIME_CONFIG.vectorConfidenceThreshold) : 0.5;
    const lowConfidence = topSimilarity < confidenceThreshold;
    let score = null;
    let wouldBlock = false;

    if (!lowConfidence) {
      let weightedVote = 0;
      let totalWeight = 0;
      for (const item of neighbors) {
        weightedVote += item.weight * item.y;
        totalWeight += item.weight;
      }
      score = totalWeight > 0 ? weightedVote / totalWeight : 0;
      // y=1 表示高价值；只有可信度足够且投票低于阈值，才应拦截。
      wouldBlock = score < (Number.isFinite(Number(RUNTIME_CONFIG.autoChimeScoreThreshold)) ? Number(RUNTIME_CONFIG.autoChimeScoreThreshold) : 0.5);
    }


    // log 只记录判断，不实际阻断；block 才会让低价值消息退出自动接话流程。
    const blocked = selectedMode === "block" && wouldBlock && !lowConfidence;
    return { allow: !blocked, blocked, mode: selectedMode, score, topSimilarity, lowConfidence, wouldBlock };
  } catch (error) {
    logFailureAtMostOncePerMinute(`[价值评分] 评分失败，按放行处理：${error.message}`);
    return { allow: true, blocked: false, mode: selectedMode, score: null, topSimilarity: null, error: error.message };
  }
}

let sampleWatcherStarted = false;
let initializationPromise = null;

function startSampleWatcher() {
  if (sampleWatcherStarted) return;
  sampleWatcherStarted = true;
  for (const file of [SAMPLE_FILE, DEFAULT_SAMPLE_FILE]) {
    fs.watchFile(file, { interval: 1000 }, (current, previous) => {
      if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) return;
      if (watchTimer) clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        watchTimer = null;
        if (normalizeMode(RUNTIME_CONFIG.valueScoreMode) === "off") return;
        void reloadSamples(true).catch((error) => {
          console.error(`[价值评分] 样例热重载失败，沿用旧样例：${error.message}`);
        });
      }, 250);
    });
  }
}

function ensureValueScorerInitialized() {
  if (normalizeMode(RUNTIME_CONFIG.valueScoreMode) === "off") return;
  if (initializationPromise) return initializationPromise;
  initializationPromise = initializeValueScorer()
    .catch((error) => logFailureAtMostOncePerMinute(`[价值评分] 初始化失败，后续消息评分时会重试：${error.message}`))
    .finally(() => { initializationPromise = null; });
  return initializationPromise;
}

// 文件监听始终存在；若从 off 热切换到 log/block，也能初始化模型并开始评分。
startSampleWatcher();
void ensureValueScorerInitialized();
onRuntimeConfigReload(() => {
  if (normalizeMode(RUNTIME_CONFIG.valueScoreMode) !== "off") void ensureValueScorerInitialized();
});
