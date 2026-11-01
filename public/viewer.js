const $ = (s) => document.querySelector(s);
const canvas = $('#screen');
const ctx = canvas.getContext('2d');
const deviceSelect = $('#device');
const postureGroup = $('#postures');
const statusEl = $('#status');
const placeholder = $('#placeholder');
const placeholderText = $('#placeholder-text');
const launchButton = $('#launch');
const controls = $('.controls');

const POSTURE_LABELS = { CLOSED: 'Cerrado', HALF_OPENED: 'Medio', OPENED: 'Abierto', REAR_DISPLAY_MODE: 'Trasera' };
const TAP_SLOP_PX = 20; // en píxeles del dispositivo
const LONG_PRESS_MS = 500;
const TARGETS_REFRESH_MS = 4000;

let ws = null;
let serial = null;
let targets = [];
let selectedKey = null; // 'avd:<nombre>' o 'serial:<serial>'
const launching = new Set(); // AVDs pedidos que aún no aparecen en adb
let meta = null;
let decoder = null;
let spsKey = null;
let waitingKey = true;
let timestamp = 0;
let framesThisSecond = 0;
let videoSinceStart = false;
let fps = 0;

function send(obj) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ---------- Video ----------

function resetDecoder() {
  if (decoder && decoder.state !== 'closed') decoder.close();
  decoder = null;
  spsKey = null;
  waitingKey = true;
}

// Devuelve el string de codec y el SPS completo: si el SPS cambia dentro del mismo stream
// (otra resolución), hay que recrear el decoder aunque el codec sea el mismo.
function parseSps(au) {
  for (let i = 0; i + 6 < au.length; i++) {
    if (au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 1 && (au[i + 3] & 0x1f) === 7) {
      const hex = (b) => b.toString(16).padStart(2, '0');
      let end = i + 4;
      while (end + 2 < au.length && !(au[end] === 0 && au[end + 1] === 0 && au[end + 2] === 1)) end++;
      return {
        codec: `avc1.${hex(au[i + 4])}${hex(au[i + 5])}${hex(au[i + 6])}`,
        key: Array.from(au.subarray(i + 3, end), hex).join(''),
      };
    }
  }
  return null;
}

function createDecoder(sps) {
  resetDecoder();
  decoder = new VideoDecoder({
    output: drawFrame,
    error: (err) => {
      console.warn('VideoDecoder:', err.message, new Date().toLocaleTimeString());
      decoder = null;
      spsKey = null;
      waitingKey = true;
      send({ type: 'restart' }); // pide un IDR nuevo
    },
  });
  // Sin `description`: los chunks van en Annex B con SPS/PPS en banda.
  decoder.configure({ codec: sps.codec, optimizeForLatency: true });
  spsKey = sps.key;
}

async function drawSnapshot(image) {
  // BMP o PNG: el tipo se detecta por el contenido.
  const bitmap = await createImageBitmap(new Blob([image]));
  // Si ya llegó video, la captura (más lenta) quedaría vieja.
  if (!videoSinceStart) {
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    ctx.drawImage(bitmap, 0, 0);
    placeholder.hidden = true;
  }
  bitmap.close();
}

function onFrame(buf) {
  const flags = buf[0];
  const data = buf.subarray(1);
  if (flags & 0x80) {
    drawSnapshot(data).catch((err) => console.warn('captura:', err));
    return;
  }
  const isKey = (flags & 1) !== 0;
  if (flags & 2) {
    const sps = parseSps(data);
    if (sps && (sps.key !== spsKey || !decoder || decoder.state === 'closed')) createDecoder(sps);
  }
  if (!decoder || decoder.state !== 'configured') return;
  if (waitingKey && !isKey) return;
  waitingKey = false;
  timestamp += 16667;
  decoder.decode(new EncodedVideoChunk({ type: isKey ? 'key' : 'delta', timestamp, data }));
}

function drawFrame(frame) {
  if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
    canvas.width = frame.displayWidth;
    canvas.height = frame.displayHeight;
  }
  ctx.drawImage(frame, 0, 0);
  frame.close();
  videoSinceStart = true;
  framesThisSecond++;
  placeholder.hidden = true;
}

setInterval(() => {
  fps = framesThisSecond;
  framesThisSecond = 0;
  renderStatus();
}, 1000);

// ---------- Estado ----------

function renderStatus(text) {
  if (typeof text === 'string') {
    statusEl.textContent = text;
    return;
  }
  if (!meta) return;
  const posture = meta.posture ? ` · ${POSTURE_LABELS[meta.posture.name] ?? meta.posture.name}` : '';
  statusEl.textContent = `${meta.width}×${meta.height}${posture} · ${fps} fps`;
}

