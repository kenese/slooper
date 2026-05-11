# Slooper Engineering Improvement Plan

This plan addresses the current engineering, architecture, performance, developer-experience, and agent-experience issues found during the project review. It intentionally replaces the older `looper_slot.pd` refactor plan, because that work is now mostly represented in the current code and docs.

## Goals

- Keep `src/engine.pd` and `src/looper_slot.pd` stable, reviewable, and safe for agents to work around.
- Avoid functional Pd DSP changes during infrastructure cleanup unless a phase explicitly calls them out.
- Make hardware/device behavior explicit instead of spread across docs, shell scripts, and controller code.
- Reduce duplicate controller logic between MIDI mode and browser OSC mode.
- Improve test reliability so changes can be verified without manual Pure Data console inspection.
- Make Raspberry Pi installs lighter and startup/shutdown safer.
- Keep project guidance useful for future human and agent contributors without stale contradictions.

## Implementation Principles

- Prefer small, independently testable changes over one large rewrite.
- Add characterization tests before extracting shared controller behavior.
- Keep `engine.pd` and `looper_slot.pd` edits rare, deliberate, and verified with `git diff`.
- Treat Pd `/state` as the source of truth, but preserve responsive UI/LED feedback with explicit pending state where useful.
- Keep all runtime/generated files under `.runtime/` and out of git.
- Every implementation phase should end with a concrete command that proves the phase worked.

## Phase 0: Baseline And Safety Net

### Deliverables

- Capture the current worktree state before implementation.
- Add or document a quick baseline verification command for the current engine tests.
- Confirm whether the starting point is expected to have dirty files.

### Suggested Work

- Run:

```bash
git status --short
git diff -- src/engine.pd src/looper_slot.pd
npm run test:engine
```

- If `npm run test:engine` cannot run because Pd is not already open, record that as the baseline and continue with the managed test runner phase later.
- Before any Pd text edit, copy the target patch to `.runtime/backups/` or rely on git plus a focused `git diff -- src/*.pd` review.

### Acceptance Checks

- We know whether the worktree was dirty before implementation.
- We know whether existing tests pass, fail, or require manual Pd startup.
- No implementation phase starts by changing Pd files blindly.

## Current Issues

1. `start.sh` mutates `src/engine.pd` on every run with `sed`.
   - This makes normal execution dirty the working tree.
   - It contradicts the project warning that text editing Pd files is fragile.
   - It makes agent work riskier because runtime config and source code are mixed.

2. Linux audio-device selection is incomplete.
   - `audio-device=Z1` changes Pd channel declarations, then Linux mode forces them back to `adc~ 1 2` / `dac~ 1 2`.
   - JACK connections remain hardcoded to XONE capture channels 9/10.
   - Device-specific JACK capture/playback routing needs to live in config.

3. Cleanup is too broad.
   - `start.sh` kills all Pd/JACK processes instead of only processes it started.
   - This is acceptable on a dedicated appliance, but rough for development and unsafe for unrelated audio work.

4. Controller logic is duplicated.
   - `src/index.js` and `src/dev_controller.js` both implement slot state, crop offsets, monitor behavior, and OSC command sequencing.
   - Future bug fixes must be made twice.

5. Node-side state can drift from Pd-side state.
   - Node estimates loop length from `Date.now()` and assumes OSC commands succeed.
   - Pd already emits `/state` messages; the controller should either reconcile with those or treat Pd as authoritative.

6. Tests are partly manual.
   - Many tests only verify that commands can be sent or require "visual verification" in the Pd console.
   - The test suite requires Pd to be started manually.
   - There is no clear CI-like command that starts Pd, waits for readiness, runs tests, and shuts down.

7. Performance and Pi install footprint can be improved.
   - Runtime Pd `print` objects are always active.
   - `puppeteer`, `puppeteer-extra`, and `puppeteer-extra-plugin-stealth` are production dependencies but do not appear to be used by project code.
   - Pd array size and crop maximum should be checked for consistency.

8. Developer experience needs consolidation.
   - Useful commands exist in docs but not npm scripts.
   - Node version guidance differs between README and CLAUDE.
   - Hardware setup is scattered across `README.md`, `CLAUDE.md`, `SKILLS.md`, `start.sh`, and `src/index.js`.

