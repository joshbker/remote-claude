import fs from "fs";
import { spawn } from "child_process";
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  REST,
  Routes,
  Message,
  DMChannel,
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
];

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

      updateState({ cwd: normalized, hasActiveSession: false, sessionCostUsd: 0 });
      await interaction.reply(
        `Working directory changed to \`${normalized}\`\nConversation cleared (new directory).`
      );
      break;
    }

    case "clear": {
      updateState({ hasActiveSession: false, sessionCostUsd: 0 });
      clearRecalledContext();
      await interaction.reply("Conversation cleared. Next message starts fresh.");
      break;
    }

    case "model": {
      const name = interaction.options.getString("name");
      if (!name) {
        await interaction.reply(`Current model: \`${state.model}\``);
        return;
      }
      updateState({ model: name });
      await interaction.reply(`Model changed to \`${name}\`.`);
      break;
    }

    case "tools": {
      const action = interaction.options.getString("action", true);
      const show = action === "show";
      updateState({ showToolUse: show });
      await interaction.reply(
        show
          ? "Tool usage will now be shown in responses."
          : "Tool usage is now hidden."
      );
      break;
    }

    case "status": {
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
      updateState({ permissionMode: mode });
      await interaction.reply(`Permission mode changed to \`${mode}\`.`);
      break;
    }

    case "restart": {
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

        const searchMsg = query ? `matching "${query}"` : "from recent history";
        await interaction.editReply(
          `✅ Found ${context.split('\n\n').length} relevant message(s) ${searchMsg}\n` +
          `Context is now active for this session. Use /clear to remove it.`
        );
      } catch (err: any) {
        console.error("[recall] Error:", err);
        await interaction.editReply(`❌ Error: ${err.message}`).catch(() => {});
      }
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
  return new Promise((resolve) => {
    const proc = spawn("claude", ["/remember", memory], {
      cwd,
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => {
      resolve({ success: false, error: err.message });
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ success: true });
      } else {
        resolve({ success: false, error: stderr.trim() || `Exit code ${code}` });
      }
    });
  });
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
    const options: any = { limit: toFetch };
    if (lastId) {
      options.before = lastId;
    }

    const batch = await channel.messages.fetch(options);
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
