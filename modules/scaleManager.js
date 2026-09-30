/**
 * Real weighing-scale bridge, for a scale that talks RS232 (via a USB-to-serial cable, showing up
 * as a COM port) or exposes a raw TCP/network stream. A third connection type — "keyboard-wedge" —
 * needs NO code here at all: that kind of scale just types its reading as keystrokes into whatever
 * input is focused, exactly like a keyboard-wedge barcode scanner, so it's handled by the same
 * scan-capture input the POS/product-form already use for barcodes.
 *
 * One physical scale is wired to one physical till, so connections are cached per config (not per
 * request/tenant-store, which is rebuilt fresh on every request) — opening/closing a COM port on
 * every `GET /hardware/weight` poll is slow and many scales/drivers don't like rapid reconnects.
 *
 * Two read modes cover the scales on the market:
 *   - 'continuous': the scale streams a line every few hundred ms (most retail/Indian scales);
 *   - 'poll':       the scale only answers a request command (CAS "\x05", Toledo "W", MT-SICS "SI\r\n"),
 *                   which is sent every `pollIntervalMs`.
 * Line framing is auto-detected: CR, LF, CRLF and STX/ETX frames all work, and a frame with no
 * terminator at all is flushed after a short idle gap.
 */
const net = require('net');

let SerialPort = null;
try {
  ({ SerialPort } = require('serialport'));
} catch {
  // serialport not installed / native binding unavailable on this platform — network and
  // keyboard-wedge scales still work; a request for a serial connection returns a clear error.
}

const connections = new Map();

const STALE_MS = 10000;
const RECONNECT_DELAY_MS = 3000;
const IDLE_FLUSH_MS = 150;
const MAX_BUFFER = 512;
const RAW_HISTORY = 100;
// A new weight is only accepted (shown, billed) once the scale has sent it this many times in a row —
// a reading still changing, or a one-off glitch, never reaches the screen. `cfg.confirmReadings` overrides it.
const CONFIRM_READINGS = 5;
const MAX_CONFIRM_WAIT_MS = 30000;

function confirmCount(cfg) {
  const n = Math.floor(Number(cfg && cfg.confirmReadings));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 100) : CONFIRM_READINGS;
}

/** How far (in the display unit) readings may wander and still count as "the same" weight. Default 0 = exactly identical. */
function stabilityTolerance(cfg, weight = 0) {
  const n = Number(cfg && cfg.stabilityTolerance);
  if (Number.isFinite(n) && n > 0) return n;
  // Not set: allow the last digit or two of a live pan to wander (retail scales flicker by a few grams),
  // and 0.5% of the load on top of that — noise grows with weight, so a fixed band would never settle at 5 kg.
  const unitKg = UNIT_TO_KG[normaliseUnit(cfg && cfg.unit) || 'kg'] || 1;
  return Math.max(DEFAULT_TOLERANCE_KG / unitKg, 0.005 * Math.abs(weight));
}

const DEFAULT_TOLERANCE_KG = 0.015;
const UNIT_TO_KG = { kg: 1, g: 0.001, lb: 0.45359237, oz: 0.028349523125 };

function normaliseUnit(unit) {
  const u = String(unit || '').trim().toLowerCase();
  if (u === 'kg' || u === 'kgs') return 'kg';
  if (u === 'g' || u === 'gm' || u === 'gms' || u === 'gr' || u === 'grams') return 'g';
  if (u === 'lb' || u === 'lbs') return 'lb';
  if (u === 'oz') return 'oz';
  return null;
}

/** Turns "\r", "\n", "\t" and "\x05"-style escapes typed into Settings into the raw bytes a poll command needs. */
function decodeEscapes(text) {
  const decoded = String(text || '').replace(/\\x([0-9a-fA-F]{2})|\\r|\\n|\\t/g, (m, hex) => {
    if (hex) return String.fromCharCode(parseInt(hex, 16));
    return { '\\r': '\r', '\\n': '\n', '\\t': '\t' }[m];
  });
  return Buffer.from(decoded, 'latin1');
}

