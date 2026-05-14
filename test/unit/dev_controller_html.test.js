const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../../public/dev-controller.html'), 'utf8');

test('dev controller exposes separate start and end crop controls', () => {
    assert.match(html, /Start Crop/);
    assert.match(html, /End Crop/);
    assert.match(html, /data-action="cropStartDown"/);
    assert.match(html, /data-action="cropStartUp"/);
    assert.match(html, /data-action="cropDown"/);
    assert.match(html, /data-action="cropUp"/);
});

test('dev controller exposes move controls and displays rounded whole milliseconds', () => {
    assert.match(html, /data-action="moveDown"/);
    assert.match(html, /data-action="moveUp"/);
    assert.match(html, /Move -30/);
    assert.match(html, /Move \+30/);
    assert.match(html, /function wholeMs\(value\)/);
    assert.match(html, /\$\{wholeMs\(slot\.currentLengthMs\)\} ms/);
    assert.match(html, /\$\{signed\(startCrop\)\} ms/);
    assert.match(html, /\$\{signed\(endCrop\)\} ms/);
});

test('dev controller exposes auto-loop, half, double, and tap tempo controls', () => {
    assert.match(html, /data-action="autoLoop:1beat"/);
    assert.match(html, /data-action="autoLoop:2beat"/);
    assert.match(html, /data-action="autoLoop:4beat"/);
    assert.match(html, /data-action="autoLoop:2bar"/);
    assert.match(html, /data-action="half"/);
    assert.match(html, /data-action="double"/);
    assert.match(html, /data-action="tapTempo"/);
    assert.match(html, /Pending/);
});

test('dev controller exposes MIDI clock status and beat flash UI', () => {
    assert.match(html, /id="tempo-panel"/);
    assert.match(html, /id="tempo-bpm"/);
    assert.match(html, /id="beat-light"/);
    assert.match(html, /function renderTempo/);
    assert.match(html, /beatProgress/);
    assert.match(html, /clock-flash/);
});

test('dev controller schedules beat flashes between state polls', () => {
    assert.match(html, /function scheduleBeatFlash/);
    assert.match(html, /scheduleNextFlash\(delayMs\)/);
    assert.match(html, /delayMs = beatMs - elapsedBeatMs/);
    assert.match(html, /requestAnimationFrame\(animateTempoProgress\)/);
});

test('dev controller keeps web control mode separate from MIDI clock source', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/dev_controller.js'), 'utf8');

    assert.match(source, /clockMidiArg/);
    assert.match(source, /getClockMidiDeviceName/);
    assert.match(source, /midiDevice: getClockMidiDeviceName\(\)/);
    assert.match(source, /\['WEB', 'OSC'\]\.includes\(requestedMidiDevice\)/);
});

test('dev controller retries transient MIDI clock input open failures', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/dev_controller.js'), 'utf8');

    assert.match(source, /async function openMidiClockInput\(\)/);
    assert.match(source, /const maxRetries = 3/);
    assert.match(source, /retrying in 1s/);
    assert.match(source, /await sleep\(1000\)/);
});

test('dev controller reconnects websocket with exponential backoff', () => {
    assert.match(html, /let ws = null/);
    assert.match(html, /function connectWebSocket/);
    assert.match(html, /Math\.min\(10000, wsReconnectDelay \* 2\)/);
    assert.doesNotMatch(html, /setInterval\(\(\) =>/);
});
