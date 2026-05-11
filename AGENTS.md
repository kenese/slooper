# AGENTS.md - Slooper Project Context

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
│   ├── engine.pd         # Pure Data top-level patch: OSC/audio routing, slot hosting
│   ├── looper_slot.pd    # Pure Data per-slot audio engine abstraction
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

### Pure Data Patch Flow
```
engine.pd
├── netreceive -u -b 9000
│   └── oscparse → list trim → route slot1 slot2 monitor connect
├── adc~
│   └── input gain → looper_slot slot1 / looper_slot slot2
├── looper_slot audio outlets
│   └── stereo sum → dac~
├── monitor route
│   └── gated dry input → dac~
└── looper_slot state outlets
    └── netsend -u -b 127.0.0.1:9001
```

`engine.pd` is intentionally a host patch. Keep duplicated per-slot DSP out of it. Per-slot logic belongs in `looper_slot.pd`; adding a slot should require one route outlet, one `[looper_slot slotN]` instance, input/output/state wiring, and the matching Node controller state/mapping.

`looper_slot.pd` handles:
- stereo recording into `$1_data` / `$1_data_R`
- playback with `phasor~`, `tabread4~`, and sample-rate conversion
- crop/extend length math
- reset to original recorded length
- clear/reset of playback gates, crop/current/original/playback length state, phasor position, and state output
- `/state` message formatting for Node/tests

`looper_slot.pd` abstraction contract:
- Argument: slot name, e.g. `[looper_slot slot1]`
- Inlets left-to-right: left audio signal, right audio signal, control messages
- Outlets left-to-right: left loop signal, right loop signal, formatted `/state` OSC message

Length state inside `looper_slot.pd` is intentionally split:
- Original length: set by `[timer]` when recording stops; not changed by crop.
- Current length: base length for cumulative crop math; updated by clipped crop output and restored from original on reset.
- Playback length: drives phasor speed, sample index scaling, anti-click width, `PENDING_LENGTH`, and `/state slotX length ...`.

State output contract:
- `rec 1` emits `/state slotX recording`
- `rec 0` emits `/state slotX stopped` and `/state slotX length <ms>`
- `play 1` emits `/state slotX playing`
- `play 0` emits `/state slotX paused`
- `crop` emits `/state slotX length <ms>`
- `reset` emits `/state slotX length <original-ms>`
- `clear` emits `/state slotX length 0` and `/state slotX stopped`

### Pure Data Object Indexing
Pure Data patches use zero-indexed object numbers in the text format. **Connections reference these indices**, so adding/removing objects shifts ALL subsequent indices. This is why text-based Pd editing is error-prone.

## Coding Conventions

### Node.js (index.js)
- Use ES6+ syntax (const, let, arrow functions)
- State machine pattern for slot states: `0=EMPTY, 1=RECORDING, 2=PLAYING, 3=STOPPED`
- MIDI devices configured in `MIDI_CONFIGS` object at top of file
- Throttled encoder updates (`controller.encoderThrottleMs = 50` in `src/config.js`)
- Hold detection for clear function (CONFIG.holdThresholdMs = 500)
- Play-on-release (default): Resuming a paused loop waits for button release (prevents playback during hold-to-delete)
- Pass `play-on-press` arg to get instant playback on button press instead

### Pure Data (`engine.pd` / `looper_slot.pd`)
- Arrays sized for 20 seconds at 48kHz: `960000` samples
- Anti-click envelope using trapezoidal windowing
- Safety: `max(1, $f1)` to prevent division by zero
- DSP auto-enabled on loadbang
- `engine.pd` should stay a thin host patch: OSC parsing/routing, shared audio input/output, monitor path, slot summing, and `netsend`
- Per-slot recording/playback/crop/reset/clear logic lives in `looper_slot.pd`
- `looper_slot.pd` abstraction contract:
  - Argument: slot name, e.g. `[looper_slot slot1]`
  - Inlets: left audio signal, right audio signal, control messages
  - Outlets: left loop signal, right loop signal, formatted `/state` OSC message

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

## Current State (as of 2026-05-11)

### ✅ Working
- **Slot 1 and slot 2 audio**: Recording, playback, stop/resume, clear
- **Slot abstraction**: `looper_slot.pd` implements per-slot audio/state logic, instantiated by `engine.pd` for each slot
- **Crop/extend**: Encoder adjusts loop length with debouncing and cumulative Pd length updates
- **Reset**: Encoder press resets cropped length to original recording length
- **Clear**: Pd handles `/slotX clear 1` directly, stops playback, clears length/crop state, and emits zero length/stopped state
- **Anti-click envelope**: Trapezoidal windowing prevents loop point clicks
- **Single monitor**: Toggle mutes when any loop is playing
- **LED sync**: Visual feedback on MIDI controller
- **Pi deployment**: JACK auto-start, audio device detection, proper port connections
- **Clean shutdown**: Ctrl+C stops JACK on Linux for safe USB unplug

