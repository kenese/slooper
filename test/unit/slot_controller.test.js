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
        ['/monitor', 0],
    ]);
    assert.equal(controller.getSlot(1).state, SlotState.PLAYING);
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
        ['/monitor', 0],
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

    await controller.toggleMonitor();
    assert.equal(controller.getState().monitorEnabled, true);
    assert.equal(controller.getState().monitorActive, true);

    controller.applyPdState(['slot1', 'playing']);
    await controller.updateMonitorState();
    assert.equal(controller.getState().monitorActive, false);
    assert.deepEqual(transport.commands, [
        ['/monitor', 1],
        ['/monitor', 0],
    ]);
});

test('Pd-reported playback state updates local monitor active state without sending OSC', async () => {
    const transport = createFakeTransport();
    const controller = createController({ transport });

    await controller.toggleMonitor();
    transport.commands.length = 0;

    controller.applyPdState(['slot1', 'playing']);
    assert.equal(controller.getState().monitorActive, false);
    assert.deepEqual(transport.commands, []);

    controller.applyPdState(['slot1', 'paused']);
    assert.equal(controller.getState().monitorActive, true);
});
