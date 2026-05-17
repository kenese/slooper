const test = require('node:test');
const assert = require('node:assert/strict');

const {
    createController,
    SlotState,
} = require('../../src/controller/slot_controller');

function createFakeTransport() {
    const commands = [];
    return {
        commands,
        async send(address, ...args) {
            commands.push([address, ...args]);
        },
    };
}

function createManualScheduler() {
    const timers = [];
    return {
        timers,
        setTimeout(fn, delayMs) {
            const timer = { fn, delayMs, cleared: false };
            timers.push(timer);
            return timer;
        },
        clearTimeout(timer) {
            timer.cleared = true;
        },
        async run(index = 0) {
            const timer = timers[index];
            assert.ok(timer, `Missing timer ${index}`);
            assert.equal(timer.cleared, false);
            await timer.fn();
        },
    };
}

test('createController accepts runtime slot descriptors', () => {
    const transport = createFakeTransport();
    const controller = createController({
        transport,
        slots: [
            { id: 1, name: 'slot1', channelId: 1, indexInChannel: 1 },
            { id: 2, name: 'slot2', channelId: 1, indexInChannel: 2 },
            { id: 3, name: 'slot3', channelId: 2, indexInChannel: 1 },
            { id: 4, name: 'slot4', channelId: 2, indexInChannel: 2 },
        ],
    });

    assert.deepEqual(controller.getState().slots.map((slot) => slot.id), [1, 2, 3, 4]);
    assert.equal(controller.getState().slots[2].channelId, 2);
    assert.equal(controller.getState().slots[2].indexInChannel, 1);
    assert.deepEqual(controller.getState().channels.map((channel) => channel.id), [1, 2]);
});

