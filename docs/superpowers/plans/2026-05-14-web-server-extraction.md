# Web Server Extraction + --web Flag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the HTTP server from `dev_controller.js` into `src/controller/web_server.js` so `index.js` can optionally serve the web UI (via `--web`) while sharing the same controller and OSC socket.

**Architecture:** A new `createWebServer({ controller, tapTempo, runtimeConfig })` factory owns all HTTP logic. `dev_controller.js` delegates to it (removing ~80 lines of inline code). `index.js` imports it and mounts it when `--web` is passed, making both inputs share one controller instance and one OscTransport.

**Tech Stack:** Node.js built-in `http`, `node:test` / `node:assert/strict` for tests (same pattern as existing unit tests).

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/controller/web_server.js` | HTTP server factory — `GET /`, `GET /api/state`, `POST /api/action` |
| Create | `test/unit/web_server.test.js` | Unit tests for `createWebServer` |
| Modify | `src/dev_controller.js` | Replace ~80 lines of inline HTTP with `createWebServer()` call |
| Modify | `src/index.js` | Add `--web` flag; mount `createWebServer` after MIDI is open |
| Modify | `public/architecture.html` | Update diagram: new box, updated mode strip, fix limitation note |

---

## Task 1: Create `src/controller/web_server.js` (test first)

**Files:**
- Create: `test/unit/web_server.test.js`
- Create: `src/controller/web_server.js`

- [ ] **Step 1.1: Write the failing tests**

Create `test/unit/web_server.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createWebServer } = require('../../src/controller/web_server');

function makeRequest(port, method, urlPath, body) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const req = http.request(
            {
                hostname: '127.0.0.1',
                port,
                path: urlPath,
                method,
                headers: payload
                    ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
                    : {},
            },
            (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    const isJson = (res.headers['content-type'] || '').includes('application/json');
                    resolve({
                        status: res.statusCode,
                        contentType: res.headers['content-type'] || '',
                        body: isJson ? JSON.parse(data) : data,
                    });
                });
            }
        );
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

function createFakeController() {
    const calls = [];
    return {
        calls,
        getState() { return { slots: [{ id: 1, state: 0 }], monitorEnabled: false }; },
        async tapSlot(id) { calls.push(['tapSlot', id]); },
        async clearSlot(id) { calls.push(['clearSlot', id]); },
        async resetSlot(id) { calls.push(['resetSlot', id]); },
        async toggleMonitor() { calls.push(['toggleMonitor']); },
        async selectInputSource(id) { calls.push(['selectInputSource', id]); },
        async autoLoopSlot(id, key) { calls.push(['autoLoopSlot', id, key]); },
        async multiplySlotLength(id, factor) { calls.push(['multiplySlotLength', id, factor]); },
        async cropStartSlot(id, delta) { calls.push(['cropStartSlot', id, delta]); },
        async cropSlot(id, delta) { calls.push(['cropSlot', id, delta]); },
        async moveSlot(id, delta) { calls.push(['moveSlot', id, delta]); },
    };
}

function createFakeTapTempo() {
    const calls = [];
    return { calls, tap(ts) { calls.push(['tap', ts]); } };
}

async function startTestServer() {
    const controller = createFakeController();
    const tapTempo = createFakeTapTempo();
    const runtimeConfig = { controller: { cropStepMs: 30 } };
    const webServer = createWebServer({ controller, tapTempo, runtimeConfig });
    const port = await webServer.listen(0, '127.0.0.1');
    return { webServer, controller, tapTempo, port };
}

test('GET /api/state returns controller state as JSON', async () => {
    const { webServer, controller, port } = await startTestServer();
    try {
        const res = await makeRequest(port, 'GET', '/api/state');
        assert.equal(res.status, 200);
        assert.deepEqual(res.body, controller.getState());
    } finally {
        await webServer.close();
    }
});

