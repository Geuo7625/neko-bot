import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);
const BASE_DIR = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(BASE_DIR, "template.html");

const MIN_WIDTH = 300;
const MAX_WIDTH = 1800;
const VIEWPORT_HEIGHT = 1000;

const LATEX_WASM_DIR = path.join(BASE_DIR, "latex-wasm", "busytex");
const BUSYTEX_WEB_BASE = "/busytex";

const BUSYTEX_REMOTE_ENDPOINT = String(
  process.env.BUSYTEX_REMOTE_ENDPOINT || "https://texlive2026.texlyre.org",
).trim();

let browser = null;
let page = null;
let browserPromise = null;
let pagePromise = null;

let localServer = null;
let localServerOrigin = null;
let localServerPromise = null;

let renderQueue = Promise.resolve();

function enqueueRender(task) {
  const next = renderQueue.then(task, task);
  renderQueue = next.catch(() => {});
  return next;
}

function resolvePackageFile(packageName, relativePath) {
  const entryPath = require.resolve(packageName);
  let dir = path.dirname(entryPath);

  while (true) {
    const packageJson = path.join(dir, "package.json");

    if (fs.existsSync(packageJson)) {
      const direct = path.join(dir, relativePath);
      if (fs.existsSync(direct)) return direct;

      const fileName = path.basename(relativePath);
      for (const candidate of [
        path.join(dir, "lib", fileName),
        path.join(dir, "dist", fileName),
        path.join(dir, fileName),
      ]) {
        if (fs.existsSync(candidate)) return candidate;
      }
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(`找不到 npm 包：${packageName}/${relativePath}`);
}

function resolveHighlightJs() {
  const pkgDir = path.dirname(require.resolve("highlight.js/package.json"));

  for (const file of [
    "highlight.min.js",
    "highlight.js",
    "dist/highlight.min.js",
    "dist/highlight.js",
    "dist/browser.min.js",
    "dist/browser.js",
    "lib/browser.min.js",
    "lib/browser.js",
  ]) {
    const full = path.join(pkgDir, file);
    if (fs.existsSync(full)) return full;
  }

  return null;
}

function getPdfJsFiles() {
  const localDir = path.join(BASE_DIR, "pdfjs");
  const localPdf = path.join(localDir, "pdf.min.mjs");
  const localWorker = path.join(localDir, "pdf.worker.min.mjs");

  if (fs.existsSync(localPdf) && fs.existsSync(localWorker)) {
    return { dir: localDir, pdf: localPdf, worker: localWorker };
  }

  try {
    const pdf = resolvePackageFile("pdfjs-dist", "build/pdf.min.mjs");
    const worker = resolvePackageFile("pdfjs-dist", "build/pdf.worker.min.mjs");
    return { dir: path.dirname(pdf), pdf, worker };
  } catch {
    throw new Error(
      `找不到 PDF.js：请提供 ${localDir}/pdf.min.mjs 和 pdf.worker.min.mjs，或安装 pdfjs-dist`,
    );
  }
}

function getBusyTexConfig() {
  if (!fs.existsSync(LATEX_WASM_DIR)) {
    throw new Error(`未找到 LaTeX WASM 资源目录：${LATEX_WASM_DIR}`);
  }

  const files = fs.readdirSync(LATEX_WASM_DIR);

  for (const file of ["busytex.js", "busytex.wasm", "busytex_worker.js"]) {
    if (!files.includes(file)) {
      throw new Error(`缺少 BusyTeX 文件：${path.join(LATEX_WASM_DIR, file)}`);
    }
  }

  let moduleFile = files.includes("texlyre-busytex.js")
    ? path.join(LATEX_WASM_DIR, "texlyre-busytex.js")
    : files.includes("index.js")
      ? path.join(LATEX_WASM_DIR, "index.js")
      : null;

  if (!moduleFile) {
    try {
      moduleFile = resolvePackageFile("texlyre-busytex", "dist/index.js");
    } catch {
      throw new Error(
        `缺少 BusyTeX 浏览器入口：${LATEX_WASM_DIR}/texlyre-busytex.js 或 index.js`,
      );
    }
  }

  const packages = files
    .filter((name) => /^texlive-[^/]+\.js$/i.test(name))
    .sort((a, b) => {
      const order = {
        "texlive-basic.js": 0,
        "texlive-recommended.js": 1,
        "texlive-extra.js": 2,
      };
      return (order[a] ?? 99) - (order[b] ?? 99);
    });

  if (!packages.length) {
    throw new Error(
      `未找到 TeX Live data package：${LATEX_WASM_DIR}/texlive-basic.js`,
    );
  }

  const packageUrls = packages.map((name) => `${BUSYTEX_WEB_BASE}/${name}`);

  return {
    basePath: BUSYTEX_WEB_BASE,
    moduleUrl: `${BUSYTEX_WEB_BASE}/__module`,
    moduleFile,
    preloadDataPackages: packageUrls,
    catalogDataPackages: packageUrls,
    remoteEndpoint: BUSYTEX_REMOTE_ENDPOINT || null,
  };
}

async function ensureLocalServer() {
  if (localServerOrigin) return localServerOrigin;
  if (localServerPromise) return localServerPromise;

  localServerPromise = new Promise((resolve, reject) => {
    let busyConfig;
    let pdfFiles;

    try {
      busyConfig = getBusyTexConfig();
      pdfFiles = getPdfJsFiles();
    } catch (error) {
      reject(error);
      return;
    }

    localServer = createServer((req, res) => {
      try {
        const url = new URL(req.url || "/", "http://127.0.0.1");
        let file = null;

        if (url.pathname === "/" || url.pathname === "/template.html") {
          file = TEMPLATE_PATH;
        } else if (url.pathname === "/pdfjs/pdf.min.mjs") {
          file = pdfFiles.pdf;
        } else if (url.pathname === "/pdfjs/pdf.worker.min.mjs") {
          file = pdfFiles.worker;
        } else if (url.pathname.startsWith("/pdfjs/cmaps/")) {
          const rel = decodeURIComponent(
            url.pathname.slice("/pdfjs/cmaps/".length),
          );
          if (!rel || rel.includes("..") || path.isAbsolute(rel)) {
            res.writeHead(400);
            res.end("Bad path");
            return;
          }
          file = path.join(
            BASE_DIR,
            "node_modules",
            "pdfjs-dist",
            "cmaps",
            rel,
          );
        } else if (url.pathname === "/busytex/__module") {
          file = busyConfig.moduleFile;
        } else if (url.pathname.startsWith("/busytex/")) {
          const rel = decodeURIComponent(
            url.pathname.slice("/busytex/".length),
          );

          if (!rel || rel.includes("..") || path.isAbsolute(rel)) {
            res.writeHead(400);
            res.end("Bad path");
            return;
          }

          file = path.join(LATEX_WASM_DIR, rel);
        }

        if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        const ext = path.extname(file).toLowerCase();
        const types = {
          ".html": "text/html; charset=utf-8",
          ".css": "text/css; charset=utf-8",
          ".js": "text/javascript; charset=utf-8",
          ".mjs": "text/javascript; charset=utf-8",
          ".wasm": "application/wasm",
          ".data": "application/octet-stream",
          ".bcmap": "application/octet-stream",
          ".map": "application/json",
        };

        res.writeHead(200, {
          "Content-Type": types[ext] || "application/octet-stream",
          "Cache-Control": "no-store",
        });

        fs.createReadStream(file).pipe(res);
      } catch (error) {
        res.writeHead(500);
        res.end(String(error?.message || error));
      }
    });

    localServer.once("error", reject);
    localServer.listen(0, "127.0.0.1", () => {
      const addr = localServer.address();
      localServerOrigin = `http://127.0.0.1:${addr.port}`;
      resolve(localServerOrigin);
    });
  });

  try {
    return await localServerPromise;
  } finally {
    localServerPromise = null;
  }
}

async function initPage(p) {
  const origin = await ensureLocalServer();

  await p.goto(`${origin}/template.html`, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  const stylePath = path.join(BASE_DIR, "style.css");
  if (fs.existsSync(stylePath)) {
    await p.addStyleTag({ path: stylePath });
  }

  await p.addScriptTag({
    path: resolvePackageFile("markdown-it", "dist/markdown-it.min.js"),
  });

  await p.addScriptTag({
    path: resolvePackageFile("katex", "dist/katex.min.js"),
  });

  await p.addStyleTag({
    path: resolvePackageFile("katex", "dist/katex.min.css"),
  });

  await p.addScriptTag({
    path: resolvePackageFile("mermaid", "dist/mermaid.min.js"),
  });

  const highlightPath = resolveHighlightJs();
  if (highlightPath) {
    await p.addScriptTag({ path: highlightPath });
  }

  await p.evaluate((config) => {
    window.__busyTexConfig = config;
  }, getBusyTexConfig());

  await p.evaluate(async () => {
    if (!window.pdfjsReady) {
      throw new Error("PDF.js 初始化 Promise 不存在");
    }

    await window.pdfjsReady;

    if (typeof window.pdfjsLib === "undefined") {
      throw new Error("PDF.js 初始化失败");
    }
  });

  await p.evaluate(() => {
    if (typeof window.initializeRenderer !== "function") {
      throw new Error("template.html 未找到 initializeRenderer()");
    }

    window.initializeRenderer();
  });
}

async function ensureBrowser() {
  if (browser && browser.isConnected()) return browser;
  if (browserPromise) return browserPromise;

  browserPromise = (async () => {
    console.log("[Renderer] 启动 Playwright Chromium...");
    browser = await chromium.launch({ headless: true });

    browser.on("disconnected", () => {
      browser = null;
      page = null;
      browserPromise = null;
      pagePromise = null;
    });

    console.log("[Renderer] Chromium 已启动");
    return browser;
  })();

  try {
    return await browserPromise;
  } finally {
    browserPromise = null;
  }
}

async function ensurePage() {
  if (page && !page.isClosed()) return page;
  if (pagePromise) return pagePromise;

  pagePromise = (async () => {
    await ensureLocalServer();

    const p = await (
      await ensureBrowser()
    ).newPage({
      viewport: { width: MAX_WIDTH, height: VIEWPORT_HEIGHT },
      deviceScaleFactor: 1,
    });

    p.on("console", (msg) => {
      console.log(`[浏览器 console.${msg.type()}] ${msg.text()}`);
    });

    p.on("pageerror", (error) => {
      console.error("[浏览器 pageerror]", error);
    });

    p.on("requestfailed", (request) => {
      console.error(
        "[浏览器 requestfailed]",
        request.url(),
        request.failure()?.errorText || "",
      );
    });

    try {
      await initPage(p);
      page = p;
      return p;
    } catch (error) {
      await p.close().catch(() => {});
      throw error;
    }
  })();

  try {
    return await pagePromise;
  } catch (error) {
    page = null;
    throw error;
  } finally {
    pagePromise = null;
  }
}

async function waitForRender(p) {
  await p.evaluate(async () => {
    if (document.fonts?.ready) await document.fonts.ready;
  });

  await p.evaluate(async () => {
    await Promise.all(
      [...document.images].map((img) =>
        img.complete
          ? Promise.resolve()
          : new Promise((resolve) => {
              img.addEventListener("load", resolve, { once: true });
              img.addEventListener("error", resolve, { once: true });
            }),
      ),
    );
  });

  await p.evaluate(async () => {
    if (typeof window.renderMermaid === "function") {
      await window.renderMermaid();
    }
  });

  await p.evaluate(async () => {
    if (document.fonts?.ready) await document.fonts.ready;
  });

  await p.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
}

async function resizePage(p) {
  const size = await p.evaluate(() => {
    const el = document.querySelector("#capture");
    if (!el) return { width: 600, height: 100 };
    const r = el.getBoundingClientRect();
    return { width: Math.ceil(r.width), height: Math.ceil(r.height) };
  });

  await p.setViewportSize({
    width: Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, size.width)),
    height: Math.max(VIEWPORT_HEIGHT, Math.min(10000, size.height + 100)),
  });
}

async function screenshotCapture(p) {
  await resizePage(p);
  return p.locator("#capture").screenshot({
    type: "png",
    animations: "disabled",
  });
}

async function renderMarkdownToBuffer(markdown) {
  return enqueueRender(async () => {
    const p = await ensurePage();
    await p.evaluate(
      async (content) => window.renderMarkdown(content),
      markdown,
    );
    await waitForRender(p);
    return screenshotCapture(p);
  });
}

/* ============================================================
   LaTeX 兼容处理
   ============================================================ */

function getLatexCompileLog(result) {
  const logs = Array.isArray(result?.logs) ? result.logs : [];

  return [
    result?.log,
    ...logs.flatMap((item) => [
      item?.log,
      item?.texmflog,
      item?.missfontlog,
      item?.stdout,
      item?.stderr,
    ]),
  ]
    .filter(Boolean)
    .map(String)
    .join("\n");
}

function hasChineseCharacters(source) {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(String(source || ""));
}

function insertAfterDocumentClass(source, content) {
  const match = String(source).match(
    /\\documentclass(?:\[[^\]]*\])?\s*\{[^}]+\}/i,
  );

  if (!match || match.index == null) {
    return `${content}\n${source}`;
  }

  const index = match.index + match[0].length;
  return source.slice(0, index) + "\n" + content + source.slice(index);
}

