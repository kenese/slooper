# Slooper Robustness Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply four hardening changes from TODO.md: WebSocket origin check, non-clobbering `onStateChange` assignment in dev_controller, monotonic tap-tempo timestamps, and regex-safe dots in pkill patterns.

**Architecture:** Four independent, self-contained changes across three JS files, one bash script, and their unit tests. No new abstractions. Each task can be implemented and committed on its own; order does not matter.

**Tech Stack:** Node.js 18+, `ws` WebSocket library, `node:test` built-in test runner (`npm test` = `node --test test/unit/*.test.js`).

---

## File Map

| File | Change |
|---|---|
| `src/controller/web_server.js` | Add origin check in `wss.on('connection', ...)`; remove explicit `Date.now()` from `tapTempo.tap()` call |
| `src/controller/tempo.js` | Change `tap()` default from `Date.now()` to `performance.now()` |
| `src/dev_controller.js` | Replace direct `onStateChange` assignment with wrap pattern |
| `start.sh` | Escape `.` → `\.` in three `pkill -f` patterns |
| `test/unit/web_server.test.js` | Add 3 WebSocket origin tests; tighten tapTempo assertion |
| `test/unit/tempo.test.js` | Add test verifying `tap()` default is not `Date.now()` |
| `test/unit/start_script.test.js` | Update one `assert.match` regex for the escaped dot |

---

## Task 1: WebSocket origin check

**Files:**
- Modify: `src/controller/web_server.js` (around line 93)
- Modify: `test/unit/web_server.test.js`

- [ ] **Step 1: Add `WebSocket` import to test file**

At the top of `test/unit/web_server.test.js`, add after `const http = require('node:http');`:

```js
const { WebSocket } = require('ws');
```

- [ ] **Step 2: Write three WebSocket origin tests**

Append to `test/unit/web_server.test.js`:

```js
test('WebSocket rejects connection with non-localhost origin', async () => {
    const { webServer, port } = await startTestServer();
    try {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
            headers: { Origin: 'http://evil.example.com' },
        });
        await new Promise((resolve, reject) => {
            ws.on('close', resolve);
            ws.on('error', resolve);
            setTimeout(() => reject(new Error('connection not closed within 1s')), 1000);
        });
    } finally {
        await webServer.close();
    }
});

test('WebSocket accepts connection with localhost origin', async () => {
    const { webServer, port } = await startTestServer();
    try {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
            headers: { Origin: `http://127.0.0.1:${port}` },
        });
        await new Promise((resolve, reject) => {
            ws.on('open', () => { ws.close(); resolve(); });
            ws.on('error', reject);
            setTimeout(() => reject(new Error('timeout')), 1000);
        });
    } finally {
        await webServer.close();
    }
});

test('WebSocket accepts connection with no origin header', async () => {
    const { webServer, port } = await startTestServer();
    try {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        await new Promise((resolve, reject) => {
            ws.on('open', () => { ws.close(); resolve(); });
            ws.on('error', reject);
            setTimeout(() => reject(new Error('timeout')), 1000);
        });
    } finally {
        await webServer.close();
    }
});
```

- [ ] **Step 3: Run tests — confirm "evil origin" test fails**

```bash
node --test test/unit/web_server.test.js
```

Expected: `WebSocket rejects connection with non-localhost origin` FAILS with "connection not closed within 1s". The localhost and no-origin tests pass (server currently accepts everything).

- [ ] **Step 4: Implement origin check in web_server.js**

In `src/controller/web_server.js`, replace:

```js
    wss.on('connection', (ws) => {
        ws.send(JSON.stringify(controller.getState()));
        ws.on('error', () => {});
    });
