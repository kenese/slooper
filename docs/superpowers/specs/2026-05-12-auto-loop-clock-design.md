# Auto Loop, Clock, and Length Transform Design

## Summary

Add clock-aware auto-loop creation and musical length controls while keeping the existing split of responsibilities:

- Node.js owns MIDI controls, clock/tap timing, scheduling, and user intent.
- Pure Data owns audio capture, playback, loop boundary math, anti-click processing, and authoritative length state.

The feature uses dedicated hardware buttons:

- Slot 1 auto-loop: 1 beat, 2 beats, 4 beats, 2 bars.
- Slot 2 auto-loop: 1 beat, 2 beats, 4 beats, 2 bars.
- Slot 1 length transform: half, double.
- Slot 2 length transform: half, double.

## Current State

The controller currently handles MIDI `noteon`, `noteoff`, and `cc` events. It does not consume MIDI realtime clock, start, stop, or continue messages.

Slot behavior is managed in `src/controller/slot_controller.js`. Node sends OSC slot commands such as `rec`, `play`, `crop`, `cropStart`, `reset`, and `clear`. Pd sends authoritative state responses such as `length`, `start`, `recording`, `playing`, `paused`, and `stopped`.

`looper_slot.pd` currently uses 20 second arrays at 48kHz (`960000` samples) but clips logical crop/playback length to 30000ms. It also keeps recording delayed input briefly after `rec 0` so there is tail audio available beyond the official loop end. The implementation should make the intended maximum explicit and consistent with the new auto-loop/transform requirements.

## Clock Model

Add a small Node-side transport clock module with no Pd dependency.

Responsibilities:

- Listen for MIDI realtime `clock` ticks where supported by `easymidi`.
- Track MIDI clock as 24 pulses per quarter note.
- Estimate BPM from recent tick intervals.
- Track beat boundaries.
- Mark MIDI clock inactive when ticks stop for a configurable stale timeout.
- Expose `isActive()`, `getBpm()`, `getBeatMs()`, and `getClosestBeatTime(now)`.

MIDI clock mode is active only while recent clock ticks are arriving. If no active MIDI clock is present, the controller uses tap tempo.

## Tap Tempo Fallback

Tap tempo is used only when MIDI clock is inactive.

Tap behavior:

- A tap control records recent tap times.
- BPM is estimated from the average of recent tap intervals.
- Invalid tap gaps are ignored or reset the tap history.
- If tap BPM is unavailable, auto-loop buttons should not start a timed auto-loop. The controller should log a clear message and leave the slot unchanged.

When using tap tempo, auto-loop recording starts immediately on button press because there is no ongoing external beat grid to snap to.

## Musical Durations

The supported auto-loop durations are:

- `1beat`: 1 beat.
- `2beat`: 2 beats.
- `4beat`: 4 beats.
- `2bar`: 8 beats, assuming 4/4.

This design assumes 4/4 for `2bar`. Time signature support is out of scope.

Duration in milliseconds is:

```text
beatMs = 60000 / bpm
durationMs = beatMs * beatCount
```

## Auto-Loop Button Behavior

Auto-loop buttons are per-slot and per-duration.

### Empty Slot

Pressing an auto-loop button on an empty slot creates a new loop:

1. Resolve the duration from active MIDI clock or tap BPM.
2. Choose the record start time:
   - MIDI clock active: closest beat to the press.
   - Tap fallback: immediately.
3. At start time, send `/slotX rec 1`.
4. At start time plus duration, send `/slotX rec 0`.
5. Immediately after record stop, send `/slotX play 1`.

The local slot state should represent a pending auto-record before recording starts so repeated button presses cannot schedule overlapping recordings for the same slot.

### Playing or Stopped Slot

Pressing an auto-loop button on an existing loop snaps the effective playback length to the selected musical duration:

1. Resolve the duration from MIDI clock or tap BPM.
2. Preserve the current start point.
3. Ask Pd to set the effective playback length to the resolved duration.
4. Leave playback state unchanged except for normal Pd length/state responses.

This is a duration change, not a start-boundary move. If the loop currently starts at an adjusted/cropped start point, that start point remains the start point.

### Recording Slot

Pressing an auto-loop button while the slot is recording should be ignored for the first implementation. This avoids changing already-scheduled stop times mid-recording and keeps the behavior predictable.

## Half and Double Buttons

Half and double buttons operate on existing loops only.

Behavior:

