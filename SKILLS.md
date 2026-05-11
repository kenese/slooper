# SKILLS.md - Slooper Operational Commands

## Development

### Start the Looper (Mac)
```bash
cd ~/Documents/Code/slooper
./start.sh
```

### Start Mac Dev Mode (BlackHole + Browser OSC)
```bash
cd ~/Documents/Code/PROJECTS/slooper
./start.sh device=MAC midi-device=OSC
open http://127.0.0.1:3000
```

In Audio MIDI Setup and Pd audio settings:
- Route source audio into `BlackHole 2ch`
- Set Pd input to `BlackHole 2ch`
- Set Pd output to Mac speakers, headphones, or your normal output
- Keep devices at `48kHz`

### Start the Looper (Raspberry Pi)
```bash
ssh patch@patchbox.local
cd ~/slooper
./start.sh
```

### Start with Options
```bash
# Normal start (reuses existing JACK if running)
./start.sh

# Force restart JACK (use after changing latency settings)
./start.sh --restart-jack

# Stop Slooper-managed processes cleanly
./start.sh --stop

# Emergency cleanup for a dedicated appliance
./start.sh --force-cleanup --stop

# Use Traktor X1 MK3 controller
./start.sh midi-device=X1MK3

# Use browser OSC controller instead of MIDI hardware
./start.sh midi-device=OSC

# Use Traktor Z1 audio interface
./start.sh audio-device=Z1

# Use Mac/BlackHole dev audio
./start.sh device=MAC

# Combine options
./start.sh midi-device=X1MK3 audio-device=Z1 --restart-jack
./start.sh device=MAC midi-device=OSC
```

### Stop the Looper
```bash
# Press Ctrl+C in the terminal running ./start.sh
# This stops processes started and tracked by Slooper.

# Or from another terminal:
./start.sh --stop

# Dedicated appliance / emergency cleanup only:
./start.sh --force-cleanup --stop
```

## Raspberry Pi Deployment

### Transfer Files to Pi
```bash
# Clone via git (recommended)
ssh patch@patchbox.local
git clone https://github.com/kenese/slooper.git
cd slooper
npm install

# Or rsync (if git unavailable)
rsync -avz --exclude '.git' --exclude 'node_modules' \
  ./slooper patch@patchbox.local:/home/patch/
```

### Update Pi from Git
```bash
ssh patch@patchbox.local
cd ~/slooper
git pull origin main
```

### Install Dependencies (Pi first-time setup)
```bash
sudo apt-get install libasound2-dev  # For MIDI
npm install
```

### Check Audio Card Position
```bash
aplay -l  # List audio devices
# XONE:PX5 is typically on card 1 or 3
```

### Check MIDI Ports
```bash
aconnect -l  # List ALSA MIDI connections
```

### Manually Start JACK
```bash
# Find XONE card number
XONE_CARD=$(aplay -l 2>/dev/null | grep -i "XONE" | head -1 | sed 's/card \([0-9]*\):.*/\1/')

# Start JACK with low latency
jackd -d alsa -d "hw:$XONE_CARD" -r 48000 -p 128 -n 2 &
```

### Check JACK Connections
```bash
jack_lsp           # List all ports
jack_lsp -c        # List connections
jack_connect system:capture_9 pure_data:input_1
jack_connect system:capture_10 pure_data:input_2
```

## Testing

### Run Integration Tests
```bash
# Unit tests do not need Pd or hardware
npm test

# Engine tests require Pure Data
npm run test:engine

# Or let the test runner start Pd headless
npm run test:engine:managed
```

### Test Specific Features
```bash
# The tests require Pure Data to be running
# They send OSC commands and verify state responses

# Results show:
# ✅ passed tests
# ❌ failed tests with error messages
```

### Manual OSC Control
```bash
# Start Pd and the browser controller first
./start.sh device=MAC midi-device=OSC

# Or send one-off OSC commands from another terminal
node scripts/send_osc.js /slot1 rec 1
node scripts/send_osc.js /slot1 rec 0
node scripts/send_osc.js /slot1 play 1
node scripts/send_osc.js /slot1 crop -30
node scripts/send_osc.js /slot1 reset 1
node scripts/send_osc.js /monitor 1
```

### Watch Pure Data Console
On Mac, the Pd window shows debug output:
- `OSC_IN: list slot1 rec 1` - Incoming OSC messages
- `LENGTH_MS: 1000` - Recorded loop length
- `PENDING_LENGTH: 950` - After crop adjustment
- `MONITOR: 1` - Monitor state

## MIDI Discovery

