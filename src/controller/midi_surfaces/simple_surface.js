const { buildMidiSlotMappings, findEncoderTarget } = require('../midi_mapping');

function setup(context) {
    const {
        input,
        output,
        runtimeConfig,
        midi,
        transport,
        tempo,
        tapTempo,
        midiClock,
        playOnPress,
        createController,
        SlotState,
        JackCaptureRouter,
        onControllerCreated,
    } = context;

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

    const controller = createController({
        transport,
        config: runtimeConfig.controller,
        slots: runtimeConfig.slots,
        tempo,
        inputSources: runtimeConfig.audio.captureSources,
        outputDestinations: runtimeConfig.audio.playbackPortPairs,
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

    onControllerCreated(controller);

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

    function handleInputSource(button) {
        controller.selectInputSource(button.sourceId)
            .then(() => console.log(`[Input] ${button.label}`))
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

    return { controller };
}

module.exports = {
    name: 'simple',
    setup,
};
