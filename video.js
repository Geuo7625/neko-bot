import axios from "axios";
import {
  AGNES_API_KEY,
  AGNES_VIDEO_URL,
  AGNES_VIDEO_RESULT_URL,
  VIDEO_MODEL,
} from "./config.js";

// ============================================================
// Agnes Video 2.5 / 2.5 Flash
// ============================================================

const DEFAULT_SECONDS = 5;
const DEFAULT_SIZE = "720P";
const DEFAULT_RATIO = "16:9";
const POLL_INTERVAL = 5000;
const VIDEO_TIMEOUT = 10 * 60 * 1000;
const COMPLETED_URL_RETRIES = 6;
const COMPLETED_URL_RETRY_INTERVAL = 2000;

const VIDEO_RATIOS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];
const VIDEO_SIZES = ["720P", "1080P", "1K", "2K"];

function normalizeSeconds(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return String(DEFAULT_SECONDS);
  return String(Math.min(12, Math.max(4, Math.round(value))));
}

function normalizeSize(size) {
  const value = String(size || "")
    .trim()
    .toUpperCase();
  if (/flash$/i.test(String(VIDEO_MODEL || ""))) return "720P";
  return VIDEO_SIZES.includes(value) ? value : DEFAULT_SIZE;
}

function normalizeRatio(ratio) {
  const value = String(ratio || "").trim();
  return VIDEO_RATIOS.includes(value) ? value : DEFAULT_RATIO;
}

function isUsableImageUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim());
}