9. Agent experience is good but stale in places.
   - The docs contain valuable Pd-specific warnings, but also contradictions and outdated values.
   - `SKILLS.md` includes destructive git discard commands that agents should not follow without explicit user approval.
   - Repo clutter makes intent harder to infer: empty files (`Audio`, `Bang`, `Start`), IDE files, root-level one-off scripts, and unused helper patches.

## Phase 1: Stop Runtime Mutation Of Pd Source

### Deliverables

- Replace `sed` edits to `src/engine.pd` with one of these approaches:
  - Preferred: make `engine.pd` use stable logical `adc~ 1 2` / `dac~ 1 2`, and handle hardware channel mapping outside Pd.
  - Alternative: generate `.runtime/engine.pd` from the tracked patch and run Pd against the generated file.
- Add `.runtime/` to `.gitignore` if generation is used.
- Ensure `./start.sh` no longer changes tracked files during normal startup.

### Suggested Work

- On Linux/JACK, always keep Pd logical ports as `input_1/2` and `output_1/2`; select actual capture/playback ports through JACK config.
- On macOS, prefer configuring device channels in Pd preferences when possible. If direct channel selection is still needed for XONE channel 9/10, use the `.runtime/engine.pd` generation path instead of mutating `src/engine.pd`.
- Add a dry-run mode before changing startup behavior heavily:

```bash
./start.sh --print-config device=MAC midi-device=OSC
./start.sh --print-config audio-device=XONE
```

- Add a guard command for agents:

```bash
git diff -- src/engine.pd src/looper_slot.pd
```

This should remain clean after startup unless a developer intentionally edited patches.

### Acceptance Checks

- `./start.sh device=MAC midi-device=OSC` does not modify tracked files.
- `./start.sh audio-device=XONE` on Linux does not modify tracked files.
- `git diff -- src/engine.pd` stays empty after startup and shutdown.
- `./start.sh --print-config ...` shows the Pd patch path, Pd launch mode, MIDI profile, OSC ports, and JACK port mapping that would be used.

## Phase 2: Centralize Device And Runtime Config

### Deliverables

- Add a config module/file, for example:

```text
config/devices.json
src/config.js
```

- Move these values out of scattered code and docs:
  - MIDI device match names.
  - MIDI note/CC mappings.
  - Audio device names.
  - JACK device match rules.
  - JACK capture ports.
  - JACK playback ports.
  - Pd launch mode.
  - Default sample rate, period size, and period count.
  - OSC host/ports.
  - Hold threshold, crop step, and encoder throttle.

### Suggested Config Shape

```json
{
  "osc": {
    "host": "127.0.0.1",
    "sendPort": 9000,
    "statePort": 9001
  },
  "audioDevices": {
    "XONE": {
      "jackCardNameIncludes": "XONE",
      "capturePorts": ["system:capture_9", "system:capture_10"],
      "playbackPorts": ["system:playback_1", "system:playback_2"]
    },
    "Z1": {
      "jackCardNameIncludes": "Traktor Z1",
      "capturePorts": ["system:capture_1", "system:capture_2"],
      "playbackPorts": ["system:playback_3", "system:playback_4"]
    },
    "MAC": {
      "mode": "native-pd"
    }
  },
  "midiDevices": {
    "XONE": {},
    "X1MK3": {},
    "OSC": {}
  }
}
```

### Implementation Notes

- Avoid requiring `jq` on the Raspberry Pi. Either keep config as a CommonJS module or use a small Node helper that prints shell-safe values for `start.sh`.
- Keep controller timing values in the same config source:

```json
{
  "controller": {
    "holdThresholdMs": 500,
    "cropStepMs": 30,
    "encoderThrottleMs": 50,
    "playOnPress": false
  }
}
```

- Keep MIDI mappings declarative, but let `midi_adapter.js` own low-level easymidi quirks such as index-first opening on Linux.

### Acceptance Checks

- Adding or changing a device mapping does not require editing controller logic.
- `start.sh` reads config or delegates to a Node startup helper that reads config.
- README, CLAUDE, and SKILLS no longer duplicate the full hardware mapping table.
- Runtime logs no longer disagree with config values, especially hold threshold and encoder throttle.

## Phase 3: Safer Process Lifecycle

### Deliverables

- Replace broad process killing with tracked process cleanup.
- Record child PIDs for Pd, JACK started by Slooper, and Node/web controller.
- Only stop JACK automatically if Slooper started it, unless the user passes an explicit `--stop-jack` or `--force-cleanup` flag.
- Keep the current broad cleanup behavior available only behind an explicit flag.

