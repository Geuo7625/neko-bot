import { NAPCAT_HTTP_URL, NAPCAT_TOKEN } from "./config.js";

import {
  parseMessageBlocks,
  splitCode,
  renderRichContentToBase64,
  renderFullLatexToBase64,
} from "./latex-renderer.js";

const BOT_QQ = "2716519388";
const BOT_NICKNAME = "NekoCode";
const CODE_CHUNK_SIZE = 3000;

/*
 * 只有这些语言的“围栏代码块”才会被渲染成图片。
 * 普通文本中的 Markdown / LaTeX 语法一律不再触发图片渲染。
 */
const RICH_CODE_LANGUAGES = new Set([
  "markdown",
  "md",
  "mdown",
  "mkdown",
  "latex",
  "tex",
  "ltx",
  "math",
  "mathjax",
  "mermaid",
]);

const LATEX_LANGUAGES = new Set(["latex", "tex", "ltx", "math", "mathjax"]);

function getHeaders() {
  const headers = {
    "Content-Type": "application/json",
  };

  if (NAPCAT_TOKEN) {
    headers["Authorization"] = `Bearer ${NAPCAT_TOKEN}`;
  }

  return headers;
}

async function napcatApi(action, params = {}) {
  const url = `${NAPCAT_HTTP_URL.replace(/\/+$/, "")}/${action}`;

  const response = await fetch(url, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const body = await response.text();

    throw new Error(`NapCat API 请求失败: HTTP ${response.status} ${body}`);
  }

  return await response.json();
}

function makeForwardNode(
  content,
  senderName = BOT_NICKNAME,
  senderId = BOT_QQ,
) {
  return {
    type: "node",
    data: {
      name: senderName,
      uin: String(senderId),
      content: [
        {
          type: "text",
          data: {
            text: content,
          },
        },
      ],
    },
  };
}

async function sendForwardMessage(targetId, isGroup, nodes) {
  if (!nodes || nodes.length === 0) {
    return;
  }

  const action = isGroup
    ? "send_group_forward_msg"
    : "send_private_forward_msg";

  const params = isGroup
    ? {
        group_id: targetId,
        messages: nodes,
      }
    : {
        user_id: targetId,
        messages: nodes,
      };

  await napcatApi(action, params);
}

async function sendPlainText(targetId, isGroup, text) {
  if (!text) {
    return;
  }

  const cleaned = String(text).replace(/^[\r\n]+|[\r\n]+$/g, "");

  if (!cleaned) {
    return;
  }

  const action = isGroup ? "send_group_msg" : "send_private_msg";

  const key = isGroup ? "group_id" : "user_id";

  await napcatApi(action, {
    [key]: targetId,
    message: [
      {
        type: "text",
        data: {
          text: cleaned,
        },
      },
    ],
  });
}

async function sendImage(targetId, isGroup, imageBase64) {
  if (!imageBase64) {
    return;
  }

  const action = isGroup ? "send_group_msg" : "send_private_msg";

  const key = isGroup ? "group_id" : "user_id";

  await napcatApi(action, {
    [key]: targetId,
    message: [
      {
        type: "image",
        data: {
          file: `base64://${imageBase64}`,
        },
      },
    ],
  });
}

async function sendRichBlock(targetId, isGroup, markdown) {
  if (!markdown || !markdown.trim()) {
    return;
  }

  try {
    const imageBase64 = await renderRichContentToBase64(markdown);

    if (!imageBase64) {
      console.error("[SpecialContent] rich 渲染失败，降级原文");

      await sendPlainText(targetId, isGroup, markdown);

      return;
    }

    await sendImage(targetId, isGroup, imageBase64);
  } catch (error) {
    console.error("[SpecialContent] rich 发送失败，降级原文:", error);

    await sendPlainText(targetId, isGroup, markdown);
  }
}

function getBlockLanguage(block) {
  return String(
    block?.language ??
      block?.lang ??
      block?.languageName ??
      block?.codeLanguage ??
      "",
  )
    .trim()
    .toLowerCase()
    .replace(/^language-/, "")
    .replace(/^lang-/, "");
}

