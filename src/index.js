const easymidi = require('easymidi');

const { getRuntimeConfig } = require('./config');
const { createController, SlotState } = require('./controller/slot_controller');
const { JackCaptureRouter } = require('./controller/jack_capture_router');
const { OscTransport } = require('./controller/osc_transport');
const { MidiClockTracker, TapTempoTracker, TempoSource } = require('./controller/tempo');
const { createWebServer } = require('./controller/web_server');
const { loadMidiSurface } = require('./controller/midi_surfaces');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

function logSuccess(message) {
    console.log(`${GREEN}${message}${RESET}`);
}

function logError(message) {
    console.error(`${RED}${message}${RESET}`);
}

const args = process.argv.slice(2);
const midiArg = args.find((arg) => arg.startsWith('midi-device='));
const audioArg = args.find((arg) => arg.startsWith('audio-device=') || arg.startsWith('device='));
const midiConfigArg = args.find((arg) => arg.startsWith('--midi-config='));
const audioConfigArg = args.find((arg) => arg.startsWith('--audio-config='));
const channelsArg = args.find((arg) => arg.startsWith('channels='));
const slotsPerChannelArg = args.find((arg) => arg.startsWith('slots-per-channel='));
const midiDeviceName = midiArg ? midiArg.split('=')[1] : 'XONE';
const audioDeviceName = audioArg ? audioArg.split('=')[1] : 'XONE';
const playOnPress = args.includes('play-on-press');

const runtimeConfig = getRuntimeConfig({
    audioDevice: audioDeviceName,
    midiDevice: midiDeviceName,
    audioConfigPath: audioConfigArg ? audioConfigArg.split('=')[1] : undefined,
    midiConfigPath: midiConfigArg ? midiConfigArg.split('=')[1] : undefined,
    channels: channelsArg ? channelsArg.split('=')[1] : undefined,
    slotsPerChannel: slotsPerChannelArg ? slotsPerChannelArg.split('=')[1] : undefined,
});

runtimeConfig.controller.playOnPress = playOnPress;

const midi = runtimeConfig.midi;
console.log(`MIDI Config: ${midi.midiName} (requested: ${midiDeviceName})`);
console.log(`Play Mode: ${playOnPress ? 'on-press (instant)' : 'on-release (default)'}`);

const inputs = easymidi.getInputs();
const inputIndex = inputs.findIndex((name) => name.toLowerCase().includes(midi.midiName.toLowerCase()));

if (inputIndex === -1) {
    logError(`MIDI input device matching "${midi.midiName}" not found.`);
    logError(`Available inputs: ${inputs.join(', ')}`);
    process.exit(1);
}

const inputDeviceName = inputs[inputIndex];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function openMidiInput() {
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`   Attempt ${attempt}: Opening by index ${inputIndex}...`);
            return new easymidi.Input(inputIndex);
        } catch (err) {
            console.log(`   Index failed: ${err.message}`);
        }

        try {
            console.log(`   Attempt ${attempt}: Opening by name "${inputDeviceName}"...`);
            return new easymidi.Input(inputDeviceName);
        } catch (err) {
            console.log(`   Name failed: ${err.message}`);
        }

        try {
            const shortName = inputs.find((name) => name.toLowerCase().includes(midi.midiName.toLowerCase()));
            if (shortName) {
                console.log(`   Attempt ${attempt}: Opening "${shortName}"...`);
                return new easymidi.Input(shortName);
            }
        } catch (err) {
            console.log(`   Short name failed: ${err.message}`);
        }

        if (attempt < maxRetries) {
            console.warn(`   All strategies failed (attempt ${attempt}/${maxRetries}), retrying in 1s...`);
            await sleep(1000);
        }
    }

    throw new Error(`Failed to open MIDI input after ${maxRetries} attempts`);
}

function openMidiOutput() {
    const outputs = easymidi.getOutputs();
    const outputIndex = outputs.findIndex((name) => name.toLowerCase().includes(midi.midiName.toLowerCase()));

    if (outputIndex === -1) {
        logError(`MIDI output device not found; LEDs disabled. Available: ${outputs.join(', ')}`);
        return null;
    }

    const outputDeviceName = outputs[outputIndex];
    try {
        const output = new easymidi.Output(outputIndex);
        logSuccess(`MIDI Output [${outputIndex}]: ${outputDeviceName}`);
        return output;
    } catch (err) {
        try {
            const output = new easymidi.Output(outputDeviceName);
            logSuccess(`MIDI Output: ${outputDeviceName}`);
            return output;
        } catch (fallbackErr) {
            logError(`Could not open MIDI output; LEDs disabled: ${fallbackErr.message}`);
            return null;
        }
    }
}

let controller;
let webServer = null;
let midiInput = null;
let midiOutput = null;
const midiClock = new MidiClockTracker();
const tapTempo = new TapTempoTracker();
const tempo = new TempoSource({ clock: midiClock, tap: tapTempo });
const transport = new OscTransport({
    host: runtimeConfig.osc.host,
    sendPort: runtimeConfig.osc.sendPort,
    statePort: Number(process.env.SLOOPER_OSC_STATE_PORT || runtimeConfig.osc.statePort),
    onState: (state) => {
        if (controller) controller.applyPdState(state);
    },
});

(async () => {
    let input;
    try {
        input = await openMidiInput();
        logSuccess(`MIDI Input [${inputIndex}]: ${inputDeviceName}`);
    } catch (err) {
        logError(err.message);
        logError(`Available inputs: ${inputs.join(', ')}`);
        transport.close();
        process.exit(1);
    }

    const output = openMidiOutput();
    midiInput = input;
    midiOutput = output;
    const surface = loadMidiSurface(midi);
    surface.setup({
        input,
        output,
        runtimeConfig,
        midi,
        transport,
        tempo,
        tapTempo,
        midiClock,
        playOnPress,
        createController,
        SlotState,
        JackCaptureRouter,
        onControllerCreated(createdController) {
            controller = createdController;
        },
    });

    if (args.includes('--web')) {
        const WEB_HOST = '127.0.0.1';
        const WEB_PORT = Number(process.env.SLOOPER_WEB_PORT || 3000);
        webServer = createWebServer({ controller, tapTempo, runtimeConfig });
        const existingOnStateChange = controller.onStateChange;
        controller.onStateChange = (state) => {
            existingOnStateChange(state);
            webServer.broadcast(state);
        };
        midiClock.onBeat = () => webServer.broadcast(controller.getState());
        webServer.listen(WEB_PORT, WEB_HOST)
            .then((port) => {
                logSuccess(`Web controller: http://${WEB_HOST}:${port}`);
            })
            .catch((err) => {
                logError(`Web server failed to start on port ${WEB_PORT}: ${err.message}`);
                process.exit(1);
            });
    }
})();

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});

function shutdown() {
    const close = webServer ? webServer.close() : Promise.resolve();
    close.finally(() => {
        if (midiInput) midiInput.close();
        if (midiOutput) midiOutput.close();
        transport.close();
        process.exit(0);
    });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