/* ------------------------------------------------------------
   检测文档里已有的 CJK 配置
   ------------------------------------------------------------ */

function detectCjkSetup(source) {
  const text = String(source || "");

  return {
    hasCtexClass:
      /\\documentclass(?:\[[^\]]*\])?\s*\{\s*ctex(?:art|rep|book)\s*\}/i.test(
        text,
      ),
    hasCtexPackage: /\\usepackage(?:\[[^\]]*\])?\s*\{\s*ctex\s*\}/i.test(text),
    hasXeCjk: /\\usepackage(?:\[[^\]]*\])?\s*\{\s*xeCJK\s*\}/i.test(text),
    hasCjkMainFont: /\\setCJKmainfont(?:\[[^\]]*\])?\s*\{/i.test(text),
    hasCjkSansFont: /\\setCJKsansfont(?:\[[^\]]*\])?\s*\{/i.test(text),
    hasCjkMonoFont: /\\setCJKmonofont(?:\[[^\]]*\])?\s*\{/i.test(text),
    hasFontspec: /\\usepackage(?:\[[^\]]*\])?\s*\{\s*fontspec\s*\}/i.test(text),
    hasSetMainFont: /\\setmainfont(?:\[[^\]]*\])?\s*\{/i.test(text),
  };
}

/* ------------------------------------------------------------
   CTeX / xeCJK 兼容（缺包时的降级）
   ------------------------------------------------------------ */