function getRawBlockCode(block) {
  return String(block?.code ?? block?.text ?? block?.content ?? "");
}

/*
 * LaTeX 自动容错
 *
 * 目标：
 * 1. 正常 LaTeX 完全不修改
 * 2. 修复常见的反斜杠丢失
 * 3. 修复 \documentclass -> Idocumentclass / ldocumentclass
 * 4. 修复 \begin -> Ibegin / lbegin
 * 5. 修复常见命令前的反斜杠丢失
 * 6. 只有高度确定是 LaTeX 时才修复
 * 7. 修复后必须再次验证，否则回退原文
 */
function repairBrokenLatex(code) {
  if (!code) {
    return code;
  }

  const source = String(code);

  /*
   * ----------------------------------------
   * 1. 正常 LaTeX：完全不碰
   * ----------------------------------------
   */
  if (
    /\\documentclass(?:\[[^\]]*\])?\s*\{/i.test(source) ||
    /\\begin\s*\{\s*document\s*\}/i.test(source)
  ) {
    return source;
  }

  /*
   * ----------------------------------------
   * 2. 判断是不是疑似“反斜杠损坏的完整 LaTeX”
   * ----------------------------------------
   *
   * 不要看到一个 documentclass 就修。
   * 至少命中两个结构才进入容错。
   */
  const strongBrokenPatterns = [
    /\b(?:I|l)documentclass(?:\[[^\]]*\])?\s*\{/i,
    /\b(?:I|l)usepackage(?:\[[^\]]*\])?\s*\{/i,
    /\b(?:I|l)begin\s*\{\s*document\s*\}/i,
    /\b(?:I|l)end\s*\{\s*document\s*\}/i,
    /\b(?:I|l)maketitle\b/i,
  ];

  const strongMatches = strongBrokenPatterns.filter((pattern) =>
    pattern.test(source),
  ).length;

  /*
   * 没有明显损坏特征，直接返回。
   */
  if (strongMatches < 2) {
    return source;
  }

  let repaired = source;

  /*
   * ----------------------------------------
   * 3. 修复高置信度命令
   * ----------------------------------------
   */
  const commands = [
    "documentclass",
    "usepackage",
    "begin",
    "end",
    "maketitle",

    "title",
    "author",
    "date",

    "section",
    "subsection",
    "subsubsection",
    "chapter",

    "label",
    "ref",
    "pageref",
    "cite",

    "textbf",
    "textit",
    "texttt",
    "textrm",
    "textsf",
    "textsc",
    "emph",
    "underline",

    "frac",
    "dfrac",
    "tfrac",
    "sqrt",

    "mathbf",
    "mathrm",
    "mathit",
    "mathsf",
    "mathtt",
    "mathcal",
    "mathbb",
    "mathfrak",

    "includegraphics",
    "caption",
    "centering",

    "newcommand",
    "renewcommand",
    "providecommand",

    "input",
    "include",

    "item",
    "footnote",
    "footnotemark",
    "footnotetext",
  ];

  for (const command of commands) {
    const pattern = new RegExp(
      `(^|[\\s{}])(?:I|l)${command}(?=\\s|\\{|\\[|$)`,
      "gm",
    );

    repaired = repaired.replace(pattern, `$1\\\\${command}`);
  }

  /*
   * ----------------------------------------
   * 4. 修复某些“命令前反斜杠变成普通空白”的情况
   *
   * 例如：
   *
   * \begin{document}
   * ↓
   * begin{document}
   *
   * 但这里必须非常谨慎。
   * ----------------------------------------
   */
  const structuralCommands = [
    "documentclass",
    "usepackage",
    "begin",
    "end",
    "maketitle",
  ];

  for (const command of structuralCommands) {
    const pattern = new RegExp(
      `(^|[\\n\\r])\\s*${command}(?=\\s*\\{|\\s*$)`,
      "gm",
    );

    repaired = repaired.replace(pattern, `$1\\\\${command}`);
  }

  /*
   * ----------------------------------------
   * 5. 修复 LaTeX 环境
   *
   * 例如：
   *
   * Ibegin{equation}
   * Iend{equation}
   *
   * ----------------------------------------
   */
  const environments = [
    "document",
    "equation",
    "equation*",
    "align",
    "align*",
    "gather",
    "gather*",
    "multline",
    "multline*",
    "matrix",
    "pmatrix",
    "bmatrix",
    "vmatrix",
    "cases",
    "array",
    "itemize",
    "enumerate",
    "figure",
    "table",
    "tabular",
    "theorem",
    "definition",
    "proof",
  ];

  for (const environment of environments) {
    const escaped = environment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    repaired = repaired.replace(
      new RegExp(`(^|[\\s{}])(?:I|l)begin\\s*\\{${escaped}\\}`, "g"),
      `$1\\\\begin{${environment}}`,
    );

    repaired = repaired.replace(
      new RegExp(`(^|[\\s{}])(?:I|l)end\\s*\\{${escaped}\\}`, "g"),
      `$1\\\\end{${environment}}`,
    );
  }

  /*
   * ----------------------------------------
   * 6. 最终验证
   *
   * 必须真的恢复成完整 LaTeX。
   * ----------------------------------------
   */
  const validAfterRepair =
    /\\documentclass(?:\[[^\]]*\])?\s*\{[^}]+\}/i.test(repaired) &&
    /\\begin\s*\{\s*document\s*\}/i.test(repaired) &&
    /\\end\s*\{\s*document\s*\}/i.test(repaired);

  if (!validAfterRepair) {
    console.warn("[SpecialContent] LaTeX 容错失败，保持原文");

    return source;
  }

  if (repaired !== source) {
    console.warn("[SpecialContent] 检测到疑似损坏 LaTeX，已自动恢复");
  }

  return repaired;
}