### Suggested Work

- Use a runtime PID directory:

```text
.runtime/pids/
```

- Add commands:

```bash
./start.sh --stop
./start.sh --status
./start.sh --force-cleanup
```

- Keep a dedicated-appliance mode for Pi if desired:

```bash
./start.sh --appliance
```

In appliance mode, broad cleanup can remain available and explicit.

### Acceptance Checks

- Stopping Slooper does not kill unrelated Pd/JACK sessions by default.
- `./start.sh --stop` cleans up Slooper-started processes.
- `./start.sh --force-cleanup` keeps the current broad behavior for emergency use.
- If JACK was already running before Slooper started, normal shutdown leaves it running.

## Phase 4: Extract Shared Controller Core

### Deliverables

- Split `src/index.js` into small modules.
- Make MIDI mode and browser mode use the same slot state machine and OSC command sequencing.

### Proposed Structure

```text
src/
  controller/
    slot_controller.js       # slot state machine and high-level actions
    osc_transport.js         # send OSC and receive /state
    midi_adapter.js          # maps MIDI events to controller actions
    web_adapter.js           # maps HTTP actions to controller actions
    state.js                 # state constants and serialization
  config.js
  index.js                  # MIDI entrypoint
  dev_controller.js          # web entrypoint
```

### Suggested Work

- Start with unit tests around the current behavior before moving code.
- Replace numeric slot states with named constants:

```javascript
const SlotState = {
  EMPTY: 0,
  RECORDING: 1,
  PLAYING: 2,
  STOPPED: 3,
};
```

- Move these actions into the shared controller:
  - tap slot
  - clear slot
  - crop slot
  - reset slot
  - monitor toggle
  - monitor auto-mute when any loop is playing

- Keep MIDI-specific behavior in `midi_adapter.js`:
  - hold timer
  - note/CC matching
  - LED output
  - play-on-press vs play-on-release

- Keep browser-specific behavior in `web_adapter.js`:
  - HTTP routing
  - static HTML serving
  - JSON serialization

### Suggested Shared Controller API

```javascript
const controller = createController({
  slots: [1, 2],
  transport,
  config,
  onStateChange,
});

await controller.tapSlot(1);
await controller.clearSlot(1);
await controller.cropSlot(1, -30);
await controller.resetSlot(1);
await controller.toggleMonitor();
controller.applyPdState(['slot1', 'length', 512]);
controller.applyPdState(['slot1', 'playing']);
```

The transport should be injectable so unit tests can assert OSC command sequences without running Pd.

### Acceptance Checks

- A crop/reset/clear behavior change is made in one shared place.
- Browser controller and MIDI controller produce the same OSC command sequence for the same high-level action.
- Existing manual workflows still work:

```bash
./start.sh
./start.sh device=MAC midi-device=OSC
```

## Phase 5: Make Pd State Authoritative

### Deliverables

- Add a state-listening OSC server to the controller path, not just the test path.
- Reconcile Node/web state from Pd `/state` messages.
- Decide what Node is responsible for versus what Pd is responsible for.
- Avoid two processes trying to bind OSC state port `9001` at the same time.

### Recommended Contract

- Pd is authoritative for:
  - actual recorded length
  - cropped/current playback length
  - recording/playing/paused/stopped state emitted from the audio engine
  - clear/reset result

- Node is authoritative for:
  - incoming user intent
  - hold detection
  - MIDI LED presentation
  - monitor preference before auto-mute

### Suggested Work

- Have the shared OSC transport listen on state port `9001`.
- Update slot length from `/state slotX length <ms>`.
- Update slot state from `/state slotX recording|playing|paused|stopped`.
- Keep a transient "pending action" if needed for responsive LED/UI feedback.
- Consider adding a `/state slotX empty` or `/state slotX cleared` message only if the current `stopped + length 0` contract becomes ambiguous.
- Let tests use an alternate state port via config or ensure the managed test runner is the only process listening during engine tests.

### Acceptance Checks

- Browser UI shows Pd-reported loop length, not a `Date.now()` estimate.
- MIDI LED behavior recovers if Pd emits a state that differs from the assumed Node state.
- Tests can validate controller state by sending fake or real `/state` messages.
- Starting the web controller while tests are running fails clearly or uses distinct configured ports.

## Phase 6: Improve Test Automation

### Deliverables

