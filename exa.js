import axios from "axios";
import { EXA_API_KEY, EXA_API_URL } from "./config.js";
// ============================================================
// 配置
// ============================================================
const DEFAULT_NUM_RESULTS = 5;
const MAX_NUM_RESULTS = 8;
const MAX_RESULT_TEXT_LENGTH = 1800;
const MAX_TOTAL_CONTEXT_LENGTH = 10000;
// ============================================================
// 工具
// ============================================================
function normalizeNumResults(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    return DEFAULT_NUM_RESULTS;
  }
  return Math.min(MAX_NUM_RESULTS, number);
}
function truncateText(text, maxLength) {
  const value = String(text || "").trim();
  if (!value) {
    return "";
  }
  if (value.length <= maxLength) {
    return value;
  }
  return value.slice(0, maxLength) + "...";
}
// ============================================================
// Exa 搜索
// ============================================================
async function exaSearch(query, options = {}) {
  const cleanQuery = typeof query === "string" ? query.trim() : "";
  if (!cleanQuery) {
    return {
      ok: false,
      content: "Exa 搜索失败：搜索关键词为空。",
    };
  }
  if (!EXA_API_KEY) {
    console.error("[Exa] EXA_API_KEY 未配置");
    return {
      ok: false,
      content: "Exa 搜索暂不可用：服务器没有配置 EXA_API_KEY。",
    };
  }
  const numResults = normalizeNumResults(options.numResults);
  console.log(`[Exa] 搜索: ${cleanQuery} | numResults=${numResults}`);
  try {
    const response = await axios.post(
      EXA_API_URL,
      {
        query: cleanQuery,
        type: "auto",
        numResults,
        contents: {
          text: true,
        },
      },
      {
        headers: {
          "x-api-key": EXA_API_KEY,
          "Content-Type": "application/json",
        },
        timeout: 15000,
        maxRedirects: 5,
      },
    );
    const data = response.data;
    // ========================================================
    // 优先使用 Exa 返回的 context
    // ========================================================
    if (typeof data?.context === "string" && data.context.trim()) {
      const context = truncateText(data.context, MAX_TOTAL_CONTEXT_LENGTH);
      console.log(`[Exa] 返回 context | ${context.length} 字符`);
      return {
        ok: true,
        content: "[Exa 网络搜索结果]\n" + context,
      };
    }
    // ========================================================
    // 普通 results
    // ========================================================
    const results = Array.isArray(data?.results) ? data.results : [];
    if (!results.length) {
      console.log("[Exa] 没有搜索结果");
      return {
        ok: true,
        content: "[Exa 网络搜索结果]\n没有找到有效结果。",
      };
    }
    const formattedResults = [];
    let totalLength = 0;
    for (let index = 0; index < Math.min(results.length, numResults); index++) {
      const item = results[index];
      if (!item || typeof item !== "object") {
        continue;
      }
      const title = String(item.title || "").trim();
      const url = String(item.url || "").trim();
      const publishedDate = String(item.publishedDate || "").trim();
      let text = String(item.text || "").trim();
      const summary = String(item.summary || "").trim();
      const highlights = Array.isArray(item.highlights)
        ? item.highlights
            .map((value) => String(value || "").trim())
            .filter(Boolean)
        : [];
      if (!text) {
        text = summary;
      }
      if (!text && highlights.length) {
        text = highlights.join("\n");
      }
      text = truncateText(text, MAX_RESULT_TEXT_LENGTH);
      let resultText = `[搜索结果 ${index + 1}]\n`;
      if (title) {
        resultText += `标题：${title}\n`;
      }
      if (publishedDate) {
        resultText += `发布时间：${publishedDate}\n`;
      }
      if (text) {
        resultText += `摘要：${text}\n`;
      }
      if (url) {
        resultText += `来源：${url}\n`;
      }
      const remaining = MAX_TOTAL_CONTEXT_LENGTH - totalLength;
      if (remaining <= 0) {
        break;
      }
      const clipped = resultText.slice(0, remaining);
      formattedResults.push(clipped);
      totalLength += clipped.length;
    }
    if (!formattedResults.length) {
      return {
        ok: true,
        content: "[Exa 网络搜索结果]\n没有找到有效结果。",
      };
    }
    const content = "[Exa 网络搜索结果]\n" + formattedResults.join("\n");
    console.log(`[Exa] 获得 ${formattedResults.length} 条结果`);
    return {
      ok: true,
      content,
    };
  } catch (error) {
    const status = error?.response?.status;
    const responseData = error?.response?.data;
    console.error(
      `[Exa] 请求失败 | ` +
        `status=${status ?? "unknown"} | ` +
        `name=${error.name || "unknown"} | ` +
        `message=${error.message || "unknown"}`,
    );
    if (responseData) {
      console.error("[Exa] 返回:", JSON.stringify(responseData, null, 2));
    }
    return {
      ok: false,
      content: "Exa 网络搜索失败：" + (error.message || "未知错误"),
    };
  }
}
// ============================================================
// 导出
// ============================================================
export { exaSearch };
