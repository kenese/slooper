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

test('linux XONE uses generated runtime patch and JACK hardware port mapping', () => {
    const config = getRuntimeConfig({
        audioDevice: 'XONE',
        midiDevice: 'XONE',
        platform: 'linux',
        projectRoot: '/repo',
    });

    assert.equal(config.pd.patchPath, path.join('/repo', '.runtime', 'engine.pd'));
    assert.equal(config.pd.generateRuntimePatch, true);
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
            ],
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

test('renderEnginePatch generates default two-slot channel host patch', () => {
    const config = getRuntimeConfig({
        audioDevice: 'MAC',
        midiDevice: 'WEB',
        platform: 'darwin',
        projectRoot: '/repo',
    });

    assert.equal(config.pd.generateRuntimePatch, true);
    assert.equal(config.pd.patchPath, path.join('/repo', '.runtime', 'engine.pd'));
    const rendered = renderEnginePatch('', config);

    assert.match(rendered, /#X declare -path \.\.\/src;/);
    assert.match(rendered, /adc~ 1 2;/);
    assert.match(rendered, /dac~ 1 2;/);
    assert.match(rendered, /route connect source monitor1;/);
    assert.match(rendered, /channel_2slot slot1 slot2;/);
    assert.match(rendered, /#X msg \d+ \d+ monitor \\\$1;/);
    assert.match(rendered, /#X connect 3 2 12 0;/);
    assert.match(rendered, /#X connect 12 0 11 2;/);
    assert.match(rendered, /#X connect 3 3 11 2;/);
    assert.match(rendered, /netsend -u -b;/);
});

test('renderEnginePatch generates multi-channel four-slot host patch', () => {
    const config = getRuntimeConfig({
        audioDevice: 'MAC',
        midiDevice: 'WEB',
        platform: 'darwin',
        projectRoot: '/repo',
        channels: 3,
        slotsPerChannel: 4,
    });
    const rendered = renderEnginePatch('', config);

    assert.match(rendered, /adc~ 1 2 3 4 5 6;/);
    assert.match(rendered, /dac~ 1 2 3 4 5 6;/);
    assert.match(rendered, /channel_4slot slot1 slot2 slot3 slot4;/);
    assert.match(rendered, /channel_4slot slot5 slot6 slot7 slot8;/);
    assert.match(rendered, /channel_4slot slot9 slot10 slot11 slot12;/);
    assert.match(rendered, /route connect source monitor1 monitor2 monitor3;/);
    assert.match(rendered, /#X connect 3 5 11 2;/);
    assert.match(rendered, /#X connect 3 5 12 2;/);
    assert.match(rendered, /#X connect 3 5 13 2;/);
    assert.match(rendered, /#X connect 3 2 14 0;/);
    assert.match(rendered, /#X connect 3 3 15 0;/);
    assert.match(rendered, /#X connect 3 4 16 0;/);
    assert.match(rendered, /#X connect 14 0 11 2;/);
    assert.match(rendered, /#X connect 15 0 12 2;/);
    assert.match(rendered, /#X connect 16 0 13 2;/);
    assert.match(rendered, /#X connect 11 2 8 0;/);
    assert.match(rendered, /#X connect 12 2 8 0;/);
    assert.match(rendered, /#X connect 13 2 8 0;/);
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

test('shell config exposes JACK port pair arrays for configured topology', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slooper-shell-audio-multi-'));
    const file = path.join(dir, 'multi.json');
    fs.writeFileSync(file, JSON.stringify({
        name: 'Multi Shell',
        mode: 'jack',
        jack: {
            cardNameIncludes: 'Multi',
            capturePortPairs: [
                { id: 'input1', ports: ['system:capture_1', 'system:capture_2'] },
                { id: 'input2', ports: ['system:capture_3', 'system:capture_4'] },
            ],
            playbackPortPairs: [
                { id: 'output1', ports: ['system:playback_1', 'system:playback_2'] },
                { id: 'output2', ports: ['system:playback_3', 'system:playback_4'] },
            ],
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
        projectRoot: '/repo',
        channels: 2,
        slotsPerChannel: 2,
    });

    const shell = renderShellConfig(config);

    assert.match(shell, /JACK_CAPTURE_PORT_PAIRS='system:capture_1,system:capture_2;system:capture_3,system:capture_4'/);
    assert.match(shell, /JACK_PLAYBACK_PORT_PAIRS='system:playback_1,system:playback_2;system:playback_3,system:playback_4'/);
    assert.match(shell, /CHANNELS='2'/);
    assert.match(shell, /SLOTS_PER_CHANNEL='2'/);
});
