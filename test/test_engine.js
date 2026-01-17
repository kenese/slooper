/**
 * Slooper Engine Tests
 * 
 * Tests the OSC interface to engine.pd by sending commands and
 * verifying the expected print output from Pure Data.
 * 
 * Usage: node test/test_engine.js
 * 
 * Prerequisites:
 * - Pure Data must be running with engine.pd loaded
 * - DSP must be enabled
 */

const { Client } = require('node-osc');
const assert = require('assert');

const OSC_PORT = 9000;
const client = new Client('127.0.0.1', OSC_PORT);

// Simple test runner
const tests = [];
let passed = 0;
let failed = 0;

function test(name, fn) {
    tests.push({ name, fn });
}

async function runTests() {
    console.log('🧪 Slooper Engine Tests\n');
    console.log('⚠️  Make sure Pure Data is running with engine.pd loaded!\n');

    for (const t of tests) {
        try {
            await t.fn();
            console.log(`✅ ${t.name}`);
            passed++;
        } catch (err) {
            console.log(`❌ ${t.name}`);
            console.log(`   Error: ${err.message}`);
            failed++;
        }
    }

    console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
    client.close();
    process.exit(failed > 0 ? 1 : 0);
}

// Helper to send OSC and wait
function sendOSC(addr, ...args) {
    return new Promise((resolve) => {
        client.send(addr, ...args, () => {
            setTimeout(resolve, 100); // Give Pd time to process
        });
    });
}

// --- Basic OSC Tests ---

test('OSC client connects without error', async () => {
    assert.ok(client, 'OSC client should exist');
});

test('can send rec 1 command', async () => {
    await sendOSC('/slot1', 'rec', 1);
    // Visual verification: check Pd console for ---REC_START---
});

test('can send rec 0 command', async () => {
    await sendOSC('/slot1', 'rec', 0);
    // Visual verification: check Pd console for ---REC_STOP--- and LENGTH_MS
});

test('can send play 1 command', async () => {
    await sendOSC('/slot1', 'play', 1);
    // Visual verification: check Pd console for PLAY_CMD: 1
});

test('can send play 0 command', async () => {
    await sendOSC('/slot1', 'play', 0);
    // Visual verification: check Pd console for PLAY_CMD: 0
});

// --- Slot 2 Tests ---

test('can send slot2 rec 1 command', async () => {
    await sendOSC('/slot2', 'rec', 1);
});

test('can send slot2 rec 0 command', async () => {
    await sendOSC('/slot2', 'rec', 0);
});

test('can send slot2 play 1 command', async () => {
    await sendOSC('/slot2', 'play', 1);
});

test('can send slot2 play 0 command', async () => {
    await sendOSC('/slot2', 'play', 0);
});

// --- Phase Reset Tests ---

test('play 1 resets phasor phase (visual verify loop starts from beginning)', async () => {
    // First, simulate a recording cycle
    await sendOSC('/slot1', 'rec', 1);
    await new Promise(r => setTimeout(r, 500)); // Record for 500ms
    await sendOSC('/slot1', 'rec', 0);
    await sendOSC('/slot1', 'play', 1);

    // Wait for some playback
    await new Promise(r => setTimeout(r, 200));

    // Stop playback
    await sendOSC('/slot1', 'play', 0);

    // Wait (phasor continues internally)
    await new Promise(r => setTimeout(r, 300));

    // Resume - should start from beginning due to phase reset
    await sendOSC('/slot1', 'play', 1);

    // Visual verification: loop should start from beginning, not middle
});

// --- Timing Tests ---

test('rapid play toggle does not crash', async () => {
    for (let i = 0; i < 10; i++) {
        await sendOSC('/slot1', 'play', 1);
        await sendOSC('/slot1', 'play', 0);
    }
    // If we get here without errors, test passes
});

test('rapid rec toggle does not crash', async () => {
    for (let i = 0; i < 5; i++) {
        await sendOSC('/slot1', 'rec', 1);
        await new Promise(r => setTimeout(r, 50));
        await sendOSC('/slot1', 'rec', 0);
    }
    // If we get here without errors, test passes
});

// --- Clear State Test ---

test('can clear slot (rec 0 + play 0)', async () => {
    await sendOSC('/slot1', 'rec', 0);
    await sendOSC('/slot1', 'play', 0);
    // Slot should now be in empty/cleared state
});

// --- Crop Tests ---

test('can send crop command to adjust loop length', async () => {
    // Record a loop first
    await sendOSC('/slot1', 'rec', 1);
    await new Promise(r => setTimeout(r, 1000));
    await sendOSC('/slot1', 'rec', 0);
    await sendOSC('/slot1', 'play', 1);

    // Send crop adjustments
    await sendOSC('/slot1', 'crop', 50);   // Extend by 50ms
    await new Promise(r => setTimeout(r, 100));
    await sendOSC('/slot1', 'crop', -100); // Shorten by 100ms

    // Visual verification: check Pd console for CROP_LENGTH changes
    await sendOSC('/slot1', 'play', 0);
});

test('crop bounds test - cannot go below 100ms', async () => {
    await sendOSC('/slot1', 'rec', 1);
    await new Promise(r => setTimeout(r, 200));
    await sendOSC('/slot1', 'rec', 0);
    await sendOSC('/slot1', 'play', 1);

    // Try to crop well below minimum
    await sendOSC('/slot1', 'crop', -5000);

    // Visual verification: CROP_LENGTH should be clipped to 100ms minimum
    await sendOSC('/slot1', 'play', 0);
});

test('crop adjustments accumulate correctly', async () => {
    // Record a 1 second loop
    await sendOSC('/slot1', 'rec', 1);
    await new Promise(r => setTimeout(r, 1000));
    await sendOSC('/slot1', 'rec', 0);
    await sendOSC('/slot1', 'play', 1);

    // Send multiple crop adjustments
    await sendOSC('/slot1', 'crop', 50);   // +50ms
    await sendOSC('/slot1', 'crop', 50);   // +100ms total
    await sendOSC('/slot1', 'crop', 50);   // +150ms total
    await sendOSC('/slot1', 'crop', -100); // +50ms total

    // Visual verification: PENDING_LENGTH should show ~1050ms
    await new Promise(r => setTimeout(r, 500));
    await sendOSC('/slot1', 'play', 0);
});

test('crop during playback does not crash', async () => {
    await sendOSC('/slot1', 'rec', 1);
    await new Promise(r => setTimeout(r, 500));
    await sendOSC('/slot1', 'rec', 0);
    await sendOSC('/slot1', 'play', 1);

    // Rapid crop adjustments during playback
    for (let i = 0; i < 20; i++) {
        await sendOSC('/slot1', 'crop', i % 2 === 0 ? 50 : -50);
    }

    await sendOSC('/slot1', 'play', 0);
    // If we get here without errors, test passes
});

// --- Monitoring Tests ---

test('can send monitor on/off commands', async () => {
    await sendOSC('/monitor', 1);  // Enable monitoring
    await new Promise(r => setTimeout(r, 100));
    await sendOSC('/monitor', 0);  // Disable monitoring
    // Visual verification: check Pd console for MONITOR output
});

// Run
runTests();