- Preserve the current start point.
- Set effective playback length to current effective length multiplied by `0.5` or `2`.
- Ignore when the slot is empty or recording.
- Leave playback state unchanged.

Doubling requires enough captured audio after the current start point. If Pd cannot safely represent the requested length, it should clamp to available captured length and emit the actual resulting `/state slotX length <ms>`.

## Pd Changes

Keep Pd changes narrow and inside `looper_slot.pd`.

Add a new control message to set effective playback length while preserving start offset. Suggested OSC command:

```text
/slotX setLength <duration-ms>
```

`setLength` should:

- Clip to a safe minimum of 100ms.
- Clip to the maximum captured/playable length.
- Preserve current start crop offset.
- Update current end length so playback length equals the requested effective length.
- Emit `/state slotX length <actual-ms>`.

Half/double can be implemented in Node by sending `setLength` with a calculated absolute length. This keeps Pd’s new surface area small.

Increase and clarify capture/playback capacity:

- Keep the existing 1 second pre-roll before the official loop start.
- Increase post-stop tail capture to 20 seconds after `rec 0`.
- Size slot arrays for the maximum official recording length plus 1 second pre-roll plus 20 seconds of post-stop tail.
- Align array sizes, logical clips, and documentation to the resulting capacity.
- Keep the effective playback length capped to captured audio so `setLength`, half, double, crop, and auto snap cannot read beyond valid buffer content.

Memory impact remains acceptable on Raspberry Pi. At 48kHz stereo using 32-bit samples, a 41 second slot buffer is about 15.7 MB per slot, or about 31.4 MB for two slots. Pd/object overhead adds some extra memory, but this is not expected to be a limiting factor on a typical Pi used for this project.

## MIDI Config Changes

Extend MIDI config validation to allow optional note controls:

- `slot1AutoLoop1Beat`
- `slot1AutoLoop2Beat`
- `slot1AutoLoop4Beat`
- `slot1AutoLoop2Bar`
- `slot2AutoLoop1Beat`
- `slot2AutoLoop2Beat`
- `slot2AutoLoop4Beat`
- `slot2AutoLoop2Bar`
- `slot1Half`
- `slot1Double`
- `slot2Half`
- `slot2Double`
- `tapTempo`

These should be optional so existing configs still load. If a control is missing, that feature is simply unmapped for that controller.

## Controller Changes

Add SlotController methods:

- `autoLoopSlot(slotId, durationKey)`
- `setSlotLength(slotId, lengthMs)`
- `multiplySlotLength(slotId, factor)`

Add scheduler handling for pending auto-records:

- One pending auto-record per slot.
- Clear pending timers when the slot is cleared.
- Ignore normal tap/record actions if an auto-record is pending, or cancel the pending auto-record explicitly. The first implementation should ignore conflicting actions and log why.

The existing manual record/play/stop flow remains unchanged.

## Error Handling

Expected non-fatal cases:

- No MIDI clock and no tap BPM: log that tempo is unavailable and do nothing.
- Auto-loop button pressed while recording: log and do nothing.
- Auto-loop already pending for slot: log and do nothing.
- Requested set length exceeds available audio: Pd clamps to the maximum captured length and emits the actual length.
- Missing optional MIDI mapping: do not register a handler for that feature.

## Testing

Add unit tests for:

- MIDI clock BPM estimation and stale detection.
- Tap tempo BPM estimation and reset behavior.
- Auto-loop duration calculation for all four modes.
- MIDI clock auto-loop schedules start on the closest beat.
- Tap fallback auto-loop starts immediately.
- Empty-slot auto-loop sends `rec 1`, then `rec 0`, then `play 1`.
- Existing-loop auto button sends `setLength` and preserves start offset.
- Half/double send absolute `setLength` values.
- Pending auto-records are cleared by `clearSlot`.
- Existing MIDI config files still load when optional controls are absent.

Add Pd patch tests for:

- `looper_slot.pd` routes `setLength`.
- `setLength` emits a length state.
- Post-stop tail capture is 20 seconds and array capacity matches the documented recording window.

Add or update integration tests where practical:

- Record a short loop, send `setLength`, verify the next length state.
- Verify clear after pending/active auto-loop returns slot to zero length.

## Out of Scope

- Time signature configuration beyond assuming 4/4 for 2 bars.
- Audio timestretching or pitch shifting.
- Quantized playback phase resets for existing loops.
- Visual loop position feedback.
- Per-slot independent BPM.
