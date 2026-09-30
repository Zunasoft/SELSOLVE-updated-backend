/**
 * Virtual hardware test — exercises the real scale / cash-drawer / weight-barcode code paths against
 * simulated devices, so the hardware integration can be verified before anything is plugged in.
 *
 *   - Weighing scale over TCP: a local server that streams (continuous) or answers a poll command,
 *     exactly as a network scale / serial-to-Ethernet adapter would.
 *   - Weighing scale over a COM port: @serialport/binding-mock stands in for the USB-serial cable.
 *   - Cash drawer: a fake network printer on a local port and a mock COM port, both recording the
 *     bytes they receive, so the ESC/POS kick command can be checked byte-for-byte.
 *   - Weight-embedded barcodes: round-trip encode → decode, including EAN-13 scale labels.
 *
 * Run: node scripts/hardware-virtual-test.js
 */
const net = require('net');
const { MockBinding } = require('@serialport/binding-mock');
const { SerialPortStream } = require('@serialport/stream');

const scaleManager = require('../modules/scaleManager');
const printerManager = require('../modules/printerManager');
const { encodeBarcodeFormat, validateBarcode } = require('../modules/barcodeFormat');

let passed = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== '' ? `  → ${detail}` : ''}`);
};
const section = (title) => console.log(`\n${title}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ virtual devices ------------------------------ */

class VirtualSerialPort extends SerialPortStream {
  constructor(options, callback) {
    super({ binding: MockBinding, ...options }, callback);
    VirtualSerialPort.instances.push(this);
  }

  write(data, encoding, cb) {
    const buf = Buffer.from(data);
    VirtualSerialPort.written.push({ path: this.settings.path, data: buf });
    if (this.onHostWrite) setImmediate(() => this.onHostWrite(buf));
    return super.write(data, encoding, cb);
  }

  /** What the device sends to the PC. */
  deviceSends(text) {
    if (this.port) this.port.emitData(Buffer.from(text, 'latin1'));
  }

  static list() {
    return MockBinding.list();
  }
}
VirtualSerialPort.instances = [];
VirtualSerialPort.written = [];

const latestPort = (path) => [...VirtualSerialPort.instances].reverse().find((p) => p.settings.path === path);

/** A TCP scale. mode 'continuous' streams `frame()` every 100ms; mode 'poll' answers only `pollCommand`. */
function startTcpScale({ mode, frame, pollCommand, intervalMs = 100 }) {
  return new Promise((resolve) => {
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {});
      if (mode === 'continuous') {
        const timer = setInterval(() => socket.write(frame()), intervalMs);
        socket.on('close', () => clearInterval(timer));
      } else {
        socket.on('data', (buf) => {
          if (buf.toString('latin1').includes(pollCommand)) socket.write(frame());
        });
      }
    });
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        close: () => new Promise((r) => {
          sockets.forEach((s) => s.destroy());
          server.close(r);
        })
      })
    );
  });
}

/** A network receipt printer on a random port, recording every byte it receives. */
function startTcpPrinter() {
  return new Promise((resolve) => {
    const received = [];
    const server = net.createServer((socket) => {
      socket.on('data', (buf) => received.push(buf));
      socket.on('error', () => {});
    });
    server.listen(0, '127.0.0.1', () =>
      resolve({ port: server.address().port, received, close: () => new Promise((r) => server.close(r)) })
    );
  });
}

/* ---------------------------------- tests ---------------------------------- */