function isUsableImageInput(value) {
  return (
    isUsableImageUrl(value) ||
    (typeof value === "string" && /^data:image\//i.test(value.trim()))
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================
// 创建视频任务
// ============================================================

async function createVideoTask(
  prompt,
  {
    mode = "text",
    ratio = DEFAULT_RATIO,
    seconds = DEFAULT_SECONDS,
    size = DEFAULT_SIZE,
    imageUrl = null,
    lastFrame = null,
    images = null,
    seed,
  } = {},
) {
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new Error("视频提示词不能为空");
  }

  const normalizedMode = ["text", "keyframe", "reference"].includes(mode)
    ? mode
    : "text";
  const normalizedRatio = normalizeRatio(ratio);
  const normalizedSeconds = normalizeSeconds(seconds);
  const normalizedSize = normalizeSize(size);

  const payload = {
    model: VIDEO_MODEL,
    prompt: prompt.trim(),
    mode: normalizedMode,
    seconds: normalizedSeconds,
    size: normalizedSize,
    aspect_ratio: normalizedRatio,
    n: 1,
  };

  if (normalizedMode === "keyframe") {
    const firstFrame = isUsableImageUrl(imageUrl) ? imageUrl.trim() : null;

    if (!firstFrame && !isUsableImageInput(lastFrame)) {
      throw new Error("keyframe 缺少有效的 first_frame 图片 URL");
    }

    if (firstFrame) payload.first_frame = firstFrame;
    if (isUsableImageUrl(lastFrame)) payload.last_frame = lastFrame.trim();
  }

  if (normalizedMode === "reference") {
    const referenceImages = Array.isArray(images)
      ? images
          .filter(isUsableImageInput)
          .map((value) => value.trim())
          .slice(0, 5)
      : [];

    if (!referenceImages.length) {
      throw new Error("reference 模式至少需要一张图片");
    }

    payload.images = referenceImages;
  }

  if (Number.isInteger(seed)) {
    payload.seed = seed;
  }

  console.log(
    `[Video] 创建任务 | model=${VIDEO_MODEL} | mode=${normalizedMode} | ` +
      `ratio=${normalizedRatio} | seconds=${normalizedSeconds} | size=${normalizedSize} | ` +
      `has_first_frame=${Boolean(payload.first_frame)} | ` +
      `first_frame_type=${isUsableImageUrl(payload.first_frame) ? "url" : payload.first_frame ? "base64" : "none"}`,
  );

  try {
    const response = await axios.post(AGNES_VIDEO_URL, payload, {
      headers: {
        Authorization: `Bearer ${AGNES_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 60000,
      maxRedirects: 10,
    });

    const data = response.data;
    console.log("[Video] 创建任务返回:", JSON.stringify(data, null, 2));

    const videoId = data?.video_id || data?.task_id || data?.id;
    if (!videoId) {
      throw new Error(
        "API 没有返回 video_id/task_id/id：" + JSON.stringify(data),
      );
    }

    return {
      videoId,
      taskId: data?.task_id || data?.id || data?.video_id,
      status: data?.status || "queued",
      progress: data?.progress ?? 0,
      seconds: data?.seconds ? Number(data.seconds) : Number(normalizedSeconds),
      size: data?.size || normalizedSize,
      mode: normalizedMode,
      ratio: normalizedRatio,
      raw: data,
    };
  } catch (error) {
    console.error("[Video] 创建视频任务失败:", error.message);
    if (error.response?.data) {
      console.error(
        "[Video] API 返回:",
        JSON.stringify(error.response.data, null, 2),
      );
    }
    throw error;
  }
}

// ============================================================
// 查询任务
// ============================================================

async function getVideoStatus(videoId) {
  if (!videoId) {
    throw new Error("videoId 不能为空");
  }

  try {
    const response = await axios.get(AGNES_VIDEO_RESULT_URL, {
      headers: {
        Authorization: `Bearer ${AGNES_API_KEY}`,
      },
      params: {
        video_id: videoId,
        model_name: VIDEO_MODEL,
      },
      timeout: 30000,
      maxRedirects: 10,
    });

    return response.data;
  } catch (error) {
    console.error(
      `[Video] 查询任务失败 | video_id=${videoId} | ${error.message}`,
    );
    if (error.response?.data) {
      console.error(
        "[Video] 查询接口返回:",
        JSON.stringify(error.response.data, null, 2),
      );
    }
    throw error;
  }
}

// ============================================================
// 视频 URL
// ============================================================

function extractVideoUrl(data) {
  if (!data || typeof data !== "object") return null;

  const urls = [
    data.metadata?.url,
    data.url,
    data.video_url,
    data.videoUrl,
    data.output?.url,
    data.result?.url,
    data.video?.url,
    data.metadata?.video_url,
    data.metadata?.videoUrl,
  ];

  for (const value of urls) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function extractVideoError(data) {
  if (!data) return "API 视频生成失败";
  if (typeof data.error === "string" && data.error.trim())
    return data.error.trim();
  if (data.error && typeof data.error === "object") {
    try {
      return JSON.stringify(data.error);
    } catch {}
  }
  if (typeof data.message === "string" && data.message.trim())
    return data.message.trim();
  return `API 视频生成失败，状态：${data.status || "unknown"}`;
}

// ============================================================
// 等待完成
// ============================================================

async function waitForVideo(
  videoId,
  { interval = POLL_INTERVAL, timeout = VIDEO_TIMEOUT } = {},
) {
  const startTime = Date.now();
  let completedWithoutUrlRetries = 0;

  while (true) {
    if (Date.now() - startTime > timeout) {
      throw new Error("视频生成超时");
    }

    const data = await getVideoStatus(videoId);
    const status = String(data?.status || "").toLowerCase();
    const progress = data?.progress ?? 0;

    console.log(
      `[Video] ${videoId} | status=${status} | progress=${progress}%`,
    );

    if (status === "completed") {
      const videoUrl = extractVideoUrl(data);

      if (videoUrl) {
        return {
          videoUrl,
          videoId: data.video_id || data.id || videoId,
          taskId: data.task_id || data.id || data.video_id || videoId,
          status: data.status,
          progress: data.progress ?? 100,
          seconds: data.seconds ? Number(data.seconds) : null,
          size: data.size || null,
          metadata: data.metadata || null,
          raw: data,
        };
      }

      completedWithoutUrlRetries++;
      console.warn(
        `[Video] ${videoId} 已完成但暂时没有 URL ` +
          `(${completedWithoutUrlRetries}/${COMPLETED_URL_RETRIES})`,
      );

      if (completedWithoutUrlRetries >= COMPLETED_URL_RETRIES) {
        throw new Error(
          "视频生成完成，但 API 没有返回视频 URL：" + JSON.stringify(data),
        );
      }

      await sleep(COMPLETED_URL_RETRY_INTERVAL);
      continue;
    }

    if (status === "failed" || status === "error") {
      throw new Error(extractVideoError(data));
    }

    await sleep(interval);
  }
}

export { createVideoTask, waitForVideo };
