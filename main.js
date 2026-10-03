import http from "http";
import { BOT_TOKEN, AI_API_KEY } from "./config.js";
import { buildTgApp } from "./bot-tg.js";
import { handleQqWs } from "./bot-qq.js";
import { handleLatexTest } from "./latex-test.js";
// 心跳探针端口（供 napcat-fallback 检测主程序存活状态）
const CHECK_PORT = 18080;
async function main() {
  // 检查必要的环境变量
  if (!BOT_TOKEN || !AI_API_KEY) {
    console.error("error：请设置 BOT_TOKEN 和 AI_API_KEY 环境变量！");
    return;
  }
  const healthServer = http.createServer(async (req, res) => {
    if (req.url === "/latex-test") {
      await handleLatexTest(req, res);
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/plain",
    });
    res.end("ok");
  });
  healthServer.listen(CHECK_PORT, "0.0.0.0", () => {
    console.log(`[fallback] run ${CHECK_PORT}`);
  });
  // 创建 Telegram Bot
  const tgApp = buildTgApp();
  // 启动 QQ WebSocket
  const qqWrapper = async () => {
    console.log("[QQ调试] handleQqWs()start");
    try {
      await handleQqWs();
    } catch (error) {
      console.error(`[QQ调试] handleQqWs() 崩溃: ${error.message}`);
      console.error(error);
    }
  };
  // 不阻塞 Telegram
  qqWrapper();
  // 启动 Telegram
  console.log("START");
  await tgApp.start();
  // 保持进程运行
  await new Promise(() => {});
}
// 程序入口
main().catch((error) => {
  console.error("ERR");
  console.error(error);
  process.exit(1);
});
// 安全退出
process.on("SIGINT", async () => {
  console.log("EXIT");
  process.exit(0);
});
process.on("SIGTERM", async () => {
  console.log("EXIT");
  process.exit(0);
});
