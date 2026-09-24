import axios from "axios";
import { SEARXNG_API_URL } from "./config.js";
// ============================================================
// 判断是否需要搜索
// ============================================================
function extractSearchQuery(userText) {
  if (!userText) {
    return {
      needSearch: false,
      query: "",
    };
  }
  const text = userText.trim();
  if (!text) {
    return {
      needSearch: false,
      query: "",
    };
  }
  // ========================================================
  // 1. 明确搜索指令
  // ========================================================
  const explicitPatterns = [
    /^搜(?:一下|一下一下)?\s*(.+)$/i,
    /^搜索(?:一下)?\s*(.+)$/i,
    /^查(?:一下|一查)?\s*(.+)$/i,
    /^查查\s*(.+)$/i,
    /^联网(?:一下)?\s*(.+)$/i,
  ];
  for (const pattern of explicitPatterns) {
    const match = text.match(pattern);
    if (match) {
      const query = match[1].trim();
      if (query) {
        return {
          needSearch: true,
          query,
        };
      }
    }
  }
  // ========================================================
  // 英文 s xxx
  // ========================================================
  if (/^s\s+.+/i.test(text)) {
    const query = text.replace(/^s\s+/i, "").trim();
    if (query) {
      return {
        needSearch: true,
        query,
      };
    }
  }
  // ========================================================
  // 2. 实时信息
  // ========================================================
  const realtimePatterns = [
    /现在.*(几点|什么时间|多少点)/,
    /今天.*(新闻|消息|发生了什么)/,
    /最新.*(消息|新闻|版本|价格|型号|驱动|固件|配置)/,
    /最近.*(价格|新闻|消息|更新|版本|驱动|固件)/,
    /刚刚.*(发布|更新|宣布|上线|推出)/,
    /.*(发布了吗|发布了没)/,
    /.*(有没有更新|有更新吗)/,
    /.*(现在|目前).*(价格|售价|汇率|版本|驱动|固件)/,
    /.*(最新版本|最新驱动|最新固件)/,
    /.*(今天|现在|目前).*(支持|兼容|上市|发售)/,
  ];
  for (const pattern of realtimePatterns) {
    if (pattern.test(text)) {
      return {
        needSearch: true,
        query: text,
      };
    }
  }
  // ========================================================
  // 3. 默认不搜索
  // ========================================================
  return {
    needSearch: false,
    query: "",
  };
}
// ============================================================
// SearXNG
// ============================================================
async function getSearchContext(userText) {
  const { needSearch, query } = extractSearchQuery(userText);
  if (!needSearch || !query) {
    return null;
  }
  console.log(`[SearXNG] 搜索: ${query}`);
  const params = {
    q: query,
    format: "json",
    language: "zh-CN",
    safesearch: 0,
  };
  try {
    const response = await axios.get(SEARXNG_API_URL, {
      params,
      timeout: 8000,
      maxRedirects: 10,
    });
    const data = response.data;
    const results = data?.results;
    if (!Array.isArray(results)) {
      return null;
    }
    const formattedResults = [];
    for (let index = 0; index < Math.min(results.length, 5); index++) {
      const item = results[index];
      if (!item || typeof item !== "object") {
        continue;
      }
      const title = String(item.title || "").trim();
      let content = String(item.content || "").trim();
      const url = String(item.url || "").trim();
      const engine = String(item.engine || "").trim();
      if (content.length > 800) {
        content = content.slice(0, 800) + "...";
      }
      if (!title && !content) {
        continue;
      }
      let resultText = `[搜索结果 ${index + 1}]\n`;
      if (title) {
        resultText += `标题：${title}\n`;
      }
      if (content) {
        resultText += `摘要：${content}\n`;
      }
      if (url) {
        resultText += `来源：${url}\n`;
      }
      if (engine) {
        resultText += `搜索引擎：${engine}\n`;
      }
      formattedResults.push(resultText);
    }
    if (!formattedResults.length) {
      console.log("[SearXNG] 没有有效结果");
      return null;
    }
    console.log(`[SearXNG] 获得 ${formattedResults.length} 条结果`);
    return formattedResults.join("\n");
  } catch (error) {
    console.error(`[SearXNG] 请求失败: ${error.message}`);
    return null;
  }
}
export { extractSearchQuery, getSearchContext };
