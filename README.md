# artnet-usb

A small Node.js app that receives Art-Net DMX over the network and passes it to a USB DMX interface, such as a DMXking or ENTTEC DMX USB Pro.

It uses [`@rtf-dm/artnet-lib`](https://www.npmjs.com/package/@rtf-dm/artnet-lib) to receive Art-Net and [`serialport`](https://serialport.io) to talk to the USB adapter.

## Features

- Listens for Art-Net `ArtDmx` packets on UDP port 6454 and forwards one universe to the USB interface
- Answers `ArtPoll` so lighting software can discover it
- Finds the USB serial adapter automatically, preferring DMXking/ENTTEC, then FTDI-based adapters
- Reconnects if the adapter is unplugged, then plugged back in
- Drops stale frames when the serial link falls behind, so output stays current

## Requirements

- Node.js 18 or newer
- A USB DMX interface that uses the ENTTEC DMX USB Pro protocol, such as the DMXking ultraDMX or an ENTTEC DMX USB Pro

## Install

```sh
git clone https://github.com/oligriffiths/artnet-usb.git
cd artnet-usb
npm install
```

## Usage

```sh
npm start
```

The app finds the USB adapter by itself and logs what it opened:

```
Art-Net receiver listening on port 6454, universe 0
Serial port open: /dev/cu.usbserial-XXXXXXXX [DMXking.com] @ 250000 (pro mode)
```

Then point your lighting software (QLC+, Chataigne, SoundSwitch, MA onPC, etc.) at this computer's IP address, or at the broadcast address, on universe 0.

Press Ctrl+C to stop.

### Choosing a device

If several USB serial devices are connected, or the scan picks the wrong one, pass the path with `--device` (or `-d`):

```sh
node index.js --device /dev/cu.usbserial-XXXXXXXX
npm start -- --device /dev/cu.usbserial-XXXXXXXX
```

To list the serial devices on your machine:

```sh
ls /dev/cu.*                # macOS
ls /dev/ttyUSB* /dev/ttyACM*  # Linux
```

### Options

You set these with environment variables:

| Variable      | Default      | Description |
|---------------|--------------|-------------|
| `UNIVERSE`    | `0`          | Art-Net port address to forward (0–32767; Net × 256 + Sub-Net × 16 + Universe) |
| `MODE`        | `pro`        | `pro` wraps the data in ENTTEC DMX USB Pro messages; `raw` writes the start code and channel bytes unframed |
| `BAUD_RATE`   | `250000`     | Serial baud rate |
| `SERIAL_PATH` | auto-detect  | Serial device path; `--device` takes priority over this |
| `REPLY_IP`    | `0.0.0.0`    | IP address the app reports in its ArtPoll replies |
| `DEBUG`       | unset        | Set to any value to log the first channels of each received frame |

Example:

```sh
DEBUG=1 UNIVERSE=1 npm start -- --device /dev/cu.usbserial-XXXXXXXX
```

## Troubleshooting

**`Resource busy` / `Cannot lock port`**: another program has the adapter open. Only one program can use it at a time. Quit other lighting apps (SoundSwitch, QLC+, etc.) or stop any other copy of this app. To see what's holding it:

```sh
lsof /dev/cu.usbserial-*
```

**No DMX arriving**: on macOS, if other Art-Net apps are also listening on port 6454, unicast packets go to only one of them. Send to the broadcast address (for example `192.168.1.255`) or quit the other apps. Run with `DEBUG=1` to confirm frames arrive.

**`No USB serial device found`**: check the cable and run `ls /dev/cu.*`. Some adapters need an FTDI driver.

## License

MIT
