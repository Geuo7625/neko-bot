import { NAPCAT_WS_URL } from "./config.js";

const connectionUrl = new URL(NAPCAT_WS_URL);
if (!connectionUrl.hostname || connectionUrl.hostname === "undefined") {
  console.error("[表情链路测试] FAIL: NAPCAT_WS_URL/NAPCAT_HOST 未配置，无法连接 NapCat");
  process.exitCode = 1;
} else {
  const socket = new WebSocket(connectionUrl);
  const timeout = setTimeout(() => {
    console.error("[表情链路测试] FAIL: 等待群 mface 事件超时");
    socket.close();
    process.exitCode = 1;
  }, 90_000);
  let completed = false;
  let echoId = null;

  socket.addEventListener("open", () => {
    console.log("[表情链路测试] 已连接，请在群里发送一张 mface 商城表情");
  });

  socket.addEventListener("message", (event) => {
    let payload;
    try { payload = JSON.parse(String(event.data)); }
    catch { return; }

    if (echoId && payload.echo === echoId) {
      clearTimeout(timeout);
      completed = true;
      const success = Number(payload?.data?.retcode ?? payload?.retcode ?? 0) === 0;
      console.log(`[表情链路测试] ${success ? "PASS" : "FAIL"}: NapCat 回发结果 retcode=${payload?.data?.retcode ?? payload?.retcode ?? 0}`);
      socket.close();
      if (!success) process.exitCode = 1;
      return;
    }

    const message = payload?.message;
    if (payload?.post_type !== "message" || payload?.message_type !== "group" || !Array.isArray(message)) return;
    if (String(payload.user_id) === String(payload.self_id)) return;
    const storedSegments = message
      .filter((segment) => segment?.type === "mface")
      .map((segment) => JSON.parse(JSON.stringify(segment)));
    if (!storedSegments.length) return;

    echoId = `sticker-loopback-${Date.now()}`;
    socket.send(JSON.stringify({
      action: "send_group_msg",
      params: { group_id: payload.group_id, message: storedSegments },
      echo: echoId,
    }));
    console.log(`[表情链路测试] 已缓存并回发原始表情段 count=${storedSegments.length}`);
  });

  socket.addEventListener("error", () => {
    if (completed) return;
    clearTimeout(timeout);
    console.error("[表情链路测试] FAIL: NapCat WebSocket 连接错误");
    process.exitCode = 1;
  });
}