test('POST /api/action tap calls controller.tapSlot with slot id', async () => {
    const { webServer, controller, port } = await startTestServer();
    try {
        const res = await makeRequest(port, 'POST', '/api/action', { action: 'tap', slot: 1 });
        assert.equal(res.status, 200);
        assert.deepEqual(controller.calls, [['tapSlot', 1]]);
    } finally {
        await webServer.close();
    }
});

test('POST /api/action monitor calls controller.toggleMonitor', async () => {
    const { webServer, controller, port } = await startTestServer();
    try {
        const res = await makeRequest(port, 'POST', '/api/action', { action: 'monitor' });
        assert.equal(res.status, 200);
        assert.deepEqual(controller.calls, [['toggleMonitor']]);
    } finally {
        await webServer.close();
    }
});

test('POST /api/action tapTempo calls tapTempo.tap', async () => {
    const { webServer, tapTempo, port } = await startTestServer();
    try {
        await makeRequest(port, 'POST', '/api/action', { action: 'tapTempo' });
        assert.equal(tapTempo.calls.length, 1);
        assert.equal(tapTempo.calls[0][0], 'tap');
    } finally {
        await webServer.close();
    }
});

test('POST /api/action cropUp calls controller.cropSlot with +cropStepMs', async () => {
    const { webServer, controller, port } = await startTestServer();
    try {
        await makeRequest(port, 'POST', '/api/action', { action: 'cropUp', slot: 2 });
        assert.deepEqual(controller.calls, [['cropSlot', 2, 30]]);
    } finally {
        await webServer.close();
    }
});

test('POST /api/action cropDown calls controller.cropSlot with -cropStepMs', async () => {
    const { webServer, controller, port } = await startTestServer();
    try {
        await makeRequest(port, 'POST', '/api/action', { action: 'cropDown', slot: 1 });
        assert.deepEqual(controller.calls, [['cropSlot', 1, -30]]);
    } finally {
        await webServer.close();
    }
});

test('POST /api/action cropStartUp calls controller.cropStartSlot with +cropStepMs', async () => {
    const { webServer, controller, port } = await startTestServer();
    try {
        await makeRequest(port, 'POST', '/api/action', { action: 'cropStartUp', slot: 1 });
        assert.deepEqual(controller.calls, [['cropStartSlot', 1, 30]]);
    } finally {
        await webServer.close();
    }
});

test('POST /api/action moveUp calls controller.moveSlot with +cropStepMs', async () => {
    const { webServer, controller, port } = await startTestServer();
    try {
        await makeRequest(port, 'POST', '/api/action', { action: 'moveUp', slot: 1 });
        assert.deepEqual(controller.calls, [['moveSlot', 1, 30]]);
    } finally {
        await webServer.close();
    }
});

test('POST /api/action source: calls controller.selectInputSource', async () => {
    const { webServer, controller, port } = await startTestServer();
    try {
        await makeRequest(port, 'POST', '/api/action', { action: 'source:ch2' });
        assert.deepEqual(controller.calls, [['selectInputSource', 'ch2']]);
    } finally {
        await webServer.close();
    }
});

test('POST /api/action autoLoop: calls controller.autoLoopSlot', async () => {
    const { webServer, controller, port } = await startTestServer();
    try {
        await makeRequest(port, 'POST', '/api/action', { action: 'autoLoop:1beat', slot: 1 });
        assert.deepEqual(controller.calls, [['autoLoopSlot', 1, '1beat']]);
    } finally {
        await webServer.close();
    }
});

test('POST /api/action unknown action returns 500 with error', async () => {
    const { webServer, port } = await startTestServer();
    try {
        const res = await makeRequest(port, 'POST', '/api/action', { action: 'bogus', slot: 1 });
        assert.equal(res.status, 500);
        assert.ok(typeof res.body.error === 'string');
        assert.ok(res.body.error.includes('Unknown action'));
    } finally {
        await webServer.close();
    }
});

test('GET / returns HTML with 200', async () => {
    const { webServer, port } = await startTestServer();
    try {
        const res = await makeRequest(port, 'GET', '/');
        assert.equal(res.status, 200);
        assert.ok(res.contentType.startsWith('text/html'));
    } finally {
        await webServer.close();
    }
});