function applyCjkFallback(source) {
  let result = String(source);
  let changed = false;

  result = result.replace(
    /\\documentclass(\[[^\]]*\])?\s*\{\s*ctexart\s*\}/gi,
    (_, options) => {
      changed = true;
      return `\\documentclass${options || ""}{article}`;
    },
  );

  result = result.replace(
    /\\documentclass(\[[^\]]*\])?\s*\{\s*ctexrep\s*\}/gi,
    (_, options) => {
      changed = true;
      return `\\documentclass${options || ""}{report}`;
    },
  );

  result = result.replace(
    /\\documentclass(\[[^\]]*\])?\s*\{\s*ctexbook\s*\}/gi,
    (_, options) => {
      changed = true;
      return `\\documentclass${options || ""}{book}`;
    },
  );

  // 删除 ctex / xeCJK 宏包引用
  const beforePkg = result;
  result = result.replace(/\\usepackage(?:\[[^\]]*\])?\s*\{\s*ctex\s*\}/gi, "");
  result = result.replace(
    /\\usepackage(?:\[[^\]]*\])?\s*\{\s*xeCJK\s*\}/gi,
    "",
  );
  if (result !== beforePkg) changed = true;

  if (!changed) return result;

  // 删除常见 CTeX 字体声明
  result = result.replace(/\\setCJKmainfont(?:\[[^\]]*\])?\s*\{[^}]+\}/gi, "");
  result = result.replace(/\\setCJKsansfont(?:\[[^\]]*\])?\s*\{[^}]+\}/gi, "");
  result = result.replace(/\\setCJKmonofont(?:\[[^\]]*\])?\s*\{[^}]+\}/gi, "");
  result = result.replace(
    /\\setCJKfamilyfont(?:\[[^\]]*\])?\s*\{[^}]+\}\s*\{[^}]+\}/gi,
    "",
  );
  result = result.replace(
    /\\newCJKfontfamily(?:\[[^\]]*\])?\s*\{[^}]+\}(?:\[[^\]]*\])?\s*\{[^}]+\}/gi,
    "",
  );
  result = result.replace(/\\CJKfamily\s*\{[^}]+\}/gi, "");
  result = result.replace(/\\(?:kaishu|heiti|songti|fangsong)\b/gi, "");
  result = result.replace(/\\punctstyle\s*\{[^}]+\}/gi, "");

  // ctex 字号 → 标准字号
  result = result.replace(/\\zihao\s*\{\s*([-\d]+)\s*\}/gi, (_, size) => {
    const map = {
      "-4": "\\normalsize",
      5: "\\small",
      4: "\\large",
      3: "\\Large",
      2: "\\LARGE",
      1: "\\huge",
      0: "\\Huge",
    };
    return map[size] || "\\normalsize";
  });

  result = result.replace(
    /^[ \t]*\\(?:ctexset|CTEXsetup)\s*\{[^\n]*\}\s*$/gim,
    "",
  );

  const setup = detectCjkSetup(result);
  const hasChinese = hasChineseCharacters(result);

  let fontBlock = "";

  if (!setup.hasFontspec) {
    fontBlock += "\\usepackage{fontspec}\n";
  }

  // ⚠️ 关键：必须使用字体文件名（含 .otf），BusyTeX / XeTeX 才能从 TeX Live 正确解析。
  if (hasChinese && !setup.hasSetMainFont) {
    fontBlock += "\\setmainfont{FandolSong-Regular.otf}\n";
  }

  if (fontBlock) {
    result = insertAfterDocumentClass(result, fontBlock.trimEnd());
  }

  return result;
}

