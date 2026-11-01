// Visor web del emulador de Android.
// Video: `adb exec-out screenrecord --output-format=h264 -` partido en access units y enviado
// por WebSocket; el navegador lo decodifica con WebCodecs. Input: `adb shell input`.
// Postura: `cmd device_state state <id>`.

import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import {
  ADB,
  SERIAL_RE,
  adb,
  resolveSerial,
  readDisplayState,
  readPostureStates,
  tapCommand,
  swipeCommand,
  keyCommand,
  postureArg,
  setPosture,
  screencap,
  rotate,
  createActions,
} from './lib/device.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 8093;
const HOST = process.env.HOST || '127.0.0.1';
const MAX_DIM = Number(process.env.MAX_DIM) || 1024; // lado mayor del video codificado
const BIT_RATE = process.env.BIT_RATE || '6M';
const POLL_MS = 1000;
// El último NAL del buffer solo se sabe completo cuando llega el siguiente start code.
// screenrecord escribe cada frame de una vez, así que un silencio lo da por terminado. adb
// entrega un frame en chunks con huecos de ~5 ms, y de más de 30 ms con dos emuladores
// codificando a la vez; si aun así se corta antes, el umbral se duplica. Mientras la pantalla
// cambia, el siguiente frame delimita al anterior antes: solo se retrasa el último de una ráfaga.
const TAIL_FLUSH_MS = 80;
const TAIL_FLUSH_MAX_MS = 400;
const MAX_CLIENT_BUFFER = 8 * 1024 * 1024;
const MAX_GOP_BYTES = 16 * 1024 * 1024;
const MIN_RESTART_GAP_MS = 2000;
const SNAPSHOT_AFTER_MS = 800;
// Un screenrecord arrancado en plena transición de display (plegar/desplegar) puede quedarse
// sin emitir nada; se espera a que se asiente y, si tras un input no llega ningún frame, se reinicia.
const DISPLAY_SETTLE_MS = 1000;
const INPUT_WATCHDOG_MS = 1500;
const MAX_BODY_BYTES = 64 * 1024;
const FLAG_KEY = 1;
const FLAG_CONFIG = 2;
const FLAG_IMAGE = 0x80; // captura BMP o PNG mientras no hay video

const START_CODE = Buffer.from([0, 0, 1]);

function log(...args) {
  console.log(new Date().toISOString().slice(11, 23), ...args);
}

function even8(n) {
  return Math.max(8, Math.round(n / 8) * 8);
}

class AnnexBSplitter {
  constructor(onNal, onPremature) {
    this.onNal = onNal;
    this.onPremature = onPremature;
    this.buf = Buffer.alloc(0);
    this.timer = null;
    this.tailMs = TAIL_FLUSH_MS;
    this.flushed = false;
  }

  push(chunk) {
    clearTimeout(this.timer);
    if (this.flushed && !(chunk[0] === 0 && chunk[1] === 0)) {
      // Llegó la continuación de un NAL que ya se dio por terminado.
      this.tailMs = Math.min(this.tailMs * 2, TAIL_FLUSH_MAX_MS);
      this.onPremature(this.tailMs);
    }
    this.flushed = false;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    let start = this.findStart(0);
    if (start < 0) {
      // Sin start code todavía; se conserva la cola por si quedó partido.
      this.buf = this.buf.subarray(Math.max(0, this.buf.length - 3));
      return;
    }
    let next;
    while ((next = this.findStart(start + 3)) >= 0) {
      this.onNal(this.buf.subarray(start, next));
      start = next;
    }
    this.buf = this.buf.subarray(start);
    this.timer = setTimeout(() => this.flush(), this.tailMs);
  }

  findStart(from) {
    const i = this.buf.indexOf(START_CODE, from);
    if (i < 0) return -1;
    return i - 1 >= from && this.buf[i - 1] === 0 ? i - 1 : i;
  }

  flush() {
    if (this.buf.length > 4) this.onNal(this.buf);
    this.buf = Buffer.alloc(0);
    this.flushed = true;
  }

  dispose() {
    clearTimeout(this.timer);
  }
}

