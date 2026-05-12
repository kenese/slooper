# Dynamic PX5 Source Switching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add live PX5 input-source switching so Send, Channel 2, and Channel 3 can be selected without restarting Pd or Node.

**Architecture:** The controller will send a `/source <id>` OSC command on every accepted source change. macOS/XONE runtime patches will expose all configured PX5 stereo source pairs to Pd at once and select the active pair inside `engine.pd` with click-safe signal gates. Pi/Linux keeps the existing JACK rewire path for now, while receiving the same `/source` command so the control contract is shared.

**Tech Stack:** Node.js `node:test`, OSC via `node-osc`, Pure Data patch text, JACK on Linux/Pi.

---

### Task 1: Controller Emits Source Selection OSC

**Files:**
- Modify: `test/unit/slot_controller.test.js`
- Modify: `src/controller/slot_controller.js`

- [ ] **Step 1: Write the failing test**

Add a test that proves source changes send `/source <id>` even when a platform-specific input router is present:

```js
test('selectInputSource sends source OSC and runs input router when configured', async () => {
    const sent = [];
    const routed = [];
    const controller = createController({
        transport: {
            send: async (...args) => sent.push(args),
        },
        inputSources: [
            { id: 'main', label: 'PX5 Send', ports: ['system:capture_9', 'system:capture_10'] },
            { id: 'ch2', label: 'PX5 Channel 2', ports: ['system:capture_3', 'system:capture_4'] },
        ],
        inputRouter: {
            selectSource: async (source, sources) => routed.push([source.id, sources.map((item) => item.id)]),
        },
    });

    await controller.selectInputSource('ch2');

    assert.deepEqual(sent, [['/source', 'ch2']]);
    assert.deepEqual(routed, [['ch2', ['main', 'ch2']]]);
    assert.equal(controller.getState().inputRouting.selectedSourceId, 'ch2');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
node --test test/unit/slot_controller.test.js
```

Expected: FAIL because `selectInputSource()` updates state and optionally calls `inputRouter`, but does not send `/source`.

- [ ] **Step 3: Implement the minimal controller change**

In `src/controller/slot_controller.js`, update `selectInputSource()` after the router call and before state mutation:

```js
if (this.inputRouter && typeof this.inputRouter.selectSource === 'function') {
    await this.inputRouter.selectSource(source, this.inputSources);
}

await this.send('/source', source.id);

this.selectedInputSourceId = source.id;
```

- [ ] **Step 4: Verify controller tests**

Run:

```bash
node --test test/unit/slot_controller.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/controller/slot_controller.js test/unit/slot_controller.test.js
git commit -m "feat: emit source selection OSC"
```

### Task 2: Represent macOS Multi-Input Pd Sources in Config

**Files:**
- Modify: `config/audio/xone-px5.json`
- Modify: `src/config.js`
- Modify: `test/unit/config.test.js`

- [ ] **Step 1: Write the failing config test**

Add a unit test that expects XONE on macOS to render a source-enabled Pd patch:

```js
test('mac XONE renders runtime patch with all selectable source input channels', () => {
    const source = [
        '#N canvas 0 0 100 100 12;',
        '#X obj 14 130 adc~ 1 2;',
        '#X obj 184 479 dac~ 1 2;',
    ].join('\n');

    const config = getRuntimeConfig({
        audioDevice: 'XONE',
        midiDevice: 'OSC',
        platform: 'darwin',
        projectRoot: '/repo',
    });

    assert.deepEqual(config.audio.captureSources.map((item) => item.id), ['main', 'ch2', 'ch3']);
    assert.equal(renderEnginePatch(source, config).includes('adc~ 3 4 5 6 9 10'), true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
node --test test/unit/config.test.js
```

Expected: FAIL because the rendered macOS XONE patch still uses only `adc~ 9 10`.

- [ ] **Step 3: Add macOS source channel metadata**

In `config/audio/xone-px5.json`, add a `pd.darwinSources` section:

```json
{
  "pd": {
    "darwin": {
      "adc": [
        9,
        10
      ],
      "dac": [
        1,
        2
      ]
    },
    "darwinSources": [
      {
        "id": "ch2",
        "adc": [
          3,
          4
        ]
      },
      {
        "id": "ch3",
        "adc": [
          5,
          6
        ]
      },
      {
        "id": "main",
        "adc": [
          9,
          10
        ]
      }
    ],
    "linux": {
      "adc": [
        1,
        2
      ],
      "dac": [
        1,
        2
      ]
    }
  }
}
```

- [ ] **Step 4: Normalize source channel metadata**

In `src/config.js`, normalize optional `pd.darwinSources` into `audio.macPdSources`, preserving `id` and stereo `adc` pairs. For non-XONE configs, default this to an empty array.

- [ ] **Step 5: Render multi-channel `adc~` when mac sources exist**

Update `renderEnginePatch()` so macOS configs with `audio.macPdSources.length > 0` replace the source `adc~` object with all configured channels in order:

```pd
adc~ 3 4 5 6 9 10
```

Do not change Linux rendering.

- [ ] **Step 6: Verify config tests**

Run:

```bash
node --test test/unit/config.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add config/audio/xone-px5.json src/config.js test/unit/config.test.js
git commit -m "feat: configure mac PX5 source channels"
```

### Task 3: Add Pd Source Selector to Host Patch

**Files:**
- Modify: `src/engine.pd`
- Modify: `test/unit/looper_slot_patch.test.js` or add `test/unit/engine_patch.test.js`

- [ ] **Step 1: Write a failing patch-structure test**

