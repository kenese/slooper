const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    getRuntimeConfig,
    renderShellConfig,
    renderEnginePatch,
} = require('../../src/config');

test('linux XONE uses tracked engine patch and JACK hardware port mapping', () => {
    const config = getRuntimeConfig({
        audioDevice: 'XONE',
        midiDevice: 'XONE',
        platform: 'linux',
        projectRoot: '/repo',
    });

    assert.equal(config.pd.patchPath, path.join('/repo', 'src', 'engine.pd'));
    assert.equal(config.pd.generateRuntimePatch, false);
    assert.deepEqual(config.audio.capturePorts, ['system:capture_9', 'system:capture_10']);
    assert.deepEqual(config.audio.playbackPorts, ['system:playback_1', 'system:playback_2']);
    assert.equal(config.audio.jackCardNameIncludes, 'XONE');
});

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
    assert.equal(config.midi.slot1.startEncoderCC, undefined);
});

test('legacy aliases resolve to bundled JSON configs', () => {
    const config = getRuntimeConfig({
        audioDevice: 'Z1',
        midiDevice: 'X1MK3',
        platform: 'linux',
        projectRoot: path.join(__dirname, '../..'),
    });

    assert.equal(config.audioDeviceName, 'Z1');
    assert.equal(config.midiDeviceName, 'X1MK3');
    assert.equal(config.audio.name, 'Traktor Kontrol Z1');
    assert.equal(config.midi.name, 'Native Instruments Traktor X1 MK3');
    assert.deepEqual(config.audio.playbackPorts, ['system:playback_3', 'system:playback_4']);
    assert.equal(config.midi.slot2.encoderCC, 21);
});

test('rejects MIDI configs missing required controls', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slooper-midi-'));
    const file = path.join(dir, 'bad.json');
    fs.writeFileSync(file, JSON.stringify({ name: 'Bad MIDI', match: 'Bad', controls: {} }));

    assert.throws(
        () => getRuntimeConfig({
            midiConfigPath: file,
            audioDevice: 'MAC',
            projectRoot: path.join(__dirname, '../..'),
        }),
        /Missing MIDI control: slot1Button/
    );
});

test('rejects JACK audio configs missing routing ports', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slooper-audio-'));
    const file = path.join(dir, 'bad.json');
    fs.writeFileSync(file, JSON.stringify({
        name: 'Bad Audio',
        mode: 'jack',
        jack: { cardNameIncludes: 'Bad' },
        pd: {
            darwin: { adc: [1, 2], dac: [1, 2] },
            linux: { adc: [1, 2], dac: [1, 2] },
        },
    }));

    assert.throws(
        () => getRuntimeConfig({
            audioConfigPath: file,
            midiDevice: 'WEB',
            projectRoot: path.join(__dirname, '../..'),
        }),
        /Missing JACK capturePorts/
    );
});

test('rejects unknown legacy config aliases', () => {
    assert.throws(
        () => getRuntimeConfig({
            audioDevice: 'NOPE',
            midiDevice: 'XONE',
            projectRoot: path.join(__dirname, '../..'),
        }),
        /Unknown audio device alias: NOPE/
    );

    assert.throws(
        () => getRuntimeConfig({
            audioDevice: 'XONE',
            midiDevice: 'NOPE',
            projectRoot: path.join(__dirname, '../..'),
        }),
        /Unknown MIDI device alias: NOPE/
    );
});

test('rejects unsupported MIDI encoder modes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slooper-midi-mode-'));
    const file = path.join(dir, 'bad-mode.json');
    fs.writeFileSync(file, JSON.stringify({
        name: 'Bad Mode',
        match: 'Bad',
        controls: {
            slot1Button: { type: 'note', note: 1, channel: 0 },
            slot2Button: { type: 'note', note: 2, channel: 0 },
            slot1Encoder: { type: 'cc', controller: 10, channel: 0, mode: 'absolute' },
            slot2Encoder: { type: 'cc', controller: 11, channel: 0, mode: 'relative-64' },
            slot1Reset: { type: 'note', note: 3, channel: 0 },
            slot2Reset: { type: 'note', note: 4, channel: 0 },
            monitorButton: { type: 'note', note: 5, channel: 0 },
        },
    }));

    assert.throws(
        () => getRuntimeConfig({
            midiConfigPath: file,
            audioDevice: 'MAC',
            projectRoot: path.join(__dirname, '../..'),
        }),
        /unsupported encoder mode: absolute/
    );
});

test('loads optional start crop encoder controls when configured', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slooper-midi-start-encoder-'));
    const file = path.join(dir, 'start-encoders.json');
    fs.writeFileSync(file, JSON.stringify({
        name: 'Start Encoder MIDI',
        match: 'Start Encoder',
        controls: {
            slot1Button: { type: 'note', note: 1, channel: 0 },
            slot2Button: { type: 'note', note: 2, channel: 0 },
            slot1Encoder: { type: 'cc', controller: 10, channel: 0, mode: 'relative-64' },
            slot2Encoder: { type: 'cc', controller: 11, channel: 0, mode: 'relative-64' },
            slot1StartEncoder: { type: 'cc', controller: 12, channel: 0, mode: 'relative-64' },
            slot2StartEncoder: { type: 'cc', controller: 13, channel: 1, mode: 'relative-64' },
            slot1Reset: { type: 'note', note: 3, channel: 0 },
            slot2Reset: { type: 'note', note: 4, channel: 0 },
            monitorButton: { type: 'note', note: 5, channel: 0 },
        },
    }));

    const config = getRuntimeConfig({
        midiConfigPath: file,
        audioDevice: 'MAC',
        projectRoot: path.join(__dirname, '../..'),
    });

    assert.equal(config.midi.slot1.startEncoderCC, 12);
    assert.equal(config.midi.slot1.startEncoderChannel, 0);
    assert.equal(config.midi.slot2.startEncoderCC, 13);
    assert.equal(config.midi.slot2.startEncoderChannel, 1);
});

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

test('mac XONE renders a runtime patch with direct channel selection', () => {
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

    assert.equal(config.pd.generateRuntimePatch, true);
    assert.equal(config.pd.patchPath, path.join('/repo', '.runtime', 'engine.pd'));
    assert.equal(renderEnginePatch(source, config), [
        '#N canvas 0 0 100 100 12;',
        '#X declare -path ../src;',
        '#X obj 14 130 adc~ 9 10;',
        '#X obj 184 479 dac~ 1 2;',
    ].join('\n'));
});

test('runtime patch declares source directory so Pd can load abstractions', () => {
    const source = [
        '#N canvas 0 0 100 100 12;',
        '#X obj 14 283 looper_slot slot1;',
    ].join('\n');
    const config = getRuntimeConfig({
        audioDevice: 'MAC',
        midiDevice: 'OSC',
        platform: 'darwin',
        projectRoot: '/repo',
    });

    assert.match(renderEnginePatch(source, config), /#X declare -path \.\.\/src;/);
});

test('shell config quotes paths and exposes controller timing values', () => {
    const config = getRuntimeConfig({
        audioDevice: 'MAC',
        midiDevice: 'WEB',
        platform: 'darwin',
        projectRoot: '/repo with spaces',
    });

    const shell = renderShellConfig(config);

    assert.match(shell, /AUDIO_DEVICE='MAC'/);
    assert.match(shell, /MIDI_DEVICE='WEB'/);
    assert.match(shell, /PD_PATCH_PATH='\/repo with spaces\/.runtime\/engine.pd'/);
    assert.match(shell, /HOLD_THRESHOLD_MS='500'/);
    assert.match(shell, /ENCODER_THROTTLE_MS='50'/);
});