/* ------------------------------------------------------------
   主动启用中文支持
   ------------------------------------------------------------ */

function applyChineseSupport(source) {
  let result = String(source || "");

  if (!hasChineseCharacters(result)) {
    return result;
  }

  const setup = detectCjkSetup(result);

  // CTeX 类或宏包会自己负责 CJK 配置，别去覆盖
  if (setup.hasCtexClass || setup.hasCtexPackage) {
    return result;
  }

  // 已经有 xeCJK + 主字体设置，也不覆盖
  if (setup.hasXeCjk && setup.hasCjkMainFont) {
    return result;
  }

  let block = "";

  if (!setup.hasXeCjk) {
    block += "\\usepackage{xeCJK}\n";
  }

  if (!setup.hasCjkMainFont) {
    // ⚠️ 必须使用字体文件名（含 .otf）
    block += "\\setCJKmainfont{FandolSong-Regular.otf}\n";
  }

  if (!setup.hasCjkSansFont) {
    block += "\\setCJKsansfont{FandolHei-Regular.otf}\n";
  }

  if (!setup.hasCjkMonoFont) {
    block += "\\setCJKmonofont{FandolFang-Regular.otf}\n";
  }

  if (!block) return result;

  return insertAfterDocumentClass(result, block.trimEnd());
}

/* ------------------------------------------------------------
   algorithm / algpseudocode 兼容
   ------------------------------------------------------------ */

