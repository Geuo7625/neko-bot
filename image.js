import axios from "axios";

import {
  AGNES_API_KEY,
  AGNES_IMAGE_URL,
  IMAGE_MODEL,
} from "./config.js";

const IMAGE_SIZES = {
  "1:1": "1024x1024",
  "4:3": "1024x768",
  "3:4": "768x1024",
  "16:9": "1024x576",
  "9:16": "576x1024",
};

const DEFAULT_RATIO = "4:3";

/**
 * 生成图片 / 图生图 / 多图合成
 *
 * mode:
 *   new       = 创建新图片
 *   edit_last = 使用 sourceImageUrls 中的图片进行图生图/多图合成
 *
 * sourceImageUrls:
 *   传给 AGNES extra_body.image 的 URL 数组
 */
async function generateImage(
  prompt,
  ratio = DEFAULT_RATIO,
  {
    mode = "new",
    sourceImageUrl = null,
    sourceImageUrls = [],
  } = {},
) {
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new Error("图片提示词不能为空");
  }

  if (mode !== "new" && mode !== "edit_last") {
    throw new Error(`不支持的图片模式：${mode}`);
  }

  const size = IMAGE_SIZES[ratio] || IMAGE_SIZES[DEFAULT_RATIO];

  const normalizedSources = [
    ...(Array.isArray(sourceImageUrls) ? sourceImageUrls : []),
    ...(sourceImageUrl ? [sourceImageUrl] : []),
  ]
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim())
    .filter((value, index, arr) => arr.indexOf(value) === index);

  if (mode === "edit_last" && normalizedSources.length === 0) {
    throw new Error("edit_last 缺少可用的源图片 URL");
  }

  // 严格按 AGNES 图片 API 示例组织请求。
  // 图生图 / 多图合成：extra_body.image = [url1, url2, ...]
  // 统一要求返回 URL，方便 QQ 直接发送。
  const extraBody = {
    response_format: "url",
  };

  if (mode === "edit_last") {
    extraBody.image = normalizedSources;
  }

  const payload = {
    model: IMAGE_MODEL,
    prompt: prompt.trim(),
    size,
    extra_body: extraBody,
  };

  console.log(
    `[Image] 请求图片 | mode=${mode} | ratio=${ratio} | size=${size} | sources=${normalizedSources.length}`,
  );

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

    const first = response.data?.data?.[0];
    const url = typeof first?.url === "string" ? first.url.trim() : "";

    if (url) {
      console.log(
        `[Image] 图片生成完成 | mode=${mode} | sources=${normalizedSources.length}`,
      );
      return url;
    }

    // 兼容 API 偶尔返回 b64_json 的情况。
    const b64 = typeof first?.b64_json === "string" ? first.b64_json.trim() : "";
    if (b64) {
      console.log(
        `[Image] 图片生成完成（b64_json） | mode=${mode} | sources=${normalizedSources.length}`,
      );
      return `data:image/png;base64,${b64}`;
    }

    throw new Error(
      "API 没有返回图片 URL：" + JSON.stringify(response.data),
    );
  } catch (error) {
    console.error(
      `[Image] 图片生成失败 | mode=${mode} | sources=${normalizedSources.length}:`,
      error.message,
    );

    if (error.response?.data) {
      console.error(
        "[Image] API 返回:",
        JSON.stringify(error.response.data, null, 2),
      );
    }

    throw error;
  }
}

export {
  generateImage,
};
