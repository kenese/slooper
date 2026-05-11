const easymidi = require('easymidi');

const { getRuntimeConfig } = require('./config');
const { createController, SlotState } = require('./controller/slot_controller');
const { OscTransport } = require('./controller/osc_transport');

const args = process.argv.slice(2);
const midiArg = args.find((arg) => arg.startsWith('midi-device='));
const audioArg = args.find((arg) => arg.startsWith('audio-device=') || arg.startsWith('device='));
const midiDeviceName = midiArg ? midiArg.split('=')[1] : 'XONE';
const audioDeviceName = audioArg ? audioArg.split('=')[1] : 'XONE';
const playOnPress = args.includes('play-on-press');

const runtimeConfig = getRuntimeConfig({
    audioDevice: audioDeviceName,
    midiDevice: midiDeviceName,
});

runtimeConfig.controller.playOnPress = playOnPress;

const midi = runtimeConfig.midi;
console.log(`MIDI Config: ${midi.midiName} (requested: ${midiDeviceName})`);
console.log(`Play Mode: ${playOnPress ? 'on-press (instant)' : 'on-release (default)'}`);

const inputs = easymidi.getInputs();
const inputIndex = inputs.findIndex((name) => name.toLowerCase().includes(midi.midiName.toLowerCase()));

if (inputIndex === -1) {
    console.error(`MIDI input device matching "${midi.midiName}" not found.`);
    console.error('Available inputs:', inputs);
    process.exit(1);
}

const inputDeviceName = inputs[inputIndex];
console.log(`MIDI Input [${inputIndex}]: ${inputDeviceName}`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function openMidiInput() {
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`   Attempt ${attempt}: Opening by index ${inputIndex}...`);
            return new easymidi.Input(inputIndex);
        } catch (err) {
            console.log(`   Index failed: ${err.message}`);
        }

        try {
            console.log(`   Attempt ${attempt}: Opening by name "${inputDeviceName}"...`);
            return new easymidi.Input(inputDeviceName);
        } catch (err) {
            console.log(`   Name failed: ${err.message}`);
        }

        try {
            const shortName = inputs.find((name) => name.includes('XONE'));
            if (shortName) {
                console.log(`   Attempt ${attempt}: Opening "${shortName}"...`);
                return new easymidi.Input(shortName);
            }
        } catch (err) {
            console.log(`   Short name failed: ${err.message}`);
        }

        if (attempt < maxRetries) {
            console.warn(`   All strategies failed (attempt ${attempt}/${maxRetries}), retrying in 1s...`);
            await sleep(1000);
        }
    }

    throw new Error(`Failed to open MIDI input after ${maxRetries} attempts`);
}

function openMidiOutput() {
    const outputs = easymidi.getOutputs();
    const outputIndex = outputs.findIndex((name) => name.toLowerCase().includes(midi.midiName.toLowerCase()));

    if (outputIndex === -1) {
        console.warn('MIDI output device not found; LEDs disabled. Available:', outputs);
        return null;
    }

    const outputDeviceName = outputs[outputIndex];
    try {
        const output = new easymidi.Output(outputIndex);
        console.log(`MIDI Output [${outputIndex}]: ${outputDeviceName}`);
        return output;
    } catch (err) {
        try {
            const output = new easymidi.Output(outputDeviceName);
            console.log(`MIDI Output: ${outputDeviceName}`);
            return output;
        } catch (fallbackErr) {
            console.warn(`Could not open MIDI output; LEDs disabled: ${fallbackErr.message}`);
            return null;
        }
    }
}

let controller;
const transport = new OscTransport({
    host: runtimeConfig.osc.host,
    sendPort: runtimeConfig.osc.sendPort,
    statePort: Number(process.env.SLOOPER_OSC_STATE_PORT || runtimeConfig.osc.statePort),
    onState: (state) => {
        if (controller) controller.applyPdState(state);
    },
});

(async () => {
    let input;
    try {
        input = await openMidiInput();
    } catch (err) {
        console.error(err.message);
        console.error('Available inputs:', inputs);
        transport.close();
        process.exit(1);
    }

    const output = openMidiOutput();
    setupMidiHandlers(input, output);
})();

