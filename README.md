# Android Viewer

Visor web del emulador de Android para el panel de navegador de Claude (Code tab), más un MCP para que Claude lo maneje. Lo que hace el MCP se ve en vivo en el visor.

```
Claude ──MCP (stdio)──► mcp/server.js ──HTTP──► server.js (visor :8093) ──adb──► emulador
                                  └──── adb directo si el visor está apagado ────┘
Panel del navegador ◄──WebSocket (video + estado)── server.js
```

- **Video**: `adb exec-out screenrecord --output-format=h264 -` → WebSocket → WebCodecs (`VideoDecoder`).
- **Selector (arriba)**: todos los AVDs del equipo (`emulator -list-avds`) más los dispositivos de adb que no son AVD. Un AVD apagado muestra «Iniciar emulador»; al terminar de arrancar se conecta solo.
- **Input**: clic = `input tap`, arrastre/pulsación larga = `input swipe`, rueda = swipe corto.
- **Controles (abajo)**, como la barra del emulador: Atrás, Inicio, Recientes · Encendido, Bajar/Subir volumen · Rotar izquierda/derecha (`emu rotate`, solo emuladores) · Guardar captura (PNG a resolución completa) · Postura.
- **Postura**: botones con los estados de `cmd device_state print-states` (Cerrado / Medio / Abierto / Trasera) y «Auto». En emuladores, Cerrado/Medio/Abierto mueven la bisagra simulada con `emu posture` (Android deriva el estado, como los controles del emulador); Trasera y los dispositivos físicos usan `cmd device_state state`. Los cambios hechos desde fuera también se reflejan.

## Uso

```bash
npm install && npm start
```

Abre `http://localhost:8093` y elige el dispositivo en el selector (o `?avd=Pixel_10` / `?serial=emulator-5554`).

Variables opcionales: `PORT` (8093), `MAX_DIM` (1024, lado mayor del video), `BIT_RATE` (6M), `ANDROID_HOME`, `ADB`, `EMULATOR`, `DEBUG=1` (registra cada comando de input).

### En el panel de navegador de Claude Code

Agrega a `.claude/launch.json` (no se versiona: lleva rutas de tu equipo) y abre con `preview_start android-viewer`:

```json
{
  "version": "0.0.1",
  "configurations": [
    {
      "name": "android-viewer",
      "runtimeExecutable": "/bin/bash",
      "runtimeArgs": ["-c", "cd /ruta/a/android-viewer && exec node server.js"],
      "port": 8093,
      "autoPort": false
    }
  ]
}
```

## MCP

Registrado en `.mcp.json` como `android-viewer`. Claude Code pide habilitarlo la primera vez que se abre una sesión en esta carpeta.

| Herramienta | Qué hace |
| --- | --- |
| `list_devices` | AVDs del equipo (serial y `booted` si corren) y dispositivos de adb |
| `launch_avd` | Arranca un AVD por nombre |
| `rotate` | Rota 90° a la izquierda o derecha (`emu rotate`) |
| `get_state` | Tamaño, rotación, postura y posturas disponibles; URL del visor |
| `screenshot` | Captura del display activo: `screencap` en crudo → BMP → JPEG con lado mayor ≤ 1024 (`sips`) |
| `tap` | `input tap` |
| `swipe` | `input swipe`; mismo punto y ≥ 500 ms = pulsación larga |
| `press_key` | back, home, recents, power, wakeup, volup, voldown, enter, delete, tab, escape |
| `type_text` | `input text` (solo ASCII) |
| `set_posture` | closed, half_opened, opened, rear_display, id o `reset`; en emuladores vía `emu posture`; devuelve el estado nuevo |

Las coordenadas son normalizadas 0–1 sobre la captura (`x = px / ancho`), así sirven en cualquier postura. `serial` es opcional si hay un solo dispositivo.

Variables: `ANDROID_VIEWER_URL` (http://localhost:8093), `SCREENSHOT_MAX` (1024).

Para probarlo a mano: `npm run mcp` (habla MCP por stdin/stdout).

## API HTTP del visor

La usa el MCP; `serial` va en el query o en el cuerpo, y es opcional con un solo dispositivo. Los POST exigen `content-type: application/json` y un origen local.

- `GET /api/devices`, `GET /api/state`, `GET /api/screenshot` (PNG)
- `POST /api/tap {x, y}`, `/api/swipe {x1, y1, x2, y2, ms}`, `/api/key {key}`, `/api/text {text}`, `/api/posture {posture}`, `/api/rotate {direction}`, `/api/launch {avd}`

`GET /api/devices` devuelve `[{ avd, serial, booted, model }]`: `serial` null = apagado; `booted` null = el emulador no respondió a tiempo.

Con alguien mirando el visor, las acciones pasan por su sesión: el panel se actualiza al momento y el watchdog vigila el stream.

## Cómo funciona

- Una sesión por dispositivo, compartida entre pestañas; se detiene al cerrarse la última.
- Cada segundo lee `dumpsys display` (tamaño, rotación y display físico activo) y `cmd device_state state`. Si cambia el display, espera 1 s a que se asiente y reinicia `screenrecord` con `--display-id` del display físico nuevo: en un plegable, cerrar cambia de panel.
- `screenrecord` solo emite frames cuando la pantalla cambia. Por eso se guarda el GOP desde el último IDR para quien se conecte después, y se manda un `screencap` mientras no haya video.
- El último NAL se da por completo tras 80 ms sin datos (o antes, cuando llega el siguiente frame). Si llega una continuación, el umbral se duplica y se pide un IDR nuevo.
- Nunca corren dos `screenrecord` a la vez en un dispositivo: en el emulador agotan el encoder por software (`err=-38`). Los reinicios pedidos por el cliente están limitados a uno cada 2 s.

## Limitaciones

- Los arrastres se envían al soltar (un `input swipe` con la duración real), no en vivo.
- No hay teclado ni audio.
- Con poca RAM libre (los emuladores paginados a swap) cada `adb shell` puede tardar decenas de segundos; el visor aguanta, pero todo va lento. Cierra emuladores o apps que no uses.
- Con varios emuladores codificando a la vez el frame rate baja: el encoder es por software. Con tres emuladores abiertos, cada consulta a `system_server` puede tardar 10–30 s; los timeouts de adb son de 30 s.
- `screencap -p` hace comprimir el PNG al emulador y con la CPU cargada tarda 14 s o más; por eso se pide en crudo (1–3 s).
- Flip_Horizontal_Fold tiene un solo display físico: `set_posture closed` cambia el estado, pero la imagen no cambia.
- Un gesto mandado justo después de cambiar de postura puede perderse mientras el launcher se reacomoda.
- Si una app pide su propia postura (`DeviceStateManager.requestState`), esa gana sobre `set_posture` mientras esté al frente.

## Por qué no ws-scrcpy

Se probó primero [ws-scrcpy](https://github.com/NetrisTV/ws-scrcpy) (fork maxduke, v0.9.2): el stream y el input funcionan, pero al cambiar de postura el video se congela hasta recargar (su server scrcpy 1.19 queda atado al display anterior) y no tiene controles de postura.

## Author

Made by [AcertijosApps](https://acertijosapps.com/librerias). See the rest of our libraries at
[acertijosapps.com/librerias](https://acertijosapps.com/librerias).

Questions or proposals: [acertijos.contacto@gmail.com](mailto:acertijos.contacto@gmail.com) or open an
[issue](https://github.com/acertijosapps/android-viewer/issues).

## License

MIT