let recorderSeq = 0;

class DeviceSession {
  constructor(serial) {
    this.serial = serial;
    this.clients = new Set();
    this.state = null;
    this.states = [];
    this.recorder = null;
    this.shell = null;
    this.pollTimer = null;
    this.restartTimer = null;
    this.snapshotTimer = null;
    this.backoff = 300;
    this.ready = null;
    this.pendingNals = [];
    // Desde el último IDR con SPS: un cliente nuevo lo recibe entero y queda al día sin
    // reiniciar screenrecord (que con la pantalla quieta no emite nada).
    this.gop = [];
    this.gopBytes = 0;
    this.lastStart = 0;
  }

  async add(ws) {
    this.clients.add(ws);
    if (!this.ready) this.ready = this.init();
    await this.ready;
    if (this.disposed || ws.readyState !== ws.OPEN) return;
    this.send(ws, this.meta());
    if (this.recorder || this.cycling) {
      if (this.streamInfo) this.send(ws, this.streamInfo);
      for (const au of this.gop) ws.send(au);
      if (!this.gop.length) this.sendSnapshot([ws]);
    } else {
      this.restart(0);
    }
  }

  remove(ws) {
    this.clients.delete(ws);
    if (this.clients.size === 0) this.dispose();
  }

  async init() {
    const help = await adb(this.serial, ['shell', 'screenrecord --help 2>&1']).catch(() => '');
    // Sin límite si la versión lo admite; si no, el bucle de reinicio cubre los 180 s.
    this.timeLimit = /Set to 0/.test(help) ? '0' : '180';
    this.states = await readPostureStates(this.serial);
    this.state = await readDisplayState(this.serial);
    if (this.disposed) return;
    this.pollTimer = setInterval(() => this.poll(), POLL_MS);
    log(this.serial, 'sesión', JSON.stringify(this.state), 'posturas', this.states.map((s) => s.name).join(','));
  }

  dispose() {
    log(this.serial, 'sin clientes; se detiene');
    this.disposed = true;
    clearInterval(this.pollTimer);
    clearTimeout(this.restartTimer);
    clearTimeout(this.snapshotTimer);
    clearTimeout(this.watchdogTimer);
    this.stopRecorder();
    this.shell?.kill();
    this.shell = null;
    sessions.delete(this.serial);
  }

  meta() {
    return { type: 'meta', serial: this.serial, ...this.state, states: this.states };
  }

  async poll() {
    if (this.polling) return;
    this.polling = true;
    const version = this.stateVersion;
    try {
      const next = await readDisplayState(this.serial);
      // Con el emulador cargado, dumpsys tarda segundos: si entretanto alguien aplicó un estado
      // más nuevo (p. ej. tras set_posture), este resultado ya es viejo.
      if (version === this.stateVersion) this.applyState(next);
    } catch (err) {
      log(this.serial, 'poll falló:', err.message);
    } finally {
      this.polling = false;
    }
  }

  applyState({ width, height, rotation, displayId, posture }) {
    const next = { width, height, rotation, displayId, posture };
    const prev = this.state;
    this.stateVersion = (this.stateVersion || 0) + 1;
    this.state = next;
    // Sesión aún en init(): no hay stream que reiniciar ni estado con qué comparar.
    if (!prev) return;
    const displayChanged =
      next.width !== prev.width ||
      next.height !== prev.height ||
      next.rotation !== prev.rotation ||
      next.displayId !== prev.displayId;
    if (displayChanged || next.posture?.id !== prev.posture?.id) {
      log(this.serial, 'cambio', JSON.stringify(next));
      this.broadcastJson(this.meta());
    }
    if (displayChanged) this.restart(DISPLAY_SETTLE_MS);
  }

