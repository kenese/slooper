# Configurable Channel Slot Topology Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Slooper start with a configurable number of independent stereo channels and configurable slots per channel, for example `channels=1 slots-per-channel=2` or `channels=3 slots-per-channel=4`.

**Architecture:** Keep `looper_slot.pd` as the unchanged per-slot DSP abstraction. Add reusable Pd channel abstractions for 2-slot and 4-slot channels, then generate a small `.runtime/engine.pd` host at startup from topology config. Node derives slots, channel membership, monitor state, and OSC routing from the same topology.

**Tech Stack:** Node.js CommonJS, Pure Data patch text, JACK on Linux, native Pd on Mac, `node:test`, OSC over UDP.

---

## File Structure

- Create `src/channel_2slot.pd`: one stereo input pair, two `[looper_slot]` instances, summed stereo loop output, one dry monitor gate, one state outlet.
- Create `src/channel_4slot.pd`: same contract as `channel_2slot.pd`, with four `[looper_slot]` instances.
- Modify `src/engine.pd`: either replace with a generated baseline template or stop relying on it directly for Linux; keep compatibility during transition by making generation default for all platforms.
- Modify `src/config.js`: parse topology args/options, normalize topology, generate runtime engine patch for all platforms, render shell variables for channel and JACK routing.
- Modify `start.sh`: accept `channels=` and `slots-per-channel=`, connect multiple JACK capture/playback pairs.
- Modify `src/controller/slot_controller.js`: store slot channel metadata and compute monitor per channel.
- Modify `src/index.js`: build MIDI handlers from normalized slot controls instead of hardcoded `slot1`/`slot2`.
- Modify `src/dev_controller.js` and web controller UI if needed: render dynamic slots/channels rather than two fixed slots.
- Modify `config/audio/*.json`: allow playback port pairs and capture port pairs for multi-channel hardware.
- Modify `config/midi/*.json`: support `slots` map while preserving legacy `slot1Button`/`slot2Button` controls.
- Modify tests in `test/unit/config.test.js`, `test/unit/engine_patch.test.js`, `test/unit/slot_controller.test.js`, `test/unit/start_script.test.js`, and integration coverage in `test/test_engine.js`.

## Topology Rules

- `channels` is a positive integer. Initial supported range: `1..4`.
- `slotsPerChannel` is either `2` or `4`.
- Slot IDs are flat and global: `slot1`, `slot2`, ..., `slotN`.
- Slot channel assignment is deterministic:

```js
const channelId = Math.floor((slotId - 1) / slotsPerChannel) + 1;
const indexInChannel = ((slotId - 1) % slotsPerChannel) + 1;
```

- Channel `1` uses Pd input pair `1/2` and output pair `1/2`.
- Channel `2` uses Pd input pair `3/4` and output pair `3/4`.
- Channel `3` uses Pd input pair `5/6` and output pair `5/6`.
- Channel monitor state is one dry monitor path per channel:

```js
monitorActive = monitorEnabled && !slotsInChannel.some(slot => slot.state === SlotState.PLAYING);
```

---

### Task 1: Add Topology Config Parsing

**Files:**
- Modify: `src/config.js`
- Test: `test/unit/config.test.js`

- [x] **Step 1: Write failing topology tests**

Add tests near the existing runtime config tests in `test/unit/config.test.js`:

```js
test('runtime config derives configurable channel slot topology', () => {
    const config = getRuntimeConfig({
        audioDevice: 'MAC',
        midiDevice: 'WEB',
        platform: 'darwin',
        projectRoot: path.join(__dirname, '../..'),
        channels: 3,
        slotsPerChannel: 4,
    });

    assert.deepEqual(config.topology, {
        channels: 3,
        slotsPerChannel: 4,
        totalSlots: 12,
    });
    assert.equal(config.slots.length, 12);
    assert.deepEqual(config.slots[0], { id: 1, name: 'slot1', channelId: 1, indexInChannel: 1 });
    assert.deepEqual(config.slots[4], { id: 5, name: 'slot5', channelId: 2, indexInChannel: 1 });
    assert.deepEqual(config.slots[11], { id: 12, name: 'slot12', channelId: 3, indexInChannel: 4 });
});

test('runtime config rejects unsupported topology values', () => {
    assert.throws(
        () => getRuntimeConfig({
            audioDevice: 'MAC',
            midiDevice: 'WEB',
            platform: 'darwin',
            projectRoot: path.join(__dirname, '../..'),
            channels: 0,
            slotsPerChannel: 2,
        }),
        /channels must be between 1 and 4/
    );

    assert.throws(
        () => getRuntimeConfig({
            audioDevice: 'MAC',
            midiDevice: 'WEB',
            platform: 'darwin',
            projectRoot: path.join(__dirname, '../..'),
            channels: 1,
            slotsPerChannel: 3,
        }),
        /slotsPerChannel must be 2 or 4/
    );
});
```

- [x] **Step 2: Run tests and confirm failure**

Run:

```bash
npm run test:unit -- test/unit/config.test.js
```

Expected: FAIL because `config.topology` and `config.slots` do not exist.

- [x] **Step 3: Implement topology normalization**

Add these helpers in `src/config.js` near the existing normalization helpers:

```js
function normalizePositiveInteger(value, fallback, label) {
    const normalized = value === undefined ? fallback : Number(value);
    if (!Number.isInteger(normalized)) {
        throw new Error(`${label} must be an integer`);
    }
    return normalized;
}

function normalizeTopology(options = {}) {
    const channels = normalizePositiveInteger(options.channels, 1, 'channels');
    const slotsPerChannel = normalizePositiveInteger(options.slotsPerChannel, 2, 'slotsPerChannel');

    if (channels < 1 || channels > 4) {
        throw new Error('channels must be between 1 and 4');
    }

    if (![2, 4].includes(slotsPerChannel)) {
        throw new Error('slotsPerChannel must be 2 or 4');
    }

    return {
        channels,
        slotsPerChannel,
        totalSlots: channels * slotsPerChannel,
    };
}

function buildSlots(topology) {
    return Array.from({ length: topology.totalSlots }, (_, index) => {
        const id = index + 1;
        return {
            id,
            name: `slot${id}`,
            channelId: Math.floor(index / topology.slotsPerChannel) + 1,
            indexInChannel: (index % topology.slotsPerChannel) + 1,
        };
    });
}
```