### Find MIDI CC Values for New Controller
```bash
node src/midi_logger.js
# Then press buttons/turn encoders to see MIDI values
# Update the MIDI mapping in src/config.js with discovered values
```

## Pure Data Editing

### Open Patch in GUI (Mac)
```bash
open src/engine.pd
```

### Pure Data Architecture Quick Reference
```text
engine.pd
  netreceive 9000
    -> oscparse
    -> list trim
    -> route slot1 slot2 monitor connect

  adc~
    -> input gain
    -> [looper_slot slot1]
    -> [looper_slot slot2]

  slot audio outlets
    -> stereo sum
    -> dac~

  slot state outlets
    -> netsend 9001
```

`engine.pd` is the host patch. It should own OSC routing, shared audio input/output, monitor dry-through, slot summing, DSP startup, and `netsend`.

`looper_slot.pd` owns one slot's internals: stereo record buffers, playback, crop, reset, clear, anti-click envelope, and `/state` formatting.

`looper_slot.pd` contract:
- Argument: slot name, e.g. `[looper_slot slot1]`
- Inlets left-to-right: left audio, right audio, control messages
- Outlets left-to-right: left loop audio, right loop audio, `/state` message

Slot-local array/message names must use Pd abstraction argument syntax:
```text
\$1_data
\$1_data_R
list prepend \$1
list prepend \$1 length
```

Do not use `#1`; Pd treats it literally.

### Test Patch Syntax
```bash
# Pure Data doesn't have a syntax check mode
# Just open in GUI and look for errors in console
```

### State Message Contract
```text
/slotX rec 1     -> /state slotX recording
/slotX rec 0     -> /state slotX stopped, /state slotX length <ms>
/slotX play 1    -> /state slotX playing
/slotX play 0    -> /state slotX paused
/slotX crop N    -> /state slotX length <ms>
/slotX reset 1   -> /state slotX length <original-ms>
/slotX clear 1   -> /state slotX length 0, /state slotX stopped
```

Tests should capture loop length from `rec 0`, `crop`, `reset`, or `clear`. `play` does not emit length.

### Safe Pd Editing Rules
- Prefer the Pd GUI for structural changes; Pd rewrites object indices correctly.
- Text edits are OK for narrow substitutions, but adding/removing objects by text can corrupt `#X connect` indices.
- Commas in saved `expr` objects must be escaped as `\,`.
- `print` has no outlets. Delete any connection where `print` is the source.
- Trigger outlets fire right-to-left. Crop/reset bugs are often trigger-order bugs.
- In abstraction files, inlet/outlet order is visual left-to-right.

## Common Debugging

### No Audio on Pi
```bash
# Check JACK is running
pgrep jackd

# Check connections
jack_lsp -c

# Restart with correct device
./start.sh --restart-jack
```

### MIDI Not Working on Pi
```bash
# List available MIDI ports
aconnect -l

# Check if device is recognized
lsusb | grep -i "allen"

# Run as sudo to test permissions
sudo node src/index.js midi-device=XONE
```

### Audio Glitches (Xruns)
```bash
# Update the JACK period values in src/config.js, then restart JACK:
./start.sh --restart-jack
```

## Git Workflow

### Commit Changes
```bash
git add -A
git commit -m "Description of changes"
git push origin main
```

### Discard Local Changes
Ask before discarding work. In particular, do not discard Pd patch changes unless you know they are yours and have checked `git diff -- src/engine.pd src/looper_slot.pd`.

### Update Pi After Push
```bash
ssh patch@patchbox.local "cd ~/slooper && git pull origin main"
```

## Multi-Step Processes

### Add Support for New MIDI Controller
1. Run `node src/midi_logger.js` with new controller connected
2. Press each button and turn each encoder
3. Note the MIDI channel, note numbers, and CC values
4. Add new entry to `MIDI_CONFIGS` in `src/index.js`
5. Add command-line parsing in `start.sh` if needed
6. Test: `./start.sh midi-device=NEWDEVICE`

### Add Another Slot (GUI Method)
1. `open src/engine.pd` in Pure Data
2. Add the new slot name to the top-level route, e.g. `route slot1 slot2 slot3 monitor connect`
3. Add a new `[looper_slot slot3]` object
4. Connect shared scaled left/right audio into the first two inlets
5. Connect the matching route outlet to the control inlet
6. Connect the two audio outlets to the stereo sum
7. Connect the state outlet to `netsend`
8. Add the matching Node MIDI/OSC state mapping in `src/index.js` or the dev controller
9. Cmd+S to save
10. Restart: `./start.sh`

### Change JACK Latency
1. Edit `start.sh` line ~103
2. Modify `-p 128 -n 2` to desired values
3. Restart with: `./start.sh --restart-jack`