function renderPostures() {
  const states = meta?.states ?? [];
  postureGroup.hidden = states.length < 2;
  postureGroup.replaceChildren(
    ...states.map((s) => {
      const b = document.createElement('button');
      b.textContent = POSTURE_LABELS[s.name] ?? s.name;
      b.title = s.name;
      b.setAttribute('aria-pressed', String(meta.posture?.id === s.id));
      b.onclick = () => send({ type: 'posture', id: s.id });
      return b;
    }),
  );
  const reset = document.createElement('button');
  reset.textContent = 'Auto';
  reset.title = 'Quita la postura forzada (cmd device_state state reset)';
  reset.onclick = () => send({ type: 'posture', id: 'reset' });
  postureGroup.append(reset);
}

function onJson(msg) {
  if (msg.type === 'meta') {
    meta = msg;
    renderPostures();
    renderStatus();
  } else if (msg.type === 'stream-start') {
    resetDecoder();
    videoSinceStart = false;
  } else if (msg.type === 'error') {
    renderStatus(`Error: ${msg.message}`);
  }
}

// ---------- Dispositivos ----------

const keyOf = (t) => (t.avd ? `avd:${t.avd}` : `serial:${t.serial}`);
const selected = () => targets.find((t) => keyOf(t) === selectedKey);

function targetLabel(t) {
  const name = t.avd || t.model || t.serial;
  if (!t.serial) return `${name} · apagado`;
  return t.booted === false ? `${name} · arrancando…` : `${name} · ${t.serial}`;
}

function showMessage(text, { launch = false } = {}) {
  placeholder.hidden = false;
  placeholderText.textContent = text;
  launchButton.hidden = !launch;
  launchButton.disabled = false;
}

function setControlsEnabled(enabled) {
  controls.querySelectorAll('button').forEach((b) => (b.disabled = !enabled));
  controls.querySelector('.emu-only').hidden = !serial?.startsWith('emulator-');
}

function disconnect() {
  const socket = ws;
  ws = null;
  socket?.close();
  serial = null;
  meta = null;
  resetDecoder();
  canvas.width = canvas.height = 0;
  postureGroup.hidden = true;
  setControlsEnabled(false);
}

function connect(nextSerial) {
  disconnect();
  serial = nextSerial;
  showMessage('Conectando…');
  setControlsEnabled(true);
  const socket = new WebSocket(`ws://${location.host}/ws?serial=${encodeURIComponent(nextSerial)}`);
  socket.binaryType = 'arraybuffer';
  socket.onmessage = (e) => (typeof e.data === 'string' ? onJson(JSON.parse(e.data)) : onFrame(new Uint8Array(e.data)));
  socket.onclose = () => {
    if (ws !== socket) return;
    renderStatus('Desconectado; reintentando…');
    // Si el emulador se cerró, refreshTargets() muestra «apagado» en vez de reintentar.
    setTimeout(() => ws === socket && refreshTargets(true), 1500);
  };
  ws = socket;
}

// Aplica la selección: conecta, espera el arranque u ofrece iniciar el AVD.
function applySelection(force = false) {
  const t = selected();
  if (!t) return;
  if (t.serial && t.booted) launching.delete(t.avd);
  // booted null = el emulador no respondió a tiempo; se intenta igual, salvo si se acaba de lanzar.
  // Ya conectado a este serial: se queda aunque un refresco lo marque como no arrancado.
  const ready = t.booted === true || (t.booted === null && !launching.has(t.avd));
  if (t.serial && (ready || (t.serial === serial && ws))) {
    if (force || serial !== t.serial || !ws) connect(t.serial);
    return;
  }
  if (serial) disconnect();
  renderStatus('');
  if (t.serial || launching.has(t.avd)) showMessage(`${t.avd || t.serial} está arrancando…`);
  else showMessage(`${t.avd} está apagado.`, { launch: true });
}

async function refreshTargets(reconnect = false) {
  try {
    targets = await (await fetch('api/devices')).json();
  } catch {
    renderStatus('El visor no responde');
    return;
  }
  if (!targets.length) {
    deviceSelect.replaceChildren();
    disconnect();
    showMessage('No hay AVDs ni dispositivos en adb.');
    return;
  }
  if (!selected()) {
    const params = new URLSearchParams(location.search);
    const wanted =
      targets.find((t) => t.serial && t.serial === params.get('serial')) ||
      targets.find((t) => t.avd && t.avd === params.get('avd')) ||
      targets.find((t) => t.serial && t.booted !== false) ||
      targets[0];
    selectedKey = keyOf(wanted);
  }
  deviceSelect.replaceChildren(...targets.map((t) => new Option(targetLabel(t), keyOf(t))));
  deviceSelect.value = selectedKey;
  const t = selected();
  // Solo se reconecta si cambió algo: el emulador terminó de arrancar, se cerró o se cayó el WebSocket.
  if (reconnect || !(t.serial && t.serial === serial && ws)) applySelection(reconnect);
}

