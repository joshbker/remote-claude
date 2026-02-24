import fs from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  REST,
  Routes,
  Message,
  DMChannel,
  Collection,
} from "discord.js";
import { config } from "./config";
import { getState, updateState } from "./state";
import { cancelCurrentRequest } from "./claude";
import { setRecalledContext, clearRecalledContext } from "./messageHandler";

const commands = [
  new SlashCommandBuilder()
    .setName("cwd")
    .setDescription("View or change the working directory")
    .addStringOption((opt) =>
      opt.setName("path").setDescription("New working directory path")
    ),

  new SlashCommandBuilder()
    .setName("clear")
    .setDescription("Clear conversation history and start fresh"),

  new SlashCommandBuilder()
    .setName("model")
    .setDescription("View or change the Claude model")
    .addStringOption((opt) =>
      opt
        .setName("name")
        .setDescription("Model name")
        .addChoices(
          { name: "Sonnet", value: "sonnet" },
          { name: "Opus", value: "opus" },
          { name: "Haiku", value: "haiku" }
        )
    ),

  new SlashCommandBuilder()
    .setName("tools")
    .setDescription("Toggle tool usage display in responses")
    .addStringOption((opt) =>
      opt
        .setName("action")
        .setDescription("Show or hide tool usage")
        .setRequired(true)
        .addChoices(
          { name: "Show tool usage", value: "show" },
          { name: "Hide tool usage", value: "hide" }
        )
    ),

  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show current bot configuration"),

  new SlashCommandBuilder()
    .setName("perms")
    .setDescription("Change permission mode")
    .addStringOption((opt) =>
      opt
        .setName("mode")
        .setDescription("Permission mode")
        .setRequired(true)
        .addChoices(
          { name: "Default (ask)", value: "default" },
          { name: "Accept edits", value: "acceptEdits" },
          { name: "Bypass all", value: "bypassPermissions" }
        )
    ),

  new SlashCommandBuilder()
    .setName("restart")
    .setDescription("Restart the bot (picks up code changes)"),

  new SlashCommandBuilder()
    .setName("remember")
    .setDescription("Save a memory for Claude to remember across all sessions")
    .addStringOption((opt) =>
      opt
        .setName("memory")
        .setDescription("What to remember")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("recall")
    .setDescription("Search Discord message history and inject it into context")
    .addStringOption((opt) =>
      opt
        .setName("query")
        .setDescription("Search term to find in message history (optional - returns all if omitted)")
        .setRequired(false)
    )
    .addIntegerOption((opt) =>
      opt
        .setName("limit")
        .setDescription("Number of messages to search (default: 200)")
        .setMinValue(10)
        .setMaxValue(500)
    ),

  new SlashCommandBuilder()
    .setName("viewmemory")
    .setDescription("View all saved global memories"),

  new SlashCommandBuilder()
    .setName("forget")
    .setDescription("Remove a memory by its number")
    .addIntegerOption((opt) =>
      opt
        .setName("number")
        .setDescription("Memory number to forget (use /viewmemory to see numbers)")
        .setRequired(true)
        .setMinValue(1)
    ),

  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Show all available commands"),
];

function trackCommand(commandName: string, args?: Record<string, any>): void {
  const state = getState();
  const argStr = args && Object.keys(args).length > 0
    ? " " + Object.entries(args).map(([k, v]) => `${k}="${v}"`).join(" ")
    : "";
  const commandStr = `/${commandName}${argStr}`;

  // Keep last 10 commands
  const recentCommands = [...state.recentCommands, commandStr].slice(-10);
  updateState({ recentCommands });
}

export async function registerCommands(): Promise<void> {
  const rest = new REST().setToken(config.discordToken);
  await rest.put(Routes.applicationCommands(config.discordAppId), {
    body: commands.map((c) => c.toJSON()),
  });
  console.log("Slash commands registered.");
}

export async function handleCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  // Owner only
  if (interaction.user.id !== config.ownerId) {
    await interaction.reply({ content: "This bot is private.", ephemeral: true });
    return;
  }

  const state = getState();

  switch (interaction.commandName) {
    case "cwd": {
      const newPath = interaction.options.getString("path");
      if (!newPath) {
        trackCommand("cwd");
        await interaction.reply(`Current working directory: \`${state.cwd}\``);
        return;
      }

      // Normalize path separators
      const normalized = newPath.replace(/\\/g, "/");

      if (!fs.existsSync(normalized)) {
        await interaction.reply(`Path does not exist: \`${normalized}\``);
        return;
      }

      const stat = fs.statSync(normalized);
      if (!stat.isDirectory()) {
        await interaction.reply(`Not a directory: \`${normalized}\``);
        return;
      }

      trackCommand("cwd", { path: normalized });
      updateState({ cwd: normalized, hasActiveSession: false, sessionCostUsd: 0 });
      await interaction.reply(
        `Working directory changed to \`${normalized}\`\nConversation cleared (new directory).`
      );
      break;
    }

    case "clear": {
      trackCommand("clear");
      updateState({ hasActiveSession: false, sessionCostUsd: 0 });
      clearRecalledContext();
      await interaction.reply("Conversation cleared. Next message starts fresh.");
      break;
    }

    case "model": {
      const name = interaction.options.getString("name");
      if (!name) {
        trackCommand("model");
        await interaction.reply(`Current model: \`${state.model}\``);
        return;
      }
      trackCommand("model", { name });
      updateState({ model: name });
      await interaction.reply(`Model changed to \`${name}\`.`);
      break;
    }

    case "tools": {
      const action = interaction.options.getString("action", true);
      const show = action === "show";
      trackCommand("tools", { action });
      updateState({ showToolUse: show });
      await interaction.reply(
        show
          ? "Tool usage will now be shown in responses."
          : "Tool usage is now hidden."
      );
      break;
    }

    case "status": {
      trackCommand("status");
      const lines = [
        `**Working directory:** \`${state.cwd}\``,
        `**Model:** \`${state.model}\``,
        `**Session:** ${state.hasActiveSession ? "active" : "none"}`,
        `**Session cost:** $${state.sessionCostUsd.toFixed(4)}`,
        `**Permission mode:** \`${state.permissionMode}\``,
        `**Show tool use:** ${state.showToolUse ? "yes" : "no"}`,
      ];
      await interaction.reply(lines.join("\n"));
      break;
    }

    case "perms": {
      const mode = interaction.options.getString("mode", true);
      trackCommand("perms", { mode });
      updateState({ permissionMode: mode });
      await interaction.reply(`Permission mode changed to \`${mode}\`.`);
      break;
    }

    case "restart": {
      trackCommand("restart");
      cancelCurrentRequest();
      await interaction.reply("🔄 Restarting bot...");
      // Give Discord time to send the reply, then exit.
      // The wrapper (restart.ts) will auto-restart the process.
      setTimeout(() => process.exit(0), 1000);
      break;
    }

    case "remember": {
      const memory = interaction.options.getString("memory", true);
      await interaction.deferReply();

      try {
        // Run the claude CLI /remember command
        const result = await runClaudeRemember(memory, state.cwd);
        if (result.success) {
          trackCommand("remember", { memory });
          await interaction.editReply(`✅ Memory saved: "${memory}"`);
        } else {
          await interaction.editReply(`❌ Failed to save memory: ${result.error}`);
        }
      } catch (err: any) {
        await interaction.editReply(`❌ Error: ${err.message}`);
      }
      break;
    }

    case "recall": {
      // Defer immediately to avoid timeout
      await interaction.deferReply();

      try {
        const query = interaction.options.getString("query");
        const limit = interaction.options.getInteger("limit") || 200;
        const channel = interaction.channel as DMChannel;

        console.log(`[recall] Fetching ${limit} messages, query: ${query || "none"}`);
        const context = await fetchMessageHistory(channel, query, limit);
        console.log(`[recall] Got ${context.split('\n\n').length} results`);

        if (context.length === 0) {
          const searchMsg = query ? `matching "${query}"` : "in history";
          await interaction.editReply(`🔍 No messages found ${searchMsg}`);
          return;
        }

        // Store the context for the next message
        setRecalledContext(context);

        const trackArgs: Record<string, any> = {};
        if (query) trackArgs.query = query;
        if (limit !== 200) trackArgs.limit = limit;
        trackCommand("recall", trackArgs);

        const searchMsg = query ? `matching "${query}"` : "from recent history";
        await interaction.editReply(
          `✅ Found ${context.split('\n\n').length} relevant message(s) ${searchMsg}\n` +
          `Context will be injected into your next message (then kept via --continue).`
        );
      } catch (err: any) {
        console.error("[recall] Error:", err);
        await interaction.editReply(`❌ Error: ${err.message}`).catch(() => {});
      }
      break;
    }

    case "viewmemory": {
      trackCommand("viewmemory");
      await interaction.deferReply();

      try {
        const memories = await getClaudeMemories();
        if (memories.length === 0) {
          await interaction.editReply("📝 No memories saved yet. Use `/remember` to add one.");
        } else {
          const memoryList = memories
            .map((m, i) => `${i + 1}. [${m.date}] ${m.content}`)
            .join("\n");
          await interaction.editReply(`📝 **Global Memories:**\n\n${memoryList}`);
        }
      } catch (err: any) {
        await interaction.editReply(`❌ Error: ${err.message}`);
      }
      break;
    }

    case "forget": {
      const number = interaction.options.getInteger("number", true);
      await interaction.deferReply();

      try {
        const result = await forgetClaudeMemory(number);
        if (result.success) {
          trackCommand("forget", { number });
          await interaction.editReply(`✅ Forgot memory #${number}`);
        } else {
          await interaction.editReply(`❌ ${result.error}`);
        }
      } catch (err: any) {
        await interaction.editReply(`❌ Error: ${err.message}`);
      }
      break;
    }

    case "help": {
      const helpText = [
        "**📋 Remote Claude Bot Commands**",
        "",
        "**💬 Conversation**",
        "`/clear` — Start fresh conversation",
        "`/recall [query] [limit]` — Search Discord history & inject into context",
        "",
        "**⚙️ Configuration**",
        "`/cwd [path]` — View or change working directory",
        "`/model [sonnet|opus|haiku]` — View or change model",
        "`/perms [mode]` — Change permission mode",
        "`/tools [show|hide]` — Toggle tool usage display",
        "`/status` — Show current config",
        "",
        "**🧠 Memory**",
        "`/remember [text]` — Save a persistent memory",
        "`/viewmemory` — View all saved memories",
        "`/forget [number]` — Remove a memory",
        "",
        "**🔧 System**",
        "`/restart` — Restart bot (picks up code changes)",
        "`/help` — This message",
        "",
        `-# Send any DM to chat • Attach files for analysis • ${config.botName} has full Claude Code access`,
      ];
      await interaction.reply(helpText.join("\n"));
      break;
    }

    default:
      await interaction.reply({ content: "Unknown command.", ephemeral: true });
  }
}