  restart(delay = 150) {
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => this.cycle(), delay);
  }

  // Reinicio pedido por un cliente (error de decodificación, lag): limitado en frecuencia
  // para no tumbar el encoder del emulador con arranques en ráfaga.
  requestKeyframe() {
    this.restart(Math.max(150, this.lastStart + MIN_RESTART_GAP_MS - Date.now()));
  }

  async cycle() {
    if (this.cycling) {
      this.cycleAgain = true;
      return;
    }
    this.cycling = true;
    try {
      do {
        this.cycleAgain = false;
        await this.stopRecorder();
        if (this.clients.size && !this.disposed) this.startRecorder();
      } while (this.cycleAgain);
    } finally {
      this.cycling = false;
    }
  }

  startRecorder() {
    const { width, height, displayId } = this.state;
    const scale = Math.min(1, MAX_DIM / Math.max(width, height));
    const vw = even8(width * scale);
    const vh = even8(height * scale);
    const pidFile = `/data/local/tmp/android-view-${this.serial.replace(/\W/g, '_')}-${++recorderSeq}.pid`;
    const recordCmd = [
      'screenrecord',
      '--output-format=h264',
      `--size ${vw}x${vh}`,
      `--bit-rate ${BIT_RATE}`,
      `--time-limit ${this.timeLimit}`,
      displayId ? `--display-id ${displayId}` : '',
      '-',
    ].join(' ');
    // Se guarda el PID para matar screenrecord en el dispositivo: cortar adb no lo detiene
    // mientras la pantalla esté quieta (solo se entera al escribir el siguiente frame).
    const proc = spawn(ADB, ['-s', this.serial, 'exec-out', `sh -c 'echo $$ > ${pidFile}; exec ${recordCmd}'`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.pidFile = pidFile;
    proc.startedAt = this.lastStart = Date.now();
    proc.frames = 0;
    this.recorder = proc;
    this.pendingNals = [];
    this.gop = [];
    this.gopBytes = 0;
    const splitter = new AnnexBSplitter(
      (nal) => this.recorder === proc && this.onNal(nal, proc),
      (tailMs) => {
        log(this.serial, `NAL cortado antes de tiempo; umbral ahora ${tailMs} ms`);
        this.requestKeyframe();
      },
    );
    proc.stdout.on('data', (chunk) => splitter.push(chunk));
    proc.stderr.on('data', (d) => log(this.serial, 'screenrecord:', d.toString().trim()));
    proc.on('exit', (code, signal) => {
      splitter.dispose();
      if (this.recorder !== proc) return;
      this.recorder = null;
      adb(this.serial, ['shell', `rm -f ${pidFile}`]).catch(() => {});
      if (!this.clients.size) return;
      // Fin normal por límite de tiempo → reinicio inmediato; si muere al arrancar, con espera.
      const ranMs = Date.now() - proc.startedAt;
      this.backoff = ranMs > 3000 ? 300 : Math.min(this.backoff * 2, 5000);
      log(this.serial, `screenrecord terminó (code=${code} signal=${signal}, ${ranMs} ms); reinicio en ${this.backoff} ms`);
      this.restart(this.backoff);
    });
    log(this.serial, `screenrecord ${vw}x${vh} display=${displayId ?? 'default'}`);
    this.streamInfo = { type: 'stream-start', videoWidth: vw, videoHeight: vh };
    this.broadcastJson(this.streamInfo);
    // Con la pantalla quieta screenrecord no emite nada: se manda una captura mientras tanto.
    clearTimeout(this.snapshotTimer);
    this.snapshotTimer = setTimeout(() => {
      if (this.recorder === proc && proc.frames === 0) this.sendSnapshot([...this.clients]);
    }, SNAPSHOT_AFTER_MS);
  }

  async stopRecorder() {
    const proc = this.recorder;
    if (!proc) return;
    this.recorder = null;
    proc.kill('SIGTERM');
    // Espera a que muera en el dispositivo: dos screenrecord a la vez agotan el encoder por
    // software del emulador (err=-38) y lo dejan inestable.
    const f = proc.pidFile;
    await adb(this.serial, [
      'shell',
      `for i in 1 2 3 4 5 6 7 8 9 10; do [ -f ${f} ] && break; sleep 0.1; done; p=$(cat ${f} 2>/dev/null); ` +
        `if [ -n "$p" ]; then kill $p 2>/dev/null; for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do kill -0 $p 2>/dev/null || break; sleep 0.1; done; fi; rm -f ${f}`,
    ]).catch((err) => log(this.serial, 'no se pudo detener screenrecord:', err.message));
  }

  async sendSnapshot(targets) {
    const { displayId } = this.state;
    try {
      const { data } = await screencap(this.serial, displayId);
      const msg = Buffer.concat([Buffer.from([FLAG_IMAGE]), data]);
      for (const ws of targets) if (ws.readyState === ws.OPEN) ws.send(msg);
    } catch (err) {
      log(this.serial, 'screencap falló:', err.message);
    }
  }

  onNal(nal, proc) {
    const type = nal[nal[2] === 1 ? 3 : 4] & 0x1f;
    if (type !== 1 && type !== 5) {
      // SPS, PPS, SEI y AUD van pegados al siguiente frame.
      this.pendingNals.push(nal);
      return;
    }
    const hasSps = this.pendingNals.some((n) => (n[n[2] === 1 ? 3 : 4] & 0x1f) === 7);
    const flags = (type === 5 ? FLAG_KEY : 0) | (hasSps ? FLAG_CONFIG : 0);
    const au = Buffer.concat([Buffer.from([flags]), ...this.pendingNals, nal]);
    this.pendingNals = [];
    proc.frames++;
    proc.lastFrameAt = Date.now();
    if (type === 5 && hasSps) {
      this.gop = [au];
      this.gopBytes = au.length;
    } else if (this.gop.length) {
      this.gop.push(au);
      this.gopBytes += au.length;
      if (this.gopBytes > MAX_GOP_BYTES) {
        // Demasiado para reenviar; los clientes que lleguen piden un reinicio.
        this.gop = [];
        this.gopBytes = 0;
      }
    }
    let lagging = false;
    for (const ws of this.clients) {
      if (ws.readyState !== ws.OPEN) continue;
      if (ws.bufferedAmount > MAX_CLIENT_BUFFER) {
        lagging = true;
        continue;
      }
      ws.send(au);
    }
    // Un cliente que perdió frames necesita un IDR nuevo.
    if (lagging) this.requestKeyframe();
  }

  send(ws, obj) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }

  broadcastJson(obj) {
    for (const ws of this.clients) this.send(ws, obj);
  }

  input(cmd) {
    if (!this.shell || this.shell.exitCode !== null) {
      this.shell = spawn(ADB, ['-s', this.serial, 'shell'], { stdio: ['pipe', 'ignore', 'pipe'] });
      this.shell.stderr.on('data', (d) => log(this.serial, 'input:', d.toString().trim()));
      this.shell.on('error', (err) => log(this.serial, 'shell:', err.message));
    }
    if (process.env.DEBUG) log(this.serial, '>', cmd);
    this.shell.stdin.write(cmd + '\n');
    this.watchInput();
  }

  watchInput() {
    const proc = this.recorder;
    const sentAt = Date.now();
    clearTimeout(this.watchdogTimer);
    this.watchdogTimer = setTimeout(() => {
      if (proc && this.recorder === proc && !(proc.lastFrameAt >= sentAt)) {
        log(this.serial, 'sin frames tras el input; se reinicia screenrecord');
        this.requestKeyframe();
      }
    }, INPUT_WATCHDOG_MS);
  }

  async handle(msg, ws) {
    switch (msg.type) {
      case 'tap':
        this.input(tapCommand(this.state, msg.x, msg.y));
        break;
      case 'swipe':
        this.input(swipeCommand(this.state, msg.x1, msg.y1, msg.x2, msg.y2, msg.ms));
        break;
      case 'key':
        this.input(keyCommand(msg.key));
        break;
      case 'rotate':
        try {
          await rotate(this.serial, msg.direction);
          this.watchInput();
        } catch (err) {
          this.send(ws, { type: 'error', message: err.message });
        }
        break;
      case 'posture':
        try {
          await setPosture(this.serial, this.states, postureArg(this.states, msg.id));
        } catch (err) {
          this.send(ws, { type: 'error', message: err.message });
        }
        await this.poll();
        break;
      case 'restart':
        this.requestKeyframe();
        break;
    }
  }
}

