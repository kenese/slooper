const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../../src/index.js'), 'utf8');

test('index.js exposes colored success and error log helpers', () => {
    assert.ok(source.includes("const GREEN = '\\x1b[32m';"));
    assert.ok(source.includes("const RED = '\\x1b[31m';"));
    assert.match(source, /function logSuccess\(message\)/);
    assert.match(source, /function logError\(message\)/);
});

test('index.js logs successful MIDI and web connections in green', () => {
    assert.match(source, /logSuccess\(`MIDI Input \[\$\{inputIndex\}\]: \$\{inputDeviceName\}`\)/);
    assert.match(source, /logSuccess\(`MIDI Output/);
    assert.match(source, /logSuccess\(`Web controller: http:\/\/\$\{WEB_HOST\}:\$\{port\}`\)/);
});

test('index.js logs MIDI and web failures in red', () => {
    assert.match(source, /logError\(`MIDI input device matching "\$\{midi\.midiName\}" not found\.`\)/);
    assert.match(source, /logError\(`Could not open MIDI output; LEDs disabled: \$\{fallbackErr\.message\}`\)/);
    assert.match(source, /logError\(`Web server failed to start on port \$\{WEB_PORT\}: \$\{err\.message\}`\)/);
});
