# Remote Claude - Access Claude Code From Anywhere

A Discord bot that wraps Claude Code CLI, allowing you to use Claude Code remotely from anywhere via Discord DMs.

## What This Does

Instead of being limited to running Claude Code in a local terminal, this bot lets you:
- DM the bot from your phone, tablet, or any device with Discord
- Claude Code runs against your local filesystem with full tool access (file editing, bash, etc.)
- Conversation persists across messages via `--continue`

## Architecture

```
Discord DM → Discord.js bot (local) → claude -p (CLI) → Local filesystem
```

The bot spawns `claude -p` with the prompt piped via stdin, collects the response, and sends it back to Discord.

## Setup

1. Create a Discord bot at https://discord.com/developers/applications
2. Enable **Message Content Intent** in the Bot settings
3. Fill in `.env`:
   - `DISCORD_TOKEN` — bot token
   - `DISCORD_APP_ID` — application ID
   - `DISCORD_OWNER_ID` — your Discord user ID (for owner-only access)
4. `npm install && npm start`

## Slash Commands

| Command | Description |
|---------|-------------|
| `/cwd [path]` | View or change working directory |
| `/clear` | Start fresh conversation |
| `/model [sonnet\|opus\|haiku]` | Change model |
| `/tools [show\|hide]` | Toggle tool usage display |
| `/status` | Show current config |
| `/perms [mode]` | Change permission mode |

## Key Files

- `src/index.ts` — Entry point, Discord client setup
- `src/claude.ts` — Spawns Claude CLI, pipes prompt via stdin
- `src/messageHandler.ts` — DM message → Claude → Discord response
- `src/commands.ts` — Slash command handlers
- `src/state.ts` — Persisted state (cwd, model, session, etc.)
- `src/discord.ts` — Message splitting, typing indicator

## Notes

- Prompt is piped via stdin to avoid Windows shell escaping issues
- `stdio: ["pipe", "pipe", "pipe"]` required for stdin writing
- Conversation continuity via `--continue` flag (continues last session in CWD)
- `/cwd` change resets the session since sessions are per-directory
- **Context awareness**: Uses `--append-system-prompt` to inject context telling Claude it's being accessed via Discord, so it's immediately aware of the interface, message length limits, and capabilities
- **Streaming**: Uses `--output-format stream-json --verbose` for NDJSON streaming — gives real-time tool usage events and text as they arrive
- **Tool display**: When `/tools show` is on, tool usage (file reads, edits, bash commands) is shown with emoji icons before the response text
