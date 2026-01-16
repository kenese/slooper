const easymidi = require('easymidi');

console.log("🎹 Looking for MIDI devices...");
const inputs = easymidi.getInputs();
const px5Name = inputs.find(n => n.toLowerCase().includes('xone') || n.toLowerCase().includes('px5'));

if (!px5Name) {
    console.error("❌ XONE:PX5 not found. Check USB connection.");
    console.log("Available:", inputs);
    process.exit(1);
}

console.log(`✅ Connected to: ${px5Name}`);
console.log("--> Press the buttons you want to use for Loop 1 and Loop 2.");

const input = new easymidi.Input(px5Name);

input.on('noteon', (msg) => console.log(`Note ON  | Note: ${msg.note} | Channel: ${msg.channel}`));
input.on('cc', (msg) => console.log(`Control Change | CC: ${msg.controller} | Val: ${msg.value}`));