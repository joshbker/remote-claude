import fs from "fs";
import path from "path";
import { config } from "./config";

export interface UserState {
  cwd: string;
  model: string;
  hasActiveSession: boolean;
  showToolUse: boolean;
  permissionMode: string;
  sessionCostUsd: number;
  recentCommands: string[];
}

let state: UserState | null = null;

function getDefaultState(): UserState {
  return {
    cwd: config.defaultCwd,
    model: config.defaultModel,
    hasActiveSession: false,
    showToolUse: false,
    permissionMode: config.defaultPermissionMode,
    sessionCostUsd: 0,
    recentCommands: [],
  };
}

export function getState(): UserState {
  if (state) return state;

  try {
    const raw = fs.readFileSync(config.statePath, "utf-8");
    state = { ...getDefaultState(), ...JSON.parse(raw) };
  } catch {
    state = getDefaultState();
  }

  return state!;
}

export function updateState(partial: Partial<UserState>): UserState {
  const current = getState();
  Object.assign(current, partial);
  saveState();
  return current;
}

function saveState(): void {
  const dir = path.dirname(config.statePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(config.statePath, JSON.stringify(state, null, 2));
}