test('GET /unknown returns 404', async () => {
    const { webServer, port } = await startTestServer();
    try {
        const res = await makeRequest(port, 'GET', '/unknown');
        assert.equal(res.status, 404);
    } finally {
        await webServer.close();
    }
});
```

- [ ] **Step 1.2: Run tests to confirm they fail**

```bash
node --test test/unit/web_server.test.js
```

Expected: `Error: Cannot find module '../../src/controller/web_server'`

- [ ] **Step 1.3: Create `src/controller/web_server.js`**

```js
const http = require('http');
const path = require('path');
const fs = require('fs');

const HTML_PATH = path.join(__dirname, '..', '..', 'public', 'dev-controller.html');

function readJson(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
            if (body.length > 1e6) {
                req.destroy();
                reject(new Error('Request too large'));
            }
        });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (err) {
                reject(err);
            }
        });
        req.on('error', reject);
    });
}

function sendJson(res, statusCode, data) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function createWebServer({ controller, tapTempo, runtimeConfig }) {
    const { cropStepMs } = runtimeConfig.controller;

    async function handleAction(action, slotId) {
        if (action === 'monitor') {
            await controller.toggleMonitor();
            return;
        }
        if (action === 'tapTempo') {
            tapTempo.tap(Date.now());
            return;
        }
        if (action.startsWith('source:')) {
            await controller.selectInputSource(action.split(':')[1]);
            return;
        }
        if (action === 'tap') await controller.tapSlot(slotId);
        else if (action.startsWith('autoLoop:')) await controller.autoLoopSlot(slotId, action.split(':')[1]);
        else if (action === 'half') await controller.multiplySlotLength(slotId, 0.5);
        else if (action === 'double') await controller.multiplySlotLength(slotId, 2);
        else if (action === 'clear') await controller.clearSlot(slotId);
        else if (action === 'cropStartDown') await controller.cropStartSlot(slotId, -cropStepMs);
        else if (action === 'cropStartUp') await controller.cropStartSlot(slotId, cropStepMs);
        else if (action === 'cropDown') await controller.cropSlot(slotId, -cropStepMs);
        else if (action === 'cropUp') await controller.cropSlot(slotId, cropStepMs);
        else if (action === 'moveDown') await controller.moveSlot(slotId, -cropStepMs);
        else if (action === 'moveUp') await controller.moveSlot(slotId, cropStepMs);
        else if (action === 'reset') await controller.resetSlot(slotId);
        else throw new Error(`Unknown action: ${action}`);
    }

    const server = http.createServer(async (req, res) => {
        try {
            if (req.method === 'GET' && req.url === '/') {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(fs.readFileSync(HTML_PATH, 'utf8'));
                return;
            }
            if (req.method === 'GET' && req.url === '/api/state') {
                sendJson(res, 200, controller.getState());
                return;
            }
            if (req.method === 'POST' && req.url === '/api/action') {
                const body = await readJson(req);
                await handleAction(body.action, Number(body.slot));
                sendJson(res, 200, controller.getState());
                return;
            }
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not found');
        } catch (err) {
            sendJson(res, 500, { error: err.message, ...controller.getState() });
        }
    });

    return {
        listen(port, host) {
            return new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(port, host, () => {
                    resolve(server.address().port);
                });
            });
        },
        close() {
            return new Promise((resolve) => server.close(resolve));
        },
    };
}