In `getRuntimeConfig`, before the returned object:

```js
const topology = normalizeTopology(options);
const slots = buildSlots(topology);
```

Add these fields to the returned config object:

```js
topology,
slots,
```

- [x] **Step 4: Run tests and confirm pass**

Run:

```bash
npm run test:unit -- test/unit/config.test.js
```

Expected: PASS for the new topology tests.

- [x] **Step 5: Commit**

```bash
git add src/config.js test/unit/config.test.js
git commit -m "feat: add runtime topology config"
```

---

### Task 2: Parse Startup Arguments

**Files:**
- Modify: `src/index.js`
- Modify: `src/dev_controller.js`
- Modify: `start.sh`
- Test: `test/unit/start_script.test.js`

- [x] **Step 1: Add argument parsing tests**

In `test/unit/start_script.test.js`, add assertions against the script source:

```js
test('start script forwards topology arguments into runtime config', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../start.sh'), 'utf8');

    assert.match(source, /CHANNELS=/);
    assert.match(source, /SLOTS_PER_CHANNEL=/);
    assert.match(source, /channels=\$CHANNELS/);
    assert.match(source, /slots-per-channel=\$SLOTS_PER_CHANNEL/);
});
```

In `test/unit/config.test.js`, add:

```js
test('runtime config accepts numeric topology options from CLI strings', () => {
    const config = getRuntimeConfig({
        audioDevice: 'MAC',
        midiDevice: 'WEB',
        platform: 'darwin',
        projectRoot: path.join(__dirname, '../..'),
        channels: '2',
        slotsPerChannel: '4',
    });

    assert.equal(config.topology.channels, 2);
    assert.equal(config.topology.slotsPerChannel, 4);
    assert.equal(config.topology.totalSlots, 8);
});
```

- [x] **Step 2: Run tests and confirm failure**

Run:

```bash
npm run test:unit -- test/unit/start_script.test.js test/unit/config.test.js
```

Expected: FAIL on the `start.sh` source checks.

- [x] **Step 3: Update Node argument parsing**

In both `src/index.js` and `src/dev_controller.js`, add:

```js
const channelsArg = args.find((arg) => arg.startsWith('channels='));
const slotsPerChannelArg = args.find((arg) => arg.startsWith('slots-per-channel='));
```

Pass these into `getRuntimeConfig`:

```js
channels: channelsArg ? channelsArg.split('=')[1] : undefined,
slotsPerChannel: slotsPerChannelArg ? slotsPerChannelArg.split('=')[1] : undefined,
```

- [x] **Step 4: Update `start.sh` defaults and forwarding**

Add defaults near the existing argument defaults:

```bash
CHANNELS=1
SLOTS_PER_CHANNEL=2
```

In the argument loop, handle:

```bash
channels=*) CHANNELS="${arg#*=}" ;;
slots-per-channel=*) SLOTS_PER_CHANNEL="${arg#*=}" ;;
```

When calling config rendering, ensure the runtime config command includes:

```bash
channels="$CHANNELS" slots-per-channel="$SLOTS_PER_CHANNEL"
```

If `start.sh` already passes the original `"$@"` into Node, keep that behavior; the explicit shell variables are for Pd/JACK config generation.

- [x] **Step 5: Run tests**

Run:

```bash
npm run test:unit -- test/unit/start_script.test.js test/unit/config.test.js
```

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add src/index.js src/dev_controller.js start.sh test/unit/start_script.test.js test/unit/config.test.js
git commit -m "feat: parse channel topology startup args"
```

---

### Task 3: Generate Runtime Engine Patch For Topology

**Files:**
- Modify: `src/config.js`
- Test: `test/unit/config.test.js`
- Test: `test/unit/engine_patch.test.js`

- [x] **Step 1: Add failing engine generation tests**

In `test/unit/config.test.js`, add:

```js
test('renderEnginePatch generates multi-channel host patch', () => {
    const config = getRuntimeConfig({
        audioDevice: 'MAC',
        midiDevice: 'WEB',
        platform: 'darwin',
        projectRoot: path.join(__dirname, '../..'),
        channels: 3,
        slotsPerChannel: 4,
    });

    const rendered = renderEnginePatch('', config);

    assert.match(rendered, /adc~ 1 2 3 4 5 6/);
    assert.match(rendered, /dac~ 1 2 3 4 5 6/);
    assert.match(rendered, /channel_4slot slot1 slot2 slot3 slot4/);
    assert.match(rendered, /channel_4slot slot5 slot6 slot7 slot8/);
    assert.match(rendered, /channel_4slot slot9 slot10 slot11 slot12/);
    assert.match(rendered, /route slot1 slot2 slot3 slot4 slot5 slot6 slot7 slot8 slot9 slot10 slot11 slot12 monitor1 monitor2 monitor3 connect/);
});
```

In `test/unit/engine_patch.test.js`, change the old static source assertion into a generated assertion:

```js
const { getRuntimeConfig, renderEnginePatch } = require('../../src/config');

test('generated engine patch accepts source and monitor messages', () => {
    const config = getRuntimeConfig({
        audioDevice: 'MAC',
        midiDevice: 'WEB',
        platform: 'darwin',
        projectRoot: path.join(__dirname, '../..'),
        channels: 1,
        slotsPerChannel: 2,
    });
    const patch = renderEnginePatch('', config);

    assert.match(patch, /route slot1 slot2 monitor1 connect source/);
    assert.match(patch, /channel_2slot slot1 slot2/);
    assert.match(patch, /netsend -u -b/);
});
```

- [x] **Step 2: Run tests and confirm failure**

Run:

```bash
npm run test:unit -- test/unit/config.test.js test/unit/engine_patch.test.js
```

Expected: FAIL because `renderEnginePatch` still rewrites the static `src/engine.pd`.

- [x] **Step 3: Implement generated patch rendering**

In `src/config.js`, add:

```js
function buildPdChannelList(pairCount) {
    return Array.from({ length: pairCount * 2 }, (_, index) => index + 1);
}

