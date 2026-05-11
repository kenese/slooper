# Configurable Hardware Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Slooper's two-slot MIDI and audio hardware mappings into JSON files while preserving current XONE, Z1, X1MK3, MAC, BlackHole, OSC, and WEB startup behavior.

**Architecture:** Keep `src/config.js` as the single normalized runtime config boundary. Add file-backed audio/MIDI config loading and validation under that boundary, then let `scripts/runtime_config.js`, `start.sh`, and `src/index.js` continue consuming the normalized shape they already use. Keep Pure Data topology at two slots.

**Tech Stack:** Node.js CommonJS, `node:test`, JSON config files, existing Bash startup script, Pure Data runtime patch rendering.

---

## File Structure

- Create `config/audio/*.json`: bundled audio interface configs.
- Create `config/midi/*.json`: bundled MIDI controller configs and example.
- Modify `src/config.js`: add JSON file loading, alias resolution, validation, and normalization.
- Modify `scripts/runtime_config.js`: parse `--audio-config=` and `--midi-config=`.
- Modify `src/index.js`: read normalized action-based MIDI controls instead of old device-specific fields.
- Modify `test/unit/config.test.js`: cover file-backed loading, aliases, validation, and shell rendering.
- Modify `README.md`: document explicit JSON startup and config authoring.

## Task 1: Add File-Backed Config Loading

**Files:**
- Create: `config/audio/xone-px5.json`
- Create: `config/audio/traktor-z1.json`
- Create: `config/audio/blackhole-mac.json`
- Create: `config/audio/generic-jack-1-2.json`
- Create: `config/midi/xone-px5.json`
- Create: `config/midi/traktor-x1mk3.json`
- Create: `config/midi/osc.json`
- Create: `config/midi/web.json`
- Create: `config/midi/example.json`
- Modify: `src/config.js`
- Test: `test/unit/config.test.js`

- [ ] **Step 1: Write failing tests**

Add tests that call `getRuntimeConfig()` with `audioConfigPath` and `midiConfigPath`, then assert normalized values:

```js
test('loads explicit JSON audio and MIDI config files', () => {
    const config = getRuntimeConfig({
        audioConfigPath: path.join(__dirname, '../../config/audio/xone-px5.json'),
        midiConfigPath: path.join(__dirname, '../../config/midi/xone-px5.json'),
        platform: 'linux',
        projectRoot: path.join(__dirname, '../..'),
    });

    assert.equal(config.audioDeviceName, 'Allen & Heath XONE:PX5');
    assert.equal(config.midiDeviceName, 'Allen & Heath XONE:PX5');
    assert.equal(config.midi.midiName, 'XONE');
    assert.deepEqual(config.audio.capturePorts, ['system:capture_9', 'system:capture_10']);
    assert.equal(config.midi.slot1.note, 14);
    assert.equal(config.midi.slot1.encoderCC, 7);
});
```

- [ ] **Step 2: Run test and verify failure**

Run: `npm run test:unit`

Expected: FAIL because config files do not exist or `getRuntimeConfig()` does not support explicit config paths yet.

- [ ] **Step 3: Add bundled config files and loader**

Implement:

- `loadJsonFile(filePath)` in `src/config.js`.
- `resolveConfigPath(projectRoot, configPath)` for relative repo paths.
- `normalizeMidiConfig(raw)` to convert action names into the existing runtime shape.
- `normalizeAudioConfig(raw)` to convert JSON audio into the existing runtime shape.

Keep compatibility by returning `config.midi.slot1`, `config.midi.slot2`, `config.midi.monitor`, `config.midi.encoderPress1`, and `config.midi.encoderPress2`.

- [ ] **Step 4: Run test and verify pass**

Run: `npm run test:unit`

Expected: PASS.

## Task 2: Preserve Legacy Aliases

**Files:**
- Modify: `src/config.js`
- Test: `test/unit/config.test.js`

- [ ] **Step 1: Write failing tests**

Add tests for old alias arguments:

```js
test('legacy aliases resolve to bundled JSON configs', () => {
    const config = getRuntimeConfig({
        audioDevice: 'Z1',
        midiDevice: 'X1MK3',
        platform: 'linux',
        projectRoot: path.join(__dirname, '../..'),
    });

    assert.equal(config.audioDeviceName, 'Traktor Kontrol Z1');
    assert.equal(config.midiDeviceName, 'Native Instruments Traktor X1 MK3');
    assert.deepEqual(config.audio.playbackPorts, ['system:playback_3', 'system:playback_4']);
    assert.equal(config.midi.slot2.encoderCC, 21);
});
```

