#!/usr/bin/env node

/**
 * MCP server for Garmin Connect IQ Simulator.
 *
 * Tools:
 *   find_simulator   – detect the running simulator window
 *   send_key         – send a single key press (up/down/enter/esc/menu/back)
 *   send_key_sequence– send multiple keys with delays
 *   screenshot       – capture the simulator window as PNG
 *   test_sequence    – interleaved keys + screenshots for visual testing
 *   launch_simulator – start the CIQ simulator
 *   build_app        – compile a Connect IQ project
 *   push_app         – push a .prg to the running simulator
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as sim from "./simulator.js";

const server = new McpServer({
  name: "connectiq-simulator",
  version: "0.1.0",
});

// ── find_simulator ──────────────────────────────────────────────────────────

server.tool(
  "find_simulator",
  "Find the running Connect IQ Simulator window. Returns window handle, title and bounds.",
  {},
  async () => {
    try {
      const info = await sim.findSimulator();
      if (!info) {
        return {
          content: [{ type: "text", text: "Simulator window not found. Is it running?" }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ── send_key ────────────────────────────────────────────────────────────────

server.tool(
  "send_key",
  "Send a single key press to the simulator. Keys: up, down, enter, esc, menu, back.",
  { key: z.enum(["up", "down", "enter", "esc", "menu", "back"]).describe("Key to send") },
  async ({ key }) => {
    try {
      const result = await sim.sendKey(key);
      return { content: [{ type: "text", text: result }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ── send_key_sequence ───────────────────────────────────────────────────────

server.tool(
  "send_key_sequence",
  "Send multiple key presses to the simulator with configurable delays between them.",
  {
    keys: z
      .array(
        z.object({
          key: z.enum(["up", "down", "enter", "esc", "menu", "back"]),
          delay: z.number().optional().describe("Delay in ms after this key (default 500)"),
        }),
      )
      .describe("Sequence of keys to send"),
  },
  async ({ keys }) => {
    try {
      const result = await sim.sendKeySequence(keys);
      return { content: [{ type: "text", text: result }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ── screenshot ──────────────────────────────────────────────────────────────

server.tool(
  "screenshot",
  "Capture a screenshot of the simulator window. Returns a PNG image.",
  {},
  async () => {
    try {
      const buffer = await sim.screenshot();
      return {
        content: [
          {
            type: "image",
            data: buffer.toString("base64"),
            mimeType: "image/png",
          },
        ],
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ── test_sequence ───────────────────────────────────────────────────────────

const stepSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("screenshot"),
    label: z.string().describe("Name for this screenshot (e.g. 'after_enter', 'main_screen')"),
  }),
  z.object({
    action: z.literal("key"),
    key: z.enum(["up", "down", "enter", "esc", "menu", "back"]),
    delay: z.number().optional().describe("Delay in ms after key press (default 500)"),
  }),
  z.object({
    action: z.literal("wait"),
    ms: z.number().describe("Milliseconds to wait"),
  }),
]);

server.tool(
  "test_sequence",
  `Run an interleaved sequence of key presses and screenshots in a single operation.
Each step is either:
  - {"action":"screenshot","label":"name"} – capture the simulator
  - {"action":"key","key":"enter","delay":500} – send a key and wait
  - {"action":"wait","ms":1000} – pause
Returns all captured screenshots as images so you can visually verify each state.`,
  {
    steps: z.array(stepSchema).describe("Ordered list of actions to perform"),
    output_dir: z
      .string()
      .optional()
      .describe("Optional directory to save screenshots (temp dir if omitted)"),
  },
  async ({ steps, output_dir }) => {
    try {
      const result = await sim.testSequence(steps, output_dir);
      const content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [];

      // Build interleaved text + image response
      let logIdx = 0;
      for (const line of result.log) {
        if (line.startsWith("FRAME:")) {
          const label = line.slice(6);
          const frame = result.frames.find((f) => f.label === label);
          content.push({ type: "text", text: `📸 ${label}` });
          if (frame) {
            content.push({
              type: "image",
              data: frame.buffer.toString("base64"),
              mimeType: "image/png",
            });
          }
        } else if (line.startsWith("KEY:")) {
          content.push({ type: "text", text: `⌨️  Sent key: ${line.slice(4)}` });
        }
      }

      if (output_dir) {
        content.push({
          type: "text",
          text: `\nScreenshots saved to: ${output_dir}`,
        });
      }

      content.push({
        type: "text",
        text: `\n✅ Sequence complete: ${result.frames.length} screenshots captured.`,
      });

      return { content: content as any };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ── launch_simulator ────────────────────────────────────────────────────────

server.tool(
  "launch_simulator",
  "Launch the Connect IQ Simulator. Auto-detects SDK path or accepts a custom one.",
  {
    sdk_path: z
      .string()
      .optional()
      .describe("Path to SDK bin directory (auto-detected if omitted)"),
  },
  async ({ sdk_path }) => {
    try {
      const result = await sim.launchSimulator(sdk_path);
      return { content: [{ type: "text", text: result }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ── build_app ───────────────────────────────────────────────────────────────

server.tool(
  "build_app",
  "Build a Connect IQ app project using monkeyc. Auto-detects SDK and Java paths.",
  {
    project_path: z.string().describe("Absolute path to the CIQ project directory"),
    device: z.string().optional().describe("Target device (default: fenix7)"),
    sdk_path: z.string().optional().describe("Path to SDK bin directory (auto-detected if omitted)"),
  },
  async ({ project_path, device, sdk_path }) => {
    try {
      const result = await sim.buildApp({
        projectPath: project_path,
        device,
        sdkPath: sdk_path,
      });
      return { content: [{ type: "text", text: result }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ── push_app ────────────────────────────────────────────────────────────────

server.tool(
  "push_app",
  "Push a compiled .prg file to the running simulator using monkeydo.",
  {
    prg_path: z.string().describe("Absolute path to the compiled .prg file"),
    device: z.string().optional().describe("Target device (default: fenix7)"),
    sdk_path: z.string().optional().describe("Path to SDK bin directory (auto-detected if omitted)"),
  },
  async ({ prg_path, device, sdk_path }) => {
    try {
      const result = await sim.pushApp({
        prgPath: prg_path,
        device,
        sdkPath: sdk_path,
      });
      return { content: [{ type: "text", text: result }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ── Start ───────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
