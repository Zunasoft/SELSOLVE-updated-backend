/**
 * Settings, user management & permissions, hardware and composite items —
 * Modules 11, 12, 13 and 18 of the SOW.
 */

const express = require('express');
const { ROLE_PERMISSIONS, ASSIGNABLE_ROLES, PERMISSION_KEYS, MODULE_KEYS, effectivePermissions } = require('../store');
const { FEATURE_CATALOG, resolveTenantFeatures } = require('../modules/features');
const { setRecipe, removeRecipe, decorateRecipe } = require('../modules/recipes');
const { validateBarcode, encodeBarcodeFormat, maxLabelQuantity } = require('../modules/barcodeFormat');
const scaleManager = require('../modules/scaleManager');
const { openCashDrawer, listPrinters, printTestPage, printerState, drawerState } = require('../modules/printerManager');

const router = express.Router();
const actor = (req) => req.headers['x-user-name'] || 'Owner';

const DEFAULT_ROLE = 'CASHIER';
const OWNER_ROLE = 'OWNER';

/** Roles are stored upper-case; accept whatever casing the client sends. */
const normaliseRole = (role) => (role ? String(role).toUpperCase() : null);

/* --------------------------------- features --------------------------------- */

/**
 * What this shop's subscription actually unlocks. The client hides the tabs it
 * gets `false` for; the server refuses those routes regardless, so hiding is a
 * courtesy rather than the control.
 */
router.get('/features', (req, res) => {
  // Same resolver the route gate uses, so what the client hides and what the
  // server refuses are always the same set.
  const features = resolveTenantFeatures(req.tenant);
  res.json({
    success: true,
    data: {
      plan: req.tenant?.plan || null,
      planExpiry: req.tenant?.expiryDate || null,
      features,
      catalog: FEATURE_CATALOG,
      enabled: Object.entries(features).filter(([, on]) => on).map(([key]) => key)
    }
  });
});

/* --------------------------------- settings --------------------------------- */

router.get('/settings', (req, res) => {
  const store = req.tenantStore;
  if (!store.settings.loyalty && store.settings.pos) {
    store.settings.loyalty = {
      enableLoyalty: store.settings.pos.enableLoyalty !== false,
      loyaltySpendAmount: Number(store.settings.pos.loyaltySpendAmount) || 100,
      loyaltyPointsPerSpend: Number(store.settings.pos.loyaltyPointsPerSpend ?? store.settings.pos.loyaltyPointsPerHundred) || 1,
      loyaltyPointsPerHundred: Number(store.settings.pos.loyaltyPointsPerHundred ?? store.settings.pos.loyaltyPointsPerSpend) || 1,
      loyaltyMinSpendToEarn: Number(store.settings.pos.loyaltyMinSpendToEarn) || 0,
      loyaltyRedeemValue: Number(store.settings.pos.loyaltyRedeemValue) || 0.5,
      loyaltyMinRedeemPoints: Number(store.settings.pos.loyaltyMinRedeemPoints) || 50,
      loyaltyMaxRedeemPercent: Number(store.settings.pos.loyaltyMaxRedeemPercent) || 100
    };
  }
  res.json({ success: true, data: store.settings });
});

