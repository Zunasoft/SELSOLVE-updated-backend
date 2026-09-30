/**
 * Cash-drawer kick — the drawer has no connection of its own, it's wired via RJ11 into the
 * receipt printer, and "opening" it means sending a raw ESC/POS pulse command out over whatever
 * connects to that printer:
 *   - 'serial':        a USB-to-serial cable / virtual COM port;
 *   - 'network':       a network printer listening on its raw ESC/POS port (9100 by default);
 *   - 'windows-share': a USB printer installed with its Windows driver and shared (Printer
 *                      properties → Sharing) — the bytes are copied raw to \\localhost\<share>,
 *                      which is how most USB thermal printers in a shop are actually set up.
 * This is independent of window.print(), which the frontend still uses to render the receipt itself
 * via the OS print driver; the kick command bypasses that entirely since a rendered/rasterized print
 * job can't carry raw control bytes reliably.
 *
 * Unlike the weighing scale, this isn't a persistent stream to read — it's one short write per
 * open, so each call gets its own short-lived connection rather than a cached one.
 */
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

let SerialPort = null;
try {
  ({ SerialPort } = require('serialport'));
} catch {
  // serialport not installed / native binding unavailable — network drawers still work.
}

// ESC p m t1 t2 — "generate pulse to drawer-kick pin", the standard ESC/POS command essentially
// every receipt printer with a drawer jack supports (pin 2, ~50ms on / 500ms off).
const DRAWER_KICK_BYTES = Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]);

// Share names go into a `copy` command line, so only plain name characters are accepted.
const SHARE_NAME_RE = /^(\\\\[A-Za-z0-9.\-_]+\\)?[A-Za-z0-9 .\-_$]+$/;

function openSerialDrawer(cfg) {
  return new Promise((resolve) => {
    if (!SerialPort) return resolve({ ok: false, message: 'Serial support is not available on this server.' });
    if (!cfg.comPort) return resolve({ ok: false, message: 'No COM port configured for the printer/drawer.' });

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    // A flaky USB-to-serial adapter can open but never fire its write/drain callback, which would
    // otherwise hang this request (and the per-tenant persist queue behind it) forever — matches the
    // timeouts already on the network (3s) and shared-printer (8s execFile) drawer paths.
    const timer = setTimeout(() => finish({ ok: false, message: `Timed out waiting for ${cfg.comPort} to respond.` }), 5000);

    const port = new SerialPort({ path: cfg.comPort, baudRate: Number(cfg.baudRate) || 9600 }, (err) => {
      if (err) return finish({ ok: false, message: `Could not open ${cfg.comPort}: ${err.message}` });
      port.write(DRAWER_KICK_BYTES, (writeErr) => {
        if (writeErr) {
          port.close(() => {});
          return finish({ ok: false, message: writeErr.message });
        }
        // write() only hands the bytes to the OS — drain before closing or the pulse can be cut off.
        port.drain(() => {
          port.close(() => {});
          finish({ ok: true });
        });
      });
    });
  });
}

function openNetworkDrawer(cfg) {
  return new Promise((resolve) => {
    if (!cfg.host) return resolve({ ok: false, message: 'No host/IP configured for the printer/drawer.' });

    const port = Number(cfg.port) || 9100;
    const where = `${cfg.host}:${port}`;
    const socket = new net.Socket();
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(3000);
    socket.connect(port, cfg.host, () => {
      // end() flushes the bytes before closing, unlike destroy().
      socket.end(DRAWER_KICK_BYTES, () => {
        settled = true;
        resolve({ ok: true });
      });
    });
    socket.on('timeout', () => finish({ ok: false, message: `No response from ${where} (timed out).` }));
    socket.on('error', (err) => finish({ ok: false, message: `Could not reach ${where}: ${err.message}` }));
  });
}

