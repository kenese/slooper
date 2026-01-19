const easymidi = require('easymidi');
const { Client } = require('node-osc');

// --- CONFIGURATION ---
const CONFIG = {
    oscIp: '127.0.0.1',
    oscPort: 9000,
    throttleMs: 50, // Minimum time between encoder updates

    midi: {
        XONE: {
            midiName: 'XONE',
            slot1: { note: 14, channel: 15, encoderCC: 7 },
            slot2: { note: 15, channel: 15, encoderCC: 7 },
            monitor1: { note: 10, channel: 15 },
            monitor2: { note: 36, channel: 15 },
            encoderPress1: { note: 28, channel: 15 },
            encoderPress2: { note: 38, channel: 15 },
        },
        X1MK3: {
            midiName: 'TRAKTOR X1MK3',
            slot1: { note: 10, channel: 0, encoderCC: 20 },  // UPDATE encoderCC after running midi_logger
            slot2: { note: 10, channel: 1, encoderCC: 21 },  // UPDATE encoderCC after running midi_logger
            monitor1: { note: 11, channel: 0 },
            monitor2: { note: 11, channel: 1 },
            encoderPress1: { note: 20, channel: 0 },
            encoderPress2: { note: 21, channel: 0 },
        },
    },
    holdThresholdMs: 500,
    ledVelocityOn: 127,
    ledVelocityOff: 0,
    cropStepMs: 30,  // Milliseconds per encoder tick
};

// --- SETUP ---
const client = new Client(CONFIG.oscIp, CONFIG.oscPort);
const inputs = easymidi.getInputs();

// Parse command line arguments
const args = process.argv.slice(2);
const midiArg = args.find(arg => arg.startsWith('midi-device='));
const midiDeviceName = midiArg ? midiArg.split('=')[1] : 'XONE';

const midi = CONFIG.midi[midiDeviceName] || CONFIG.midi.XONE;
console.log(`MIDI Config: ${midi.midiName} (requested: ${midiDeviceName})`);

// Find input port matching our device
const inputIndex = inputs.findIndex(n => n.toLowerCase().includes(midi.midiName.toLowerCase()));

if (inputIndex === -1) {
    console.error(`❌ MIDI Input device matching "${midi.midiName}" not found.`);
    console.error(`Available inputs: `, inputs);
    process.exit(1);
}

const inputDeviceName = inputs[inputIndex];
console.log(`✅ MIDI Input [${inputIndex}]: ${inputDeviceName}`);

// Helper function to sleep
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// On Linux, MIDI ports can be flaky - try multiple approaches
let input;
const openMidiInput = async () => {
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        // Strategy 1: Try by index
        try {
            console.log(`   Attempt ${attempt}: Opening by index ${inputIndex}...`);
            return new easymidi.Input(inputIndex);
        } catch (err1) {
            console.log(`   Index failed: ${err1.message}`);
        }

        // Strategy 2: Try by full name
        try {
            console.log(`   Attempt ${attempt}: Opening by name "${inputDeviceName}"...`);
            return new easymidi.Input(inputDeviceName);
        } catch (err2) {
            console.log(`   Name failed: ${err2.message}`);
        }

        // Strategy 3: Try with just "XONE:PX5" (shorter name)
        try {
            const shortName = inputs.find(n => n.includes('XONE'));
            if (shortName) {
                console.log(`   Attempt ${attempt}: Opening "${shortName}"...`);
                return new easymidi.Input(shortName);
            }
        } catch (err3) {
            console.log(`   Short name failed: ${err3.message}`);
        }

        if (attempt < maxRetries) {
            console.warn(`   ⚠️  All strategies failed (attempt ${attempt}/${maxRetries}), retrying in 1s...`);
            await sleep(1000);
        } else {
            throw new Error(`Failed to open MIDI input after ${maxRetries} attempts`);
        }
    }
};

