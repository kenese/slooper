# SKILLS.md - Slooper Operational Commands

## Development

### Start the Looper (Mac)
```bash
cd ~/Documents/Code/slooper
./start.sh
```

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

# Stop everything cleanly (safe to unplug USB audio after)
./start.sh --stop

# Use Traktor X1 MK3 controller
./start.sh midi-device=X1MK3

# Use Traktor Z1 audio interface
./start.sh audio-device=Z1

# Combine options
./start.sh midi-device=X1MK3 audio-device=Z1 --restart-jack
```

### Stop the Looper
```bash
# Press Ctrl+C in the terminal running ./start.sh
# This cleanly stops Node, Pure Data, and JACK (on Linux)

# Or manually:
pkill -f "node src/index.js"
pkill pd
pkill jackd  # Linux only
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
# First, start the looper in one terminal
./start.sh

# In another terminal, run tests
node test/test_engine.js
```

### Test Specific Features
```bash
# The tests require Pure Data to be running
# They send OSC commands and verify state responses

# Results show:
# ✅ passed tests
# ❌ failed tests with error messages
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
# Update MIDI_CONFIGS in index.js with discovered values
```

## Pure Data Editing

### Open Patch in GUI (Mac)
```bash
open src/engine.pd
```

### Test Patch Syntax
```bash
# Pure Data doesn't have a syntax check mode
# Just open in GUI and look for errors in console
```

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
# Edit start.sh line ~103, increase buffer:
# Change: -p 128 -n 2
# To:     -p 256 -n 2
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
```bash
git checkout HEAD -- src/engine.pd  # Restore specific file
git checkout HEAD -- .              # Restore all files
```

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

### Add Slot 2 Audio (GUI Method)
1. `open src/engine.pd` in Pure Data
2. Find the `route slot1 slot2 monitor connect` object
3. Locate all slot1 processing objects (between route and dac~)
4. Select them, Cmd+C to copy, Cmd+V to paste
5. Move pasted objects to the right
6. Edit array names: `slot1_data` → `slot2_data`, `slot1_data_R` → `slot2_data_R`
7. Connect slot2 outlet (index 1) from main router to new chain
8. Connect new chain output to `dac~`
9. Cmd+S to save
10. Restart: `./start.sh`

### Change JACK Latency
1. Edit `start.sh` line ~103
2. Modify `-p 128 -n 2` to desired values
3. Restart with: `./start.sh --restart-jack`