function testScaleFormats() {
  section('1. Scale data formats (parser)');
  const cases = [
    ['CAS / A&D stable', 'ST,GS,+001.250kg', {}, 1.25, true],
    ['CAS / A&D unstable', 'US,GS,+000.870kg', {}, 0.87, false],
    ['Sign spaced from digits', 'ST,NT,-  0.500kg', {}, -0.5, true],
    ['Scale id before reading', '01 ST,GS,+  2.345 kg', {}, 2.345, true],
    ['MT-SICS stable', 'S S      1.234 kg', {}, 1.234, true],
    ['MT-SICS dynamic', 'S D      1.230 kg', {}, 1.23, false],
    ['Bare number (Essae/Toledo style)', '   1.250', {}, 1.25, null],
    ['Grams output → kg', '  1250 g', {}, 1.25, null],
    ['kg output → grams display', 'ST,GS,+001.250kg', { unit: 'g' }, 1250, true],
    ['Pounds output → kg', '2.205 lb', {}, 1.0, null],
    ['Comma decimal separator', '1,250 kg', {}, 1.25, null],
    ['Implied 3 decimals', '001250', { decimals: 3 }, 1.25, null],
    ['Custom pattern', 'WT:0001.25 KG', { weightPattern: 'WT:(\\d+\\.\\d+)\\s*(KG)' }, 1.25, null]
  ];
  for (const [label, line, cfg, weight, stable] of cases) {
    const r = scaleManager.parseScaleLine(line, cfg);
    check(`${label}: "${line}"`, r && r.weight === weight && r.stable === stable, r ? `${r.weight} ${r.unit} stable=${r.stable}` : 'no match');
  }
  check('Overload is flagged, not read as a weight', scaleManager.parseScaleLine('ST,OL,+ OL  kg')?.overload === true);
  check('Line with no digits is ignored', scaleManager.parseScaleLine('ST,GS,---') === null);
  check('Poll command escapes decode to bytes', scaleManager.decodeEscapes('SI\\r\\n').equals(Buffer.from('SI\r\n')) && scaleManager.decodeEscapes('\\x05')[0] === 5);
}

async function testTcpScaleContinuous() {
  section('2. Network scale — continuous stream (CRLF, then STX/ETX framing)');
  let grams = 1250;
  const scale = await startTcpScale({ mode: 'continuous', frame: () => `ST,GS,+${(grams / 1000).toFixed(3).padStart(7, '0')}kg\r\n` });
  const cfg = { connectionType: 'network', host: '127.0.0.1', port: scale.port, unit: 'kg' };

  let r = await scaleManager.waitForReading(cfg, { timeoutMs: 2000 });
  check('First read after connect returns the weight', r.ok && r.weight === 1.25, JSON.stringify(r));
  check('Stable flag from the scale is honoured', r.ok && r.stable === true);

  grams = 3405;
  // The stream keeps sending; the new weight only shows once enough readings in a row agree.
  for (let i = 0; i < 60 && !(scaleManager.getLiveReading(cfg).weight === 3.405); i += 1) await sleep(100);
  r = scaleManager.getLiveReading(cfg);
  check('Weight change on the pan is picked up live (once enough readings agree)', r.ok && r.weight === 3.405, r.weight);

  const diag = scaleManager.getDiagnostics(cfg);
  check('Diagnostics show raw lines from the scale', diag.rawLines.length > 0 && diag.rawLines.at(-1).line.includes('ST,GS'), diag.rawLines.at(-1)?.line);

  await scale.close();
  await sleep(200);
  r = scaleManager.getLiveReading(cfg);
  check('Scale going offline is reported, not a stale weight', !r.ok && r.reason === 'CONNECTION_ERROR', r.message);
  scaleManager.closeFor(cfg);

  // STX ... ETX framing with no CR/LF at all.
  const framed = await startTcpScale({ mode: 'continuous', frame: () => '\x02  0.750kg\x03' });
  const cfg2 = { connectionType: 'network', host: '127.0.0.1', port: framed.port };
  r = await scaleManager.waitForReading(cfg2, { timeoutMs: 2000 });
  check('STX/ETX framed frames are read', r.ok && r.weight === 0.75, JSON.stringify(r));
  scaleManager.closeFor(cfg2);
  await framed.close();

  // No terminator at all — flushed once the line goes quiet.
  const bare = await startTcpScale({ mode: 'continuous', intervalMs: 400, frame: () => '  2.000' });
  const cfg3 = { connectionType: 'network', host: '127.0.0.1', port: bare.port };
  r = await scaleManager.waitForReading(cfg3, { timeoutMs: 2000 }); // 30 frames at 400ms — waits while the count grows
  check('Frames with no line terminator are read', r.ok && r.weight === 2, JSON.stringify(r));
  scaleManager.closeFor(cfg3);
  await bare.close();
}

