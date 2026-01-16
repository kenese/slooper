const easymidi = require('easymidi');
const { Client } = require('node-osc');

// --- CONFIGURATION ---
const CONFIG = {
    oscIp: '127.0.0.1',
    oscPort: 9000,
    midiName: 'XONE',
    slot1: { note: 14, channel: 15 },
    slot2: { note: 15, channel: 15 },
    holdThresholdMs: 1000,  // 1 second hold to clear
    ledVelocityOn: 127,
    ledVelocityOff: 0
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

// --- LOGIC ---

// Handle button press (noteon with velocity > 0)
input.on('noteon', (msg) => {
    let slot = slots.find(s => s.note === msg.note);
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
    let slot = slots.find(s => s.note === msg.note);
    if (!slot) return;
    handleRelease(slot);
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

function handleClear(slot) {
    const addr = `/slot${slot.id}`;
    console.log(`[Slot ${slot.id}] CLEARED (Hold 1s)`);
    client.send(addr, 'rec', 0);
    client.send(addr, 'play', 0);
    slot.state = 0;

    // Flash LED 3 times to indicate clear
    flashLED(slot, 3, 100);
}

function handleTap(slot) {
    const addr = `/slot${slot.id}`;

    if (slot.state === 0) {
        console.log(`[Slot ${slot.id}] Rec Start`);
        client.send(addr, 'rec', 1);
        slot.state = 1;
        setLED(slot, true);
    }
    else if (slot.state === 1) {
        console.log(`[Slot ${slot.id}] Rec Stop -> Play`);
        client.send(addr, 'rec', 0);
        client.send(addr, 'play', 1);
        slot.state = 2;
        setLED(slot, true);
    }
    else if (slot.state === 2) {
        console.log(`[Slot ${slot.id}] Stopped`);
        client.send(addr, 'play', 0);
        slot.state = 3;
        setLED(slot, false);
    }
    else if (slot.state === 3) {
        console.log(`[Slot ${slot.id}] Resuming`);
        client.send(addr, 'play', 1);
        slot.state = 2;
        setLED(slot, true);
    }
}

console.log('');
console.log('Controls:');
console.log('  TAP: Record -> Play -> Stop -> Resume');
console.log('  HOLD 1s: Clear slot (triggers automatically, no release needed)');
console.log('  LED: ON when recording/playing, OFF when stopped/empty');
console.log('');