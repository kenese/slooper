# CLAUDE.md - Slooper Project Context

## Project Overview
**Slooper** is a DIY hardware looper built on Raspberry Pi using Node.js (MIDI/OSC controller) and Pure Data (audio engine) that records, plays, and manipulates audio loops with anti-click processing.

## Tech Stack
- **Node.js** (v18+ recommended for Pi compatibility)
- **Pure Data** (Pd-0.55-2 on Pi, Pd-0.56-2 on Mac) - Audio processing engine
- **JACK Audio** - Low-latency audio routing on Linux/Pi
- **OSC** - Communication between Node.js and Pure Data (ports 9000/9001)
- **MIDI** - Hardware control via `easymidi` library
- **Key npm packages:** `easymidi`, `node-osc`

## Architecture

### File Structure
```
slooper/
├── src/
│   ├── index.js          # Node.js MIDI/OSC controller (main logic)
│   ├── engine.pd         # Pure Data audio engine (audio processing)
│   └── midi_logger.js    # Utility to discover MIDI CC values
├── test/
│   └── test_engine.js    # OSC-based integration tests
├── start.sh              # Multi-platform startup script
└── README.md             # Documentation
```

### Communication Flow
```
MIDI Controller → Node.js (index.js) → OSC → Pure Data (engine.pd) → Audio Out
                                       ↓
                              OSC State Responses
```

### Pure Data Object Indexing
Pure Data patches use zero-indexed object numbers in the text format. **Connections reference these indices**, so adding/removing objects shifts ALL subsequent indices. This is why text-based Pd editing is error-prone.

## Coding Conventions

### Node.js (index.js)
- Use ES6+ syntax (const, let, arrow functions)
- State machine pattern for slot states: `0=EMPTY, 1=RECORDING, 2=PLAYING, 3=STOPPED`
- MIDI devices configured in `MIDI_CONFIGS` object at top of file
- Throttled encoder updates (CONFIG.throttleMs = 100)
- Hold detection for clear function (CONFIG.holdThresholdMs = 500)
- Play-on-release (default): Resuming a paused loop waits for button release (prevents playback during hold-to-delete)
- Pass `play-on-press` arg to get instant playback on button press instead

### Pure Data (engine.pd)
- Arrays sized for 20 seconds at 48kHz: `960000` samples
- Anti-click envelope using trapezoidal windowing
- Safety: `max(1, $f1)` to prevent division by zero
- DSP auto-enabled on loadbang

### Shell Scripts
- Use `[[ "$OSTYPE" == "darwin"* ]]` for Mac detection
- Linux uses JACK audio, Mac uses native Pd audio
- Cleanup function traps EXIT signal

## Hardware Configuration

### Development Machine (Mac)
- Pure Data runs with GUI
- Audio channels: `adc~ 9 10` (XONE main input), `dac~ 1 2` (main output)
- MIDI port opens by name

### Production (Raspberry Pi + Patchbox OS)
- Pure Data runs headless: `pd -nogui -jack -nomidi`
- JACK audio server required (auto-started by script)
- XONE:PX5 typically on `hw:3` (USB position varies)
- JACK connections: `system:capture_9/10 → pure_data:input_1/2`
- MIDI ports may need to be opened by **index** rather than name (ALSA quirk)
- May need `libasound2-dev` installed for MIDI

### Allen & Heath XONE:PX5
- 10-channel USB audio interface
- Main stereo input on channels 9-10 (NOT 1-2!)
- Main stereo output on channels 1-2
- Has integrated MIDI I/O
- MIDI port name on Linux: `XONE:PX5:XONE:PX5 MIDI 1 20:0` (complex format)

### JACK Latency Settings
```bash
# Aggressive (default): ~5ms
jackd -d alsa -d "$JACK_DEVICE" -r 48000 -p 128 -n 2

# Balanced: ~10ms
jackd -d alsa -d "$JACK_DEVICE" -r 48000 -p 256 -n 2

# Safe: ~16ms  
jackd -d alsa -d "$JACK_DEVICE" -r 48000 -p 256 -n 3
```

