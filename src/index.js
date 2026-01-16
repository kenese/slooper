const easymidi = require('easymidi');
const { Client } = require('node-osc');
const os = require('os');

// --- CONFIGURATION ---
const CONFIG = {
    // Audio Engine Connection
    oscIp: '127.0.0.1',
    oscPort: 9000,

    // MIDI Device Name (Partial match works)
    midiName: 'XONE',

    // MIDI Mappings (UPDATE THESE AFTER RUNNING LOGGER)
    // Example: The MIDI Note numbers for your chosen buttons
    slot1: { note: 14, channel: 15 },
    slot2: { note: 15, channel: 15 }
};

// --- SETUP ---
const client = new Client(CONFIG.oscIp, CONFIG.oscPort);
const inputs = easymidi.getInputs();
const deviceName = inputs.find(n => n.includes(CONFIG.midiName));

if (!deviceName) {
    console.error(`❌ device matching "${CONFIG.midiName}" not found.`);
    process.exit(1);
}

console.log(`✅ Connected to ${deviceName}`);
const input = new easymidi.Input(deviceName);
const output = new easymidi.Output(deviceName);

// State: 0=EMPTY, 1=RECORDING, 2=PLAYING, 3=PAUSED
let slots = [
    { id: 1, state: 0, note: CONFIG.slot1.note },
    { id: 2, state: 0, note: CONFIG.slot2.note }
];

// --- LOGIC ---
input.on('noteon', (msg) => {
    // Find which slot was pressed
    let slot = slots.find(s => s.note === msg.note);
    if (!slot) return;

    handleTrigger(slot);
});

function handleTrigger(slot) {
    const addr = `/slot${slot.id}`;

    if (slot.state === 0) {
        // Start Recording
        console.log(`[Slot ${slot.id}] Rec Start`);
        client.send(`${addr}/rec`, 1);
        slot.state = 1;
        // Future: Send MIDI back to light up button
    }
    else if (slot.state === 1) {
        // Stop Rec -> Play
        console.log(`[Slot ${slot.id}] Rec Stop -> Play`);
        client.send(`${addr}/rec`, 0);
        client.send(`${addr}/play`, 1);
        slot.state = 2;
    }
    else if (slot.state === 2) {
        // Stop Playing
        console.log(`[Slot ${slot.id}] Paused`);
        client.send(`${addr}/play`, 0);
        slot.state = 3;
    }
    else if (slot.state === 3) {
        // Resume Playing
        console.log(`[Slot ${slot.id}] Resuming`);
        client.send(`${addr}/play`, 1);
        slot.state = 2;
    }
}