function renderGeneratedEnginePatch(config) {
    const topology = config.topology;
    const slots = config.slots;
    const audioChannels = buildPdChannelList(topology.channels);
    const routeItems = [
        ...slots.map((slot) => slot.name),
        ...Array.from({ length: topology.channels }, (_, index) => `monitor${index + 1}`),
        'connect',
        'source',
    ];

    const lines = [
        '#N canvas 171 24 1100 700 10;',
        '#X declare -path ../src;',
        '#X obj 13 8 netreceive -u -b 9000;',
        '#X obj 14 29 oscparse;',
        '#X obj 14 63 list trim;',
        `#X obj 201 112 route ${routeItems.join(' ')};`,
        `#X obj 14 130 adc~ ${audioChannels.join(' ')};`,
        `#X obj 184 560 dac~ ${audioChannels.join(' ')};`,
        '#X obj 535 8 loadbang;',
        '#X msg 535 63 \\; pd dsp 1;',
        '#X obj 505 398 netsend -u -b;',
        '#X obj 505 318 loadbang;',
        '#X msg 505 364 connect 127.0.0.1 9001;',
    ];

    // Keep this generator simple and explicit. Object IDs are deterministic
    // because every object line is appended before connection generation.
    const objectCountBeforeChannels = lines.filter((line) => line.startsWith('#X obj ') || line.startsWith('#X msg ')).length;
    const channelObjectIds = [];
    for (let channelIndex = 0; channelIndex < topology.channels; channelIndex += 1) {
        const channelSlots = slots
            .filter((slot) => slot.channelId === channelIndex + 1)
            .map((slot) => slot.name);
        const abstraction = topology.slotsPerChannel === 4 ? 'channel_4slot' : 'channel_2slot';
        channelObjectIds.push(objectCountBeforeChannels + channelIndex);
        lines.push(`#X obj ${14 + channelIndex * 220} 283 ${abstraction} ${channelSlots.join(' ')};`);
    }

    const connections = [];
    const netreceive = 0;
    const oscparse = 1;
    const listTrim = 2;
    const route = 3;
    const adc = 4;
    const dac = 5;
    const loadbang = 6;
    const dspMessage = 7;
    const netsend = 8;
    const netsendLoadbang = 9;
    const connectMessage = 10;

    connections.push(`#X connect ${netreceive} 0 ${oscparse} 0;`);
    connections.push(`#X connect ${oscparse} 0 ${listTrim} 0;`);
    connections.push(`#X connect ${listTrim} 0 ${route} 0;`);
    connections.push(`#X connect ${loadbang} 0 ${dspMessage} 0;`);
    connections.push(`#X connect ${netsendLoadbang} 0 ${connectMessage} 0;`);
    connections.push(`#X connect ${connectMessage} 0 ${netsend} 0;`);

    for (const slot of slots) {
        const channelObject = channelObjectIds[slot.channelId - 1];
        connections.push(`#X connect ${route} ${slot.id - 1} ${channelObject} 2;`);
    }

    for (let channelIndex = 0; channelIndex < topology.channels; channelIndex += 1) {
        const channelObject = channelObjectIds[channelIndex];
        const monitorOutlet = topology.totalSlots + channelIndex;
        connections.push(`#X connect ${route} ${monitorOutlet} ${channelObject} 3;`);
        connections.push(`#X connect ${adc} ${channelIndex * 2} ${channelObject} 0;`);
        connections.push(`#X connect ${adc} ${channelIndex * 2 + 1} ${channelObject} 1;`);
        connections.push(`#X connect ${channelObject} 0 ${dac} ${channelIndex * 2};`);
        connections.push(`#X connect ${channelObject} 1 ${dac} ${channelIndex * 2 + 1};`);
        connections.push(`#X connect ${channelObject} 2 ${netsend} 0;`);
    }

    return `${lines.join('\n')}\n${connections.join('\n')}\n`;
}
```

Then change `renderEnginePatch` to:

```js
function renderEnginePatch(source, config) {
    if (config.topology) {
        return renderGeneratedEnginePatch(config);
    }
    // Keep the existing legacy implementation below for compatibility until deleted.
}
```

Set `generateRuntimePatch` to `true` for all platforms in `getRuntimeConfig`:

```js
const generateRuntimePatch = true;
```

- [x] **Step 4: Run tests**

Run:

```bash
npm run test:unit -- test/unit/config.test.js test/unit/engine_patch.test.js
```

Expected: PASS for generated patch tests. Update any old tests that expect Linux to use tracked `src/engine.pd`; Linux should now use `.runtime/engine.pd`.

- [ ] **Step 5: Commit**

```bash
git add src/config.js test/unit/config.test.js test/unit/engine_patch.test.js
git commit -m "feat: generate engine patch from topology"
```

---

### Task 4: Add Pd Channel Abstractions

**Files:**
- Create: `src/channel_2slot.pd`
- Create: `src/channel_4slot.pd`
- Test: `test/unit/engine_patch.test.js`

- [x] **Step 1: Write abstraction existence tests**

Add to `test/unit/engine_patch.test.js`:

```js
test('channel abstractions expose expected looper slots and monitor gate', () => {
    const channel2 = fs.readFileSync(path.join(__dirname, '../../src/channel_2slot.pd'), 'utf8');
    const channel4 = fs.readFileSync(path.join(__dirname, '../../src/channel_4slot.pd'), 'utf8');

    assert.match(channel2, /looper_slot \\$1/);
    assert.match(channel2, /looper_slot \\$2/);
    assert.match(channel2, /route \\$1 \\$2 monitor/);
    assert.match(channel2, /line~/);

    assert.match(channel4, /looper_slot \\$1/);
    assert.match(channel4, /looper_slot \\$2/);
    assert.match(channel4, /looper_slot \\$3/);
    assert.match(channel4, /looper_slot \\$4/);
    assert.match(channel4, /route \\$1 \\$2 \\$3 \\$4 monitor/);
});
```

- [x] **Step 2: Run tests and confirm failure**

Run:

```bash
npm run test:unit -- test/unit/engine_patch.test.js
```

Expected: FAIL because the new Pd files do not exist.

- [x] **Step 3: Create `channel_2slot.pd` in the Pd GUI**

Use the Pd GUI to create the abstraction rather than hand-editing connection-heavy patch text. The contract must be:

```text
inlet~ left
inlet~ right
inlet slot-control
inlet monitor-control
outlet~ left
outlet~ right
outlet state
```

Object layout:

```pd
[inlet~] [inlet~] [inlet] [inlet]
                  |
              [route $1 $2 monitor]
             /          \