/** Section-wise merge so one screen can save without clobbering the others. */
router.put('/settings/:section', async (req, res) => {
  try {
    const store = req.tenantStore;
    const section = req.params.section;

    // Array-shaped, not object-shaped — the generic `{...existing, ...req.body}` merge below is
    // built for object sections and would mangle an array, so this one just replaces it wholesale.
    if (section === 'barcodeFormat') {
      const fields = Array.isArray(req.body?.fields) ? req.body.fields : Array.isArray(req.body) ? req.body : null;
      if (!fields || !fields.some((f) => f.type === 'id') || !fields.some((f) => f.type === 'value')) {
        return res.status(400).json({ success: false, message: 'Barcode format needs at least an id field and a value field.' });
      }
      store.settings.barcodeFormat = fields;
      return res.json({ success: true, message: 'Barcode format saved.', data: store.settings.barcodeFormat });
    }

    if (!store.settings[section]) {
      if (section === 'loyalty' || section === 'pos') {
        store.settings[section] = {};
      } else {
        return res.status(404).json({ success: false, message: `Unknown settings section "${section}".` });
      }
    }

    // Mutating req.tenantStore.settings is enough — the tenant middleware
    // flushes it transactionally (queued per tenant) at the end of this
    // request. A direct saveSettingsToDb() call here used to write immediately
    // and unqueued, racing that flush: two concurrent PUTs to different
    // sections could each read/write the whole settings object and clobber
    // each other's change.
    store.settings[section] = { ...store.settings[section], ...req.body };

    // Sync loyalty properties bidirectionally between pos and loyalty sections
    if (section === 'loyalty' || section === 'pos') {
      const loyaltyKeys = [
        'enableLoyalty',
        'loyaltySpendAmount',
        'loyaltyPointsPerSpend',
        'loyaltyPointsPerHundred',
        'loyaltyMinSpendToEarn',
        'loyaltyRedeemValue',
        'loyaltyMinRedeemPoints',
        'loyaltyMaxRedeemPercent'
      ];

      const otherSection = section === 'loyalty' ? 'pos' : 'loyalty';
      if (!store.settings[otherSection]) store.settings[otherSection] = {};

      loyaltyKeys.forEach((k) => {
        if (req.body[k] !== undefined) {
          store.settings[otherSection][k] = req.body[k];
        }
      });

      // Keep loyaltyPointsPerSpend and loyaltyPointsPerHundred synchronized
      if (req.body.loyaltyPointsPerSpend !== undefined) {
        store.settings.pos.loyaltyPointsPerHundred = req.body.loyaltyPointsPerSpend;
        if (store.settings.loyalty) store.settings.loyalty.loyaltyPointsPerHundred = req.body.loyaltyPointsPerSpend;
      } else if (req.body.loyaltyPointsPerHundred !== undefined) {
        store.settings.pos.loyaltyPointsPerSpend = req.body.loyaltyPointsPerHundred;
        if (store.settings.loyalty) store.settings.loyalty.loyaltyPointsPerSpend = req.body.loyaltyPointsPerHundred;
      }
    }

    res.json({
      success: true,
      message: `${section.charAt(0).toUpperCase() + section.slice(1)} settings saved.`,
      data: store.settings[section]
    });
  } catch (err) {
    console.error('[PUT /settings/:section]', err);
    res.status(500).json({ success: false, message: 'Could not save settings. Please try again.' });
  }
});

/* --------------------------------- hardware --------------------------------- */

router.get('/hardware', (req, res) => {
  res.json({ success: true, data: req.tenantStore.settings.hardware });
});

// Numeric fields arrive as strings from <input type="number">; the serial/TCP libraries need numbers.
const HARDWARE_NUMERIC_FIELDS = ['baudRate', 'dataBits', 'stopBits', 'port', 'pollIntervalMs', 'decimals', 'stabilityTolerance', 'confirmReadings'];
// Set by the server from real test results only — never taken from the client.
const HARDWARE_SERVER_FIELDS = ['status', 'lastTestedAt', 'lastTestResult', 'lastReading', 'lastReadAt'];

function sanitiseHardwarePatch(body) {
  const patch = { ...(body || {}) };
  for (const key of HARDWARE_SERVER_FIELDS) delete patch[key];
  for (const key of HARDWARE_NUMERIC_FIELDS) {
    if (patch[key] === undefined) continue;
    if (patch[key] === '' || patch[key] === null) {
      // An emptied tuning field means "automatic" — it must clear the saved value, not keep the old one.
      if (key === 'stabilityTolerance' || key === 'confirmReadings') patch[key] = null;
      else delete patch[key];
      continue;
    }
    const n = Number(patch[key]);
    if (!Number.isFinite(n)) return { error: `${key} must be a number.` };
    patch[key] = n;
  }
  for (const key of ['comPort', 'host', 'shareName', 'pollCommand', 'weightPattern', 'printerName']) {
    if (typeof patch[key] === 'string') patch[key] = patch[key].trim();
  }
  if (patch.weightPattern) {
    try {
      new RegExp(patch.weightPattern, 'i');
    } catch {
      return { error: 'Weight pattern is not a valid regular expression.' };
    }
  }
  return { patch };
}

router.put('/hardware/:device', (req, res) => {
  const hardware = req.tenantStore.settings.hardware;
  const device = req.params.device;
  if (!hardware[device]) {
    return res.status(404).json({ success: false, message: `Unknown device "${device}".` });
  }
  const { patch, error } = sanitiseHardwarePatch(req.body);
  if (error) return res.status(400).json({ success: false, message: error });

  // Release the scale's COM port / socket so the new settings (or a disable) take effect immediately.
  // Skipped when nothing about the connection changed (the Settings page re-saves before every test),
  // so a good live connection isn't torn down and its stability count reset.
  if (device === 'weighingScale') {
    const next = { ...hardware[device], ...patch };
    if (next.enabled === false || scaleManager.connectionKey(next) !== scaleManager.connectionKey(hardware[device])) {
      scaleManager.closeFor(hardware[device]);
    }
  }

  hardware[device] = { ...hardware[device], ...patch };
  res.json({ success: true, message: `${HARDWARE_LABELS[device] || hardware[device].name} settings saved.`, data: hardware[device] });
});

