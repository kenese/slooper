# Audio and MIDI Mode Refactor Design

## Goal

Make Slooper choose audio routing mode and MIDI interaction mode explicitly, so send-style looping, channel-insert looping, simple MIDI mappings, and controller-specific MIDI surfaces do not get mixed by accident.

## Audio Modes

Slooper needs two explicit looper audio modes. This is separate from the backend transport mode (`jack` or `native-pd`).

### Send Mode

Send Mode always has one looper channel. Slots record from a send/source path and can contain loops from any selected input source. Playback goes through one stereo return output.

Rules:
- Runtime topology has `channels: 1`.
- `slotsPerChannel` remains configurable as `2` or `4`.
- Audio config may expose one or more capture sources, but they feed one Pd input pair.
- Audio config exposes one playback return pair.
- Source switching remains a global selection before the looper input.
- The generated Pd host contains one channel abstraction.

### Channel Mode

Channel Mode works like inserts. Every input channel has its own looper slots, dry monitor path, loop output, and stereo output pair. Users can listen and mix through USB even when not looping because dry monitor and loop signal are routed through Slooper.

Rules:
- Runtime topology has `channels: 1..4`.
- `slotsPerChannel` remains configurable as `2` or `4`.
- Each channel maps one capture pair to the matching Pd input pair.
- Each channel maps one playback pair to the matching Pd output pair.
- Monitor state remains channel-local.
- Channel Mode must work with `channels: 1` for Mac testing.
- The generated Pd host uses the existing per-channel abstraction topology.

### Config Boundary

Audio JSON must choose exactly one looper routing model:

```json
{
  "routingMode": "send"
}
```

or:

```json
{
  "routingMode": "channel"
}
```

The existing `mode` field should stay reserved for audio backend selection (`jack` or `native-pd`). Validation should reject configs that mix Send Mode and Channel Mode shapes, such as `routingMode: "send"` with multiple playback pairs intended for channel outputs, or `routingMode: "channel"` without enough capture/playback pairs for the selected channel count.

## MIDI Modes

Slooper needs two MIDI interaction modes.

### Simple MIDI Mode

Simple mode is the current behavior. Users map notes and CCs to direct actions in JSON:
- slot button
- hold to clear
- reset
- start/end/move encoders
- auto-loop buttons
- half/double
- monitor
- tap tempo
- capture source buttons

Simple mode should keep existing XONE, X1MK3, WEB, and OSC behavior working.

### Custom MIDI Mode

Custom mode is for controller-specific interaction designs that require logic beyond note-to-action mapping. The MIDI config selects a named surface module, and the module owns how hardware events become app actions and LED state.

Example shape:

```json
{
  "midiMode": "custom",
  "surface": "x1mk3-2channel"
}
```

The first custom surface should start as a duplicate of Simple mode to prove the loader and boundaries work before adding the new X1MK3 behavior.

## Future X1MK3 2-Channel Custom Behavior

The custom X1MK3 2-channel surface should support a per-channel selected auto-loop option.

Rules:
- Each channel has one set of four auto-loop selector buttons.
- Exactly one auto-loop option is selected per channel at all times.
- Startup selects option 1 for each channel.
- The selected button is lit; the other three are off or dim.
- Selecting an auto-loop option updates that channel state.
- If a slot is currently playing in that channel, selecting the option immediately adjusts that playing loop length.
- If no slot is playing, the selected option is stored.
- `shift + slot record` applies the selected channel auto-loop length to that slot.
- Only one slot should play per channel in this custom mode.
- Pressing another recorded slot in the same channel immediately switches playback to that slot and stops the previously playing slot.
- Channel-level start/end encoders affect only the currently playing slot in that channel.
- If no slot is playing, channel-level encoders do nothing at first.

Auto-loop labels can be controller-facing names while the controller dispatches the existing internal duration keys. For example, a user-facing "1 bar" option can dispatch `4beat` under the current 4/4 assumption.

## Proposed Architecture

Add explicit mode fields during config normalization:
- `config.audio.routingMode`: `send` or `channel`
- `config.midi.midiMode`: `simple`, `custom`, or `virtual`
- `config.midi.surface`: a module key such as `simple` or `x1mk3-2channel`

Split MIDI handling out of `src/index.js` into surface modules:

```text
src/controller/midi_surfaces/
  index.js
  simple_surface.js
  x1mk3_2channel_surface.js
```

`src/index.js` remains responsible for opening MIDI input/output, creating `slot_controller`, creating tempo/OSC/web services, and handing those dependencies to the selected surface.

Each MIDI surface owns:
- mapping hardware events to semantic controller calls
- modifier state
- hold timers
- LED rendering
- runtime control summary logging

The simple surface should initially contain the behavior currently inline in `src/index.js`. The first custom surface should delegate to the simple surface until the custom X1MK3 behavior is implemented in a later step.

## Testing Strategy

Unit tests should cover config validation first:
- send mode accepts one runtime channel and one playback return
- channel mode accepts one channel and multiple channels
- channel mode rejects insufficient capture/playback pairs
- send mode rejects multiple channel playback pairs
- existing configs normalize to explicit modes
- simple MIDI configs select the simple surface
- custom MIDI configs select the requested surface

Surface tests should cover loader behavior before custom logic:
- `simple` resolves to `simple_surface`
- `custom` with `x1mk3-2channel` resolves to `x1mk3_2channel_surface`
- unknown custom surface throws a clear error

Integration-level safety checks:
- `npm run test:unit`
- `./start.sh --print-config audio-device=MAC midi-device=WEB channels=1 slots-per-channel=2`
- `./start.sh --print-config audio-device=XONE_2C midi-device=X1MK3_2C channels=2 slots-per-channel=2`

## Non-Goals For First Refactor

The first refactor should not implement the full X1MK3 custom auto-loop workflow. It should only make the audio and MIDI mode boundaries explicit, preserve current behavior, and prove a custom MIDI surface can be loaded.
