# @acertijosapps/android-viewer

Live Android emulator viewer for the browser, plus an MCP server so an AI agent can drive it.
Built for the browser pane of AI coding tools (such as Claude Code): you and the agent watch and
control the same emulator, in real time, including foldable postures.

<img src="https://unpkg.com/@acertijosapps/android-viewer/media/viewer-foldable.jpg" width="560" alt="Android Viewer streaming a Pixel 10 Pro Fold emulator: AVD selector on top, the live screen in the middle, and the navigation, hardware, rotation, screenshot and posture controls at the bottom" />

- **Live video**: `adb exec-out screenrecord` (H.264) over WebSocket, decoded in the browser with WebCodecs.
- **Input**: click, drag, long press and scroll become `adb shell input` commands.
- **Every AVD on your machine**: pick a running emulator or start a stopped one from the viewer.
- **Emulator controls**: Back, Home, Recents, Power, Volume, Rotate, full-resolution screenshot.
- **Foldables**: Closed / Half-opened / Opened / Rear display. On emulators they move the simulated hinge, like the emulator's own controls; the stream follows the active display when you fold or rotate.
- **MCP server**: the same actions as tools, so the agent's taps show up live in the viewer.
- **Nothing to install on the device**: no APK, no server push; only `adb`.

## Requirements

- Node.js 18 or later.
- Android SDK platform tools (`adb`) and, to list and start AVDs, the emulator.
  Found through `ANDROID_HOME`, `ANDROID_SDK_ROOT` or the default SDK location; override with `ADB` and `EMULATOR`.
- A browser with WebCodecs (Chromium-based browsers, Safari 16.4+, Firefox 130+).
- Works on macOS, Linux and Windows.

## Quick start

```sh
npx @acertijosapps/android-viewer
```

Open <http://localhost:8093> and pick a device. Deep links: `?avd=Pixel_10` or `?serial=emulator-5554`.

```text
android-viewer [options]        Start the viewer
android-viewer mcp [options]    Start the MCP server on stdio

  -p, --port <port>      Viewer port (default 8093, env PORT)
      --host <host>      Interface to bind (default 127.0.0.1, env HOST)
      --viewer-url <url> Viewer the MCP talks to (default http://localhost:8093)
```

Other environment variables: `MAX_DIM` (longest side of the encoded video, default 1024),
`BIT_RATE` (default `6M`), `SCREENSHOT_MAX` (longest side of MCP screenshots, default 1024) and
`DEBUG=1` (logs every input command).

## Use it with an AI agent (MCP)

Claude Code:

```sh
claude mcp add android-viewer -- npx -y @acertijosapps/android-viewer mcp
```

Any other MCP client:

```json
{
  "mcpServers": {
    "android-viewer": {
      "command": "npx",
      "args": ["-y", "@acertijosapps/android-viewer", "mcp"]
    }
  }
}
```

Keep the viewer running (`npx @acertijosapps/android-viewer`) to watch what the agent does. Without
it, the MCP drives the device through `adb` directly.

| Tool | What it does |
| --- | --- |
| `list_devices` | AVDs on the machine (with `serial` and `booted` when running) and other adb devices |
| `launch_avd` | Start an AVD by name |
| `get_state` | Display size, rotation, current posture, available postures and the viewer URL |
| `screenshot` | PNG of the active display, longest side ≤ 1024 px |
| `tap` | `input tap` |
| `swipe` | `input swipe`; same start and end with ≥ 500 ms is a long press |
| `press_key` | back, home, recents, power, wakeup, volup, voldown, enter, delete, tab, escape |
| `type_text` | `input text` (printable ASCII) |
| `rotate` | Rotate 90° left or right (emulators) |
| `set_posture` | closed, half_opened, opened, rear_display, a state id, or `reset`; returns the new state |

Coordinates are normalized to `0–1` over the screenshot (`x = pixel_x / image_width`), so they hold
in any posture or orientation. `serial` is optional when only one device is connected.

