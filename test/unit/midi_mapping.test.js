const test = require('node:test');
const assert = require('node:assert/strict');

const {
    buildMidiSlotMappings,
    findEncoderTarget,
} = require('../../src/controller/midi_mapping');

test('MIDI slot mappings tolerate sparse dynamic slot controls', () => {
    const runtimeConfig = {
        slots: [
            { id: 1, name: 'slot1' },
            { id: 2, name: 'slot2' },
            { id: 3, name: 'slot3' },
            { id: 4, name: 'slot4' },
        ],
        midi: {
            slots: {
                slot1: {
                    note: 1,
                    channel: 0,
                    encoderCC: 10,
                    encoderChannel: 0,
                    autoLoops: {
                        '1beat': { note: 30, channel: 0 },
                    },
                    half: { note: 40, channel: 0 },
                    reset: { note: 20, channel: 0 },
                },
                slot4: {
                    note: 4,
                    channel: 0,
                    encoderCC: 13,
                    encoderChannel: 0,
                    startEncoderCC: 14,
                    startEncoderChannel: 0,
                    moveEncoderCC: 15,
                    moveEncoderChannel: 0,
                    autoLoops: {},
                    double: { note: 44, channel: 0 },
                    reset: { note: 23, channel: 0 },
                },
            },
        },
    };

    const mappings = buildMidiSlotMappings(runtimeConfig);

    assert.deepEqual(mappings.buttonSlots.map((slot) => slot.id), [1, 4]);
    assert.deepEqual(mappings.autoLoopButtons, [
        { id: 1, durationKey: '1beat', note: 30, channel: 0 },
    ]);
    assert.deepEqual(mappings.transformButtons.map((button) => [button.id, button.label]), [
        [1, 'Half'],
        [4, 'Double'],
    ]);
    assert.deepEqual(mappings.encoderPressButtons, [
        { id: 1, note: 20, channel: 0 },
        { id: 4, note: 23, channel: 0 },
    ]);
    assert.deepEqual(findEncoderTarget(mappings.encoderControls, { controller: 13, channel: 0 }), {
        slotId: 4,
        target: 'end',
    });
    assert.deepEqual(findEncoderTarget(mappings.encoderControls, { controller: 14, channel: 0 }), {
        slotId: 4,
        target: 'start',
    });
    assert.equal(findEncoderTarget(mappings.encoderControls, { controller: 99, channel: 0 }), null);
});
