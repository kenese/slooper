const test = require('node:test');
const assert = require('node:assert/strict');
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
