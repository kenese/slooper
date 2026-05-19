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
