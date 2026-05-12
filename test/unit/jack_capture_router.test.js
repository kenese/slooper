const test = require('node:test');
const assert = require('node:assert/strict');

const { JackCaptureRouter } = require('../../src/controller/jack_capture_router');

test('selectSource disconnects configured capture sources and connects selected source to Pd inputs', async () => {
    const commands = [];
    const router = new JackCaptureRouter({
        runCommand: async (command, args) => {
            commands.push([command, ...args]);
        },
    });

    const sources = [
        { id: 'ch2', label: 'Channel 2', ports: ['system:capture_3', 'system:capture_4'] },
        { id: 'ch3', label: 'Channel 3', ports: ['system:capture_5', 'system:capture_6'] },
    ];

    await router.selectSource(sources[1], sources);

    assert.deepEqual(commands, [
        ['jack_disconnect', 'system:capture_3', 'pure_data:input_1'],
        ['jack_disconnect', 'system:capture_4', 'pure_data:input_2'],
        ['jack_disconnect', 'system:capture_5', 'pure_data:input_1'],
        ['jack_disconnect', 'system:capture_6', 'pure_data:input_2'],
        ['jack_connect', 'system:capture_5', 'pure_data:input_1'],
        ['jack_connect', 'system:capture_6', 'pure_data:input_2'],
    ]);
});

test('selectSource ignores disconnect failures because missing JACK links are harmless', async () => {
    const commands = [];
    const router = new JackCaptureRouter({
        runCommand: async (command, args) => {
            commands.push([command, ...args]);
            if (command === 'jack_disconnect') {
                throw new Error('not connected');
            }
        },
    });

    await router.selectSource(
        { id: 'ch2', label: 'Channel 2', ports: ['system:capture_3', 'system:capture_4'] },
        [{ id: 'ch2', label: 'Channel 2', ports: ['system:capture_3', 'system:capture_4'] }]
    );

    assert.deepEqual(commands.slice(-2), [
        ['jack_connect', 'system:capture_3', 'pure_data:input_1'],
        ['jack_connect', 'system:capture_4', 'pure_data:input_2'],
    ]);
});
