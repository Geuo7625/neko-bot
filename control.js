import { OWNER_QQ } from "./config.js";

// ============================================================
// 主人专用指令
// ============================================================

const OWNER_ONLY_COMMANDS = new Map([
  ["/clear", "clear"],
  ["/rm -rf /*", "clear_all"],
  ["/reboot", "reboot"],
  ["表情包测试", "sticker_test"],
  ["表情包审核", "sticker_review"],
]);

// 带参数的主人指令：指令名 + 空格 + 参数（表情包序号 / hash 前缀）。
const OWNER_PREFIX_COMMANDS = [
  ["表情包通过", "sticker_approve"],
  ["表情包淘汰", "sticker_reject"],
];

// ============================================================
// 公开指令
//
// 不要求主人身份，但仍然需要经过这里统一识别。
// ============================================================

const PUBLIC_COMMANDS = new Map([["/状态", "server_status"]]);

// ============================================================
// 指令解析
// ============================================================

function isOwnerQq(senderQq) {
  return Boolean(senderQq) && String(senderQq).trim() === String(OWNER_QQ).trim();
}

function handleControlCommand(text, senderQq) {
  if (!text || typeof text !== "string") {
    return null;
  }

  const command = text.trim();
  const lowered = command.toLowerCase();

  // ==========================================================
  // 主人专用（带参数）
  // ==========================================================

  for (const [prefix, action] of OWNER_PREFIX_COMMANDS) {
    if (lowered.startsWith(prefix)) {
      const arg = command.slice(prefix.length).trim();
      return {
        type: isOwnerQq(senderQq) ? "owner" : "unauthorized",
        action,
        arg,
        command: lowered,
      };
    }
  }

  // ==========================================================
  // 主人专用
  // ==========================================================

  const ownerAction = OWNER_ONLY_COMMANDS.get(lowered);

  if (ownerAction) {
    if (isOwnerQq(senderQq)) {
      return {
        type: "owner",
        action: ownerAction,
        command: lowered,
      };
    }

    return {
      type: "unauthorized",
      action: ownerAction,
      command: lowered,
    };
  }

  // ==========================================================
  // 公开
  // ==========================================================

  const publicAction = PUBLIC_COMMANDS.get(lowered);

  if (publicAction) {
    return {
      type: "public",
      action: publicAction,
      command,
    };
  }

  // ==========================================================
  // 普通消息
  // ==========================================================

  return null;
}

export { handleControlCommand };
