// Acceso a dispositivos por adb, compartido por el visor (server.js) y el MCP (mcp/server.js).

import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const SDK =
  process.env.ANDROID_HOME ||
  process.env.ANDROID_SDK_ROOT ||
  path.join(os.homedir(), process.platform === 'darwin' ? 'Library/Android/sdk' : 'Android/Sdk');
const sdkTool = (rel, fallback) => (existsSync(path.join(SDK, rel)) ? path.join(SDK, rel) : fallback);
export const ADB = process.env.ADB || sdkTool('platform-tools/adb', 'adb');
export const EMULATOR = process.env.EMULATOR || sdkTool('emulator/emulator', 'emulator');

export const KEYCODES = {
  back: 4,
  home: 3,
  recents: 187,
  power: 26,
  wakeup: 224,
  volup: 24,
  voldown: 25,
  enter: 66,
  delete: 67,
  tab: 61,
  escape: 111,
};
export const SERIAL_RE = /^[\w.:-]+$/;

// Error del que pide (dato inválido), para responder 400 en la API.
function invalid(message) {
  return Object.assign(new Error(message), { status: 400 });
}

export function adb(serial, args, { timeout = 30000, encoding = 'utf8' } = {}) {
  const full = serial ? ['-s', serial, ...args] : args;
  return new Promise((resolve, reject) => {
    execFile(ADB, full, { timeout, encoding, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((String(stderr) || err.message).trim()));
      else resolve(stdout);
    });
  });
}

export async function listDevices() {
  const out = await adb(null, ['devices', '-l']);
  const devices = out
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [serial, state, ...rest] = l.split(/\s+/);
      const props = Object.fromEntries(rest.map((kv) => kv.split(':')));
      return { serial, state, model: props.model || '' };
    });
  await Promise.all(
    devices
      .filter((d) => d.state === 'device' && d.serial.startsWith('emulator-'))
      .map(async (d) => {
        try {
          d.avd = (await adb(d.serial, ['emu', 'avd', 'name'], { timeout: 3000 })).split('\n')[0].trim();
        } catch {
          // sin consola del emulador: se queda con el modelo
        }
      }),
  );
  return devices;
}

// Sin serial: el único dispositivo conectado; con varios hay que elegir.
export async function resolveSerial(serial) {
  if (serial) {
    if (!SERIAL_RE.test(serial)) throw invalid(`Serial inválido: ${serial}`);
    return serial;
  }
  const online = (await listDevices()).filter((d) => d.state === 'device');
  if (online.length === 1) return online[0].serial;
  if (!online.length) throw new Error('No hay dispositivos en adb.');
  throw invalid(`Hay varios dispositivos; indica serial: ${online.map((d) => d.serial).join(', ')}`);
}

const booted = new Set();
const bootChecks = new Map();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// AVDs instalados en el equipo, con el serial del emulador si está corriendo, más los
// dispositivos que no son AVD (físicos o remotos).
export async function listTargets() {
  const [devices, avdNames] = await Promise.all([
    listDevices(),
    new Promise((resolve) =>
      execFile(EMULATOR, ['-list-avds'], { timeout: 10000 }, (err, out) =>
        resolve(err ? [] : out.split('\n').map((l) => l.trim()).filter((l) => l && !l.includes(' '))),
      ),
    ),
  ]);
  const online = devices.filter((d) => d.state === 'device');
  for (const serial of booted) if (!online.some((d) => d.serial === serial)) booted.delete(serial);
  await Promise.all(
    online.map(async (d) => {
      // getprop puede tardar 5–9 s en un emulador cargado: un serial arrancado no se vuelve a consultar.
      if (!booted.has(d.serial)) {
        // Con refrescos cada pocos segundos, una consulta lenta no se duplica.
        if (!bootChecks.has(d.serial)) {
          const check = adb(d.serial, ['shell', 'getprop sys.boot_completed'], { timeout: 15000 })
            .then((prop) => (prop.trim() === '1' ? (booted.add(d.serial), true) : false))
            .catch(() => null) // sin respuesta: desconocido, no «arrancando»
            .finally(() => bootChecks.delete(d.serial));
          bootChecks.set(d.serial, check);
        }
        // No se bloquea la lista: si no responde pronto queda en null (desconocido) y sigue en segundo plano.
        const result = await Promise.race([bootChecks.get(d.serial), wait(1500).then(() => null)]);
        d.booted = result;
        return;
      }
      d.booted = true;
    }),
  );
  const targets = avdNames.map((avd) => {
    const d = online.find((x) => x.avd === avd);
    return { avd, serial: d?.serial ?? null, booted: d?.booted ?? false, model: d?.model ?? '' };
  });
  for (const d of online) {
    if (!targets.some((t) => t.serial === d.serial)) targets.push({ avd: d.avd ?? null, serial: d.serial, booted: d.booted, model: d.model });
  }
  return targets;
}