module.exports = { createWebServer };
```

- [ ] **Step 1.4: Run tests to confirm they pass**

```bash
node --test test/unit/web_server.test.js
```

Expected: all 13 tests pass (`ok 1 - GET /api/state ...` etc.)

- [ ] **Step 1.5: Run full unit suite to check for regressions**

```bash
npm run test:unit
```

Expected: all existing tests pass plus the 13 new ones.

- [ ] **Step 1.6: Commit**

```bash
git add src/controller/web_server.js test/unit/web_server.test.js
git commit -m "feat: add createWebServer factory module"
```

---

## Task 2: Update `dev_controller.js` to use `web_server.js`

**Files:**
- Modify: `src/dev_controller.js`

The change removes the inline `readJson`, `sendJson`, `handleAction`, and `http.createServer` block (~80 lines) and replaces them with a `createWebServer` call. Everything else stays identical.

- [ ] **Step 2.1: Replace the full content of `src/dev_controller.js`**

The new file is identical to the current one except:
1. Remove `const http = require('http');` from line 1
2. Add `const { createWebServer } = require('./controller/web_server');` after the last `require`
3. Remove the `readJson`, `sendJson`, `handleAction`, and `const server = http.createServer(...)` block (lines 117–199)
4. Replace `server.listen(PORT, HOST, () => { ... });` with:
   ```js
   const webServer = createWebServer({ controller, tapTempo, runtimeConfig });
   webServer.listen(PORT, HOST).then(() => {
       console.log(`OSC web controller: http://${HOST}:${PORT}`);
       console.log(`Sending OSC to ${runtimeConfig.osc.host}:${runtimeConfig.osc.sendPort}`);
       console.log(`Listening for Pd state on ${runtimeConfig.osc.host}:${runtimeConfig.osc.statePort}`);
       console.log(`Tempo: MIDI clock from ${runtimeConfig.midi.midiName}, tap fallback from web`);
   });
   ```
5. Replace `server.close(() => { ... })` in `shutdown()` with:
   ```js
   webServer.close().then(() => {
       if (midiClockInput) midiClockInput.close();
       transport.close();
       process.exit(0);
   });
   ```

The complete new file (`http`, `path`, `fs` imports removed since they only served the HTTP block; `let controller` kept for the null-guard in the `onState` closure):

```js
const easymidi = require('easymidi');

const { getRuntimeConfig } = require('./config');
const { createController } = require('./controller/slot_controller');
const { JackCaptureRouter } = require('./controller/jack_capture_router');
const { OscTransport } = require('./controller/osc_transport');
const { MidiClockTracker, TapTempoTracker, TempoSource } = require('./controller/tempo');
const { createWebServer } = require('./controller/web_server');

const HOST = '127.0.0.1';
const PORT = Number(process.env.SLOOPER_WEB_PORT || 3000);
const args = process.argv.slice(2);
const audioArg = args.find((arg) => arg.startsWith('audio-device=') || arg.startsWith('device='));
const audioConfigArg = args.find((arg) => arg.startsWith('--audio-config='));
const midiArg = args.find((arg) => arg.startsWith('midi-device='));
const midiConfigArg = args.find((arg) => arg.startsWith('--midi-config='));
const clockMidiArg = args.find((arg) => arg.startsWith('clock-midi-device=') || arg.startsWith('--clock-midi-device='));

function getClockMidiDeviceName() {
    if (clockMidiArg) {
        return clockMidiArg.split('=')[1];
    }

    if (process.env.SLOOPER_MIDI_CLOCK_DEVICE) {
        return process.env.SLOOPER_MIDI_CLOCK_DEVICE;
    }

    const requestedMidiDevice = midiArg ? midiArg.split('=')[1] : null;
    if (requestedMidiDevice && !['WEB', 'OSC'].includes(requestedMidiDevice)) {
        return requestedMidiDevice;
    }

    return 'X1MK3';
}

const runtimeConfig = getRuntimeConfig({
    audioDevice: audioArg ? audioArg.split('=')[1] : (process.env.SLOOPER_AUDIO_DEVICE || 'MAC'),
    audioConfigPath: audioConfigArg ? audioConfigArg.split('=')[1] : undefined,
    midiDevice: getClockMidiDeviceName(),
    midiConfigPath: midiConfigArg ? midiConfigArg.split('=')[1] : undefined,
});

