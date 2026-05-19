const easymidi = require('easymidi');

const { getRuntimeConfig } = require('./config');
const { createController } = require('./controller/slot_controller');
const { JackCaptureRouter } = require('./controller/jack_capture_router');
const { OscTransport } = require('./controller/osc_transport');
const { MidiClockTracker, TapTempoTracker, TempoSource } = require('./controller/tempo');
const { createWebServer } = require('./controller/web_server');

const HOST = '127.0.0.1';
const PORT = Number(process.env.SLOOPER_WEB_PORT || 3000);
const args = process.argv.slice(2);
const audioArg = args.find((arg) => arg.startsWith('audio-device=') || arg.startsWith('device='));
const audioConfigArg = args.find((arg) => arg.startsWith('--audio-config='));
const midiArg = args.find((arg) => arg.startsWith('midi-device='));
const midiConfigArg = args.find((arg) => arg.startsWith('--midi-config='));
const clockMidiArg = args.find((arg) => arg.startsWith('clock-midi-device=') || arg.startsWith('--clock-midi-device='));
const channelsArg = args.find((arg) => arg.startsWith('channels='));
const slotsPerChannelArg = args.find((arg) => arg.startsWith('slots-per-channel='));

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
    channels: channelsArg ? channelsArg.split('=')[1] : undefined,
    slotsPerChannel: slotsPerChannelArg ? slotsPerChannelArg.split('=')[1] : undefined,
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
    onState: (oscArgs) => {
        if (controller) controller.applyPdState(oscArgs);
    },
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

controller = createController({
    transport,
    config: runtimeConfig.controller,
    slots: runtimeConfig.slots,
    tempo,
    inputSources: runtimeConfig.audio.captureSources,
    outputDestinations: runtimeConfig.audio.playbackPortPairs,
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

const webServer = createWebServer({ controller, tapTempo, runtimeConfig });
controller.onStateChange = webServer.broadcast;
midiClock.onBeat = () => webServer.broadcast(controller.getState());
webServer.listen(PORT, HOST).then(() => {
    console.log(`OSC web controller: http://${HOST}:${PORT}`);
    console.log(`Sending OSC to ${runtimeConfig.osc.host}:${runtimeConfig.osc.sendPort}`);
    console.log(`Listening for Pd state on ${runtimeConfig.osc.host}:${runtimeConfig.osc.statePort}`);
    console.log(`Tempo: MIDI clock from ${runtimeConfig.midi.midiName}, tap fallback from web`);
});

function shutdown() {
    webServer.close().then(() => {
        if (midiClockInput) midiClockInput.close();
        transport.close();
        process.exit(0);
    });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