const SCALE_REASON_MESSAGES = {
  NO_COM_PORT: 'No COM port configured for the scale in Settings → Hardware.',
  NO_HOST: 'No host/port configured for the scale in Settings → Hardware.',
  NO_READING_YET: 'Scale is connected but has not sent a reading yet. Check baud rate / read mode.',
  STALE: 'Scale reading is stale.',
  OVERLOAD: 'Scale is overloaded.',
  CONNECTION_ERROR: 'Could not connect to the scale.'
};

const markTested = (device, ok) => {
  device.status = ok ? 'connected' : 'error';
  device.lastTestedAt = new Date().toISOString();
  device.lastTestResult = ok ? 'OK' : 'FAILED';
};

/**
 * Device connection test. The cash drawer and weighing scale have a real server-side connection
 * (modules/printerManager.js, modules/scaleManager.js), so their test performs the real hardware
 * action. Receipt/label printers print through the OS print driver and the scanner is a keyboard,
 * so the server can't reach them — their test says how to check them instead of claiming success.
 */
router.post('/hardware/:device/test', async (req, res) => {
  const hardware = req.tenantStore.settings.hardware;
  const key = req.params.device;
  const device = hardware[key];
  if (!device) return res.status(404).json({ success: false, message: 'Unknown device.' });

  if (key === 'cashDrawer') {
    const result = await openCashDrawer(device);
    if (!result.ok) {
      markTested(device, false);
      return res.status(400).json({ success: false, message: result.message || 'Could not open the cash drawer.', data: device });
    }
    if (!result.simulated) markTested(device, true);
    return res.json({
      success: true,
      message: result.simulated
        ? 'Simulated mode — no drawer was opened. Pick a real connection to test the hardware.'
        : 'Drawer kick-out pulse sent — the drawer should have opened.',
      data: device
    });
  }

  if (key === 'weighingScale') {
    if (device.connectionType === 'serial' || device.connectionType === 'network') {
      const reading = await scaleManager.waitForReading(device, { timeoutMs: 3000 });
      if (!reading.ok) {
        markTested(device, false);
        return res.status(400).json({
          success: false,
          message: reading.message || SCALE_REASON_MESSAGES[reading.reason] || 'Scale is not responding.',
          reason: reading.reason,
          data: device
        });
      }
      markTested(device, true);
      return res.json({
        success: true,
        message: `Scale responded: ${reading.weight} ${reading.unit}${reading.stable ? ' (stable)' : ' (settling)'}.`,
        data: device
      });
    }
    if (device.connectionType === 'keyboard-wedge') {
      return res.json({ success: true, message: 'Keyboard-wedge scale: press the scale\'s send/print key with the POS weight box focused — the reading types in.', data: device });
    }
    return res.json({ success: true, message: 'Simulated mode — no real scale is read. Pick USB/Serial or Network to test the hardware.', data: device });
  }

  // Printers: check Windows has the chosen printer online, then print a real test page on it.
  if (key === 'posPrinter' || key === 'barcodePrinter' || key === 'labelPrinter') {
    const status = printerState(device.printerName, await listPrinters());
    if (status.state !== 'connected') {
      markTested(device, false);
      return res.status(400).json({ success: false, message: status.detail, data: device });
    }
    const result = await printTestPage(device.printerName, [`Device: ${HARDWARE_LABELS[key] || key}`]);
    markTested(device, result.ok);
    return res.status(result.ok ? 200 : 400).json({ success: result.ok, message: result.message, data: device });
  }

  const detail = {
    barcodeScanner: 'Scan any barcode into the test box on this card to check the scanner.'
  }[key];

  res.json({ success: true, message: detail || 'Configuration saved; this device has no server-side test.', data: device });
});

const HARDWARE_LABELS = {
  posPrinter: 'Printer',
  barcodePrinter: 'Barcode Label Printer',
  labelPrinter: 'Barcode Label Printer',
  barcodeScanner: 'Barcode Scanner',
  weighingScale: 'Weighing Scale',
  cashDrawer: 'Cash Drawer'
};

/**
 * Live status of every device, worked out now — never the stored `status`, which older settings
 * hold as a fixed "READY"/"CONNECTED" whether or not anything is plugged in. Printers and the
 * drawer's printer are checked with Windows, the scale by its COM port and data, and the scanner
 * honestly reported as untestable from here (it is a keyboard).
 */
