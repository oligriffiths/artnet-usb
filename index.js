import { NetworkCommunicator, ARTNET_PORT } from '@rtf-dm/artnet-lib';
import { Dmx, Poll, PollReply } from '@rtf-dm/artnet-packets';
import { SerialPort } from 'serialport';
import { parseArgs } from 'node:util';
import readline from 'node:readline/promises';

const USAGE = `Usage: node index.js [options]

Options:
  -d, --device <path>     Serial device path (default: auto-detect)
  -u, --universe <n>      Art-Net port address to forward, 0-32767 (default: 0)
  -m, --mode <pro|raw>    pro = ENTTEC DMX USB Pro framing, raw = unframed DMX bytes (default: pro)
  -b, --baud-rate <n>     Serial baud rate (default: 250000)
      --reply-ip <ip>     IP address reported in ArtPoll replies (default: 0.0.0.0)
      --no-autoconnect    Ask which device to use even if only one is found
  -v, --verbose           Print debug info and DMX data
  -h, --help              Show this help`;

function fail(message) {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(1);
}

let args;
try {
  ({ values: args } = parseArgs({
    options: {
      device: { type: 'string', short: 'd' },
      universe: { type: 'string', short: 'u', default: '0' },
      mode: { type: 'string', short: 'm', default: 'pro' },
      'baud-rate': { type: 'string', short: 'b', default: '250000' },
      'reply-ip': { type: 'string', default: '0.0.0.0' },
      'no-autoconnect': { type: 'boolean', default: false },
      verbose: { type: 'boolean', short: 'v', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  }));
} catch (err) {
  fail(err.message);
}

if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

const SERIAL_PATH = args.device; // otherwise auto-detected
const UNIVERSE = Number(args.universe);
if (!Number.isInteger(UNIVERSE) || UNIVERSE < 0 || UNIVERSE > 32767) {
  fail(`Invalid universe "${args.universe}": must be an integer from 0 to 32767`);
}
const MODE = args.mode;
if (MODE !== 'pro' && MODE !== 'raw') {
  fail(`Invalid mode "${MODE}": must be "pro" or "raw"`);
}
const BAUD_RATE = Number(args['baud-rate']);
if (!Number.isInteger(BAUD_RATE) || BAUD_RATE <= 0) {
  fail(`Invalid baud rate "${args['baud-rate']}"`);
}
const REPLY_IP = args['reply-ip'];
if (!/^(\d{1,3})(\.\d{1,3}){3}$/.test(REPLY_IP) || REPLY_IP.split('.').some((n) => Number(n) > 255)) {
  fail(`Invalid reply IP "${REPLY_IP}"`);
}
const VERBOSE = args.verbose;

function verbose(...message) {
  if (VERBOSE) {
    console.log('[verbose]', ...message);
  }
}

verbose(`Options: universe ${UNIVERSE}, mode ${MODE}, baud ${BAUD_RATE}, device ${SERIAL_PATH || 'auto-detect'}, ` +
  `autoconnect ${!args['no-autoconnect']}, reply IP ${REPLY_IP}`);
const AUTOCONNECT = !args['no-autoconnect'];
if (!AUTOCONNECT && !SERIAL_PATH && !process.stdin.isTTY) {
  fail('--no-autoconnect needs a terminal to ask which device to use (or pass --device)');
}
const RETRY_MS = 2000;
const FTDI_VENDOR_ID = '0403';
const USB_SERIAL_PATTERN = /usbserial|usbmodem|ttyUSB|ttyACM/i;

let serial = null;
let shuttingDown = false;

const DMX_MANUFACTURER_PATTERN = /dmxking|enttec/i;

// On macOS, /dev/cu.* is the outgoing (call-up) device and won't block waiting for carrier
function toCallUpPath(path) {
  return path.replace(/^\/dev\/tty\./, '/dev/cu.');
}

function describePort(port) {
  const details = [port.manufacturer, port.serialNumber && `serial ${port.serialNumber}`].filter(Boolean);
  return details.length ? `${toCallUpPath(port.path)} (${details.join(', ')})` : toCallUpPath(port.path);
}

// Ask which device to use; ports are sorted with the most likely DMX adapter first
async function promptForPort(ports) {
  console.log(ports.length === 1 ? 'Found a USB serial device:' : 'Found several USB serial devices:');
  ports.forEach((port, i) => {
    console.log(`  ${i + 1}) ${describePort(port)}`);
  });
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => {
    rl.close();
    shutdown();
  });
  try {
    while (true) {
      // With --no-autoconnect the user must type a number; otherwise Enter picks the first
      const hint = AUTOCONNECT ? ' (default 1)' : '';
      const answer = (await rl.question(`Select a device [1-${ports.length}]${hint}: `)).trim();
      if (answer === '' && AUTOCONNECT) {
        return ports[0];
      }
      const choice = Number(answer);
      if (Number.isInteger(choice) && choice >= 1 && choice <= ports.length) {
        return ports[choice - 1];
      }
      console.log('Invalid selection.');
    }
  } finally {
    rl.close();
  }
}

// Last logged port list, so verbose mode only prints it when it changes
let lastPortList = null;

// Path picked from the prompt, kept so retries and reconnects don't ask again
let selectedPath = null;

// Find a USB serial adapter, preferring known DMX interfaces, then FTDI chips
async function findSerialDevice() {
  const ports = await SerialPort.list();
  const portList = ports.map(describePort).join(', ') || 'none';
  if (portList !== lastPortList) {
    verbose(`Serial ports: ${portList}`);
    lastPortList = portList;
  }
  if (SERIAL_PATH) {
    const match = ports.find((port) => toCallUpPath(port.path) === toCallUpPath(SERIAL_PATH));
    return { path: SERIAL_PATH, manufacturer: match?.manufacturer };
  }
  const usbPorts = ports.filter((port) => port.vendorId || USB_SERIAL_PATTERN.test(port.path));
  if (usbPorts.length === 0) {
    return null;
  }
  const rank = (port) => {
    if (DMX_MANUFACTURER_PATTERN.test(port.manufacturer || '')) {
      return 0;
    }
    if (port.vendorId?.toLowerCase() === FTDI_VENDOR_ID) {
      return 1;
    }
    return 2;
  };
  usbPorts.sort((a, b) => rank(a) - rank(b));

  let chosen = usbPorts.find((port) => toCallUpPath(port.path) === selectedPath);
  if (!chosen && usbPorts.length === 1 && AUTOCONNECT) {
    chosen = usbPorts[0];
  } else if (!chosen && !process.stdin.isTTY) {
    chosen = usbPorts[0];
    console.warn(`Found ${usbPorts.length} USB serial devices, using ${toCallUpPath(chosen.path)} (use --device to choose)`);
  } else if (!chosen) {
    chosen = await promptForPort(usbPorts);
    selectedPath = toCallUpPath(chosen.path);
  }
  return { path: toCallUpPath(chosen.path), manufacturer: chosen.manufacturer };
}

function scheduleConnect() {
  setTimeout(connectSerial, RETRY_MS);
}

let waitingLogged = false;

async function connectSerial() {
  let device;
  try {
    device = await findSerialDevice();
  } catch (err) {
    console.error('Serial scan failed:', err.message);
  }
  if (!device) {
    if (!waitingLogged) {
      console.log('No USB serial device found, waiting for one to be connected...');
      waitingLogged = true;
    }
    scheduleConnect();
    return;
  }
  waitingLogged = false;
  const { path, manufacturer } = device;

  const port = new SerialPort({
    path,
    baudRate: BAUD_RATE,
    dataBits: 8,
    stopBits: 2,
    parity: 'none',
    autoOpen: false,
  });

  port.on('error', (err) => {
    console.error('Serial error:', err.message);
  });

  port.open((err) => {
    if (err) {
      console.error(`Serial open failed: ${err.message} (retrying in ${RETRY_MS / 1000}s)`);
      scheduleConnect();
      return;
    }
    const name = manufacturer ? ` [${manufacturer}]` : '';
    console.log(`Serial port open: ${path}${name} @ ${BAUD_RATE} (${MODE} mode)`);
    serial = port;
    port.on('close', () => {
      serial = null;
      if (!shuttingDown) {
        console.warn('Serial port closed, rescanning...');
        scheduleConnect();
      }
    });
  });
}

// Wrap DMX data in an ENTTEC DMX USB Pro "Output Only Send DMX" (label 6) message
function buildProFrame(dmx) {
  const payloadLength = dmx.length + 1; // +1 for DMX start code
  const frame = Buffer.alloc(payloadLength + 5);
  frame[0] = 0x7e;
  frame[1] = 6;
  frame[2] = payloadLength & 0xff;
  frame[3] = (payloadLength >> 8) & 0xff;
  frame[4] = 0x00; // start code
  dmx.copy(frame, 5);
  frame[frame.length - 1] = 0xe7;
  return frame;
}

function buildRawFrame(dmx) {
  return Buffer.concat([Buffer.from([0x00]), dmx]);
}

const stats = { received: 0, otherUniverse: 0, written: 0, dropped: 0 };

let busy = false;
let pending = null;

function writeFrame(frame) {
  busy = true;
  serial.write(frame);
  stats.written++;
  serial.drain(() => {
    busy = false;
    if (pending && serial && serial.isOpen) {
      const next = pending;
      pending = null;
      writeFrame(next);
    }
  });
}

function sendToSerial(dmx) {
  if (!serial || !serial.isOpen) {
    return;
  }
  const frame = MODE === 'raw' ? buildRawFrame(dmx) : buildProFrame(dmx);
  // Drop stale frames: only keep the newest while a write is in flight
  if (busy) {
    if (pending) {
      stats.dropped++;
    }
    pending = frame;
    return;
  }
  writeFrame(frame);
}

// Print channels as rows of 16, stopping after the last non-zero channel
function formatDmx(dmx) {
  let end = dmx.length;
  while (end > 0 && dmx[end - 1] === 0) {
    end--;
  }
  if (end === 0) {
    return '    (all channels 0)';
  }
  const rows = [];
  for (let i = 0; i < end; i += 16) {
    const values = [...dmx.subarray(i, Math.min(i + 16, end))].map((v) => String(v).padStart(3));
    rows.push(`    ${String(i + 1).padStart(3)}: ${values.join(' ')}`);
  }
  if (end < dmx.length) {
    rows.push(`    (channels ${end + 1}-${dmx.length} are 0)`);
  }
  return rows.join('\n');
}

let lastDmx = null;

// Use the library's communicator directly: ArtNetImpl's discovery crashes on
// ArtPollReply packets from some nodes ("packet size mismatch")
const communicator = new NetworkCommunicator();

function buildPollReply() {
  const ip = REPLY_IP.split('.').map((n) => parseInt(n, 10));
  return new PollReply({
    macAddress: communicator.selfMacAddress.split(':').map((v) => parseInt(v, 16)),
    port: ARTNET_PORT,
    ipAddress: ip,
  }).encode();
}

communicator.addListener('UDP_PACKET', (data, { address }) => {
  if (Poll.is(data)) {
    verbose(`ArtPoll from ${address}, sending ArtPollReply`);
    communicator.send(buildPollReply(), address).catch((err) => {
      console.error('ArtPollReply failed:', err.message);
    });
    return;
  }
  let packet;
  try {
    packet = Dmx.create(data);
  } catch (err) {
    console.error('Bad ArtDmx packet:', err.message);
    return;
  }
  if (!packet) {
    return;
  }
  const { net, subNet, length, sequence, dmxData } = packet.payload;
  // Port address: Net (7 bits) + SubUni (sub-net + universe, 8 bits)
  const universe = ((net & 0x7f) << 8) | subNet;
  if (universe !== UNIVERSE) {
    stats.otherUniverse++;
    return;
  }
  stats.received++;
  const dmx = Buffer.from(dmxData.slice(0, Math.min(length, 512)));
  if (VERBOSE && (!lastDmx || !dmx.equals(lastDmx))) {
    verbose(`ArtDmx from ${address}, universe ${universe}, sequence ${sequence}, ${dmx.length} channels:\n${formatDmx(dmx)}`);
    lastDmx = dmx;
  }
  sendToSerial(dmx);
});

// The library unrefs its socket; keep the process alive while the serial port reconnects
const keepAlive = setInterval(() => {}, 1 << 30);

if (VERBOSE) {
  setInterval(() => {
    if (stats.received || stats.otherUniverse) {
      const other = stats.otherUniverse ? `, ${stats.otherUniverse} for other universes` : '';
      verbose(`Last second: ${stats.received} frames received, ${stats.written} written, ${stats.dropped} dropped${other}`);
    }
    stats.received = 0;
    stats.otherUniverse = 0;
    stats.written = 0;
    stats.dropped = 0;
  }, 1000).unref();
}

await communicator.init();
console.log(`Art-Net receiver listening on port ${ARTNET_PORT}, universe ${UNIVERSE}`);
connectSerial();

async function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log('\nShutting down');
  clearInterval(keepAlive);
  // Don't hang if the serial port or socket won't close cleanly
  setTimeout(() => {
    process.exit(0);
  }, 1000).unref();
  try {
    await communicator.dispose();
  } catch (err) {
    // socket already closed
  }
  if (serial && serial.isOpen) {
    serial.close(() => {
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
