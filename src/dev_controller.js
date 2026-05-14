const http = require('http');
const path = require('path');
const fs = require('fs');
const easymidi = require('easymidi');

const { getRuntimeConfig } = require('./config');
const { createController } = require('./controller/slot_controller');
const { JackCaptureRouter } = require('./controller/jack_capture_router');
const { OscTransport } = require('./controller/osc_transport');
const { MidiClockTracker, TapTempoTracker, TempoSource } = require('./controller/tempo');

const HOST = '127.0.0.1';
const PORT = Number(process.env.SLOOPER_WEB_PORT || 3000);
const htmlPath = path.join(__dirname, '..', 'public', 'dev-controller.html');
const args = process.argv.slice(2);
const audioArg = args.find((arg) => arg.startsWith('audio-device=') || arg.startsWith('device='));
const audioConfigArg = args.find((arg) => arg.startsWith('--audio-config='));
const midiArg = args.find((arg) => arg.startsWith('midi-device='));
const midiConfigArg = args.find((arg) => arg.startsWith('--midi-config='));
const clockMidiArg = args.find((arg) => arg.startsWith('clock-midi-device=') || arg.startsWith('--clock-midi-device='));

function getClockMidiDeviceName() {
    if (clockMidiArg) {
        return clockMidiArg.split('=')[1];
    }

    if (process.env.SLOOPER_MIDI_CLOCK_DEVICE) {
        return process.env.SLOOPER_MIDI_CLOCK_DEVICE;
    }

    const requestedMidiDevice = midiArg ? midiArg.split('=')[1] : null;
    if (requestedMidiDevice && !['WEB', 'OSC'].includes(requestedMidiDevice)) {
        return requestedMidiDevice;
    }

    return 'X1MK3';
}

const runtimeConfig = getRuntimeConfig({
    audioDevice: audioArg ? audioArg.split('=')[1] : (process.env.SLOOPER_AUDIO_DEVICE || 'MAC'),
    audioConfigPath: audioConfigArg ? audioConfigArg.split('=')[1] : undefined,
    midiDevice: getClockMidiDeviceName(),
    midiConfigPath: midiConfigArg ? midiConfigArg.split('=')[1] : undefined,
});

runtimeConfig.osc.sendPort = Number(process.env.SLOOPER_OSC_SEND_PORT || runtimeConfig.osc.sendPort);
runtimeConfig.osc.statePort = Number(process.env.SLOOPER_OSC_STATE_PORT || runtimeConfig.osc.statePort);

let controller;
let midiClockInput = null;
const midiClock = new MidiClockTracker();
const tapTempo = new TapTempoTracker();
const tempo = new TempoSource({ clock: midiClock, tap: tapTempo });
const transport = new OscTransport({
    host: runtimeConfig.osc.host,
    sendPort: runtimeConfig.osc.sendPort,
    statePort: runtimeConfig.osc.statePort,
    onState: (args) => {
        if (controller) controller.applyPdState(args);
    },
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

controller = createController({
    transport,
    config: runtimeConfig.controller,
    tempo,
    inputSources: runtimeConfig.audio.captureSources,
    inputRouter: runtimeConfig.platform === 'linux' && runtimeConfig.audio.mode === 'jack'
        ? new JackCaptureRouter()
        : null,
});

async function openMidiClockInput() {
    const inputs = easymidi.getInputs();
    const matchName = runtimeConfig.midi.midiName;
    const inputIndex = inputs.findIndex((name) => name.toLowerCase().includes(matchName.toLowerCase()));

    if (inputIndex === -1) {
        console.warn(`MIDI clock input matching "${matchName}" not found. Tap tempo fallback is available.`);
        console.warn('Available inputs:', inputs);
        return;
    }

    const inputName = inputs[inputIndex];
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            midiClockInput = new easymidi.Input(inputIndex);
            break;
        } catch (err) {
            try {
                midiClockInput = new easymidi.Input(inputName);
                break;
            } catch (fallbackErr) {
                if (attempt < maxRetries) {
                    console.warn(`Could not open MIDI clock input "${inputName}" (attempt ${attempt}/${maxRetries}): ${fallbackErr.message}; retrying in 1s...`);
                    await sleep(1000);
                } else {
                    console.warn(`Could not open MIDI clock input "${inputName}": ${fallbackErr.message}`);
                    return;
                }
            }
        }
    }

    midiClockInput.on('clock', () => midiClock.tick());
    midiClockInput.on('start', () => midiClock.reset());
    midiClockInput.on('continue', () => midiClock.reset());
    midiClockInput.on('stop', () => midiClock.reset());
    console.log(`MIDI clock input [${inputIndex}]: ${inputName}`);
}