async function testTcpScalePoll() {
  section('3. Network scale — poll mode (scale only answers a request command)');
  const scale = await startTcpScale({ mode: 'poll', pollCommand: 'W', frame: () => '   0.625 kg\r' });
  const cfg = { connectionType: 'network', host: '127.0.0.1', port: scale.port, readMode: 'poll', pollCommand: 'W', pollIntervalMs: 200 };

  const r = await scaleManager.waitForReading(cfg, { timeoutMs: 2000 });
  check('Poll command is sent and the reply is read (CR-only line end)', r.ok && r.weight === 0.625, JSON.stringify(r));

  const silentCfg = { ...cfg, readMode: 'continuous', port: scale.port };
  scaleManager.closeFor(cfg);
  const silent = await scaleManager.waitForReading(silentCfg, { timeoutMs: 800 });
  check('Same scale in continuous mode gives a clear "no reading" state', !silent.ok && silent.reason === 'NO_READING_YET', silent.reason);
  scaleManager.closeFor(silentCfg);
  await scale.close();
}

async function testSerialScale() {
  section('4. USB/serial scale on a virtual COM port');
  scaleManager._setSerialPortImpl(VirtualSerialPort);
  MockBinding.createPort('COM7', { echo: false, record: true, manufacturer: 'Prolific' });

  const ports = await scaleManager.listSerialPorts();
  check('COM port shows in the Settings port list', ports.some((p) => p.path === 'COM7'), ports.map((p) => p.path).join(', '));

  const cfg = { connectionType: 'serial', comPort: 'COM7', baudRate: 9600, dataBits: 7, parity: 'even', stopBits: 1, unit: 'kg' };
  let r = scaleManager.getLiveReading(cfg);
  check('Before any data: waiting state, not a fake weight', !r.ok && r.reason === 'NO_READING_YET', r.reason);

  await sleep(50);
  const port = latestPort('COM7');
  check('Port opened with the configured 9600 7-E-1 settings', port && port.settings.dataBits === 7 && port.settings.parity === 'even', port && `${port.settings.baudRate} ${port.settings.dataBits}${port.settings.parity[0].toUpperCase()}${port.settings.stopBits}`);

  // A weight is only accepted once 5 readings in a row agree (within the tolerance).
  const sendN = (p, line, n) => { for (let i = 0; i < n; i += 1) p.deviceSends(line); };
  sendN(port, '  1.250\n', 4);
  await sleep(50);
  r = scaleManager.getLiveReading(cfg);
  check('Nothing shown until 5 readings agree', !r.ok && r.reason === 'NO_READING_YET', r.message);
  port.deviceSends('  1.250\n');
  await sleep(50);
  r = scaleManager.getLiveReading(cfg);
  check('LF-terminated reading arrives once confirmed', r.ok && r.weight === 1.25, r.weight);
  check('…and is stable (no change pending)', r.ok && r.stable === true);

  sendN(port, '  1.300\n', 4);
  await sleep(50);
  r = scaleManager.getLiveReading(cfg);
  check('A changed reading keeps the old weight, flagged unsettled, until 5 agree', r.ok && r.weight === 1.25 && r.stable === false, `${r.weight} stable=${r.stable}`);
  port.deviceSends('  1.300\n');
  await sleep(50);
  r = scaleManager.getLiveReading(cfg);
  check('The 5th agreeing reading updates the weight', r.ok && r.weight === 1.3 && r.stable === true, r.weight);
  check('Display weight follows the pan (smoothed)', scaleManager.displayWeight(cfg) === 1.3, scaleManager.displayWeight(cfg));

  // A flickering last digit (±6 g) must still settle with the default tolerance…
  for (const w of ['1.296', '1.304', '1.299', '1.306', '1.301', '1.297']) port.deviceSends(`  ${w}\n`);
  await sleep(50);
  r = scaleManager.getLiveReading(cfg);
  check('Flicker inside the tolerance stays stable', r.ok && r.stable === true && Math.abs(r.weight - 1.3) <= 0.006, `${r.weight} stable=${r.stable}`);
  // …but a real change (50 g) is not mistaken for flicker.
  for (const w of ['1.350', '1.352', '1.349', '1.351']) port.deviceSends(`  ${w}\n`);
  await sleep(50);
  r = scaleManager.getLiveReading(cfg);
  check('A real change is unsettled until it holds', r.ok && r.stable === false, `${r.weight} stable=${r.stable}`);
  port.deviceSends('  1.350\n');
  await sleep(50);
  r = scaleManager.getLiveReading(cfg);
  check('…then settles on the new weight', r.ok && r.stable === true && Math.abs(r.weight - 1.35) <= 0.003, `${r.weight} stable=${r.stable}`);

  // Bytes no scale prints (wrong baud, bad cable, stuck adapter) are dropped, never read as a weight.
  const before = scaleManager.displayWeight(cfg);
  for (const junk of ['000.23Sø', 'K%þ00.235']) port.deviceSends(`${junk}\n`);
  await sleep(50);
  check('Damaged lines are ignored', scaleManager.displayWeight(cfg) === before, `${before} → ${scaleManager.displayWeight(cfg)}`);


  sendN(port, 'ST,GS,-  0.020kg\r\n', 30);
  await sleep(50);
  r = scaleManager.getLiveReading(cfg);
  check('Negative weight stays negative (so POS can refuse it)', r.ok && r.weight === -0.02, r.weight);

  port.deviceSends('ST,OL,+  OL  kg\r\n');
  await sleep(50);
  r = scaleManager.getLiveReading(cfg);
  check('Overload is reported', !r.ok && r.reason === 'OVERLOAD', r.message);

  port.deviceSends('garbage-frame-without-digits\r\n');
  await sleep(50);

  // Simulate the cable being pulled.
  await new Promise((resolve) => port.close(resolve));
  await sleep(50);
  r = scaleManager.getLiveReading(cfg);
  check('Cable pulled → connection error shown', !r.ok && r.reason === 'CONNECTION_ERROR', r.message);

  // Plug back in: after the reconnect backoff the next read reopens the port.
  await sleep(3100);
  scaleManager.getLiveReading(cfg);
  await sleep(50);
  const reopened = latestPort('COM7');
  check('Reconnects by itself after the cable is plugged back in', reopened && reopened !== port && reopened.isOpen);
  for (let i = 0; i < 30; i += 1) reopened.deviceSends('ST,GS,+002.000kg\r\n');
  await sleep(50);
  r = scaleManager.getLiveReading(cfg);
  check('Reads again after reconnect', r.ok && r.weight === 2, r.weight);

  // Cashier swaps items and clicks Read at once: the old stable 2.000 must not be returned.
  const pending = scaleManager.waitForReading(cfg, { timeoutMs: 2000, requireStable: true });
  setTimeout(() => { for (let i = 0; i < 3; i += 1) reopened.deviceSends('US,GS,+001.480kg\r\n'); }, 50);
  setTimeout(() => { for (let i = 0; i < 30; i += 1) reopened.deviceSends('ST,GS,+001.500kg\r\n'); }, 150);
  r = await pending;
  check('Stable read waits for the new item, not the previous stable weight', r.ok && r.weight === 1.5 && r.stable, r.weight);

  // Changing settings releases the port instead of leaving it locked.
  const cfgNewBaud = { ...cfg, baudRate: 4800 };
  scaleManager.getLiveReading(cfgNewBaud);
  await sleep(50);
  check('Settings change closes the old port handle', !reopened.isOpen);
  check('…and reopens with the new baud rate', latestPort('COM7').settings.baudRate === 4800);

  // Poll mode over serial (CAS ENQ).
  scaleManager.closeFor(cfg);
  const pollCfg = { ...cfg, readMode: 'poll', pollCommand: '\\x05', pollIntervalMs: 150 };
  scaleManager.getLiveReading(pollCfg);
  await sleep(50);
  const pollPort = latestPort('COM7');
  pollPort.onHostWrite = (buf) => {
    if (buf[0] === 0x05) pollPort.deviceSends('ST,GS,+000.455kg\r\n');
  };
  r = await scaleManager.waitForReading(pollCfg, { timeoutMs: 1500 });
  check('Serial poll mode: ENQ sent, reply read', r.ok && r.weight === 0.455, JSON.stringify(r));
  scaleManager.closeFor(pollCfg);

  const missing = await scaleManager.waitForReading({ connectionType: 'serial', comPort: 'COM99' }, { timeoutMs: 500 });
  check('Wrong/missing COM port gives a clear error', !missing.ok && missing.reason === 'CONNECTION_ERROR', missing.message);
  scaleManager.closeAll();
}

