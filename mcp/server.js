// MCP del visor: herramientas para que Claude maneje el emulador.
// Habla con la API HTTP del visor (server.js) para que cada acción se vea en vivo en el panel;
// si el visor no está corriendo, usa adb directo con la misma lógica (lib/device.js).
// stdout es del protocolo MCP: los logs van a stderr.

import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { KEYCODES, createActions, imageSize, resolveSerial } from '../lib/device.js';

const VIEWER_URL = (process.env.ANDROID_VIEWER_URL || 'http://localhost:8093').replace(/\/$/, '');
const SCREENSHOT_MAX = Number(process.env.SCREENSHOT_MAX) || 1024;
const VIEWER_TIMEOUT_MS = 60000;

const direct = createActions();

// Error de red (visor apagado) → modo directo. Un error HTTP del visor sí se propaga.
class ViewerDown extends Error {}

async function viewer(method, route, params = {}) {
  const url = new URL(VIEWER_URL + route);
  const init = { method, signal: AbortSignal.timeout(VIEWER_TIMEOUT_MS) };
  if (method === 'GET') {
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  } else {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(params);
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (err.name === 'TimeoutError') throw new Error(`El visor no respondió en ${VIEWER_TIMEOUT_MS / 1000} s`);
    throw new ViewerDown(err.message);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  const type = res.headers.get('content-type') || '';
  return type.startsWith('image/') ? { data: Buffer.from(await res.arrayBuffer()), mimeType: type } : res.json();
}

// Ejecuta una acción por el visor o, si no está corriendo, por adb.
async function run(action, method, route, params) {
  try {
    return { result: await viewer(method, route, params), via: 'visor' };
  } catch (err) {
    if (!(err instanceof ViewerDown)) throw err;
    const serial = action === 'devices' || action === 'launch' ? undefined : await resolveSerial(params.serial);
    return { result: await direct[action]({ ...params, serial }), via: 'adb' };
  }
}

function execFileAsync(cmd, args) {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, (err, stdout, stderr) => (err ? reject(new Error(String(stderr) || err.message)) : resolve(stdout))),
  );
}

// Reduce la captura con `sips` (macOS) para no mandar varios MB al modelo.
async function shrink({ data: image, mimeType }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'android-viewer-'));
  try {
    const src = path.join(dir, mimeType === 'image/bmp' ? 'in.bmp' : 'in.png');
    const out = path.join(dir, 'out.jpg');
    await writeFile(src, image);
    await execFileAsync('sips', ['-Z', String(SCREENSHOT_MAX), '-s', 'format', 'jpeg', '-s', 'formatOptions', '80', src, '--out', out]);
    return { data: await readFile(out), mimeType: 'image/jpeg' };
  } catch (err) {
    console.error('sips falló; se manda la captura original:', err.message);
    return { data: image, mimeType };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });

const serialArg = z
  .string()
  .optional()
  .describe('Serial de adb (p. ej. emulator-5556). Opcional si hay un solo dispositivo conectado.');
const coord = (what) => z.number().min(0).max(1).describe(`${what}, normalizada 0–1 sobre la captura de pantalla`);

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const server = new McpServer({ name: 'android-viewer', version });

server.registerTool(
  'list_devices',
  {
    title: 'Listar dispositivos',
    description:
      'Lista los AVDs del equipo (con serial y booted si el emulador está corriendo) y los ' +
      'dispositivos de adb que no son AVD. Un AVD con serial null está apagado: arráncalo con launch_avd.',
    annotations: { readOnlyHint: true },
  },
  async () => text((await run('devices', 'GET', '/api/devices', {})).result),
);

server.registerTool(
  'get_state',
  {
    title: 'Estado del dispositivo',
    description:
      'Tamaño y rotación del display activo, postura actual y posturas disponibles (plegables). ' +
      'Incluye la URL del visor para verlo en el panel del navegador.',
    inputSchema: { serial: serialArg },
    annotations: { readOnlyHint: true },
  },
  async ({ serial }) => {
    const { result, via } = await run('state', 'GET', '/api/state', { serial });
    return text({
      ...result,
      viewer: via === 'visor' ? `${VIEWER_URL}/?serial=${result.serial}` : 'apagado (inícialo con `npm start` o preview_start android-view)',
    });
  },
);

