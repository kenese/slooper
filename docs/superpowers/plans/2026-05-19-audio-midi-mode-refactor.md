# Audio and MIDI Mode Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explicit Send/Channel audio routing modes and Simple/Custom MIDI surface modes while preserving current behavior.

**Architecture:** Audio config gains a normalized looper routing mode separate from JACK/native-Pd backend mode. MIDI mode is independent from audio routing mode, so Send/Channel and Simple/Custom combinations are valid unless a specific surface rejects an incompatible topology. MIDI handling moves behind swappable surface modules, with Simple mode containing the current behavior and the initial X1MK3 custom surface delegating to Simple mode.

**Tech Stack:** Node.js CommonJS, `node:test`, `easymidi`, Pure Data generated host patch.

---

## File Structure

- Modify `src/config.js`: normalize and validate `audio.routingMode`, `midi.midiMode`, and `midi.surface`; keep existing aliases working.
- Modify `scripts/runtime_config.js`: parse optional `audio-mode=` and `midi-mode=` CLI arguments if used by `start.sh`.
- Modify `start.sh`: expose explicit mode labels and forward mode arguments into runtime config.
- Create `src/controller/midi_surfaces/index.js`: load the selected MIDI surface module.
- Create `src/controller/midi_surfaces/simple_surface.js`: own the current inline MIDI mapping/event/LED behavior.
- Create `src/controller/midi_surfaces/x1mk3_2channel_surface.js`: custom surface placeholder that delegates to Simple mode.
- Modify `src/index.js`: open MIDI devices and delegate setup to the selected surface.
- Modify `config/audio/*.json`: add explicit `routingMode`.
- Modify `config/midi/*.json`: add explicit `midiMode` and `surface` where applicable.
- Modify `test/unit/config.test.js`: add audio and MIDI mode normalization/validation coverage.
- Create `test/unit/midi_surfaces.test.js`: cover surface resolution.
- Modify `test/unit/start_script.test.js`: update expected mode-label behavior.
- Modify `README.md`: document Send Mode, Channel Mode, Simple MIDI Mode, and Custom MIDI Mode.

---

### Task 1: Normalize Explicit Audio Routing Mode

**Files:**
- Modify: `src/config.js`
- Test: `test/unit/config.test.js`

- [ ] **Step 1: Write failing config tests**

Add these tests to `test/unit/config.test.js` after the existing audio topology tests:

```js
test('audio config exposes explicit send routing mode', () => {
    const config = getRuntimeConfig({
        audioDevice: 'Z1',
        midiDevice: 'WEB',
        platform: 'linux',
        projectRoot: path.join(__dirname, '../..'),
    });

    assert.equal(config.audio.routingMode, 'send');
    assert.equal(config.topology.channels, 1);
});

test('audio config exposes explicit channel routing mode with one channel', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slooper-audio-channel-one-'));
    const file = path.join(dir, 'channel-one.json');
    fs.writeFileSync(file, JSON.stringify({
        name: 'Channel One',
        mode: 'native-pd',
        routingMode: 'channel',
        pd: {
            darwin: { adc: [1, 2], dac: [1, 2] },
            linux: { adc: [1, 2], dac: [1, 2] },
        },
    }));

    const config = getRuntimeConfig({
        audioConfigPath: file,
        midiDevice: 'WEB',
        platform: 'darwin',
        projectRoot: path.join(__dirname, '../..'),
        channels: 1,
    });

    assert.equal(config.audio.routingMode, 'channel');
    assert.equal(config.topology.channels, 1);
});

test('send routing mode rejects multiple playback channel pairs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slooper-audio-bad-send-'));
    const file = path.join(dir, 'bad-send.json');
    fs.writeFileSync(file, JSON.stringify({
        name: 'Bad Send',
        mode: 'jack',
        routingMode: 'send',
        jack: {
            cardNameIncludes: 'Bad',
            capturePorts: ['system:capture_1', 'system:capture_2'],
            playbackPortPairs: [
                { id: 'out1', ports: ['system:playback_1', 'system:playback_2'] },
                { id: 'out2', ports: ['system:playback_3', 'system:playback_4'] },
            ],
        },
        pd: {
            darwin: { adc: [1, 2], dac: [1, 2] },
            linux: { adc: [1, 2], dac: [1, 2] },
        },
    }));

    assert.throws(
        () => getRuntimeConfig({
            audioConfigPath: file,
            midiDevice: 'WEB',
            platform: 'linux',
            projectRoot: path.join(__dirname, '../..'),
        }),
        /send routing mode must expose exactly one playback pair/
    );
});

test('channel routing mode rejects insufficient JACK capture pairs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slooper-audio-bad-channel-'));
    const file = path.join(dir, 'bad-channel.json');
    fs.writeFileSync(file, JSON.stringify({
        name: 'Bad Channel',
        mode: 'jack',
        routingMode: 'channel',
        jack: {
            cardNameIncludes: 'Bad',
            capturePortPairs: [
                { id: 'in1', ports: ['system:capture_1', 'system:capture_2'] },
            ],
            playbackPortPairs: [
                { id: 'out1', ports: ['system:playback_1', 'system:playback_2'] },
            ],
        },
        pd: {
            darwin: { adc: [1, 2], dac: [1, 2] },
            linux: { adc: [1, 2], dac: [1, 2] },
        },
    }));

    assert.throws(
        () => getRuntimeConfig({
            audioConfigPath: file,
            midiDevice: 'WEB',
            platform: 'linux',
            projectRoot: path.join(__dirname, '../..'),
            channels: 2,
        }),
        /channel routing mode requires at least 2 capture pairs/
    );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test test/unit/config.test.js
```

Expected: FAIL because `config.audio.routingMode` and the new validation errors do not exist yet.

- [ ] **Step 3: Implement audio routing mode normalization**

In `src/config.js`, add these helpers near the audio normalization helpers:

```js
function inferRoutingMode(raw, topology) {
    if (raw.routingMode) return raw.routingMode;
    if (topology.channels > 1) return 'channel';
    if (raw.mode === 'native-pd') return 'channel';
    if (raw.jack && Array.isArray(raw.jack.playbackPortPairs) && raw.jack.playbackPortPairs.length > 1) return 'channel';
    return 'send';
}

function normalizeRoutingMode(raw, topology) {
    const routingMode = inferRoutingMode(raw, topology);
    if (!['send', 'channel'].includes(routingMode)) {
        throw new Error(`Unsupported audio routingMode: ${routingMode}`);
    }
    return routingMode;
}

function validateAudioRoutingMode(raw, routingMode, topology) {
    if (routingMode === 'send') {
        const jack = raw.jack || {};
        if (Array.isArray(jack.playbackPortPairs) && jack.playbackPortPairs.length !== 1) {
            throw new Error('send routing mode must expose exactly one playback pair');
        }
        if (topology.channels !== 1) {
            throw new Error('send routing mode requires channels=1');
        }
        return;
    }

    if (routingMode === 'channel' && raw.mode === 'jack') {
        const capturePairs = normalizeCaptureSources(raw.jack || {});
        const playbackPairs = normalizePlaybackOutputs(raw.jack || {});
        if (capturePairs.length < topology.channels) {
            throw new Error(`channel routing mode requires at least ${topology.channels} capture pairs`);
        }
        if (playbackPairs.length < topology.channels) {
            throw new Error(`channel routing mode requires at least ${topology.channels} playback pairs`);
        }
    }
}
```

Change `getRuntimeConfig()` so topology is normalized before audio normalization:

```js
const topology = normalizeTopology(options);
const audio = normalizeAudioConfig(loadJsonFile(audioConfigPath), topology);
```

Change `normalizeAudioConfig(raw)` to accept topology, compute routing mode, validate it, and return it:

```js
function normalizeAudioConfig(raw, topology = normalizeTopology()) {
    validateAudioConfig(raw);

    const routingMode = normalizeRoutingMode(raw, topology);
    validateAudioRoutingMode(raw, routingMode, topology);

    const jack = raw.jack || {};
    const pd = raw.pd || {};
    const usesJack = raw.mode === 'jack' || !raw.mode;
    const capturePortPairs = usesJack ? normalizeCaptureSources(jack) : [];
    const playbackPortPairs = usesJack ? normalizePlaybackOutputs(jack) : [];

    return {
        name: raw.name,
        mode: raw.mode || 'jack',
        routingMode,
        jackCardNameIncludes: jack.cardNameIncludes || '',
        capturePortPairs,
        playbackPortPairs,
        capturePorts: capturePortPairs[0] ? capturePortPairs[0].ports : [],
        captureSources: capturePortPairs,
        playbackPorts: playbackPortPairs[0] ? playbackPortPairs[0].ports : [],
        macPdChannels: pd.darwin || { adc: [1, 2], dac: [1, 2] },
        macPdSources: normalizeMacPdSources(pd),
        linuxPdChannels: pd.linux || { adc: [1, 2], dac: [1, 2] },
        jack: {
            sampleRate: jack.sampleRate,
            periodSize: jack.periodSize,
            periods: jack.periods,
        },
    };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
node --test test/unit/config.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.js test/unit/config.test.js
git commit -m "feat: add explicit audio routing modes"
```

---

### Task 2: Update Audio Config Files And Startup Labels

**Files:**
- Modify: `config/audio/blackhole-mac.json`
- Modify: `config/audio/generic-jack-1-2.json`
- Modify: `config/audio/traktor-z1.json`
- Modify: `config/audio/xone-px5.json`
- Modify: `config/audio/xone-px5-2channel.json`
- Modify: `src/config.js`
- Modify: `start.sh`
- Test: `test/unit/start_script.test.js`
- Test: `test/unit/config.test.js`

- [ ] **Step 1: Write failing startup label tests**

Update `test/unit/start_script.test.js` by replacing the selected channel mode test with:

```js
test('start.sh prints selected explicit audio routing mode in green', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../start.sh'), 'utf8');

    assert.match(source, /runtime_mode_label\(\)/);
    assert.match(source, /echo "Send Mode"/);
    assert.match(source, /echo "Channel Mode \(1 channel\)"/);
    assert.match(source, /echo "Channel Mode \(\$CHANNELS channels\)"/);
    assert.match(source, /log_success "\$\(runtime_mode_label\)"/);
});
```

Add this separate test so the expectation is tied to an explicit channel audio alias rather than the default audio device:

```js
test('start.sh --print-config reports explicit channel routing mode', () => {
    const output = execFileSync('bash', [
        'start.sh',
        '--print-config',
        'audio-device=XONE_2C',
        'midi-device=X1MK3_2C',
        'channels=2',
        'slots-per-channel=2',
    ], {
        cwd: projectRoot,
        encoding: 'utf8',
    });
    const config = JSON.parse(output);

    assert.equal(config.audio.routingMode, 'channel');
    assert.equal(config.topology.channels, 2);
});
```

- [ ] **Step 2: Add explicit `routingMode` to audio config JSON**

Set the current configs to preserve existing behavior:

```json
"routingMode": "channel"
```

for `config/audio/blackhole-mac.json`, `config/audio/xone-px5-2channel.json`, and any multi-channel insert config.

Use:

```json
"routingMode": "send"
```

for `config/audio/traktor-z1.json`, `config/audio/generic-jack-1-2.json`, and send/return configs.

For `config/audio/xone-px5.json`, choose the current intended default. If it is currently used as the send/return setup from PX5 USB channels 9/10 to playback 1/2, set it to `send`.

- [ ] **Step 3: Expose routing mode in shell config**

In `src/config.js`, add this entry to `renderShellConfig()`:

```js
AUDIO_ROUTING_MODE: config.audio.routingMode,
```

- [ ] **Step 4: Update `start.sh` label logic**

Change `runtime_mode_label()` in `start.sh` to use `AUDIO_ROUTING_MODE`:

```bash
runtime_mode_label() {
    if [ "$AUDIO_ROUTING_MODE" = "send" ]; then
        echo "Send Mode"
    elif [ "$CHANNELS" = "1" ]; then
        echo "Channel Mode (1 channel)"
    else
        echo "Channel Mode ($CHANNELS channels)"
    fi
}
```

- [ ] **Step 5: Run tests**

Run:

```bash
node --test test/unit/config.test.js test/unit/start_script.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add config/audio src/config.js start.sh test/unit/config.test.js test/unit/start_script.test.js
git commit -m "chore: name send and channel audio modes"
```

---

### Task 3: Add MIDI Surface Loader

**Files:**
- Create: `src/controller/midi_surfaces/index.js`
- Create: `src/controller/midi_surfaces/simple_surface.js`
- Create: `src/controller/midi_surfaces/x1mk3_2channel_surface.js`
- Modify: `src/config.js`
- Test: `test/unit/config.test.js`
- Test: `test/unit/midi_surfaces.test.js`

- [ ] **Step 1: Write failing MIDI config tests**

Add these tests to `test/unit/config.test.js` near the existing MIDI config tests:

```js
test('MIDI configs default to simple MIDI mode and surface', () => {
    const config = getRuntimeConfig({
        midiDevice: 'XONE',
        audioDevice: 'XONE',
        platform: 'linux',
        projectRoot: path.join(__dirname, '../..'),
    });

    assert.equal(config.midi.midiMode, 'simple');
    assert.equal(config.midi.surface, 'simple');
});

test('MIDI config can select custom surface mode', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slooper-midi-custom-'));
    const file = path.join(dir, 'custom.json');
    fs.writeFileSync(file, JSON.stringify({
        name: 'Custom X1',
        match: 'TRAKTOR X1 MK3',
        midiMode: 'custom',
        surface: 'x1mk3-2channel',
        controls: {
            slot1Button: { type: 'note', note: 1, channel: 0 },
            slot2Button: { type: 'note', note: 2, channel: 0 },
            slot1EndEncoder: { type: 'cc', controller: 10, channel: 0, mode: 'relative-64' },
            slot2EndEncoder: { type: 'cc', controller: 11, channel: 0, mode: 'relative-64' },
            slot1Reset: { type: 'note', note: 3, channel: 0 },
            slot2Reset: { type: 'note', note: 4, channel: 0 },
            monitorButton: { type: 'note', note: 5, channel: 0 }
        }
    }));

    const config = getRuntimeConfig({
        midiConfigPath: file,
        audioDevice: 'MAC',
        platform: 'darwin',
        projectRoot: path.join(__dirname, '../..'),
    });

    assert.equal(config.midi.midiMode, 'custom');
    assert.equal(config.midi.surface, 'x1mk3-2channel');
});

test('custom MIDI mode can be used with send routing mode', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slooper-midi-custom-send-'));
    const file = path.join(dir, 'custom-send.json');
    fs.writeFileSync(file, JSON.stringify({
        name: 'Custom Send X1',
        match: 'TRAKTOR X1 MK3',
        midiMode: 'custom',
        surface: 'x1mk3-2channel',
        controls: {
            slot1Button: { type: 'note', note: 1, channel: 0 },
            slot2Button: { type: 'note', note: 2, channel: 0 },
            slot1EndEncoder: { type: 'cc', controller: 10, channel: 0, mode: 'relative-64' },
            slot2EndEncoder: { type: 'cc', controller: 11, channel: 0, mode: 'relative-64' },
            slot1Reset: { type: 'note', note: 3, channel: 0 },
            slot2Reset: { type: 'note', note: 4, channel: 0 },
            monitorButton: { type: 'note', note: 5, channel: 0 }
        }
    }));

    const config = getRuntimeConfig({
        midiConfigPath: file,
        audioDevice: 'Z1',
        platform: 'linux',
        projectRoot: path.join(__dirname, '../..'),
        channels: 1,
    });

    assert.equal(config.audio.routingMode, 'send');
    assert.equal(config.midi.midiMode, 'custom');
    assert.equal(config.midi.surface, 'x1mk3-2channel');
});
```