router.get('/hardware/status', async (req, res) => {
  const hw = req.tenantStore.settings.hardware || {};
  const off = { state: 'off', label: 'Off', detail: 'Switched off.' };
  const [printers, ports] = await Promise.all([listPrinters(), scaleManager.listSerialPorts()]);
  const comPorts = ports.map((p) => p.path);

  const scaleStatus = async (cfg = {}) => {
    const type = cfg.connectionType;
    if (type === 'keyboard-wedge') {
      return { state: 'unknown', label: 'Keyboard scale', detail: 'Types its weight into Billing — press its send key there to test.' };
    }
    if (type !== 'serial' && type !== 'network') {
      return { state: 'not_connected', label: 'Not connected', detail: 'Plug the scale in and press Detect scale, or weights are typed by hand.' };
    }
    if (type === 'serial' && !comPorts.includes(cfg.comPort)) {
      return { state: 'not_found', label: 'Not found', detail: `${cfg.comPort || 'The COM port'} is not on this PC — is the scale plugged in?` };
    }
    const r = await scaleManager.waitForReading(cfg, { timeoutMs: 2000 });
    if (r.ok) return { state: 'connected', label: 'Connected', detail: `Reading ${r.weight} ${r.unit}${r.stable ? ' (stable)' : ''}.` };
    if (r.reason === 'NO_READING_YET' || r.reason === 'STALE') {
      return { state: 'offline', label: 'No data', detail: r.message || 'Connected, but the scale is not sending weights — check it is switched on and the baud rate.' };
    }
    return { state: 'offline', label: 'Error', detail: r.message || 'Could not reach the scale.' };
  };

  const [posPrinter, barcodePrinter, cashDrawer, weighingScale] = await Promise.all([
    hw.posPrinter?.enabled === false ? off : printerState(hw.posPrinter?.printerName, printers),
    hw.barcodePrinter?.enabled === false ? off : printerState(hw.barcodePrinter?.printerName, printers),
    hw.cashDrawer?.enabled === false ? off : drawerState(hw.cashDrawer, printers, comPorts),
    hw.weighingScale?.enabled === false ? off : scaleStatus(hw.weighingScale)
  ]);
  const barcodeScanner = hw.barcodeScanner?.enabled === false
    ? off
    : { state: 'unknown', label: 'On', detail: 'A scanner acts as a keyboard, so it can’t be detected until it scans — use the test box.' };

  res.json({
    success: true,
    data: {
      devices: { posPrinter, barcodePrinter, cashDrawer, weighingScale, barcodeScanner },
      printers: printers.printers,
      printersSupported: printers.supported
    }
  });
});

/**
 * Stable weight read for the POS weight display.
 *
 * `connectionType: 'serial'` reads a real USB-to-RS232 scale via modules/scaleManager.js;
 * `'network'` reads a TCP-attached scale the same way; `'keyboard-wedge'` needs no server-side
 * read at all (the scale types its own reading into the focused input, like a scanner) — this
 * route is only ever polled for the first two. With no scale set up ('none', or the legacy
 * 'simulated') it answers NOT_CONNECTED. `weight` is in `unit` and is signed — a negative value
 * means the scale needs re-zeroing, and the POS refuses to bill it.
 */
router.get('/hardware/weight', async (req, res) => {
  const scale = req.tenantStore.settings.hardware.weighingScale || {};
  if (scale.enabled === false) {
    return res.status(400).json({ success: false, message: 'Weighing scale is disabled in Settings → Hardware.' });
  }

  if (scale.connectionType === 'serial' || scale.connectionType === 'network') {
    const reading = await scaleManager.waitForReading(scale, {
      timeoutMs: 2500,
      requireStable: req.query.stable === '1'
    });
    if (!reading.ok) {
      return res.status(reading.reason === 'NO_READING_YET' ? 503 : 400).json({
        success: false,
        message: reading.message || SCALE_REASON_MESSAGES[reading.reason] || 'Scale is not responding.',
        reason: reading.reason
      });
    }
    return res.json({
      success: true,
      data: {
        weight: reading.weight,
        unit: reading.unit,
        stable: reading.stable,
        simulated: false,
        comPort: scale.comPort || null,
        raw: reading.raw,
        readAt: reading.readAt
      }
    });
  }

  // A keyboard-wedge scale types its own reading — answering here with the simulated value would
  // hand the cashier a random weight to bill.
  if (scale.connectionType === 'keyboard-wedge') {
    return res.status(400).json({
      success: false,
      reason: 'KEYBOARD_WEDGE',
      message: 'This scale types its reading itself — click the quantity box and press the scale\'s send key.'
    });
  }

  // No scale set up ('none', or the old 'simulated' default). This used to answer with a random
  // "simulated" weight, which a cashier could bill — a real counter must never get a made-up weight.
  res.status(400).json({
    success: false,
    reason: 'NOT_CONNECTED',
    message: 'No weighing scale is connected — plug it in and use Settings → Hardware → Detect scale, or type the weight.'
  });
});

/**
 * Finds a scale on this PC's COM ports by listening for weight data (modules/scaleManager.js
 * detectScales) and, when exactly one is found, sets it up and switches it on. Billing calls this
 * while no scale is set up, so plugging one in is enough; Settings calls it with `force`.
 */
