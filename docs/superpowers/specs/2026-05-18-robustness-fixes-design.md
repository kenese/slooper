# Robustness Fixes Design — 2026-05-18

Four small hardening changes from TODO.md. No Pd patch work; all changes are JS or bash.

---

## 1. WebSocket origin check (`web_server.js`)

**Problem:** `wss.on('connection', ...)` accepts any local connection with no origin validation. Safe today because the server binds to `127.0.0.1`, but fragile if the bind address ever changes.

**Fix:** In the `connection` handler, inspect `req.headers.origin`. If it is present and does not resolve to localhost (127.0.0.1 or `::1`), terminate the socket immediately. Connections without an `Origin` header (e.g. native WebSocket clients, curl) are accepted — the check targets browser-origin restrictions only.

```js
wss.on('connection', (ws, req) => {
    const origin = req.headers.origin;
    if (origin) {
        try {
            const host = new URL(origin).hostname;
            if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
                ws.terminate();
                return;
            }
        } catch {
            ws.terminate();
            return;
        }
    }
    ws.send(JSON.stringify(controller.getState()));
    ws.on('error', () => {});
});
```

**Files:** `src/controller/web_server.js`

---

## 2. `onStateChange` wrap in `dev_controller.js`

**Problem:** `dev_controller.js:115` does `controller.onStateChange = webServer.broadcast`, clobbering any previous handler set before this line.

**Fix:** Adopt the same wrap pattern used in `index.js:145-148`:

```js
const existingOnStateChange = controller.onStateChange;
controller.onStateChange = (state) => {
    existingOnStateChange(state);
    webServer.broadcast(state);
};
```

**Files:** `src/dev_controller.js`

---

## 3. Monotonic timestamps in `TapTempoTracker` (`tempo.js`)

**Problem:** `TapTempoTracker.tap()` defaults to `Date.now()`, which can jump backwards on NTP correction. A backward jump produces a negative interval; `interval > 0` silently drops the tap.

**Fix:**
- Change the default in `tap(timeMs = Date.now())` → `tap(timeMs = performance.now())`.
- Remove the explicit `Date.now()` argument from the one caller in `web_server.js:46` so it falls through to the monotonic default.

**Files:** `src/controller/tempo.js`, `src/controller/web_server.js`

---

## 4. Escape dots in `pkill` patterns (`start.sh`)

**Problem:** `force_cleanup()` uses unescaped `.` in three `pkill -f` patterns (lines 102–104). An unescaped `.` is a regex wildcard, so `node src/index.js` technically matches `node src/indexXjs`.

**Fix:** Escape to `\.` in each of the three patterns:
```bash
pkill -f "node src/index\.js"
pkill -f "node src/dev_controller\.js"
pkill -f "node src/midi_logger\.js"
```

Only `midi_logger.js` has an existing `assert.match` in `test/unit/start_script.test.js` (line 37); `index.js` and `dev_controller.js` are not tested. Update the one existing assertion to match the escaped form (the regex needs `\\\.` to match a literal `\` then `.`):

```js
// before
/pkill -f "node src\/midi_logger\.js" 2>\/dev\/null \|\| true/
// after
/pkill -f "node src\/midi_logger\\\.js" 2>\/dev\/null \|\| true/
```

**Files:** `start.sh`, `test/unit/start_script.test.js`

---

## Testing

- `npm test` (unit) — should pass unchanged after all four changes.
- Manual smoke: start the dev controller, open a browser WebSocket connection from localhost — should connect. A non-localhost origin should be terminated.
- Tap tempo: verify tap-to-tempo still works from the web UI after the `performance.now()` change.
