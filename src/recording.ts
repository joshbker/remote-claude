import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { getScreens, getWindows, ScreenInfo, WindowInfo } from "./screenshot";

interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Focus a window and return its screen bounds */
async function focusAndGetBounds(windowTitle: string): Promise<WindowBounds> {
  const escapedTitle = windowTitle.replace(/'/g, "''");
  const psScript = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WinHelper {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
}
"@ -ErrorAction SilentlyContinue
$proc = Get-Process | Where-Object { $_.MainWindowTitle -eq '${escapedTitle}' } | Select-Object -First 1
if (-not $proc) {
    $proc = Get-Process | Where-Object { $_.MainWindowTitle -like '*${escapedTitle}*' } | Select-Object -First 1
}
if (-not $proc) { throw "Window not found: ${escapedTitle}" }
$hwnd = $proc.MainWindowHandle
if ([WinHelper]::IsIconic($hwnd)) {
    [void][WinHelper]::ShowWindow($hwnd, 9)
}
[void][WinHelper]::SetForegroundWindow($hwnd)
$rect = New-Object WinHelper+RECT
[void][WinHelper]::GetWindowRect($hwnd, [ref]$rect)
@{ x=$rect.Left; y=$rect.Top; width=$rect.Right-$rect.Left; height=$rect.Bottom-$rect.Top } | ConvertTo-Json -Compress
`;
  return new Promise((resolve, reject) => {
    const proc = spawn("powershell", ["-ExecutionPolicy", "Bypass", "-Command", psScript], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(stderr || "Failed to focus window"));
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error("Failed to parse window bounds"));
      }
    });
    proc.on("error", reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface RecordingOptions {
  duration?: number; // seconds (default 5, max 15)
  monitor?: "primary" | "all" | number;
  windowTitle?: string; // window title for gdigrab
  format?: "gif" | "mp4"; // default gif
  fps?: number; // default 15
  scale?: number; // max width, default 640 for gif, 1280 for mp4
}

export async function recordScreen(options: RecordingOptions = {}): Promise<string> {
  const {
    duration = 5,
    format = "gif",
    fps = 15,
    monitor = "primary",
    windowTitle,
  } = options;

  const scale = options.scale || (format === "gif" ? 640 : 1280);
  const clampedDuration = Math.min(Math.max(duration, 1), 15);

  const tempDir = path.join(process.cwd(), ".temp-attachments");
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const timestamp = Date.now();
  const outputFile = path.join(tempDir, `recording-${timestamp}.${format}`);

  if (format === "gif") {
    // Two-pass GIF for good quality: capture mp4 first, then convert with palette
    const tempMp4 = path.join(tempDir, `recording-${timestamp}-temp.mp4`);
    const tempPalette = path.join(tempDir, `recording-${timestamp}-palette.png`);

    try {
      // Step 1: Capture to mp4
      await captureWithFfmpeg(tempMp4, {
        duration: clampedDuration,
        fps,
        monitor,
        windowTitle,
      });

      // Step 2: Generate palette
      await runFfmpeg([
        "-i", tempMp4,
        "-vf", `fps=${fps},scale=${scale}:-1:flags=lanczos,palettegen=stats_mode=diff`,
        "-y", tempPalette,
      ]);

      // Step 3: Convert to GIF using palette
      await runFfmpeg([
        "-i", tempMp4,
        "-i", tempPalette,
        "-lavfi", `fps=${fps},scale=${scale}:-1:flags=lanczos [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5`,
        "-y", outputFile,
      ]);

      return outputFile;
    } finally {
      // Clean up temp files
      if (fs.existsSync(tempMp4)) fs.unlinkSync(tempMp4);
      if (fs.existsSync(tempPalette)) fs.unlinkSync(tempPalette);
    }
  } else {
    // Direct mp4 capture
    await captureWithFfmpeg(outputFile, {
      duration: clampedDuration,
      fps: Math.min(fps, 30),
      monitor,
      windowTitle,
      extraArgs: ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "23"],
    });
    return outputFile;
  }
}

interface CaptureOptions {
  duration: number;
  fps: number;
  monitor: "primary" | "all" | number;
  windowTitle?: string;
  extraArgs?: string[];
}

async function captureWithFfmpeg(outputPath: string, options: CaptureOptions): Promise<void> {
  const { duration, fps, monitor, windowTitle, extraArgs = [] } = options;
  const args: string[] = [];

  if (windowTitle) {
    // Focus window and capture its screen region (avoids overlay issues with gdigrab title=)
    const bounds = await focusAndGetBounds(windowTitle);
    await sleep(300); // let window render on top

    // Ensure even dimensions (ffmpeg requires it for some codecs)
    const w = bounds.width % 2 === 0 ? bounds.width : bounds.width - 1;
    const h = bounds.height % 2 === 0 ? bounds.height : bounds.height - 1;

    args.push(
      "-f", "gdigrab",
      "-framerate", fps.toString(),
      "-offset_x", bounds.x.toString(),
      "-offset_y", bounds.y.toString(),
      "-video_size", `${w}x${h}`,
      "-t", duration.toString(),
      "-i", "desktop",
    );
  } else {
    // Screen capture - need to determine bounds for specific monitors
    const screens = await getScreens();
    let offsetX = 0;
    let offsetY = 0;
    let width = 0;
    let height = 0;

    if (monitor === "all" || monitor === "primary") {
      if (monitor === "primary") {
        const primary = screens.find((s) => s.primary) || screens[0];
        offsetX = primary.x;
        offsetY = primary.y;
        width = primary.width;
        height = primary.height;
      } else {
        // All monitors - get bounding box
        const left = Math.min(...screens.map((s) => s.x));
        const top = Math.min(...screens.map((s) => s.y));
        const right = Math.max(...screens.map((s) => s.x + s.width));
        const bottom = Math.max(...screens.map((s) => s.y + s.height));
        offsetX = left;
        offsetY = top;
        width = right - left;
        height = bottom - top;
      }
    } else {
      // Specific monitor index
      const screen = screens[monitor as number];
      if (!screen) throw new Error(`Monitor ${monitor} not found`);
      offsetX = screen.x;
      offsetY = screen.y;
      width = screen.width;
      height = screen.height;
    }

    args.push(
      "-f", "gdigrab",
      "-framerate", fps.toString(),
      "-offset_x", offsetX.toString(),
      "-offset_y", offsetY.toString(),
      "-video_size", `${width}x${height}`,
      "-t", duration.toString(),
      "-i", "desktop",
    );
  }

  args.push(...extraArgs, "-y", outputPath);

  await runFfmpeg(args);
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });

    let stderr = "";
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`));
      }
    });

    proc.on("error", (err) => {
      if ((err as any).code === "ENOENT") {
        reject(new Error("ffmpeg not found. Install it or add it to PATH."));
      } else {
        reject(err);
      }
    });
  });
}

// Parse a target string (same logic as screenshot) and return RecordingOptions
export async function parseRecordTarget(target: string | null): Promise<Partial<RecordingOptions>> {
  if (!target) return { monitor: "primary" };

  const lower = target.toLowerCase();

  if (lower === "all") return { monitor: "all" };
  if (lower === "primary") return { monitor: "primary" };

  // Monitor number
  const monMatch = target.match(/(\d+)/);
  if (/^monitor\s*\d+$|^\d+$/.test(lower) && monMatch) {
    return { monitor: parseInt(monMatch[1]) };
  }

  // Window match — check both directions (target in title, and title in target)
  const windows = await getWindows();
  const match = windows.find(
    (w) =>
      w.processName.toLowerCase().includes(lower) ||
      w.title.toLowerCase().includes(lower) ||
      lower.includes(w.processName.toLowerCase()) ||
      lower.includes(w.title.toLowerCase())
  );

  if (match) {
    return { windowTitle: match.title };
  }

  return { monitor: "primary" };
}