async function testCashDrawer() {
  section('5. Cash drawer kick (ESC/POS) via the receipt printer');
  const kick = printerManager.DRAWER_KICK_BYTES;

  const printer = await startTcpPrinter();
  let r = await printerManager.openCashDrawer({ enabled: true, connectionType: 'network', host: '127.0.0.1', port: printer.port });
  await sleep(50);
  const got = Buffer.concat(printer.received);
  check('Network printer receives the exact kick bytes', r.ok && got.equals(kick), got.toString('hex'));
  await printer.close();

  r = await printerManager.openCashDrawer({ enabled: true, connectionType: 'network', host: '127.0.0.1', port: 1 });
  check('Unreachable printer gives an error, never throws', !r.ok && /127\.0\.0\.1:1/.test(r.message), r.message);

  printerManager._setSerialPortImpl(VirtualSerialPort);
  MockBinding.createPort('COM8', { echo: false, record: true });
  VirtualSerialPort.written = [];
  r = await printerManager.openCashDrawer({ enabled: true, connectionType: 'serial', comPort: 'COM8', baudRate: 9600 });
  const serialBytes = Buffer.concat(VirtualSerialPort.written.filter((w) => w.path === 'COM8').map((w) => w.data));
  check('Serial printer receives the exact kick bytes', r.ok && serialBytes.equals(kick), serialBytes.toString('hex'));

  r = await printerManager.openCashDrawer({ enabled: true, connectionType: 'serial', comPort: 'COM55' });
  check('Missing COM port for drawer gives a clear error', !r.ok && /COM55/.test(r.message), r.message);

  r = await printerManager.openCashDrawer({ enabled: true, connectionType: 'windows-share', shareName: 'POS & del x' });
  check('Unsafe printer share name is rejected', !r.ok && /share name/i.test(r.message), r.message);

  if (process.platform === 'win32') {
    r = await printerManager.openCashDrawer({ enabled: true, connectionType: 'windows-share', shareName: 'SelsolveNoSuchPrinter' });
    check('Missing Windows printer share gives a clear error', !r.ok && /SelsolveNoSuchPrinter/.test(r.message), r.message);
  }

  r = await printerManager.openCashDrawer({ enabled: false, connectionType: 'network', host: '127.0.0.1' });
  check('Disabled drawer does nothing', !r.ok && /disabled/.test(r.message));
  r = await printerManager.openCashDrawer({ enabled: true, connectionType: 'simulated' });
  check('Simulated drawer is a harmless success', r.ok && r.simulated === true);
}

