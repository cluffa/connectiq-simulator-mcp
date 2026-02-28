/**
 * Connect IQ Simulator interaction via PowerShell + Win32 APIs.
 * Each operation spawns a short-lived PowerShell process – no native modules needed.
 */

import { exec } from "child_process";
import { promisify } from "util";
import { tmpdir } from "os";
import { join } from "path";
import { readFile, writeFile, unlink, readdir, stat } from "fs/promises";
import { randomUUID } from "crypto";
import { existsSync } from "fs";

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WindowInfo {
  handle: string;
  title: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export type SimKey = "up" | "down" | "enter" | "esc" | "menu" | "back";

const KEY_MAP: Record<SimKey, string> = {
  up: "{UP}",
  down: "{DOWN}",
  enter: "{ENTER}",
  esc: "{ESCAPE}",
  menu: "{F3}",
  back: "{ESCAPE}",
};

export const VALID_KEYS = Object.keys(KEY_MAP) as SimKey[];

// ---------------------------------------------------------------------------
// PowerShell runner
// ---------------------------------------------------------------------------

async function runPs(script: string): Promise<string> {
  const tmp = join(tmpdir(), `ciq_mcp_${randomUUID().slice(0, 8)}.ps1`);
  await writeFile(tmp, script, "utf-8");
  try {
    const { stdout } = await execAsync(
      `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -STA -File "${tmp}"`,
      { maxBuffer: 50 * 1024 * 1024, timeout: 30000 },
    );
    return stdout.trim();
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Cached window handle
// ---------------------------------------------------------------------------

let cached: WindowInfo | null = null;

async function ensureHandle(): Promise<WindowInfo> {
  if (cached) return cached;
  const info = await findSimulator();
  if (!info) throw new Error("Simulator window not found. Is the CIQ Simulator running?");
  return info;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function findSimulator(): Promise<WindowInfo | null> {
  const script = [
    'Add-Type @"',
    "using System;",
    "using System.Runtime.InteropServices;",
    "public class W {",
    '    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
    "    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }",
    "}",
    '"@',
    "",
    '$procs = Get-Process -Name "simulator" -ErrorAction SilentlyContinue',
    "if (-not $procs) { Write-Output \"null\"; exit }",
    "$found = $false",
    "foreach ($p in $procs) {",
    "    if ($p.MainWindowHandle -ne [IntPtr]::Zero) {",
    "        $h = $p.MainWindowHandle",
    "        $rect = New-Object W+RECT",
    "        [W]::GetWindowRect($h, [ref]$rect) | Out-Null",
    "        $info = @{",
    '            handle = $h.ToInt64().ToString()',
    "            title = $p.MainWindowTitle",
    "            left = $rect.Left",
    "            top = $rect.Top",
    "            right = $rect.Right",
    "            bottom = $rect.Bottom",
    "            width = $rect.Right - $rect.Left",
    "            height = $rect.Bottom - $rect.Top",
    "        }",
    "        ConvertTo-Json $info -Compress",
    "        $found = $true",
    "        break",
    "    }",
    "}",
    'if (-not $found) { Write-Output "null" }',
  ].join("\r\n");

  const output = await runPs(script);
  if (!output || output === "null") {
    cached = null;
    return null;
  }
  cached = JSON.parse(output) as WindowInfo;
  return cached;
}

export async function sendKey(key: SimKey): Promise<string> {
  const mapped = KEY_MAP[key];
  if (!mapped) throw new Error(`Unknown key: ${key}. Valid: ${VALID_KEYS.join(", ")}`);
  const info = await ensureHandle();

  const script = [
    'Add-Type @"',
    "using System;",
    "using System.Runtime.InteropServices;",
    "public class W {",
    '    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
    "}",
    '"@',
    "Add-Type -AssemblyName System.Windows.Forms",
    `[W]::SetForegroundWindow([IntPtr]::new([long]${info.handle})) | Out-Null`,
    "Start-Sleep -Milliseconds 200",
    `[System.Windows.Forms.SendKeys]::SendWait("${mapped}")`,
    "Start-Sleep -Milliseconds 300",
    `Write-Output "sent ${key} (${mapped})"`,
  ].join("\r\n");

  return await runPs(script);
}

export async function sendKeySequence(
  keys: Array<{ key: SimKey; delay?: number }>,
): Promise<string> {
  const info = await ensureHandle();
  const steps = keys.map((k) => {
    const mapped = KEY_MAP[k.key];
    if (!mapped) throw new Error(`Unknown key: ${k.key}`);
    const delay = k.delay ?? 500;
    return [
      `[System.Windows.Forms.SendKeys]::SendWait("${mapped}")`,
      `Start-Sleep -Milliseconds ${delay}`,
      `Write-Output "  sent ${k.key}"`,
    ].join("\r\n");
  });

  const script = [
    'Add-Type @"',
    "using System;",
    "using System.Runtime.InteropServices;",
    "public class W {",
    '    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
    "}",
    '"@',
    "Add-Type -AssemblyName System.Windows.Forms",
    `[W]::SetForegroundWindow([IntPtr]::new([long]${info.handle})) | Out-Null`,
    "Start-Sleep -Milliseconds 200",
    ...steps,
    'Write-Output "sequence complete"',
  ].join("\r\n");

  return await runPs(script);
}

export async function screenshot(): Promise<Buffer> {
  const info = await ensureHandle();
  const outFile = join(tmpdir(), `ciq_screenshot_${randomUUID().slice(0, 8)}.png`);
  const outFileEscaped = outFile.replace(/\\/g, "\\\\");

  const script = [
    'Add-Type @"',
    "using System;",
    "using System.Runtime.InteropServices;",
    "public class W {",
    '    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
    "    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }",
    "}",
    '"@',
    "Add-Type -AssemblyName System.Drawing",
    `$hwnd = [IntPtr]::new([long]${info.handle})`,
    "$rect = New-Object W+RECT",
    "[W]::GetWindowRect($hwnd, [ref]$rect) | Out-Null",
    "$w = $rect.Right - $rect.Left",
    "$h = $rect.Bottom - $rect.Top",
    "$bmp = New-Object System.Drawing.Bitmap($w, $h)",
    "$gfx = [System.Drawing.Graphics]::FromImage($bmp)",
    "$gfx.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size($w, $h)))",
    "$gfx.Dispose()",
    `$bmp.Save("${outFileEscaped}")`,
    "$bmp.Dispose()",
    'Write-Output "ok"',
  ].join("\r\n");

  await runPs(script);
  const buffer = await readFile(outFile);
  await unlink(outFile).catch(() => {});
  return buffer;
}

// ---------------------------------------------------------------------------
// SDK path auto-detection
// ---------------------------------------------------------------------------

export async function findSdkPath(): Promise<string | null> {
  const appData = process.env.APPDATA;
  if (!appData) return null;
  const sdkBase = join(appData, "Garmin", "ConnectIQ", "Sdks");
  if (!existsSync(sdkBase)) return null;

  const entries = await readdir(sdkBase);
  const sdkDirs = entries
    .filter((e) => e.startsWith("connectiq-sdk-"))
    .sort()
    .reverse();

  for (const dir of sdkDirs) {
    const binDir = join(sdkBase, dir, "bin");
    if (existsSync(binDir)) return binDir;
  }
  return null;
}

export async function findJavaPath(): Promise<string | null> {
  // Check JAVA_HOME
  if (process.env.JAVA_HOME) {
    const javaExe = join(process.env.JAVA_HOME, "bin", "java.exe");
    if (existsSync(javaExe)) return javaExe;
  }

  // Check common install paths
  const bases = [
    "C:\\Program Files\\Eclipse Adoptium",
    "C:\\Program Files\\Java",
    "C:\\Program Files\\OpenJDK",
  ];
  for (const base of bases) {
    if (!existsSync(base)) continue;
    const entries = await readdir(base);
    for (const dir of entries.sort().reverse()) {
      const javaExe = join(base, dir, "bin", "java.exe");
      if (existsSync(javaExe)) return javaExe;
    }
  }
  return null;
}

export async function launchSimulator(sdkPath?: string): Promise<string> {
  const sdk = sdkPath ?? (await findSdkPath());
  if (!sdk) throw new Error("SDK path not found. Pass sdk_path or install the Connect IQ SDK.");
  const simExe = join(sdk, "simulator.exe");
  if (!existsSync(simExe)) throw new Error(`simulator.exe not found at ${simExe}`);

  // Launch and don't wait
  exec(`start "" "${simExe}"`, { shell: "cmd.exe" });

  // Wait for window to appear
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const info = await findSimulator();
    if (info) return `Simulator launched: ${info.title} (${info.width}x${info.height})`;
  }
  return "Simulator process started but window not detected yet. Try find_simulator in a few seconds.";
}

export async function buildApp(opts: {
  projectPath: string;
  device?: string;
  sdkPath?: string;
}): Promise<string> {
  const sdk = opts.sdkPath ?? (await findSdkPath());
  if (!sdk) throw new Error("SDK path not found. Pass sdk_path or install the Connect IQ SDK.");

  const java = await findJavaPath();
  if (!java) throw new Error("Java not found. Install JDK and set JAVA_HOME.");

  const device = opts.device ?? "fenix7";
  const monkeyc = join(sdk, "monkeyc.bat");
  const jungleFile = join(opts.projectPath, "monkey.jungle");
  const devKey = join(opts.projectPath, "developer_key.der");

  if (!existsSync(jungleFile)) throw new Error(`monkey.jungle not found at ${jungleFile}`);

  const outDir = join(opts.projectPath, "build");
  if (!existsSync(outDir)) {
    await writeFile(join(outDir, ".gitkeep"), "");
  }

  const javaDir = join(java, "..");
  const cmd = `cmd.exe /C "set PATH=${javaDir};%PATH% && "${monkeyc}" -f "${jungleFile}" -d ${device} -o "${join(outDir, "app.prg")}" -y "${devKey}" -w"`;

  const { stdout, stderr } = await execAsync(cmd, {
    timeout: 120000,
    maxBuffer: 10 * 1024 * 1024,
  });

  return (stdout + "\n" + stderr).trim() || "Build completed successfully.";
}

export async function pushApp(opts: {
  prgPath: string;
  device?: string;
  sdkPath?: string;
}): Promise<string> {
  const sdk = opts.sdkPath ?? (await findSdkPath());
  if (!sdk) throw new Error("SDK path not found.");

  const java = await findJavaPath();
  if (!java) throw new Error("Java not found.");

  const device = opts.device ?? "fenix7";
  const monkeydo = join(sdk, "monkeydo.bat");

  if (!existsSync(opts.prgPath)) throw new Error(`PRG file not found: ${opts.prgPath}`);

  const javaDir = join(java, "..");
  const cmd = `cmd.exe /C "set PATH=${javaDir};%PATH% && "${monkeydo}" "${opts.prgPath}" ${device}"`;

  const { stdout, stderr } = await execAsync(cmd, {
    timeout: 60000,
    maxBuffer: 10 * 1024 * 1024,
  });

  return (stdout + "\n" + stderr).trim() || "App pushed to simulator.";
}

// ---------------------------------------------------------------------------
// Test sequence – interleaved keys + screenshots in a single PS process
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

export async function testSequence(
  steps: TestStep[],
  outputDir?: string,
): Promise<TestResult> {
  const info = await ensureHandle();
  const runId = randomUUID().slice(0, 8);
  const frameDir = outputDir ?? join(tmpdir(), `ciq_test_${runId}`);
  const frameDirEscaped = frameDir.replace(/\\/g, "\\\\");

  // Build the PS script
  const lines: string[] = [
    // --- Win32 types ---
    'Add-Type @"',
    "using System;",
    "using System.Runtime.InteropServices;",
    "public class W {",
    '    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
    '    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
    "    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }",
    "}",
    '"@',
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "",
    `$outDir = "${frameDirEscaped}"`,
    "if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }",
    "",
    `$hwnd = [IntPtr]::new([long]${info.handle})`,
    "[W]::SetForegroundWindow($hwnd) | Out-Null",
    "Start-Sleep -Milliseconds 300",
    "",
    "# --- helper: capture screenshot ---",
    "function Snap($name) {",
    "    Start-Sleep -Milliseconds 400",
    "    $rect = New-Object W+RECT",
    "    [W]::GetWindowRect($hwnd, [ref]$rect) | Out-Null",
    "    $w = $rect.Right - $rect.Left",
    "    $h = $rect.Bottom - $rect.Top",
    "    $bmp = New-Object System.Drawing.Bitmap($w, $h)",
    "    $gfx = [System.Drawing.Graphics]::FromImage($bmp)",
    "    $gfx.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size($w, $h)))",
    "    $gfx.Dispose()",
    '    $file = Join-Path $outDir "$name.png"',
    "    $bmp.Save($file)",
    "    $bmp.Dispose()",
    '    Write-Output "FRAME:$name"',
    "}",
    "",
    'Write-Output "=== Test sequence start ==="',
    "",
  ];

  let frameIndex = 0;
  for (const step of steps) {
    if (step.action === "screenshot") {
      const safeName = `${String(frameIndex).padStart(2, "0")}_${step.label.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
      lines.push(`Snap "${safeName}"`);
      frameIndex++;
    } else if (step.action === "key") {
      const mapped = KEY_MAP[step.key];
      if (!mapped) throw new Error(`Unknown key: ${step.key}`);
      const delay = step.delay ?? 500;
      lines.push(`Write-Output "KEY:${step.key}"`);
      lines.push(`[System.Windows.Forms.SendKeys]::SendWait("${mapped}")`);
      lines.push(`Start-Sleep -Milliseconds ${delay}`);
    } else if (step.action === "wait") {
      lines.push(`Start-Sleep -Milliseconds ${step.ms}`);
    }
  }

  lines.push('', 'Write-Output "=== Test sequence done ==="');

  const script = lines.join("\r\n");

  // Increase timeout for long sequences (base 30s + 3s per step)
  const timeout = 30000 + steps.length * 3000;
  const tmp = join(tmpdir(), `ciq_test_${runId}.ps1`);
  await writeFile(tmp, script, "utf-8");

  let stdout: string;
  try {
    const result = await execAsync(
      `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -STA -File "${tmp}"`,
      { maxBuffer: 50 * 1024 * 1024, timeout },
    );
    stdout = result.stdout.trim();
  } finally {
    await unlink(tmp).catch(() => {});
  }

  // Parse output and read frame files
  const log = stdout.split(/\r?\n/).filter(Boolean);
  const frameLabels = log
    .filter((l) => l.startsWith("FRAME:"))
    .map((l) => l.slice(6));

  const frames: TestFrame[] = [];
  for (const label of frameLabels) {
    const filePath = join(frameDir, `${label}.png`);
    try {
      const buffer = await readFile(filePath);
      frames.push({ label, buffer });
      // Clean up temp file (but leave if outputDir was specified)
      if (!outputDir) await unlink(filePath).catch(() => {});
    } catch {
      // Frame file missing – skip
    }
  }

  // Clean up temp dir if we created it
  if (!outputDir) {
    const { rmdir } = await import("fs/promises");
    await rmdir(frameDir).catch(() => {});
  }

  return { log, frames };
}

export function clearCache(): void {
  cached = null;
}
