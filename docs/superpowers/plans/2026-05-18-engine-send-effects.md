# Engine Send Effects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add shared engine-level reverb and echo send effects, with loop and monitor send toggles, wet/config controls, and echo freeze that mutes dry loops and monitor while playing the echo tail.

**Architecture:** Keep `src/looper_slot.pd` unchanged. Add effect routing in `src/engine.pd`, with one stereo reverb abstraction using Pd `rev3~` and one stereo hand-rolled echo abstraction. Add a small Node effects controller for OSC/state, then expose controls through the web dev controller before MIDI mapping.

**Tech Stack:** Pure Data vanilla, Node.js CommonJS, `node:test`, OSC over UDP, existing browser dev controller.

---

## File Structure

- Create `src/controller/effects_controller.js`
  - Owns effect state, validates/clips values, and sends `/fx ...` OSC messages.
  - Keeps effect logic out of `SlotController`.
- Modify `src/controller/slot_controller.js`
  - Composes `EffectsController`.
  - Includes `effects` in `getState()`.
  - Exposes wrapper methods used by the web server.
- Modify `src/controller/web_server.js`
  - Accepts new POST actions for effect toggles and numeric controls.
- Modify `public/dev-controller.html`
  - Adds the effect UI: send toggles, effect on/off, wet/config controls, freeze.
- Create `src/echo_fx.pd`
  - Stereo echo abstraction with control inlet, stereo signal inlets, stereo signal outlets.
- Create `src/reverb_fx.pd`
  - Stereo `rev3~` wrapper with control inlet, stereo signal inlets, stereo signal outlets.
- Modify `src/engine.pd`
  - Adds `/fx` route.
  - Taps loop mix and monitor mix into reverb/echo send buses.
  - Mixes wet effect outputs into `dac~`.
  - Applies echo freeze dry mute rules.
- Modify `test/unit/slot_controller.test.js`
  - Covers effect state and OSC messages through the app controller surface.
- Modify `test/unit/web_server.test.js`
  - Covers HTTP actions for effect controls.
- Modify `test/unit/engine_patch.test.js`
  - Guards the Pd route/abstraction structure.
- Optional later: modify `src/index.js` and `config/midi/*.json`
  - Adds hardware MIDI mappings after the web controls prove the behavior.

## Message Contract

Use one `/fx` route in Pd. Keep commands flat enough that Pd text routing stays readable.

```text
/fx reverbOn <0|1>
/fx reverbWet <0..1>
/fx reverbRoom <0..1>
/fx reverbDamp <0..1>

/fx echoOn <0|1>
/fx echoWet <0..1>
/fx echoTime <1..4000 ms>
/fx echoFeedback <0..0.95>
/fx echoDamp <0..1>
/fx echoFreeze <0|1>

/fx loopsToReverb <0|1>
/fx loopsToEcho <0|1>
/fx monitorToReverb <0|1>
/fx monitorToEcho <0|1>
```

Default state:

```js
{
  reverbOn: false,
  reverbWet: 0.35,
  reverbRoom: 0.75,
  reverbDamp: 0.35,
  echoOn: false,
  echoWet: 0.45,
  echoTime: 375,
  echoFeedback: 0.55,
  echoDamp: 0.35,
  echoFreeze: false,
  loopsToReverb: false,
  loopsToEcho: false,
  monitorToReverb: false,
  monitorToEcho: false
}
```

Echo freeze behavior:

```text
echoFreeze = 1:
  echo input gate closes
  echo feedback moves to hold value inside echo_fx.pd
  dry loop mix is muted when loopsToEcho = 1
  dry monitor mix is muted when monitorToEcho = 1
  echo wet output remains audible

echoFreeze = 0:
  echo input gate follows echoOn/send gates
  echo feedback returns to configured echoFeedback
  dry loop/monitor gates return to normal existing behavior
```

---

### Task 1: Add Effects Controller State and OSC Commands

**Files:**
- Create: `src/controller/effects_controller.js`
- Modify: `src/controller/slot_controller.js`
- Test: `test/unit/slot_controller.test.js`

- [ ] **Step 1: Write failing controller tests**

Append these tests to `test/unit/slot_controller.test.js`:

```js
test('getState includes default engine effect state', () => {
    const transport = createFakeTransport();
    const controller = createController({ transport });

    assert.deepEqual(controller.getState().effects, {
        reverbOn: false,
        reverbWet: 0.35,
        reverbRoom: 0.75,
        reverbDamp: 0.35,
        echoOn: false,
        echoWet: 0.45,
        echoTime: 375,
        echoFeedback: 0.55,
        echoDamp: 0.35,
        echoFreeze: false,
        loopsToReverb: false,
        loopsToEcho: false,
        monitorToReverb: false,
        monitorToEcho: false,
    });
});

test('setEffect updates state and sends clipped OSC values', async () => {
    const transport = createFakeTransport();
    const controller = createController({ transport });

    await controller.setEffect('echoWet', 2);
    await controller.setEffect('echoTime', 5000);
    await controller.setEffect('echoFeedback', 0.99);
    await controller.setEffect('reverbOn', true);

    assert.equal(controller.getState().effects.echoWet, 1);
    assert.equal(controller.getState().effects.echoTime, 4000);
    assert.equal(controller.getState().effects.echoFeedback, 0.95);
    assert.equal(controller.getState().effects.reverbOn, true);
    assert.deepEqual(transport.commands, [
        ['/fx', 'echoWet', 1],
        ['/fx', 'echoTime', 4000],
        ['/fx', 'echoFeedback', 0.95],
        ['/fx', 'reverbOn', 1],
    ]);
});

test('toggleEffect flips boolean effect controls', async () => {
    const transport = createFakeTransport();
    const controller = createController({ transport });

    await controller.toggleEffect('loopsToEcho');
    await controller.toggleEffect('echoFreeze');
    await controller.toggleEffect('echoFreeze');

    assert.equal(controller.getState().effects.loopsToEcho, true);
    assert.equal(controller.getState().effects.echoFreeze, false);
    assert.deepEqual(transport.commands, [
        ['/fx', 'loopsToEcho', 1],
        ['/fx', 'echoFreeze', 1],
        ['/fx', 'echoFreeze', 0],
    ]);
});

test('setEffect rejects unknown effect controls', async () => {
    const transport = createFakeTransport();
    const controller = createController({ transport });

    await assert.rejects(
        () => controller.setEffect('missingControl', 1),
        /Unknown effect control: missingControl/
    );
});
```

- [ ] **Step 2: Run the focused tests and confirm failure**

Run:

```bash
npm test -- test/unit/slot_controller.test.js
```

Expected: fails because `getState().effects`, `setEffect`, and `toggleEffect` do not exist yet.

- [ ] **Step 3: Create `EffectsController`**

Create `src/controller/effects_controller.js`:

```js
const DEFAULT_EFFECTS_STATE = {
    reverbOn: false,
    reverbWet: 0.35,
    reverbRoom: 0.75,
    reverbDamp: 0.35,
    echoOn: false,
    echoWet: 0.45,
    echoTime: 375,
    echoFeedback: 0.55,
    echoDamp: 0.35,
    echoFreeze: false,
    loopsToReverb: false,
    loopsToEcho: false,
    monitorToReverb: false,
    monitorToEcho: false,
};

const BOOLEAN_CONTROLS = new Set([
    'reverbOn',
    'echoOn',
    'echoFreeze',
    'loopsToReverb',
    'loopsToEcho',
    'monitorToReverb',
    'monitorToEcho',
]);

const RANGES = {
    reverbWet: [0, 1],
    reverbRoom: [0, 1],
    reverbDamp: [0, 1],
    echoWet: [0, 1],
    echoTime: [1, 4000],
    echoFeedback: [0, 0.95],
    echoDamp: [0, 1],
};

function cloneState(state) {
    return { ...state };
}

function clip(value, min, max) {
    return Math.max(min, Math.min(max, Number(value)));
}

class EffectsController {
    constructor(options = {}) {
        if (!options.transport) {
            throw new Error('EffectsController requires a transport');
        }
        this.transport = options.transport;
        this.state = {
            ...DEFAULT_EFFECTS_STATE,
            ...(options.initialState || {}),
        };
    }

    getState() {
        return cloneState(this.state);
    }

    normalize(name, value) {
        if (BOOLEAN_CONTROLS.has(name)) {
            return value ? 1 : 0;
        }
        if (RANGES[name]) {
            const [min, max] = RANGES[name];
            return clip(value, min, max);
        }
        throw new Error(`Unknown effect control: ${name}`);
    }

    async set(name, value) {
        const normalized = this.normalize(name, value);
        this.state[name] = BOOLEAN_CONTROLS.has(name) ? Boolean(normalized) : normalized;
        await this.transport.send('/fx', name, normalized);
        return this.getState();
    }

    async toggle(name) {
        if (!BOOLEAN_CONTROLS.has(name)) {
            throw new Error(`Effect control is not toggleable: ${name}`);
        }
        return this.set(name, !this.state[name]);
    }
}

module.exports = {
    DEFAULT_EFFECTS_STATE,
    EffectsController,
};
```