async function testScaleDetection() {
  section('7. Plug-and-play: finding the scale on the COM ports');
  scaleManager._setSerialPortImpl(VirtualSerialPort);
  MockBinding.createPort('COM21', { echo: false, record: true, manufacturer: 'Prolific' }); // streaming scale
  MockBinding.createPort('COM22', { echo: false, record: true, manufacturer: 'Epson' }); // receipt printer: silent

  // Whatever opens COM21 gets a scale's stream, as a real scale would send it.
  let streamed = 'ST,GS,+001.250kg\r\n';
  const feeder = setInterval(() => {
    for (const p of VirtualSerialPort.instances) {
      if (p.isOpen && p.settings.path === 'COM21') p.deviceSends(streamed);
    }
  }, 100);

  VirtualSerialPort.written = [];
  let r = await scaleManager.detectScales({ force: true });
  const hit = r.found.find((f) => f.path === 'COM21');
  check('Streaming scale found on COM21 at 9600', r.found.length === 1 && hit && hit.baudRate === 9600 && hit.weight === 1.25, JSON.stringify(r.found));
  check('Silent printer port not mistaken for a scale', !r.found.some((f) => f.path === 'COM22'));
  check('Detection never writes to any port', VirtualSerialPort.written.length === 0, `${VirtualSerialPort.written.length} writes`);

  const t0 = Date.now();
  r = await scaleManager.detectScales();
  check('Repeat check with the same ports is instant (cached)', r.cached === true && Date.now() - t0 < 200, `${Date.now() - t0}ms`);

  // A 7-E-1 scale read at 8-N-1: the parity bit arrives as bit 8 of each byte.
  clearInterval(feeder);
  const evenParity = (text) => Buffer.from([...Buffer.from(text, 'latin1')].map((b) => {
    let ones = 0;
    for (let i = 0; i < 7; i++) ones += (b >> i) & 1;
    return ones % 2 ? b | 0x80 : b;
  }));
  MockBinding.createPort('COM23', { echo: false, record: true });
  const feeder7 = setInterval(() => {
    for (const p of VirtualSerialPort.instances) {
      if (p.isOpen && p.settings.path === 'COM23' && p.port) p.port.emitData(evenParity('  0.735 kg\r\n'));
    }
  }, 100);
  r = await scaleManager.detectScales({ force: true });
  clearInterval(feeder7);
  const seven = r.found.find((f) => f.path === 'COM23');
  check('7-E-1 scale found and its format worked out', seven && seven.dataBits === 7 && seven.parity === 'even' && seven.weight === 0.735, JSON.stringify(seven));
  streamed = '';
  scaleManager.closeAll();
}