const sessions = new Map();

// ---------- API HTTP (la usa el MCP) ----------
// Con alguien mirando el visor, las acciones pasan por su sesión: el panel se entera al momento
// y el watchdog vigila el stream. Sin visor abierto, adb directo.

const actions = createActions({
  cachedState: (serial) => {
    const session = sessions.get(serial);
    return session?.state ? { ...session.state, states: session.states } : null;
  },
  afterInput: (serial) => sessions.get(serial)?.watchInput(),
  afterPosture: (serial, next) => sessions.get(serial)?.applyState(next),
});

const API = {
  'GET /api/devices': actions.devices,
  'GET /api/state': actions.state,
  'POST /api/tap': actions.tap,
  'POST /api/swipe': actions.swipe,
  'POST /api/key': actions.key,
  'POST /api/text': actions.text,
  'POST /api/posture': actions.posture,
  'POST /api/rotate': actions.rotate,
  'POST /api/launch': actions.launch,
};

function isLocalOrigin(origin) {
  if (!origin) return true;
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Cuerpo demasiado grande'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {});
      } catch {
        reject(Object.assign(new Error('JSON inválido'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  if (url.pathname === '/api/screenshot' && req.method === 'GET') {
    const { data, mimeType } = await actions.screenshot({ serial: await resolveSerial(url.searchParams.get('serial')) });
    res.writeHead(200, { 'content-type': mimeType, 'cache-control': 'no-store' });
    res.end(data);
    return;
  }
  const handler = API[route];
  if (!handler) throw Object.assign(new Error('Ruta no encontrada'), { status: 404 });
  let params = Object.fromEntries(url.searchParams);
  if (req.method === 'POST') {
    // JSON obligatorio: una página ajena no puede mandarlo sin preflight CORS, que aquí no se concede.
    if (!/^application\/json\b/.test(req.headers['content-type'] || '') || !isLocalOrigin(req.headers.origin)) {
      throw Object.assign(new Error('Se requiere application/json desde un origen local'), { status: 403 });
    }
    params = { ...params, ...(await readJson(req)) };
  }
  if (route !== 'GET /api/devices' && route !== 'POST /api/launch') params.serial = await resolveSerial(params.serial);
  const result = await handler(params);
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(result));
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    const file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(PUBLIC + path.sep)) throw Object.assign(new Error('forbidden'), { status: 403 });
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch (err) {
    const status = err.status || (err.code === 'ENOENT' ? 404 : 500);
    if (url.pathname.startsWith('/api/')) {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
      return;
    }
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(status === 500 ? err.message : String(status));
  }
});