- [ ] **Step 2: Write failing surface loader tests**

Create `test/unit/midi_surfaces.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const { loadMidiSurface } = require('../../src/controller/midi_surfaces');

test('loads simple MIDI surface', () => {
    const surface = loadMidiSurface({ midiMode: 'simple', surface: 'simple' });

    assert.equal(typeof surface.setup, 'function');
    assert.equal(surface.name, 'simple');
});

test('loads custom X1MK3 2-channel MIDI surface', () => {
    const surface = loadMidiSurface({ midiMode: 'custom', surface: 'x1mk3-2channel' });

    assert.equal(typeof surface.setup, 'function');
    assert.equal(surface.name, 'x1mk3-2channel');
});

test('rejects unknown MIDI surface', () => {
    assert.throws(
        () => loadMidiSurface({ midiMode: 'custom', surface: 'missing-surface' }),
        /Unknown MIDI surface: missing-surface/
    );
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
node --test test/unit/config.test.js test/unit/midi_surfaces.test.js
```

Expected: FAIL because the MIDI mode fields and surface modules do not exist yet.

- [ ] **Step 4: Normalize MIDI mode fields**

In `src/config.js`, add:

```js
function normalizeMidiMode(raw) {
    if (raw.mode === 'virtual') {
        return { midiMode: 'virtual', surface: 'virtual' };
    }

    const midiMode = raw.midiMode || 'simple';
    if (!['simple', 'custom'].includes(midiMode)) {
        throw new Error(`Unsupported MIDI mode: ${midiMode}`);
    }

    const surface = raw.surface || (midiMode === 'simple' ? 'simple' : undefined);
    if (!surface) {
        throw new Error('Custom MIDI mode requires a surface');
    }

    return { midiMode, surface };
}
```

In `normalizeMidiConfig(raw)`, call the helper after validation:

```js
const midiModeConfig = normalizeMidiMode(raw);
```

For virtual mode, return:

```js
return {
    name: raw.name,
    midiName: raw.match,
    mode: raw.mode,
    ...midiModeConfig,
};
```

For hardware modes, include:

```js
...midiModeConfig,
```

in the returned normalized MIDI object.

- [ ] **Step 5: Create surface modules**

Create `src/controller/midi_surfaces/simple_surface.js`:

```js
module.exports = {
    name: 'simple',
    setup() {
        throw new Error('simple MIDI surface setup has not been wired into src/index.js yet');
    },
};
```

Create `src/controller/midi_surfaces/x1mk3_2channel_surface.js`:

```js
const simpleSurface = require('./simple_surface');

module.exports = {
    name: 'x1mk3-2channel',
    setup(context) {
        return simpleSurface.setup(context);
    },
};
```

Create `src/controller/midi_surfaces/index.js`:

```js
const simpleSurface = require('./simple_surface');
const x1mk3TwoChannelSurface = require('./x1mk3_2channel_surface');

const SURFACES = {
    simple: simpleSurface,
    'x1mk3-2channel': x1mk3TwoChannelSurface,
};

function loadMidiSurface(midi) {
    const surfaceName = midi.surface || 'simple';
    const surface = SURFACES[surfaceName];
    if (!surface) {
        throw new Error(`Unknown MIDI surface: ${surfaceName}`);
    }
    return surface;
}

module.exports = {
    loadMidiSurface,
};
```

Do not add generic config validation that blocks `midiMode: "custom"` in Send Mode. Surface-specific compatibility checks belong in the selected surface setup code, where the full runtime topology is available.

- [ ] **Step 6: Run tests**

Run:

```bash
node --test test/unit/config.test.js test/unit/midi_surfaces.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/config.js src/controller/midi_surfaces test/unit/config.test.js test/unit/midi_surfaces.test.js
git commit -m "feat: add MIDI surface mode loader"
```

---

### Task 4: Move Current MIDI Handling Into Simple Surface