## Current State (as of 2026-01-19)

### ✅ Working
- **Slot 1 audio**: Recording, playback, stop/resume, clear
- **Crop/extend**: Encoder adjusts loop length with debouncing
- **Reset**: Encoder press resets length to original
- **Anti-click envelope**: Trapezoidal windowing prevents loop point clicks
- **Single monitor**: Toggle mutes when any loop is playing
- **LED sync**: Visual feedback on MIDI controller
- **Pi deployment**: JACK auto-start, audio device detection, proper port connections
- **Clean shutdown**: Ctrl+C stops JACK on Linux for safe USB unplug

### ❌ Not Working / TODO
- **Slot 2 audio**: OSC routing exists but Pure Data has no audio processing for slot2
- The `route slot1 slot2 monitor connect` object receives slot2 messages but they go nowhere

### 🔧 Partially Working
- Pre-record buffer for adjusting loop START point (not implemented)
- Visual feedback of loop position in Pd (not implemented)

## Important Quirks

### Pure Data Text Editing (DANGER)

**Object index corruption**: Inserting or deleting an object in `engine.pd` text shifts ALL subsequent object indices, breaking every `#X connect` line that references those indices. Even a simple `sed` replacement can cause cascading `connection failed` errors. **Always use the Pd GUI for structural changes.**

**Comma escaping in `expr` objects**: Commas MUST be escaped as `\,` in saved Pd files:
```
# CORRECT:
#X obj 397 500 expr 1000.0 / max(1 \, $f1);

# WRONG (causes "expr: syntax error"):
#X obj 397 500 expr 1000.0 / max(1, $f1);
```

**`print` object has NO outlets**: If you see `(print->float) connection failed`, that connection line is garbage. The `print` object is a sink—it has no output. Delete any `#X connect X 0 Y 0;` where X is a `print` object.

### sed Differences Mac vs Linux
Mac requires an empty string after `-i`, Linux does not. Use this helper:
```bash
run_sed() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' -e "$1" "$2"
    else
        sed -i -e "$1" "$2"
    fi
}
# Usage: run_sed 's/old/new/' file.pd
```

### Headless Pi / Patchbox OS

**D-Bus error with JACK**: When running via SSH (no X display), `jack_control` fails with `Unable to autolaunch a dbus-daemon without a $DISPLAY`. Fix:
```bash
export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus
# or
dbus-launch jack_control start
```

**Pd requires `-nogui`**: Without it, Pd fails with `no display name and no $DISPLAY environment variable`.

**Pd requires `-nomidi`**: Otherwise Pd grabs the MIDI device first and Node.js gets `ALSA error making port connection`. Full command:
```bash
pd -nogui -jack -nomidi src/engine.pd &
```

### MIDI on Linux/ALSA
```javascript
// MIDI ports often need to be opened by INDEX on Linux
const inputIndex = inputs.findIndex(n => n.includes('XONE'));
input = new easymidi.Input(inputIndex);  // Works better than name
```

### Monitor Logic
```javascript
// Single monitor that auto-mutes when any loop plays
const anyPlaying = slots.some(s => s.state === 2);
const shouldMonitor = monitorEnabled && !anyPlaying;
```

### Crop Accumulation
- Crop deltas are accumulated, not absolute values
- Original length stored separately from current length
- Reset clears crop offset back to 0 (both JS and Pd)

---

## Tribal Knowledge (Bug Fixes)

### Crop Timing Bug (Fixed 2026-01-18)
**Symptom:** `PENDING_LENGTH` in Pd was always one crop command behind. First crop showed no change, second crop showed the first crop's value, etc.

**Cause:** In `engine.pd`, the trigger object `t f b` (ID 43) fires right-to-left. The bang (`b`) triggered the length calculation BEFORE the float (`f`) updated the `+` object's addend.

