import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  InteractionType,
} from "discord.js";
import { config } from "./config";
import { handleDirectMessage } from "./messageHandler";
import { registerCommands, handleCommand } from "./commands";

const client = new Client({
  intents: [
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  try {
    await registerCommands();
  } catch (err) {
    console.error("Failed to register commands:", err);
  }
});

client.on(Events.MessageCreate, handleDirectMessage);

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.type !== InteractionType.ApplicationCommand) return;
  if (!interaction.isChatInputCommand()) return;
  try {
    await handleCommand(interaction);
  } catch (err) {
    console.error("Command error:", err);
    const reply = interaction.replied || interaction.deferred
      ? interaction.followUp.bind(interaction)
      : interaction.reply.bind(interaction);
    await reply({ content: "Something went wrong.", ephemeral: true }).catch(() => {});
  }
});

process.on("SIGINT", () => {
  console.log("Shutting down...");
  client.destroy();
  process.exit(0);
});

process.on("SIGTERM", () => {
  client.destroy();
  process.exit(0);
});

client.login(config.discordToken);
