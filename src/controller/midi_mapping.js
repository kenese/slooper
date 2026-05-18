function getSlotControl(runtimeConfig, id) {
    const midi = runtimeConfig.midi || {};
    return midi.slots && midi.slots[`slot${id}`];
}

function createAutoLoopButtons(slotId, autoLoops = {}) {
    return Object.entries(autoLoops).map(([durationKey, control]) => ({
        id: slotId,
        durationKey,
        note: control.note,
        channel: control.channel,
    }));
}

function createTransformButton(slotId, control, factor, label) {
    if (!control) return null;
    return {
        id: slotId,
        note: control.note,
        channel: control.channel,
        factor,
        label,
    };
}

function createEncoderControl(slotId, control, keyPrefix, target) {
    const ccKey = keyPrefix === 'end' ? 'encoderCC' : `${keyPrefix}EncoderCC`;
    const channelKey = keyPrefix === 'end' ? 'encoderChannel' : `${keyPrefix}EncoderChannel`;
    const cc = control[ccKey];
    if (cc === undefined) return null;
    return {
        slotId,
        target,
        controller: cc,
        channel: control[channelKey] ?? control.channel,
    };
}

function buildMidiSlotMappings(runtimeConfig) {
    const buttonSlots = [];
    const autoLoopButtons = [];
    const transformButtons = [];
    const encoderPressButtons = [];
    const encoderControls = [];

    for (const slot of runtimeConfig.slots || []) {
        const control = getSlotControl(runtimeConfig, slot.id);
        if (!control) continue;

        if (control.note !== undefined) {
            buttonSlots.push({
                id: slot.id,
                note: control.note,
                channel: control.channel,
                holdTimer: null,
                actionFired: false,
            });
        }

        autoLoopButtons.push(...createAutoLoopButtons(slot.id, control.autoLoops));
        transformButtons.push(
            createTransformButton(slot.id, control.half, 0.5, 'Half'),
            createTransformButton(slot.id, control.double, 2, 'Double')
        );

        if (control.reset) {
            encoderPressButtons.push({
                id: slot.id,
                note: control.reset.note,
                channel: control.reset.channel,
            });
        }

        encoderControls.push(
            createEncoderControl(slot.id, control, 'end', 'end'),
            createEncoderControl(slot.id, control, 'start', 'start'),
            createEncoderControl(slot.id, control, 'move', 'move')
        );
    }

    return {
        buttonSlots,
        autoLoopButtons,
        transformButtons: transformButtons.filter(Boolean),
        encoderPressButtons,
        encoderControls: encoderControls.filter(Boolean),
    };
}

function findEncoderTarget(encoderControls, msg) {
    const match = encoderControls.find((control) => (
        msg.controller === control.controller && msg.channel === control.channel
    ));
    return match ? { slotId: match.slotId, target: match.target } : null;
}

module.exports = {
    buildMidiSlotMappings,
    findEncoderTarget,
    getSlotControl,
};
