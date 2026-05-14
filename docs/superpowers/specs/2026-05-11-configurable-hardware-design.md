# Configurable Hardware Design

Date: 2026-05-11

## Goal

Make Slooper easier to run with class-compliant audio interfaces and configurable MIDI controllers by moving hardware-specific settings into JSON configuration files.

This first pass keeps the looper itself at two slots and supports MIDI controllers that can emit note buttons plus relative-64 CC encoder messages. Variable slot count, MIDI learn, broader encoder modes, and automatic hardware detection are deferred.

## Scope

Included:

- External JSON files for MIDI mappings.
- External JSON files for audio interface and channel routing.
- Command-line arguments for selecting config files.
- Backward-compatible aliases for existing startup commands.
- Validation with clear startup errors when required config fields are missing.
- Documentation and examples for creating new config files.

Deferred:

- Variable number of looper slots.
- Runtime MIDI learn.
- Encoder modes beyond `relative-64`.
- Fully automatic device detection.
- GUI configuration.
- Reworking Pure Data slot topology.

## Recommended Startup Interface

Primary explicit form:

```bash
./start.sh --midi-config=config/midi/xone-px5.json --audio-config=config/audio/xone-px5.json
```

Backward-compatible form:

```bash
./start.sh midi-device=XONE audio-device=Z1
```

The old aliases should resolve to bundled JSON config files. That keeps current workflows working while making new hardware support a file-editing task instead of a code-editing task.

## Config File Layout

Add bundled configs under:

```text
config/
  audio/
    xone-px5.json
    traktor-z1.json
    blackhole-mac.json
    generic-jack-1-2.json
  midi/
    xone-px5.json
    traktor-x1mk3.json
    example.json
```

## MIDI Config Shape

MIDI config describes the current two-slot controller surface in action terms. Controller code should depend on action names, not on a particular device.

Example:

```json
{
  "name": "Allen & Heath XONE:PX5",
  "match": "XONE",
  "controls": {
    "slot1Button": { "type": "note", "note": 14, "channel": 15 },
    "slot2Button": { "type": "note", "note": 15, "channel": 15 },
    "slot1EndEncoder": { "type": "cc", "controller": 7, "channel": 15, "mode": "relative-64" },
    "slot2EndEncoder": { "type": "cc", "controller": 7, "channel": 15, "mode": "relative-64" },
    "slot1Reset": { "type": "note", "note": 28, "channel": 15 },
    "slot2Reset": { "type": "note", "note": 38, "channel": 15 },
    "monitorButton": { "type": "note", "note": 10, "channel": 15 }
  }
}
```

Required control actions:

- `slot1Button`
- `slot2Button`
- `slot1EndEncoder`
- `slot2EndEncoder`
- `slot1Reset`
- `slot2Reset`
- `monitorButton`

Supported control types for this pass:

- `note`
- `cc`

Supported encoder mode for this pass:

- `relative-64`

Other encoder modes can be added later after testing real controllers that need them.

## Audio Config Shape

Audio config describes JACK/native Pd behavior, channel selection, and JACK routing.

Example:

```json
{
  "name": "Allen & Heath XONE:PX5",
  "mode": "jack",
  "jack": {
    "cardNameIncludes": "XONE",
    "sampleRate": 48000,
    "periodSize": 128,
    "periods": 2,
    "capturePorts": ["system:capture_9", "system:capture_10"],
    "playbackPorts": ["system:playback_1", "system:playback_2"]
  },
  "pd": {
    "darwin": { "adc": [9, 10], "dac": [1, 2] },
    "linux": { "adc": [1, 2], "dac": [1, 2] }
  }
}
```

Supported audio modes for this pass:

- `jack`: Linux/Pi flow where `start.sh` starts or connects to JACK, launches Pd with `-jack`, and connects configured JACK ports.
- `native-pd`: Mac/dev flow where Pd uses its own audio settings and runtime patch channel numbers.

For Linux/JACK, Pd should continue to use logical `adc~ 1 2` and `dac~ 1 2`; hardware channel mapping belongs in JACK port connections. For macOS/native Pd, runtime patch generation may set direct `adc~` and `dac~` channels.

## Runtime Config Flow

`src/config.js` should become a config loader, validator, and normalizer:

1. Parse config-file arguments and legacy aliases.
2. Load MIDI and audio JSON files.
3. Merge them with base OSC/controller defaults.
4. Validate required fields.
5. Return the normalized runtime config consumed by existing code.

`scripts/runtime_config.js`, `start.sh`, and `src/index.js` should keep consuming the normalized config object. This limits blast radius and preserves the current startup architecture.

## Error Handling

Startup should fail early with actionable messages when:

- A config file path does not exist.
- JSON is invalid.
- A required MIDI control is missing.
- A MIDI control uses an unsupported type or encoder mode.
- Required audio routing fields are missing for the selected mode.
- A selected legacy alias does not resolve to a bundled config.

When the MIDI input matching `match` is not found, the startup error should print available MIDI inputs, as it does today.

When JACK cannot find an audio card matching `jack.cardNameIncludes`, startup may keep the existing fallback behavior initially, but the log should name the configured match string and fallback device.

## Testing

Add focused unit tests for:

- Loading bundled MIDI and audio config files.
- Resolving legacy aliases to bundled JSON files.
- Rejecting malformed MIDI configs.
- Rejecting malformed audio configs.
- Rendering shell config values from file-backed config.
- Preserving current XONE, Z1, X1MK3, MAC/BlackHole behavior.

Existing OSC/Pd integration tests should continue to run against the two-slot engine.

## Documentation

Update the README configuration section to explain:

- How to start with explicit JSON files.
- How legacy aliases map to bundled files.
- How to copy `config/midi/example.json` for a new controller.
- How to use `src/midi_logger.js` to discover note, channel, and CC values.
- How JACK capture/playback ports map hardware channels to Pd logical inputs and outputs.

## Open Decisions

No open decisions remain for this first pass. JSON is the chosen format, the initial looper remains two-slot, and MIDI learn plus variable slots are deferred.
