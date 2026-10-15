# artnet-usb

A small Node.js app that receives Art-Net DMX over the network and passes it to a USB DMX interface, such as a DMXking or ENTTEC DMX USB Pro.

It uses [`@rtf-dm/artnet-lib`](https://www.npmjs.com/package/@rtf-dm/artnet-lib) to receive Art-Net and [`serialport`](https://serialport.io) to talk to the USB adapter.

## Features

- Listens for Art-Net `ArtDmx` packets on UDP port 6454 and forwards one universe to the USB interface
- Answers `ArtPoll` so lighting software can discover it
- Finds the USB serial adapter automatically, and asks which one to use if there are several
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

If several USB serial devices are connected, the app lists them and asks which one to use. Likely DMX adapters (DMXking/ENTTEC, then FTDI) come first, and pressing Enter picks the first one:

```
Found several USB serial devices:
  1) /dev/cu.usbserial-XXXXXXXX (DMXking.com, serial XXXXXXXX)
  2) /dev/cu.usbmodem1101 (Arduino LLC)
Select a device [1-2] (default 1):
```

The app keeps using your choice when it reconnects. If it isn't running in a terminal (for example as a service), it uses the first device without asking.

To skip the prompt, pass the path with `--device` (or `-d`):

```sh
node index.js --device /dev/cu.usbserial-XXXXXXXX
npm start -- --device /dev/cu.usbserial-XXXXXXXX
```

To list the serial devices on your machine:

```sh
ls /dev/cu.*                # macOS
ls /dev/ttyUSB* /dev/ttyACM*  # Linux
```

### Choosing a universe

By default, the app forwards universe 0. Use `--universe` (or `-u`) to pick another:

```sh
node index.js --universe 1
npm start -- -u 1
```

The value is the full Art-Net port address (0–32767): Net × 256 + Sub-Net × 16 + Universe.

### Options

| Option                  | Default     | Description |
|-------------------------|-------------|-------------|
| `-d, --device <path>`   | auto-detect | Serial device path |
| `-u, --universe <n>`    | `0`         | Art-Net port address to forward (0–32767) |
| `-m, --mode <pro\|raw>` | `pro`       | `pro` wraps the data in ENTTEC DMX USB Pro messages; `raw` writes the start code and channel bytes unframed |
| `-b, --baud-rate <n>`   | `250000`    | Serial baud rate |
| `--reply-ip <ip>`       | `0.0.0.0`   | IP address the app reports in its ArtPoll replies |
| `--debug`               |             | Log the first channels of each received frame |
| `-h, --help`            |             | Show usage |

Example:

```sh
node index.js --debug --universe 1 --device /dev/cu.usbserial-XXXXXXXX
npm start -- --debug -u 1
```

## Troubleshooting

**`Resource busy` / `Cannot lock port`**: another program has the adapter open. Only one program can use it at a time. Quit other lighting apps (SoundSwitch, QLC+, etc.) or stop any other copy of this app. To see what's holding it:

```sh
lsof /dev/cu.usbserial-*
```

**No DMX arriving**: on macOS, if other Art-Net apps are also listening on port 6454, unicast packets go to only one of them. Send to the broadcast address (for example `192.168.1.255`) or quit the other apps. Run with `--debug` to confirm frames arrive.

**`No USB serial device found`**: check the cable and run `ls /dev/cu.*`. Some adapters need an FTDI driver.

## License

MIT