**Files:**
- Modify: `src/index.js`
- Modify: `src/controller/midi_surfaces/simple_surface.js`
- Modify: `src/controller/midi_surfaces/x1mk3_2channel_surface.js`
- Test: `test/unit/midi_surfaces.test.js`

- [ ] **Step 1: Add a focused surface setup test**

Append this test to `test/unit/midi_surfaces.test.js`:

```js
test('custom X1MK3 surface delegates setup to simple behavior initially', () => {
    const calls = [];
    const simple = {
        name: 'simple',
        setup(context) {
            calls.push(context.marker);
            return { controller: context.controller };
        },
    };
    const surfaceFactory = require('../../src/controller/midi_surfaces/x1mk3_2channel_surface');
    const surface = surfaceFactory.createForTest(simple);

    const result = surface.setup({ marker: 'called', controller: { id: 1 } });

    assert.deepEqual(calls, ['called']);
    assert.deepEqual(result, { controller: { id: 1 } });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test test/unit/midi_surfaces.test.js
```

Expected: FAIL because `createForTest` does not exist.

- [ ] **Step 3: Add custom surface factory for testable delegation**

Replace `src/controller/midi_surfaces/x1mk3_2channel_surface.js` with:

```js
const simpleSurface = require('./simple_surface');

function createSurface(delegate) {
    return {
        name: 'x1mk3-2channel',
        setup(context) {
            return delegate.setup(context);
        },
    };
}

module.exports = {
    ...createSurface(simpleSurface),
    createForTest: createSurface,
};
```

- [ ] **Step 4: Extract `setupMidiHandlers` from `src/index.js`**

Move the current `setupMidiHandlers(input, output)` body into `src/controller/midi_surfaces/simple_surface.js`.

The exported setup signature should be:

```js
function setup(context) {
    const {
        input,
        output,
        runtimeConfig,
        midi,
        transport,
        tempo,
        tapTempo,
        midiClock,
        playOnPress,
        createController,
        SlotState,
        JackCaptureRouter,
        onControllerCreated,
    } = context;

    // Existing setupMidiHandlers body goes here.
    // Replace assignment to outer `controller` with:
    // const controller = createController(...);
    // onControllerCreated(controller);
    // return { controller };
}

module.exports = {
    name: 'simple',
    setup,
};
```

Keep `handleInputSource(button)` inside the simple surface so MIDI action routing is fully owned by the surface.

- [ ] **Step 5: Wire surface setup from `src/index.js`**

In `src/index.js`, import:

```js
const { loadMidiSurface } = require('./controller/midi_surfaces');
```

Replace the direct `setupMidiHandlers(input, output);` call with:

```js
const surface = loadMidiSurface(midi);
surface.setup({
    input,
    output,
    runtimeConfig,
    midi,
    transport,
    tempo,
    tapTempo,
    midiClock,
    playOnPress,
    createController,
    SlotState,
    JackCaptureRouter,
    onControllerCreated(createdController) {
        controller = createdController;
    },
});
```

Delete `setupMidiHandlers()` and `handleInputSource()` from `src/index.js` after moving them.

- [ ] **Step 6: Run unit tests**

Run:

```bash
npm run test:unit
```

Expected: PASS.

- [ ] **Step 7: Smoke-test dry-run configs**

Run:

```bash
./start.sh --print-config audio-device=MAC midi-device=WEB channels=1 slots-per-channel=2
./start.sh --print-config audio-device=XONE_2C midi-device=X1MK3_2C channels=2 slots-per-channel=2
```

Expected: both commands print valid JSON. The first shows `audio.routingMode` for Mac and `midi.midiMode` for WEB. The second shows the X1MK3 2-channel MIDI config still resolves.

- [ ] **Step 8: Commit**

```bash
git add src/index.js src/controller/midi_surfaces test/unit/midi_surfaces.test.js
git commit -m "refactor: move MIDI handling into simple surface"
```

---

### Task 5: Mark X1MK3 2-Channel As Initial Custom Surface

