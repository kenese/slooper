# Plan: Complete `looper_slot.pd` Refactor

## Current state

- The committed `src/engine.pd` is the known-good behavioral reference:
  - Slot 1 recording, playback, stop/resume, crop, reset, stereo buffers, anti-click envelope, state output, and monitor routing are implemented inline.
  - Slot 2 OSC routing exists in the top-level route, but committed `engine.pd` does not implement slot 2 audio processing.
  - There is no first-class `clear` route in the committed slot logic; Node sends `clear`, but Pd currently relies mostly on `play 0`/new recording behavior.
- `src/engine.pd` is now mostly an orchestration patch:
  - OSC receive/parse/route.
  - Audio input scaling.
  - Two `[looper_slot slot1]` / `[looper_slot slot2]` instances.
  - Slot audio summing, monitor passthrough, DSP loadbang, and state `netsend`.
- `src/looper_slot.pd` contains the per-slot audio engine:
  - Left/right recording into `#1_data` / `#1_data_R`.
  - Playback with `phasor~`, `tabread4~`, crop/reset length logic, and anti-click envelope.
  - State output via `oscformat /state`.
- `src/index.js` already sends slot-scoped OSC messages like `/slot1 rec 1`, `/slot2 crop -30`, `/slotX reset 1`, and `/slotX clear 1`.
- Slot 2 is now wired in `engine.pd`, but the extracted slot abstraction still needs validation as the single source of truth for slot behavior.

## Known-good baseline

Use this commit as the pre-refactor working reference:

```text
f9d710d7362e01f5643ae6e1bc3b03abdee8000f
```

Short ref:

```text
f9d710d
```

Commit message:

```text
engine tidy. THis is working in one file. About to move to looper slot module
```

Useful commands while refactoring:

```bash
git diff f9d710d -- src/engine.pd src/looper_slot.pd
git show f9d710d:src/engine.pd
git show f9d710d:src/looper_slot.pd
```

The behavioral source of truth is `f9d710d:src/engine.pd`. That file has the working inline slot 1 implementation. The goal is to preserve that behavior inside `src/looper_slot.pd`, then instantiate it per slot from `src/engine.pd`.

## Main risks to control

- Pd text patch editing is fragile because `#X connect` lines reference zero-based object indices.
- Abstraction inlet/outlet ordering must be verified. The intended contract should be:
  - Inlets: left audio signal, right audio signal, control messages.
  - Outlets: left loop signal, right loop signal, formatted OSC state message.
- `clear` is sent by Node but is not currently routed inside `looper_slot.pd`; `route rec play crop reset` drops it.
- `length_msg.pd` and `state_msg.pd` exist but are not currently used. For this refactor, ignore them unless the message formatting inside `looper_slot.pd` becomes meaningfully harder to maintain.
- `analyze_pd.py` currently treats every `#X` line as an object, including `#X f` formatting lines, which can produce misleading object indices for patches with split object formatting.
- The final top-level patch should be easy to extend beyond two slots, so avoid slot-specific hardcoding outside the one necessary OSC route and one abstraction instance per slot.

## Proposed implementation plan

1. Lock down the known-good behavior from committed `engine.pd`
   - Use committed `src/engine.pd` as the reference for slot internals, especially the order of trigger objects around crop/reset.
   - Map each inline slot 1 object group to the equivalent object group in `looper_slot.pd`.
   - Check for behavioral drift introduced by the extraction, including state message formatting and the previous crop/reset fixes.

2. Establish the abstraction contract
   - Confirm the visual and runtime inlet/outlet order of `looper_slot.pd`.
   - Adjust the abstraction layout if needed so the left-to-right inlet/outlet order matches the engine connections.
   - Contract:
     - Args: slot name, e.g. `[looper_slot slot1]`.
     - Inlets: left audio signal, right audio signal, control messages.
     - Outlets: left loop signal, right loop signal, formatted OSC state message.
   - Keep `engine.pd` responsible only for global OSC routing, audio input/output, monitoring, slot mixing, and `netsend`.
   - Keep each slot instance self-contained by deriving all array/state names from `$1`.

3. Validate current slot 1 behavior before broadening changes
   - Start Pd with `src/engine.pd`.
   - Run the existing OSC regression flow against `/slot1`.
   - Confirm state messages are emitted as `/state slot1 recording|stopped|playing|paused` and `/state slot1 length <ms>`.
   - Confirm crop, reset, and anti-click playback still behave after extraction.

4. Make `clear` a first-class slot command
   - Change `looper_slot.pd` control routing from `rec play crop reset` to include `clear`.
   - On `clear`, stop playback gate, reset phasor phase, reset crop accumulator, reset active/original length to a safe value, and stop recording writes.
   - Emit a deterministic state message. Proposed default: `/state slotX stopped` plus `/state slotX length 0`, because Node's state machine already uses empty/stopped separately and no current code expects a `cleared` Pd state.
   - Verify clear does not leave old playback audio running and does not carry crop offset into the next recording.

5. Confirm true two-slot independence
   - Verify `#1_data` and `#1_data_R` resolve to separate arrays for `slot1` and `slot2`.
   - Record, play, crop, reset, pause, and clear each slot independently.
   - Verify both slots can play together and sum correctly in `engine.pd`.
   - Verify slot 1 commands never alter slot 2 state or length, and vice versa.

