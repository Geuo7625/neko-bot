// ============================================================
// 图片输入 / Vision
// ============================================================
function createVisionMessage(imageContent, userText) {
  const content = [
    {
      type: "image_url",
      image_url: {
        url: imageContent,
      },
    },
    {
      type: "text",
      text:
        userText ||
        "请结合当前上下文判断这张图片是否与用户的问题有关。" +
          "如果用户是在询问图片内容，再分析图片；" +
          "如果当前内容与图片无关，就不要主动描述图片。",
    },
  ];
  return {
    content,
    historyText: `[发送了一张图片/头像] ${userText || ""}`.trim(),
  };
}
export { createVisionMessage };
