# Slooper Remaining Backlog

Last reviewed: 2026-05-18

This file replaces the older engineering improvement plan. Most of that plan has already landed: runtime Pd patch generation, centralized config, safer startup lifecycle, shared controller core, Pd state reconciliation, npm scripts, Node version metadata, and unit coverage are now present in the repo.

Use this as the current backlog, not as a historical checklist.

## Current Baseline

- `start.sh` launches generated `.runtime/engine.pd` and does not mutate tracked Pd patches during normal startup.
- Audio and MIDI device behavior is centralized through `src/config.js`, `config/audio/*.json`, and `config/midi/*.json`.
- `audio-device=XONE`, `audio-device=Z1`, and `audio-device=MAC` are represented in config.
- Runtime topology supports `channels=1..4` and `slots-per-channel=2|4`.
- MIDI and web controls share `src/controller/slot_controller.js`.
- `src/controller/osc_transport.js` listens for Pd `/state`; controller state is reconciled from Pd messages.
- Unit tests cover controller behavior, config, topology, web server routing, MIDI mapping, tempo logic, start script behavior, and Pd patch invariants.
- `package.json` has practical scripts and `engines.node >=18`.
- Heavy browser automation dependencies are not installed as production dependencies.

## Verification Commands

Run these before and after changing startup/config/controller behavior:

```bash
git status --short
npm test
./start.sh --print-config audio-device=XONE midi-device=WEB channels=2 slots-per-channel=2
git diff -- src/engine.pd src/looper_slot.pd
```

For Pd integration checks:

```bash
npm run test:engine:managed
```

If Pure Data is unavailable on the machine, record that explicitly and run the unit suite.

## High Priority

### 1. Clean Stale Documentation

The code has moved faster than the docs. Refresh the human and agent docs so they describe the current generated-engine architecture and current config layout.

Files to review:

- `README.md`
- `AGENTS.md`
- `CLAUDE.md`
- `SKILLS.md`
- `public/architecture.html`

Known stale or risky references to check:

```bash
grep -R "throttleMs\|Hold 1s\|adc~ 9 10\|git checkout HEAD --" -n \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.worktrees .
```

Acceptance checks:

- Docs identify `src/config.js` and `config/audio|midi/*.json` as source-of-truth config.
- Docs describe `.runtime/engine.pd` as generated and `src/engine.pd` as a legacy/generated-baseline host patch.
- Docs do not imply `start.sh` mutates tracked Pd files.
- Agent-facing docs keep the Pure Data editing warnings.
- Destructive git discard commands are removed or clearly require explicit user approval.

### 2. Reduce Runtime Pd Console Noise

Runtime Pd `print` objects are still active and should either be gated behind debug mode or documented as intentional diagnostics.

Current examples:

- `src/engine.pd`: `OSC_IN`, `DSP_ON`, `MONITOR`
- `src/channel_2slot.pd`: `CHANNEL_MONITOR`
- `src/looper_slot.pd`: `PENDING_LENGTH`

Acceptance checks:

- Normal Pi runtime does not spam Pd console unless debug is enabled, or the remaining prints are explicitly documented as expected.
- Any Pd text edits are small, reviewed with `git diff -- src/*.pd`, and covered by `npm test`.

### 3. Tighten Engine Integration Tests

`test/test_engine.js` has many assertions, but it still contains visual/manual verification language. Convert remaining visual-only checks to actual OSC state assertions where practical.

Focus areas:

- Replace "visual verify" test descriptions/comments with asserted behavior.
- Add or keep clear readiness/failure messaging for missing Pure Data.
- Keep `npm test` fast and hardware-free; keep Pd startup under `npm run test:engine:managed`.

Acceptance checks:

- Engine tests no longer pass important behavior solely because no exception was thrown.
- The managed runner starts Pd, runs the suite, and shuts Pd down.
- Known regressions around crop, reset, clear, slot independence, and topology remain covered.

## Medium Priority

### 4. Finish Process Lifecycle Edges

Linux JACK lifecycle is now PID-aware, but macOS cleanup still kills untracked Pd processes to work around GUI startup behavior.

Acceptance checks:

- Normal shutdown avoids killing unrelated Pd/JACK sessions where practical.
- Broad cleanup remains available only through explicit emergency/appliance paths.
- Any unavoidable macOS broad cleanup behavior is documented as a dev-mode caveat.

### 5. Clean Repository Clutter

Some helper or legacy files may still be useful, but they should either be documented or removed after verification.

Review candidates:

- `src/engine_connections.pd.txt`
- `src/engine_connections.txt`
- `src/length_msg.pd`
- `src/state_msg.pd`
- IDE and OS metadata files if tracked

Acceptance checks:

- Root and `src/` contain source, docs, package files, and clearly named support files.
- Deleted helper files are confirmed unused by tests, docs, startup, and active development workflows.

## Product Backlog

These are feature work, not cleanup blockers:

- Loop position feedback in Pd, web UI, and/or MIDI LEDs.
- Better web controller connection status and error states.
- More complete browser-controller ergonomics, such as keyboard shortcuts.
- Further testing on Raspberry Pi hardware for multi-channel JACK routing.

## Historical Work Already Done

The old plan included these as future phases, but they are now implemented enough that they should not be treated as open work:

- Stop runtime mutation of `src/engine.pd`.
- Centralize runtime/device config.
- Add `.runtime/` generated patch path.
- Add `--print-config`, `--stop`, `--status`, `--force-cleanup`, and appliance-mode startup controls.
- Extract shared controller core.
- Listen for Pd `/state` in controller paths.
- Add controller/unit tests.
- Add managed engine test runner.
- Remove Puppeteer production dependency concern.
- Add practical npm scripts and `engines.node`.

When this backlog changes, update this file directly instead of appending a second long-range plan.
