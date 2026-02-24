import { spawn } from "child_process";
import { createInterface } from "readline";
import { UserState } from "./state";

const TIMEOUT_MS = 10 * 60 * 1000; // 10 minute timeout

export interface ClaudeResponse {
  text: string;
  toolUse: string[];
  error: string | null;
  costUsd: number | null;
}

export interface StreamEvent {
  type: "text" | "tool_use" | "tool_result" | "thinking";
  content: string;
}

export async function sendMessage(
  prompt: string,
  state: UserState,
  onStream?: (event: StreamEvent) => void
): Promise<ClaudeResponse> {
  const systemPrompt = [
    "🤖 OPERATIONAL CONTEXT: You are currently running as the Remote Claude Discord bot.",
    "The user is messaging you RIGHT NOW through Discord DMs, and you are responding via the Claude Code CLI on their local machine.",
    "This conversation is happening through the bot architecture described in the codebase you have access to.",
    `Working directory: ${state.cwd}`,
    "You have full Claude Code capabilities: file editing, bash, search, web access, etc.",
    "Keep responses concise (Discord has a 2000 char per message limit, long responses get split).",
    "Use markdown and code blocks for formatting.",
  ].join(" ");

  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--model", state.model,
    "--permission-mode", state.permissionMode,
    "--append-system-prompt", systemPrompt,
  ];

  if (state.hasActiveSession) {
    args.push("--continue");
  }

  console.log(`[claude] model=${state.model}, cwd=${state.cwd}, continue=${state.hasActiveSession}`);
  console.log(`[claude] Prompt: ${prompt.slice(0, 100)}${prompt.length > 100 ? "..." : ""}`);

  // Clean env to avoid nested Claude Code detection
  const cleanEnv = { ...process.env };
  for (const key of [
    "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_AGENT_SDK_VERSION",
    "CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES", "CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL",
    "CLAUDE_CODE_MODULE_PATH", "CLAUDE_CODE_SESSION_ID",
  ]) {
    delete cleanEnv[key];
  }

  return new Promise((resolve) => {
    let resolved = false;
    const textParts: string[] = [];
    const toolUseParts: string[] = [];
    let costUsd: number | null = null;
    let error: string | null = null;

    const finish = (override?: Partial<ClaudeResponse>) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      resolve({
        text: textParts.join(""),
        toolUse: toolUseParts,
        error,
        costUsd,
        ...override,
      });
    };

    const timeout = setTimeout(() => {
      console.log("[claude] TIMEOUT - killing process");
      proc?.kill();
      finish({ error: "Claude timed out after 10 minutes." });
    }, TIMEOUT_MS);

    const proc = spawn("claude", args, {
      cwd: state.cwd,
      shell: true,
      env: cleanEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    console.log(`[claude] PID: ${proc.pid}`);

    // Pipe prompt via stdin to avoid shell escaping issues
    proc.stdin?.write(prompt);
    proc.stdin?.end();

    let stderr = "";

    // Parse NDJSON lines from stdout
    if (proc.stdout) {
      const rl = createInterface({ input: proc.stdout });
      rl.on("line", (line) => {
        if (!line.trim()) return;
        try {
          const msg = JSON.parse(line);
          handleMessage(msg, textParts, toolUseParts, state, onStream, (c) => { costUsd = c; }, (e) => { error = e; });
        } catch {
          // Skip non-JSON lines
        }
      });
    }

    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      console.log(`[claude] stderr: ${text.trim()}`);
    });

    proc.on("error", (err) => {
      console.error("[claude] Process error:", err.message);
      finish({ error: `Process error: ${err.message}` });
    });

    proc.on("close", (code) => {
      console.log(`[claude] Exited code=${code}, text parts=${textParts.length}, tool parts=${toolUseParts.length}`);
      if (code !== 0 && textParts.length === 0) {
        error = error || stderr.trim() || `Claude exited with code ${code}`;
      }
      finish();
    });
  });
}

function handleMessage(
  msg: any,
  textParts: string[],
  toolUseParts: string[],
  state: UserState,
  onStream: ((event: StreamEvent) => void) | undefined,
  setCost: (cost: number) => void,
  setError: (error: string) => void,
): void {
  switch (msg.type) {
    case "system":
      if (msg.subtype === "init") {
        console.log(`[claude] Session: ${msg.session_id}`);
      }
      break;

    case "assistant":
      // Full assistant message with content blocks
      if (msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text) {
            textParts.push(block.text);
            onStream?.({ type: "text", content: block.text });
          } else if (block.type === "tool_use") {
            if (state.showToolUse) {
              const formatted = formatToolUse(block.name, block.input);
              toolUseParts.push(formatted);
              onStream?.({ type: "tool_use", content: formatted });
            } else {
              // Even if not showing, notify stream so user sees activity
              onStream?.({ type: "tool_use", content: `Using ${block.name}...` });
            }
          }
        }
      }
      break;

    case "result":
      if (msg.total_cost_usd != null) {
        setCost(msg.total_cost_usd);
      } else if (msg.cost_usd != null) {
        setCost(msg.cost_usd);
      }
      if (msg.is_error || msg.subtype?.startsWith("error")) {
        const errMsg = msg.error || msg.errors?.join(", ") || "Unknown error";
        setError(errMsg);
      }
      // The result message also has a `result` field with the final text
      // Only use it if we didn't already capture text from assistant messages
      if (textParts.length === 0 && msg.result) {
        textParts.push(msg.result);
      }
      console.log(`[claude] Result: ${msg.subtype}, cost=$${msg.total_cost_usd ?? "?"}`);
      break;

    default:
      // Log unknown types for debugging
      if (msg.type) {
        console.log(`[claude] Event: ${msg.type}${msg.subtype ? "/" + msg.subtype : ""}`);
      }
      break;
  }
}

function formatToolUse(toolName: string, input: any): string {
  const icon = getToolIcon(toolName);

  switch (toolName) {
    case "Read":
      return `-# ${icon} Read ${input?.file_path || "unknown"}`;
    case "Write":
      return `-# ${icon} Created ${input?.file_path || "unknown"}`;
    case "Edit":
      return `-# ${icon} Edited ${input?.file_path || "unknown"}`;
    case "Bash": {
      const cmd = input?.command || "";
      const short = cmd.length > 80 ? cmd.slice(0, 80) + "..." : cmd;
      return `-# ${icon} ${short}`;
    }
    case "Glob":
      return `-# ${icon} Search files: ${input?.pattern || ""}`;
    case "Grep":
      return `-# ${icon} Search code: ${input?.pattern || ""}`;
    case "WebSearch":
      return `-# ${icon} Web search: ${input?.query || ""}`;
    case "WebFetch":
      return `-# ${icon} Fetch: ${input?.url || ""}`;
    case "Task":
      return `-# ${icon} Agent: ${input?.description || ""}`;
    default:
      return `-# ${icon} ${toolName}`;
  }
}

function getToolIcon(toolName: string): string {
  const icons: Record<string, string> = {
    Read: "📖", Write: "📝", Edit: "✏️", Bash: "⚡",
    Glob: "🔍", Grep: "🔎", WebSearch: "🌐", WebFetch: "🌐",
    Task: "🤖", TodoWrite: "📋", AskUserQuestion: "❓",
  };
  return icons[toolName] || "🔧";
}