**Files:**
- Modify: `config/midi/traktor-x1mk3-2channel.json`
- Modify: `test/unit/config.test.js`
- Modify: `README.md`

- [ ] **Step 1: Add config assertion**

In `test/unit/config.test.js`, add this assertion to the existing X1MK3 2-channel alias test:

```js
assert.equal(config.midi.midiMode, 'custom');
assert.equal(config.midi.surface, 'x1mk3-2channel');
```

- [ ] **Step 2: Update `config/midi/traktor-x1mk3-2channel.json`**

Add top-level fields:

```json
"midiMode": "custom",
"surface": "x1mk3-2channel"
```

Leave all current controls in place so the custom surface can delegate to Simple mode.

- [ ] **Step 3: Document modes**

Update `README.md` hardware/config section with:

```md
Slooper has two audio routing modes:

- `routingMode: "send"`: one looper channel records from a send/source path and returns all playback through one stereo output.
- `routingMode: "channel"`: each input channel has its own looper slots, monitor path, loop output, and stereo output pair. This mode can run with `channels=1` for Mac testing.

Slooper has two MIDI modes:

- `midiMode: "simple"`: JSON maps buttons and encoders directly to looper actions.
- `midiMode: "custom"`: a named surface module owns controller-specific interaction behavior. Custom MIDI can run in Send Mode or Channel Mode unless that specific surface rejects the selected topology. `surface: "x1mk3-2channel"` currently delegates to Simple mode and is the staging point for the X1MK3 custom workflow.
```

- [ ] **Step 4: Run tests**

Run:

```bash
npm run test:unit
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add config/midi/traktor-x1mk3-2channel.json README.md test/unit/config.test.js
git commit -m "chore: configure initial X1 custom MIDI surface"
```

---

### Task 6: Final Verification

**Files:**
- No code changes unless verification exposes a regression.

- [ ] **Step 1: Run all unit tests**

Run:

```bash
npm run test:unit
```

Expected: PASS.

- [ ] **Step 2: Render runtime config for Send Mode**

Run:

```bash
./start.sh --print-config audio-device=XONE midi-device=XONE channels=1 slots-per-channel=2
```

Expected: JSON includes:

```json
"routingMode": "send"
```

and:

```json
"channels": 1
```

- [ ] **Step 3: Render runtime config for Channel Mode with one channel**

Run:

```bash
./start.sh --print-config audio-device=MAC midi-device=WEB channels=1 slots-per-channel=2
```

Expected: JSON includes an explicit routing mode and keeps one runtime channel.

- [ ] **Step 4: Render runtime config for Channel Mode with two channels**

Run:

```bash
./start.sh --print-config audio-device=XONE_2C midi-device=X1MK3_2C channels=2 slots-per-channel=2
```

Expected: JSON includes:

```json
"channels": 2
```

and:

```json
"surface": "x1mk3-2channel"
```

- [ ] **Step 5: Confirm Custom MIDI Is Not Tied To Channel Mode**

Run the unit test added in Task 3:

```bash
node --test test/unit/config.test.js --test-name-pattern "custom MIDI mode can be used with send routing mode"
```

Expected: PASS. The resolved config should have `audio.routingMode` set to `send` and `midi.surface` set to `x1mk3-2channel`.

- [ ] **Step 6: Commit verification doc updates if changed**

If verification required README or test expectation changes, commit them:

```bash
git add README.md test/unit
git commit -m "docs: clarify audio and MIDI mode verification"
```

If no files changed, do not create a commit.

---

## Later Plan: X1MK3 Custom Workflow

After this refactor lands, create a separate plan for the real custom surface behavior:

- Per-channel auto-loop selector state.
- Send Mode support with one selected auto-loop option for the single looper channel.
- Four mutually exclusive auto-loop buttons per channel.
- MIDI LED brightness rendering for selected/unselected selector buttons.
- Shift modifier.
- `shift + slot record` applies the selected channel auto-loop to that slot.
- Exclusive playback per channel.
- Immediate switching to another recorded slot in the same channel.
- Channel-level start/end encoders targeting the currently playing slot.
