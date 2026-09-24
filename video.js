import axios from "axios";
import {
  AGNES_API_KEY,
  AGNES_VIDEO_URL,
  AGNES_VIDEO_RESULT_URL,
  VIDEO_MODEL,
} from "./config.js";
// ============================================================
// 配置
// ============================================================
const VIDEO_SIZES = {
  "1:1": {
    width: 1024,
    height: 1024,
  },
  "4:3": {
    width: 1024,
    height: 768,
  },
  "3:4": {
    width: 768,
    height: 1024,
  },
  "16:9": {
    width: 1024,
    height: 576,
  },
  "9:16": {
    width: 576,
    height: 1024,
  },
};
const DEFAULT_RATIO = "16:9";
const DEFAULT_FRAMES = 121;
const DEFAULT_FPS = 24;
const POLL_INTERVAL = 5000;
const VIDEO_TIMEOUT = 10 * 60 * 1000;
const COMPLETED_URL_RETRIES = 6;
const COMPLETED_URL_RETRY_INTERVAL = 2000;
// ============================================================
// 工具
// ============================================================
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
// ============================================================
// 创建视频任务
// ============================================================
async function createVideoTask(
  prompt,
  {
    ratio = DEFAULT_RATIO,
    frames = DEFAULT_FRAMES,
    fps = DEFAULT_FPS,
    negativePrompt = "",
    seed,
  } = {},
) {
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new Error("视频提示词不能为空");
  }
  if (
    !Number.isInteger(frames) ||
    frames < 9 ||
    frames > 441 ||
    (frames - 1) % 8 !== 0
  ) {
    throw new Error("视频帧数必须满足 8n + 1，范围为 9~441");
  }
  if (!Number.isInteger(fps) || fps < 1 || fps > 60) {
    throw new Error("视频 FPS 必须为 1~60");
  }
  const dimensions = VIDEO_SIZES[ratio] || VIDEO_SIZES[DEFAULT_RATIO];
  const payload = {
    model: VIDEO_MODEL,
    prompt: prompt.trim(),
    width: dimensions.width,
    height: dimensions.height,
    num_frames: frames,
    frame_rate: fps,
  };
  if (typeof negativePrompt === "string" && negativePrompt.trim()) {
    payload.negative_prompt = negativePrompt.trim();
  }
  if (Number.isInteger(seed)) {
    payload.seed = seed;
  }
  console.log(
    `[Video] 创建任务 | ` +
      `model=${VIDEO_MODEL} | ` +
      `ratio=${ratio} | ` +
      `frames=${frames} | ` +
      `fps=${fps}`,
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
    const videoId = data.video_id || data.task_id || data.id;
    if (!videoId) {
      throw new Error(
        "API 没有返回 video_id/task_id/id：" + JSON.stringify(data),
      );
    }
    return {
      videoId,
      taskId: data.task_id || data.id || data.video_id,
      status: data.status || "queued",
      progress: data.progress ?? 0,
      seconds: data.seconds ? Number(data.seconds) : null,
      size: data.size || null,
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
  if (!data || typeof data !== "object") {
    return null;
  }
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
// ============================================================
// 错误
// ============================================================
function extractVideoError(data) {
  if (!data) {
    return "API 视频生成失败";
  }
  if (typeof data.error === "string" && data.error.trim()) {
    return data.error.trim();
  }
  if (data.error && typeof data.error === "object") {
    try {
      return JSON.stringify(data.error);
    } catch {
      // ignore
    }
  }
  if (typeof data.message === "string" && data.message.trim()) {
    return data.message.trim();
  }
  return `API 视频生成失败，状态：` + `${data.status || "unknown"}`;
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
    const status = String(data.status || "").toLowerCase();
    const progress = data.progress ?? 0;
    console.log(
      `[Video] ${videoId} | ` + `status=${status} | ` + `progress=${progress}%`,
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
// ============================================================
// 导出
// ============================================================
export { createVideoTask, waitForVideo };
