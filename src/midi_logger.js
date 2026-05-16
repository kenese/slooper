const easymidi = require('easymidi');

console.log("🎹 Looking for MIDI devices...");
const inputs = easymidi.getInputs();
const hardwareName = inputs.find(n => n.toLowerCase().includes('traktor') || n.toLowerCase().includes('x1'));
console.log('inputs', inputs)

if (!hardwareName) {
    console.error("❌ Traktor/X1 device not found. Check USB connection.");
    console.log("Available:", inputs);
    process.exit(1);
}

console.log(`✅ Connected to: ${hardwareName}`);
console.log("--> Press the buttons you want to use for Loop 1 and Loop 2.");

const input = new easymidi.Input(hardwareName);

input.on('noteon', (msg) => console.log(`Note ON  | Note: ${msg.note} | Channel: ${msg.channel}`));
input.on('cc', (msg) => console.log(`Control Change | CC: ${msg.controller} | Val: ${msg.value}`));
input.on('clock', () => console.log('MIDI Clock tick'));
input.on('start', () => console.log('MIDI Start'));
input.on('continue', () => console.log('MIDI Continue'));
input.on('stop', () => console.log('MIDI Stop'));
