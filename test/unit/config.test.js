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

test('audio configs can expose multiple named JACK capture source pairs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slooper-audio-sources-'));
    const file = path.join(dir, 'sources.json');
    fs.writeFileSync(file, JSON.stringify({
        name: 'Multi Source',
        mode: 'jack',
        jack: {
            cardNameIncludes: 'Multi',
            capturePortPairs: [
                { id: 'ch2', label: 'Channel 2', ports: ['system:capture_3', 'system:capture_4'] },
                { id: 'ch3', label: 'Channel 3', ports: ['system:capture_5', 'system:capture_6'] },
            ],
            playbackPorts: ['system:playback_1', 'system:playback_2'],
        },
        pd: {
            darwin: { adc: [1, 2], dac: [1, 2] },
            linux: { adc: [1, 2], dac: [1, 2] },
        },
    }));

    const config = getRuntimeConfig({
        audioConfigPath: file,
        midiDevice: 'WEB',
        platform: 'linux',
        projectRoot: path.join(__dirname, '../..'),
    });

    assert.deepEqual(config.audio.capturePorts, ['system:capture_3', 'system:capture_4']);
    assert.deepEqual(config.audio.captureSources, [
        { id: 'ch2', label: 'Channel 2', ports: ['system:capture_3', 'system:capture_4'] },
        { id: 'ch3', label: 'Channel 3', ports: ['system:capture_5', 'system:capture_6'] },
    ]);
});

test('single legacy JACK capture pair is exposed as send mode source', () => {
    const config = getRuntimeConfig({
        audioDevice: 'Z1',
        midiDevice: 'WEB',
        platform: 'linux',
        projectRoot: path.join(__dirname, '../..'),
    });

    assert.deepEqual(config.audio.captureSources, [
        {
            id: 'capture-1',
            label: 'Capture 1',
            ports: ['system:capture_1', 'system:capture_2'],
        },
    ]);
});

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
                    reset: { type: 'note', note: 20, channel: 0 },
                    autoLoops: {
                        '1beat': { type: 'note', note: 30, channel: 0 },
                    },
                },
                slot4: {
                    button: { type: 'note', note: 4, channel: 0 },
                    endEncoder: { type: 'cc', controller: 13, channel: 0, mode: 'relative-64' },
                    reset: { type: 'note', note: 23, channel: 0 },
                },
            },
        },
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
    assert.deepEqual(config.midi.slots.slot1.autoLoops['1beat'], { note: 30, channel: 0 });
    assert.equal(config.midi.slot1.note, 1);
});

test('rejects dynamic MIDI slot configs missing required controls', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slooper-midi-slots-bad-'));
    const file = path.join(dir, 'bad-slots.json');
    fs.writeFileSync(file, JSON.stringify({
        name: 'Bad Slots',
        match: 'Bad Slots',
        controls: {
            monitorButton: { type: 'note', note: 5, channel: 0 },
            slots: {
                slot1: {
                    button: { type: 'note', note: 1, channel: 0 },
                    endEncoder: { type: 'cc', controller: 10, channel: 0, mode: 'relative-64' },
                },
            },
        },
    }));

    assert.throws(
        () => getRuntimeConfig({
            audioDevice: 'MAC',
            midiConfigPath: file,
            platform: 'darwin',
            projectRoot: path.join(__dirname, '../..'),
        }),
        /Missing MIDI control: slots\.slot1\.reset/
    );
});

