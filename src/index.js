const easymidi = require('easymidi');

const { getRuntimeConfig } = require('./config');
const { createController, SlotState } = require('./controller/slot_controller');
const { JackCaptureRouter } = require('./controller/jack_capture_router');
const { OscTransport } = require('./controller/osc_transport');
const { MidiClockTracker, TapTempoTracker, TempoSource } = require('./controller/tempo');

const args = process.argv.slice(2);
const midiArg = args.find((arg) => arg.startsWith('midi-device='));
const audioArg = args.find((arg) => arg.startsWith('audio-device=') || arg.startsWith('device='));
const midiConfigArg = args.find((arg) => arg.startsWith('--midi-config='));
const audioConfigArg = args.find((arg) => arg.startsWith('--audio-config='));
const midiDeviceName = midiArg ? midiArg.split('=')[1] : 'XONE';
const audioDeviceName = audioArg ? audioArg.split('=')[1] : 'XONE';
const playOnPress = args.includes('play-on-press');

const runtimeConfig = getRuntimeConfig({
    audioDevice: audioDeviceName,
    midiDevice: midiDeviceName,
    audioConfigPath: audioConfigArg ? audioConfigArg.split('=')[1] : undefined,
    midiConfigPath: midiConfigArg ? midiConfigArg.split('=')[1] : undefined,
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
            const shortName = inputs.find((name) => name.toLowerCase().includes(midi.midiName.toLowerCase()));
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
const midiClock = new MidiClockTracker();
const tapTempo = new TapTempoTracker();
const tempo = new TempoSource({ clock: midiClock, tap: tapTempo });
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
    const autoLoopButtons = [
        ...createAutoLoopButtons(1, midi.slot1.autoLoops),
        ...createAutoLoopButtons(2, midi.slot2.autoLoops),
    ];
    const transformButtons = [
        createTransformButton(1, midi.slot1.half, 0.5, 'Half'),
        createTransformButton(1, midi.slot1.double, 2, 'Double'),
        createTransformButton(2, midi.slot2.half, 0.5, 'Half'),
        createTransformButton(2, midi.slot2.double, 2, 'Double'),
    ].filter(Boolean);
    const monitorButton = { note: midi.monitor.note, channel: midi.monitor.channel };
    const sourceButtons = (midi.captureSources || [])
        .map((control, index) => {
            const source = runtimeConfig.audio.captureSources[index];
            return source ? { ...control, sourceId: source.id, label: source.label } : null;
        })
        .filter(Boolean);

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
        tempo,
        inputSources: runtimeConfig.audio.captureSources,
        inputRouter: runtimeConfig.platform === 'linux' && runtimeConfig.audio.mode === 'jack'
            ? new JackCaptureRouter()
            : null,
        onStateChange: (state) => {
            for (const slotState of state.slots) {
                const buttonSlot = buttonSlots.find((slot) => slot.id === slotState.id);
                if (buttonSlot) {
                    setLED(buttonSlot, [SlotState.PENDING, SlotState.RECORDING, SlotState.PLAYING].includes(slotState.state));
                }
            }
            setLED(monitorButton, state.monitorEnabled);
            for (const sourceButton of sourceButtons) {
                setLED(sourceButton, state.inputRouting.selectedSourceId === sourceButton.sourceId);
            }
        },
    });

    buttonSlots.forEach((slot) => setLED(slot, false));
    setLED(monitorButton, false);
    sourceButtons.forEach((button) => setLED(button, controller.getState().inputRouting.selectedSourceId === button.sourceId));

    input.on('clock', () => midiClock.tick());
    input.on('start', () => midiClock.reset());
    input.on('continue', () => midiClock.reset());
    input.on('stop', () => midiClock.reset());

    input.on('noteon', (msg) => {
        if (msg.note === monitorButton.note && msg.channel === monitorButton.channel && msg.velocity > 0) {
            handleMonitorToggle();
            return;
        }

        if (msg.velocity > 0) {
            if (midi.tapTempo && msg.note === midi.tapTempo.note && msg.channel === midi.tapTempo.channel) {
                handleTapTempo();
                return;
            }

            const sourceButton = sourceButtons.find((button) => button.note === msg.note && button.channel === msg.channel);
            if (sourceButton) {
                handleInputSource(sourceButton);
                return;
            }

            const autoLoop = autoLoopButtons.find((button) => button.note === msg.note && button.channel === msg.channel);
            if (autoLoop) {
                handleAutoLoop(autoLoop);
                return;
            }

            const transform = transformButtons.find((button) => button.note === msg.note && button.channel === msg.channel);
            if (transform) {
                handleTransform(transform);
                return;
            }

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
        let target = 'end';
        if (msg.controller === midi.slot1.encoderCC && msg.channel === (midi.slot1.encoderChannel ?? midi.slot1.channel)) slotId = 1;
        else if (msg.controller === midi.slot2.encoderCC && msg.channel === (midi.slot2.encoderChannel ?? midi.slot2.channel)) slotId = 2;
        else if (midi.slot1.startEncoderCC !== undefined && msg.controller === midi.slot1.startEncoderCC && msg.channel === (midi.slot1.startEncoderChannel ?? midi.slot1.channel)) {
            slotId = 1;
            target = 'start';
        } else if (midi.slot2.startEncoderCC !== undefined && msg.controller === midi.slot2.startEncoderCC && msg.channel === (midi.slot2.startEncoderChannel ?? midi.slot2.channel)) {
            slotId = 2;
            target = 'start';
        }
        if (slotId) handleEncoder(slotId, msg.value, target);
    });

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

    function handleEncoder(slotId, value, target) {
        let delta = 0;
        if (value > 64) delta = runtimeConfig.controller.cropStepMs;
        else if (value < 64) delta = -runtimeConfig.controller.cropStepMs;

        if (delta === 0) return;

        if (target === 'start') {
            controller.scheduleStartCrop(slotId, delta, (slot) => {
                const offset = slot.startCropOffset >= 0 ? `+${slot.startCropOffset}` : slot.startCropOffset;
                console.log(`[Slot ${slot.id}] start crop ${offset}ms`);
            });
            return;
        }

        controller.scheduleCrop(slotId, delta, (slot) => {
            const offset = slot.cropOffset >= 0 ? `+${slot.cropOffset}` : slot.cropOffset;
            console.log(`[Slot ${slot.id}] loop: ${slot.lengthMs + slot.cropOffset - slot.startCropOffset}ms [end crop ${offset}ms]`);
        });
    }

    function handleEncoderPress(slotId) {
        const slot = controller.getSlot(slotId);
        if (!slot || slot.state !== SlotState.PLAYING) return;
        console.log(`[Slot ${slotId}] loop: ${slot.lengthMs}ms [start/end crop 0ms] (reset)`);
        controller.resetSlot(slotId).catch((err) => console.error(err.message));
    }

    function handleMonitorToggle() {
        controller.toggleMonitor().catch((err) => console.error(err.message));
        console.log(`[Monitor] ${controller.getState().monitorEnabled ? 'ON' : 'OFF'}`);
    }

    function handleTapTempo() {
        tapTempo.tap(Date.now());
        const bpm = tapTempo.getBpm();
        console.log(`[Tempo] Tap${bpm ? ` ${bpm.toFixed(1)} BPM` : ''}`);
    }

    function handleAutoLoop(button) {
        controller.autoLoopSlot(button.id, button.durationKey)
            .then((result) => {
                if (!result.ok) {
                    console.log(`[Slot ${button.id}] auto ${button.durationKey}: ${result.reason}`);
                    return;
                }
                console.log(`[Slot ${button.id}] auto ${button.durationKey}: ${Math.round(result.durationMs)}ms (${result.source})`);
            })
            .catch((err) => console.error(err.message));
    }

    function handleTransform(button) {
        controller.multiplySlotLength(button.id, button.factor)
            .then((result) => {
                if (!result.ok) {
                    console.log(`[Slot ${button.id}] ${button.label}: ${result.reason}`);
                    return;
                }
                console.log(`[Slot ${button.id}] ${button.label}: ${Math.round(result.durationMs)}ms`);
            })
            .catch((err) => console.error(err.message));
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

    function formatNoteControl(control) {
        return `Ch${control.channel} N${control.note}`;
    }

    console.log('');
    console.log('Controls (Runtime MIDI Values):');
    console.log(`  TAP           : [S1: Ch${midi.slot1.channel} N${midi.slot1.note}] [S2: Ch${midi.slot2.channel} N${midi.slot2.note}] -> Record/Play/Stop`);
    console.log(`  HOLD (${runtimeConfig.controller.holdThresholdMs}ms): [S1: Ch${midi.slot1.channel} N${midi.slot1.note}] [S2: Ch${midi.slot2.channel} N${midi.slot2.note}] -> Clear Slot`);
    console.log(`  END ENCODER   : [S1: Ch${midi.slot1.encoderChannel ?? midi.slot1.channel} CC${midi.slot1.encoderCC}] [S2: Ch${midi.slot2.encoderChannel ?? midi.slot2.channel} CC${midi.slot2.encoderCC}] -> Adjust Loop End`);
    if (midi.slot1.startEncoderCC !== undefined || midi.slot2.startEncoderCC !== undefined) {
        const s1 = midi.slot1.startEncoderCC !== undefined ? `Ch${midi.slot1.startEncoderChannel ?? midi.slot1.channel} CC${midi.slot1.startEncoderCC}` : 'not mapped';
        const s2 = midi.slot2.startEncoderCC !== undefined ? `Ch${midi.slot2.startEncoderChannel ?? midi.slot2.channel} CC${midi.slot2.startEncoderCC}` : 'not mapped';
        console.log(`  START ENCODER : [S1: ${s1}] [S2: ${s2}] -> Adjust Loop Start`);
    }
    console.log(`  ENCODER PRESS : [S1: Ch${midi.encoderPress1.channel} N${midi.encoderPress1.note}] [S2: Ch${midi.encoderPress2.channel} N${midi.encoderPress2.note}] -> Reset Length`);
    if (autoLoopButtons.length > 0) {
        console.log(`  AUTO LOOP     : ${autoLoopButtons.map((button) => `[S${button.id} ${button.durationKey}: ${formatNoteControl(button)}]`).join(' ')}`);
    }
    if (transformButtons.length > 0) {
        console.log(`  HALF/DOUBLE   : ${transformButtons.map((button) => `[S${button.id} ${button.label}: ${formatNoteControl(button)}]`).join(' ')}`);
    }
    if (midi.tapTempo) {
        console.log(`  TAP TEMPO     : ${formatNoteControl(midi.tapTempo)}`);
    }
    if (sourceButtons.length > 0) {
        console.log(`  INPUT SOURCE  : ${sourceButtons.map((button) => `[${button.label}: ${formatNoteControl(button)}]`).join(' ')}`);
    }
    console.log(`  MONITOR       : Ch${midi.monitor.channel} N${midi.monitor.note} -> Toggle (mutes when loop plays)`);
    console.log('');
}

function handleInputSource(button) {
    controller.selectInputSource(button.sourceId)
        .then(() => console.log(`[Input] ${button.label}`))
        .catch((err) => console.error(err.message));
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