- Convert visual-verification tests into assertions where possible.
- Add a test command that starts Pd headless for the integration suite.
- Add unit tests for the shared controller core.

### Proposed Scripts

```json
{
  "scripts": {
    "test": "npm run test:unit && npm run test:engine",
    "test:unit": "node --test test/unit/*.test.js",
    "test:engine": "node test/test_engine.js",
    "test:engine:managed": "node test/run_engine_tests.js",
    "dev:mac": "./start.sh device=MAC midi-device=OSC",
    "midi:log": "node src/midi_logger.js",
    "osc:debug": "node scripts/debug_osc.js"
  }
}
```

### Test Strategy Tweaks

- Split tests into three layers:
  - Unit tests for shared controller behavior with fake transport.
  - OSC contract tests for command/state message formatting.
  - Managed engine integration tests that require Pd.
- Keep the default `npm test` fast enough for local iteration. If managed Pd startup is slow or platform-specific, expose it as `npm run test:engine:managed` and document when to use it.
- Ensure every engine integration test begins by clearing both slots so tests do not inherit Pd state from a previous test.

### Engine Test Improvements

- Add assertions for every currently visual-only test:
  - `rec 1` emits `recording`.
  - `rec 0` emits `stopped` and `length`.
  - `play 1` emits `playing`.
  - `play 0` emits `paused`.
  - crop lower bound emits the minimum length.
  - cumulative crop emits the expected length.
  - monitor command emits a state/debug message, if Pd is extended to report monitor state.

- Add startup readiness:
  - Start Pd with `pd -nogui -nomidi src/engine.pd` where possible.
  - Send `/connect` until state port receives a known response.
  - Fail fast with a clear message if Pd is missing.

### Unit Test Targets

- Tap state transitions.
- Hold-to-clear behavior.
- Play-on-press versus play-on-release.
- Crop throttling and delta accumulation.
- Monitor auto-mute.
- State reconciliation from `/state`.

### Acceptance Checks

- `npm test` has no tests that pass only because "no exception was thrown" unless that is explicitly the behavior under test.
- A clean checkout can run a documented test command on Mac dev mode.
- Known regressions from CLAUDE are represented by named tests.
- Unit tests can run without Pd, MIDI hardware, JACK, or audio devices.

## Phase 7: Performance And Pi Footprint

### Deliverables

- Remove unused heavy dependencies or move browser tooling to `devDependencies`.
- Add debug gating for Pd console output.
- Align buffer size, sample rate, and crop/record limits.

### Suggested Work

- Search usage before removing dependencies:

```bash
grep -R "puppeteer\\|puppeteer-extra" . --exclude-dir=node_modules
```

- If unused, remove:

```bash
npm uninstall puppeteer puppeteer-extra puppeteer-extra-plugin-stealth
```

- If browser tests are added later, install only `puppeteer` as a dev dependency.
- Add a Pd debug control path or maintain separate debug patches if runtime print gating is awkward in Pd.
- Verify these values agree:
  - array size in samples
  - sample rate
  - maximum recording/extension length
  - crop upper bound

### Additional Checks

- Update both `package.json` and `package-lock.json` when dependencies move or are removed.
- If Pd debug `print` objects remain, document that they are intentional and harmless; otherwise gate or remove the noisy ones in a focused Pd patch review.

### Acceptance Checks

- `npm install --omit=dev` on Pi does not install Chromium/Puppeteer.
- Normal Pi runtime does not spam Pd console unless debug is enabled.
- The maximum loop length cannot exceed allocated array capacity.

## Phase 8: Developer Experience Cleanup

### Deliverables

- Add practical npm scripts.
- Add `engines.node` to `package.json`.
- Normalize project docs around one recommended Node version.
- Move helper scripts into `scripts/`.

### Suggested Work

- Use Node 18+ as the current practical baseline unless testing proves Node 20+ works cleanly on the Pi target.
- Update `package.json`:

```json
{
  "main": "src/index.js",
  "engines": {
    "node": ">=18"
  }
}
```

- Move root scripts:
  - `send_osc.js` -> `scripts/send_osc.js`
  - `debug_osc.js` -> `scripts/debug_osc.js`
  - `analyze_pd.py` -> `scripts/analyze_pd.py`
  - `parse_pd.js` -> `scripts/parse_pd.js`

- Delete or document:
  - `Audio`
  - `Bang`
  - `Start`
  - `src/engine_connections.pd.txt`
  - `src/engine_connections.txt`
  - `src/length_msg.pd`
  - `src/state_msg.pd`