router.post('/hardware/weight/detect', async (req, res) => {
  const hardware = req.tenantStore.settings.hardware;
  const scale = hardware.weighingScale || {};
  const result = await scaleManager.detectScales({ force: Boolean(req.body && req.body.force) });

  let applied = false;
  if (result.found.length === 1) {
    const f = result.found[0];
    const alreadySet = scale.connectionType === 'serial' && scale.comPort === f.path && Number(scale.baudRate) === f.baudRate;
    if (!alreadySet) {
      scaleManager.closeFor(scale);
      hardware.weighingScale = {
        ...scale,
        connectionType: 'serial',
        comPort: f.path,
        baudRate: f.baudRate,
        dataBits: f.dataBits,
        parity: f.parity,
        stopBits: f.stopBits,
        readMode: 'continuous',
        enabled: true,
        status: 'connected',
        lastTestedAt: new Date().toISOString(),
        lastTestResult: 'OK'
      };
      applied = true;
    }
  }

  res.json({
    success: true,
    message: result.found.length === 1
      ? `Weighing scale found on ${result.found[0].path} (${result.found[0].baudRate} baud) — switched on.`
      : result.found.length > 1
        ? `${result.found.length} scales found — pick one in Settings → Hardware.`
        : 'No scale found. Check it is plugged in and switched on; a scale that only answers a request command must be set up by hand.',
    data: { ...result, applied, scale: hardware.weighingScale }
  });
});

/**
 * Live scale readings as Server-Sent Events, for the POS weight box to auto-fill from while it is
 * open. One long-lived request instead of polling GET /hardware/weight — every request hydrates the
 * whole tenant store from MongoDB, which is far too heavy to repeat several times a second. A reading
 * is pushed only when it changes; the client closes the stream when the weight box closes.
 */
const WEIGHT_STREAM_INTERVAL_MS = 150;
const WEIGHT_STREAM_MAX_MS = 10 * 60 * 1000;

router.get('/hardware/weight/stream', (req, res) => {
  const scale = req.tenantStore.settings.hardware.weighingScale || {};
  if (scale.enabled === false) {
    return res.status(400).json({ success: false, message: 'Weighing scale is disabled in Settings → Hardware.' });
  }
  if (scale.connectionType !== 'serial' && scale.connectionType !== 'network') {
    return res.status(400).json({ success: false, message: 'Live weight needs a USB/Serial or Network scale in Settings → Hardware.' });
  }

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();

  let last = '';
  const push = () => {
    const r = scaleManager.getLiveReading(scale);
    // What the scale is really sending, so Settings can show it flowing (updates with every new line).
    const d = scaleManager.getDiagnostics(scale);
    const feed = { bytes: d.bytesReceived || 0, rawLines: (d.rawLines || []).map((l) => l.line), display: scaleManager.displayWeight(scale) };
    // Before the first settle, show the moving weight as "Settling…" (stable:false — billing refuses it)
    // rather than a blank "Waiting for scale…".
    const settling = !r.ok && r.reason === 'NO_READING_YET' && d.connected && !d.error && d.lastWeight !== null && d.lastWeight !== undefined;
    const payload = r.ok
      ? { ok: true, weight: r.weight, unit: r.unit, stable: r.stable, ...feed }
      : settling
        ? { ok: true, weight: d.lastWeight, unit: scale.unit || 'kg', stable: false, ...feed }
      : { ok: false, reason: r.reason, message: r.message || SCALE_REASON_MESSAGES[r.reason] || 'Scale is not responding.', ...feed };
    const json = JSON.stringify(payload);
    if (json !== last) {
      last = json;
      res.write(`data: ${json}\n\n`);
    }
  };

  push();
  const timer = setInterval(push, WEIGHT_STREAM_INTERVAL_MS);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
  // A tab left open on the weight box shouldn't hold a stream forever; the client reconnects if it's still open.
  const lifetime = setTimeout(() => res.end(), WEIGHT_STREAM_MAX_MS);
  req.on('close', () => {
    clearInterval(timer);
    clearInterval(heartbeat);
    clearTimeout(lifetime);
  });
});

/** Raw lines the scale has been sending — for working out a new scale's data format in Settings. */
router.get('/hardware/weight/diagnostics', (req, res) => {
  const scale = req.tenantStore.settings.hardware.weighingScale || {};
  res.json({ success: true, data: scaleManager.getDiagnostics(scale) });
});

/** Parses a sample line with the saved scale format (optionally overridden) — lets Settings check a format without hardware. */
router.post('/hardware/weight/parse-test', (req, res) => {
  const scale = req.tenantStore.settings.hardware.weighingScale || {};
  const { line, ...overrides } = req.body || {};
  if (typeof line !== 'string' || !line.trim()) {
    return res.status(400).json({ success: false, message: 'Paste a sample line from the scale.' });
  }
  const { patch, error } = sanitiseHardwarePatch(overrides);
  if (error) return res.status(400).json({ success: false, message: error });

  const parsed = scaleManager.parseScaleLine(scaleManager.decodeEscapes(line).toString('latin1'), { ...scale, ...patch });
  if (!parsed) return res.json({ success: true, data: { matched: false } });
  res.json({ success: true, data: { matched: true, ...parsed } });
});

