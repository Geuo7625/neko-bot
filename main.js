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
    console.error("错误：请设置 BOT_TOKEN 和 AI_API_KEY 环境变量！");
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
    console.log(`[健康检查] 心跳探针已启动，监听端口 ${CHECK_PORT}`);
  });
  // 创建 Telegram Bot
  const tgApp = buildTgApp();
  // 启动 QQ WebSocket
  const qqWrapper = async () => {
    console.log("[QQ调试] handleQqWs() 准备启动");
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
  console.log("机器人启动中，正在监听 Telegram 与 QQ WebSocket 喵~");
  await tgApp.start();
  // 保持进程运行
  await new Promise(() => {});
}
// 程序入口
main().catch((error) => {
  console.error("机器人发生未处理异常：");
  console.error(error);
  process.exit(1);
});
// 安全退出
process.on("SIGINT", async () => {
  console.log("机器人已安全停止运行喵~");
  process.exit(0);
});
process.on("SIGTERM", async () => {
  console.log("机器人已安全停止运行喵~");
  process.exit(0);
});