[looper_slot $1]     [looper_slot $2]
       |   |   \        /   |   |
       +~  +~   state  state
        \   \          /
         [outlet~] [outlet~] [outlet]

dry input -> [*~ 0.8] -> [*~] controlled by [line~] -> summed into outlets
```

Saved patch text must contain:

```pd
route \$1 \$2 monitor
looper_slot \$1
looper_slot \$2
line~
```

Do not add monitor audio per slot. Add exactly one dry stereo monitor path per channel abstraction.

- [x] **Step 4: Create `channel_4slot.pd` in the Pd GUI**

Use the same contract as `channel_2slot.pd`, but route `$1` through `$4` and sum four slot outputs into one stereo channel output.

Saved patch text must contain:

```pd
route \$1 \$2 \$3 \$4 monitor
looper_slot \$1
looper_slot \$2
looper_slot \$3
looper_slot \$4
line~
```

- [x] **Step 5: Run patch structure tests**

Run:

```bash
npm run test:unit -- test/unit/engine_patch.test.js
```

Expected: PASS.

- [x] **Step 6: Run managed engine smoke test for 1 channel / 2 slots**

Run:

```bash
./start.sh audio-device=MAC midi-device=WEB channels=1 slots-per-channel=2
```

In another terminal:

```bash
npm run test:engine
```

Expected: current `slot1` and `slot2` integration tests pass.

Verified 2026-05-18:
- `npm run test:engine` passed with 41 passed, 0 failed after restarting Pd against generated `.runtime/engine.pd`.
- Smoke exposed a `setLength`/`cropStart` regression in `looper_slot.pd`; fixed by giving `setLength` a side-effect-free start-offset memory and covering it in `test/unit/looper_slot_patch.test.js`.

- [ ] **Step 7: Commit**

```bash
git add src/channel_2slot.pd src/channel_4slot.pd test/unit/engine_patch.test.js
git commit -m "feat: add reusable channel abstractions"
```

---

### Task 5: Make Controller Channel-Aware

**Files:**
- Modify: `src/controller/slot_controller.js`
- Test: `test/unit/slot_controller.test.js`

- [x] **Step 1: Add failing channel monitor tests**

Add to `test/unit/slot_controller.test.js`:

```js
test('controller creates slots from topology metadata', () => {
    const controller = createController({
        transport: createTransport(),
        slots: [
            { id: 1, name: 'slot1', channelId: 1, indexInChannel: 1 },
            { id: 2, name: 'slot2', channelId: 1, indexInChannel: 2 },
            { id: 3, name: 'slot3', channelId: 2, indexInChannel: 1 },
            { id: 4, name: 'slot4', channelId: 2, indexInChannel: 2 },
        ],
    });

    assert.equal(controller.getState().slots.length, 4);
    assert.equal(controller.getState().slots[2].channelId, 2);
    assert.equal(controller.getState().channels.length, 2);
});

test('monitor state is independent per channel', async () => {
    const transport = createTransport();
    const controller = createController({
        transport,
        slots: [
            { id: 1, name: 'slot1', channelId: 1, indexInChannel: 1 },
            { id: 2, name: 'slot2', channelId: 1, indexInChannel: 2 },
            { id: 3, name: 'slot3', channelId: 2, indexInChannel: 1 },
            { id: 4, name: 'slot4', channelId: 2, indexInChannel: 2 },
        ],
    });

    controller.applyPdState(['slot3', 'length', 1000]);
    controller.applyPdState(['slot3', 'playing']);
    await controller.updateMonitorState();

    assert.deepEqual(
        transport.commands.slice(-2),
        [['/monitor1', 1], ['/monitor2', 0]]
    );
    assert.equal(controller.getState().channels[0].monitorActive, true);
    assert.equal(controller.getState().channels[1].monitorActive, false);
});
```

- [x] **Step 2: Run tests and confirm failure**

Run:

```bash
npm run test:unit -- test/unit/slot_controller.test.js
```

Expected: FAIL because slots are numeric IDs only and monitor is global.

- [x] **Step 3: Update slot creation**

In `src/controller/slot_controller.js`, change `createSlot` to accept metadata:

```js
function createSlot(slotConfig) {
    const id = typeof slotConfig === 'number' ? slotConfig : slotConfig.id;
    return {
        id,
        name: slotConfig.name || `slot${id}`,
        channelId: slotConfig.channelId || 1,
        indexInChannel: slotConfig.indexInChannel || id,
        state: SlotState.EMPTY,
        recordStartTime: 0,
        lengthMs: 0,
        originalLengthMs: 0,
        cropOffset: 0,
        startCropOffset: 0,
        pendingDelta: 0,
        pendingStartDelta: 0,
        pendingMoveDelta: 0,
        updateTimer: null,
        startUpdateTimer: null,
        moveUpdateTimer: null,
        autoStartTimer: null,
        autoStopTimer: null,
        pendingAutoRecord: null,
    };
}
```

Keep:

```js
this.slots = (options.slots || [1, 2]).map(createSlot);
```

- [x] **Step 4: Add channel monitor state helpers**

Add methods:

```js
getChannelIds() {
    return [...new Set(this.slots.map((slot) => slot.channelId))].sort((a, b) => a - b);
}

