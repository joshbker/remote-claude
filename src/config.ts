import "dotenv/config";
import path from "path";
import os from "os";

export const config = {
  discordToken: process.env.DISCORD_TOKEN!,
  discordAppId: process.env.DISCORD_APP_ID!,
  ownerId: process.env.DISCORD_OWNER_ID!,
  defaultCwd: process.env.DEFAULT_CWD || os.homedir(),
  defaultModel: process.env.DEFAULT_MODEL || "sonnet",
  defaultPermissionMode: process.env.DEFAULT_PERMISSION_MODE || "acceptEdits",
  statePath: path.join(__dirname, "..", "data", "state.json"),
  botName: process.env.BOT_NAME || "Clawde",
  ownerName: process.env.OWNER_NAME || "the user",
  systemPrompt: process.env.SYSTEM_PROMPT || "",
};