/** Lists real COM ports present on this machine, for a Settings → Hardware port picker. */
router.get('/hardware/serial-ports', async (req, res) => {
  const ports = await scaleManager.listSerialPorts();
  res.json({ success: true, data: ports });
});

/**
 * Fires the drawer-kick pulse. Called automatically right after a cash sale completes (frontend,
 * best-effort — a failed kick never blocks or unwinds a sale), and also exposed for a manual
 * "Open Drawer" button and the Settings "Test Connection" flow.
 */
router.post('/hardware/cash-drawer/open', async (req, res) => {
  const drawer = req.tenantStore.settings.hardware.cashDrawer;
  const result = await openCashDrawer(drawer);
  if (!result.ok) return res.status(400).json({ success: false, message: result.message || 'Could not open the cash drawer.' });
  res.json({ success: true, message: result.simulated ? 'Drawer kick simulated (no hardware connected).' : 'Drawer kick-out pulse sent.', data: result });
});

/** Record a reading taken by a real scale on the client side. */
router.post('/hardware/weight', (req, res) => {
  const scale = req.tenantStore.settings.hardware.weighingScale || {};
  const weight = Number(req.body.weight);
  if (!Number.isFinite(weight) || weight < 0) {
    return res.status(400).json({ success: false, message: 'A valid weight is required.' });
  }

  scale.status = 'connected';
  scale.lastReading = weight;
  scale.lastReadAt = new Date().toISOString();

  res.json({ success: true, data: { weight, unit: scale.unit || 'kg', stable: true, readAt: scale.lastReadAt } });
});

// decodeBarcodeFormat / encodeBarcodeFormat now live in modules/barcodeFormat.js, shared with
// the product form's barcode Generate button in controllers/catalog.controller.js.

router.get('/hardware/decode-barcode/:code', (req, res) => {
  const store = req.tenantStore;
  const code = String(req.params.code).trim();

  const direct = (store.products || []).find(
    (p) => p.barcode === code || p.sku === code || (p.barcodes || []).includes(code)
  );
  if (direct) {
    return res.json({ success: true, data: { product: direct, quantity: 1, embedded: false } });
  }

  // Only actually attempted as an embedded barcode when at least one weighed product exists —
  // otherwise every plain barcode miss would surface a confusing "No weight-embedded products
  // configured" instead of the plainer "No product matches that barcode."
  const hasWeighedProducts = (store.products || []).some((p) => p.requiresWeight);
  if (hasWeighedProducts) {
    const result = validateBarcode(store, code);
    if (result.valid) {
      return res.json({
        success: true,
        data: {
          product: result.product,
          quantity: result.quantity,
          embedded: true,
          amount: Math.round(result.quantity * result.product.price * 100) / 100
        }
      });
    }
  }

  res.status(404).json({ success: false, message: 'No product matches that barcode.' });
});

/** Barcode label payload for the label printer / kiosk flow. */
router.post('/hardware/barcode-label', (req, res) => {
  const store = req.tenantStore;
  const { productId, weight, quantity } = req.body;
  const product = store.products.find((p) => p.id === productId);
  if (!product) return res.status(404).json({ success: false, message: 'Product not found.' });

  const qty = Number(weight) || Number(quantity) || 1;
  // A quantity too big for the label's digits would print clamped to the maximum and scan as the wrong amount.
  if (product.requiresWeight) {
    const max = maxLabelQuantity(store, product);
    if (max !== null && qty > max) {
      return res.status(400).json({
        success: false,
        message: `Quantity ${qty} doesn't fit on this label — the most it can hold is ${max}. Increase the length in Settings → Barcode.`
      });
    }
  }
  const amount = Math.round(qty * product.price * 100) / 100;

  // The label printer is configured under either key depending on how old the
  // shop's settings document is; neither is guaranteed to be present.
  const hardware = store.settings.hardware || {};
  const labelPrinter = hardware.barcodePrinter || hardware.labelPrinter || {};

  res.json({
    success: true,
    message: 'Barcode label generated.',
    data: {
      productName: product.printName || product.regionalName || product.name,
      barcode: product.barcode,
      // Weight-embedded payload built from the store's shared barcode format.
      encoded: product.requiresWeight
        ? encodeBarcodeFormat(store, product, qty)
        : product.barcode,
      unit: product.unit,
      quantity: qty,
      rate: product.price,
      amount,
      mrp: product.mrp,
      labelSize: labelPrinter.labelSize || '50x25mm',
      printedAt: new Date().toISOString()
    }
  });
});

/* ------------------------------ users & roles ------------------------------ */