function getBlockCode(block) {
  const raw = getRawBlockCode(block);

  if (!raw.trim()) {
    return "";
  }

  const language = getBlockLanguage(block);

  /*
   * 只有明确标记为 LaTeX 的代码块才进行容错。
   * 普通代码绝对不做这种修复。
   */
  if (LATEX_LANGUAGES.has(language)) {
    return repairBrokenLatex(raw).trim();
  }

  return raw.trim();
}

function isRichCodeBlock(block) {
  const language = getBlockLanguage(block);

  return RICH_CODE_LANGUAGES.has(language);
}

function isLatexCodeBlock(block) {
  return LATEX_LANGUAGES.has(getBlockLanguage(block));
}

function looksLikeFullLatexDocument(code) {
  if (!code) {
    return false;
  }

  const source = String(code);

  return (
    /\\documentclass(?:\[[^\]]*\])?\s*\{[^}]+\}/i.test(source) ||
    /\\begin\s*\{\s*document\s*\}/i.test(source) ||
    /\\end\s*\{\s*document\s*\}/i.test(source)
  );
}

function getRichContentFromCodeBlock(block) {
  const language = getBlockLanguage(block);
  const code = getBlockCode(block);

  if (!code) {
    return "";
  }

  if (LATEX_LANGUAGES.has(language)) {
    if (looksLikeFullLatexDocument(code)) {
      return code;
    }

    return `$$
${code}
$$`;
  }

  if (language === "mermaid") {
    return `\`\`\`mermaid
${code}
\`\`\``;
  }

  return code;
}

async function sendLatexCodeBlock(targetId, isGroup, block) {
  /*
   * getBlockCode() 会在这里自动进行一次
   * “损坏 LaTeX 反斜杠恢复”。
   */
  const code = getBlockCode(block);

  if (!code) {
    return;
  }

  if (!looksLikeFullLatexDocument(code)) {
    await sendRichBlock(
      targetId,
      isGroup,
      `$$
${code}
$$`,
    );

    return;
  }

  try {
    const imageBase64 = await renderFullLatexToBase64(code);

    if (!imageBase64) {
      console.error("[SpecialContent] 完整 LaTeX 编译器不可用，降级原文");

      await sendPlainText(targetId, isGroup, code);

      return;
    }

    await sendImage(targetId, isGroup, imageBase64);
  } catch (error) {
    console.error("[SpecialContent] 完整 LaTeX 编译失败，降级原文:", error);

    await sendPlainText(targetId, isGroup, code);
  }
}