isChannelMonitorActive(channelId) {
    const anyPlaying = this.slots.some((slot) =>
        slot.channelId === channelId && slot.state === SlotState.PLAYING
    );
    return this.monitorEnabled && !anyPlaying;
}
```

Update `getState()` to include `channelId` and `indexInChannel` per slot and a `channels` array:

```js
channels: this.getChannelIds().map((channelId) => ({
    id: channelId,
    monitorEnabled: this.monitorEnabled,
    monitorActive: this.isChannelMonitorActive(channelId),
})),
```

- [x] **Step 5: Update monitor sends**

Replace `updateMonitorState()` with:

```js
async updateMonitorState() {
    for (const channelId of this.getChannelIds()) {
        const active = this.isChannelMonitorActive(channelId);
        await this.send(`/monitor${channelId}`, active ? 1 : 0);
    }
    this.monitorActive = this.getChannelIds().every((channelId) => this.isChannelMonitorActive(channelId));
}
```

Replace `refreshMonitorActive()` with:

```js
refreshMonitorActive() {
    this.monitorActive = this.getChannelIds().every((channelId) => this.isChannelMonitorActive(channelId));
}
```

For backward compatibility with old tests, either update tests from `/monitor` to `/monitor1`, or temporarily send both `/monitor1` and `/monitor` only when there is one channel. Prefer updating tests.

- [x] **Step 6: Run tests**

Run:

```bash
npm run test:unit -- test/unit/slot_controller.test.js
```

Expected: PASS after updating old monitor expectations from `/monitor` to `/monitor1`.

- [ ] **Step 7: Commit**

```bash
git add src/controller/slot_controller.js test/unit/slot_controller.test.js
git commit -m "feat: make monitor state channel aware"
```

---

### Task 6: Pass Runtime Slots Into Controller

**Files:**
- Modify: `src/index.js`
- Modify: `src/dev_controller.js`
- Test: `test/unit/slot_controller.test.js`

- [x] **Step 1: Add construction assertions if needed**

If there is no direct test for `createController` options in web/dev setup, add a unit test around `createController` only:

```js
test('controller defaults preserve legacy two slot topology', () => {
    const controller = createController({ transport: createTransport() });

    assert.deepEqual(
        controller.getState().slots.map((slot) => ({ id: slot.id, channelId: slot.channelId })),
        [{ id: 1, channelId: 1 }, { id: 2, channelId: 1 }]
    );
});
```

- [x] **Step 2: Update controller construction**

In `src/index.js`, pass:

```js
slots: runtimeConfig.slots,
```

into `createController`.

In `src/dev_controller.js`, pass the same:

```js
slots: runtimeConfig.slots,
```

- [x] **Step 3: Run tests**

Run:

```bash
npm run test:unit
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/index.js src/dev_controller.js test/unit/slot_controller.test.js
git commit -m "feat: initialize controller from runtime slots"
```

---

### Task 7: Normalize MIDI Slot Controls

**Files:**
- Modify: `src/config.js`
- Modify: `config/midi/web.json`
- Modify: `config/midi/osc.json`
- Modify: `config/midi/xone-px5.json`
- Modify: `config/midi/traktor-x1mk3.json`
- Test: `test/unit/config.test.js`

- [x] **Step 1: Add failing MIDI normalization test**

In `test/unit/config.test.js`, add:

```js
test('MIDI configs can define dynamic slot control map', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slooper-midi-slots-'));
    const file = path.join(dir, 'slots.json');
    fs.writeFileSync(file, JSON.stringify({
        name: 'Slots',
        match: 'Slots',
        controls: {
            monitorButton: { type: 'note', note: 5, channel: 0 },
            slots: {
                slot1: {
                    button: { type: 'note', note: 1, channel: 0 },
                    endEncoder: { type: 'cc', controller: 10, channel: 0, mode: 'relative-64' },
                    reset: { type: 'note', note: 20, channel: 0 }
                },
                slot4: {
                    button: { type: 'note', note: 4, channel: 0 },
                    endEncoder: { type: 'cc', controller: 13, channel: 0, mode: 'relative-64' },
                    reset: { type: 'note', note: 23, channel: 0 }
                }
            }
        }
    }));

    const config = getRuntimeConfig({
        audioDevice: 'MAC',
        midiConfigPath: file,
        platform: 'darwin',
        projectRoot: path.join(__dirname, '../..'),
        channels: 2,
        slotsPerChannel: 2,
    });

    assert.equal(config.midi.slots.slot1.note, 1);
    assert.equal(config.midi.slots.slot4.encoderCC, 13);
    assert.equal(config.midi.slot1.note, 1);
});
```

- [x] **Step 2: Run tests and confirm failure**

Run:

```bash
npm run test:unit -- test/unit/config.test.js
```

Expected: FAIL because `controls.slots` is not normalized.

- [x] **Step 3: Add slot-control normalization helper**

In `src/config.js`, add:

```js
function normalizeSlotControl(control = {}) {
    return {
        note: control.button && control.button.note,
        channel: control.button && control.button.channel,
        encoderCC: control.endEncoder && control.endEncoder.controller,
        encoderChannel: control.endEncoder && control.endEncoder.channel,
        encoderMode: control.endEncoder && control.endEncoder.mode,
        startEncoderCC: control.startEncoder && control.startEncoder.controller,
        startEncoderChannel: control.startEncoder && control.startEncoder.channel,
        startEncoderMode: control.startEncoder && control.startEncoder.mode,
        moveEncoderCC: control.moveEncoder && control.moveEncoder.controller,
        moveEncoderChannel: control.moveEncoder && control.moveEncoder.channel,
        moveEncoderMode: control.moveEncoder && control.moveEncoder.mode,
        autoLoops: control.autoLoops || {},
        half: normalizeNoteControl(control.half),
        double: normalizeNoteControl(control.double),
        reset: normalizeNoteControl(control.reset),
    };
}