server.registerTool(
  'screenshot',
  {
    title: 'Captura de pantalla',
    description:
      'Captura la pantalla del display activo. Para tap/swipe usa coordenadas normalizadas: ' +
      'x = píxel_x / ancho de la imagen, y = píxel_y / alto de la imagen.',
    inputSchema: { serial: serialArg },
    annotations: { readOnlyHint: true },
  },
  async ({ serial }) => {
    const { result: capture } = await run('screenshot', 'GET', '/api/screenshot', { serial });
    const { width, height } = imageSize(capture.data);
    const { data, mimeType } = await shrink(capture);
    return {
      content: [
        { type: 'image', data: data.toString('base64'), mimeType },
        { type: 'text', text: `Pantalla de ${width}×${height} px (imagen reducida a lado mayor ≤ ${SCREENSHOT_MAX}).` },
      ],
    };
  },
);

server.registerTool(
  'tap',
  {
    title: 'Tocar',
    description: 'Toca un punto de la pantalla (input tap).',
    inputSchema: { x: coord('Coordenada x'), y: coord('Coordenada y'), serial: serialArg },
  },
  async ({ x, y, serial }) => {
    await run('tap', 'POST', '/api/tap', { serial, x, y });
    return text(`tap en (${x.toFixed(3)}, ${y.toFixed(3)})`);
  },
);

server.registerTool(
  'swipe',
  {
    title: 'Deslizar',
    description:
      'Desliza de un punto a otro (input swipe). Con el mismo punto de inicio y fin y una ' +
      'duración ≥ 500 ms es una pulsación larga.',
    inputSchema: {
      x1: coord('x inicial'),
      y1: coord('y inicial'),
      x2: coord('x final'),
      y2: coord('y final'),
      duration_ms: z.number().int().min(50).max(5000).default(300).describe('Duración del gesto en ms'),
      serial: serialArg,
    },
  },
  async ({ x1, y1, x2, y2, duration_ms, serial }) => {
    await run('swipe', 'POST', '/api/swipe', { serial, x1, y1, x2, y2, ms: duration_ms });
    return text(`swipe (${x1.toFixed(3)}, ${y1.toFixed(3)}) → (${x2.toFixed(3)}, ${y2.toFixed(3)}) en ${duration_ms} ms`);
  },
);

server.registerTool(
  'press_key',
  {
    title: 'Pulsar tecla',
    description: 'Pulsa una tecla del sistema (input keyevent).',
    inputSchema: { key: z.enum(Object.keys(KEYCODES)).describe('Tecla'), serial: serialArg },
  },
  async ({ key, serial }) => {
    await run('key', 'POST', '/api/key', { serial, key });
    return text(`tecla ${key}`);
  },
);

server.registerTool(
  'type_text',
  {
    title: 'Escribir texto',
    description: 'Escribe texto ASCII en el campo enfocado (input text). Para Enter usa press_key.',
    inputSchema: { text: z.string().min(1).max(1000).describe('Texto a escribir'), serial: serialArg },
  },
  async ({ text: value, serial }) => {
    await run('text', 'POST', '/api/text', { serial, text: value });
    return text(`escrito: ${JSON.stringify(value)}`);
  },
);

server.registerTool(
  'launch_avd',
  {
    title: 'Iniciar AVD',
    description:
      'Arranca un emulador por nombre de AVD (ver list_devices). Vuelve enseguida: espera a que ' +
      'list_devices lo muestre con booted=true antes de usarlo.',
    inputSchema: { avd: z.string().describe('Nombre del AVD, p. ej. Pixel_10_Pro_Fold') },
  },
  async ({ avd }) => text((await run('launch', 'POST', '/api/launch', { avd })).result),
);

server.registerTool(
  'rotate',
  {
    title: 'Rotar',
    description: 'Rota el emulador 90° (como el botón de rotar del emulador). Solo emuladores.',
    inputSchema: { direction: z.enum(['left', 'right']).describe('Sentido'), serial: serialArg },
  },
  async ({ direction, serial }) => {
    await run('rotate', 'POST', '/api/rotate', { serial, direction });
    return text(`rotado a la ${direction === 'left' ? 'izquierda' : 'derecha'}`);
  },
);

server.registerTool(
  'set_posture',
  {
    title: 'Cambiar postura',
    description:
      'Cambia la postura de un plegable. En emuladores mueve la bisagra simulada (`emu posture`); ' +
      'en dispositivos físicos o REAR_DISPLAY usa `cmd device_state state`. Acepta el nombre ' +
      '(closed, half_opened, opened, rear_display), el id numérico o "reset" para volver a la del sensor. ' +
      'Devuelve el estado nuevo.',
    inputSchema: {
      posture: z.union([z.string(), z.number().int()]).describe('Nombre, id o "reset"'),
      serial: serialArg,
    },
  },
  async ({ posture, serial }) => text((await run('posture', 'POST', '/api/posture', { serial, posture })).result),
);

await server.connect(new StdioServerTransport());
console.error(`android-viewer MCP listo (visor: ${VIEWER_URL})`);
