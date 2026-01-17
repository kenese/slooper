const easymidi = require('easymidi');
const { Client } = require('node-osc');

// --- CONFIGURATION ---
const CONFIG = {
    oscIp: '127.0.0.1',
    oscPort: 9000,
    midiName: 'TRAKTOR X1 MK3',
    // midiName: 'XONE'
    slot1: { note: 10, channel: 0, encoderCC: 20 },  // UPDATE encoderCC after running midi_logger
    slot2: { note: 10, channel: 1, encoderCC: 21 },  // UPDATE encoderCC after running midi_logger
    // slot1: { note: 14, channel: 15, encoderCC: 8 },  // UPDATE encoderCC after running midi_logger
    // slot2: { note: 15, channel: 15, encoderCC: 8 },  // UPDATE encoderCC after running midi_logger
    holdThresholdMs: 1000,
    ledVelocityOn: 127,
    ledVelocityOff: 0,
    cropStepMs: 50,  // Milliseconds per encoder tick
    monitor1: { note: 11, channel: 0 },
    monitor2: { note: 11, channel: 1 },
    encoderPress1: { note: 20, channel: 0 },
    encoderPress2: { note: 21, channel: 0 }
};

// --- SETUP ---
const client = new Client(CONFIG.oscIp, CONFIG.oscPort);
const inputs = easymidi.getInputs();
const deviceName = inputs.find(n => n.toLowerCase().includes(CONFIG.midiName.toLowerCase()));

if (!deviceName) {
    console.error(`❌ Device matching "${CONFIG.midiName}" not found.`);
    process.exit(1);
}

console.log(`✅ Connected to ${deviceName}`);
const input = new easymidi.Input(deviceName);
const output = new easymidi.Output(deviceName);

// State: 0=EMPTY, 1=RECORDING, 2=PLAYING, 3=STOPPED
let slots = [
    { id: 1, state: 0, note: CONFIG.slot1.note, channel: CONFIG.slot1.channel, holdTimer: null, actionFired: false },
    { id: 2, state: 0, note: CONFIG.slot2.note, channel: CONFIG.slot2.channel, holdTimer: null, actionFired: false }
];

// Monitoring state
let monitorEnabled = [false, false];  // per slot
let monitors = [
    { id: 1, note: CONFIG.monitor1.note, channel: CONFIG.monitor1.channel },
    { id: 2, note: CONFIG.monitor2.note, channel: CONFIG.monitor2.channel }
];

// Crop tracking per slot
let cropState = [
    { recordStartTime: 0, originalLength: 0, cropOffset: 0 },
    { recordStartTime: 0, originalLength: 0, cropOffset: 0 }
];

// --- LED CONTROL ---
function setLED(slot, on) {
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
monitors.forEach(mon => setLED(mon, false));

// --- LOGIC ---

// Handle button press (noteon with velocity > 0)
input.on('noteon', (msg) => {
    // Check if it's a monitor button
    let monitor = monitors.find(m => m.note === msg.note && m.channel === msg.channel);
    if (monitor && msg.velocity > 0) {
        handleMonitorToggle(monitor);
        return;
    }

    // Check if it's an encoder press (reset loop length)
    if (msg.velocity > 0) {
        if (msg.note === CONFIG.encoderPress1.note && msg.channel === CONFIG.encoderPress1.channel) {
            handleEncoderPress(slots[0]);
            return;
        }
        if (msg.note === CONFIG.encoderPress2.note && msg.channel === CONFIG.encoderPress2.channel) {
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
    if (msg.controller === CONFIG.slot1.encoderCC) {
        slot = slots[0];
    } else if (msg.controller === CONFIG.slot2.encoderCC) {
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
        const addr = `/slot${slot.id}`;
        const idx = slot.id - 1;
        cropState[idx].cropOffset += delta;
        const currentLength = cropState[idx].originalLength + cropState[idx].cropOffset;
        const offsetStr = cropState[idx].cropOffset >= 0 ? `+${cropState[idx].cropOffset}` : cropState[idx].cropOffset;
        console.log(`[Slot ${slot.id}] loop: ${currentLength}ms [crop ${offsetStr}ms]`);
        client.send(addr, 'crop', delta);
    }
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

function handleMonitorToggle(monitor) {
    const idx = monitor.id - 1;
    monitorEnabled[idx] = !monitorEnabled[idx];
    console.log(`[Monitor ${monitor.id}] ${monitorEnabled[idx] ? 'ON' : 'OFF'}`);
    setLED(monitor, monitorEnabled[idx]);
    updateMonitorState();
}

function updateMonitorState() {
    // Monitoring is active if: (any monitor enabled) AND (no slot is playing)
    const anyMonitorOn = monitorEnabled[0] || monitorEnabled[1];
    const anyPlaying = slots.some(s => s.state === 2);
    const shouldMonitor = anyMonitorOn && !anyPlaying;
    client.send('/monitor', shouldMonitor ? 1 : 0);
}

function handleClear(slot) {
    const addr = `/slot${slot.id}`;
    const idx = slot.id - 1;
    console.log(`[Slot ${slot.id}] CLEARED (Hold 1s)`);
    client.send(addr, 'rec', 0);
    client.send(addr, 'play', 0);
    slot.state = 0;

    // Reset crop state
    cropState[idx].originalLength = 0;
    cropState[idx].cropOffset = 0;

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
console.log('Controls:');
console.log('  TAP: Record -> Play -> Stop -> Resume');
console.log('  HOLD 1s: Clear slot (triggers automatically, no release needed)');
console.log('  ENCODER ROTATE: Adjust loop length ± (CW=extend, CCW=shorten)');
console.log('  ENCODER PRESS: Reset loop to original length');
console.log('  MONITOR: Toggle passthrough (auto-mutes when any loop plays)');
console.log('  LED: ON when recording/playing/monitoring, OFF when stopped/empty');
console.log('');