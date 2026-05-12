# Auto Loop Clock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-slot auto-loop buttons, MIDI-clock/tap tempo scheduling, loop length snap, half/double length transforms, and longer post-stop tail capture.

**Architecture:** Keep approach 1 from the design: Node.js owns clock/tap timing, button mapping, scheduling, and high-level slot behavior. Pure Data receives normal record/play commands plus one new `setLength` command that preserves the current start point and emits authoritative length state.

**Tech Stack:** Node.js CommonJS, `node:test`, `easymidi`, `node-osc`, Pure Data patch text tests.

---

### Task 1: Transport Clock and Tap Tempo

**Files:**
- Create: `src/controller/tempo.js`
- Test: `test/unit/tempo.test.js`

- [x] Write failing tests for MIDI clock BPM, stale detection, nearest beat calculation, tap tempo averaging, and tap reset after a long gap.
- [x] Run `node --test test/unit/tempo.test.js` and verify the module is missing.
- [x] Implement `MidiClockTracker`, `TapTempoTracker`, `AUTO_LOOP_DURATIONS`, and `getAutoLoopDurationMs`.
- [x] Run `node --test test/unit/tempo.test.js` and verify the tests pass.

### Task 2: Optional MIDI Controls

**Files:**
- Modify: `src/config.js`
- Test: `test/unit/config.test.js`

- [x] Add failing tests that optional auto-loop, half/double, and tap controls load when present while existing configs still load without them.
- [x] Run `node --test test/unit/config.test.js` and verify the new tests fail.
- [x] Extend MIDI config normalization with optional note controls.
- [x] Run `node --test test/unit/config.test.js` and verify config tests pass.

### Task 3: Slot Controller Auto Loop Methods

**Files:**
- Modify: `src/controller/slot_controller.js`
- Test: `test/unit/slot_controller.test.js`

- [x] Add failing tests for empty-slot auto record scheduling, tap fallback immediate start, existing-loop snap via `setLength`, half/double transforms, pending timer cleanup on clear, and unavailable tempo no-op.
- [x] Run `node --test test/unit/slot_controller.test.js` and verify the new tests fail.
- [x] Implement `autoLoopSlot`, `setSlotLength`, `multiplySlotLength`, pending auto-record state, and timer cleanup.
- [x] Run `node --test test/unit/slot_controller.test.js` and verify controller tests pass.

### Task 4: Runtime MIDI Wiring

**Files:**
- Modify: `src/index.js`
- Modify: `src/dev_controller.js`
- Modify: `public/dev-controller.html` if needed for dev testing
- Test: existing unit tests plus manual code inspection

- [x] Wire MIDI realtime `clock`, `start`, `stop`, and `continue` events into `MidiClockTracker` where `easymidi` exposes them.
- [x] Wire optional auto-loop, half/double, and tap controls into note handling.
- [x] Add equivalent web-controller actions for auto-loop, half, double, and tap tempo so the feature can be tested without hardware mappings.
- [x] Run `npm run test:unit`.

### Task 5: Pd `setLength` and Tail Capacity

**Files:**
- Modify: `src/looper_slot.pd`
- Modify: `test/unit/looper_slot_patch.test.js`
- Modify: `README.md`

- [x] Add failing patch tests for `setLength`, 20 second post-stop tail, and larger arrays.
- [x] Run `node --test test/unit/looper_slot_patch.test.js` and verify the new tests fail.
- [x] Update `looper_slot.pd` to route `setLength`, preserve start offset, update effective length, emit state length, delay stop by 21000ms, and resize arrays for 41 seconds at 48kHz.
- [x] Update README docs to describe the new controls and capture capacity.
- [x] Run `node --test test/unit/looper_slot_patch.test.js`.

### Task 6: Integration and Full Verification

**Files:**
- Modify: `test/test_engine.js` if the Pd engine test can cover `setLength` reliably.

- [x] Add or update an engine test that records a short loop, sends `/slot1 setLength <ms>`, and verifies the next length state.
- [x] Run `npm run test:unit`.
- [x] Attempt `npm run test:engine:managed`; local `pd` binary was unavailable in this environment.
- [x] Run `git status --short` and review the final diff.