function openSharedPrinterDrawer(cfg) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      return resolve({ ok: false, message: 'Shared-printer drawers only work when the server runs on Windows.' });
    }
    const share = String(cfg.shareName || '').trim();
    if (!share) return resolve({ ok: false, message: 'No printer share name configured for the drawer.' });
    if (!SHARE_NAME_RE.test(share)) {
      return resolve({ ok: false, message: 'Printer share name may only contain letters, numbers, spaces, ".", "-" and "_".' });
    }

    const target = share.startsWith('\\\\') ? share : `\\\\localhost\\${share}`;
    const tmp = path.join(os.tmpdir(), `selsolve-drawer-${process.pid}-${Date.now()}.bin`);
    try {
      fs.writeFileSync(tmp, DRAWER_KICK_BYTES);
    } catch (err) {
      return resolve({ ok: false, message: `Could not prepare the drawer command: ${err.message}` });
    }

    execFile('cmd.exe', ['/d', '/c', 'copy', '/b', tmp, target], { timeout: 8000, windowsHide: true }, (err, stdout, stderr) => {
      fs.unlink(tmp, () => {});
      if (err) {
        const detail = String(stderr || stdout || err.message).trim().split(/\r?\n/)[0];
        return resolve({ ok: false, message: `Could not send to printer share ${target}: ${detail}` });
      }
      resolve({ ok: true });
    });
  });
}

/** Sends the drawer-kick pulse per the drawer's configured connection. Never throws. */
async function openCashDrawer(cfg) {
  if (!cfg) return { ok: false, message: 'Cash drawer is not configured.' };
  if (cfg.enabled === false) return { ok: false, message: 'Cash drawer is disabled in Settings → Hardware.' };

  if (cfg.connectionType === 'serial') return openSerialDrawer(cfg);
  if (cfg.connectionType === 'network') return openNetworkDrawer(cfg);
  if (cfg.connectionType === 'windows-share') return openSharedPrinterDrawer(cfg);
  // 'simulated' or unset — no hardware attached yet, treat as a harmless no-op success so the
  // checkout flow never breaks because a drawer hasn't been wired up.
  return { ok: true, simulated: true };
}

/* ------------------------------ live status ------------------------------ */

// Printers that exist on every Windows PC but aren't a physical device.
const VIRTUAL_PRINTER_RE = /PDF|XPS|OneNote|Fax|Snagit|AnyDesk/i;
const VIRTUAL_PORT_RE = /^(PORTPROMPT:|nul:|SHRFAX:|FILE:)|onenote|XPSPort/i;

function runPowerShell(script, env = {}) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 15000, windowsHide: true, env: { ...process.env, ...env } },
      (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') })
    );
  });
}

/**
 * The printers installed on this PC, as Windows reports them, with whether each is online. The
 * backend runs on the till PC, so this is the real state of the receipt/label printer — not a
 * stored "READY". Windows only; elsewhere `supported: false`.
 */
async function listPrinters() {
  if (process.platform !== 'win32') return { supported: false, printers: [] };
  const { err, stdout } = await runPowerShell(
    'Get-CimInstance Win32_Printer | Select-Object Name,PortName,DriverName,Default,WorkOffline,PrinterStatus,ExtendedPrinterStatus,DetectedErrorState,Shared,ShareName | ConvertTo-Json -Compress'
  );
  if (err) return { supported: true, printers: [], error: 'Could not read the printer list from Windows.' };
  let rows;
  try {
    rows = JSON.parse(stdout.trim() || '[]');
  } catch {
    rows = [];
  }
  if (!Array.isArray(rows)) rows = rows ? [rows] : [];
  return {
    supported: true,
    printers: rows.map((p) => ({
      name: p.Name,
      port: p.PortName || null,
      driver: p.DriverName || null,
      isDefault: Boolean(p.Default),
      shared: Boolean(p.Shared),
      shareName: p.ShareName || null,
      // 7 = offline in both PrinterStatus and ExtendedPrinterStatus; DetectedErrorState 9 = offline.
      online: !(p.WorkOffline || p.PrinterStatus === 7 || p.ExtendedPrinterStatus === 7 || p.DetectedErrorState === 9),
      virtual: VIRTUAL_PRINTER_RE.test(p.Name || '') || VIRTUAL_PORT_RE.test(p.PortName || '')
    }))
  };
}