function normalizeLegacySlotControl(controls, slotName) {
    const prefix = slotName;
    return normalizeSlotControl({
        button: controls[`${prefix}Button`],
        endEncoder: controls[`${prefix}EndEncoder`],
        startEncoder: controls[`${prefix}StartEncoder`],
        moveEncoder: controls[`${prefix}MoveEncoder`],
        reset: controls[`${prefix}Reset`],
        half: controls[`${prefix}Half`],
        double: controls[`${prefix}Double`],
        autoLoops: normalizeAutoLoopControls(controls, prefix),
    });
}
```

In `normalizeMidiConfig`, build:

```js
const slotControls = {};
if (controls.slots) {
    for (const [slotName, control] of Object.entries(controls.slots)) {
        slotControls[slotName] = normalizeSlotControl(control);
    }
} else {
    slotControls.slot1 = normalizeLegacySlotControl(controls, 'slot1');
    slotControls.slot2 = normalizeLegacySlotControl(controls, 'slot2');
}
```

Return:

```js
slots: slotControls,
slot1: slotControls.slot1,
slot2: slotControls.slot2,
```

Keep `encoderPress1` and `encoderPress2` for compatibility:

```js
encoderPress1: slotControls.slot1 && slotControls.slot1.reset,
encoderPress2: slotControls.slot2 && slotControls.slot2.reset,
```

- [x] **Step 4: Run config tests**

Run:

```bash
npm run test:unit -- test/unit/config.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.js test/unit/config.test.js
git commit -m "feat: normalize dynamic MIDI slot controls"
```

---

### Task 8: Make MIDI Handlers Dynamic

**Files:**
- Modify: `src/index.js`
- Test: existing unit tests indirectly; add direct tests only if extracting helpers.

- [x] **Step 1: Replace hardcoded button slot list**

In `setupMidiHandlers`, replace:

```js
const buttonSlots = [
    { id: 1, note: midi.slot1.note, channel: midi.slot1.channel, holdTimer: null, actionFired: false },
    { id: 2, note: midi.slot2.note, channel: midi.slot2.channel, holdTimer: null, actionFired: false },
];
```

with:

```js
const buttonSlots = runtimeConfig.slots
    .map((slot) => {
        const control = midi.slots && midi.slots[slot.name];
        return control && control.note !== undefined
            ? { id: slot.id, note: control.note, channel: control.channel, holdTimer: null, actionFired: false }
            : null;
    })
    .filter(Boolean);
```

- [x] **Step 2: Replace auto-loop and transform lists**

Use:

```js
const autoLoopButtons = runtimeConfig.slots.flatMap((slot) => {
    const control = midi.slots && midi.slots[slot.name];
    return createAutoLoopButtons(slot.id, control ? control.autoLoops : {});
});

const transformButtons = runtimeConfig.slots.flatMap((slot) => {
    const control = midi.slots && midi.slots[slot.name];
    if (!control) return [];
    return [
        createTransformButton(slot.id, control.half, 0.5, 'Half'),
        createTransformButton(slot.id, control.double, 2, 'Double'),
    ].filter(Boolean);
});
```

- [x] **Step 3: Replace reset/encoder lookup**

Where code references `midi.slot1`, `midi.slot2`, `midi.encoderPress1`, or `midi.encoderPress2`, replace it with lookup by slot ID:

```js
function getSlotControl(id) {
    return midi.slots && midi.slots[`slot${id}`];
}
```

For end crop encoder handlers, compare against `control.encoderCC` and `control.encoderChannel`.

For start crop, compare against `control.startEncoderCC` and `control.startEncoderChannel`.

For move crop, compare against `control.moveEncoderCC` and `control.moveEncoderChannel`.

For reset, compare against `control.reset.note` and `control.reset.channel`.

- [x] **Step 4: Update console mapping**

Change mapping output from hardcoded two slots to:

```js
for (const slot of runtimeConfig.slots) {
    const control = getSlotControl(slot.id);
    if (!control) continue;
    console.log(`  ${slot.name.toUpperCase()} BUTTON : Ch${control.channel} N${control.note}`);
    console.log(`  ${slot.name.toUpperCase()} END    : Ch${control.encoderChannel} CC${control.encoderCC}`);
}
```

- [x] **Step 5: Run unit tests**

Run:

```bash
npm run test:unit
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/index.js
git commit -m "feat: drive MIDI handlers from slot topology"
```

---

### Task 9: Support Multi-Channel Audio Config And JACK Connections

**Files:**
- Modify: `src/config.js`
- Modify: `start.sh`
- Modify: `config/audio/xone-px5.json`
- Test: `test/unit/config.test.js`
- Test: `test/unit/start_script.test.js`

- [x] **Step 1: Add failing audio pair tests**

In `test/unit/config.test.js`, add:

```js
test('audio config exposes playback port pairs for multiple channels', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slooper-audio-multi-'));
    const file = path.join(dir, 'multi.json');
    fs.writeFileSync(file, JSON.stringify({
        name: 'Multi',
        mode: 'jack',
        jack: {
            cardNameIncludes: 'Multi',
            capturePortPairs: [
                { id: 'input1', label: 'Input 1', ports: ['system:capture_1', 'system:capture_2'] },
                { id: 'input2', label: 'Input 2', ports: ['system:capture_3', 'system:capture_4'] },
            ],
            playbackPortPairs: [
                { id: 'output1', label: 'Output 1', ports: ['system:playback_1', 'system:playback_2'] },
                { id: 'output2', label: 'Output 2', ports: ['system:playback_3', 'system:playback_4'] },
            ]
        },
        pd: {
            darwin: { adc: [1, 2], dac: [1, 2] },
            linux: { adc: [1, 2], dac: [1, 2] }
        }
    }));

    const config = getRuntimeConfig({
        audioConfigPath: file,
        midiDevice: 'WEB',
        platform: 'linux',
        projectRoot: path.join(__dirname, '../..'),
        channels: 2,
        slotsPerChannel: 2,
    });

    assert.deepEqual(config.audio.capturePortPairs.map((pair) => pair.ports), [
        ['system:capture_1', 'system:capture_2'],
        ['system:capture_3', 'system:capture_4'],
    ]);
    assert.deepEqual(config.audio.playbackPortPairs.map((pair) => pair.ports), [
        ['system:playback_1', 'system:playback_2'],
        ['system:playback_3', 'system:playback_4'],
    ]);
});
```

- [x] **Step 2: Run tests and confirm failure**

Run:

```bash
npm run test:unit -- test/unit/config.test.js
```

Expected: FAIL because playback port pairs are not normalized.

- [x] **Step 3: Add playback pair normalization**

In `src/config.js`, add:

```js
function normalizePlaybackOutput(output, index) {
    if (!output || typeof output !== 'object') {
        throw new Error(`Invalid JACK playbackPortPairs entry at index ${index}`);
    }
    if (!output.id) {
        throw new Error(`Missing JACK playback output id at index ${index}`);
    }
    if (!isPair(output.ports)) {
        throw new Error(`Missing JACK playback output ports for ${output.id}`);
    }
    return {
        id: output.id,
        label: output.label || output.id,
        ports: output.ports,
    };
}

