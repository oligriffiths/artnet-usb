import { NetworkCommunicator, ARTNET_PORT } from '@rtf-dm/artnet-lib';
import { Dmx, Poll, PollReply } from '@rtf-dm/artnet-packets';
import { SerialPort } from 'serialport';
import { parseArgs } from 'node:util';

// Configuration (override with environment variables)
const { values: args } = parseArgs({
  options: {
    device: { type: 'string', short: 'd' },
  },
});

// Serial device: --device, then SERIAL_PATH, otherwise auto-detected
const SERIAL_PATH = args.device || process.env.SERIAL_PATH;
const BAUD_RATE = Number(process.env.BAUD_RATE || 250000);
const UNIVERSE = Number(process.env.UNIVERSE || 0); // Art-Net port address (0-32767)
const MODE = process.env.MODE || 'pro'; // 'pro' = ENTTEC DMX USB Pro framing, 'raw' = raw DMX bytes
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

// Find a USB serial adapter, preferring known DMX interfaces, then FTDI chips
async function findSerialDevice() {
  const ports = await SerialPort.list();
  if (SERIAL_PATH) {
    const match = ports.find((port) => toCallUpPath(port.path) === toCallUpPath(SERIAL_PATH));
    return { path: SERIAL_PATH, manufacturer: match?.manufacturer };
  }
  const usbPorts = ports.filter((port) => port.vendorId || USB_SERIAL_PATTERN.test(port.path));
  if (usbPorts.length === 0) {
    return null;
  }
  const dmx = usbPorts.find((port) => DMX_MANUFACTURER_PATTERN.test(port.manufacturer || ''));
  const ftdi = usbPorts.find((port) => port.vendorId?.toLowerCase() === FTDI_VENDOR_ID);
  const chosen = dmx || ftdi || usbPorts[0];
  if (usbPorts.length > 1) {
    console.warn(`Found ${usbPorts.length} USB serial devices, using ${chosen.path} (use --device to override)`);
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

let busy = false;
let pending = null;

function sendToSerial(dmx) {
  if (!serial || !serial.isOpen) {
    return;
  }
  const frame = MODE === 'raw' ? buildRawFrame(dmx) : buildProFrame(dmx);
  // Drop stale frames: only keep the newest while a write is in flight
  if (busy) {
    pending = frame;
    return;
  }
  busy = true;
  serial.write(frame);
  serial.drain(() => {
    busy = false;
    if (pending) {
      const next = pending;
      pending = null;
      busy = true;
      serial.write(next);
      serial.drain(() => {
        busy = false;
      });
    }
  });
}

// Use the library's communicator directly: ArtNetImpl's discovery crashes on
// ArtPollReply packets from some nodes ("packet size mismatch")
const communicator = new NetworkCommunicator();

function buildPollReply() {
  const ip = (process.env.REPLY_IP || '0.0.0.0').split('.').map((n) => parseInt(n, 10));
  return new PollReply({
    macAddress: communicator.selfMacAddress.split(':').map((v) => parseInt(v, 16)),
    port: ARTNET_PORT,
    ipAddress: ip,
  }).encode();
}

communicator.addListener('UDP_PACKET', (data, { address }) => {
  if (Poll.is(data)) {
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
  const { net, subNet, length, dmxData } = packet.payload;
  // Port address: Net (7 bits) + SubUni (sub-net + universe, 8 bits)
  const universe = ((net & 0x7f) << 8) | subNet;
  if (universe !== UNIVERSE) {
    return;
  }
  const dmx = Buffer.from(dmxData.slice(0, Math.min(length, 512)));
  if (process.env.DEBUG) {
    console.log(`ArtDmx universe ${universe}, ${dmx.length} ch: ${[...dmx.subarray(0, 8)].join(' ')} ...`);
  }
  sendToSerial(dmx);
});

connectSerial();
await communicator.init();
console.log(`Art-Net receiver listening on port ${ARTNET_PORT}, universe ${UNIVERSE}`);

// The library unrefs its socket; keep the process alive while the serial port reconnects
const keepAlive = setInterval(() => {}, 1 << 30);

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
