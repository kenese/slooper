# CLAUDE.md - Slooper Project Context

## Project Overview
**Slooper** is a DIY hardware looper built on Raspberry Pi using Node.js (MIDI/OSC controller) and Pure Data (audio engine) that records, plays, and manipulates audio loops with anti-click processing.

## Tech Stack
- **Node.js** (v18+ recommended for Pi compatibility)
- **Pure Data** (Pd-0.55-2) - Audio processing engine
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

## Refactoring Strategy (Failed Attempt)

### What We Tried
1. **Abstraction approach**: Create `looper_slot.pd` as a reusable module
2. **Simplified engine.pd**: Instantiate with `looper_slot slot1` and `looper_slot slot2`

### Why It Failed
- Pure Data's text format uses object indices for connections
- Adding objects shifts ALL indices, breaking connections
- Without visual feedback, impossible to verify correct wiring
- Multiple attempts resulted in `audio signal outlet connected to nonsignal inlet` errors

### Recommended Approach
**Use Pure Data GUI to duplicate slot1 visually:**
1. Open `src/engine.pd` in Pure Data
2. Select slot1 processing objects
3. Copy/paste and move to the right
4. Edit array names: `slot1_data` → `slot2_data`, etc.
5. Connect slot2 output from main router to new chain
6. Save and test

## Important Quirks

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
- Reset clears crop offset back to 0