const PERMISSION_LABELS = {
  canDiscount: 'Apply discount',
  canVoidBill: 'Void / cancel bill',
  canManageStock: 'Adjust stock',
  canEditPrice: 'Edit prices',
  canManageProducts: 'Add / edit products',
  canManageParties: 'Add / edit customers & vendors',
  canRecordPurchase: 'Record purchases',
  canAccessReports: 'View reports',
  canExport: 'Export to PDF / Excel',
  canAccessSettings: 'Change settings',
  canManageUsers: 'Manage users',
  canOpenSession: 'Open counter session',
  canCloseSession: 'Close counter session',
  canCashInOut: 'Cash in / cash out'
};

const MODULE_LABELS = {
  dashboard: 'Dashboard',
  billing: 'POS Billing',
  products: 'Products',
  inventory: 'Inventory',
  purchases: 'Purchases',
  customers: 'Customers',
  vendors: 'Vendors',
  accounts: 'Accounts',
  expenses: 'Expenses',
  reports: 'Reports',
  tables: 'Tables',
  settings: 'Settings',
  users: 'Users & Roles'
};

router.get('/users', (req, res) => {
  const planFeatures = resolveTenantFeatures(req.tenant);

  res.json({
    success: true,
    data: {
      users: (req.tenantStore.users || []).map(({ pin, ...u }) => ({
        ...u,
        hasPin: Boolean(pin),
        effective: effectivePermissions(u)
      })),
      roles: ASSIGNABLE_ROLES.map((key) => ({
        key,
        label: ROLE_PERMISSIONS[key].label,
        defaults: ROLE_PERMISSIONS[key]
      })),
      permissionMatrix: ROLE_PERMISSIONS,
      permissionKeys: PERMISSION_KEYS,
      permissionLabels: PERMISSION_LABELS,
      moduleKeys: MODULE_KEYS,
      moduleLabels: MODULE_LABELS,
      // A module the subscription does not include cannot be granted to anyone,
      // so the matrix greys it out instead of pretending the toggle works.
      planFeatures
    }
  });
});

router.post('/users', (req, res) => {
  const store = req.tenantStore;
  const { name, phone, email, pin, permissions } = req.body;
  const role = normaliseRole(req.body.role) || DEFAULT_ROLE;

  if (!name) return res.status(400).json({ success: false, message: 'User name is required.' });
  if (!ROLE_PERMISSIONS[role]) {
    return res.status(400).json({ success: false, message: `Unknown role "${role}".` });
  }

  const user = {
    id: `u_${Date.now()}`,
    name,
    phone: phone || '',
    email: email || '',
    role,
    pin: pin || '0000',
    status: 'active',
    permissions: permissions || null,
    createdBy: actor(req),
    createdAt: new Date().toISOString()
  };

  store.users.push(user);
  const { pin: _pin, ...safe } = user;
  res.status(201).json({ success: true, message: `${user.role} "${user.name}" added.`, data: safe });
});

router.put('/users/:id', (req, res) => {
  const store = req.tenantStore;
  const user = (store.users || []).find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

  const { name, phone, email, status, pin, permissions } = req.body;
  const role = normaliseRole(req.body.role);

  if (user.role === OWNER_ROLE && role && role !== OWNER_ROLE) {
    return res.status(400).json({ success: false, message: 'The Owner role cannot be changed.' });
  }

  if (name) user.name = name;
  if (phone !== undefined) user.phone = phone;
  if (email !== undefined) user.email = email;
  if (role && ROLE_PERMISSIONS[role]) user.role = role;
  if (status) user.status = status;
  if (pin) user.pin = pin;
  if (permissions !== undefined) user.permissions = permissions;

  const { pin: _pin, ...safe } = user;
  res.json({ success: true, message: 'User updated.', data: safe });
});

router.delete('/users/:id', (req, res) => {
  const store = req.tenantStore;
  const user = (store.users || []).find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
  if (user.role === OWNER_ROLE) {
    return res.status(400).json({ success: false, message: 'The Owner account cannot be removed.' });
  }
  store.users = store.users.filter((u) => u.id !== req.params.id);
  res.json({ success: true, message: 'User removed.' });
});

/** Effective permissions: explicit overrides win, otherwise the role default. */
router.get('/users/:id/permissions', (req, res) => {
  const user = (req.tenantStore.users || []).find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
  res.json({
    success: true,
    data: {
      role: user.role,
      roleDefaults: ROLE_PERMISSIONS[user.role] || null,
      overrides: user.permissions || null,
      effective: effectivePermissions(user)
    }
  });
});

/**
 * Permission toggle & module access control — Module 11.
 *
 * Only the differences from the role default are stored, so a later change to a
 * role's baseline still reaches every user who has not been given an explicit
 * override for that particular switch.
 */