function applyAlgorithmFallback(source) {
  let result = String(source);
  let changed = false;

  result = result.replace(
    /\\usepackage(?:\[[^\]]*\])?\s*\{\s*algorithm\s*\}/gi,
    () => {
      changed = true;
      return "";
    },
  );

  result = result.replace(
    /\\usepackage(?:\[[^\]]*\])?\s*\{\s*algpseudocode\s*\}/gi,
    () => {
      changed = true;
      return "";
    },
  );

  if (!changed) return result;

  result = result.replace(
    /\\begin\s*\{\s*algorithm\s*\}(?:\s*\[[^\]]*\])?/gi,
    "\\begin{figure}[htbp]\n\\centering",
  );
  result = result.replace(/\\end\s*\{\s*algorithm\s*\}/gi, "\\end{figure}");

  result = result.replace(
    /\\begin\s*\{\s*algorithmic\s*\}(?:\s*\[[^\]]*\])?/gi,
    "\\begin{quote}\\small",
  );
  result = result.replace(/\\end\s*\{\s*algorithmic\s*\}/gi, "\\end{quote}");

  result = result.replace(/\\Require\b/gi, "\\textbf{Require:}");
  result = result.replace(/\\Ensure\b/gi, "\\textbf{Ensure:}");
  result = result.replace(/\\Statex\b/gi, "\\par");
  result = result.replace(/\\State\b/gi, "\\par");
  result = result.replace(/\\Comment\s*\{([^{}]*)\}/gi, "\\quad\\textit{($1)}");
  result = result.replace(/\\Return\b/gi, "\\textbf{return }");
  result = result.replace(
    /\\If\s*\{([^{}]*)\}/gi,
    "\\textbf{if } $1 \\textbf{ then}",
  );
  result = result.replace(
    /\\ElsIf\s*\{([^{}]*)\}/gi,
    "\\textbf{else if } $1 \\textbf{ then}",
  );
  result = result.replace(/\\Else\b/gi, "\\textbf{else}");
  result = result.replace(/\\EndIf\b/gi, "");
  result = result.replace(/\\For\s*\{([^{}]*)\}/gi, "\\textbf{for } $1");
  result = result.replace(/\\ForAll\s*\{([^{}]*)\}/gi, "\\textbf{for all } $1");
  result = result.replace(/\\EndFor\b/gi, "");
  result = result.replace(/\\While\s*\{([^{}]*)\}/gi, "\\textbf{while } $1");
  result = result.replace(/\\EndWhile\b/gi, "");
  result = result.replace(/\\Loop\b/gi, "\\par");
  result = result.replace(/\\EndLoop\b/gi, "");
  result = result.replace(/\\Repeat\b/gi, "\\textbf{repeat}");
  result = result.replace(/\\Until\s*\{([^{}]*)\}/gi, "\\textbf{until } $1");

  result = result.replace(
    /\\Procedure\s*\{([^{}]*)\}\s*\{([^{}]*)\}/gi,
    "\\par\\textbf{procedure } $1($2)",
  );
  result = result.replace(/\\EndProcedure\b/gi, "");

  result = result.replace(
    /\\Function\s*\{([^{}]*)\}\s*\{([^{}]*)\}/gi,
    "\\par\\textbf{function } $1($2)",
  );
  result = result.replace(/\\EndFunction\b/gi, "");

  result = result.replace(/\\Indent\b/gi, "\\quad");
  result = result.replace(/\\EndIndent\b/gi, "");

  return result;
}

/* ------------------------------------------------------------
   字体兼容
   ------------------------------------------------------------ */

function applyFontFallback(source, log) {
  const text = String(source);

  if (/FandolSong-Regular/i.test(log) || /FandolSong-Regular/i.test(text)) {
    // ⚠️ 修正正则：使用 (?![-\w]) 防止部分匹配，并用正确转义的 \. 与 \b
    return text
      .replace(
        /FandolSong-Regular(?!\.otf)(?![-\w])/gi,
        "FandolSong-Regular.otf",
      )
      .replace(/FandolHei-Regular(?!\.otf)(?![-\w])/gi, "FandolHei-Regular.otf")
      .replace(
        /FandolFang-Regular(?!\.otf)(?![-\w])/gi,
        "FandolFang-Regular.otf",
      )
      .replace(
        /FandolKai-Regular(?!\.otf)(?![-\w])/gi,
        "FandolKai-Regular.otf",
      );
  }

  return text;
}

/* ------------------------------------------------------------
   根据当前错误决定下一次兼容方式
   ------------------------------------------------------------ */

function createLatexCompatibilitySource(source, errorLog) {
  const text = String(source || "");
  const log = String(errorLog || "");

  // 1. CTeX / xeCJK
  const missingCtex = /File [`']ctex\.sty['`] not found/i.test(log);
  const missingCtexClass =
    /File [`']ctex(?:art|rep|book)\.cls['`] not found/i.test(log);
  const missingXeCjk = /File [`']xeCJK\.sty['`] not found/i.test(log);

  if (missingCtex || missingCtexClass || missingXeCjk) {
    const result = applyCjkFallback(text);
    if (result !== text) {
      return { name: "CJK / CTeX 轻量兼容", source: result };
    }
  }

  // 2. algorithm / algpseudocode
  const missingAlgorithm = /File [`']algorithm\.sty['`] not found/i.test(log);
  const missingAlgpseudocode =
    /File [`']algpseudocode\.sty['`] not found/i.test(log);

  if (missingAlgorithm || missingAlgpseudocode) {
    const result = applyAlgorithmFallback(text);
    if (result !== text) {
      return {
        name: "algorithm / algpseudocode 轻量兼容",
        source: result,
      };
    }
  }

  // 3. 常见字体失败
  if (
    /font.*not found/i.test(log) ||
    /fontspec.*cannot find/i.test(log) ||
    /The font .* cannot be found/i.test(log) ||
    /Fandol/i.test(log)
  ) {
    const result = applyFontFallback(text, log);
    if (result !== text) {
      return { name: "CJK 字体兼容", source: result };
    }
  }

  return null;
}

