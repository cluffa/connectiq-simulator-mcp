# connectiq-simulator-mcp

MCP server for automating the **Garmin Connect IQ Simulator** on Windows.

Send keys, take screenshots, build apps, and push them to the simulator – all from an AI assistant (Claude Code, Cursor, etc.) via the [Model Context Protocol](https://modelcontextprotocol.io).

## Tools

| Tool | Description |
|------|-------------|
| `find_simulator` | Detect the running simulator window (handle, title, bounds) |
| `send_key` | Send a single key press: `up`, `down`, `enter`, `esc`, `menu`, `back` |
| `send_key_sequence` | Send multiple keys with configurable delays |
| `screenshot` | Capture the simulator window as PNG |
| `test_sequence` | Interleaved keys + screenshots for visual UI testing |
| `launch_simulator` | Start the CIQ Simulator (auto-detects SDK path) |
| `build_app` | Compile a Connect IQ project with `monkeyc` |
| `push_app` | Push a `.prg` to the running simulator with `monkeydo` |

## Requirements

- **Windows 10/11** (uses Win32 APIs via PowerShell)
- **Node.js** >= 18
- **Garmin Connect IQ SDK** installed via the SDK Manager
- **Java JDK** (for building apps – auto-detected from `JAVA_HOME` or common paths)
- **PowerShell** (included with Windows)

## Installation

```bash
npm install -g connectiq-simulator-mcp
```

Or clone and build locally:

```bash
git clone https://github.com/thomaszipf/connectiq-simulator-mcp.git
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
      "args": ["C:/path/to/connectiq-simulator-mcp/dist/index.js"]
    }
  }
}
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "connectiq-simulator": {
      "command": "node",
      "args": ["C:/path/to/connectiq-simulator-mcp/dist/index.js"]
    }
  }
}
```

### Cursor / VS Code

Add to your MCP settings with the same `command` and `args`.

## How It Works

The server uses **PowerShell** subprocess calls to interact with Win32 APIs:

- **Window detection**: `Get-Process` + `GetWindowRect` to find the simulator
- **Key sending**: `SetForegroundWindow` + `SendKeys.SendWait` for key presses
- **Screenshots**: `Graphics.CopyFromScreen` to capture the window region
- **Building/pushing**: Shells out to `monkeyc.bat` / `monkeydo.bat`

No native Node.js modules are needed – everything works through PowerShell.

### Simulator Key Mapping

| Simulator Button | Key |
|-----------------|-----|
| UP | `up` (Up arrow) |
| DOWN | `down` (Down arrow) |
| ENTER / START | `enter` (Enter) |
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

## License

MIT