openMidiClockInput();

function readJson(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
            if (body.length > 1e6) {
                req.destroy();
                reject(new Error('Request too large'));
            }
        });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (err) {
                reject(err);
            }
        });
        req.on('error', reject);
    });
}

function sendJson(res, statusCode, data) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

async function handleAction(action, slotId) {
    if (action === 'monitor') {
        await controller.toggleMonitor();
        return;
    }

    if (action === 'tapTempo') {
        tapTempo.tap(Date.now());
        return;
    }

    if (action.startsWith('source:')) {
        await controller.selectInputSource(action.split(':')[1]);
        return;
    }

    if (action === 'tap') await controller.tapSlot(slotId);
    else if (action.startsWith('autoLoop:')) await controller.autoLoopSlot(slotId, action.split(':')[1]);
    else if (action === 'half') await controller.multiplySlotLength(slotId, 0.5);
    else if (action === 'double') await controller.multiplySlotLength(slotId, 2);
    else if (action === 'clear') await controller.clearSlot(slotId);
    else if (action === 'cropStartDown') await controller.cropStartSlot(slotId, -runtimeConfig.controller.cropStepMs);
    else if (action === 'cropStartUp') await controller.cropStartSlot(slotId, runtimeConfig.controller.cropStepMs);
    else if (action === 'cropDown') await controller.cropSlot(slotId, -runtimeConfig.controller.cropStepMs);
    else if (action === 'cropUp') await controller.cropSlot(slotId, runtimeConfig.controller.cropStepMs);
    else if (action === 'moveDown') await controller.moveSlot(slotId, -runtimeConfig.controller.cropStepMs);
    else if (action === 'moveUp') await controller.moveSlot(slotId, runtimeConfig.controller.cropStepMs);
    else if (action === 'reset') await controller.resetSlot(slotId);
    else throw new Error(`Unknown action: ${action}`);
}

const server = http.createServer(async (req, res) => {
    try {
        if (req.method === 'GET' && req.url === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(fs.readFileSync(htmlPath, 'utf8'));
            return;
        }

        if (req.method === 'GET' && req.url === '/api/state') {
            sendJson(res, 200, controller.getState());
            return;
        }

        if (req.method === 'POST' && req.url === '/api/action') {
            const body = await readJson(req);
            await handleAction(body.action, Number(body.slot));
            sendJson(res, 200, controller.getState());
            return;
        }

        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
    } catch (err) {
        sendJson(res, 500, { error: err.message, ...controller.getState() });
    }
});

server.listen(PORT, HOST, () => {
    console.log(`OSC web controller: http://${HOST}:${PORT}`);
    console.log(`Sending OSC to ${runtimeConfig.osc.host}:${runtimeConfig.osc.sendPort}`);
    console.log(`Listening for Pd state on ${runtimeConfig.osc.host}:${runtimeConfig.osc.statePort}`);
    console.log(`Tempo: MIDI clock from ${runtimeConfig.midi.midiName}, tap fallback from web`);
});

function shutdown() {
    server.close(() => {
        if (midiClockInput) {
            midiClockInput.close();
        }
        transport.close();
        process.exit(0);
    });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