6. Keep the top-level shape extendable
   - Keep `engine.pd` as a repeated-slot host: one route outlet, one `[looper_slot slotN]`, two audio-sum connections, and one state-out connection per slot.
   - Do not duplicate slot internals in `engine.pd`.
   - If adding a third slot later, the expected work should be limited to:
     - Add `slot3` to the OSC route.
     - Add `[looper_slot slot3]`.
     - Connect the shared audio inputs, slot outputs, and state outlet.
     - Add a Node MIDI mapping/state entry.

7. Decide what to do with helper abstractions
   - Ignore `src/state_msg.pd` and `src/length_msg.pd` for the initial completion unless `looper_slot.pd` message wiring becomes messy.
   - Include them in a possible later cleanup if multiple slot-like abstractions start formatting `/state` messages or if message formatting grows beyond simple state/length output.

8. Improve validation tooling before final edits
   - Update or replace the local Pd parser/checker so it ignores `#X f` formatting lines and reports unresolved connections accurately.
   - Add a simple check that `engine.pd` has the expected `[looper_slot ...]` instances and that each state outlet reaches `netsend`.
   - Avoid large hand-written Pd text rewrites; prefer Pd GUI edits or tiny, reviewed textual patches.

9. Update regression tests
   - Extend `test/test_engine.js` to assert slot 2 state and length messages, not just command send success.
   - Add clear-specific assertions:
     - Clear emits the expected state.
     - Clear followed by a fresh recording reports a fresh length.
     - Clear stops playback state for both slots.
   - Add cross-slot assertions:
     - Slot 1 crop/reset does not affect slot 2.
     - Slot 2 crop/reset does not affect slot 1.

10. Documentation cleanup
   - Update `CLAUDE.md` current-state notes once slot 2 is confirmed working.
   - Update `README.md` TODOs if reset/slot 2 behavior is now fixed.
   - Document the `looper_slot.pd` abstraction contract in a short comment block or repo doc.

## Acceptance criteria

- `engine.pd` contains no duplicated per-slot DSP logic.
- `looper_slot.pd` is the only implementation of slot recording/playback/crop/reset/clear behavior.
- `/slot1` and `/slot2` both support `rec`, `play`, `crop`, `reset`, and `clear`.
- Both slots emit correctly namespaced `/state` messages.
- Existing crop timing, crop persistence, reset, and over-record regressions still pass for slot 1.
- Equivalent core behavior is covered for slot 2.
- Clearing a slot stops playback and resets crop/length state before the next recording.
- Adding another slot later does not require copying internal slot DSP/state logic.

## Pd GUI/runtime validation context

The reason I asked about Pd GUI/runtime validation is that Pd patch files are fragile to edit as raw text. Adding or deleting one object changes the object numbers used by every later `#X connect` line. The Pd GUI rewrites those indices correctly when objects are added and connected visually.

There are two practical approaches:

1. Text-only edits plus checks
   - Faster for small, mechanical changes.
   - Higher risk if we need to add several Pd objects or reconnect internals.
   - Requires parser/checker validation and OSC runtime tests afterward.

2. Pd GUI/runtime validation
   - Safer for object insertion/reconnection because Pd manages indices.
   - Lets us open `engine.pd`, confirm abstractions instantiate, watch console errors, and run OSC tests against a real patch.
   - More manual, but better for validating audio patch behavior.

Recommendation: use text edits only for simple, reviewable changes; use Pd runtime validation before considering the refactor done.

## Manual Pd Editor Workflow

Since the structural Pd changes will be safer in the Pd editor, use this workflow:

1. I will describe the exact patch-level change needed.
2. You make the structural edit in Pd and save the file.
3. I review the saved `.pd` diff and connection graph.
4. We repeat until `looper_slot.pd` matches the committed `engine.pd` slot behavior.
5. I can then update tests/docs and do any small text-only cleanup.

The first manual-editor pass should focus on these changes:

1. Rebuild or repair `looper_slot.pd` from committed `engine.pd` slot 1 logic
   - Use the committed inline slot 1 logic as the source of truth.
   - Keep the slot abstraction argument as the slot name.
   - Replace hardcoded slot-specific resources with argument-derived names:
     - `slot1_data` -> `#1_data`
     - `slot1_data_R` -> `#1_data_R`
     - state messages should output the instance slot name, e.g. `slot1` or `slot2`.
   - Preserve the existing crop/reset trigger ordering from committed `engine.pd`.

2. Set the abstraction interface clearly
   - Inlets, left to right:
     - left audio signal
     - right audio signal
     - control messages
   - Outlets, left to right:
     - left loop signal
     - right loop signal
     - formatted `/state` OSC message
   - After saving, I will verify the actual inlet/outlet ordering from the file and top-level connections.

3. Keep `engine.pd` as a slot host
   - `engine.pd` should have one `[looper_slot slotN]` object per slot.
   - Both slots should receive the same scaled stereo audio input.
   - Each slot audio output should feed the shared stereo sum.
   - Each slot state outlet should feed the shared `netsend`.
   - The only slot-specific top-level wiring should be route outlet -> slot control inlet and slot outputs -> mix/state.

4. Leave helper abstractions alone for now
   - Do not wire `length_msg.pd` or `state_msg.pd` into the current refactor.
   - Revisit later only if message formatting becomes duplicated outside `looper_slot.pd`.

5. Defer `clear` until the extraction exactly matches known-good behavior
   - First goal: extracted slot 1 behaves like committed inline slot 1, and slot 2 behaves the same independently.
   - Second goal: add `clear` as a proper command once the extraction baseline is stable.
