import axios from "axios";

import {
  AGNES_API_KEY,
  AGNES_IMAGE_URL,
  IMAGE_MODEL,
} from "./config.js";

// ============================================================
// 配置
// ============================================================

const IMAGE_SIZES = {
  "1:1": "1024x1024",
  "4:3": "1024x768",
  "3:4": "768x1024",
  "16:9": "1024x576",
  "9:16": "576x1024",
};

const DEFAULT_RATIO = "4:3";

// ============================================================
// 图片生成
//
// mode:
//   new       = 创建新图片
//   edit_last = 修改上一张图片
//
// sourceImageUrl:
//   edit_last 时必须提供
// ============================================================

async function generateImage(
  prompt,
  ratio = DEFAULT_RATIO,
  {
    mode = "new",
    sourceImageUrl = null,
  } = {},
) {
  // ==========================================================
  // 1. 基础参数检查
  // ==========================================================

  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new Error("图片提示词不能为空");
  }

  if (mode !== "new" && mode !== "edit_last") {
    throw new Error(`不支持的图片模式：${mode}`);
  }

  if (mode === "edit_last") {
    if (
      typeof sourceImageUrl !== "string" ||
      !sourceImageUrl.trim()
    ) {
      throw new Error("edit_last 缺少 sourceImageUrl");
    }
  }

  const size =
    IMAGE_SIZES[ratio] ||
    IMAGE_SIZES[DEFAULT_RATIO];

  // ==========================================================
  // 2. 基础请求参数
  // ==========================================================

  const payload = {
    model: IMAGE_MODEL,
    prompt: prompt.trim(),
    n: 1,
    size,
  };

  // ==========================================================
  // 3. 图片编辑
  //
  // 注意：
  // 这里的字段名必须和你的 AGNES 图片 API 实际接口一致。
  //
  // 如果你的 API 使用 source_image_url，
  // 就保持下面这样。
  // ==========================================================

  if (mode === "edit_last") {
    payload.source_image_url = sourceImageUrl.trim();
  }

  console.log(
    `[Image] 请求图片 | ` +
      `mode=${mode} | ` +
      `ratio=${ratio} | ` +
      `size=${size}`,
  );

  // ==========================================================
  // 4. 请求 API
  // ==========================================================

  try {
    const response = await axios.post(
      AGNES_IMAGE_URL,
      payload,
      {
        headers: {
          Authorization: `Bearer ${AGNES_API_KEY}`,
          "Content-Type": "application/json",
        },

        timeout: 60000,
        maxRedirects: 10,
      },
    );

    const url =
      response.data?.data?.[0]?.url;

    if (!url) {
      throw new Error(
        "API 没有返回图片 URL：" +
          JSON.stringify(response.data),
      );
    }

    console.log(
      `[Image] 图片生成完成 | mode=${mode}`,
    );

    return url;
  } catch (error) {
    console.error(
      `[Image] 图片生成失败 | mode=${mode}:`,
      error.message,
    );

    if (error.response?.data) {
      console.error(
        "[Image] API 返回:",
        JSON.stringify(
          error.response.data,
          null,
          2,
        ),
      );
    }

    throw error;
  }
}

// ============================================================
// 导出
// ============================================================

export {
  generateImage,
};