Create or update a test that checks `src/engine.pd` routes `source` and contains source-selection control objects:

```js
test('engine patch accepts source selection messages', () => {
    const patch = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'engine.pd'), 'utf8');

    assert.match(patch, /route slot1 slot2 monitor connect source/);
    assert.match(patch, /route main ch2 ch3/);
    assert.match(patch, /line~/);
});
```

- [ ] **Step 2: Run the patch test to verify it fails**

Run:

```bash
node --test test/unit/engine_patch.test.js
```

Expected: FAIL because `engine.pd` currently routes only `slot1 slot2 monitor connect`.

- [ ] **Step 3: Update `engine.pd` carefully**

Edit `src/engine.pd` in Pd GUI if possible, then save and inspect text. The intended host flow is:

```pd
[route slot1 slot2 monitor connect source]
                                      |
                              [route main ch2 ch3]
```

For the static tracked patch, keep normal Linux/default input as `adc~ 1 2`. Add selector controls that can gate either the default input pair or, in generated macOS runtime patches, the expanded source input outlets.

Use `line~` ramps for source gains:

```pd
[msg 1 10] -> [line~] -> [*~]
[msg 0 10] -> [line~] -> [*~]
```

Keep the selected stereo output feeding the existing `*~ 0.8` input gain objects, so the rest of the looper graph remains unchanged.

- [ ] **Step 4: Verify Pd text object connections**

Run:

```bash
python3 scripts/analyze_pd.py src/engine.pd
```

Expected: no obvious connection from a sink object such as `print`, and source selector objects appear before their expected connections.

- [ ] **Step 5: Verify patch test**

Run:

```bash
node --test test/unit/engine_patch.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/engine.pd test/unit/engine_patch.test.js
git commit -m "feat: add Pd input source selector"
```

### Task 4: Integrate Runtime Rendering With Pd Source Selector

**Files:**
- Modify: `src/config.js`
- Modify: `test/unit/config.test.js`
- Verify: `.runtime/engine.pd` generated output

- [ ] **Step 1: Write the failing runtime rendering test**

Add a test that renders the current `src/engine.pd` with XONE/macOS config and asserts that all source channels and source routing coexist:

```js
test('mac XONE runtime patch keeps source selector with expanded adc channels', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'engine.pd'), 'utf8');
    const config = getRuntimeConfig({
        audioDevice: 'XONE',
        midiDevice: 'OSC',
        platform: 'darwin',
        projectRoot: '/repo',
    });
    const rendered = renderEnginePatch(source, config);

    assert.match(rendered, /adc~ 3 4 5 6 9 10/);
    assert.match(rendered, /route slot1 slot2 monitor connect source/);
    assert.match(rendered, /route main ch2 ch3/);
});
```

- [ ] **Step 2: Run the test to verify it fails or confirms missing integration**

Run:

```bash
node --test test/unit/config.test.js
```

Expected: FAIL if rendering does not yet preserve the selector with expanded channels.

- [ ] **Step 3: Adjust rendering with minimal text transforms**

Keep the transform limited to replacing the existing `adc~` channel list. Do not insert Pd objects into the middle of `src/engine.pd`; object insertion shifts connection indices.

- [ ] **Step 4: Verify generated runtime patch**

Run:

```bash
node scripts/runtime_config.js --ensure-runtime-patch midi-device=OSC audio-device=XONE
grep -n 'adc~\|route slot1 slot2 monitor connect source\|route main ch2 ch3' .runtime/engine.pd
```

Expected: generated patch contains expanded `adc~` and source route objects.

- [ ] **Step 5: Commit**

```bash
git add src/config.js test/unit/config.test.js
git commit -m "feat: render source-enabled mac runtime patch"
```

### Task 5: End-to-End Manual Verification

**Files:**
- Modify only if verification exposes a bug.

- [ ] **Step 1: Run unit tests**

Run:

```bash
npm run test:unit
```

Expected: PASS.

- [ ] **Step 2: Start macOS XONE mode**

Run:

```bash
./start.sh midi-device=OSC audio-device=XONE
```

Expected: Pd opens fresh, web controller starts, and Pd console shows OSC input when source buttons are clicked.

- [ ] **Step 3: Verify live source switching**

With audio present on PX5 Send, Channel 2, and Channel 3:

```text
Select PX5 Send -> monitor/record hears Send.
Select PX5 Channel 2 -> monitor/record hears Channel 2 without restart.
Select PX5 Channel 3 -> monitor/record hears Channel 3 without restart.
Switch while monitor is active -> no loud click.
Switch while a loop is playing -> existing loop continues; new recordings use selected input.
```

- [ ] **Step 4: Verify Pi/Linux dynamic routing**

On Pi:

```bash
./start.sh midi-device=OSC audio-device=XONE --restart-jack
```

Expected: selecting sources rewires JACK without restart and Pd continues running.

- [ ] **Step 5: Commit any verification fixes**

Only if fixes were needed:

```bash
git add <changed-files>
git commit -m "fix: stabilize dynamic PX5 source switching"
```

---

## Self-Review

- Spec coverage: The plan covers controller OSC, macOS Pd source switching, Pi/JACK dynamic routing, tests, and manual verification.
- Placeholder scan: No TODO/TBD placeholders remain.
- Type consistency: Source IDs are consistently `main`, `ch2`, and `ch3`; controller method is consistently `selectInputSource()`.
- Scope check: This is one focused feature. It does not attempt to replace the Pi JACK router with a fully Pd-native multi-input router.