function setupMidiHandlers(input, output) {
    const buttonSlots = [
        { id: 1, note: midi.slot1.note, channel: midi.slot1.channel, holdTimer: null, actionFired: false },
        { id: 2, note: midi.slot2.note, channel: midi.slot2.channel, holdTimer: null, actionFired: false },
    ];
    const monitorButton = { note: midi.monitor.note, channel: midi.monitor.channel };

    function setLED(target, on) {
        if (!output) return;
        output.send('noteon', {
            note: target.note,
            velocity: on ? 127 : 0,
            channel: target.channel,
        });
    }

    function flashLED(target, times, intervalMs) {
        let count = 0;
        const flash = () => {
            if (count >= times * 2) {
                setLED(target, false);
                return;
            }
            setLED(target, count % 2 === 0);
            count++;
            setTimeout(flash, intervalMs);
        };
        flash();
    }

    controller = createController({
        transport,
        config: runtimeConfig.controller,
        onStateChange: (state) => {
            for (const slotState of state.slots) {
                const buttonSlot = buttonSlots.find((slot) => slot.id === slotState.id);
                if (buttonSlot) {
                    setLED(buttonSlot, slotState.state === SlotState.RECORDING || slotState.state === SlotState.PLAYING);
                }
            }
            setLED(monitorButton, state.monitorEnabled);
        },
    });

    buttonSlots.forEach((slot) => setLED(slot, false));
    setLED(monitorButton, false);

    input.on('noteon', (msg) => {
        if (msg.note === monitorButton.note && msg.channel === monitorButton.channel && msg.velocity > 0) {
            handleMonitorToggle();
            return;
        }

        if (msg.velocity > 0) {
            if (msg.note === midi.encoderPress1.note && msg.channel === midi.encoderPress1.channel) {
                handleEncoderPress(1);
                return;
            }
            if (msg.note === midi.encoderPress2.note && msg.channel === midi.encoderPress2.channel) {
                handleEncoderPress(2);
                return;
            }
        }

        const slot = buttonSlots.find((candidate) => candidate.note === msg.note && candidate.channel === msg.channel);
        if (!slot) return;

        if (msg.velocity === 0) {
            handleRelease(slot);
            return;
        }

        slot.actionFired = false;
        slot.holdTimer = setTimeout(() => {
            handleClear(slot);
            slot.actionFired = true;
            slot.holdTimer = null;
        }, runtimeConfig.controller.holdThresholdMs);

        const state = controller.getSlot(slot.id).state;
        if (state === SlotState.STOPPED && playOnPress) {
            handleTap(slot.id);
            slot.actionFired = true;
        }
    });

    input.on('noteoff', (msg) => {
        const slot = buttonSlots.find((candidate) => candidate.note === msg.note && candidate.channel === msg.channel);
        if (slot) handleRelease(slot);
    });

    input.on('cc', (msg) => {
        let slotId = null;
        if (msg.controller === midi.slot1.encoderCC) slotId = 1;
        else if (msg.controller === midi.slot2.encoderCC) slotId = 2;
        if (slotId) handleEncoder(slotId, msg.value);
    });

    function handleRelease(slot) {
        if (slot.holdTimer) {
            clearTimeout(slot.holdTimer);
            slot.holdTimer = null;
        }

        if (!slot.actionFired) {
            handleTap(slot.id);
        }

        slot.actionFired = false;
    }

    function handleEncoder(slotId, value) {
        let delta = 0;
        if (value > 64) delta = runtimeConfig.controller.cropStepMs;
        else if (value < 64) delta = -runtimeConfig.controller.cropStepMs;

        if (delta === 0) return;

        controller.scheduleCrop(slotId, delta, (slot) => {
            const offset = slot.cropOffset >= 0 ? `+${slot.cropOffset}` : slot.cropOffset;
            console.log(`[Slot ${slot.id}] loop: ${slot.lengthMs + slot.cropOffset}ms [crop ${offset}ms]`);
        });
    }

    function handleEncoderPress(slotId) {
        const slot = controller.getSlot(slotId);
        if (!slot || slot.state !== SlotState.PLAYING) return;
        console.log(`[Slot ${slotId}] loop: ${slot.lengthMs}ms [crop 0ms] (reset)`);
        controller.resetSlot(slotId).catch((err) => console.error(err.message));
    }

    function handleMonitorToggle() {
        controller.toggleMonitor().catch((err) => console.error(err.message));
        console.log(`[Monitor] ${controller.getState().monitorEnabled ? 'ON' : 'OFF'}`);
    }

    function handleClear(buttonSlot) {
        console.log(`[Slot ${buttonSlot.id}] CLEARED (Hold ${runtimeConfig.controller.holdThresholdMs}ms)`);
        controller.clearSlot(buttonSlot.id)
            .then(() => flashLED(buttonSlot, 3, 100))
            .catch((err) => console.error(err.message));
    }

    function handleTap(slotId) {
        const before = controller.getSlot(slotId).state;
        controller.tapSlot(slotId)
            .then(() => {
                const after = controller.getSlot(slotId).state;
                if (before === SlotState.EMPTY) console.log(`[Slot ${slotId}] Rec Start`);
                else if (before === SlotState.RECORDING) console.log(`[Slot ${slotId}] Rec Stop -> Play`);
                else if (after === SlotState.STOPPED) console.log(`[Slot ${slotId}] Stopped`);
                else if (after === SlotState.PLAYING) console.log(`[Slot ${slotId}] Resuming`);
            })
            .catch((err) => console.error(err.message));
    }

    console.log('');
    console.log('Controls (Runtime MIDI Values):');
    console.log(`  TAP           : [S1: Ch${midi.slot1.channel} N${midi.slot1.note}] [S2: Ch${midi.slot2.channel} N${midi.slot2.note}] -> Record/Play/Stop`);
    console.log(`  HOLD (${runtimeConfig.controller.holdThresholdMs}ms): [S1: Ch${midi.slot1.channel} N${midi.slot1.note}] [S2: Ch${midi.slot2.channel} N${midi.slot2.note}] -> Clear Slot`);
    console.log(`  ENCODER ROTATE: [S1: Ch${midi.slot1.channel} CC${midi.slot1.encoderCC}] [S2: Ch${midi.slot2.channel} CC${midi.slot2.encoderCC}] -> Adjust Length`);
    console.log(`  ENCODER PRESS : [S1: Ch${midi.encoderPress1.channel} N${midi.encoderPress1.note}] [S2: Ch${midi.encoderPress2.channel} N${midi.encoderPress2.note}] -> Reset Length`);
    console.log(`  MONITOR       : Ch${midi.monitor.channel} N${midi.monitor.note} -> Toggle (mutes when loop plays)`);
    console.log('');
}

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

function shutdown() {
    transport.close();
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