### ❌ Not Working / TODO
- None currently known for the slot extraction baseline

### 🔧 Partially Working
- Pre-record buffer for adjusting loop START point (not implemented)
- Visual feedback of loop position in Pd (not implemented)

## Important Quirks

### Pure Data Text Editing (DANGER)

**Object index corruption**: Inserting or deleting an object in `engine.pd` text shifts ALL subsequent object indices, breaking every `#X connect` line that references those indices. Even a simple `sed` replacement can cause cascading `connection failed` errors. 

**Comma escaping in `expr` objects**: Commas MUST be escaped as `\,` in saved Pd files:
```
# CORRECT:
#X obj 397 500 expr 1000.0 / max(1 \, $f1);

# WRONG (causes "expr: syntax error"):
#X obj 397 500 expr 1000.0 / max(1, $f1);
```

**`print` object has NO outlets**: If you see `(print->float) connection failed`, that connection line is garbage. The `print` object is a sink—it has no output. Delete any `#X connect X 0 Y 0;` where X is a `print` object.

**Abstraction arguments use `$1`, not `#1`**: In Pd abstraction files, use `$1` for the first creation argument. In saved `.pd` text this appears as `\$1`. Using `#1` is literal and will emit state messages like `#1 recording` instead of `slot1 recording`. Slot-local arrays should use names like `\$1_data` and `\$1_data_R`.

**Inlet/outlet order is visual left-to-right**: Abstraction inlet/outlet order is not connection order in the text file. In `looper_slot.pd`, keep audio outlets visually left of the plain state outlet so `engine.pd` receives left audio, right audio, then OSC state.

**Do not expect play to emit length**: Length messages are emitted by record stop, crop, reset, and clear. `play 1/0` only emits `playing`/`paused`. Tests should capture original lengths from `rec 0`, not by sending `play`.

**Trigger order is right-to-left**: `[t b b b]` and `[t b f]` fire their rightmost outlet first. This is relied on for reset and crop sequencing. If reset or crop seems one step behind, inspect trigger ordering before changing arithmetic.

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

### Playback Continues After Clear (Fixed 2026-05-11)
**Symptom:** After sending `clear`, Pd logs showed `ACTIVE_LENGTH` continuing to output the old loop length (loop kept playing briefly).

**Fix:** `looper_slot.pd` now routes `clear` directly. Clear stops tabwrites/playback gates, resets phasor/crop/current/original/playback length state, emits `/state slotX length 0`, and emits `/state slotX stopped`.

### Literal `#1` Slot Names (Fixed 2026-05-11)
**Symptom:** Engine tests received state messages like `["#1", "recording"]` instead of `["slot1", "recording"]`. Slot arrays were also not truly slot-local.

**Cause:** `looper_slot.pd` used `#1` where Pd abstractions require `$1`. In saved patch text that must appear escaped as `\$1`.

**Fix:** Use `\$1_data`, `\$1_data_R`, `list prepend \$1`, and `list prepend \$1 length` in saved `.pd` text.

---

## Regression Tests

The following tests in `test/test_engine.js` guard against known bugs:

| Test Name | Guards Against |
|-----------|----------------|
| `crop updates PENDING_LENGTH immediately` | Crop timing bug (off-by-one) |
| `Regression: Crop reset on new recording` | Crop persistence bug |
| `slot crop adjustments are cumulative` | Repeated crop deltas must accumulate |
| `slot2 crop and reset restore original loop length` | Slot abstraction parity for reset/crop |
| `Clear command stops playback and resets slot` | Clear must be handled inside Pd |
| `clearing one slot does not clear the other slot` | Cross-slot clear independence |
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
- **Verified**: tracked `src/engine.pd` stays on logical `adc~ 1 2` and `dac~ 1 2`
- **Reason**: JACK presents logical port numbers to Pd, not hardware channels. The configured JACK connections (`system:capture_9/10` for XONE) handle the hardware mapping.
- **Mac uses**: generated `.runtime/engine.pd` when direct device channels such as XONE `adc~ 9 10` are needed
- **Linux uses**: tracked `src/engine.pd` with logical `adc~ 1 2` and `dac~ 1 2`

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
