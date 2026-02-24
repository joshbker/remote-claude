import fs from "fs";
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  REST,
  Routes,
} from "discord.js";
import { config } from "./config";
import { getState, updateState } from "./state";

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

    default:
      await interaction.reply({ content: "Unknown command.", ephemeral: true });
  }
}
