import { spawn, ChildProcess } from "child_process";

// Simple wrapper that restarts the bot when it exits
let child: ChildProcess | null = null;

function start() {
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
      setTimeout(start, 500);
    } else {
      console.log(`[wrapper] Bot crashed (code ${code}), restarting in 3s...`);
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