- [ ] **Step 2: Run test and verify failure**

Run: `npm run test:unit`

Expected: FAIL until aliases are resolved through bundled JSON files.

- [ ] **Step 3: Implement alias maps**

Add internal maps:

```js
const AUDIO_ALIASES = {
    XONE: 'config/audio/xone-px5.json',
    Z1: 'config/audio/traktor-z1.json',
    MAC: 'config/audio/blackhole-mac.json',
    BLACKHOLE: 'config/audio/blackhole-mac.json',
};

const MIDI_ALIASES = {
    XONE: 'config/midi/xone-px5.json',
    X1MK3: 'config/midi/traktor-x1mk3.json',
    OSC: 'config/midi/osc.json',
    WEB: 'config/midi/web.json',
};
```

- [ ] **Step 4: Run test and verify pass**

Run: `npm run test:unit`

Expected: PASS.

## Task 3: Validate Config Errors

**Files:**
- Modify: `src/config.js`
- Test: `test/unit/config.test.js`

- [ ] **Step 1: Write failing validation tests**

Use temporary files created by the test to assert errors:

```js
test('rejects MIDI configs missing required controls', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slooper-midi-'));
    const file = path.join(dir, 'bad.json');
    fs.writeFileSync(file, JSON.stringify({ name: 'Bad', match: 'Bad', controls: {} }));

    assert.throws(
        () => getRuntimeConfig({ midiConfigPath: file, audioDevice: 'MAC', projectRoot: path.join(__dirname, '../..') }),
        /Missing MIDI control: slot1Button/
    );
});
```

Add similar audio validation for a JACK config without capture/playback ports.

- [ ] **Step 2: Run test and verify failure**

Run: `npm run test:unit`

Expected: FAIL until validators throw actionable errors.

- [ ] **Step 3: Implement validators**

Add:

- `validateMidiConfig(raw, sourceLabel)`.
- `validateAudioConfig(raw, sourceLabel)`.
- Checks for required action names, `note`/`cc` types, `relative-64` encoder mode, valid channel arrays, and JACK port arrays.

- [ ] **Step 4: Run test and verify pass**

Run: `npm run test:unit`

Expected: PASS.

## Task 4: Wire CLI Args Through Startup

**Files:**
- Modify: `scripts/runtime_config.js`
- Modify: `src/index.js`
- Test: `test/unit/config.test.js`

- [ ] **Step 1: Write failing arg parse tests**

Export `parseArgs` from `scripts/runtime_config.js` and test:

```js
test('runtime_config parses explicit config path arguments', () => {
    const { parseArgs } = require('../../scripts/runtime_config');
    assert.deepEqual(parseArgs([
        '--audio-config=config/audio/generic-jack-1-2.json',
        '--midi-config=config/midi/example.json',
    ]), {
        mode: 'shell',
        audioConfigPath: 'config/audio/generic-jack-1-2.json',
        midiConfigPath: 'config/midi/example.json',
    });
});
```

- [ ] **Step 2: Run test and verify failure**

Run: `npm run test:unit`

Expected: FAIL because `parseArgs` is not exported or does not parse the new args.

- [ ] **Step 3: Implement arg parsing and index wiring**

Update `scripts/runtime_config.js` and `src/index.js` to accept:

- `--audio-config=...`
- `--midi-config=...`

Keep old `audio-device=`, `device=`, and `midi-device=` args working.

- [ ] **Step 4: Run test and verify pass**

Run: `npm run test:unit`

Expected: PASS.

## Task 5: Document Usage

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update README configuration section**

Document explicit JSON startup, legacy aliases, bundled file locations, and how to copy `config/midi/example.json`.

- [ ] **Step 2: Verify documentation references real files**

Run: `npm run test:unit`

Expected: PASS.

## Final Verification

- [ ] Run `npm run test:unit`.
- [ ] Run `./start.sh --print-config --audio-config=config/audio/generic-jack-1-2.json --midi-config=config/midi/example.json`.
- [ ] Run `./start.sh --print-config audio-device=Z1 midi-device=X1MK3`.
- [ ] Check `git diff --stat` and confirm no Pure Data patch topology changes were made.