function normalizePlaybackOutputs(jack) {
    if (Array.isArray(jack.playbackPortPairs)) {
        if (jack.playbackPortPairs.length === 0) {
            throw new Error('Missing JACK playbackPortPairs');
        }
        return jack.playbackPortPairs.map(normalizePlaybackOutput);
    }

    if (!isPair(jack.playbackPorts)) {
        throw new Error('Missing JACK playbackPorts');
    }

    return [{
        id: 'playback-1',
        label: 'Playback 1',
        ports: jack.playbackPorts,
    }];
}
```

Include normalized values in audio config:

```js
const capturePortPairs = normalizeCaptureSources(raw.jack);
const playbackPortPairs = normalizePlaybackOutputs(raw.jack);
```

Return both `capturePortPairs` and `playbackPortPairs`, preserving legacy `capturePorts` and `playbackPorts` as the first pair:

```js
capturePortPairs,
playbackPortPairs,
capturePorts: capturePortPairs[0].ports,
playbackPorts: playbackPortPairs[0].ports,
```

- [x] **Step 4: Render shell config arrays**

In `renderShellConfig`, add:

```js
JACK_CAPTURE_PORT_PAIRS: config.audio.capturePortPairs.map((pair) => pair.ports.join(',')).join(';'),
JACK_PLAYBACK_PORT_PAIRS: config.audio.playbackPortPairs.map((pair) => pair.ports.join(',')).join(';'),
CHANNELS: config.topology.channels,
SLOTS_PER_CHANNEL: config.topology.slotsPerChannel,
```

- [x] **Step 5: Update `start.sh` JACK connection loop**

Replace the single connect block with:

```bash
IFS=';' read -r -a CAPTURE_PAIRS <<< "$JACK_CAPTURE_PORT_PAIRS"
IFS=';' read -r -a PLAYBACK_PAIRS <<< "$JACK_PLAYBACK_PORT_PAIRS"

for ((i = 0; i < CHANNELS; i++)); do
    IFS=',' read -r CAPTURE_LEFT CAPTURE_RIGHT <<< "${CAPTURE_PAIRS[$i]}"
    IFS=',' read -r PLAYBACK_LEFT PLAYBACK_RIGHT <<< "${PLAYBACK_PAIRS[$i]}"
    PD_IN_LEFT="pure_data:input_$((i * 2 + 1))"
    PD_IN_RIGHT="pure_data:input_$((i * 2 + 2))"
    PD_OUT_LEFT="pure_data:output_$((i * 2 + 1))"
    PD_OUT_RIGHT="pure_data:output_$((i * 2 + 2))"

    jack_connect "$CAPTURE_LEFT" "$PD_IN_LEFT" || echo "   Warning: could not connect $CAPTURE_LEFT to $PD_IN_LEFT"
    jack_connect "$CAPTURE_RIGHT" "$PD_IN_RIGHT" || echo "   Warning: could not connect $CAPTURE_RIGHT to $PD_IN_RIGHT"
    jack_connect "$PD_OUT_LEFT" "$PLAYBACK_LEFT" || echo "   Warning: could not connect $PD_OUT_LEFT to $PLAYBACK_LEFT"
    jack_connect "$PD_OUT_RIGHT" "$PLAYBACK_RIGHT" || echo "   Warning: could not connect $PD_OUT_RIGHT to $PLAYBACK_RIGHT"
