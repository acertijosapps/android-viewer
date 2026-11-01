// MCP del visor: herramientas para que Claude maneje el emulador.
// Habla con la API HTTP del visor (server.js) para que cada acción se vea en vivo en el panel;
// si el visor no está corriendo, usa adb directo con la misma lógica (lib/device.js).
// stdout es del protocolo MCP: los logs van a stderr.

import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { KEYCODES, createActions, resolveSerial } from '../lib/device.js';

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
    if (err.name === 'TimeoutError') throw new Error(`The viewer did not answer within ${VIEWER_TIMEOUT_MS / 1000} s`);
    throw new ViewerDown(err.message);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  const type = res.headers.get('content-type') || '';
  if (!type.startsWith('image/')) return res.json();
  return {
    data: Buffer.from(await res.arrayBuffer()),
    mimeType: type,
    screenWidth: Number(res.headers.get('x-screen-width')),
    screenHeight: Number(res.headers.get('x-screen-height')),
  };
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

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });

const serialArg = z
  .string()
  .optional()
  .describe('adb serial (e.g. emulator-5556). Optional when only one device is connected.');
const coord = (what) => z.number().min(0).max(1).describe(`${what}, normalized 0–1 over the screenshot`);

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const server = new McpServer({ name: 'android-viewer', version });

server.registerTool(
  'list_devices',
  {
    title: 'List devices',
    description:
      'Lists the AVDs on this machine (with serial and booted when the emulator is running) and the ' +
      'adb devices that are not AVDs. An AVD with serial null is stopped: start it with launch_avd.',
    annotations: { readOnlyHint: true },
  },
  async () => text((await run('devices', 'GET', '/api/devices', {})).result),
);

server.registerTool(
  'get_state',
  {
    title: 'Device state',
    description:
      'Size and rotation of the active display, current posture and available postures (foldables). ' +
      'Includes the viewer URL to watch the device in a browser pane.',
    inputSchema: { serial: serialArg },
    annotations: { readOnlyHint: true },
  },
  async ({ serial }) => {
    const { result, via } = await run('state', 'GET', '/api/state', { serial });
    return text({
      ...result,
      viewer: via === 'visor' ? `${VIEWER_URL}/?serial=${result.serial}` : 'not running (start it with `npx @acertijosapps/android-viewer`)',
    });
  },
);

server.registerTool(
  'screenshot',
  {
    title: 'Screenshot',
    description:
      'Captures the active display (PNG). For tap/swipe use normalized coordinates: ' +
      'x = pixel_x / image width, y = pixel_y / image height.',
    inputSchema: { serial: serialArg },
    annotations: { readOnlyHint: true },
  },
  async ({ serial }) => {
    const { result: shot } = await run('screenshot', 'GET', '/api/screenshot', { serial, max: SCREENSHOT_MAX });
    return {
      content: [
        { type: 'image', data: shot.data.toString('base64'), mimeType: shot.mimeType },
        { type: 'text', text: `Screen is ${shot.screenWidth}×${shot.screenHeight} px (image scaled to a longest side ≤ ${SCREENSHOT_MAX}).` },
      ],
    };
  },
);

server.registerTool(
  'tap',
  {
    title: 'Tap',
    description: 'Taps a point on the screen (input tap).',
    inputSchema: { x: coord('x coordinate'), y: coord('y coordinate'), serial: serialArg },
  },
  async ({ x, y, serial }) => {
    await run('tap', 'POST', '/api/tap', { serial, x, y });
    return text(`tapped (${x.toFixed(3)}, ${y.toFixed(3)})`);
  },
);

server.registerTool(
  'swipe',
  {
    title: 'Swipe',
    description:
      'Swipes from one point to another (input swipe). With the same start and end point and a ' +
      'duration ≥ 500 ms it is a long press.',
    inputSchema: {
      x1: coord('Start x'),
      y1: coord('Start y'),
      x2: coord('End x'),
      y2: coord('End y'),
      duration_ms: z.number().int().min(50).max(5000).default(300).describe('Gesture duration in ms'),
      serial: serialArg,
    },
  },
  async ({ x1, y1, x2, y2, duration_ms, serial }) => {
    await run('swipe', 'POST', '/api/swipe', { serial, x1, y1, x2, y2, ms: duration_ms });
    return text(`swipe (${x1.toFixed(3)}, ${y1.toFixed(3)}) → (${x2.toFixed(3)}, ${y2.toFixed(3)}) in ${duration_ms} ms`);
  },
);

server.registerTool(
  'press_key',
  {
    title: 'Press key',
    description: 'Presses a system key (input keyevent).',
    inputSchema: { key: z.enum(Object.keys(KEYCODES)).describe('Key'), serial: serialArg },
  },
  async ({ key, serial }) => {
    await run('key', 'POST', '/api/key', { serial, key });
    return text(`pressed ${key}`);
  },
);

server.registerTool(
  'type_text',
  {
    title: 'Type text',
    description: 'Types ASCII text into the focused field (input text). For Enter use press_key.',
    inputSchema: { text: z.string().min(1).max(1000).describe('Text to type'), serial: serialArg },
  },
  async ({ text: value, serial }) => {
    await run('text', 'POST', '/api/text', { serial, text: value });
    return text(`typed ${JSON.stringify(value)}`);
  },
);

server.registerTool(
  'launch_avd',
  {
    title: 'Launch AVD',
    description:
      'Starts an emulator by AVD name (see list_devices). Returns right away: wait until ' +
      'list_devices shows it with booted=true before using it.',
    inputSchema: { avd: z.string().describe('AVD name, e.g. Pixel_10_Pro_Fold') },
  },
  async ({ avd }) => text((await run('launch', 'POST', '/api/launch', { avd })).result),
);

server.registerTool(
  'rotate',
  {
    title: 'Rotate',
    description: "Rotates the emulator 90° (like the emulator's rotate button). Emulators only.",
    inputSchema: { direction: z.enum(['left', 'right']).describe('Direction'), serial: serialArg },
  },
  async ({ direction, serial }) => {
    await run('rotate', 'POST', '/api/rotate', { serial, direction });
    return text(`rotated ${direction}`);
  },
);

server.registerTool(
  'set_posture',
  {
    title: 'Set posture',
    description:
      'Changes the posture of a foldable. On emulators it moves the simulated hinge (`emu posture`); ' +
      'on physical devices or for REAR_DISPLAY it uses `cmd device_state state`. Accepts the name ' +
      '(closed, half_opened, opened, rear_display), the numeric id or "reset" to go back to the sensor posture. ' +
      'Returns the new state.',
    inputSchema: {
      posture: z.union([z.string(), z.number().int()]).describe('Name, id or "reset"'),
      serial: serialArg,
    },
  },
  async ({ posture, serial }) => text((await run('posture', 'POST', '/api/posture', { serial, posture })).result),
);

await server.connect(new StdioServerTransport());
console.error(`android-viewer MCP ready (viewer: ${VIEWER_URL})`);