Only delete helper files after confirming they are not used by an active workflow.

### Recommended First Pass

- Move helper scripts before deleting anything.
- Add compatibility notes or wrapper scripts if docs still reference the old root paths.
- Delay deletion of Pd helper patches until after engine tests and docs are updated, because they may encode useful message-format experiments.

### Acceptance Checks

- `npm run` shows the common project workflows.
- A new developer can start Mac dev mode from README without reading three docs.
- Root directory contains source, docs, package files, and clearly named script/config directories only.

## Phase 9: Agent Experience And Documentation

### Deliverables

- Split human-facing and agent-facing docs cleanly.
- Remove contradictions between README, CLAUDE, SKILLS, code, and tests.
- Replace destructive agent instructions with safer alternatives.

### Suggested Documentation Shape

```text
README.md       # user/developer quickstart and architecture summary
AGENTS.md       # agent-safe implementation guidance
SKILLS.md       # operational commands only, if still useful
CLAUDE.md       # optional compatibility copy or remove after AGENTS.md exists
```

### Required Doc Fixes

- Fix README nested code fence in the Pi Node install section.
- Align Node version guidance.
- Align `CONFIG.throttleMs` docs with code.
- Align hold threshold wording: docs say 500ms, runtime log says "Hold 1s".
- Rename or remove duplicate guidance between `CLAUDE.md` and `AGENTS.md`; if both stay, identify one as generated/compatibility copy.
- Keep Pd editing warnings, especially:
  - Pure Data object indices are fragile.
  - Escaped commas in saved `expr` objects.
  - `print` has no outlets.
  - abstraction args use `$1`.
  - trigger order is right-to-left.
- Remove or soften destructive git commands in `SKILLS.md`.
  - Replace `git checkout HEAD -- .` with "ask before discarding changes".

### Acceptance Checks

- A future agent can identify:
  - entrypoints
  - source-of-truth config
  - test commands
  - safe Pd editing rules
  - prohibited destructive operations
- Docs do not contain stale implementation claims contradicted by code.
- `rg "throttleMs|Hold 1s|adc~ 9 10|git checkout HEAD --"` either finds no stale guidance or finds intentional, contextual references.

## Phase 10: Optional Product Improvements

These are not blockers for the engineering cleanup, but they are natural next features once the base is stable.

- Pre-record buffer so loop start can be adjusted, not just loop end.
- Loop position feedback in Pd, browser UI, and/or MIDI LEDs.
- Better web controller affordances:
  - keyboard shortcuts
  - current loop position
  - Pd connection status
  - authoritative Pd length/state display
- More than two slots through a config-driven slot list.

## Recommended Execution Order

1. Baseline current behavior and worktree state.
2. Stop mutating `src/engine.pd` at startup.
3. Centralize device config and fix Linux `audio-device` JACK routing.
4. Make process lifecycle cleanup safer.
5. Add controller unit tests, then extract shared controller core.
6. Make Pd `/state` authoritative in Node/web state.
7. Upgrade tests and add a managed engine test runner.
8. Remove unused dependencies and reduce Pi runtime noise.
9. Clean npm scripts, Node version, helper files, and repo layout.
10. Refresh README/AGENTS/SKILLS/CLAUDE so future agents get accurate guidance.

## Suggested Implementation Slices

These slices are safer than implementing the plan strictly phase-by-phase as one long branch:

1. **Startup safety slice:** Phase 0, Phase 1, and the minimal config needed to stop Pd source mutation.
2. **Runtime config and lifecycle slice:** Phase 2 and Phase 3.
3. **Controller core slice:** Phase 4, with unit tests first.
4. **Authoritative state and tests slice:** Phase 5 and Phase 6.
5. **Cleanup slice:** Phase 7, Phase 8, and Phase 9.

Each slice should leave the project runnable before moving to the next.

## Definition Of Done

- Normal startup and shutdown leave the git worktree clean.
- `audio-device=XONE`, `audio-device=Z1`, and `device=MAC` are represented in centralized config.
- Browser and MIDI controls share the same core controller behavior.
- Controller state is reconciled from Pd `/state` messages.
- Tests cover state transitions, crop/reset/clear regressions, slot independence, and controller core logic.
- Pi production install avoids unused browser automation dependencies.
- Runtime Pd logging can be disabled.
- Docs are consistent, agent-safe, and current.
