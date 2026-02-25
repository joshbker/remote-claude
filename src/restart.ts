import { spawn, ChildProcess, execSync } from "child_process";

// Simple wrapper that restarts the bot when it exits
let child: ChildProcess | null = null;
let crashCount = 0;
const MAX_CRASHES = 3;

function typeCheck(): boolean {
  try {
    console.log("[wrapper] Running type check...");
    execSync("npx tsc --noEmit", { stdio: "pipe", cwd: process.cwd() });
    console.log("[wrapper] Type check passed.");
    return true;
  } catch (err: any) {
    console.error("[wrapper] Type check failed:");
    const error = err.stderr?.toString() || err.stdout?.toString() || err.message;
    console.error(error);
    return false;
  }
}

function start() {
  // First run type check - if it fails, don't even try to start
  if (!typeCheck()) {
    console.error("[wrapper] Not starting bot due to type errors. Fix the errors and restart manually.");
    process.exit(1);
  }

  console.log("[wrapper] Starting bot...");
  child = spawn("npx", ["tsx", "src/index.ts"], {
    stdio: "inherit",
    shell: true,
    cwd: process.cwd(),
  });

  child.on("close", (code) => {
    child = null;
    if (code === 0) {
      console.log("[wrapper] Bot exited cleanly, restarting...");
      crashCount = 0; // Reset crash count on clean exit
      setTimeout(start, 500);
    } else {
      crashCount++;
      if (crashCount >= MAX_CRASHES) {
        console.error(`[wrapper] Bot crashed ${MAX_CRASHES} times in a row. Stopping to prevent infinite loop.`);
        console.error("[wrapper] Fix the errors and restart manually with: npm start");
        process.exit(1);
      }
      console.log(`[wrapper] Bot crashed (code ${code}), restarting in 3s... (${crashCount}/${MAX_CRASHES})`);
      setTimeout(start, 3000);
    }
  });
}

process.on("SIGINT", () => {
  console.log("[wrapper] Shutting down...");
  child?.kill();
  process.exit(0);
});

start();