runtimeConfig.osc.sendPort = Number(process.env.SLOOPER_OSC_SEND_PORT || runtimeConfig.osc.sendPort);
runtimeConfig.osc.statePort = Number(process.env.SLOOPER_OSC_STATE_PORT || runtimeConfig.osc.statePort);

let controller;
let midiClockInput = null;
const midiClock = new MidiClockTracker();
const tapTempo = new TapTempoTracker();
const tempo = new TempoSource({ clock: midiClock, tap: tapTempo });
const transport = new OscTransport({
    host: runtimeConfig.osc.host,
    sendPort: runtimeConfig.osc.sendPort,
    statePort: runtimeConfig.osc.statePort,
    onState: (args) => {
        if (controller) controller.applyPdState(args);
    },
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

controller = createController({
    transport,
    config: runtimeConfig.controller,
    tempo,
    inputSources: runtimeConfig.audio.captureSources,
    inputRouter: runtimeConfig.platform === 'linux' && runtimeConfig.audio.mode === 'jack'
        ? new JackCaptureRouter()
        : null,
});

async function openMidiClockInput() {
    const inputs = easymidi.getInputs();
    const matchName = runtimeConfig.midi.midiName;
    const inputIndex = inputs.findIndex((name) => name.toLowerCase().includes(matchName.toLowerCase()));

    if (inputIndex === -1) {
        console.warn(`MIDI clock input matching "${matchName}" not found. Tap tempo fallback is available.`);
        console.warn('Available inputs:', inputs);
        return;
    }

    const inputName = inputs[inputIndex];
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            midiClockInput = new easymidi.Input(inputIndex);
            break;
        } catch (err) {
            try {
                midiClockInput = new easymidi.Input(inputName);
                break;
            } catch (fallbackErr) {
                if (attempt < maxRetries) {
                    console.warn(`Could not open MIDI clock input "${inputName}" (attempt ${attempt}/${maxRetries}): ${fallbackErr.message}; retrying in 1s...`);
                    await sleep(1000);
                } else {
                    console.warn(`Could not open MIDI clock input "${inputName}": ${fallbackErr.message}`);
                    return;
                }
            }
        }
    }

    midiClockInput.on('clock', () => midiClock.tick());
    midiClockInput.on('start', () => midiClock.reset());
    midiClockInput.on('continue', () => midiClock.reset());
    midiClockInput.on('stop', () => midiClock.reset());
    console.log(`MIDI clock input [${inputIndex}]: ${inputName}`);
}

openMidiClockInput();

const webServer = createWebServer({ controller, tapTempo, runtimeConfig });
webServer.listen(PORT, HOST).then(() => {
    console.log(`OSC web controller: http://${HOST}:${PORT}`);
    console.log(`Sending OSC to ${runtimeConfig.osc.host}:${runtimeConfig.osc.sendPort}`);
    console.log(`Listening for Pd state on ${runtimeConfig.osc.host}:${runtimeConfig.osc.statePort}`);
    console.log(`Tempo: MIDI clock from ${runtimeConfig.midi.midiName}, tap fallback from web`);
});

function shutdown() {
    webServer.close().then(() => {
        if (midiClockInput) midiClockInput.close();
        transport.close();
        process.exit(0);
    });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

- [ ] **Step 2.2: Run unit tests to confirm no regressions**

```bash
npm run test:unit
```

Expected: all tests pass (same count as after Task 1).

- [ ] **Step 2.3: Commit**

```bash
git add src/dev_controller.js
git commit -m "refactor: dev_controller delegates HTTP to createWebServer"
```

---

## Task 3: Add `--web` flag to `index.js`

**Files:**
- Modify: `src/index.js`

Three focused changes: add import, add web server startup after MIDI opens, add cleanup in shutdown.

- [ ] **Step 3.1: Add the `createWebServer` import**

At the top of `src/index.js`, after the existing `require` lines (after line 7), add:

```js
const { createWebServer } = require('./controller/web_server');
```

- [ ] **Step 3.2: Add module-level `webServer` variable**

On line 108, `let controller;` exists. Add `let webServer = null;` immediately after it:

```js
let controller;
let webServer = null;
```

- [ ] **Step 3.3: Start the web server after `setupMidiHandlers`**

In the async IIFE (around line 133), `setupMidiHandlers(input, output)` is the last line before the closing `})();`. After that call, add:

```js
    setupMidiHandlers(input, output);

    if (args.includes('--web')) {
        const WEB_HOST = '127.0.0.1';
        const WEB_PORT = Number(process.env.SLOOPER_WEB_PORT || 3000);
        webServer = createWebServer({ controller, tapTempo, runtimeConfig });
        webServer.listen(WEB_PORT, WEB_HOST).then((port) => {
            console.log(`Web controller: http://${WEB_HOST}:${port}`);
        });
    }