// Immediately-invoked async to handle the MIDI opening
(async () => {
    try {
        input = await openMidiInput();
    } catch (err) {
        console.error(`❌ ${err.message}`);
        console.error(`   Available inputs:`, inputs);
        process.exit(1);
    }

    // Continue with the rest of setup after MIDI is open
    setupMidiHandlers();
})();

function setupMidiHandlers() {

    // Find output port matching our device
    const outputs = easymidi.getOutputs();
    const outputIndex = outputs.findIndex(n => n.toLowerCase().includes(midi.midiName.toLowerCase()));

    let output = null;
    if (outputIndex !== -1) {
        const outputDeviceName = outputs[outputIndex];
        try {
            // Try opening by index first
            output = new easymidi.Output(outputIndex);
            console.log(`✅ MIDI Output [${outputIndex}]: ${outputDeviceName}`);
        } catch (err) {
            try {
                output = new easymidi.Output(outputDeviceName);
                console.log(`✅ MIDI Output: ${outputDeviceName}`);
            } catch (err2) {
                console.warn(`⚠️  Could not open MIDI output (LEDs disabled): ${err2.message}`);
            }
        }
    } else {
        console.warn(`⚠️  MIDI Output device not found (LEDs disabled). Available: `, outputs);
    }

    // State: 0=EMPTY, 1=RECORDING, 2=PLAYING, 3=STOPPED
    let slots = [
        { id: 1, state: 0, note: midi.slot1.note, channel: midi.slot1.channel, holdTimer: null, actionFired: false },
        { id: 2, state: 0, note: midi.slot2.note, channel: midi.slot2.channel, holdTimer: null, actionFired: false }
    ];

    // Monitoring state - single monitor (muted when any loop is playing)
    let monitorEnabled = false;
    const monitorButton = { note: midi.monitor1.note, channel: midi.monitor1.channel };

    // Crop tracking per slot
    // Crop tracking per slot
    let cropState = [
        { recordStartTime: 0, originalLength: 0, cropOffset: 0, pendingDelta: 0, updateTimer: null },
        { recordStartTime: 0, originalLength: 0, cropOffset: 0, pendingDelta: 0, updateTimer: null }
    ];

    // --- LED CONTROL ---
    function setLED(slot, on) {
        if (!output) return;  // Skip if no MIDI output available
        output.send('noteon', {
            note: slot.note,
            velocity: on ? CONFIG.ledVelocityOn : CONFIG.ledVelocityOff,
            channel: slot.channel
        });
    }

    function flashLED(slot, times, intervalMs) {
        let count = 0;
        const flash = () => {
            if (count >= times * 2) {
                setLED(slot, false);  // End with LED off
                return;
            }
            setLED(slot, count % 2 === 0);  // Toggle on/off
            count++;
            setTimeout(flash, intervalMs);
        };
        flash();
    }

    // Initialize LEDs to off on startup
    slots.forEach(slot => setLED(slot, false));
    setLED(monitorButton, false);

    // --- LOGIC ---

    // Handle button press (noteon with velocity > 0)
    input.on('noteon', (msg) => {
        // Check if it's the monitor button
        if (msg.note === monitorButton.note && msg.channel === monitorButton.channel && msg.velocity > 0) {
            handleMonitorToggle();
            return;
        }

        // Check if it's an encoder press (reset loop length)
        if (msg.velocity > 0) {
            if (msg.note === midi.encoderPress1.note && msg.channel === midi.encoderPress1.channel) {
                handleEncoderPress(slots[0]);
                return;
            }
            if (msg.note === midi.encoderPress2.note && msg.channel === midi.encoderPress2.channel) {
                handleEncoderPress(slots[1]);
                return;
            }
        }

        let slot = slots.find(s => s.note === msg.note && s.channel === msg.channel);
        if (!slot) return;

        if (msg.velocity === 0) {
            // This is actually a button release
            handleRelease(slot);
        } else {
            // Button pressed - start hold timer
            slot.actionFired = false;

            // Start a timer that fires clear after holdThresholdMs
            slot.holdTimer = setTimeout(() => {
                handleClear(slot);
                slot.actionFired = true;
                slot.holdTimer = null;
            }, CONFIG.holdThresholdMs);

            // For STOPPED state, trigger resume immediately on press for low latency
            // For PLAYING state, wait for release so hold-to-clear keeps playing
            if (slot.state === 3) {
                handleTap(slot);
                slot.actionFired = true;
            }
        }
    });

    // Handle button release (noteoff)
    input.on('noteoff', (msg) => {
        let slot = slots.find(s => s.note === msg.note && s.channel === msg.channel);
        if (!slot) return;
        handleRelease(slot);
    });

    // Handle encoder for loop length adjustment
    input.on('cc', (msg) => {
        let slot = null;
        if (msg.controller === midi.slot1.encoderCC) {
            slot = slots[0];
        } else if (msg.controller === midi.slot2.encoderCC) {
            slot = slots[1];
        }
        if (slot) handleEncoder(slot, msg.value);
    });

    function handleRelease(slot) {
        // Cancel hold timer if still running
        if (slot.holdTimer) {
            clearTimeout(slot.holdTimer);
            slot.holdTimer = null;
        }

        // If action wasn't already fired, fire it now (for EMPTY and RECORDING states)
        if (!slot.actionFired) {
            handleTap(slot);
        }

        slot.actionFired = false;
    }

    function handleEncoder(slot, value) {
        // Only adjust if slot is actively playing (state 2=PLAYING)
        if (slot.state !== 2) return;

        // Calculate delta for endless encoder (64 = no change, <64 = CCW, >64 = CW)
        let delta = 0;
        if (value > 64) {
            delta = CONFIG.cropStepMs;  // Clockwise = extend
        } else if (value < 64) {
            delta = -CONFIG.cropStepMs;  // Counter-clockwise = shorten
        }

        if (delta !== 0) {
            const idx = slot.id - 1;

            // Add to pending delta
            cropState[idx].pendingDelta += delta;

            // If no timer is running, schedule an update
            if (!cropState[idx].updateTimer) {
                cropState[idx].updateTimer = setTimeout(() => {
                    processEncoderUpdate(slot);
                }, CONFIG.throttleMs);
            }
        }
    }

    function processEncoderUpdate(slot) {
        const idx = slot.id - 1;
        const delta = cropState[idx].pendingDelta;

        // Reset pending/timer stuff first
        cropState[idx].pendingDelta = 0;
        cropState[idx].updateTimer = null;

        if (delta === 0) return;

        const addr = `/slot${slot.id}`;
        cropState[idx].cropOffset += delta;
        const currentLength = cropState[idx].originalLength + cropState[idx].cropOffset;
        const offsetStr = cropState[idx].cropOffset >= 0 ? `+${cropState[idx].cropOffset}` : cropState[idx].cropOffset;

        console.log(`[Slot ${slot.id}] loop: ${currentLength}ms [crop ${offsetStr}ms]`);
        client.send(addr, 'crop', delta);
    }

    function handleEncoderPress(slot) {
        // Only reset if slot is actively playing (state 2=PLAYING)
        if (slot.state !== 2) return;

        const addr = `/slot${slot.id}`;
        const idx = slot.id - 1;
        cropState[idx].cropOffset = 0;
        console.log(`[Slot ${slot.id}] loop: ${cropState[idx].originalLength}ms [crop 0ms] (reset)`);
        client.send(addr, 'reset', 1);
    }

    function handleMonitorToggle() {
        monitorEnabled = !monitorEnabled;
        console.log(`[Monitor] ${monitorEnabled ? 'ON' : 'OFF'}`);
        setLED(monitorButton, monitorEnabled);
        updateMonitorState();
    }

    function updateMonitorState() {
        // Monitor is active if: monitor enabled AND no slot is playing
        const anyPlaying = slots.some(s => s.state === 2);
        const shouldMonitor = monitorEnabled && !anyPlaying;
        client.send('/monitor', shouldMonitor ? 1 : 0);
    }

    function handleClear(slot) {
        const addr = `/slot${slot.id}`;
        const idx = slot.id - 1;
        console.log(`[Slot ${slot.id}] CLEARED (Hold 1s)`);

        // Explicitly stop playback first
        client.send(addr, 'play', 0);

        client.send(addr, 'clear', 1);
        slot.state = 0;

        // Reset crop state
        cropState[idx].originalLength = 0;
        cropState[idx].cropOffset = 0;
        cropState[idx].pendingDelta = 0;
        if (cropState[idx].updateTimer) {
            clearTimeout(cropState[idx].updateTimer);
            cropState[idx].updateTimer = null;
        }

        // Flash LED 3 times to indicate clear
        flashLED(slot, 3, 100);
        updateMonitorState();  // Re-evaluate monitoring
    }

    function handleTap(slot) {
        const addr = `/slot${slot.id}`;
        const idx = slot.id - 1;

        if (slot.state === 0) {
            console.log(`[Slot ${slot.id}] Rec Start`);
            cropState[idx].recordStartTime = Date.now();
            cropState[idx].cropOffset = 0;
            client.send(addr, 'rec', 1);
            slot.state = 1;
            setLED(slot, true);
        }
        else if (slot.state === 1) {
            const recordedMs = Date.now() - cropState[idx].recordStartTime;
            cropState[idx].originalLength = recordedMs;
            console.log(`[Slot ${slot.id}] Rec Stop -> Play | loop: ${recordedMs}ms`);
            client.send(addr, 'rec', 0);
            client.send(addr, 'play', 1);
            slot.state = 2;
            setLED(slot, true);
            updateMonitorState();  // Mute monitoring when playing starts
        }
        else if (slot.state === 2) {
            console.log(`[Slot ${slot.id}] Stopped`);
            client.send(addr, 'play', 0);
            slot.state = 3;
            setLED(slot, false);
            updateMonitorState();  // Re-evaluate monitoring when stopped
        }
        else if (slot.state === 3) {
            console.log(`[Slot ${slot.id}] Resuming`);
            client.send(addr, 'play', 1);
            slot.state = 2;
            setLED(slot, true);
            updateMonitorState();  // Mute monitoring when playing resumes
        }
    }

    console.log('');
    console.log('Controls (Runtime MIDI Values):');
    console.log(`  TAP           : [S1: Ch${midi.slot1.channel} N${midi.slot1.note}] [S2: Ch${midi.slot2.channel} N${midi.slot2.note}] -> Record/Play/Stop`);
    console.log(`  HOLD (1s)     : [S1: Ch${midi.slot1.channel} N${midi.slot1.note}] [S2: Ch${midi.slot2.channel} N${midi.slot2.note}] -> Clear Slot`);
    console.log(`  ENCODER ROTATE: [S1: Ch${midi.slot1.channel} CC${midi.slot1.encoderCC}] [S2: Ch${midi.slot2.channel} CC${midi.slot2.encoderCC}] -> Adjust Length`);
    console.log(`  ENCODER PRESS : [S1: Ch${midi.encoderPress1.channel} N${midi.encoderPress1.note}] [S2: Ch${midi.encoderPress2.channel} N${midi.encoderPress2.note}] -> Reset Length`);
    console.log(`  MONITOR       : Ch${midi.monitor1.channel} N${midi.monitor1.note} -> Toggle (mutes when loop plays)`);
    console.log(`  LED           : [S1: Ch${midi.slot1.channel} N${midi.slot1.note}] [S2: Ch${midi.slot2.channel} N${midi.slot2.note}] -> Visual Feedback`);
    console.log('');

    // --- ERROR HANDLING ---
    process.on('uncaughtException', (err) => {
        console.error('⚠️  Uncaught Exception:', err);
        // Don't exit immediately, try to keep running if possible, 
        // but typically Napi::Error means native module trouble.
    });

    process.on('unhandledRejection', (reason, promise) => {
        console.error('⚠️  Unhandled Rejection at:', promise, 'reason:', reason);
    });
} // end setupMidiHandlers