test('monitor state is independent per channel', async () => {
    const transport = createFakeTransport();
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

test('tapSlot records, stops recording, starts playback, and updates monitor', async () => {
    const transport = createFakeTransport();
    const controller = createController({ transport, now: () => 1000 });

    await controller.tapSlot(1);
    assert.deepEqual(transport.commands, [['/slot1', 'rec', 1]]);
    assert.equal(controller.getSlot(1).state, SlotState.RECORDING);

    controller.setNow(() => 1500);
    await controller.tapSlot(1);

    assert.deepEqual(transport.commands, [
        ['/slot1', 'rec', 1],
        ['/slot1', 'rec', 0],
        ['/slot1', 'play', 1],
        ['/monitor1', 0],
    ]);
    assert.equal(controller.getSlot(1).state, SlotState.PLAYING);
});

test('getState reports send mode when there is only one capture source', () => {
    const transport = createFakeTransport();
    const controller = createController({
        transport,
        inputSources: [
            { id: 'main', label: 'Main', ports: ['system:capture_9', 'system:capture_10'] },
        ],
    });

    assert.deepEqual(controller.getState().inputRouting, {
        mode: 'send',
        selectedSourceId: 'main',
        sources: [
            { id: 'main', label: 'Main', ports: ['system:capture_9', 'system:capture_10'] },
        ],
    });
});

test('getState includes tempo status when a tempo source is configured', () => {
    const transport = createFakeTransport();
    const controller = createController({
        transport,
        now: () => 1200,
        tempo: {
            getStatus(timeMs) {
                return { source: 'midi', active: true, bpm: 120, timeMs };
            },
        },
    });

    assert.deepEqual(controller.getState().tempo, {
        source: 'midi',
        active: true,
        bpm: 120,
        timeMs: 1200,
    });
});

test('selectInputSource switches global capture source through the router', async () => {
    const transport = createFakeTransport();
    const selections = [];
    const controller = createController({
        transport,
        inputSources: [
            { id: 'ch2', label: 'Channel 2', ports: ['system:capture_3', 'system:capture_4'] },
            { id: 'ch3', label: 'Channel 3', ports: ['system:capture_5', 'system:capture_6'] },
        ],
        inputRouter: {
            async selectSource(source, sources) {
                selections.push({ source, sources });
            },
        },
    });

    const result = await controller.selectInputSource('ch3');

    assert.deepEqual(result, { ok: true, action: 'select-input-source', sourceId: 'ch3' });
    assert.equal(controller.getState().inputRouting.mode, 'switching');
    assert.equal(controller.getState().inputRouting.selectedSourceId, 'ch3');
    assert.deepEqual(selections, [{
        source: { id: 'ch3', label: 'Channel 3', ports: ['system:capture_5', 'system:capture_6'] },
        sources: [
            { id: 'ch2', label: 'Channel 2', ports: ['system:capture_3', 'system:capture_4'] },
            { id: 'ch3', label: 'Channel 3', ports: ['system:capture_5', 'system:capture_6'] },
        ],
    }]);
    assert.deepEqual(transport.commands, [['/source', 'ch3']]);
});

test('selectInputSource sends source OSC and runs input router when configured', async () => {
    const sent = [];
    const routed = [];
    const controller = createController({
        transport: {
            send: async (...args) => sent.push(args),
        },
        inputSources: [
            { id: 'main', label: 'PX5 Send', ports: ['system:capture_9', 'system:capture_10'] },
            { id: 'ch2', label: 'PX5 Channel 2', ports: ['system:capture_3', 'system:capture_4'] },
        ],
        inputRouter: {
            selectSource: async (source, sources) => routed.push([source.id, sources.map((item) => item.id)]),
        },
    });

    await controller.selectInputSource('ch2');

    assert.deepEqual(sent, [['/source', 'ch2']]);
    assert.deepEqual(routed, [['ch2', ['main', 'ch2']]]);
    assert.equal(controller.getState().inputRouting.selectedSourceId, 'ch2');
});

test('selectInputSource rejects unknown capture source ids', async () => {
    const transport = createFakeTransport();
    const controller = createController({
        transport,
        inputSources: [
            { id: 'ch2', label: 'Channel 2', ports: ['system:capture_3', 'system:capture_4'] },
        ],
    });

    await assert.rejects(
        () => controller.selectInputSource('missing'),
        /Unknown input source: missing/
    );
});

test('clearSlot stops playback, clears Pd, resets local slot, and updates monitor', async () => {
    const transport = createFakeTransport();
    const controller = createController({ transport });

    controller.applyPdState(['slot1', 'length', 500]);
    controller.applyPdState(['slot1', 'playing']);

    await controller.clearSlot(1);

    assert.deepEqual(transport.commands, [
        ['/slot1', 'play', 0],
        ['/slot1', 'clear', 1],
        ['/monitor1', 1],
    ]);
    assert.equal(controller.getSlot(1).state, SlotState.EMPTY);
    assert.equal(controller.getSlot(1).lengthMs, 0);
    assert.equal(controller.getSlot(1).cropOffset, 0);
    assert.equal(controller.getSlot(1).startCropOffset, 0);
});

test('cropSlot, cropStartSlot, and resetSlot only send commands while playing', async () => {
    const transport = createFakeTransport();
    const controller = createController({ transport });

    await controller.cropSlot(1, 30);
    await controller.cropStartSlot(1, -30);
    await controller.resetSlot(1);
    assert.deepEqual(transport.commands, []);

    controller.applyPdState(['slot1', 'length', 500]);
    controller.applyPdState(['slot1', 'playing']);
    await controller.cropSlot(1, 30);
    await controller.cropStartSlot(1, -30);
    await controller.resetSlot(1);

    assert.deepEqual(transport.commands, [
        ['/slot1', 'crop', 30],
        ['/slot1', 'cropStart', -30],
        ['/slot1', 'reset', 1],
    ]);
    assert.equal(controller.getSlot(1).cropOffset, 0);
    assert.equal(controller.getSlot(1).startCropOffset, 0);
});

test('applyPdState makes Pd length and state authoritative', () => {
    const transport = createFakeTransport();
    const controller = createController({ transport });

    controller.applyPdState(['slot1', 'recording']);
    assert.equal(controller.getSlot(1).state, SlotState.RECORDING);

    controller.applyPdState(['slot1', 'length', 640]);
    assert.equal(controller.getSlot(1).lengthMs, 640);

    controller.applyPdState(['slot1', 'start', -60]);
    assert.equal(controller.getSlot(1).startCropOffset, -60);

    controller.applyPdState(['slot1', 'stopped']);
    assert.equal(controller.getSlot(1).state, SlotState.STOPPED);

    controller.applyPdState(['slot1', 'length', 0]);
    controller.applyPdState(['slot1', 'stopped']);
    assert.equal(controller.getSlot(1).state, SlotState.EMPTY);
    assert.equal(controller.getSlot(1).startCropOffset, 0);
});

test('current length accounts for start and end crop offsets', async () => {
    const transport = createFakeTransport();
    const controller = createController({ transport });

    controller.applyPdState(['slot1', 'length', 1000]);
    controller.applyPdState(['slot1', 'playing']);

    await controller.cropSlot(1, 90);
    await controller.cropStartSlot(1, -120);

    const slot = controller.getState().slots[0];
    assert.equal(slot.cropOffset, 90);
    assert.equal(slot.endCropOffset, 90);
    assert.equal(slot.startCropOffset, -120);
    assert.equal(slot.currentLengthMs, 1210);
});

test('moveSlot shifts start and end crop together without changing length', async () => {
    const transport = createFakeTransport();
    const controller = createController({ transport });

    controller.applyPdState(['slot1', 'length', 1000]);
    controller.applyPdState(['slot1', 'playing']);

    await controller.moveSlot(1, 30);

    assert.deepEqual(transport.commands, [
        ['/slot1', 'cropStart', 30],
        ['/slot1', 'crop', 30],
    ]);
    const slot = controller.getState().slots[0];
    assert.equal(slot.startCropOffset, 30);
    assert.equal(slot.endCropOffset, 30);
    assert.equal(slot.currentLengthMs, 1000);
});

test('moveSlot clips movement when the end boundary is already at its minimum', async () => {
    const transport = createFakeTransport();
    const controller = createController({ transport });

    controller.applyPdState(['slot1', 'length', 1000]);
    controller.applyPdState(['slot1', 'start', -900]);
    controller.applyPdState(['slot1', 'playing']);

    await controller.moveSlot(1, -30);

    assert.deepEqual(transport.commands, []);
    const slot = controller.getState().slots[0];
    assert.equal(slot.startCropOffset, -900);
    assert.equal(slot.currentLengthMs, 1000);
});

test('Pd-reported effective length is not double-counted with crop offsets', async () => {
    const transport = createFakeTransport();
    const controller = createController({ transport });

    controller.applyPdState(['slot1', 'length', 1000]);
    controller.applyPdState(['slot1', 'playing']);

    await controller.cropSlot(1, 30);
    controller.applyPdState(['slot1', 'length', 1030]);
    assert.equal(controller.getState().slots[0].currentLengthMs, 1030);

    await controller.cropStartSlot(1, -90);
    controller.applyPdState(['slot1', 'start', -90]);
    controller.applyPdState(['slot1', 'length', 1120]);
    assert.equal(controller.getState().slots[0].currentLengthMs, 1120);
    assert.equal(controller.getState().slots[0].endCropOffset, 30);
    assert.equal(controller.getState().slots[0].startCropOffset, -90);
});

test('monitor active follows preference and playing slots', async () => {
    const transport = createFakeTransport();
    const controller = createController({ transport });

    assert.equal(controller.getState().monitorEnabled, true);
    assert.equal(controller.getState().monitorActive, true);

    controller.applyPdState(['slot1', 'playing']);
    await controller.updateMonitorState();
    assert.equal(controller.getState().monitorActive, false);
    assert.deepEqual(transport.commands, [
        ['/monitor1', 0],
    ]);
});

test('Pd-reported playback state updates local monitor active state without sending OSC', async () => {
    const transport = createFakeTransport();
    const controller = createController({ transport });

    controller.applyPdState(['slot1', 'playing']);
    assert.equal(controller.getState().monitorActive, false);
    assert.deepEqual(transport.commands, []);

    controller.applyPdState(['slot1', 'paused']);
    assert.equal(controller.getState().monitorActive, true);
});

test('autoLoopSlot schedules empty slot recording on nearest MIDI beat', async () => {
    const transport = createFakeTransport();
    const scheduler = createManualScheduler();
    const controller = createController({
        transport,
        now: () => 1455,
        setTimeout: scheduler.setTimeout,
        clearTimeout: scheduler.clearTimeout,
        tempo: {
            getTiming() {
                return {
                    source: 'midi',
                    beatMs: 500,
                    startTimeMs: 1500,
                };
            },
        },
    });

    const result = await controller.autoLoopSlot(1, '4beat');

    assert.deepEqual(result, { ok: true, action: 'scheduled-record', source: 'midi', durationMs: 2000, startDelayMs: 45 });
    assert.equal(controller.getSlot(1).state, SlotState.PENDING);
    assert.equal(scheduler.timers[0].delayMs, 45);
    assert.deepEqual(transport.commands, []);

    await scheduler.run(0);
    assert.deepEqual(transport.commands, [['/slot1', 'rec', 1]]);
    assert.equal(controller.getSlot(1).state, SlotState.RECORDING);
    assert.equal(scheduler.timers[1].delayMs, 2000);

    await scheduler.run(1);
    assert.deepEqual(transport.commands, [
        ['/slot1', 'rec', 1],
        ['/slot1', 'rec', 0],
        ['/slot1', 'play', 1],
        ['/monitor1', 0],
    ]);
    assert.equal(controller.getSlot(1).state, SlotState.PLAYING);
});

test('autoLoopSlot starts immediately with tap tempo fallback', async () => {
    const transport = createFakeTransport();
    const scheduler = createManualScheduler();
    const controller = createController({
        transport,
        now: () => 2000,
        setTimeout: scheduler.setTimeout,
        clearTimeout: scheduler.clearTimeout,
        tempo: {
            getTiming() {
                return {
                    source: 'tap',
                    beatMs: 600,
                    startTimeMs: 2000,
                };
            },
        },
    });

    await controller.autoLoopSlot(1, '1beat');

    assert.equal(scheduler.timers[0].delayMs, 0);
    await scheduler.run(0);
    assert.deepEqual(transport.commands, [['/slot1', 'rec', 1]]);
    assert.equal(scheduler.timers[1].delayMs, 600);
});

test('autoLoopSlot snaps existing loop to musical length', async () => {
    const transport = createFakeTransport();
    const controller = createController({
        transport,
        tempo: {
            getTiming() {
                return { source: 'tap', beatMs: 500, startTimeMs: 0 };
            },
        },
    });

    controller.applyPdState(['slot1', 'length', 900]);
    controller.applyPdState(['slot1', 'start', -30]);
    controller.applyPdState(['slot1', 'playing']);

    const result = await controller.autoLoopSlot(1, '2bar');

    assert.deepEqual(result, { ok: true, action: 'set-length', source: 'tap', durationMs: 4000 });
    assert.deepEqual(transport.commands, [['/slot1', 'setLength', 4000]]);
    assert.equal(controller.getSlot(1).startCropOffset, -30);
    assert.equal(controller.getSlot(1).lengthMs, 4000);
});

test('autoLoopSlot is a no-op without tempo', async () => {
    const transport = createFakeTransport();
    const controller = createController({
        transport,
        tempo: {
            getTiming() {
                return null;
            },
        },
    });

    const result = await controller.autoLoopSlot(1, '1beat');

    assert.deepEqual(result, { ok: false, reason: 'tempo-unavailable' });
    assert.deepEqual(transport.commands, []);
    assert.equal(controller.getSlot(1).state, SlotState.EMPTY);
});

test('multiplySlotLength sends absolute setLength for half and double', async () => {
    const transport = createFakeTransport();
    const controller = createController({ transport });

    controller.applyPdState(['slot1', 'length', 1200]);
    controller.applyPdState(['slot1', 'playing']);

    assert.deepEqual(await controller.multiplySlotLength(1, 0.5), { ok: true, action: 'set-length', durationMs: 600 });
    assert.deepEqual(await controller.multiplySlotLength(1, 2), { ok: true, action: 'set-length', durationMs: 1200 });
    assert.deepEqual(transport.commands, [
        ['/slot1', 'setLength', 600],
        ['/slot1', 'setLength', 1200],
    ]);
});

test('clearSlot cancels pending auto-record timers', async () => {
    const transport = createFakeTransport();
    const scheduler = createManualScheduler();
    const controller = createController({
        transport,
        now: () => 1000,
        setTimeout: scheduler.setTimeout,
        clearTimeout: scheduler.clearTimeout,
        tempo: {
            getTiming() {
                return { source: 'midi', beatMs: 500, startTimeMs: 1200 };
            },
        },
    });

    await controller.autoLoopSlot(1, '1beat');
    await controller.clearSlot(1);

    assert.equal(scheduler.timers[0].cleared, true);
    assert.deepEqual(transport.commands, [
        ['/slot1', 'play', 0],
        ['/slot1', 'clear', 1],
        ['/monitor1', 1],
    ]);
    assert.equal(controller.getSlot(1).state, SlotState.EMPTY);
});
