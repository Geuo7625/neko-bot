import { renderFullLatexToBuffer } from "./latex-renderer.js";
const TEST_LATEX = String.raw`
\documentclass{article}
\usepackage{fontspec}
\usepackage{xeCJK}
\setCJKmainfont{FandolSong-Regular.otf}
\begin{document}
ABC
你好世界
中文测试
\end{document}
`;
export async function handleLatexTest(req, res) {
  try {
    const image = await renderFullLatexToBuffer(TEST_LATEX);
    res.writeHead(200, {
      "Content-Type": "image/png",
      "Cache-Control": "no-store",
    });
    res.end(image);
  } catch (error) {
    console.error("[LaTeX测试] 渲染失败：");
    console.error(error);
    res.writeHead(500, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(error?.stack || String(error));
  }
}
