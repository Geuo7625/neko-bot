import { OWNER_QQ } from "./config.js";

// ============================================================
// 主人专用指令
// ============================================================

const OWNER_ONLY_COMMANDS = new Map([
  ["/clear", "clear"],
  ["/rm -rf /*", "clear_all"],
  ["/reboot", "reboot"],
]);

// ============================================================
// 公开指令
//
// 不要求主人身份，但仍然需要经过这里统一识别。
// ============================================================

const PUBLIC_COMMANDS = new Map([["/状态", "server_status"]]);

// ============================================================
// 指令解析
// ============================================================

function handleControlCommand(text, senderQq) {
  if (!text || typeof text !== "string") {
    return null;
  }

  const command = text.trim().toLowerCase();

  // ==========================================================
  // 主人专用
  // ==========================================================

  const ownerAction = OWNER_ONLY_COMMANDS.get(command);

  if (ownerAction) {
    const isOwner =
      senderQq && String(senderQq).trim() === String(OWNER_QQ).trim();

    if (isOwner) {
      return {
        type: "owner",
        action: ownerAction,
        command,
      };
    }

    return {
      type: "unauthorized",
      action: ownerAction,
      command,
    };
  }

  // ==========================================================
  // 公开
  // ==========================================================

  const publicAction = PUBLIC_COMMANDS.get(command);

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
