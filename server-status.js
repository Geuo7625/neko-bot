import axios from "axios";

/* =========================================================
   配置
   ========================================================= */

const SERVER_STATUS_URL = "http://192.168.1.20:2080/api/fast";

// 同一个 QQ 10 秒内只能查询一次
const STATUS_COOLDOWN_MS = 10_000;

const lastStatusRequest = new Map();

const httpClient = axios.create({
  timeout: 5000,
});

/* =========================================================
   工具函数
   ========================================================= */

/**
 * 格式化百分比
 */
function formatPercent(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return "未知";
  }

  return `${number.toFixed(1)}%`;
}

/**
 * MHz → GHz
 *
 * 例如：
 * 1500 -> 1.50 GHz
 * 4100 -> 4.10 GHz
 */
function formatGHz(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return "未知";
  }

  return `${(number / 1000).toFixed(2)} GHz`;
}

/**
 * 格式化温度
 */
function formatTemp(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return "未知";
  }

  return `${number.toFixed(0)}°C`;
}

/**
 * 格式化网络速度
 */
function formatMbps(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return "未知";
  }

  return `${number.toFixed(2)} Mbps`;
}

/**
 * MB → GB
 */
function formatGB(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return "未知";
  }

  return `${(number / 1024).toFixed(1)}GB`;
}

/**
 * 格式化网卡连接速率
 */
function formatNetworkSpeed(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return "未知";
  }

  if (number >= 1000) {
    return `${(number / 1000).toFixed(number % 1000 === 0 ? 0 : 1)} Gbps`;
  }

  return `${number} Mbps`;
}

/* =========================================================
   限速
   ========================================================= */

/**
 * 检查查询限速。
 *
 * 返回：
 * {
 *   allowed: true
 * }
 *
 * 或：
 * {
 *   allowed: false,
 *   remainingMs
 * }
 */
function checkServerStatusRateLimit(userId) {
  const key = String(userId);
  const now = Date.now();

  const lastTime = lastStatusRequest.get(key) || 0;
  const elapsed = now - lastTime;

  if (elapsed < STATUS_COOLDOWN_MS) {
    return {
      allowed: false,
      remainingMs: STATUS_COOLDOWN_MS - elapsed,
    };
  }

  lastStatusRequest.set(key, now);

  return {
    allowed: true,
  };
}

/* =========================================================
   获取服务器状态
   ========================================================= */

async function getServerStatus() {
  const response = await httpClient.get(SERVER_STATUS_URL);

  const data = response.data;

  if (!data || typeof data !== "object") {
    throw new Error("服务器状态 API 返回格式无效");
  }

  /* -------------------------------------------------------
     SSH / 运行状态
     ------------------------------------------------------- */

  const sshConnected = data.ssh?.connected === true;

  /* -------------------------------------------------------
     CPU
     ------------------------------------------------------- */

  const cpuUsage = Number(data.cpu?.usagePercent);
  const cpuTemp = Number(data.cpu?.tempC);
  const cpuCurrentMHz = Number(data.cpu?.currentMHz);
  const cpuMaxMHz = Number(data.cpu?.maxMHz);

  /* -------------------------------------------------------
     内存
     ------------------------------------------------------- */

  const memoryTotal = Number(data.memory?.totalMB);
  const memoryUsed = Number(data.memory?.usedMB);
  const memoryAvailable = Number(data.memory?.availableMB);
  const memoryUsage = Number(data.memory?.usagePercent);

  /* -------------------------------------------------------
     GPU
     ------------------------------------------------------- */

  const gpuUsage = Number(data.gpu?.usagePercent);
  const gpuTemp = Number(data.gpu?.tempC);
  const gpuCurrentMHz = Number(
    data.gpu?.currentFreqMHz ?? data.gpu?.actualFreqMHz
  );
  const gpuMaxMHz = Number(data.gpu?.maxFreqMHz);

  /* -------------------------------------------------------
     网络
     ------------------------------------------------------- */

  const networks = Array.isArray(data.network)
    ? data.network
    : [];

  /* -------------------------------------------------------
     负载
     ------------------------------------------------------- */

  const loadAverage = Array.isArray(data.loadAverage)
    ? data.loadAverage
    : [];

  /* -------------------------------------------------------
     输出
     ------------------------------------------------------- */

  const lines = [];

  lines.push("服务器状态");
  lines.push("");

  // SSH / 运行状态
  lines.push(
    `SSH 状态 ${sshConnected ? "正常" : "断开"}`
  );

  // CPU
  const cpuLine = [
    "CPU",
    formatPercent(cpuUsage),
    formatTemp(cpuTemp),
  ];

  if (
    Number.isFinite(cpuCurrentMHz) &&
    Number.isFinite(cpuMaxMHz)
  ) {
    cpuLine.push(
      `${formatGHz(cpuCurrentMHz)} / ${formatGHz(cpuMaxMHz)}`
    );
  } else if (Number.isFinite(cpuCurrentMHz)) {
    cpuLine.push(formatGHz(cpuCurrentMHz));
  }

  lines.push(cpuLine.join("   "));

  // 内存
  lines.push(
    [
      "内存",
      formatPercent(memoryUsage),
      `${formatGB(memoryUsed)} / ${formatGB(memoryTotal)}`,
    ].join("   ")
  );

  // 可用内存
  lines.push(
    `可用   ${formatGB(memoryAvailable)}`
  );

  // 负载
  if (loadAverage.length >= 3) {
    const load = loadAverage
      .slice(0, 3)
      .map((value) => {
        const number = Number(value);

        return Number.isFinite(number)
          ? number.toFixed(2)
          : "未知";
      })
      .join(" / ");

    lines.push(`负载   ${load}`);
  }

  // GPU
  const gpuLine = [
    "GPU",
    formatPercent(gpuUsage),
    formatTemp(gpuTemp),
  ];

  if (
    Number.isFinite(gpuCurrentMHz) &&
    Number.isFinite(gpuMaxMHz)
  ) {
    gpuLine.push(
      `${formatGHz(gpuCurrentMHz)} / ${formatGHz(gpuMaxMHz)}`
    );
  } else if (Number.isFinite(gpuCurrentMHz)) {
    gpuLine.push(formatGHz(gpuCurrentMHz));
  }

  lines.push(gpuLine.join("   "));

  // 网络
  if (networks.length > 0) {
    lines.push("");
    lines.push("网络");

    for (const network of networks) {
      const name = network?.name || "未知网卡";
      const speed = Number(network?.speedMbps);
      const download = Number(network?.downloadMbps);
      const upload = Number(network?.uploadMbps);

      lines.push(
        `${name}  ${formatNetworkSpeed(speed)}`
      );

      lines.push(
        `  ↓ ${formatMbps(download)}  ↑ ${formatMbps(upload)}`
      );
    }
  }

  // 详细查看
  lines.push("");
  lines.push("详细查看  run.geuo.org ↗");

  return lines.join("\n");
}

/* =========================================================
   清除限速
   ========================================================= */

function clearServerStatusRateLimits() {
  lastStatusRequest.clear();
}

/* =========================================================
   导出
   ========================================================= */

export {
  getServerStatus,
  checkServerStatusRateLimit,
  clearServerStatusRateLimits,
};