const wss = new WebSocketServer({
  server,
  path: '/ws',
  // Cualquier página abierta en el navegador podría conectarse a localhost y manejar el
  // dispositivo; solo se aceptan orígenes locales.
  verifyClient: ({ origin }) => isLocalOrigin(origin),
});

wss.on('connection', async (ws, req) => {
  const serial = new URL(req.url, 'http://x').searchParams.get('serial') || '';
  if (!SERIAL_RE.test(serial)) {
    ws.close(1008, 'serial inválido');
    return;
  }
  let session = sessions.get(serial);
  if (!session) {
    session = new DeviceSession(serial);
    sessions.set(serial, session);
  }
  ws.on('close', () => session.remove(ws));
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    session.handle(msg, ws).catch((err) => log(serial, 'mensaje falló:', err.message));
  });
  try {
    await session.add(ws);
  } catch (err) {
    log(serial, 'no se pudo iniciar:', err.message);
    session.send(ws, { type: 'error', message: err.message });
    ws.close();
  }
});

server.listen(PORT, HOST, () => log(`Android Viewer en http://${HOST === '127.0.0.1' ? 'localhost' : HOST}:${PORT}/ (adb: ${ADB})`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const s of [...sessions.values()]) s.dispose();
    // Margen para que los `kill` de screenrecord lleguen al dispositivo.
    setTimeout(() => process.exit(0), 500);
  });
}