**Fix:** Changed `t f b` to `t b f` and swapped connections:
```
# Before (wrong order):
#X obj 400 100 t f b;
#X connect 43 0 40 1;  # Float to + addend
#X connect 43 1 39 0;  # Bang to f (calc)

# After (correct order):
#X obj 400 100 t b f;
#X connect 43 1 40 1;  # Float to + addend (fires FIRST now)
#X connect 43 0 39 0;  # Bang to f (calc, fires SECOND)
```

### Crop Persistence Bug (Fixed 2026-01-18)
**Symptom:** After clearing a loop and recording a new one, the previous crop adjustments were applied to the new loop immediately. E.g., record 2000ms → crop -300ms → clear → record 5000ms → Pd shows `PENDING_LENGTH: 4700` instead of 5000.

**Cause:** The `+` object (ID 40) that accumulates crop deltas retained its right-inlet value across recordings. Nothing reset it.

**Fix:** Added a `msg 0` triggered by `rec 1` to reset the `+` addend:
```
#X msg 250 100 0;
#X connect 10 0 62 0;  # rec start trigger -> msg 0
#X connect 62 0 40 1;  # msg 0 -> + right inlet (reset addend)
```

### Playback Continues After Clear (Observed)
**Symptom:** After sending `clear`, Pd logs showed `ACTIVE_LENGTH` continuing to output the old loop length (loop kept playing briefly).

**Status:** Masked by the crop persistence fix (rec 1 resets state). May resurface if clear-without-new-recording workflow is used. Needs investigation.

---

## Regression Tests

The following tests in `test/test_engine.js` guard against known bugs:

| Test Name | Guards Against |
|-----------|----------------|
| `crop updates PENDING_LENGTH immediately` | Crop timing bug (off-by-one) |
| `Regression: Crop reset on new recording` | Crop persistence bug |
| `Over-Record Workflow` | Recording over existing loop |
| `Crop Extension Logic` | Crop + workflow stability |

---

## ✅ RESOLVED CONTRADICTIONS

The following items were flagged as contradictions during summarization but have been **verified against current working code** (2026-01-19).

### JACK Port Naming on Linux ✅
- **Verified**: `start.sh` uses `system:capture_9/10 → pure_data:input_1/2` for XONE:PX5
- **Why it works**: JACK exposes all 10 hardware channels from XONE. The hardware uses channels 9-10 for main input.
- **Pd ports confirmed**: `pure_data:input_1`, `pure_data:input_2` (underscore, 1-indexed)
- **SKILLS.md is correct**: Lines 102-103 show the right commands for XONE on Pi

### Pd adc~/dac~ Channel Numbers on Linux ✅
- **Verified**: `start.sh` lines 95-99 **automatically force** `adc~ 1 2` and `dac~ 1 2` on Linux
- **Reason**: JACK presents logical port numbers to Pd, not hardware channels. The JACK connections (`system:capture_9`) handle the hardware mapping.
- **Mac uses**: `adc~ 9 10` (direct hardware access, no JACK)
- **Linux uses**: `adc~ 1 2` (JACK logical ports, script auto-converts)

### Pure Data Version ✅ (Minor)
- **Mac currently**: Pd-0.56-2
- **Cleanup script references**: Pd-0.55-2 (still works, fallback to generic `killall pd`)
- **Impact**: None—both versions work identically for this project

### Crop Reset Behavior ✅ (Fixed 2026-01-19)
- **JS behavior**: `handleEncoderPress()` resets `cropOffset` to 0 and sends `/slotX reset 1` to Pd
- **Pd behavior**: `reset` route now implemented in engine.pd (objects 78-80)
  - `t b b` sequences the operations (right-to-left: clear addend first, then output original)
  - `msg 0` → `+` right inlet clears the crop addend
  - Bang → `f` (object 40) re-outputs the original length
- **Result**: Encoder press now truly resets both JS tracking AND Pd audio engine to original loop length
