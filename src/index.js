const easymidi = require('easymidi');

const { getRuntimeConfig } = require('./config');
const { createController, SlotState } = require('./controller/slot_controller');
const { JackCaptureRouter } = require('./controller/jack_capture_router');
const { buildMidiSlotMappings, findEncoderTarget } = require('./controller/midi_mapping');
const { OscTransport } = require('./controller/osc_transport');
const { MidiClockTracker, TapTempoTracker, TempoSource } = require('./controller/tempo');
const { createWebServer } = require('./controller/web_server');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

function logSuccess(message) {
    console.log(`${GREEN}${message}${RESET}`);
}

function logError(message) {
    console.error(`${RED}${message}${RESET}`);
}

const args = process.argv.slice(2);
const midiArg = args.find((arg) => arg.startsWith('midi-device='));
const audioArg = args.find((arg) => arg.startsWith('audio-device=') || arg.startsWith('device='));
const midiConfigArg = args.find((arg) => arg.startsWith('--midi-config='));
const audioConfigArg = args.find((arg) => arg.startsWith('--audio-config='));
const channelsArg = args.find((arg) => arg.startsWith('channels='));
const slotsPerChannelArg = args.find((arg) => arg.startsWith('slots-per-channel='));
const midiDeviceName = midiArg ? midiArg.split('=')[1] : 'XONE';
const audioDeviceName = audioArg ? audioArg.split('=')[1] : 'XONE';
const playOnPress = args.includes('play-on-press');

const runtimeConfig = getRuntimeConfig({
    audioDevice: audioDeviceName,
    midiDevice: midiDeviceName,
    audioConfigPath: audioConfigArg ? audioConfigArg.split('=')[1] : undefined,
    midiConfigPath: midiConfigArg ? midiConfigArg.split('=')[1] : undefined,
    channels: channelsArg ? channelsArg.split('=')[1] : undefined,
    slotsPerChannel: slotsPerChannelArg ? slotsPerChannelArg.split('=')[1] : undefined,
});

runtimeConfig.controller.playOnPress = playOnPress;

const midi = runtimeConfig.midi;
console.log(`MIDI Config: ${midi.midiName} (requested: ${midiDeviceName})`);
console.log(`Play Mode: ${playOnPress ? 'on-press (instant)' : 'on-release (default)'}`);

const inputs = easymidi.getInputs();
const inputIndex = inputs.findIndex((name) => name.toLowerCase().includes(midi.midiName.toLowerCase()));

if (inputIndex === -1) {
    logError(`MIDI input device matching "${midi.midiName}" not found.`);
    logError(`Available inputs: ${inputs.join(', ')}`);
    process.exit(1);
}

const inputDeviceName = inputs[inputIndex];

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
        logError(`MIDI output device not found; LEDs disabled. Available: ${outputs.join(', ')}`);
        return null;
    }

    const outputDeviceName = outputs[outputIndex];
    try {
        const output = new easymidi.Output(outputIndex);
        logSuccess(`MIDI Output [${outputIndex}]: ${outputDeviceName}`);
        return output;
    } catch (err) {
        try {
            const output = new easymidi.Output(outputDeviceName);
            logSuccess(`MIDI Output: ${outputDeviceName}`);
            return output;
        } catch (fallbackErr) {
            logError(`Could not open MIDI output; LEDs disabled: ${fallbackErr.message}`);
            return null;
        }
    }
}

let controller;
let webServer = null;
let midiInput = null;
let midiOutput = null;
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
        logSuccess(`MIDI Input [${inputIndex}]: ${inputDeviceName}`);
    } catch (err) {
        logError(err.message);
        logError(`Available inputs: ${inputs.join(', ')}`);
        transport.close();
        process.exit(1);
    }

    const output = openMidiOutput();
    midiInput = input;
    midiOutput = output;
    setupMidiHandlers(input, output);

    if (args.includes('--web')) {
        const WEB_HOST = '127.0.0.1';
        const WEB_PORT = Number(process.env.SLOOPER_WEB_PORT || 3000);
        webServer = createWebServer({ controller, tapTempo, runtimeConfig });
        const existingOnStateChange = controller.onStateChange;
        controller.onStateChange = (state) => {
            existingOnStateChange(state);
            webServer.broadcast(state);
        };
        midiClock.onBeat = () => webServer.broadcast(controller.getState());
        webServer.listen(WEB_PORT, WEB_HOST)
            .then((port) => {
                logSuccess(`Web controller: http://${WEB_HOST}:${port}`);
            })
            .catch((err) => {
                logError(`Web server failed to start on port ${WEB_PORT}: ${err.message}`);
                process.exit(1);
            });
    }
})();

function setupMidiHandlers(input, output) {
    const {
        buttonSlots,
        autoLoopButtons,
        transformButtons,
        encoderPressButtons,
        encoderControls,
    } = buildMidiSlotMappings(runtimeConfig);
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
        slots: runtimeConfig.slots,
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
    setLED(monitorButton, controller.getState().monitorEnabled);
    sourceButtons.forEach((button) => setLED(button, controller.getState().inputRouting.selectedSourceId === button.sourceId));
    controller.updateMonitorState().catch((err) => console.error(err.message));

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

            const encoderPress = encoderPressButtons.find((button) => (
                msg.note === button.note && msg.channel === button.channel
            ));
            if (encoderPress) {
                handleEncoderPress(encoderPress.id);
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
        const encoderTarget = findEncoderTarget(encoderControls, msg);
        if (encoderTarget) handleEncoder(encoderTarget.slotId, msg.value, encoderTarget.target);
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

        if (target === 'move') {
            controller.scheduleMove(slotId, delta, (slot) => {
                const offset = slot.startCropOffset >= 0 ? `+${slot.startCropOffset}` : slot.startCropOffset;
                console.log(`[Slot ${slot.id}] move ${offset}ms`);
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
    if (buttonSlots.length > 0) {
        const buttonSummary = buttonSlots.map((slot) => `[S${slot.id}: ${formatNoteControl(slot)}]`).join(' ');
        console.log(`  TAP           : ${buttonSummary} -> Record/Play/Stop`);
        console.log(`  HOLD (${runtimeConfig.controller.holdThresholdMs}ms): ${buttonSummary} -> Clear Slot`);
    }
    logEncoderControls('END ENCODER', 'end', 'Adjust Loop End');
    logEncoderControls('START ENCODER', 'start', 'Adjust Loop Start');
    logEncoderControls('MOVE ENCODER', 'move', 'Shift Loop Window');
    if (encoderPressButtons.length > 0) {
        console.log(`  ENCODER PRESS : ${encoderPressButtons.map((button) => `[S${button.id}: ${formatNoteControl(button)}]`).join(' ')} -> Reset Length`);
    }
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

    function logEncoderControls(label, target, description) {
        const controls = encoderControls.filter((control) => control.target === target);
        if (controls.length === 0) return;
        console.log(`  ${label.padEnd(13)} : ${controls.map((control) => `[S${control.slotId}: Ch${control.channel} CC${control.controller}]`).join(' ')} -> ${description}`);
    }
}

function handleInputSource(button) {
    controller.selectInputSource(button.sourceId)
        .then(() => console.log(`[Input] ${button.label}`))
        .catch((err) => console.error(err.message));
}

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});

function shutdown() {
    const close = webServer ? webServer.close() : Promise.resolve();
    close.finally(() => {
        if (midiInput) midiInput.close();
        if (midiOutput) midiOutput.close();
        transport.close();
        process.exit(0);
    });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