### In the Claude Code browser pane

Add the viewer to `.claude/launch.json` and open it with `preview_start android-viewer`:

```json
{
  "version": "0.0.1",
  "configurations": [
    {
      "name": "android-viewer",
      "runtimeExecutable": "npx",
      "runtimeArgs": ["-y", "@acertijosapps/android-viewer"],
      "port": 8093,
      "autoPort": false
    }
  ]
}
```

## HTTP API

The MCP uses the viewer's API; you can call it too. `serial` goes in the query string or the body
and is optional with a single device. `POST` requests require `content-type: application/json` and a
local origin, so other websites can't drive your devices.

| Endpoint | |
| --- | --- |
| `GET /api/devices` | `[{ avd, serial, booted, model }]`: `serial: null` = stopped, `booted: null` = didn't answer in time |
| `GET /api/state` | Display size, rotation, `displayId`, posture and available postures |
| `GET /api/screenshot?max=<px>` | PNG; real screen size in `X-Screen-Width` / `X-Screen-Height` |
| `POST /api/tap` | `{ x, y }` |
| `POST /api/swipe` | `{ x1, y1, x2, y2, ms }` |
| `POST /api/key` | `{ key }` |
| `POST /api/text` | `{ text }` |
| `POST /api/posture` | `{ posture }` |
| `POST /api/rotate` | `{ direction: "left" \| "right" }` |
| `POST /api/launch` | `{ avd }` |

When a viewer tab is watching the device, actions go through its live session: the viewer updates at
once and a watchdog restarts the stream if a gesture produces no frames.

## How it works

- One session per device, shared by every tab, stopped when the last one closes.
- Every second it reads `dumpsys display` (size, rotation and the physical display behind logical
  display 0) and `cmd device_state state`. When the display changes, it waits for it to settle and
  restarts `screenrecord` with `--display-id` of the new panel: folding a device switches panels.
- `screenrecord` only emits frames when the screen changes, so the viewer keeps the GOP since the last
  IDR for late joiners and sends a screenshot while there is no video.
- Only one `screenrecord` runs per device at a time: two of them exhaust the emulator's software
  encoder (`err=-38`). Restarts requested by clients are rate-limited.
- Screenshots use raw `screencap` (compressing PNG inside the emulator is slow under load), are scaled
  down by area averaging and encoded as PNG with `node:zlib`, with no native dependencies.

## Limitations

- Drags are sent on release (one `input swipe` with the real duration), not live.
- No keyboard passthrough or audio yet; use `type_text` and `press_key`.
- Higher latency than a native client such as [scrcpy](https://github.com/Genymobile/scrcpy).
- The software encoder slows down with several emulators recording at once; with little free RAM
  (emulators paged out to swap) every `adb shell` call can take seconds.
- If an app requests its own posture (`DeviceStateManager.requestState`), it wins over `set_posture`
  while it is in the foreground.
- `Flip_Horizontal_Fold` style AVDs with a single physical display change state when closed, but the
  picture stays the same.
- The viewer UI is in Spanish for now.

## Why not ws-scrcpy?

[ws-scrcpy](https://github.com/NetrisTV/ws-scrcpy) was tried first: streaming and input work, but the
video freezes on a posture change until you reload (its scrcpy 1.19 server stays bound to the previous
display), and it has no posture controls.

## Contributing

Branching model (`main` · `beta`), Conventional Commits and releases are described in
[CONTRIBUTING.md](./CONTRIBUTING.md); changes are listed in [CHANGELOG.md](./CHANGELOG.md).

## Author

Made by [AcertijosApps](https://acertijosapps.com/librerias). See the rest of our libraries at
[acertijosapps.com/librerias](https://acertijosapps.com/librerias).

Questions or proposals: [acertijos.contacto@gmail.com](mailto:acertijos.contacto@gmail.com) or open an
[issue](https://github.com/acertijosapps/android-viewer/issues).

## License

MIT
