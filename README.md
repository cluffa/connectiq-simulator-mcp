# connectiq-simulator-mcp

MCP server for automating the **Garmin Connect IQ Simulator** — macOS port.

Send keys, take screenshots, build apps, and push them to the simulator – all from an AI assistant (Claude Code, Cursor, etc.) via the [Model Context Protocol](https://modelcontextprotocol.io).

> **Platforms:** macOS (this fork). For the [original Windows version](https://github.com/thomaszipf/connectiq-simulator-mcp), see [thomaszipf/connectiq-simulator-mcp](https://github.com/thomaszipf/connectiq-simulator-mcp).

## Tools

| Tool | Description |
|------|-------------|
| `find_simulator` | Detect the running simulator window (PID, title, bounds) |
| `send_key` | Send a single key press: `up`, `down`, `enter`, `esc`, `menu`, `back` |
| `send_key_sequence` | Send multiple keys with configurable delays |
| `screenshot` | Capture the simulator window as PNG |
| `test_sequence` | Interleaved keys + screenshots for visual UI testing |
| `launch_simulator` | Start the CIQ Simulator (auto-detects SDK path) |
| `build_app` | Compile a Connect IQ project with `monkeyc` |
| `push_app` | Push a `.prg` to the running simulator with `monkeydo` |

## Requirements

- **macOS** (uses `osascript` for window control and `screencapture` for screenshots)
- **Node.js** >= 18
- **Garmin Connect IQ SDK** installed via the SDK Manager (auto-detected from `~/Library/Application Support/Garmin/ConnectIQ/Sdks/`)
- **Java JDK** (for building apps – auto-detected via `/usr/libexec/java_home`)

## Installation

### From npm (coming soon)

```bash
npm install -g @cluffa/connectiq-simulator-mcp
```

### From source

```bash
git clone https://github.com/cluffa/connectiq-simulator-mcp.git
cd connectiq-simulator-mcp
npm install
npm run build
```

## Configuration

### Claude Code

Add to your `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "connectiq-simulator": {
      "command": "node",
      "args": ["/path/to/connectiq-simulator-mcp/dist/index.js"]
    }
  }
}
```

### Claude Desktop / Cursor / VS Code

Same `command` and `args` — point `args[0]` to the absolute path of `dist/index.js`.

## How It Works

The server uses **osascript** (AppleScript) subprocess calls to interact with the simulator:

- **Window detection**: `System Events` process/window queries
- **Key sending**: AppleScript `keystroke` / `key code` sent to the simulator process
- **Screenshots**: Native `screencapture -R` with window coordinates
- **Building/pushing**: Shells out to `monkeyc` / `monkeydo`

No native Node.js modules are needed — everything works through macOS built-in utilities.

### Simulator Key Mapping

| Simulator Button | Key |
|-----------------|-----|
| UP | `up` (Up arrow) |
| DOWN | `down` (Down arrow) |
| ENTER / START | `enter` (Return) |
| BACK / ESC | `esc` (Escape) |
| MENU | `menu` (F3) |

## Example Usage

Once configured, you can ask your AI assistant:

> "Take a screenshot of the simulator"

> "Send enter key to the simulator"

> "Build my padel-tracker app and push it to the simulator"

> "Send this key sequence: enter, wait 1s, down, wait 500ms, enter"

> "Run a test sequence: screenshot, press enter, screenshot, press down, screenshot — so I can see each state"

### test_sequence Example

The `test_sequence` tool runs a full scripted interaction in one call — keys and screenshots interleaved — and returns all captured frames inline so you can visually verify each app state:

```json
{
  "steps": [
    { "action": "screenshot", "label": "initial" },
    { "action": "key", "key": "enter", "delay": 800 },
    { "action": "screenshot", "label": "after_enter" },
    { "action": "key", "key": "down", "delay": 500 },
    { "action": "screenshot", "label": "after_down" },
    { "action": "wait", "ms": 1000 },
    { "action": "screenshot", "label": "final" }
  ]
}
```

The response contains interleaved text labels and PNG images — the AI can see exactly what happened at each step and evaluate the UI.

## Differences from the original Windows version

| Feature | Windows (original) | macOS (this fork) |
|---------|-------------------|-------------------|
| Window detection | PowerShell + Win32 `GetWindowRect` | AppleScript `System Events` |
| Key injection | `SendKeys.SendWait` | AppleScript `keystroke` / `key code` |
| Screenshot | `Graphics.CopyFromScreen` | `screencapture -R` |
| SDK detection | `%APPDATA%\Garmin\ConnectIQ\Sdks` | `~/Library/Application Support/Garmin/ConnectIQ/Sdks` |
| Java detection | `JAVA_HOME` + common paths | `/usr/libexec/java_home` |
| Process launch | `simulator.exe` | `open -a ConnectIQ.app` |

## License

MIT — see [LICENSE](LICENSE).