done
```

- [x] **Step 6: Run tests**

Run:

```bash
npm run test:unit -- test/unit/config.test.js test/unit/start_script.test.js
```

Expected: PASS after updating old source assertions to the looped JACK behavior.

- [x] **Step 7: Commit**

```bash
git add src/config.js start.sh config/audio/xone-px5.json test/unit/config.test.js test/unit/start_script.test.js
git commit -m "feat: support multi-channel jack routing"
```

---

### Task 10: Update Web Controller For Dynamic Slots

**Files:**
- Modify: `src/dev_controller.js`
- Modify: any embedded HTML/CSS/JS template used by the web controller
- Test: `test/unit/dev_controller_html.test.js`
- Test: `test/unit/web_server.test.js`

- [x] **Step 1: Add failing HTML tests**

In `test/unit/dev_controller_html.test.js`, add source-level checks for dynamic rendering:

```js
test('dev controller renders slots from state instead of fixed slot buttons', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../src/dev_controller.js'), 'utf8');

    assert.match(html, /state\.slots\.map/);
    assert.match(html, /slot\.channelId/);
    assert.doesNotMatch(html, /slot1Button[\s\S]*slot2Button/);
});
```

- [x] **Step 2: Run tests and confirm failure**

Run:

```bash
npm run test:unit -- test/unit/dev_controller_html.test.js
```

Expected: FAIL if the current UI is fixed to two slots.

- [x] **Step 3: Render slots grouped by channel**

In the browser JS template, derive:

```js
function groupSlotsByChannel(slots) {
    return slots.reduce((groups, slot) => {
        const key = String(slot.channelId || 1);
        groups[key] = groups[key] || [];
        groups[key].push(slot);
        return groups;
    }, {});
}
```

Render:

```js
const groups = groupSlotsByChannel(state.slots || []);
channelsContainer.innerHTML = Object.entries(groups).map(([channelId, slots]) => `
    <section class="channel">
        <h2>Channel ${channelId}</h2>
        <div class="slots">
            ${slots.map(renderSlot).join('')}
        </div>
    </section>
`).join('');
```

Make each slot button call the existing action endpoint with the dynamic ID:

```html
<button data-action="tap" data-slot="${slot.id}">${slot.name || `Slot ${slot.id}`}</button>
```

- [x] **Step 4: Run tests**

Run:

```bash
npm run test:unit -- test/unit/dev_controller_html.test.js test/unit/web_server.test.js
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/dev_controller.js test/unit/dev_controller_html.test.js test/unit/web_server.test.js
git commit -m "feat: render web controller from slot topology"
```

---

### Task 11: Expand Engine Integration Tests

**Files:**
- Modify: `test/test_engine.js`
- Modify: `test/run_engine_tests.js`

- [ ] **Step 1: Add multi-slot OSC test**

In `test/test_engine.js`, add:

```js
test('topology slots beyond slot2 respond independently', async () => {
    await sendOSC('/slot3', 'rec', 1);
    await expectState('slot3', 'recording');
    await wait(150);
    await sendOSC('/slot3', 'rec', 0);
    await expectState('slot3', 'stopped');
    await expectState('slot3', 'length');

    await sendOSC('/slot4', 'rec', 1);
    await expectState('slot4', 'recording');
    await wait(150);
    await sendOSC('/slot4', 'rec', 0);
    await expectState('slot4', 'stopped');
    await expectState('slot4', 'length');

    assert.ok(getLastLength('slot3') > 0);
    assert.ok(getLastLength('slot4') > 0);
});
```

- [ ] **Step 2: Update managed runner topology**

In `test/run_engine_tests.js`, make the managed Pd process start with a 2-channel/2-slot topology:

```js
const args = [
    './start.sh',
    'audio-device=MAC',
    'midi-device=WEB',
    'channels=2',
    'slots-per-channel=2',
];
```

If the runner starts Pd directly, update its config call to pass `channels: 2` and `slotsPerChannel: 2`.

- [ ] **Step 3: Run managed engine tests**

Run:

```bash
npm run test:engine:managed
```

Expected: PASS. If Pd is not installed in the environment, record that as a local verification blocker and run unit tests instead.

- [ ] **Step 4: Commit**

```bash
git add test/test_engine.js test/run_engine_tests.js
git commit -m "test: cover generated multi-channel engine topology"
```

---

### Task 12: Documentation And Final Verification

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md` if present as a repo file

- [ ] **Step 1: Update README startup examples**

Add:

```markdown
## Runtime topology

Slooper can start with a configurable number of stereo channels and slots per channel:

```bash
./start.sh channels=1 slots-per-channel=2
./start.sh channels=2 slots-per-channel=4
./start.sh channels=3 slots-per-channel=2
```

Slots are named globally. With `channels=2 slots-per-channel=4`, channel 1 owns `slot1`-`slot4`, and channel 2 owns `slot5`-`slot8`.

Each channel has one dry monitor path. Any playing slot in a channel mutes that channel's dry monitor only; other channels remain independent.
```

- [ ] **Step 2: Update architecture docs**

Replace the old two-slot engine description with:

```markdown
engine.pd is generated at startup into `.runtime/engine.pd`.
It hosts one `[channel_2slot ...]` or `[channel_4slot ...]` abstraction per configured stereo channel.
`looper_slot.pd` remains the per-slot DSP engine.
```

- [ ] **Step 3: Run full unit suite**

Run:

```bash
npm run test:unit
```

Expected: PASS.

- [ ] **Step 4: Run engine suite**

Run:

```bash
npm run test:engine:managed
```

Expected: PASS on a machine with Pd available.

- [ ] **Step 5: Manual hardware smoke test**

On the Pi/XONE setup:

```bash
./start.sh audio-device=XONE midi-device=X1MK3 channels=2 slots-per-channel=2
```

Verify:

- Capture pair 1 records into `slot1` and `slot2`.
- Capture pair 2 records into `slot3` and `slot4`.
- `slot1`/`slot2` return only on playback pair 1.
- `slot3`/`slot4` return only on playback pair 2.
- Playing `slot1` mutes only channel 1 dry monitor.
- Playing `slot3` mutes only channel 2 dry monitor.
- `slot1` and `slot3` can play simultaneously.

- [ ] **Step 6: Commit**

```bash
git add README.md AGENTS.md
git commit -m "docs: document configurable channel topology"
```

---

## Execution Notes

- Use the Pd GUI for `channel_2slot.pd` and `channel_4slot.pd` wiring. Avoid large hand-edited Pd connection rewrites.
- Keep `looper_slot.pd` unchanged unless a test proves its abstraction contract is insufficient.
- Prefer generated top-level `engine.pd` over dynamic Pd object creation.
- Keep one dry monitor path per channel. Do not add monitor output per slot.
- Preserve legacy `channels=1 slots-per-channel=2` behavior throughout the work.

## Self-Review

- Spec coverage: The plan covers configurable channel count, configurable slots per channel, independent output pairs, channel-local monitor muting, Node slot state, MIDI routing, web routing, JACK routing, docs, and tests.
- Placeholder scan: No placeholder markers or unspecified implementation steps remain.
- Type consistency: The plan consistently uses `topology.channels`, `topology.slotsPerChannel`, `config.slots`, `slot.channelId`, `slot.indexInChannel`, `/monitorN`, and flat OSC slot names.
