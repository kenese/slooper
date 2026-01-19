# slooper

A DIY raspberry pi looper built using Node.js and Pure Data (Pd). This is a vibe coded fuck around so bear that in mind before relying too much on any of it. AI also wrote most of this page so it is pretty dorky. I just corrected some errors

## Features

- **Dual-Slot Looping**: Two independent looping slots with dedicated hardware controls.
- **Dynamic Hardware Support**:
Currently hardcoded to support the following but should work with any usb midi devices and class compliant audio interfaces
  - **MIDI Controllers**: Allen & Heath PX5 and Native Instruments Traktor X1 MK3.
  - **Audio Interfaces**: Allen & Heath PX5 and Traktor Z1.
- **Loop Management**:
  - **Record/Play**: Seamless recording and playback states.
  - **Clear**: Hold button for 500ms to clear a slot.
  - **Crop/Extend**: Rotate encoder to adjust loop length in real-time. 500ms of audio is recorded after your loop so you can both reduce and extend loop length
  - **Reset**: Press encoder to reset loop length to original recording. This shit not working tho 
- **Audio Processing**:
  - **Glitch-Free Looping**: Trapezoidal amplitude windowing to prevent clicks at loop points.
  - **Monitoring**: Smart monitoring that auto-mutes when loops are playing.
- **Visual Feedback**:
  - **LED Sync**: Accurate hardware LED states for Recording, Playing, and Empty states.
  - **Console Logging**: Detailed OSC and state logging for debugging.

## Getting Started

### Prerequisites

- **Node.js**: (v14+ recommended)
- **Pure Data**: (Tested with Pd-0.55-2)
- **Git**

### Installation

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd slooper
   ```
2. Install dependencies:
   ```bash
   npm install
   ```

### Raspberry Pi / Patchbox OS

If you are running this on a Raspberry Pi using Patchbox OS, you will need to install the ALSA development library for the MIDI integration to work.

1. **Install Dependencies**:
   ```bash
   sudo apt-get install libasound2-dev
   ```
   *Note: Ensure you are running Node.js v14.14+ (older versions don't support `node:` imports used by dependencies).*
   ```bash
   ```bash
   node -v 
   # If older than v14.14, you MUST upgrade.
   # We recommend Node.js v18 LTS as it has the best compatibility with Raspberry Pi (ARMv7/ARM64) and Patchbox OS.
   
   # 1. Remove old version (optional but recommended)
   sudo apt remove nodejs npm
   
   # 2. Install Node.js v18 LTS
   curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```
2. **Transfer Files**:
   Use `rsync` to copy the project to your Pi. This excludes large/incompatible folders like `.git` and `node_modules` (which must be rebuilt on the Pi).
   ```bash
   rsync -avz --exclude '.git' --exclude 'node_modules' ./slooper patch@patchbox.local:/home/patch/
   ```
3. **Install & Run**:
   SSH into your Pi, navigate to the directory, install dependencies, and run the script.
   ```bash
   cd slooper
   npm install
   ./start.sh
   ```
4. **Audio Setup**:
   Ensure your audio interface is configured correctly in Patchbox OS (using `patchbox` config tool or JACK). The startup script attempts to launch `pd`, but you may need to manually manage connections if using JACK.

### Running

Start the application using the provided shell script. This will automatically configure audio settings, start Pure Data, and launch the Node.js controller.

```bash
./start.sh
```

### Configuration

You can customize the hardware setup using command-line arguments:

**Select MIDI Device:**
```bash
# Default (XONE)
./start.sh

# Traktor X1 MK3
./start.sh midi-device=X1MK3
```

**Select Audio Device:**
```bash
# Default (XONE: adc 9 10, dac 1 2)
./start.sh

# Traktor Z1 (adc 1 2, dac 3 4)
./start.sh audio-device=Z1
```

**Combine Arguments:**
```bash
./start.sh midi-device=X1MK3 audio-device=Z1
```

**Play Mode (Resume Behavior):**

By default, resuming a paused loop happens on button **release** rather than press. This prevents the loop from playing when you hold to delete.

```bash
# Default: play on release (prevents playback during hold-to-delete)
./start.sh

# Instant playback on press (old behavior, lowest latency)
./start.sh play-on-press
```

### Start/Stop Options (Linux/Pi)

**Normal Start** (reuses existing JACK if running):
```bash
./start.sh
```

**Force Restart JACK** (apply new latency settings):
```bash
./start.sh --restart-jack
```

**Stop Everything** (safe to unplug USB audio after):
```bash
./start.sh --stop
```

**Ctrl+C** also performs a clean shutdown - stops Node, Pure Data, and JACK on Linux. You'll see:
```
🧹 Cleaning up...
✅ Stopped. Safe to unplug audio device.
```

### Latency Tuning (Linux/Pi)

The default JACK settings target ~5ms latency (128 frames × 2 periods @ 48kHz). If you experience audio glitches (xruns), edit `start.sh` line ~103 and adjust:

| Setting | Latency | Stability |
|---------|---------|-----------|
| `-p 128 -n 2` | ~5ms | Aggressive (default) |
| `-p 256 -n 2` | ~10ms | Balanced |
| `-p 256 -n 3` | ~16ms | Safe |
| `-p 512 -n 3` | ~32ms | Very stable |

After changing, restart with:
```bash
./start.sh --restart-jack
```

### Troubleshooting (Raspberry Pi)

**"jack wont start" / D-Bus Error**:
If you see errors about `dbus-daemon` or `jack_control` when running headless (SSH), you need to start a D-Bus session manually before starting JACK or the script.

Run this:
```bash
export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus
# If that doesn't work, try:
dbus-launch jack_control start
```

**"Device matching 'XONE' not found"**:
This means the Raspberry Pi does not see your USB MIDI controller.
1. Check that the USB cable is connected and the device is powered on.
2. Run `lsusb` to see if the device acts up in the USB list.
3. Run `aconnect -l` to see available ALSA MIDI ports.
4. If you are using a different controller, update the `start.sh` command (e.g., `midi-device=X1MK3`) or modify `src/index.js` to match your device's name.

## TODO

- [ ] Fix adjust/crop reset
- [ ] Pre-record/delay so the loop start can also be adjusted
- [ ] Visual feedback of loop position in PD