async function compileLatexWithFallback(p, source) {
  if (typeof source !== "string" || !source.trim()) {
    return null;
  }

  const compile = async (input) => {
    return p.evaluate(async (src) => {
      if (typeof window.compileLatex !== "function") {
        throw new Error("template.html 未加载 compileLatex()");
      }
      return window.compileLatex(src);
    }, input);
  };

  const MAX_ATTEMPTS = 5;

  let currentSource = applyChineseSupport(source);
  let lastLog = "";
  const triedSources = new Set();

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (triedSources.has(currentSource)) break;
    triedSources.add(currentSource);

    if (attempt > 1) {
      console.log(`[LaTeX] 第 ${attempt} 次编译，使用兼容版本`);
    }

    let result;

    try {
      result = await compile(currentSource);
    } catch (error) {
      lastLog = error?.message || String(error);
      throw new Error(`XeLaTeX 编译调用失败：\n${lastLog}`);
    }

    if (result?.success && result?.pdf) {
      if (attempt > 1) {
        console.log("[LaTeX] 兼容编译成功");
      }
      return {
        result,
        source: currentSource,
        fallback: attempt > 1,
      };
    }

    lastLog = getLatexCompileLog(result) || "未知 LaTeX 编译错误";

    const next = createLatexCompatibilitySource(currentSource, lastLog);

    if (!next) {
      throw new Error(`XeLaTeX 编译失败：\n${lastLog}`);
    }

    if (triedSources.has(next.source)) break;

    console.warn(`[LaTeX] 编译失败，检测到可兼容问题：${next.name}`);

    currentSource = next.source;
  }

  throw new Error(`XeLaTeX 编译失败：\n${lastLog}`);
}