/** Prints a short test page on `printerName` through its Windows driver (any printer, shared or not). */
async function printTestPage(printerName, lines = []) {
  if (process.platform !== 'win32') return { ok: false, message: 'Test printing is only available when the server runs on Windows.' };
  if (!printerName) return { ok: false, message: 'Choose the printer first.' };
  const text = ['Selsolve POS — test print', new Date().toLocaleString(), ...lines, '', 'If you can read this, the printer works.', '', '', ''].join('\n');
  // Name and text go in through environment variables, never into the command line itself.
  const { err, stderr } = await runPowerShell('$env:SELSOLVE_TEXT | Out-Printer -Name $env:SELSOLVE_PRINTER', {
    SELSOLVE_PRINTER: printerName,
    SELSOLVE_TEXT: text
  });
  if (err) {
    const detail = (stderr || err.message).trim().split(/\r?\n/)[0];
    return { ok: false, message: `Could not print to "${printerName}": ${detail}` };
  }
  return { ok: true, message: `Test page sent to "${printerName}".` };
}

/** Status of a printer chosen by name, from a listPrinters() result. */
function printerState(printerName, list) {
  if (!list.supported) return { state: 'unknown', label: 'Unknown', detail: 'Printer status can only be checked when the server runs on Windows.' };
  const physical = list.printers.filter((p) => !p.virtual);
  if (!printerName) {
    return physical.length
      ? { state: 'not_selected', label: 'Not selected', detail: 'Choose the printer below.' }
      : { state: 'not_found', label: 'No printer', detail: 'No printer is installed on this PC — connect it and install its driver.' };
  }
  const p = list.printers.find((x) => x.name === printerName);
  if (!p) return { state: 'not_found', label: 'Not found', detail: `"${printerName}" is not installed on this PC.` };
  if (!p.online) return { state: 'offline', label: 'Offline', detail: `"${printerName}" is offline — check the cable and that it is switched on.` };
  return { state: 'connected', label: 'Ready', detail: `"${printerName}" is installed and online.` };
}

/** Reachability of a network printer's port — connects and closes without sending a byte. */
function probeTcp(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.connect(Number(port) || 9100, host, () => finish(true));
    socket.on('timeout', () => finish(false));
    socket.on('error', () => finish(false));
  });
}

/**
 * Whether the path to the drawer works right now: the shared printer is installed and online, the
 * COM port exists, or the network printer answers. The drawer itself can't report in, and nothing is
 * sent — checking must never pop it open.
 */
async function drawerState(cfg, list, comPorts) {
  const type = cfg?.connectionType;
  if (type === 'windows-share') {
    const share = String(cfg.shareName || '').trim().toLowerCase();
    if (!share) return { state: 'not_set', label: 'Not set up', detail: 'Enter the receipt printer’s share name.' };
    const p = list.printers.find((x) => x.shared && String(x.shareName || '').toLowerCase() === share);
    if (!p) return { state: 'not_found', label: 'Not found', detail: `No printer on this PC is shared as "${cfg.shareName}".` };
    if (!p.online) return { state: 'offline', label: 'Offline', detail: `Printer "${p.name}" is offline, so the drawer can't open.` };
    return { state: 'connected', label: 'Ready', detail: `Via printer "${p.name}".` };
  }
  if (type === 'serial') {
    if (!cfg.comPort) return { state: 'not_set', label: 'Not set up', detail: 'Choose the printer’s COM port.' };
    return comPorts.includes(cfg.comPort)
      ? { state: 'connected', label: 'Port found', detail: `${cfg.comPort} is present.` }
      : { state: 'not_found', label: 'Not found', detail: `${cfg.comPort} is not on this PC — is the printer plugged in?` };
  }
  if (type === 'network') {
    if (!cfg.host) return { state: 'not_set', label: 'Not set up', detail: 'Enter the printer’s IP address.' };
    const where = `${cfg.host}:${Number(cfg.port) || 9100}`;
    return (await probeTcp(cfg.host, cfg.port))
      ? { state: 'connected', label: 'Ready', detail: `Printer at ${where} answers.` }
      : { state: 'offline', label: 'Offline', detail: `No answer from ${where}.` };
  }
  return { state: 'not_connected', label: 'Not connected', detail: 'Choose how the drawer is connected.' };
}

/** Test hook — swaps in a mock SerialPort class (e.g. built on @serialport/binding-mock). */
function _setSerialPortImpl(impl) {
  SerialPort = impl;
}

module.exports = {
  openCashDrawer,
  listPrinters,
  printTestPage,
  printerState,
  drawerState,
  DRAWER_KICK_BYTES,
  _setSerialPortImpl
};
