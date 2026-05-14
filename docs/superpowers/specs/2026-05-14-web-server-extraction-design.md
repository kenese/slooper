# Design: Extract Web Server Module + `--web` Flag for `index.js`

**Date:** 2026-05-14
**Status:** Approved

## Problem

Mode A (X1MK3 MIDI via `index.js`) and Mode B (web UI via `dev_controller.js`) cannot run simultaneously. Each file creates its own `createController()` instance and `OscTransport`, meaning both try to bind the same OSC state port (9001) if launched together.

## Goal

Allow `index.js` to optionally serve the web controller UI alongside full MIDI control, so both inputs share one controller and one OSC connection.

## Approach: Extract a shared HTTP module

Pull the HTTP server logic out of `dev_controller.js` into a new module `src/controller/web_server.js`. Both `index.js` (via a `--web` flag) and `dev_controller.js` import it. No code duplication, no OSC port conflict.

---

## Changes

### 1. New file: `src/controller/web_server.js`

Exports a single factory:

```js
function createWebServer({ controller, tapTempo, runtimeConfig })
// returns { listen(port, host), close() }
```

Contains everything currently inline in `dev_controller.js`:
- `readJson(req)` — promise-based body reader
- `sendJson(res, statusCode, data)` — JSON response helper
- `handleAction(action, slotId)` — maps HTTP action strings to controller method calls
- `http.createServer(...)` — serves `GET /`, `GET /api/state`, `POST /api/action`

Dependencies are injected (no global state): `controller`, `tapTempo`, `runtimeConfig.controller.cropStepMs`.

The HTML file path resolves relative to `__dirname` just as it does now in `dev_controller.js`.

### 2. `src/index.js`

- Parse `--web` from `process.argv`
- Parse `SLOOPER_WEB_PORT` env var (default `3000`) and bind to `HOST = '127.0.0.1'` — consistent with `dev_controller.js`
- After `setupMidiHandlers` creates `controller`, if `--web` is set:
  - `const webServer = createWebServer({ controller, tapTempo, runtimeConfig })`
  - `webServer.listen(PORT, HOST)` — logs `OSC web controller: http://HOST:PORT`
- In `shutdown()`, call `webServer.close()` before `transport.close()`

The `controller` variable is already module-scoped (`let controller`), so it is accessible after `setupMidiHandlers` assigns it.

### 3. `src/dev_controller.js`

- Replace the inline `readJson` / `sendJson` / `handleAction` / `http.createServer` block (~80 lines) with:
  ```js
  const { createWebServer } = require('./controller/web_server');
  // ...
  const webServer = createWebServer({ controller, tapTempo, runtimeConfig });
  webServer.listen(PORT, HOST);
  ```
- `shutdown()` calls `webServer.close()` instead of `server.close(...)`
- All other logic (MIDI clock input, OSC transport, controller creation) is unchanged

### 4. `start.sh`

No changes. Existing branching logic is correct:
- `midi-device=WEB` → `dev_controller.js` (web-only, no physical MIDI)
- anything else → `index.js` (MIDI control; add `--web` to also get the HTTP UI)

To run both simultaneously: `./start.sh audio-device=MAC midi-device=X1MK3 --web`

### 5. `public/architecture.html`

- Add `web_server.js` box in the Node.js layer
- Update `index.js` box to mention optional HTTP when `--web`
- Update `dev_controller.js` box to mention it delegates HTTP to `web_server.js`
- Update Mode A strip to show `--web` variant
- Add arrows: `web-server ↔ browser` (replacing direct `devjs ↔ browser`), `indexjs → web-server` (dashed, optional), `devjs → web-server` (dashed)
- Replace "Current limitation" note with a "Fixed" note

### 6. `package.json` scripts

No changes.

---

## Interface contract for `createWebServer`

| Parameter | Type | Description |
|---|---|---|
| `controller` | SlotController | The shared controller instance |
| `tapTempo` | TapTempoTracker | Shared tap-tempo tracker |
| `runtimeConfig` | RuntimeConfig | Used for `controller.cropStepMs` |

Returns `{ listen(port, host), close() }`.

---

## What does NOT change

- `slot_controller.js`, `osc_transport.js`, `tempo.js`, `jack_capture_router.js`
- All MIDI handling in `index.js`
- All MIDI clock / controller setup in `dev_controller.js`
- `start.sh` branching logic
- `package.json` scripts
- The `public/dev-controller.html` browser UI