```

With:

```js
    wss.on('connection', (ws, req) => {
        const origin = req.headers.origin;
        if (origin) {
            try {
                const { hostname } = new URL(origin);
                if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1') {
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

- [ ] **Step 5: Run tests — confirm all pass**

```bash
node --test test/unit/web_server.test.js
```

Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/controller/web_server.js test/unit/web_server.test.js
git commit -m "fix: reject WebSocket connections from non-localhost origins"
```

---

## Task 2: `dev_controller.js` onStateChange wrap

**Files:**
- Modify: `src/dev_controller.js` (around line 121)

> No new test: `dev_controller.js` is a startup script (not a module). The currently-assigned `onStateChange` is the no-op default from `SlotController`, so no existing handler is being dropped today. This is a defensive change that matches the wrap pattern already used in `index.js:179-183`, ensuring safety if a handler is ever set before this line.

- [ ] **Step 1: Apply the wrap pattern**

In `src/dev_controller.js`, replace:

```js
controller.onStateChange = webServer.broadcast;
```

With:

```js
const existingOnStateChange = controller.onStateChange;
controller.onStateChange = (state) => {
    existingOnStateChange(state);
    webServer.broadcast(state);
};
```

- [ ] **Step 2: Run full test suite to confirm no regressions**

```bash
npm test
```

Expected: All tests PASS.

- [ ] **Step 3: Commit**

```bash
git add src/dev_controller.js
git commit -m "fix: wrap onStateChange in dev_controller to avoid clobbering existing handler"
```

---

## Task 3: Monotonic timestamps in TapTempoTracker

**Files:**
- Modify: `src/controller/tempo.js` (line 103)
- Modify: `src/controller/web_server.js` (line 44)
- Modify: `test/unit/tempo.test.js`
- Modify: `test/unit/web_server.test.js`

- [ ] **Step 1: Write failing test in tempo.test.js**

Append to `test/unit/tempo.test.js`:

```js
test('TapTempoTracker.tap uses performance.now() by default, not Date.now()', () => {
    const realDateNow = Date.now;
    Date.now = () => 9999999;
    const tap = new TapTempoTracker();
    tap.tap();
    Date.now = realDateNow;
    assert.notEqual(tap.tapTimes[0], 9999999, 'tap() must not call Date.now()');
});
```

- [ ] **Step 2: Tighten existing tapTempo test in web_server.test.js**

In `test/unit/web_server.test.js`, find the test `'POST /api/action tapTempo calls tapTempo.tap'` and add one assertion after the existing two:

```js
// existing:
assert.equal(tapTempo.calls.length, 1);
assert.equal(tapTempo.calls[0][0], 'tap');
// add:
assert.equal(tapTempo.calls[0][1], undefined, 'tap() should be called without an explicit timestamp');
```

- [ ] **Step 3: Run — confirm both new assertions fail**

```bash
node --test test/unit/tempo.test.js test/unit/web_server.test.js
```

Expected:
- `TapTempoTracker.tap uses performance.now() by default` — FAIL (`tapTimes[0]` equals 9999999 because `Date.now()` is still used)
- `POST /api/action tapTempo calls tapTempo.tap` — FAIL (`calls[0][1]` is a number from `Date.now()`, not `undefined`)

- [ ] **Step 4: Change the default in tempo.js**

In `src/controller/tempo.js`, replace:

```js
    tap(timeMs = Date.now()) {
```

With:

```js
    tap(timeMs = performance.now()) {
```

- [ ] **Step 5: Remove the explicit timestamp from the web_server.js caller**

In `src/controller/web_server.js`, replace:

```js
            tapTempo.tap(Date.now());
```

With:

```js
            tapTempo.tap();
```

- [ ] **Step 6: Run — confirm both tests now pass**

```bash
node --test test/unit/tempo.test.js test/unit/web_server.test.js
```

Expected: All tests PASS.

- [ ] **Step 7: Run full suite to confirm no regressions**

```bash
npm test
```

Expected: All tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/controller/tempo.js src/controller/web_server.js test/unit/tempo.test.js test/unit/web_server.test.js
git commit -m "fix: use performance.now() in TapTempoTracker to avoid non-monotonic timestamp drops"
```

---

## Task 4: Escape dots in pkill patterns

**Files:**
- Modify: `start.sh` (lines 135–137)
- Modify: `test/unit/start_script.test.js` (line 37)

Background: `pkill -f` treats its argument as a regex. An unescaped `.` matches any character, so `node src/index.js` would technically match `node src/indexXjs`. Escaping to `\.` restricts it to a literal dot.

- [ ] **Step 1: Update the test to expect the escaped form (this makes it fail)**

In `test/unit/start_script.test.js`, replace line 37:

```js
    assert.match(startScript, /pkill -f "node src\/midi_logger\.js" 2>\/dev\/null \|\| true/);
```

With:

```js
    assert.match(startScript, /pkill -f "node src\/midi_logger\\\.js" 2>\/dev\/null \|\| true/);
```

(`\\\.` in the regex literal = match a literal backslash then a literal dot in the target string.)

- [ ] **Step 2: Run — confirm the test now fails**

```bash
node --test test/unit/start_script.test.js
```

Expected: FAIL — `start.sh` still has `midi_logger.js` (no backslash), so the new regex does not match.

- [ ] **Step 3: Escape dots in start.sh**

In `start.sh`, replace lines 135–137:

```bash
    pkill -f "node src/index.js" 2>/dev/null || true
    pkill -f "node src/dev_controller.js" 2>/dev/null || true
    pkill -f "node src/midi_logger.js" 2>/dev/null || true
```

With:

```bash
    pkill -f "node src/index\.js" 2>/dev/null || true
    pkill -f "node src/dev_controller\.js" 2>/dev/null || true
    pkill -f "node src/midi_logger\.js" 2>/dev/null || true
```

- [ ] **Step 4: Run — confirm the test passes**

```bash
node --test test/unit/start_script.test.js
```

Expected: All tests PASS.

- [ ] **Step 5: Run full suite to confirm no regressions**

```bash
npm test
```

Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add start.sh test/unit/start_script.test.js
git commit -m "fix: escape dots in pkill -f patterns to prevent regex wildcard matches"
```