function stabilityFlag(text) {
  // ST/US: CAS, A&D, most Chinese/Indian retail scales. "S S"/"S D": Mettler-Toledo MT-SICS.
  if (/\bUS\b|^S\s+D\b|\bMOTION\b/i.test(text)) return false;
  if (/\bST\b|^S\s+S\b|\bSTABLE\b/i.test(text)) return true;
  return null;
}

/**
 * Parses one line from the scale into a weight in the configured display unit (`cfg.unit`,
 * default kg). Understands a unit suffix on the reading (kg/g/lb/oz — converted), a sign
 * separated from the digits by spaces ("-  0.500"), a comma decimal separator, implied decimals
 * (`cfg.decimals` for scales that send "001234" meaning 1.234), and ST/US stability flags.
 * `cfg.weightPattern` is an escape hatch for unusual formats: a regex whose first capture group
 * is the number (and optional second group the unit). Returns null for lines with no weight.
 */
function parseScaleLine(line, cfg = {}) {
  const text = String(line).replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  if (!text) return null;

  if (/\bOL\b|\bO-L\b|OVERLOAD|\bOVER\b/i.test(text)) return { overload: true, raw: text };

  const displayUnit = normaliseUnit(cfg.unit) || 'kg';
  let numText = null;
  let unitText = null;

  if (cfg.weightPattern) {
    let re;
    try {
      re = new RegExp(cfg.weightPattern, 'i');
    } catch {
      return null;
    }
    const m = text.match(re);
    if (!m) return null;
    numText = (m[1] ?? m[0]).replace(/\s+/g, '');
    unitText = m[2] || null;
  } else {
    // Prefer the number that carries a unit ("01 ST,GS,+001.234kg" → 1.234, not the scale id 01).
    const re = /([+-]?)\s*(\d+(?:[.,]\d+)?)\s*(kgs?|gms?|grams|gr|g|lbs?|oz)?(?![a-z])/gi;
    let first = null;
    let withUnit = null;
    let m;
    while ((m = re.exec(text))) {
      if (!first) first = m;
      if (m[3]) {
        withUnit = m;
        break;
      }
    }
    const pick = withUnit || first;
    if (!pick) return null;
    numText = `${pick[1] || ''}${pick[2]}`;
    unitText = pick[3] || null;
  }

  const hasDecimalPoint = /[.,]/.test(numText);
  let value = Number(numText.replace(',', '.'));
  if (!Number.isFinite(value)) return null;

  const decimals = Number(cfg.decimals) || 0;
  if (decimals > 0 && !hasDecimalPoint) value /= Math.pow(10, decimals);

  const sourceUnit = normaliseUnit(unitText) || displayUnit;
  const weight = Math.round(((value * UNIT_TO_KG[sourceUnit]) / UNIT_TO_KG[displayUnit]) * 1000) / 1000;

  return { weight, unit: displayUnit, stable: stabilityFlag(text), raw: text };
}

/** Everything that changes how the scale is opened or parsed — a change to any of these means a new connection. */
function keyFor(cfg) {
  const endpoint = endpointFor(cfg);
  const opts = [cfg.baudRate, cfg.dataBits, cfg.parity, cfg.stopBits, cfg.readMode, cfg.pollCommand, cfg.pollIntervalMs];
  return `${endpoint}|${opts.join('|')}`;
}

function endpointFor(cfg) {
  return cfg.connectionType === 'serial' ? `serial:${cfg.comPort}` : `network:${cfg.host}:${cfg.port}`;
}

function pushRaw(conn, line) {
  conn.rawLines.push({ at: new Date().toISOString(), line });
  if (conn.rawLines.length > RAW_HISTORY) conn.rawLines.shift();
}