async function sendCodeBlock(targetId, isGroup, code) {
  if (!code) {
    return;
  }

  const chunks = splitCode(code, CODE_CHUNK_SIZE);

  if (!chunks.length) {
    return;
  }

  const nodes = [];

  for (const chunk of chunks) {
    if (!chunk) {
      continue;
    }

    nodes.push(makeForwardNode(chunk));
  }

  await sendForwardMessage(targetId, isGroup, nodes);
}

async function sendLatexImage(targetId, isGroup, latex) {
  if (!latex) {
    return;
  }

  await sendRichBlock(
    targetId,
    isGroup,
    `$$
${latex}
$$`,
  );
}

async function sendMixedLatexImage(targetId, isGroup, content) {
  await sendRichBlock(targetId, isGroup, content);
}

async function sendNormalSegment(targetId, isGroup, text) {
  await sendPlainText(targetId, isGroup, text);
}

const MESSAGE_SPLIT_PATTERN = /\s*===SPLIT===\s*/g;

function splitMessages(text) {
  if (!text) {
    return [];
  }

  return String(text)
    .split(MESSAGE_SPLIT_PATTERN)
    .map((item) => item.trim())
    .filter(Boolean);
}

/*
 * ============================================================
 * 核心：只有“代码块包裹”的内容才允许被渲染成图片
 * ============================================================
 *
 * - text      → 纯文本发送
 * - markdown  → 纯文本发送（重要：不再渲染图片）
 * - code      → 只有命中 RICH_CODE_LANGUAGES 才渲染图片，
 *                否则按普通代码块转发
 *
 * 普通消息里的 $...$、$$...$$、**加粗**、标题、列表等
 * 不再触发任何图片渲染。
 */
async function sendSpecialContent(targetId, isGroup, text) {
  if (!text) {
    return;
  }

  const messages = splitMessages(text);

  if (!messages.length) {
    return;
  }

  for (const message of messages) {
    if (!message || !message.trim()) {
      continue;
    }

    const blocks = parseMessageBlocks(message);

    if (!blocks.length) {
      continue;
    }

    for (const block of blocks) {
      if (block.type === "text") {
        await sendPlainText(targetId, isGroup, block.text);

        continue;
      }

      /*
       * 关键修改：
       *
       * 之前的实现会在这里把 markdown 交给 sendRichBlock()，
       * 于是普通文本只要包含 $...$、**xx**、# 标题 等语法，
       * 就会被强制渲染成图片。
       *
       * 现在改为纯文本发送：
       * 只有被代码块包裹的内容才会进入图片渲染流程。
       */
      if (block.type === "markdown") {
        await sendPlainText(targetId, isGroup, block.markdown);

        continue;
      }

      if (block.type === "code") {
        /*
         * 非白名单语言的代码块 → 走转发，不渲染图片。
         */
        if (!isRichCodeBlock(block)) {
          await sendCodeBlock(targetId, isGroup, block.code);

          continue;
        }

        /*
         * LaTeX 代码块 → 专用渲染通道。
         */
        if (isLatexCodeBlock(block)) {
          await sendLatexCodeBlock(targetId, isGroup, block);

          continue;
        }

        /*
         * markdown / mermaid 等白名单代码块 → 渲染成图片。
         */
        const richContent = getRichContentFromCodeBlock(block);

        if (richContent) {
          await sendRichBlock(targetId, isGroup, richContent);
        }

        continue;
      }
    }
  }
}

export {
  napcatApi,
  parseMessageBlocks,
  splitCode,
  splitMessages,
  makeForwardNode,
  sendForwardMessage,
  sendPlainText,
  sendLatexImage,
  sendMixedLatexImage,
  sendNormalSegment,
  sendRichBlock,
  sendCodeBlock,
  sendSpecialContent,
};