router.put('/users/:id/permissions', (req, res) => {
  const store = req.tenantStore;
  const user = (store.users || []).find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

  if (user.role === OWNER_ROLE) {
    return res.status(400).json({
      success: false,
      message: 'The Owner always has full access — their permissions cannot be restricted.'
    });
  }

  const base = ROLE_PERMISSIONS[user.role] || ROLE_PERMISSIONS[DEFAULT_ROLE];
  const { modules, reset, ...flags } = req.body;

  if (reset) {
    user.permissions = null;
    return res.json({
      success: true,
      message: `${user.name} reset to the ${base.label} defaults.`,
      data: { role: user.role, overrides: null, effective: effectivePermissions(user) }
    });
  }

  const overrides = { ...(user.permissions || {}) };

  // Module access: keep only the entries that actually differ from the role.
  if (modules && typeof modules === 'object') {
    const moduleOverrides = { ...(overrides.modules || {}) };
    for (const key of MODULE_KEYS) {
      if (modules[key] === undefined) continue;
      const wanted = Boolean(modules[key]);
      if (wanted === Boolean(base.modules[key])) delete moduleOverrides[key];
      else moduleOverrides[key] = wanted;
    }
    if (Object.keys(moduleOverrides).length) overrides.modules = moduleOverrides;
    else delete overrides.modules;
  }

  // Action toggles, same rule. `maxDiscountPercent` is a number, not a switch.
  for (const key of [...PERMISSION_KEYS, 'maxDiscountPercent']) {
    if (req.body[key] === undefined) continue;
    const wanted = key === 'maxDiscountPercent' ? Number(req.body[key]) : Boolean(flags[key]);
    if (wanted === base[key]) delete overrides[key];
    else overrides[key] = wanted;
  }

  user.permissions = Object.keys(overrides).length ? overrides : null;

  res.json({
    success: true,
    message: `Permissions updated for ${user.name}.`,
    data: { role: user.role, overrides: user.permissions, effective: effectivePermissions(user) }
  });
});

/** PIN sign-in at the counter — decides which modules the session can reach. */
router.post('/users/verify-pin', (req, res) => {
  const store = req.tenantStore;
  const { userId, pin } = req.body;
  const user = (store.users || []).find((u) => u.id === userId);

  if (!user || user.pin !== String(pin)) {
    // Coded so the client does not mistake a mistyped counter PIN for an
    // expired shop session and sign the user out.
    return res.status(401).json({ success: false, code: 'INVALID_PIN', message: 'Incorrect PIN.' });
  }
  if (user.status !== 'active') {
    return res.status(403).json({ success: false, code: 'USER_INACTIVE', message: 'This user account is inactive.' });
  }

  const { pin: _pin, ...safe } = user;
  res.json({
    success: true,
    message: `Welcome, ${user.name}.`,
    data: { user: safe, permissions: effectivePermissions(user) }
  });
});

/* ------------------------- composite items (recipes) ------------------------- */

/**
 * Recipes are created and edited on the Add/Edit Product screen in Inventory —
 * these endpoints are the read-across view (every composite in one list) and the
 * same save path the product form uses, so the two can never disagree.
 */
router.get('/recipes', (req, res) => {
  const store = req.tenantStore;
  const rows = (store.recipes || []).map((r) => decorateRecipe(store, r));

  res.json({
    success: true,
    data: rows,
    summary: {
      total: rows.length,
      outOfStock: rows.filter((r) => r.stockStatus === 'OUT_OF_STOCK').length,
      rawMaterials: [...new Set(rows.flatMap((r) => r.ingredients.map((i) => i.productId)))].length
    }
  });
});

router.post('/recipes', (req, res) => {
  const store = req.tenantStore;
  const { productId } = req.body;

  const product = (store.products || []).find((p) => p.id === productId);
  if (!product) return res.status(404).json({ success: false, message: 'Composite product not found.' });

  try {
    const recipe = setRecipe(store, product, req.body);
    res.status(201).json({
      success: true,
      message: `Recipe saved for ${product.name} — costed at ${recipe.unitCost} per ${product.unit}.`,
      data: decorateRecipe(store, recipe)
    });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

router.delete('/recipes/:id', (req, res) => {
  const store = req.tenantStore;
  const recipe = (store.recipes || []).find((r) => r.id === req.params.id);
  if (!recipe) return res.status(404).json({ success: false, message: 'Recipe not found.' });

  const product = (store.products || []).find((p) => p.id === recipe.productId);
  if (product) {
    // Without a recipe the item can no longer be a composite, so it falls back
    // to a standard product rather than silently selling with no deduction.
    product.isComposite = false;
    product.productType = 'standard';
    product.recipeItems = [];
  }

  removeRecipe(store, recipe.productId);
  res.json({ success: true, message: `Recipe removed — "${recipe.productName}" is now a standard product.` });
});

module.exports = router;
