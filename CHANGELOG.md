# Changelog

Todas las notas relevantes de este proyecto se documentan aquí.
Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/); versionado [SemVer](https://semver.org/lang/es/).

## [Sin liberar]

### Añadido
- Visor web del emulador: `screenrecord` H.264 por WebSocket, decodificado con WebCodecs. Guarda el GOP para quien se conecta después y manda una captura mientras la pantalla está quieta.
- Selector con todos los AVDs del equipo y los dispositivos de adb; un AVD apagado se arranca desde el visor.
- Controles como los del emulador: Atrás, Inicio, Recientes, Encendido, volumen, rotar izquierda/derecha, guardar captura a resolución completa y posturas de plegable.
- Posturas: en emuladores mueven la bisagra simulada (`emu posture`); en dispositivos físicos y Trasera, `cmd device_state state`. El stream sigue al display activo al plegar o rotar.
- API HTTP del visor (`/api/devices`, `/state`, `/screenshot`, `/tap`, `/swipe`, `/key`, `/text`, `/posture`, `/rotate`, `/launch`), solo desde orígenes locales.
- MCP por stdio (`list_devices`, `launch_avd`, `get_state`, `screenshot`, `tap`, `swipe`, `press_key`, `type_text`, `rotate`, `set_posture`): habla con el visor para que todo se vea en vivo, o con adb directo si el visor está apagado.
- Capturas en JavaScript puro: `screencap` en crudo, reducción por promedio de área y PNG con `zlib`, sin `sips` ni otras herramientas del sistema, así que funcionan en macOS, Linux y Windows. `GET /api/screenshot?max=<px>` reduce la imagen y devuelve el tamaño real en `X-Screen-Width`/`X-Screen-Height`.
- Comando `android-viewer` para `npx @acertijosapps/android-viewer`: sin argumentos arranca el visor (`--port`, `--host`) y `mcp` arranca el MCP (`--viewer-url`); `--help` y `--version`.
- README en inglés con captura del visor (`media/`, incluida en el paquete y servida por unpkg), instalación con `npx` y configuración del MCP para Claude Code y otros clientes.
- Textos en inglés: interfaz del visor, errores de la API, herramientas del MCP y mensajes de la terminal.
- Git flow del proyecto: CHANGELOG, guía de contribución, hooks de git (Conventional Commits y ramas protegidas) y CI en GitHub Actions.

### Cambiado

### Corregido

### Eliminado

<!--
 Al promover beta → main: renombra [Sin liberar] a [X.Y.Z] - AAAA-MM-DD y vuelve a crear una
 sección [Sin liberar] vacía encima de ella. Las versiones liberadas quedan debajo, de la más
 nueva a la más vieja.
-->