```

- [ ] **Step 3.4: Close the web server in `shutdown()`**

The existing `shutdown` function (around line 475) is:

```js
function shutdown() {
    transport.close();
    process.exit(0);
}
```

Replace with:

```js
function shutdown() {
    if (webServer) webServer.close();
    transport.close();
    process.exit(0);
}
```

- [ ] **Step 3.5: Run unit tests**

```bash
npm run test:unit
```

Expected: all tests still pass (no regressions).

- [ ] **Step 3.6: Commit**

```bash
git add src/index.js
git commit -m "feat: add --web flag to index.js for simultaneous MIDI + web control"
```

---

## Task 4: Update `public/architecture.html`

**Files:**
- Modify: `public/architecture.html`

Five targeted changes to the HTML: mode strip, boxes, positions, arrows, and the bottom note.

- [ ] **Step 4.1: Update the Mode A block in the mode strip**

Find:
```html
  <div class="mode-block">
    <h3>Mode A — Hardware MIDI (X1MK3 / XONE)</h3>
    <div class="mode-cmd">./start.sh midi-device=X1MK3</div>
    <p class="mode-desc">Runs <code>src/index.js</code>. Reads physical MIDI controller. Sends LED feedback. MIDI clock from hardware.</p>
  </div>
```

Replace with:
```html
  <div class="mode-block">
    <h3>Mode A — Hardware MIDI (X1MK3 / XONE)</h3>
    <div class="mode-cmd">./start.sh midi-device=X1MK3</div>
    <div class="mode-cmd" style="margin-top:4px;">./start.sh midi-device=X1MK3 --web</div>
    <p class="mode-desc">Runs <code>src/index.js</code>. Reads physical MIDI controller. Sends LED feedback. Add <code>--web</code> to also serve the browser UI on :3000 — both share one controller and one OSC socket.</p>
  </div>
```

- [ ] **Step 4.2: Update the Mode B block and remove the Limitation block**

Find:
```html
  <div class="mode-divider"></div>
  <div class="mode-block">
    <h3>Mode B — Web Controller</h3>
    <div class="mode-cmd">./start.sh midi-device=WEB</div>
    <p class="mode-desc">Runs <code>src/dev_controller.js</code>. Serves browser UI on :3000. MIDI clock still from XONE. No physical button control.</p>
  </div>
  <div class="mode-divider"></div>
  <div class="mode-block">
    <h3>Limitation</h3>
    <p class="mode-desc" style="color:#f87171;">These are two separate processes. Both cannot run simultaneously against the same looper state — each creates its own controller instance and OSC connection.</p>
  </div>
```

Replace with:
```html
  <div class="mode-divider"></div>
  <div class="mode-block">
    <h3>Mode B — Web Only</h3>
    <div class="mode-cmd">./start.sh midi-device=WEB</div>
    <p class="mode-desc">Runs <code>src/dev_controller.js</code>. Serves browser UI on :3000. Optional MIDI clock from X1MK3. Use when no physical controller is connected.</p>
  </div>