async function renderFullLatexToBuffer(latex) {
  return enqueueRender(async () => {
    const source = String(latex || "").trim();
    if (!source) return null;

    const p = await ensurePage();

    const compiled = await compileLatexWithFallback(p, source);
    const result = compiled.result;

    if (!result?.success) {
      throw new Error("XeLaTeX 编译失败");
    }

    if (!result.pdf) {
      throw new Error("XeLaTeX 编译成功，但没有返回 PDF");
    }

    await p.evaluate(async (pdfBase64) => {
      if (typeof window.pdfjsLib === "undefined") {
        throw new Error("PDF.js 尚未加载");
      }

      const capture = document.getElementById("capture");
      const content = document.getElementById("content");

      if (!capture || !content) {
        throw new Error("#capture 或 #content 不存在");
      }

      content.innerHTML = "";

      const latexContainer = document.createElement("div");
      latexContainer.className = "latex-render";
      content.appendChild(latexContainer);

      const binary = atob(pdfBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }

      const pdf = await window.pdfjsLib.getDocument({
        data: bytes,
        cMapUrl: "/pdfjs/cmaps/",
        cMapPacked: true,
      }).promise;

      if (!pdf.numPages) throw new Error("PDF 没有页面");

      const firstPage = await pdf.getPage(1);

      /*
       * LaTeX 不再直接以“整页 PDF”参与布局。
       *
       * 先用较高分辨率渲染整页，然后自动检测透明区域，
       * 把 PDF 自带的上下左右页边距裁掉。
       *
       * Markdown 完全不经过这里，因此不会受影响。
       */
      const containerWidth = Math.max(
        300,
        latexContainer.clientWidth || content.clientWidth || 1360,
      );

      // 内部使用更高分辨率，之后再缩到最终宽度，避免裁剪后放大导致模糊
      const renderWidth = Math.min(3200, Math.max(1800, containerWidth * 2));

      const baseViewport = firstPage.getViewport({ scale: 1 });
      const scale = renderWidth / baseViewport.width;
      const viewport = firstPage.getViewport({ scale });

      const fullCanvas = document.createElement("canvas");
      fullCanvas.width = Math.ceil(viewport.width);
      fullCanvas.height = Math.ceil(viewport.height);

      const fullCtx = fullCanvas.getContext("2d", {
        willReadFrequently: true,
      });

      if (!fullCtx) {
        throw new Error("无法创建 Canvas 2D Context");
      }

      await firstPage.render({
        canvasContext: fullCtx,
        viewport,
        background: "rgba(0,0,0,0)",
      }).promise;

      /*
       * 自动检测 LaTeX 实际绘制区域。
       *
       * 标准 XeLaTeX PDF 通常不会给整页填充背景，
       * 因此页面空白区域保持 alpha = 0。
       */
      const imageData = fullCtx.getImageData(
        0,
        0,
        fullCanvas.width,
        fullCanvas.height,
      );

      const data = imageData.data;

      let minX = fullCanvas.width;
      let minY = fullCanvas.height;
      let maxX = -1;
      let maxY = -1;

      // 忽略极低透明度的边缘抗锯齿噪声
      const ALPHA_THRESHOLD = 8;

      for (let y = 0; y < fullCanvas.height; y++) {
        const row = y * fullCanvas.width * 4;

        for (let x = 0; x < fullCanvas.width; x++) {
          const alpha = data[row + x * 4 + 3];

          if (alpha > ALPHA_THRESHOLD) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }

      let canvas;

      if (maxX >= minX && maxY >= minY) {
        /*
         * 给内容四周留一点很小的安全距离，
         * 防止文字 / 数学公式贴到边缘。
         */
        const cropPadding = Math.max(24, Math.round(renderWidth * 0.012));

        minX = Math.max(0, minX - cropPadding);
        minY = Math.max(0, minY - cropPadding);
        maxX = Math.min(fullCanvas.width - 1, maxX + cropPadding);
        maxY = Math.min(fullCanvas.height - 1, maxY + cropPadding);

        const cropWidth = maxX - minX + 1;
        const cropHeight = maxY - minY + 1;

        canvas = document.createElement("canvas");
        canvas.width = cropWidth;
        canvas.height = cropHeight;

        const cropCtx = canvas.getContext("2d");
        if (!cropCtx) {
          throw new Error("无法创建裁剪 Canvas");
        }

        cropCtx.drawImage(
          fullCanvas,
          minX,
          minY,
          cropWidth,
          cropHeight,
          0,
          0,
          cropWidth,
          cropHeight,
        );
      } else {
        // 极少数 PDF 本身带整页背景，检测不到透明边界时退回整页
        canvas = fullCanvas;
      }

      canvas.className = "latex-page";
      canvas.style.display = "block";

      /*
       * 裁剪后的内容直接铺满和 Markdown 相同的内容区域。
       * 不再让 PDF 的“整页宽度”决定视觉大小。
       */
      canvas.style.width = "100%";
      canvas.style.height = "auto";
      canvas.style.maxWidth = "100%";

      latexContainer.innerHTML = "";
      latexContainer.appendChild(canvas);

      latexContainer.dataset.width = String(canvas.width);
      latexContainer.dataset.height = String(canvas.height);
    }, result.pdf);

    await waitForRender(p);
    return screenshotCapture(p);
  });
}

async function renderLatexContentToBuffer(latex) {
  const source = String(latex || "").trim();
  if (!source) return null;

  return isFullLatexDocument(source)
    ? renderFullLatexToBuffer(source)
    : renderMarkdownToBuffer(`$$${source}$$`);
}

async function renderRichContentToBuffer(markdown) {
  if (!markdown || !String(markdown).trim()) return null;
  return renderMarkdownToBuffer(markdown);
}

async function renderRichContentToBase64(markdown) {
  if (!markdown || !String(markdown).trim()) return null;

  try {
    const image = await renderRichContentToBuffer(markdown);
    return image ? image.toString("base64") : null;
  } catch (error) {
    console.error("[Renderer] rich → PNG 失败:", error);
    return null;
  }
}

async function renderFullLatexToBase64(latex) {
  if (!latex || !String(latex).trim()) return null;

  try {
    const image = await renderFullLatexToBuffer(latex);
    return image ? image.toString("base64") : null;
  } catch (error) {
    console.error("[Renderer] 完整 LaTeX → PNG 失败:", error);
    return null;
  }
}

async function renderLatexContentToBase64(latex) {
  if (!latex || !String(latex).trim()) return null;

  try {
    const image = await renderLatexContentToBuffer(latex);
    return image ? image.toString("base64") : null;
  } catch (error) {
    console.error("[Renderer] LaTeX → PNG 失败:", error);
    return null;
  }
}

async function renderLatexToBase64(latex) {
  return renderLatexContentToBase64(latex);
}

async function renderMixedContentToBase64(content) {
  return renderRichContentToBase64(content);
}

async function renderMixedContent(content) {
  const base64 = await renderMixedContentToBase64(content);
  return base64 ? Buffer.from(base64, "base64") : null;
}

function cleanLatex(latex) {
  if (!latex) return "";

  let result = String(latex).trim();

  if (result.startsWith("$$") && result.endsWith("$$")) {
    result = result.slice(2, -2).trim();
  } else if (result.startsWith("\\(") && result.endsWith("\\)")) {
    result = result.slice(2, -2).trim();
  } else if (result.startsWith("\\[") && result.endsWith("\\]")) {
    result = result.slice(2, -2).trim();
  }

  return result;
}

async function renderFormulaTransparent(latex) {
  return renderLatexToBuffer(latex);
}

async function renderLatexToBuffer(latex) {
  const base64 = await renderLatexToBase64(latex);
  return base64 ? Buffer.from(base64, "base64") : null;
}

async function createBackground() {
  throw new Error(
    "createBackground() 已废弃：背景现在由 template.html/CSS 处理。",
  );
}

async function composeFormula() {
  throw new Error("composeFormula() 已废弃：公式现在由 KaTeX/HTML 处理。");
}

function splitMixedContent(content) {
  return [["text", content || ""]];
}

async function wrapText(text) {
  return String(text || "").split("\n");
}

function isMermaidLanguage(language) {
  return (
    String(language || "")
      .trim()
      .split(/\s+/)[0]
      ?.toLowerCase() === "mermaid"
  );
}

function isLatexLanguage(language) {
  const normalized = String(language || "")
    .trim()
    .toLowerCase()
    .replace(/^language-/, "")
    .replace(/^lang-/, "");

  return ["latex", "tex", "ltx", "math", "mathjax"].includes(normalized);
}

function isFullLatexDocument(source) {
  if (!source) return false;

  const text = String(source);

  return (
    /\\documentclass(?:\[[^\]]*\])?\s*\{[^}]+\}/.test(text) &&
    /\\begin\s*\{\s*document\s*\}/.test(text) &&
    /\\end\s*\{\s*document\s*\}/.test(text)
  );
}