async function runClaudeRemember(
  memory: string,
  cwd: string
): Promise<{ success: boolean; error?: string }> {
  try {
    // Get the global CLAUDE.md path
    const claudeDir = path.join(os.homedir(), ".claude");
    const claudeMdPath = path.join(claudeDir, "CLAUDE.md");

    // Ensure .claude directory exists
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }

    // Read existing content or create new file
    let existingContent = "";
    if (fs.existsSync(claudeMdPath)) {
      existingContent = fs.readFileSync(claudeMdPath, "utf-8");
    } else {
      // Create initial structure
      existingContent = "# Global Memory for Claude Code\n\n## Discord Bot Memories\n\n";
    }

    // Format the new memory entry with timestamp
    const timestamp = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
    const memoryEntry = `- [${timestamp}] ${memory}\n`;

    // Check if there's a "Discord Bot Memories" section
    if (existingContent.includes("## Discord Bot Memories")) {
      // Append under the Discord Bot Memories section
      existingContent = existingContent.replace(
        /## Discord Bot Memories\n/,
        `## Discord Bot Memories\n\n${memoryEntry}`
      );
    } else {
      // Add a new section at the end
      existingContent += `\n## Discord Bot Memories\n\n${memoryEntry}`;
    }

    // Write back to file
    fs.writeFileSync(claudeMdPath, existingContent, "utf-8");

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

async function fetchMessageHistory(
  channel: DMChannel,
  query: string | null,
  limit: number
): Promise<string> {
  // Discord API limits fetches to 100 messages at a time, so we need to paginate
  const allMessages: Message[] = [];
  let lastId: string | undefined = undefined;
  const batchSize = 100;

  while (allMessages.length < limit) {
    const toFetch = Math.min(batchSize, limit - allMessages.length);
    const options: { limit: number; before?: string } = {
      limit: toFetch,
      ...(lastId && { before: lastId })
    };

    const batch = await channel.messages.fetch(options) as Collection<string, Message>;

    // batch is a Collection<string, Message>
    if (batch.size === 0) break; // No more messages

    allMessages.push(...batch.values());
    lastId = batch.last()?.id;

    // If we got fewer than requested, we've hit the end
    if (batch.size < toFetch) break;
  }

  // Filter messages that contain the query (case insensitive) if query provided
  let relevant: Message[] = allMessages;

  if (query) {
    const queryLower = query.toLowerCase();
    relevant = [];
    for (const msg of allMessages) {
      if (msg.content.toLowerCase().includes(queryLower)) {
        relevant.push(msg);
      }
    }
  }

  // Sort by timestamp (oldest first)
  relevant.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  // Format as conversation pairs
  const formatted: string[] = [];

  for (const msg of relevant) {
    const author = msg.author.bot ? "Assistant" : "User";
    const timestamp = msg.createdAt.toISOString().split('T')[0]; // Just the date
    formatted.push(`[${timestamp}] ${author}: ${msg.content}`);
  }

  return formatted.join('\n\n');
}

async function getClaudeMemories(): Promise<Array<{ date: string; content: string }>> {
  const claudeMdPath = path.join(os.homedir(), ".claude", "CLAUDE.md");

  if (!fs.existsSync(claudeMdPath)) {
    return [];
  }

  const content = fs.readFileSync(claudeMdPath, "utf-8");
  const memories: Array<{ date: string; content: string }> = [];

  // Parse memories in the "Discord Bot Memories" section
  const lines = content.split("\n");
  let inDiscordSection = false;

  for (const line of lines) {
    if (line.trim() === "## Discord Bot Memories") {
      inDiscordSection = true;
      continue;
    }

    // Stop if we hit another section
    if (inDiscordSection && line.startsWith("##")) {
      break;
    }

    // Parse memory entries like: - [2026-02-24] Some memory text
    if (inDiscordSection && line.trim().startsWith("- [")) {
      const match = line.match(/^- \[([^\]]+)\] (.+)$/);
      if (match) {
        memories.push({
          date: match[1],
          content: match[2],
        });
      }
    }
  }

  return memories;
}

async function forgetClaudeMemory(
  number: number
): Promise<{ success: boolean; error?: string }> {
  try {
    const claudeMdPath = path.join(os.homedir(), ".claude", "CLAUDE.md");

    if (!fs.existsSync(claudeMdPath)) {
      return { success: false, error: "No memories found" };
    }

    const content = fs.readFileSync(claudeMdPath, "utf-8");
    const lines = content.split("\n");
    let inDiscordSection = false;
    let memoryIndex = 0;
    let lineToRemove = -1;

    // Find the memory to remove
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.trim() === "## Discord Bot Memories") {
        inDiscordSection = true;
        continue;
      }

      if (inDiscordSection && line.startsWith("##")) {
        break;
      }

      if (inDiscordSection && line.trim().startsWith("- [")) {
        memoryIndex++;
        if (memoryIndex === number) {
          lineToRemove = i;
          break;
        }
      }
    }

    if (lineToRemove === -1) {
      return { success: false, error: `Memory #${number} not found` };
    }

    // Remove the line
    lines.splice(lineToRemove, 1);

    // Write back
    fs.writeFileSync(claudeMdPath, lines.join("\n"), "utf-8");

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