function testWeightBarcodes() {
  section('6. Weight-embedded barcode labels (scale label → POS scan)');
  // One shared shape for the whole store now (Settings → Barcode) — products no
  // longer carry their own barcodeFormat, only their own id number and W/P flag letter.
  const sharedFormat = [
    { type: 'id', length: 5 },
    { type: 'sku', enabled: false, length: 5 },
    { type: 'flag', length: 1 },
    { type: 'value', length: 5, precision: 3 }
  ];
  const apples = { id: 'p1', name: 'Apples', unit: 'kg', price: 180, requiresWeight: true, embeddedId: '10001', weightFlag: 'W' };
  const grapes = { id: 'p2', name: 'Grapes', unit: 'kg', price: 120, requiresWeight: true, embeddedId: '00042', weightFlag: 'W' };
  const store = { settings: { barcodeFormat: sharedFormat }, products: [apples, grapes] };

  const code = encodeBarcodeFormat(store, apples, 1.25);
  check('Label encodes 1.250 kg', code === '10001W01250', code);
  let v = validateBarcode(store, code);
  check('Scanning it decodes product + weight', v.valid && v.product.id === 'p1' && v.quantity === 1.25, `${v.product?.name} ${v.quantity}`);

  const grapesCode = encodeBarcodeFormat(store, grapes, 0.875);
  v = validateBarcode(store, grapesCode);
  check('A second product sharing the same store-wide format decodes by its own id', v.valid && v.product.id === 'p2' && v.quantity === 0.875, `${v.product?.name} ${v.quantity}`);

  v = validateBarcode(store, '10001X01250');
  check('Wrong type flag is rejected', !v.valid, v.error);
  v = validateBarcode(store, '99999W01250');
  check('Unknown product id is rejected', !v.valid, v.error);
  v = validateBarcode(store, '10001W');
  check('Truncated scan is rejected', !v.valid, v.error);
}

(async () => {
  console.log('Selsolve virtual hardware test');
  try {
    testScaleFormats();
    await testTcpScaleContinuous();
    await testTcpScalePoll();
    await testSerialScale();
    await testCashDrawer();
    await testScaleDetection();
    testWeightBarcodes();
  } catch (err) {
    failed += 1;
    console.error('\nUnexpected error:', err);
  } finally {
    scaleManager.closeAll();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