function parseMessageBlocks(text) {
  if (!text) return [];

  const source = String(text);
  const blocks = [];

  const pattern =
    /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?\n([\s\S]*?)^ {0,3}\1[ \t]*(?:\r?\n|$)/gm;

  let cursor = 0;

  for (const match of source.matchAll(pattern)) {
    const start = match.index;
    const end = start + match[0].length;
    const language = match[2].trim();
    const code = match[3];

    if (start > cursor) {
      pushTextOrMarkdown(blocks, source.slice(cursor, start));
    }

    blocks.push({ type: "code", language, code });

    cursor = end;
  }

  if (cursor < source.length) {
    pushTextOrMarkdown(blocks, source.slice(cursor));
  }

  if (!blocks.length && source.trim()) {
    pushTextOrMarkdown(blocks, source);
  }

  return mergeAdjacentBlocks(blocks);
}

function pushTextOrMarkdown(blocks, text) {
  const normalized = String(text || "").replace(/^[\r\n]+|[\r\n]+$/g, "");

  if (!normalized.trim()) return;

  blocks.push(
    containsRenderableSyntax(normalized)
      ? { type: "markdown", markdown: normalized }
      : { type: "text", text: normalized },
  );
}

function containsRenderableSyntax(text) {
  if (!text) return false;

  return (
    /!\[[^\]]*\]\([^)]+\)/.test(text) ||
    /\[[^\]]+\]\([^)]+\)/.test(text) ||
    /```[\s\S]*?```/.test(text) ||
    /\$\$[\s\S]*?\$\$/.test(text) ||
    /\\\[[\s\S]*?\\\]/.test(text) ||
    /\\\([\s\S]*?\\\)/.test(text) ||
    /\$[^$\n]+\$/.test(text) ||
    /\*\*[^\n]+?\*\*/.test(text) ||
    /`[^`\n]+`/.test(text) ||
    /(^|\n)#{1,6}\s+/.test(text) ||
    /(^|\n)>\s+/.test(text) ||
    /(^|\n)[-*+]\s+/.test(text)
  );
}

function mergeAdjacentBlocks(blocks) {
  const result = [];

  for (const block of blocks) {
    if (!block) continue;

    const last = result[result.length - 1];

    if (
      last &&
      last.type === block.type &&
      (block.type === "text" || block.type === "markdown")
    ) {
      const key = block.type === "text" ? "text" : "markdown";
      last[key] += "\n" + block[key];
    } else {
      result.push(block);
    }
  }

  return result;
}

const LATEX_DOCUMENT_PATTERN =
  /\\documentclass(?:\[[^\]]*\])?\s*\{[^}]+\}[\s\S]*?\\begin\s*\{\s*document\s*\}[\s\S]*?\\end\s*\{\s*document\s*\}/gm;

function extractLatexDocuments(text) {
  const documents = [];
  if (!text) return documents;

  for (const match of String(text).matchAll(LATEX_DOCUMENT_PATTERN)) {
    documents.push({
      content: match[0],
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  return documents;
}

function extractCodeBlocks(text) {
  const result = [];
  if (!text) return result;

  const pattern =
    /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?\n([\s\S]*?)^ {0,3}\1[ \t]*(?:\r?\n|$)/gm;

  for (const match of String(text).matchAll(pattern)) {
    const language = match[2].trim();

    if (isMermaidLanguage(language)) continue;

    result.push({
      language,
      code: match[3],
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  return result;
}

function isInsideRange(start, end, ranges) {
  return (ranges || []).some((item) => start >= item.start && end <= item.end);
}

function rangesOverlap(start1, end1, start2, end2) {
  return start1 < end2 && end1 > start2;
}

function splitCode(code, chunkSize = 3000) {
  if (!code) return [];
  if (code.length <= chunkSize) return [code];

  const chunks = [];
  const lines = code.match(/[^\n]*\n|[^\n]+$/g) || [];

  let current = "";

  for (const line of lines) {
    if (current.length + line.length <= chunkSize) {
      current += line;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = "";
    }

    if (line.length > chunkSize) {
      for (let i = 0; i < line.length; i += chunkSize) {
        chunks.push(line.slice(i, i + chunkSize));
      }
    } else {
      current = line;
    }
  }

  if (current) chunks.push(current);

  return chunks;
}

async function closeRenderer() {
  if (browser) {
    await browser.close().catch(() => {});
  }

  if (localServer) {
    await new Promise((resolve) => localServer.close(() => resolve()));
  }

  browser = null;
  page = null;
  browserPromise = null;
  pagePromise = null;
  localServer = null;
  localServerOrigin = null;
  localServerPromise = null;
  renderQueue = Promise.resolve();
}

export {
  parseMessageBlocks,
  extractCodeBlocks,
  extractLatexDocuments,
  isInsideRange,
  rangesOverlap,
  isMermaidLanguage,
  isLatexLanguage,
  isFullLatexDocument,
  splitCode,
  renderRichContentToBuffer,
  renderRichContentToBase64,
  renderFullLatexToBuffer,
  renderFullLatexToBase64,
  renderLatexContentToBuffer,
  renderLatexContentToBase64,
  renderLatexToBase64,
  renderMixedContentToBase64,
  renderMixedContent,
  renderFormulaTransparent,
  renderLatexToBuffer,
  createBackground,
  composeFormula,
  splitMixedContent,
  wrapText,
  cleanLatex,
  closeRenderer,
};
