import { DMChannel, TextBasedChannel } from "discord.js";

const MAX_LENGTH = 2000;

export function splitMessage(content: string): string[] {
  if (content.length <= MAX_LENGTH) return [content];

  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitIndex = -1;

    // Try to split at a code block boundary (```) before the limit
    const codeBlockPattern = /```\n?/g;
    let inCodeBlock = false;
    let lastCodeBlockEnd = -1;
    let match: RegExpExecArray | null;

    while ((match = codeBlockPattern.exec(remaining)) !== null) {
      if (match.index >= MAX_LENGTH) break;
      if (inCodeBlock) {
        lastCodeBlockEnd = match.index + match[0].length;
      }
      inCodeBlock = !inCodeBlock;
    }

    // If we found a complete code block boundary, split after it
    if (lastCodeBlockEnd > 0 && lastCodeBlockEnd > MAX_LENGTH * 0.3) {
      splitIndex = lastCodeBlockEnd;
    }

    // Fall back to newline
    if (splitIndex === -1) {
      splitIndex = remaining.lastIndexOf("\n", MAX_LENGTH);
    }

    // Fall back to space
    if (splitIndex === -1 || splitIndex < MAX_LENGTH * 0.3) {
      splitIndex = remaining.lastIndexOf(" ", MAX_LENGTH);
    }

    // Hard cut as last resort
    if (splitIndex === -1 || splitIndex < MAX_LENGTH * 0.3) {
      splitIndex = MAX_LENGTH;
    }

    let chunk = remaining.slice(0, splitIndex);
    remaining = remaining.slice(splitIndex).trimStart();

    // Handle split inside code block: close it in this chunk, reopen in next
    const backtickCount = (chunk.match(/```/g) || []).length;
    if (backtickCount % 2 !== 0) {
      chunk += "\n```";
      remaining = "```\n" + remaining;
    }

    chunks.push(chunk);
  }

  return chunks;
}

export function startTypingIndicator(
  channel: TextBasedChannel
): { stop: () => void } {
  const interval = setInterval(() => {
    (channel as DMChannel).sendTyping().catch(() => {});
  }, 8000);

  // Send immediately
  (channel as DMChannel).sendTyping().catch(() => {});

  return {
    stop: () => clearInterval(interval),
  };
}