function handleLine(conn, line) {
  if (!line.replace(/[\x00-\x20]/g, '')) return;
  pushRaw(conn, line.replace(/[\x00-\x1f\x7f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`));

  // A line with bytes no scale prints (above 0x7E) was damaged on the wire — wrong baud/parity, a bad
  // cable or a stuck adapter. Dropped rather than parsed, or a mangled "000.23Sø" would bill as 0.23.
  // (Scales set up as 7-bit are unaffected: their high bit is already stripped by the port.)
  if (/[-ÿ]/.test(line)) {
    conn.badLines = (conn.badLines || 0) + 1;
    return;
  }

  // Parsed with the latest config each time, so unit/decimals/pattern edits apply without a reconnect.
  const parsed = parseScaleLine(line, conn.cfg);
  if (!parsed) return;

  conn.lastAt = Date.now();
  conn.error = null;
  if (parsed.overload) {
    conn.overload = true;
    return;
  }
  conn.overload = false;
  conn.lastWeight = parsed.weight;
  // Settled = the latest N readings all sit inside the tolerance band (a sliding window, so slow drift
  // and a flickering last digit don't restart the wait). The confirmed weight is the middle of that window.
  const need = confirmCount(conn.cfg);
  const w = parsed.weight;
  const tol = stabilityTolerance(conn.cfg, w) + 1e-9;
  conn.window.push(w);
  while (conn.window.length > need) conn.window.shift();
  conn.candidate = w;

  // How many of the most recent readings agree (shown as progress while waiting).
  let lo = w;
  let hi = w;
  let agree = 0;
  for (let i = conn.window.length - 1; i >= 0; i--) {
    lo = Math.min(lo, conn.window[i]);
    hi = Math.max(hi, conn.window[i]);
    if (hi - lo > tol) break;
    agree += 1;
  }
  conn.candidateCount = agree;
  conn.settled = conn.window.length >= need && agree >= need;
  if (conn.settled) {
    const sorted = conn.window.slice().sort((x, y) => x - y);
    conn.confirmedWeight = sorted[Math.floor(sorted.length / 2)];
  }
  conn.lastRaw = parsed.raw;
}

function handleChunk(conn, chunk) {
  conn.bytesIn += chunk.length;
  conn.buffer += chunk.toString('latin1');
  const parts = conn.buffer.split(/[\r\n\x02\x03]+/);
  conn.buffer = parts.pop();
  for (const line of parts) handleLine(conn, line);

  if (conn.buffer.length > MAX_BUFFER) conn.buffer = conn.buffer.slice(-MAX_BUFFER);

  // Some scales send a fixed-width frame with no terminator at all — flush it once the line goes quiet.
  clearTimeout(conn.idleTimer);
  if (conn.buffer) {
    conn.idleTimer = setTimeout(() => {
      const pending = conn.buffer;
      conn.buffer = '';
      handleLine(conn, pending);
    }, IDLE_FLUSH_MS);
  }
}

/** Stable = the latest reading has been received CONFIRM_READINGS times in a row, i.e. no change is pending. The scale's own ST/US flag is not used. */
function isStable(conn) {
  return conn.confirmedWeight !== null && conn.settled;
}

function markError(conn, message) {
  conn.error = message;
  conn.failedAt = Date.now();
  conn.connected = false;
}

function startPolling(cfg, conn) {
  if (cfg.readMode !== 'poll' || !cfg.pollCommand) return;
  const command = decodeEscapes(cfg.pollCommand);
  const interval = Math.max(100, Number(cfg.pollIntervalMs) || 500);
  conn.pollTimer = setInterval(() => {
    if (conn.connected && conn.write) conn.write(command);
  }, interval);
}

function openSerial(cfg, conn) {
  if (!SerialPort) {
    markError(conn, 'Serial support is not available on this server (serialport module failed to load).');
    return;
  }
  try {
    // A Bluetooth COM port can take seconds to open. If this connection is closed meanwhile (Settings
    // saved/tested, scale switched off), the open must still be undone once it lands — otherwise the
    // orphaned port keeps COM3 locked and every later open fails with "Access denied".
    let closing = false;
    const release = (port) => {
      try {
        if (port.isOpen) port.close(() => {});
      } catch {
        /* already closed */
      }
    };
    const port = new SerialPort(
      {
        path: cfg.comPort,
        baudRate: Number(cfg.baudRate) || 9600,
        dataBits: Number(cfg.dataBits) || 8,
        parity: cfg.parity || 'none',
        stopBits: Number(cfg.stopBits) || 1
      },
      (err) => {
        if (closing) return release(port);
        if (err) return markError(conn, `Could not open ${cfg.comPort}: ${err.message}`);
        conn.connected = true;
        console.log(`[scale] ${cfg.comPort} opened`);
      }
    );
    port.on('data', (chunk) => {
      if (!closing) handleChunk(conn, chunk);
    });
    port.on('error', (err) => {
      console.warn(`[scale] ${cfg.comPort} error: ${err.message}`);
      if (!closing) markError(conn, `${cfg.comPort}: ${err.message}`);
    });
    port.on('close', (err) => {
      console.warn(`[scale] ${cfg.comPort} closed${err && err.disconnected ? ' (disconnected)' : ''}`);
      if (!closing) markError(conn, err && err.disconnected ? `${cfg.comPort} was disconnected (cable unplugged / scale switched off?).` : `${cfg.comPort} was closed.`);
    });
    conn.write = (buf) => port.isOpen && port.write(buf);
    conn.close = () => {
      closing = true;
      release(port);
    };
  } catch (err) {
    markError(conn, err.message);
  }
}

function openNetwork(cfg, conn) {
  try {
    const socket = new net.Socket();
    const where = `${cfg.host}:${cfg.port}`;
    // Only the connect attempt is timed — once connected, a scale that sends nothing while the pan is
    // untouched is normal, and staleness is reported separately.
    socket.setTimeout(5000);
    socket.connect(Number(cfg.port), cfg.host, () => {
      socket.setTimeout(0);
      socket.setKeepAlive(true, 10000);
      conn.connected = true;
      conn.error = null;
    });
    socket.on('data', (chunk) => handleChunk(conn, chunk));
    socket.on('timeout', () => {
      markError(conn, `No response from ${where} (timed out).`);
      socket.destroy();
    });
    socket.on('error', (err) => markError(conn, `Could not reach ${where}: ${err.message}`));
    socket.on('close', () => {
      if (!conn.error) markError(conn, `Connection to ${where} was closed.`);
    });
    conn.write = (buf) => !socket.destroyed && socket.write(buf);
    conn.close = () => socket.destroy();
  } catch (err) {
    markError(conn, err.message);
  }
}

function closeConnection(key) {
  const conn = connections.get(key);
  if (!conn) return;
  connections.delete(key);
  clearInterval(conn.pollTimer);
  clearTimeout(conn.idleTimer);
  try {
    conn.close && conn.close();
  } catch {
    /* already closed */
  }
}

function ensureConnection(cfg) {
  const key = keyFor(cfg);
  let conn = connections.get(key);

  // A failed/unplugged connection is retried (after a short backoff) instead of staying dead until restart.
  if (conn && conn.error && Date.now() - conn.failedAt >= RECONNECT_DELAY_MS) {
    closeConnection(key);
    conn = null;
  }
  if (conn) {
    conn.cfg = cfg;
    return conn;
  }

  // Same COM port / host with different settings — release the old handle first, or the port stays locked.
  const endpoint = endpointFor(cfg);
  for (const [otherKey, other] of connections) {
    if (endpointFor(other.cfg) === endpoint) closeConnection(otherKey);
  }

  conn = {
    cfg,
    lastWeight: null,
    lastAt: null,
    lastRaw: null,
    candidate: null,
    candidateCount: 0,
    window: [],
    settled: false,
    confirmedWeight: null,
    rawLines: [],
    buffer: '',
    bytesIn: 0,
    overload: false,
    connected: false,
    error: null,
    failedAt: null,
    openedAt: Date.now(),
    close: null,
    write: null
  };
  connections.set(key, conn);
  if (cfg.connectionType === 'serial') openSerial(cfg, conn);
  else if (cfg.connectionType === 'network') openNetwork(cfg, conn);
  startPolling(cfg, conn);
  return conn;
}

function checkConfig(cfg) {
  if (!cfg || (cfg.connectionType !== 'serial' && cfg.connectionType !== 'network')) return 'NOT_CONFIGURED';
  if (cfg.connectionType === 'serial' && !cfg.comPort) return 'NO_COM_PORT';
  if (cfg.connectionType === 'network' && (!cfg.host || !cfg.port)) return 'NO_HOST';
  return null;
}

/**
 * Returns the scale's current reading, or a reason it can't be read yet. Never throws — a
 * disconnected/misconfigured scale is a normal, expected state for the caller to show in the UI.
 * `weight` is signed: a negative reading means the scale needs re-zeroing, and callers must not bill it.
 */
function getLiveReading(cfg) {
  const configError = checkConfig(cfg);
  if (configError) return { ok: false, reason: configError };

  const conn = ensureConnection(cfg);
  if (conn.error) return { ok: false, reason: 'CONNECTION_ERROR', message: conn.error };
  if (conn.lastAt === null) {
    return {
      ok: false,
      reason: 'NO_READING_YET',
      message: conn.bytesIn > 0
        ? conn.badLines > 0
          ? 'The scale data is garbled — check the baud rate, cable and connector, or unplug and re-plug the USB adapter.'
          : 'Scale is sending data, but no weight could be read from it — check the data format in Settings → Hardware.'
        : undefined
    };
  }

  const ageMs = Date.now() - conn.lastAt;
  if (ageMs > STALE_MS) {
    return {
      ok: false,
      reason: 'STALE',
      message: cfg.readMode === 'poll'
        ? 'Scale has stopped answering the poll command.'
        : 'Scale has not reported a new reading in over 10s. If it only sends on request, switch Read mode to "Poll".'
    };
  }
  if (conn.overload) return { ok: false, reason: 'OVERLOAD', message: 'Scale is overloaded — remove some weight.' };
  if (conn.confirmedWeight === null) {
    return {
      ok: false,
      reason: 'NO_READING_YET',
      message: `Waiting for the scale to send the same reading ${confirmCount(cfg)} times (${conn.candidateCount} so far).`,
      progress: conn.candidateCount
    };
  }

  return {
    ok: true,
    // The last confirmed weight — a change shows only after it has repeated enough times.
    weight: conn.confirmedWeight,
    unit: normaliseUnit(cfg.unit) || 'kg',
    stable: isStable(conn),
    raw: conn.lastRaw,
    readAt: new Date(conn.lastAt).toISOString()
  };
}

const TRANSIENT_REASONS = new Set(['NO_READING_YET', 'STALE']);

/**
 * Like getLiveReading, but gives a freshly opened connection (or a poll-mode scale) up to
 * `timeoutMs` to deliver a reading — so the very first "Read weight" after a restart doesn't fail.
 * With `requireStable`, also waits for the scale to settle — on a reading taken after this call
 * started, so a click right after swapping items can't return the previous item's stable weight.
 * A scale that only sends on change gets its latest reading once the timeout passes.
 */
async function waitForReading(cfg, { timeoutMs = 2500, requireStable = false } = {}) {
  const startedAt = Date.now();
  let deadline = startedAt + timeoutMs;
  let reading = getLiveReading(cfg);
  // While the same reading keeps repeating toward the confirmation count, keep waiting (the wait
  // depends on how fast this scale sends) — but never past MAX_CONFIRM_WAIT_MS in total, and only
  // while the count is actually growing, so a pan that keeps changing can't hold the request open.
  const hardStop = startedAt + MAX_CONFIRM_WAIT_MS;
  let lastProgress = 0;
  while (Date.now() < deadline) {
    if (!reading.ok && reading.reason === 'NO_READING_YET' && reading.progress > lastProgress) {
      lastProgress = reading.progress;
      deadline = Math.min(hardStop, Math.max(deadline, Date.now() + 1500));
    }
    if (reading.ok && (!requireStable || (reading.stable && Date.parse(reading.readAt) >= startedAt))) return reading;
    if (!reading.ok && !TRANSIENT_REASONS.has(reading.reason)) return reading;
    await new Promise((r) => setTimeout(r, 100));
    reading = getLiveReading(cfg);
  }
  return reading;
}

/** The middle of the latest readings — a smoothed live weight for display (billing uses the settled reading). null when there is none fresh. */
function displayWeight(cfg) {
  const conn = connections.get(keyFor(cfg));
  if (!conn || conn.error || !conn.window.length || conn.lastAt === null || Date.now() - conn.lastAt > STALE_MS || conn.overload) return null;
  const sorted = conn.window.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** What the scale has actually been sending — for Settings → Hardware, to work out a scale's data format. */
function getDiagnostics(cfg) {
  const configError = checkConfig(cfg);
  if (configError) return { configured: false, reason: configError };
  const conn = ensureConnection(cfg);
  return {
    configured: true,
    connected: conn.connected,
    error: conn.error,
    bytesReceived: conn.bytesIn,
    lastWeight: conn.lastWeight,
    lastReadAt: conn.lastAt ? new Date(conn.lastAt).toISOString() : null,
    rawLines: conn.rawLines.slice()
  };
}

/** Releases the port for this scale config — called when Settings change or the scale is disabled. */
function closeFor(cfg) {
  if (!cfg) return;
  const endpoint = endpointFor(cfg);
  for (const [key, conn] of connections) {
    if (endpointFor(conn.cfg) === endpoint) closeConnection(key);
  }
}

/* ------------------------------ auto-detection ------------------------------ */

// Most retail scales stream at 9600; the rest are covered by the others, most common first.
const DETECT_BAUDS = [9600, 4800, 2400, 19200, 1200, 38400];
const DETECT_LISTEN_MS = 1300;
// "Nothing found" is re-checked after this long even with the same ports — the scale may have been
// plugged in but switched off last time.
const DETECT_CACHE_MS = 2 * 60 * 1000;
let lastDetect = null;

/** Opens `path` read-only for `ms` and returns what arrived — null if the port can't be opened. Never writes. */
function listenOnPort(path, baudRate, ms) {
  return new Promise((resolve) => {
    const chunks = [];
    let port;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (port && port.isOpen) port.close(() => {});
      resolve(value);
    };
    const timer = setTimeout(() => finish(Buffer.concat(chunks)), ms + 1500); // hard stop if open hangs
    try {
      port = new SerialPort({ path, baudRate, dataBits: 8, parity: 'none', stopBits: 1 }, (err) => {
        if (err) return finish(null);
        setTimeout(() => finish(Buffer.concat(chunks)), ms);
      });
      port.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      port.on('error', () => finish(null));
    } catch {
      finish(null);
    }
  });
}

/**
 * Does this sample look like a weighing scale? Tried as-is and with the top bit stripped: a 7-E-1
 * scale read at 8-N-1 arrives with its parity bit as bit 8, and stripping it recovers the text.
 */
function weightFromSample(buf) {
  const variants = [
    { bytes: buf, sevenBit: false },
    { bytes: Buffer.from(buf.map((b) => b & 0x7f)), sevenBit: true }
  ];
  for (const { bytes, sevenBit } of variants) {
    // A scale sends plain text. Wrong framing (e.g. 7-E-1 read as 8-N-1) garbles some bytes, and a
    // stray digit in the garbage must not pass as a weight — so the text has to be almost all clean.
    const clean = bytes.filter((b) => (b >= 0x20 && b <= 0x7e) || b === 0x0d || b === 0x0a || b === 0x02 || b === 0x03).length;
    if (clean < bytes.length * 0.97) continue;
    const lines = bytes.toString('latin1').split(/[\r\n\x02\x03]+/).map((l) => l.trim()).filter(Boolean);
    const readings = lines.map((l) => parseScaleLine(l, {})).filter((p) => p && !p.overload);
    if (readings.length >= 2) return { weight: readings.at(-1).weight, sevenBit, sample: lines.at(-1) };
  }
  return null;
}

/**
 * Finds weighing scales on this PC's COM ports by listening for weight lines — only ever reading,
 * so a receipt printer or other device on a COM port is never sent anything. Covers scales that
 * stream their reading (most retail scales); a scale that only answers a request command needs
 * setting up by hand. Bluetooth virtual ports are skipped: opening one can hang for seconds.
 * Results are cached per set of ports, so calling this on every Billing visit is cheap.
 */
async function detectScales({ force = false } = {}) {
  if (!SerialPort) return { scanned: [], found: [], error: 'Serial support is not available on this server.' };

  let ports = [];
  try {
    ports = await SerialPort.list();
  } catch {
    ports = [];
  }
  const candidates = ports.filter((p) => !/BTHENUM/i.test(p.pnpId || ''));
  const key = candidates.map((p) => p.path).sort().join(',');
  const fresh = lastDetect && lastDetect.key === key && (lastDetect.result.found.length || Date.now() - lastDetect.at < DETECT_CACHE_MS);
  if (!force && fresh) return { ...lastDetect.result, cached: true };

  // Our own open scale connection would make its port look busy.
  closeAll();

  const found = [];
  let remaining = candidates.map((p) => p.path);
  for (const baudRate of DETECT_BAUDS) {
    if (!remaining.length) break;
    const samples = await Promise.all(remaining.map(async (path) => ({ path, buf: await listenOnPort(path, baudRate, DETECT_LISTEN_MS) })));
    const retry = [];
    for (const { path, buf } of samples) {
      if (!buf || !buf.length) continue; // busy, missing, or silent — not a streaming scale
      const hit = weightFromSample(buf);
      if (hit) {
        const info = candidates.find((p) => p.path === path) || {};
        found.push({
          path,
          baudRate,
          dataBits: hit.sevenBit ? 7 : 8,
          parity: hit.sevenBit ? 'even' : 'none',
          stopBits: 1,
          weight: hit.weight,
          sample: hit.sample,
          manufacturer: info.manufacturer || null
        });
      } else {
        retry.push(path); // data, but unreadable: probably the wrong speed
      }
    }
    remaining = retry;
  }

  const result = { scanned: candidates.map((p) => p.path), found };
  lastDetect = { key, at: Date.now(), result };
  return result;
}

/** Lists actual COM ports present on this machine, for a Settings-page port picker. */
async function listSerialPorts() {
  if (!SerialPort) return [];
  try {
    const ports = await SerialPort.list();
    return ports.map((p) => ({ path: p.path, manufacturer: p.manufacturer || null }));
  } catch {
    return [];
  }
}

function closeAll() {
  for (const key of [...connections.keys()]) closeConnection(key);
}

/** Test hook — swaps in a mock SerialPort class (e.g. built on @serialport/binding-mock). */
function _setSerialPortImpl(impl) {
  SerialPort = impl;
  lastDetect = null;
}

module.exports = {
  getLiveReading,
  displayWeight,
  waitForReading,
  getDiagnostics,
  parseScaleLine,
  decodeEscapes,
  detectScales,
  listSerialPorts,
  closeFor,
  closeAll,
  connectionKey: keyFor,
  _setSerialPortImpl
};