test('rejects invalid dynamic MIDI slot auto-loop controls', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slooper-midi-slots-bad-auto-loop-'));
    const file = path.join(dir, 'bad-auto-loop.json');
    fs.writeFileSync(file, JSON.stringify({
        name: 'Bad Auto Loop Slots',
        match: 'Bad Auto Loop Slots',
        controls: {
            monitorButton: { type: 'note', note: 5, channel: 0 },
            slots: {
                slot1: {
                    button: { type: 'note', note: 1, channel: 0 },
                    endEncoder: { type: 'cc', controller: 10, channel: 0, mode: 'relative-64' },
                    reset: { type: 'note', note: 20, channel: 0 },
                    autoLoops: {
                        '1beat': null,
                    },
                },
            },
        },
    }));

    assert.throws(
        () => getRuntimeConfig({
            audioDevice: 'MAC',
            midiConfigPath: file,
            platform: 'darwin',
            projectRoot: path.join(__dirname, '../..'),
        }),
        /MIDI control slots\.slot1\.autoLoops\.1beat must be type note/
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
            slot1EndEncoder: { type: 'cc', controller: 10, channel: 0, mode: 'absolute' },
            slot2EndEncoder: { type: 'cc', controller: 11, channel: 0, mode: 'relative-64' },
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
            slot1EndEncoder: { type: 'cc', controller: 10, channel: 0, mode: 'relative-64' },
            slot2EndEncoder: { type: 'cc', controller: 11, channel: 0, mode: 'relative-64' },
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

test('loads optional auto-loop, half, double, and tap note controls when configured', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slooper-midi-auto-loop-'));
    const file = path.join(dir, 'auto-loop.json');
    fs.writeFileSync(file, JSON.stringify({
        name: 'Auto Loop MIDI',
        match: 'Auto Loop',
        controls: {
            slot1Button: { type: 'note', note: 1, channel: 0 },
            slot2Button: { type: 'note', note: 2, channel: 0 },
            slot1EndEncoder: { type: 'cc', controller: 10, channel: 0, mode: 'relative-64' },
            slot2EndEncoder: { type: 'cc', controller: 11, channel: 0, mode: 'relative-64' },
            slot1Reset: { type: 'note', note: 3, channel: 0 },
            slot2Reset: { type: 'note', note: 4, channel: 0 },
            monitorButton: { type: 'note', note: 5, channel: 0 },
            slot1AutoLoop1Beat: { type: 'note', note: 20, channel: 0 },
            slot1AutoLoop2Beat: { type: 'note', note: 21, channel: 0 },
            slot1AutoLoop4Beat: { type: 'note', note: 22, channel: 0 },
            slot1AutoLoop2Bar: { type: 'note', note: 23, channel: 0 },
            slot2AutoLoop1Beat: { type: 'note', note: 24, channel: 1 },
            slot2AutoLoop2Beat: { type: 'note', note: 25, channel: 1 },
            slot2AutoLoop4Beat: { type: 'note', note: 26, channel: 1 },
            slot2AutoLoop2Bar: { type: 'note', note: 27, channel: 1 },
            slot1Half: { type: 'note', note: 30, channel: 0 },
            slot1Double: { type: 'note', note: 31, channel: 0 },
            slot2Half: { type: 'note', note: 32, channel: 1 },
            slot2Double: { type: 'note', note: 33, channel: 1 },
            tapTempo: { type: 'note', note: 40, channel: 0 },
        },
    }));

    const config = getRuntimeConfig({
        midiConfigPath: file,
        audioDevice: 'MAC',
        projectRoot: path.join(__dirname, '../..'),
    });

    assert.deepEqual(config.midi.slot1.autoLoops['1beat'], { note: 20, channel: 0 });
    assert.deepEqual(config.midi.slot1.autoLoops['2beat'], { note: 21, channel: 0 });
    assert.deepEqual(config.midi.slot1.autoLoops['4beat'], { note: 22, channel: 0 });
    assert.deepEqual(config.midi.slot1.autoLoops['2bar'], { note: 23, channel: 0 });
    assert.deepEqual(config.midi.slot2.autoLoops['1beat'], { note: 24, channel: 1 });
    assert.deepEqual(config.midi.slot2.autoLoops['2bar'], { note: 27, channel: 1 });
    assert.deepEqual(config.midi.slot1.half, { note: 30, channel: 0 });
    assert.deepEqual(config.midi.slot1.double, { note: 31, channel: 0 });
    assert.deepEqual(config.midi.slot2.half, { note: 32, channel: 1 });
    assert.deepEqual(config.midi.slot2.double, { note: 33, channel: 1 });
    assert.deepEqual(config.midi.tapTempo, { note: 40, channel: 0 });
});

test('loads optional capture source MIDI note controls when configured', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slooper-midi-capture-source-'));
    const file = path.join(dir, 'capture-source.json');
    fs.writeFileSync(file, JSON.stringify({
        name: 'Capture Source MIDI',
        match: 'Capture Source',
        controls: {
            slot1Button: { type: 'note', note: 1, channel: 0 },
            slot2Button: { type: 'note', note: 2, channel: 0 },
            slot1EndEncoder: { type: 'cc', controller: 10, channel: 0, mode: 'relative-64' },
            slot2EndEncoder: { type: 'cc', controller: 11, channel: 0, mode: 'relative-64' },
            slot1Reset: { type: 'note', note: 3, channel: 0 },
            slot2Reset: { type: 'note', note: 4, channel: 0 },
            monitorButton: { type: 'note', note: 5, channel: 0 },
            captureSource1: { type: 'note', note: 50, channel: 0 },
            captureSource2: { type: 'note', note: 51, channel: 0 },
        },
    }));

    const config = getRuntimeConfig({
        midiConfigPath: file,
        audioDevice: 'MAC',
        projectRoot: path.join(__dirname, '../..'),
    });

    assert.deepEqual(config.midi.captureSources, [
        { note: 50, channel: 0 },
        { note: 51, channel: 0 },
    ]);
});

test('optional auto-loop controls are absent when not configured', () => {
    const config = getRuntimeConfig({
        audioDevice: 'MAC',
        midiDevice: 'XONE',
        platform: 'darwin',
        projectRoot: path.join(__dirname, '../..'),
    });

    assert.deepEqual(config.midi.slot1.autoLoops, {});
    assert.deepEqual(config.midi.slot2.autoLoops, {});
    assert.equal(config.midi.slot1.half, undefined);
    assert.equal(config.midi.slot2.double, undefined);
    assert.equal(config.midi.tapTempo, undefined);
    assert.deepEqual(config.midi.captureSources, []);
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

test('mac XONE renders a runtime patch with direct output channel selection', () => {
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
        '#X obj 14 130 adc~ 3 4 5 6 9 10;',
        '#X obj 184 479 dac~ 1 2;',
    ].join('\n'));
});

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

test('mac XONE runtime patch keeps source selector with expanded adc channel mapping', () => {
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
    assert.match(rendered, /#X connect 5 4 41 0;/);
    assert.match(rendered, /#X connect 5 5 42 0;/);
    assert.match(rendered, /#X connect 5 0 43 0;/);
    assert.match(rendered, /#X connect 5 1 44 0;/);
    assert.match(rendered, /#X connect 5 2 45 0;/);
    assert.match(rendered, /#X connect 5 3 46 0;/);
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