```

- [ ] **Step 4.3: Add the `web-server-js` box to the diagram (inside `<div class="canvas">`)**

After the closing `</div>` of the `devjs` box, add:

```html
  <div class="box node" id="web-server-js" style="min-width:260px;">
    <div class="box-title">controller/web_server.js</div>
    <div class="box-sub">
      Shared HTTP server factory.<br><br>
      GET  / → dev-controller.html<br>
      GET  /api/state → controller.getState()<br>
      POST /api/action → handleAction()<br><br>
      Returns { listen(port, host), close() }<br>
      Used by both index.js (--web) and dev_controller.js
    </div>
    <span class="tag http">HTTP :3000</span>
    <span class="tag shared">shared</span>
  </div>
```

- [ ] **Step 4.4: Update the `indexjs` box description**

Find inside the `indexjs` box:
```html
      Calls createController() → OscTransport
```

Replace with:
```html
      Calls createController() → OscTransport<br>
      Optionally mounts web_server.js (--web flag)
```

- [ ] **Step 4.5: Update the `devjs` box description**

Find inside the `devjs` box:
```html
      Also opens MIDI input for clock only (XONE by default)<br>
      clock ticks → MidiClockTracker → TempoSource<br><br>
      Calls createController() → OscTransport
```

Replace with:
```html
      Also opens MIDI input for clock only (XONE by default)<br>
      clock ticks → MidiClockTracker → TempoSource<br><br>
      Calls createController() → OscTransport<br>
      Delegates HTTP to web_server.js
```

Also update the mode tag from `data-mode="Mode B"` to `data-mode="Mode B only"`:

Find:
```html
  <div class="box node mode-only" data-mode="Mode B" id="devjs" style="min-width:300px;">
```

Replace with:
```html
  <div class="box node mode-only" data-mode="Mode B only" id="devjs" style="min-width:300px;">
```

- [ ] **Step 4.6: Add `web-server-js` to `DEFAULT_POSITIONS`**

Find:
```js
  startsh:         { left: 750, top:1080 },
```

Replace with:
```js
  startsh:         { left: 750, top:1080 },
  'web-server-js': { left: 760, top: 880 },
```

- [ ] **Step 4.7: Update the arrows array**

Find these two arrows (the browser ↔ devjs HTTP arrows):
```js
  { from: 'browser',       to: 'devjs',            label: 'POST /api/action\nGET /api/state', color: '#34d399' },
  { from: 'devjs',         to: 'browser',           label: 'HTML + JSON state',                color: '#34d399', offset: 12 },
```

Replace with:
```js
  { from: 'browser',       to: 'web-server-js',     label: 'POST /api/action\nGET /api/state', color: '#34d399' },
  { from: 'web-server-js', to: 'browser',            label: 'HTML + JSON state',                color: '#34d399', offset: 12 },
  { from: 'devjs',         to: 'web-server-js',      label: 'delegates HTTP',                   color: '#34d399', dashed: true },
  { from: 'indexjs',       to: 'web-server-js',      label: 'HTTP (--web)',                     color: '#34d399', dashed: true },
```

- [ ] **Step 4.8: Replace the bottom limitation note**

Find:
```html
<div class="note">
  <strong>Current limitation:</strong> Mode A (X1MK3) and Mode B (web) cannot run concurrently — each creates its own <code>createController()</code> instance and OSC connection to Pd.
  Fix: absorb the HTTP server from <code>dev_controller.js</code> into <code>index.js</code> so both share one controller instance and one OSC socket.
</div>
```

Replace with:
```html
<div class="note" style="border-color:#34d399; background:#061810; color:#065f46;">
  <strong style="color:#34d399;">Fixed:</strong> <code>src/controller/web_server.js</code> is a shared factory used by both <code>index.js</code> (via <code>--web</code>) and <code>dev_controller.js</code>. Both modes now share one controller instance and one OSC socket. Run both simultaneously: <code>./start.sh midi-device=X1MK3 --web</code>
</div>
```

- [ ] **Step 4.9: Run unit tests one final time**

```bash
npm run test:unit
```

Expected: all tests pass.

- [ ] **Step 4.10: Commit**

```bash
git add public/architecture.html
git commit -m "docs: update architecture diagram for web_server.js extraction"
```
