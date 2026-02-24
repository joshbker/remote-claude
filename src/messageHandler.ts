import { Message, ChannelType, DMChannel } from "discord.js";
import { config } from "./config";
import { getState, updateState } from "./state";
import { sendMessage, StreamEvent } from "./claude";
import { splitMessage, startTypingIndicator } from "./discord";

let busy = false;

export async function handleDirectMessage(message: Message): Promise<void> {
  // Ignore bots
  if (message.author.bot) return;

  // Only DMs
  if (message.channel.type !== ChannelType.DM) return;

  // Owner only
  if (message.author.id !== config.ownerId) {
    await message.reply("This bot is private.");
    return;
  }

  // Concurrency lock
  if (busy) {
    await message.reply("Still processing your previous request. Please wait.");
    return;
  }

  const prompt = message.content;
  if (!prompt.trim()) return;

  const channel = message.channel as DMChannel;
  busy = true;
  const typing = startTypingIndicator(message.channel);

  try {
    const state = getState();

    // Live status tracking
    const status = { msg: null as Message | null, lines: [] as string[], lastEdit: 0 };
    const EDIT_INTERVAL = 2000;

    const updateStatus = async () => {
      const now = Date.now();
      if (now - status.lastEdit < EDIT_INTERVAL) return;
      status.lastEdit = now;

      const display = status.lines.join("\n") || "⏳ Thinking...";
      const truncated = display.length > 1900 ? display.slice(0, 1900) + "\n..." : display;

      try {
        if (!status.msg) {
          status.msg = await channel.send(truncated);
        } else {
          await status.msg.edit(truncated);
        }
      } catch {
        // Ignore edit failures
      }
    };

    // Stream callback — shows live tool use and progress
    const onStream = (event: StreamEvent) => {
      if (event.type === "tool_use") {
        status.lines.push(event.content);
        updateStatus();
      }
    };

    const response = await sendMessage(prompt, state, onStream);

    typing.stop();

    // Mark active session
    if (!state.hasActiveSession && !response.error) {
      updateState({ hasActiveSession: true });
    }

    // Track cost
    if (response.costUsd) {
      updateState({ sessionCostUsd: state.sessionCostUsd + response.costUsd });
    }

    // Build final response
    const parts: string[] = [];

    // Tool usage summary (if enabled and tools were used)
    if (response.toolUse.length > 0) {
      parts.push(response.toolUse.join("\n"));
    }

    // Main text
    if (response.text.trim()) {
      parts.push(response.text);
    }

    // Error
    if (response.error) {
      parts.push(`**Error:** ${response.error}`);
    }

    let text = parts.join("\n\n");
    if (!text.trim()) {
      text = "(No response)";
    }

    // Send final response
    const chunks = splitMessage(text);

    if (status.msg) {
      // Replace the status message with the first chunk of the final response
      await status.msg.edit(chunks[0]).catch(() => {});
      for (let i = 1; i < chunks.length; i++) {
        await channel.send(chunks[i]);
      }
    } else {
      for (const chunk of chunks) {
        await channel.send(chunk);
      }
    }
  } catch (err: any) {
    typing.stop();
    await channel.send(`**Error:** ${err.message}`).catch(() => {});
  } finally {
    busy = false;
  }
}