// Arranca un AVD como proceso independiente (sigue vivo aunque se cierre el visor).
export async function launchAvd(avd) {
  const targets = await listTargets();
  const target = targets.find((t) => t.avd === avd);
  if (!target) throw invalid(`AVD desconocido: ${avd}. Disponibles: ${targets.filter((t) => t.avd).map((t) => t.avd).join(', ')}`);
  if (target.serial) return { avd, serial: target.serial, alreadyRunning: true };
  const child = spawn(EMULATOR, ['-avd', avd], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  return { avd, serial: null, launched: true };
}

// `emu rotate` gira 90° en sentido horario, como el botón del emulador; a la izquierda son tres.
export async function rotate(serial, direction) {
  if (!serial.startsWith('emulator-')) throw invalid('Rotar solo está disponible en emuladores');
  if (direction !== 'left' && direction !== 'right') throw invalid('direction debe ser left o right');
  for (let i = 0; i < (direction === 'right' ? 1 : 3); i++) await adb(serial, ['emu', 'rotate']);
}

export async function readDisplayState(serial) {
  const out = await adb(serial, [
    'shell',
    'dumpsys display | grep -m1 mOverrideDisplayInfo; echo @@; cmd device_state state 2>/dev/null | head -1',
  ]);
  const [disp, ds = ''] = out.split('@@');
  const size = disp.match(/real (\d+) x (\d+)/);
  if (!size) throw new Error('No se pudo leer el tamaño del display');
  const rotation = disp.match(/\brotation (\d)/);
  const uid = disp.match(/uniqueId "local:(\d+)"/);
  const posture = ds.match(/identifier=(\d+), name='([^']+)'/);
  return {
    width: Number(size[1]),
    height: Number(size[2]),
    rotation: rotation ? Number(rotation[1]) : 0,
    // Display físico que respalda al lógico 0; en un plegable cambia al cerrar/abrir.
    displayId: uid ? uid[1] : null,
    posture: posture ? { id: Number(posture[1]), name: posture[2] } : null,
  };
}

export async function readPostureStates(serial) {
  const out = await adb(serial, ['shell', 'cmd device_state print-states']).catch(() => '');
  return [...out.matchAll(/identifier=(\d+), name='([^']+)'[^}]*cancel_when_requester_not_on_top=(\w+)/g)]
    // Los estados que se cancelan si el solicitante no está al frente no sirven desde la shell.
    .filter((m) => m[3] !== 'true')
    .map((m) => ({ id: Number(m[1]), name: m[2] }));
}

// ---------- Comandos de input (coordenadas normalizadas 0–1 sobre el display lógico) ----------

function toPx(state, nx, ny) {
  const clamp = (v) => Math.min(1, Math.max(0, Number(v) || 0));
  return [Math.round(clamp(nx) * (state.width - 1)), Math.round(clamp(ny) * (state.height - 1))];
}

export function tapCommand(state, x, y) {
  const [px, py] = toPx(state, x, y);
  return `input tap ${px} ${py}`;
}

export function swipeCommand(state, x1, y1, x2, y2, ms) {
  const [ax, ay] = toPx(state, x1, y1);
  const [bx, by] = toPx(state, x2, y2);
  const duration = Math.round(Math.min(5000, Math.max(50, Number(ms) || 300)));
  return `input swipe ${ax} ${ay} ${bx} ${by} ${duration}`;
}

export function keyCommand(key) {
  const code = KEYCODES[key];
  if (!code) throw invalid(`Tecla desconocida: ${key}. Válidas: ${Object.keys(KEYCODES).join(', ')}`);
  return `input keyevent ${code}`;
}