- [ ] **Step 4: Compose effects into `SlotController`**

In `src/controller/slot_controller.js`, add this import near the top:

```js
const { EffectsController } = require('./effects_controller');
```

In the constructor, after `this.transport = options.transport;`, add:

```js
        this.effects = options.effectsController || new EffectsController({
            transport: this.transport,
            initialState: options.effects,
        });
```

In `getState()`, add this sibling property next to `tempo`:

```js
            effects: this.effects.getState(),
```

Add these methods to the `SlotController` class:

```js
    async setEffect(name, value) {
        const state = await this.effects.set(name, value);
        this.emitChange();
        return state;
    }

    async toggleEffect(name) {
        const state = await this.effects.toggle(name);
        this.emitChange();
        return state;
    }
```

- [ ] **Step 5: Run focused and full unit tests**

Run:

```bash
npm test -- test/unit/slot_controller.test.js
npm test
```

Expected: all unit tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/controller/effects_controller.js src/controller/slot_controller.js test/unit/slot_controller.test.js
git commit -m "feat: add engine effects controller state"
```

---

### Task 2: Add Web Server Actions for Effects

**Files:**
- Modify: `src/controller/web_server.js`
- Test: `test/unit/web_server.test.js`

- [ ] **Step 1: Write failing web server tests**

Add tests to `test/unit/web_server.test.js` using the existing helper style in that file. If the file uses an HTTP request helper, follow that helper exactly and add these two cases:

```js
test('POST /api/action supports effect toggle actions', async () => {
    const calls = [];
    const server = createWebServer({
        controller: {
            getState: () => ({ ok: true }),
            toggleEffect: async (name) => calls.push(['toggleEffect', name]),
        },
        runtimeConfig: { controller: { cropStepMs: 30 } },
    });

    const response = await postJson(server, '/api/action', {
        action: 'effectToggle',
        control: 'loopsToEcho',
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(calls, [['toggleEffect', 'loopsToEcho']]);
});

test('POST /api/action supports effect value actions', async () => {
    const calls = [];
    const server = createWebServer({
        controller: {
            getState: () => ({ ok: true }),
            setEffect: async (name, value) => calls.push(['setEffect', name, value]),
        },
        runtimeConfig: { controller: { cropStepMs: 30 } },
    });

    const response = await postJson(server, '/api/action', {
        action: 'effectSet',
        control: 'echoTime',
        value: 625,
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(calls, [['setEffect', 'echoTime', 625]]);
});
```

If the actual helper names differ, preserve the repository's current `web_server.test.js` helper names and only change the setup/action bodies shown above.

- [ ] **Step 2: Run focused test and confirm failure**

Run:

```bash
npm test -- test/unit/web_server.test.js
```

Expected: fails because `effectToggle` and `effectSet` actions are not routed.

- [ ] **Step 3: Implement web action routing**

In `src/controller/web_server.js`, inside the POST action handler, add these branches before the final unknown-action branch:

```js
        else if (action === 'effectToggle') {
            await controller.toggleEffect(body.control);
        }
        else if (action === 'effectSet') {
            await controller.setEffect(body.control, body.value);
        }
```

Use the local variable that holds the parsed request body. If the file currently destructures only `{ action, slotId }`, update it to include the full parsed object:

```js
const body = await readJson(req);
const { action, slotId } = body;
```

- [ ] **Step 4: Run focused and full unit tests**

Run:

```bash
npm test -- test/unit/web_server.test.js
npm test
```

Expected: all unit tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/controller/web_server.js test/unit/web_server.test.js
git commit -m "feat: expose effects through web actions"
```

---

### Task 3: Add Dev Controller Effect UI

**Files:**
- Modify: `public/dev-controller.html`
- Test: `test/unit/dev_controller_html.test.js`

- [ ] **Step 1: Add HTML structure tests**

Append to `test/unit/dev_controller_html.test.js`:

```js
test('dev controller includes engine send effects controls', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'dev-controller.html'), 'utf8');

    assert.match(html, /data-effect-toggle="loopsToReverb"/);
    assert.match(html, /data-effect-toggle="loopsToEcho"/);
    assert.match(html, /data-effect-toggle="monitorToReverb"/);
    assert.match(html, /data-effect-toggle="monitorToEcho"/);
    assert.match(html, /data-effect-toggle="reverbOn"/);
    assert.match(html, /data-effect-toggle="echoOn"/);
    assert.match(html, /data-effect-toggle="echoFreeze"/);
    assert.match(html, /data-effect-range="reverbWet"/);
    assert.match(html, /data-effect-range="echoTime"/);
    assert.match(html, /action: 'effectToggle'/);
    assert.match(html, /action: 'effectSet'/);
});
```

- [ ] **Step 2: Run focused test and confirm failure**

Run:

```bash
npm test -- test/unit/dev_controller_html.test.js
```

Expected: fails because the controls are not present.

- [ ] **Step 3: Add effects panel markup**

In `public/dev-controller.html`, add `effects` to the CSS panel selector:

```css
        .slot,
        .transport,
        .input-routing,
        .tempo,
        .effects {
            border: 1px solid var(--line);
            border-radius: 8px;
            background: var(--panel);
            padding: 14px;
        }
```

Add compact range styling near the button styles:

```css
        .effects {
            margin-top: 14px;
        }

        .effects-grid {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 12px;
        }

        .effect-bank {
            display: grid;
            gap: 8px;
        }

        .effect-bank h2 {
            margin-bottom: 2px;
        }

        .range-row {
            display: grid;
            grid-template-columns: 112px 1fr 52px;
            align-items: center;
            gap: 8px;
            color: var(--muted);
            font-size: 13px;
        }

        input[type="range"] {
            width: 100%;
        }

        button.active {
            border-color: var(--accent);
            background: var(--accent);
            color: #07120e;
        }
```

Add this section after the monitor transport block:

```html
        <section class="effects">
            <div class="effects-grid">
                <div class="effect-bank">
                    <h2>Reverb</h2>
                    <button data-effect-toggle="reverbOn">Reverb On</button>
                    <button data-effect-toggle="loopsToReverb">Loops Send</button>
                    <button data-effect-toggle="monitorToReverb">Monitor Send</button>
                    <label class="range-row">
                        <span>Wet</span>
                        <input data-effect-range="reverbWet" type="range" min="0" max="1" step="0.01">
                        <strong data-effect-value="reverbWet">0.35</strong>
                    </label>
                    <label class="range-row">
                        <span>Room</span>
                        <input data-effect-range="reverbRoom" type="range" min="0" max="1" step="0.01">
                        <strong data-effect-value="reverbRoom">0.75</strong>
                    </label>
                    <label class="range-row">
                        <span>Damp</span>
                        <input data-effect-range="reverbDamp" type="range" min="0" max="1" step="0.01">
                        <strong data-effect-value="reverbDamp">0.35</strong>
                    </label>
                </div>

                <div class="effect-bank">
                    <h2>Echo</h2>
                    <button data-effect-toggle="echoOn">Echo On</button>
                    <button data-effect-toggle="loopsToEcho">Loops Send</button>
                    <button data-effect-toggle="monitorToEcho">Monitor Send</button>
                    <button data-effect-toggle="echoFreeze">Freeze</button>
                    <label class="range-row">
                        <span>Wet</span>
                        <input data-effect-range="echoWet" type="range" min="0" max="1" step="0.01">
                        <strong data-effect-value="echoWet">0.45</strong>
                    </label>
                    <label class="range-row">
                        <span>Time</span>
                        <input data-effect-range="echoTime" type="range" min="1" max="4000" step="1">
                        <strong data-effect-value="echoTime">375</strong>
                    </label>
                    <label class="range-row">
                        <span>Feedback</span>
                        <input data-effect-range="echoFeedback" type="range" min="0" max="0.95" step="0.01">
                        <strong data-effect-value="echoFeedback">0.55</strong>
                    </label>
                    <label class="range-row">
                        <span>Damp</span>
                        <input data-effect-range="echoDamp" type="range" min="0" max="1" step="0.01">
                        <strong data-effect-value="echoDamp">0.35</strong>
                    </label>
                </div>
            </div>
        </section>
```

- [ ] **Step 4: Add browser JS handlers**

In the existing script, add:

```js
        document.querySelectorAll('[data-effect-toggle]').forEach((button) => {
            button.addEventListener('click', () => {
                sendAction({
                    action: 'effectToggle',
                    control: button.dataset.effectToggle,
                });
            });
        });

        document.querySelectorAll('[data-effect-range]').forEach((input) => {
            input.addEventListener('input', () => {
                sendAction({
                    action: 'effectSet',
                    control: input.dataset.effectRange,
                    value: Number(input.value),
                });
            });
        });
```

In the existing render/update function, add:

```js
        function updateEffects(effects = {}) {
            document.querySelectorAll('[data-effect-toggle]').forEach((button) => {
                const name = button.dataset.effectToggle;
                button.classList.toggle('active', Boolean(effects[name]));
            });

            document.querySelectorAll('[data-effect-range]').forEach((input) => {
                const name = input.dataset.effectRange;
                if (effects[name] === undefined) return;
                input.value = effects[name];
                const value = document.querySelector(`[data-effect-value="${name}"]`);
                if (value) value.textContent = Number(effects[name]).toFixed(name === 'echoTime' ? 0 : 2);
            });
        }
```

Call it wherever state is rendered:

```js
        updateEffects(state.effects);
```

- [ ] **Step 5: Run focused and full unit tests**

Run:

```bash
npm test -- test/unit/dev_controller_html.test.js
npm test
```

Expected: all unit tests pass.

- [ ] **Step 6: Commit**

```bash
git add public/dev-controller.html test/unit/dev_controller_html.test.js
git commit -m "feat: add web controls for engine effects"
```

---

### Task 4: Create Pd Echo and Reverb Abstractions

**Files:**
- Create: `src/echo_fx.pd`
- Create: `src/reverb_fx.pd`
- Test: `test/unit/engine_patch.test.js`

- [ ] **Step 1: Add patch structure tests**

Append to `test/unit/engine_patch.test.js`:

```js
test('effect abstractions exist with expected core objects', () => {
    const echo = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'echo_fx.pd'), 'utf8');
    const reverb = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'reverb_fx.pd'), 'utf8');

    assert.match(echo, /route on wet time feedback damp freeze/);
    assert.match(echo, /delwrite~ \$0_echo_L 4000/);
    assert.match(echo, /delwrite~ \$0_echo_R 4000/);
    assert.match(echo, /vd~ \$0_echo_L/);
    assert.match(echo, /vd~ \$0_echo_R/);
    assert.match(echo, /lop~/);

    assert.match(reverb, /route on wet room damp/);
    assert.match(reverb, /rev3~/);
    assert.match(reverb, /line~/);
});
```

- [ ] **Step 2: Run focused test and confirm failure**

Run:

```bash
npm test -- test/unit/engine_patch.test.js
```

Expected: fails because the abstractions do not exist.

- [ ] **Step 3: Create `src/reverb_fx.pd` in Pd GUI**

Use Pd GUI for this file if possible. Text editing Pd files is fragile. Create an abstraction with this contract:

```text
inlets left-to-right:
  inlet~ left send bus
  inlet~ right send bus
  inlet control messages: on wet room damp

outlets left-to-right:
  outlet~ left wet signal
  outlet~ right wet signal
```

Patch behavior:

```text
control inlet -> route on wet room damp
on -> line~ gate over 10 ms
wet -> line~ wet gain over 10 ms
room -> scale 0..1 to rev3 liveness range, initial target 75..98
damp -> scale 0..1 to rev3 HF damping range, initial target 20..80

left/right input -> *~ on gate -> rev3~ 100 90 3000 20
rev3~ stereo output -> *~ wet line~ -> outlet~
```

Important Pd text constraints:

```text
Use commas in expr as \,
Do not connect out of print objects
Keep signal outlets visually left of any plain outlet if later adding state
```

- [ ] **Step 4: Create `src/echo_fx.pd` in Pd GUI**

Create an abstraction with this contract:

```text
inlets left-to-right:
  inlet~ left send bus
  inlet~ right send bus
  inlet control messages: on wet time feedback damp freeze

outlets left-to-right:
  outlet~ left wet signal
  outlet~ right wet signal
```

Patch behavior:

```text
control inlet -> route on wet time feedback damp freeze
on -> line~ gate over 10 ms
wet -> line~ wet gain over 10 ms
time -> clip 1 4000 -> sig~ -> lop~ 5 -> vd~ delay time
feedback -> clip 0 0.95
damp -> scale 0..1 to lop~ cutoff, initial target 12000 - damp * 11000
freeze -> closes input write gate and switches feedback to 0.99

input write:
  ((left input * on gate * freeze-inverted gate) + damped left feedback) -> delwrite~ $0_echo_L 4000
  ((right input * on gate * freeze-inverted gate) + damped right feedback) -> delwrite~ $0_echo_R 4000

read:
  vd~ $0_echo_L -> lop~ damp cutoff -> feedback path and wet output
  vd~ $0_echo_R -> lop~ damp cutoff -> feedback path and wet output

wet output:
  delayed signal * wet line~ -> outlet~
```

Safety constraints:

```text
Clip configured feedback to 0..0.95.
When freeze is on, use 0.99, not greater than 1.0.
Put a [clip~ -1 1] or gentle [tanh~] equivalent before delwrite~ if feedback can self-build.
Do not let wet output depend on dry input directly; echo output should be delay-buffer output.
```

- [ ] **Step 5: Run patch structure test**

Run:

```bash
npm test -- test/unit/engine_patch.test.js
```

Expected: effect abstraction test passes. Existing engine patch tests still pass.

- [ ] **Step 6: Commit**

```bash
git add src/echo_fx.pd src/reverb_fx.pd test/unit/engine_patch.test.js
git commit -m "feat: add pd send effect abstractions"
```

---

### Task 5: Wire Engine-Level Send Buses in `engine.pd`

**Files:**
- Modify: `src/engine.pd`
- Test: `test/unit/engine_patch.test.js`
- Test: `test/test_engine.js`

- [ ] **Step 1: Add engine patch structure tests**

Extend `test/unit/engine_patch.test.js`:

```js
test('engine patch exposes shared fx route and send abstractions', () => {
    const patch = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'engine.pd'), 'utf8');

    assert.match(patch, /route slot1 slot2 monitor connect source fx/);
    assert.match(patch, /route reverbOn reverbWet reverbRoom reverbDamp echoOn echoWet echoTime echoFeedback echoDamp echoFreeze loopsToReverb loopsToEcho monitorToReverb monitorToEcho/);
    assert.match(patch, /reverb_fx/);
    assert.match(patch, /echo_fx/);
    assert.match(patch, /line~/);
});
```

- [ ] **Step 2: Add managed engine OSC smoke test**

In `test/test_engine.js`, add a test that sends all `/fx` messages and asserts the engine stays responsive by recording a short loop afterward:

```js
await t.test('engine accepts fx controls without breaking slot state', async () => {
    await sendOsc('/fx', 'reverbOn', 1);
    await sendOsc('/fx', 'reverbWet', 0.4);
    await sendOsc('/fx', 'reverbRoom', 0.8);
    await sendOsc('/fx', 'reverbDamp', 0.25);
    await sendOsc('/fx', 'echoOn', 1);
    await sendOsc('/fx', 'echoWet', 0.5);
    await sendOsc('/fx', 'echoTime', 375);
    await sendOsc('/fx', 'echoFeedback', 0.6);
    await sendOsc('/fx', 'echoDamp', 0.35);
    await sendOsc('/fx', 'loopsToEcho', 1);
    await sendOsc('/fx', 'monitorToEcho', 1);
    await sendOsc('/fx', 'echoFreeze', 1);
    await sendOsc('/fx', 'echoFreeze', 0);

    const messages = [];
    const stopCapture = captureStateMessages((message) => messages.push(message));

    await sendOsc('/slot1', 'rec', 1);
    await wait(150);
    await sendOsc('/slot1', 'rec', 0);
    await waitForMessage(messages, ['slot1', 'length']);

    stopCapture();
    assert.ok(messages.some((message) => message[0] === 'slot1' && message[1] === 'length'));
});
```

Use the exact helper names already present in `test/test_engine.js`; the payload sequence above is the required behavior.

- [ ] **Step 3: Run tests and confirm failure**

Run:

```bash
npm test -- test/unit/engine_patch.test.js
npm run test:engine:managed
```

Expected: patch test fails until `engine.pd` is wired. Managed engine test may fail until Pd route accepts `/fx`.

- [ ] **Step 4: Edit `src/engine.pd` in Pd GUI**

Use Pd GUI if possible. Keep `engine.pd` as a host patch. Do not duplicate effect internals here.

Routing changes:

```text
current:
  route slot1 slot2 monitor connect source

new:
  route slot1 slot2 monitor connect source fx

fx outlet:
  route reverbOn reverbWet reverbRoom reverbDamp echoOn echoWet echoTime echoFeedback echoDamp echoFreeze loopsToReverb loopsToEcho monitorToReverb monitorToEcho
```

Audio routing:

```text
loop mix L/R:
  existing slot1+slot2 +~ outputs

monitor mix L/R:
  existing post-monitor-gate signal before dac~

reverb send bus:
  (loop mix * loopsToReverb gate * reverbOn gate)
  +
  (monitor mix * monitorToReverb gate * reverbOn gate)
  -> reverb_fx signal inlets

echo send bus:
  (loop mix * loopsToEcho gate * echoOn gate)
  +
  (monitor mix * monitorToEcho gate * echoOn gate)
  -> echo_fx signal inlets

wet returns:
  reverb_fx L/R -> dac~ 1/2
  echo_fx L/R -> dac~ 1/2
```

Dry mute for echo freeze:

```text
loop dry mute factor:
  if echoFreeze == 1 and loopsToEcho == 1 then 0 else 1

monitor dry mute factor:
  if echoFreeze == 1 and monitorToEcho == 1 then 0 else existing monitor gate value
```

Implement mute factors with message-rate `expr` and `line~` ramps:

```text
expr if($f1 == 1 && $f2 == 1 \, 0 \, 1)
msg $1 10
line~
```

Control forwarding:

```text
reverbOn/reverbWet/reverbRoom/reverbDamp -> list prepend matching symbol -> reverb_fx control inlet
echoOn/echoWet/echoTime/echoFeedback/echoDamp/echoFreeze -> list prepend matching symbol -> echo_fx control inlet
```

Initialize defaults from `loadbang`:

```text
reverbOn 0
reverbWet 0.35
reverbRoom 0.75
reverbDamp 0.35
echoOn 0
echoWet 0.45
echoTime 375
echoFeedback 0.55
echoDamp 0.35
echoFreeze 0
loopsToReverb 0
loopsToEcho 0
monitorToReverb 0
monitorToEcho 0
```

- [ ] **Step 5: Run patch and engine tests**

Run:

```bash
npm test -- test/unit/engine_patch.test.js
npm run test:engine:managed
```

Expected: patch tests pass and managed engine tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/engine.pd test/unit/engine_patch.test.js test/test_engine.js
git commit -m "feat: wire engine send effects"
```

---

### Task 6: Verify the Full Browser Workflow

**Files:**
- No required source edits unless verification exposes defects.

- [ ] **Step 1: Start Mac dev server**

Run:

```bash
npm run dev:mac
```

Expected:

```text
Slooper Web Controller listening on http://127.0.0.1:3000
```

- [ ] **Step 2: Open the browser controller**

Open:

```text
http://127.0.0.1:3000
```

- [ ] **Step 3: Exercise reverb controls**

Manual checks:

```text
Enable Reverb On.
Enable Loops Send.
Record a loop.
Raise/lower Wet and confirm the loop reverb changes.
Disable Loops Send and confirm only dry loop remains.
Enable Monitor Send and confirm monitored input can feed reverb.
```

- [ ] **Step 4: Exercise echo controls**

Manual checks:

```text
Enable Echo On.
Enable Loops Send.
Record a loop.
Adjust Time and confirm delay spacing changes.
Adjust Feedback and confirm tail length changes.
Adjust Damp and confirm tail gets darker/brighter.
Disable Loops Send and confirm echo no longer receives loop audio.
```

- [ ] **Step 5: Exercise freeze behavior**

Manual checks:

```text
Enable Echo On.
Enable Loops Send.
Play a loop.
Press Freeze.
Confirm dry loop mutes and echo tail remains.
Release Freeze.
Confirm dry loop returns.

Enable Monitor Send.
Enable Monitor.
Press Freeze.
Confirm dry monitor mutes and echo tail remains.
Release Freeze.
Confirm dry monitor follows the normal monitor state again.
```

- [ ] **Step 6: Stop dev server cleanly**

Press `Ctrl+C`.

Expected: Pd and Node stop, and no runaway Pd/JACK processes remain.

- [ ] **Step 7: Commit fixes if manual verification required edits**

If defects were fixed:

```bash
git add src/engine.pd src/echo_fx.pd src/reverb_fx.pd public/dev-controller.html src/controller/*.js test/unit/*.test.js test/test_engine.js
git commit -m "fix: stabilize engine effects workflow"
```

If no defects were found, do not create an empty commit.

---

### Task 7: Document Effects Usage

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add README documentation**

Add this section under `Features` or after the Pure Data architecture section:

```markdown
## Engine Send Effects

Slooper has two shared engine-level send effects:

- **Reverb**: a stereo `rev3~` reverb send.
- **Echo**: a stereo delay with wet level, delay time, feedback, damping, and freeze.

The effects are shared by the whole engine, not instantiated per loop slot. The engine exposes four send toggles:

- loops to reverb
- loops to echo
- monitor to reverb
- monitor to echo

Echo freeze holds the delay tail, stops feeding new audio into the echo, and mutes the dry loop or monitor path when that path is currently sent to echo. This behaves like a DJ mixer echo-freeze gesture while keeping the normal routing as send effects.
```

- [ ] **Step 2: Run documentation-adjacent tests**

Run:

```bash
npm test
```

Expected: all unit tests pass.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: describe engine send effects"
```

---

## Final Verification

Run:

```bash
npm test
npm run test:engine:managed
```

Expected:

```text
unit tests pass
managed engine tests pass
```

Then run the Mac dev workflow once:

```bash
npm run dev:mac
```

Open:

```text
http://127.0.0.1:3000
```

Verify:

```text
Reverb wet affects loop send.
Reverb wet affects monitor send.
Echo wet/time/feedback/damp affect loop send.
Echo wet/time/feedback/damp affect monitor send.
Echo freeze mutes dry loops when loopsToEcho is enabled.
Echo freeze mutes dry monitor when monitorToEcho is enabled.
Echo freeze does not permanently break normal monitor auto-mute after release.
Existing record/play/stop/crop/reset/clear behavior still works.
```

## Implementation Notes

- Prefer editing Pd files in Pd GUI. Text editing `.pd` files can corrupt object indices.
- If text editing Pd is unavoidable, add objects at the end and update `#X connect` lines carefully.
- Keep `looper_slot.pd` unchanged for this feature.
- Keep effect DSP in `echo_fx.pd` and `reverb_fx.pd`; `engine.pd` should only route, gate, and mix.
- Do not add MIDI mappings until web controls prove the behavior.
- If `rev3~` sounds too basic later, replace only `reverb_fx.pd` internals. Keep the `/fx` message contract stable.

## Self-Review

- Spec coverage: The plan covers shared reverb, shared echo, send toggles for loops and monitor, wet/config controls, and echo freeze dry mute behavior.
- Placeholder scan: No unresolved placeholder markers or intentionally undefined implementation slots remain.
- Type consistency: Effect names match across the message contract, default state, tests, web actions, and Pd route names.
