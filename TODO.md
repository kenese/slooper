# TODO — Deferred from Code Review (2026-05-17)

## Requires Pd patch work

### `moveSlot` sends two OSC commands non-atomically
- **File:** `src/controller/slot_controller.js` — `moveSlot()`
- **Problem:** Sends `cropStart` and `crop` as separate OSC messages. Between them, Pd's loop window is briefly inconsistent, which can produce a click.
- **Fix:** Add a `/slotN move <delta>` command to `looper_slot.pd` that adjusts start and end crop atomically. Update `moveSlot()` to send that single message instead.

## Robustness — low risk in current use, worth revisiting

### WebSocket has no origin check
- **File:** `src/controller/web_server.js` — `wss.on('connection', ...)`
- **Problem:** Any local process can connect to the WebSocket. Currently safe because the server binds to `127.0.0.1` only.
- **Fix:** If the server is ever exposed on `0.0.0.0` (e.g. for network access from a phone), add an origin check or token-based auth on connection.

### `dev_controller.js` `onStateChange` reassignment is brittle
- **File:** `src/dev_controller.js:115`
- **Problem:** `controller.onStateChange = webServer.broadcast` clobbers any previous handler. If another module wraps `onStateChange`, this silently drops it.
- **Fix:** Adopt a consistent wrap pattern (same as `index.js:141-145`) or expose an event emitter / `addStateListener()` method on `SlotController`.

### `TapTempoTracker` assumes monotonic timestamps
- **File:** `src/controller/tempo.js` — `TapTempoTracker.tap()`
- **Problem:** A backward `Date.now()` jump (NTP correction) produces a negative interval. Currently harmless because `interval > 0` filters it, but it silently discards a tap.
- **Fix:** Use `performance.now()` (monotonic) inside the tracker, or document the assumption explicitly.

### `force_cleanup` pkill patterns match any character for `.`
- **File:** `start.sh` — `force_cleanup()`
- **Problem:** `pkill -f "node src/index.js"` uses an unescaped `.` which is a regex wildcard. In practice the patterns are specific enough to not have false positives, but they'd technically match `node src/indexXjs`.
- **Fix:** Escape the dots: `pkill -f "node src/index\.js"`. Requires updating the corresponding test in `test/unit/start_script.test.js` to match the new pattern.