deviceSelect.onchange = () => {
  selectedKey = deviceSelect.value;
  const t = selected();
  history.replaceState(null, '', t.avd ? `?avd=${encodeURIComponent(t.avd)}` : `?serial=${encodeURIComponent(t.serial)}`);
  applySelection(true);
};

launchButton.onclick = async () => {
  const t = selected();
  launchButton.disabled = true;
  placeholderText.textContent = `Iniciando ${t.avd}…`;
  try {
    const res = await fetch('api/launch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ avd: t.avd }),
    });
    if (!res.ok) throw new Error((await res.json()).error);
    launching.add(t.avd);
    showMessage(`${t.avd} está arrancando…`);
  } catch (err) {
    showMessage(`No se pudo iniciar ${t.avd}: ${err.message}`, { launch: true });
  }
};

setInterval(() => refreshTargets(), TARGETS_REFRESH_MS);

// ---------- Controles ----------

document.querySelectorAll('[data-key]').forEach((b) => (b.onclick = () => send({ type: 'key', key: b.dataset.key })));
document.querySelectorAll('[data-rotate]').forEach((b) => (b.onclick = () => send({ type: 'rotate', direction: b.dataset.rotate })));

// Captura a resolución completa (la del canvas es la del video, reducida); el visor ya la da en PNG.
$('#screenshot').onclick = async () => {
  if (!serial) return;
  const t = selected();
  renderStatus('Guardando captura…');
  try {
    const res = await fetch(`api/screenshot?serial=${encodeURIComponent(serial)}`);
    if (!res.ok) throw new Error((await res.json()).error);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await res.blob());
    a.download = `${t?.avd || serial}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    renderStatus();
  } catch (err) {
    renderStatus(`Captura falló: ${err.message}`);
  }
};

// ---------- Input ----------

// Posición normalizada (0–1) dentro del video, descontando el letterbox de object-fit.
function toNorm(e) {
  const r = canvas.getBoundingClientRect();
  const ar = canvas.width / canvas.height;
  let w = r.width;
  let h = r.height;
  let ox = 0;
  let oy = 0;
  if (r.width / r.height > ar) {
    w = h * ar;
    ox = (r.width - w) / 2;
  } else {
    h = w / ar;
    oy = (r.height - h) / 2;
  }
  return { x: (e.clientX - r.left - ox) / w, y: (e.clientY - r.top - oy) / h };
}

const inside = (p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
let press = null;

canvas.addEventListener('pointerdown', (e) => {
  if (!meta || !canvas.width || e.button !== 0) return;
  const p = toNorm(e);
  if (!inside(p)) return;
  canvas.setPointerCapture(e.pointerId);
  press = { ...p, t: performance.now() };
});

canvas.addEventListener('pointerup', (e) => {
  if (!press) return;
  const p = toNorm(e);
  const end = { x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)) };
  const ms = performance.now() - press.t;
  const dist = Math.hypot((end.x - press.x) * meta.width, (end.y - press.y) * meta.height);
  if (dist < TAP_SLOP_PX && ms < LONG_PRESS_MS) send({ type: 'tap', x: press.x, y: press.y });
  else if (dist < TAP_SLOP_PX) send({ type: 'swipe', x1: press.x, y1: press.y, x2: press.x, y2: press.y, ms });
  else send({ type: 'swipe', x1: press.x, y1: press.y, x2: end.x, y2: end.y, ms: Math.max(ms, 100) });
  press = null;
});

canvas.addEventListener('pointercancel', () => (press = null));

let lastWheel = 0;
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const now = performance.now();
    if (!meta || now - lastWheel < 300) return;
    const p = toNorm(e);
    if (!inside(p)) return;
    lastWheel = now;
    const dy = Math.sign(e.deltaY) * 0.25;
    send({ type: 'swipe', x1: p.x, y1: p.y, x2: p.x, y2: Math.min(1, Math.max(0, p.y - dy)), ms: 150 });
  },
  { passive: false },
);

if (!('VideoDecoder' in window)) {
  showMessage('Este navegador no tiene WebCodecs (VideoDecoder).');
} else {
  setControlsEnabled(false);
  refreshTargets();
}
