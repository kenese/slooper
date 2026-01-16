const easymidi = require('easymidi');
const { Client } = require('node-osc');

// --- CONFIGURATION ---
const CONFIG = {
    oscIp: '127.0.0.1',
    oscPort: 9000,
    midiName: 'XONE',
    slot1: { note: 14, channel: 15 },
    slot2: { note: 15, channel: 15 },
    holdThresholdMs: 500
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
    { id: 1, state: 0, note: CONFIG.slot1.note, pressTime: null },
    { id: 2, state: 0, note: CONFIG.slot2.note, pressTime: null }
];

// --- LOGIC ---

// Handle button press (noteon with velocity > 0)
input.on('noteon', (msg) => {
    let slot = slots.find(s => s.note === msg.note);
    if (!slot) return;

    if (msg.velocity === 0) {
        // This is actually a button release (some devices send vel 0 instead of noteoff)
        handleRelease(slot);
    } else {
        // Button pressed
        slot.pressTime = Date.now();
    }
});

// Handle button release (noteoff)
input.on('noteoff', (msg) => {
    let slot = slots.find(s => s.note === msg.note);
    if (!slot) return;
    handleRelease(slot);
});

function handleRelease(slot) {
    if (slot.pressTime === null) return;

    const holdDuration = Date.now() - slot.pressTime;
    slot.pressTime = null;

    if (holdDuration >= CONFIG.holdThresholdMs) {
        handleClear(slot);
    } else {
        handleTap(slot);
    }
}

function handleClear(slot) {
    const addr = `/slot${slot.id}`;
    console.log(`[Slot ${slot.id}] CLEARED (Hold detected)`);
    client.send(addr, 'rec', 0);
    client.send(addr, 'play', 0);
    slot.state = 0;
}

function handleTap(slot) {
    const addr = `/slot${slot.id}`;

    if (slot.state === 0) {
        console.log(`[Slot ${slot.id}] Rec Start`);
        client.send(addr, 'rec', 1);
        slot.state = 1;
    }
    else if (slot.state === 1) {
        console.log(`[Slot ${slot.id}] Rec Stop -> Play`);
        client.send(addr, 'rec', 0);
        client.send(addr, 'play', 1);
        slot.state = 2;
    }
    else if (slot.state === 2) {
        console.log(`[Slot ${slot.id}] Stopped`);
        client.send(addr, 'play', 0);
        slot.state = 3;
    }
    else if (slot.state === 3) {
        console.log(`[Slot ${slot.id}] Resuming`);
        client.send(addr, 'play', 1);
        slot.state = 2;
    }
}

console.log('');
console.log('Controls:');
console.log('  TAP: Record -> Play -> Stop -> Resume');
console.log('  HOLD (500ms): Clear slot for new recording');
console.log('');