export function textCommand(text) {
  const value = String(text ?? '');
  if (!value) throw invalid('Texto vacío');
  if (/[^\x20-\x7e]/.test(value)) throw invalid('`input text` solo admite ASCII imprimible');
  // `input text` toma %s como espacio; el resto va entre comillas simples para la shell.
  return `input text '${value.replace(/ /g, '%s').replace(/'/g, `'\\''`)}'`;
}

// Acepta id numérico, nombre (CLOSED, half_opened, "half-opened") o "reset".
export function postureArg(states, value) {
  if (value === 'reset') return 'reset';
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const id = Number(value);
    if (states.some((s) => s.id === id)) return id;
  } else {
    const name = String(value).toUpperCase().replace(/[-\s]/g, '_');
    const found = states.find((s) => s.name === name || s.name === `${name}_MODE`);
    if (found) return found.id;
  }
  const valid = states.map((s) => `${s.id}=${s.name}`).join(', ') || 'ninguna';
  throw invalid(`Postura no disponible: ${value}. Válidas: ${valid}, reset`);
}

// Posturas del sensor de bisagra del emulador (`emu posture`): mueven la bisagra simulada y
// Android deriva el estado solo, como los controles del emulador. Sin override de device_state.
const EMU_POSTURES = { CLOSED: 1, HALF_OPENED: 2, OPENED: 3 };

export async function setPosture(serial, states, arg) {
  const name = states.find((s) => s.id === arg)?.name;
  if (serial.startsWith('emulator-') && EMU_POSTURES[name]) {
    await adb(serial, ['shell', 'cmd device_state state reset']);
    const out = await adb(serial, ['emu', 'posture', String(EMU_POSTURES[name])]);
    if (!/^KO/m.test(out)) return;
  }
  // Dispositivo físico, estado sin postura de sensor (REAR_DISPLAY…) o «reset».
  await adb(serial, ['shell', `cmd device_state state ${arg}`]);
}

// Captura del display. Se pide en crudo (RGBA) y se codifica aquí: comprimir el PNG en el
// emulador es lo más lento con la CPU cargada (14 s contra ~1–6 s en crudo). Sin dependencias
// nativas ni herramientas del sistema, así que funciona igual en macOS, Linux y Windows.
//   format: 'png' (por defecto) o 'bmp' (sin comprimir, lo más rápido para el navegador).
//   maxDim: reduce la imagen para que su lado mayor no pase de ese tamaño.
// Devuelve { data, mimeType, width, height, screenWidth, screenHeight }.
export async function screencap(serial, displayId, { format = 'png', maxDim } = {}) {
  const display = displayId ? ` -d ${displayId}` : '';
  const raw = await adb(serial, ['exec-out', `screencap${display}`], { encoding: 'buffer' });
  const screenWidth = raw.readUInt32LE(0);
  const screenHeight = raw.readUInt32LE(4);
  const pixelFormat = raw.readUInt32LE(8);
  // Cabecera de 12 bytes (Android ≤ 11) o 16 (con dataspace); formato 1 = RGBA_8888, 2 = RGBX_8888.
  const header = raw.length - screenWidth * screenHeight * 4;
  if (!((pixelFormat === 1 || pixelFormat === 2) && (header === 12 || header === 16))) {
    // Formato raro: PNG del dispositivo, sin reducir.
    const png = await adb(serial, ['exec-out', `screencap -p${display}`], { encoding: 'buffer' });
    const size = imageSize(png);
    return { data: png, mimeType: 'image/png', ...size, screenWidth: size.width, screenHeight: size.height };
  }
  let image = { width: screenWidth, height: screenHeight, rgba: raw.subarray(header) };
  if (maxDim && Math.max(screenWidth, screenHeight) > maxDim) image = downscale(image, maxDim);
  const { width, height, rgba } = image;
  return format === 'bmp'
    ? { data: rgbaToBmp(rgba, width, height), mimeType: 'image/bmp', width, height, screenWidth, screenHeight }
    : { data: rgbaToPng(rgba, width, height), mimeType: 'image/png', width, height, screenWidth, screenHeight };
}

// Reducción por promedio de área: cada píxel de salida promedia el bloque de origen que cubre.
function downscale({ width: sw, height: sh, rgba: src }, maxDim) {
  const scale = maxDim / Math.max(sw, sh);
  const width = Math.max(1, Math.round(sw * scale));
  const height = Math.max(1, Math.round(sh * scale));
  const dst = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor((y * sh) / height);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / height));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor((x * sw) / width);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / width));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let i = (yy * sw + x0) * 4, end = (yy * sw + x1) * 4; i < end; i += 4) {
          r += src[i];
          g += src[i + 1];
          b += src[i + 2];
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (y * width + x) * 4;
      dst[o] = r / n;
      dst[o + 1] = g / n;
      dst[o + 2] = b / n;
      dst[o + 3] = 255;
    }
  }
  return { width, height, rgba: dst };
}

function rgbaToBmp(rgba, width, height) {
  const row = Math.ceil((width * 3) / 4) * 4;
  const bmp = Buffer.alloc(54 + row * height);
  bmp.write('BM', 0);
  bmp.writeUInt32LE(bmp.length, 2);
  bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(width, 18);
  bmp.writeInt32LE(height, 22); // positivo: filas de abajo hacia arriba
  bmp.writeUInt16LE(1, 26);
  bmp.writeUInt16LE(24, 28);
  bmp.writeUInt32LE(row * height, 34);
  for (let y = 0; y < height; y++) {
    let src = y * width * 4;
    let dst = 54 + (height - 1 - y) * row;
    for (let x = 0; x < width; x++, src += 4, dst += 3) {
      bmp[dst] = rgba[src + 2];
      bmp[dst + 1] = rgba[src + 1];
      bmp[dst + 2] = rgba[src];
    }
  }
  return bmp;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// PNG RGB de 8 bits. Filtro Sub en cada fila: en capturas de UI deja casi todo en cero y
// deflate comprime mucho mejor.
function rgbaToPng(rgba, width, height) {
  const row = width * 3 + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    let o = y * row;
    raw[o++] = 1;
    let pr = 0;
    let pg = 0;
    let pb = 0;
    for (let x = 0, i = y * width * 4; x < width; x++, i += 4) {
      const r = rgba[i];
      const g = rgba[i + 1];
      const b = rgba[i + 2];
      raw[o++] = (r - pr) & 0xff;
      raw[o++] = (g - pg) & 0xff;
      raw[o++] = (b - pb) & 0xff;
      pr = r;
      pg = g;
      pb = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bits por canal
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// Ancho y alto de un PNG o BMP.
function imageSize(data) {
  if (data[0] === 0x42 && data[1] === 0x4d) return { width: data.readInt32LE(18), height: Math.abs(data.readInt32LE(22)) };
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

// ---------- Acciones de alto nivel ----------
// Las usan la API HTTP del visor (con hooks hacia su sesión en vivo) y el MCP cuando el visor
// no está corriendo (sin hooks).

const POSTURE_SETTLE_MS = 800;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createActions({ cachedState = () => null, afterInput = () => {}, afterPosture = async () => {} } = {}) {
  async function state(serial) {
    const cached = cachedState(serial);
    if (cached) return { serial, ...cached };
    return freshState(serial);
  }

  async function freshState(serial, states) {
    if (states) return { serial, ...(await readDisplayState(serial)), states };
    const [display, postureStates] = await Promise.all([readDisplayState(serial), readPostureStates(serial)]);
    return { serial, ...display, states: postureStates };
  }

  async function input(serial, cmd) {
    await adb(serial, ['shell', cmd]);
    afterInput(serial);
    return { ok: true };
  }

  return {
    devices: () => listTargets(),
    launch: ({ avd }) => launchAvd(avd),
    rotate: async ({ serial, direction }) => {
      await rotate(serial, direction);
      afterInput(serial);
      return { ok: true };
    },
    state: ({ serial }) => state(serial),
    tap: async ({ serial, x, y }) => input(serial, tapCommand(await state(serial), x, y)),
    swipe: async ({ serial, x1, y1, x2, y2, ms }) => input(serial, swipeCommand(await state(serial), x1, y1, x2, y2, ms)),
    key: ({ serial, key }) => input(serial, keyCommand(key)),
    text: ({ serial, text }) => input(serial, textCommand(text)),
    posture: async ({ serial, posture }) => {
      const { states } = await state(serial);
      await setPosture(serial, states, postureArg(states, posture));
      // El display tarda en cambiar de panel; antes de eso dumpsys aún da el tamaño viejo.
      await sleep(POSTURE_SETTLE_MS);
      const next = await freshState(serial, states);
      await afterPosture(serial, next);
      return next;
    },
    screenshot: async ({ serial, max }) =>
      screencap(serial, (await state(serial)).displayId, { maxDim: Number(max) || undefined }),
  };
}
