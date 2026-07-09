/**
 * Connect IQ Simulator interaction via osascript + screencapture.
 * Each operation spawns a short-lived osascript process – no native modules needed.
 *
 * Ported from the original Windows/PowerShell implementation by thomaszipf.
 */

import { exec, execFile } from "child_process";
import { execSync } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
import { tmpdir, homedir } from "os";
import { join } from "path";
import { readFile, writeFile, unlink, readdir, mkdir, rm } from "fs/promises";
import { existsSync } from "fs";
import { randomUUID } from "crypto";

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WindowInfo {
  handle: string;   // process PID string
  title: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export type SimKey = "up" | "down" | "enter" | "esc" | "menu" | "back";

/** AppleScript key codes / keystroke names */
const KEY_MAP: Record<SimKey, string> = {
  up:    "key code 126",
  down:  "key code 125",
  enter: "keystroke return",
  esc:   "key code 53",
  menu:  "key code 99",   /* F3 */
  back:  "key code 53",   /* ESC (same as back on Garmin) */
};

export const VALID_KEYS = Object.keys(KEY_MAP) as SimKey[];

// ---------------------------------------------------------------------------
// osascript runner
// ---------------------------------------------------------------------------

/**
 * Run an AppleScript snippet and return its stdout.
 * The script receives a prelude that quits on error.
 */
async function runApplescript(script: string): Promise<string> {
  const wrapped = `
try
${script.split("\n").map(l => "    " + l).join("\n")}
on error errMsg
    return "ERROR: " & errMsg
end try`;
  const tmp = join(tmpdir(), `ciq_mcp_${randomUUID().slice(0, 8)}.applescript`);
  await writeFile(tmp, wrapped, "utf-8");
  try {
    const { stdout } = await execAsync(
      `osascript "${tmp}"`,
      { maxBuffer: 10 * 1024 * 1024, timeout: 15000 },
    );
    const out = stdout.trim();
    if (out.startsWith("ERROR:")) {
      throw new Error(out.slice(6).trim());
    }
    return out;
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

/**
 * Run a JXA (JavaScript for Automation) snippet.
 * JXA gives us access to Objective-C bridges for CGWindow-level APIs.
 */
async function runJXA(script: string): Promise<string> {
  const tmp = join(tmpdir(), `ciq_mcp_${randomUUID().slice(0, 8)}.jxa`);
  // Wrap in a try-catch
  const wrapped = `ObjC.import('stdlib');\n(function(){\ntry{${script}\n}catch(e){return "ERROR: "+e.message;}})();`;
  await writeFile(tmp, wrapped, "utf-8");
  try {
    const { stdout } = await execAsync(
      `osascript -l JavaScript "${tmp}"`,
      { maxBuffer: 10 * 1024 * 1024, timeout: 15000 },
    );
    const out = stdout.trim();
    if (out.startsWith("ERROR:")) {
      throw new Error(out.slice(6).trim());
    }
    return out;
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Cached window info
// ---------------------------------------------------------------------------

let cached: WindowInfo | null = null;

async function ensureHandle(): Promise<WindowInfo> {
  if (cached) return cached;
  const info = await findSimulator();
  if (!info) throw new Error("Simulator window not found. Is the CIQ Simulator running?");
  return info;
}

/** Re-discover the handle if a call fails (simulator may have restarted). */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    cached = null;
    await findSimulator();
    return await fn();
  }
}

// ---------------------------------------------------------------------------
// Window detection
// ---------------------------------------------------------------------------

/** Find the running simulator process and return its window bounds. */
export async function findSimulator(): Promise<WindowInfo | null> {
  const script = `
tell application "System Events"
    set simProcs to every process whose name is "simulator"
    if (count of simProcs) is 0 then return "null"
    set simProc to item 1 of simProcs
    try
        set win1 to window 1 of simProc
        set winPos to position of win1
        set winSize to size of win1
        set x to item 1 of winPos
        set y to item 1 of winSize
        set w to item 2 of winSize
        return (unix id of simProc as string) & "|" & ¬
               (name of win1 as string) & "|" & ¬
               (item 1 of winPos as string) & "|" & ¬
               (item 2 of winPos as string) & "|" & ¬
               (item 1 of winSize as string) & "|" & ¬
               (item 2 of winSize as string)
    on error
        return "null"
    end try
end tell`;

  const output = await runApplescript(script);
  if (!output || output === "null") {
    cached = null;
    return null;
  }
  const parts = output.split("|");
  if (parts.length !== 6) return null;

  const left   = parseInt(parts[2], 10);
  const top    = parseInt(parts[3], 10);
  const width  = parseInt(parts[4], 10);
  const height = parseInt(parts[5], 10);

  cached = {
    handle: parts[0],          // PID
    title:  parts[1],
    left,
    top,
    right:  left + width,
    bottom: top + height,
    width,
    height,
  };
  return cached;
}

// ---------------------------------------------------------------------------
// Key sending
// ---------------------------------------------------------------------------

/** Send a single key press to the simulator. */
export async function sendKey(key: SimKey): Promise<string> {
  const mapped = KEY_MAP[key];
  if (!mapped) throw new Error(`Unknown key: ${key}. Valid: ${VALID_KEYS.join(", ")}`);

  return withRetry(async () => {
    await ensureHandle(); // verify window exists
    const script = `
tell application "System Events"
    tell process "simulator"
        set frontmost to true
        delay 0.3
        ${mapped}
        delay 0.3
    end tell
end tell
return "sent ${key}"`;

    return await runApplescript(script);
  });
}

/** Send a sequence of keys with configurable delays. */
export async function sendKeySequence(
  keys: Array<{ key: SimKey; delay?: number }>,
): Promise<string> {
  return withRetry(async () => {
    await ensureHandle();
    const steps = keys.map((k) => {
      const mapped = KEY_MAP[k.key];
      if (!mapped) throw new Error(`Unknown key: ${k.key}`);
      const delay = k.delay ?? 500;
      // Convert ms to seconds for AppleScript 'delay'
      const delaySec = (delay / 1000).toFixed(2);
      return `\n        ${mapped}\n        delay ${delaySec}`;
    });

    const script = `tell application "System Events"\n    tell process "simulator"\n        set frontmost to true\n        delay 0.3${steps.join("")}\n    end tell\nend tell\nreturn "sequence complete"`;

    return await runApplescript(script);
  });
}

// ---------------------------------------------------------------------------
// Screenshot
// ---------------------------------------------------------------------------

/** Capture the simulator window as a PNG. Uses screencapture with window coords. */
export async function screenshot(): Promise<Buffer> {
  return withRetry(async () => {
    const info = await ensureHandle();
    const outFile = join(tmpdir(), `ciq_screenshot_${randomUUID().slice(0, 8)}.png`);

    // Use screencapture with -R (rectangle in points) which is simpler
    // and doesn't require matching CGWindowID
    const rect = `${info.left},${info.top},${info.width},${info.height}`;
    try {
      execSync(`screencapture -R ${rect} -o -x "${outFile}"`, {
        timeout: 10000,
        stdio: "pipe",
      });
    } catch (e: any) {
      throw new Error(`screencapture failed: ${e.message}`);
    }

    const buffer = await readFile(outFile);
    await unlink(outFile).catch(() => {});
    return buffer;
  });
}

// ---------------------------------------------------------------------------
// Test sequence – interleaved keys + screenshots
// ---------------------------------------------------------------------------

export type TestStep =
  | { action: "screenshot"; label: string }
  | { action: "key"; key: SimKey; delay?: number }
  | { action: "wait"; ms: number };

export interface TestFrame {
  label: string;
  buffer: Buffer;
}

export interface TestResult {
  log: string[];
  frames: TestFrame[];
}

let _seqIdx = 0;

export async function testSequence(
  steps: TestStep[],
  outputDir?: string,
): Promise<TestResult> {
  const info = await ensureHandle();
  const runId = randomUUID().slice(0, 8);
  const frameDir = outputDir ?? join(tmpdir(), `ciq_test_${runId}`);
  if (!existsSync(frameDir)) {
    await mkdir(frameDir, { recursive: true });
  }

  const log: string[] = [];
  const frames: TestFrame[] = [];

  // Bring simulator to front
  await runApplescript(`
tell application "System Events"
    tell process "simulator"
        set frontmost to true
        delay 0.3
    end tell
end tell`);

  for (const step of steps) {
    if (step.action === "screenshot") {
      const idx = String(_seqIdx++).padStart(3, "0");
      const safeName = `${idx}_${step.label.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
      const outFile = join(frameDir, `${safeName}.png`);
      const rect = `${info.left},${info.top},${info.width},${info.height}`;
      try {
        execSync(`screencapture -R ${rect} -o -x "${outFile}"`, {
          timeout: 5000,
          stdio: "pipe",
        });
        const buffer = await readFile(outFile);
        frames.push({ label: safeName, buffer });
        log.push(`FRAME:${safeName}`);
        if (!outputDir) await unlink(outFile).catch(() => {});
      } catch (e: any) {
        log.push(`FRAME_ERROR:${safeName}`);
      }
    } else if (step.action === "key") {
      const mapped = KEY_MAP[step.key];
      if (!mapped) throw new Error(`Unknown key: ${step.key}`);
      const delay = step.delay ?? 500;
      const delaySec = (delay / 1000).toFixed(2);
      await runApplescript(`
tell application "System Events"
    tell process "simulator"
        set frontmost to true
        delay 0.1
        ${mapped}
        delay ${delaySec}
    end tell
end tell`);
      log.push(`KEY:${step.key}`);
    } else if (step.action === "wait") {
      const delaySec = (step.ms / 1000).toFixed(2);
      await runApplescript(`delay ${delaySec}`);
      log.push(`WAIT:${step.ms}ms`);
    }
  }

  // Clean up temp dir if we created it
  if (!outputDir) {
    await rm(frameDir, { recursive: true, force: true }).catch(() => {});
  }

  return { log, frames };
}

// ---------------------------------------------------------------------------
// SDK path auto-detection
// ---------------------------------------------------------------------------

/** Find the Connect IQ SDK bin directory on macOS. */
export async function findSdkPath(): Promise<string | null> {
  const sdkBase = join(homedir(), "Library", "Application Support", "Garmin", "ConnectIQ", "Sdks");
  if (!existsSync(sdkBase)) {
    return null;
  }

  try {
    const entries = await readdir(sdkBase);
    const sdkDirs = entries
      .filter((e) => e.startsWith("connectiq-sdk-"))
      .sort()
      .reverse();

    for (const dir of sdkDirs) {
      const binDir = join(sdkBase, dir, "bin");
      if (existsSync(binDir)) return binDir;
    }
  } catch {
    // ignore readdir errors
  }
  return null;
}

/** Find a Java installation. */
export async function findJavaPath(): Promise<string | null> {
  // Use macOS java_home utility
  try {
    const result = execSync("/usr/libexec/java_home", { encoding: "utf-8" }).trim();
    if (result) {
      const javaExe = join(result, "bin", "java");
      if (existsSync(javaExe)) return javaExe;
    }
  } catch {
    // java_home not found
  }

  // Fallback: JAVA_HOME env
  if (process.env.JAVA_HOME) {
    const javaExe = join(process.env.JAVA_HOME, "bin", "java");
    if (existsSync(javaExe)) return javaExe;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Simulator process management
// ---------------------------------------------------------------------------

/** Find the simulator binary path. Checks both SDK install and .Garmin runtime. */
async function findSimulatorBinary(sdkPath?: string): Promise<string> {
  const sdk = sdkPath ?? (await findSdkPath());
  if (!sdk) throw new Error("SDK path not found.");

  const simBinary = join(sdk, "ConnectIQ.app", "Contents", "MacOS", "simulator");
  if (existsSync(simBinary)) return simBinary;

  // Also check .Garmin runtime mirror
  const altSdk = sdk.replace(
    join(homedir(), "Library", "Application Support"),
    join(homedir(), ".Garmin"),
  );
  const altBinary = join(altSdk, "ConnectIQ.app", "Contents", "MacOS", "simulator");
  if (existsSync(altBinary)) return altBinary;

  throw new Error(`simulator binary not found at ${simBinary}`);
}

/** Kill the simulator process by name. */
function killSimulator(): void {
  try {
    execSync('pkill -f "Contents/MacOS/simulator"', { stdio: "ignore" });
  } catch {
    // process may not exist
  }
  cached = null;
}

/** Launch the CIQ Simulator via the SDK Manager GUI.
 *  Opens ConnectIQ.app, auto-launches the last-used device (Enter keypress
 *  via AppleScript), and waits for the simulator window to appear.
 *  If already running, kills and restarts it fresh when restart=true. */
export async function launchSimulator(sdkPath?: string, restart = false): Promise<string> {
  if (restart) {
    killSimulator();
    await new Promise((r) => setTimeout(r, 1500));
  }

  // Check if already running with a loaded device
  const existing = await findSimulator();
  if (existing && !restart) {
    return `Simulator already running: ${existing.title} (${existing.width}x${existing.height})`;
  }

  const sdk = sdkPath ?? (await findSdkPath());
  if (!sdk) throw new Error("SDK path not found.");

  const appPath = join(sdk, "ConnectIQ.app");
  if (!existsSync(appPath)) {
    throw new Error(`ConnectIQ.app not found at ${appPath}`);
  }

  // Open the SDK Manager
  execFile("open", [appPath], (err) => {
    if (err) throw err;
  });

  // Wait for SDK Manager window, then press Enter to launch last-used device.
  // The SDK Manager remembers LastUsedDevice from simulator.ini.
  await new Promise((r) => setTimeout(r, 4000));
  try {
    await runApplescript(`
tell application "System Events"
    tell process "simulator"
        set frontmost to true
        delay 0.5
        keystroke return
    end tell
end tell`);
  } catch {
    // If AppleScript fails, the simulator might have auto-launched already
  }

  // Wait for simulator window to appear
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const info = await findSimulator();
    if (info) return `Simulator launched: ${info.title} (${info.width}x${info.height})`;
  }
  return "ConnectIQ.app opened but simulator window not detected. The device may need to be launched manually from the SDK Manager.";
}

// ---------------------------------------------------------------------------
// Build app
// ---------------------------------------------------------------------------

/** Build a Connect IQ project using monkeyc. */
export async function buildApp(opts: {
  projectPath: string;
  device?: string;
  sdkPath?: string;
}): Promise<string> {
  const sdk = opts.sdkPath ?? (await findSdkPath());
  if (!sdk) throw new Error("SDK path not found. Pass sdk_path or install the Connect IQ SDK.");

  const device = opts.device ?? "fenix7";
  const monkeyc = join(sdk, "monkeyc");
  const monkeyJungle = join(opts.projectPath, "monkey.jungle");

  if (!existsSync(monkeyJungle)) throw new Error(`monkey.jungle not found at ${monkeyJungle}`);

  const outDir = join(opts.projectPath, "build");
  if (!existsSync(outDir)) {
    await mkdir(outDir, { recursive: true });
  }

  const outFile = join(outDir, "app.prg");

  // Try to find developer key in common locations
  const devKey = join(opts.projectPath, "developer_key.der");
  let keyPath = "";
  if (existsSync(devKey)) {
    keyPath = devKey;
  } else {
    const homeKey = join(homedir(), "Documents", "garmin_developer_key.der");
    if (existsSync(homeKey)) {
      keyPath = homeKey;
    }
  }

  // Build args to execFile (no shell, no quoting issues with spaces in paths)
  const args = keyPath
    ? ["-f", monkeyJungle, "-y", keyPath, "-d", device, "-w", "-o", outFile]
    : ["-f", monkeyJungle, "-d", device, "-w", "-o", outFile];

  try {
    const { stdout, stderr } = await execFileAsync(monkeyc, args, {
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const output = (stdout + "\n" + stderr).trim();
    if (!output || output.includes("BUILD SUCCESSFUL")) {
      return `Build successful: ${outFile}`;
    }
    return output;
  } catch (e: any) {
    return `Build failed: ${e.stdout || e.stderr || e.message}`;
  }
}

// ---------------------------------------------------------------------------
// Push app to simulator
// ---------------------------------------------------------------------------

/** Push a compiled .prg to the running simulator using monkeydo.
 *  Calls Java directly (bypassing the monkeydo shell script) to avoid
 *  path-quoting issues with execFile/exec on paths containing spaces.
 *  If monkeydo fails with "Too Many Profiles" (BLE profile exhaustion from
 *  repeated pushes), kills and restarts the simulator automatically, then
 *  retries once. */
export async function pushApp(opts: {
  prgPath: string;
  device?: string;
  sdkPath?: string;
}): Promise<string> {
  const sdk = opts.sdkPath ?? (await findSdkPath());
  if (!sdk) throw new Error("SDK path not found.");

  const device = opts.device ?? "fenix7";
  const monkeybrainsJar = join(sdk, "monkeybrains.jar");
  const shellScript = join(sdk, "shell");
  const javaPath = await findJavaPath();

  if (!javaPath) throw new Error("Java not found.");
  if (!existsSync(monkeybrainsJar)) throw new Error(`monkeybrains.jar not found at ${monkeybrainsJar}`);
  if (!existsSync(opts.prgPath)) throw new Error(`PRG file not found: ${opts.prgPath}`);

  const java = javaPath; // narrowed for closure capture

  async function runMonkeydo(): Promise<string> {
    const { stdout, stderr } = await execFileAsync(java, [
      "-classpath", monkeybrainsJar,
      "com.garmin.monkeybrains.monkeydodeux.MonkeyDoDeux",
      "-f", opts.prgPath,
      "-d", device,
      "-s", shellScript,
    ], {
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return (stdout + "\n" + stderr).trim();
  }

  try {
    const output = await runMonkeydo();
    return output || "App pushed to simulator.";
  } catch (e: any) {
    const output = e.stdout || e.stderr || e.message || "";

    // "Too Many Profiles" = BLE profile exhaustion from repeated pushes.
    // Restart the simulator and retry once.
    if (output.includes("Too Many Profiles")) {
      // Kill and relaunch with fresh BLE state
      killSimulator();
      await new Promise((r) => setTimeout(r, 1500));
      await launchSimulator(sdk);
      await new Promise((r) => setTimeout(r, 2000));

      // Retry
      try {
        const retryOutput = await runMonkeydo();
        return (retryOutput || "App pushed to simulator.") + " (simulator was restarted to clear BLE profiles)";
      } catch (retryErr: any) {
        return `Push failed after restart: ${retryErr.stdout || retryErr.stderr || retryErr.message}`;
      }
    }

    return `Push failed: ${output}`;
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

export function clearCache(): void {
  cached = null;
}
