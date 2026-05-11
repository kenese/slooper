const fs = require('fs');
const path = require('path');

const DEFAULT_PROJECT_ROOT = path.resolve(__dirname, '..');

const BASE_CONFIG = {
    osc: {
        host: '127.0.0.1',
        sendPort: 9000,
        statePort: 9001,
    },
    controller: {
        holdThresholdMs: 500,
        cropStepMs: 30,
        encoderThrottleMs: 50,
        playOnPress: false,
    },
    jack: {
        sampleRate: 48000,
        periodSize: 128,
        periods: 2,
    },
    audioDevices: {
        XONE: {
            jackCardNameIncludes: 'XONE',
            capturePorts: ['system:capture_9', 'system:capture_10'],
            playbackPorts: ['system:playback_1', 'system:playback_2'],
            macPdChannels: {
                adc: [9, 10],
                dac: [1, 2],
            },
            linuxPdChannels: {
                adc: [1, 2],
                dac: [1, 2],
            },
        },
        Z1: {
            jackCardNameIncludes: 'Traktor Z1',
            capturePorts: ['system:capture_1', 'system:capture_2'],
            playbackPorts: ['system:playback_3', 'system:playback_4'],
            macPdChannels: {
                adc: [1, 2],
                dac: [3, 4],
            },
            linuxPdChannels: {
                adc: [1, 2],
                dac: [1, 2],
            },
        },
        MAC: {
            mode: 'native-pd',
            macPdChannels: {
                adc: [1, 2],
                dac: [1, 2],
            },
            linuxPdChannels: {
                adc: [1, 2],
                dac: [1, 2],
            },
        },
        BLACKHOLE: {
            mode: 'native-pd',
            macPdChannels: {
                adc: [1, 2],
                dac: [1, 2],
            },
            linuxPdChannels: {
                adc: [1, 2],
                dac: [1, 2],
            },
        },
    },
    midiDevices: {
        XONE: {
            midiName: 'XONE',
            slot1: { note: 14, channel: 15, encoderCC: 7 },
            slot2: { note: 15, channel: 15, encoderCC: 7 },
            monitor: { note: 10, channel: 15 },
            encoderPress1: { note: 28, channel: 15 },
            encoderPress2: { note: 38, channel: 15 },
        },
        X1MK3: {
            midiName: 'TRAKTOR X1MK3',
            slot1: { note: 10, channel: 0, encoderCC: 20 },
            slot2: { note: 10, channel: 1, encoderCC: 21 },
            monitor: { note: 11, channel: 0 },
            encoderPress1: { note: 20, channel: 0 },
            encoderPress2: { note: 21, channel: 0 },
        },
        OSC: {
            midiName: 'OSC',
        },
        WEB: {
            midiName: 'WEB',
        },
    },
};

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function normalizePlatform(platform = process.platform) {
    return platform === 'darwin' ? 'darwin' : 'linux';
}

function getAudioDevice(name = 'XONE') {
    return BASE_CONFIG.audioDevices[name] || BASE_CONFIG.audioDevices.XONE;
}

function getMidiDevice(name = 'XONE') {
    return BASE_CONFIG.midiDevices[name] || BASE_CONFIG.midiDevices.XONE;
}

function getRuntimeConfig(options = {}) {
    const projectRoot = options.projectRoot || DEFAULT_PROJECT_ROOT;
    const platform = normalizePlatform(options.platform);
    const audioDeviceName = options.audioDevice || 'XONE';
    const midiDeviceName = options.midiDevice || 'XONE';
    const audio = clone(getAudioDevice(audioDeviceName));
    const midi = clone(getMidiDevice(midiDeviceName));
    const sourcePatchPath = path.join(projectRoot, 'src', 'engine.pd');
    const runtimePatchPath = path.join(projectRoot, '.runtime', 'engine.pd');
    const pdChannels = platform === 'darwin' ? audio.macPdChannels : audio.linuxPdChannels;
    const generateRuntimePatch = platform === 'darwin';

    return {
        projectRoot,
        platform,
        audioDeviceName,
        midiDeviceName,
        osc: clone(BASE_CONFIG.osc),
        controller: clone(BASE_CONFIG.controller),
        jack: clone(BASE_CONFIG.jack),
        audio,
        midi,
        pd: {
            sourcePatchPath,
            patchPath: generateRuntimePatch ? runtimePatchPath : sourcePatchPath,
            generateRuntimePatch,
            channels: pdChannels,
        },
    };
}

function replacePdChannels(source, objectName, channels) {
    const [left, right] = channels;
    const pattern = new RegExp(`${objectName}~\\s+[0-9]+\\s+[0-9]+`, 'g');
    return source.replace(pattern, `${objectName}~ ${left} ${right}`);
}

function renderEnginePatch(source, config) {
    let rendered = replacePdChannels(source, 'adc', config.pd.channels.adc);
    rendered = replacePdChannels(rendered, 'dac', config.pd.channels.dac);
    if (config.pd.generateRuntimePatch && !rendered.includes('#X declare -path ../src;')) {
        rendered = rendered.replace(
            /^(#N canvas [^\n]*;\n?)/,
            '$1#X declare -path ../src;\n'
        );
    }
    return rendered;
}

function ensureRuntimePatch(config) {
    if (!config.pd.generateRuntimePatch) {
        return config.pd.patchPath;
    }

    const source = fs.readFileSync(config.pd.sourcePatchPath, 'utf8');
    const rendered = renderEnginePatch(source, config);
    fs.mkdirSync(path.dirname(config.pd.patchPath), { recursive: true });
    fs.writeFileSync(config.pd.patchPath, rendered);
    return config.pd.patchPath;
}

function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function renderShellConfig(config) {
    const entries = {
        PROJECT_ROOT: config.projectRoot,
        PLATFORM: config.platform,
        AUDIO_DEVICE: config.audioDeviceName,
        MIDI_DEVICE: config.midiDeviceName,
        OSC_HOST: config.osc.host,
        OSC_SEND_PORT: config.osc.sendPort,
        OSC_STATE_PORT: config.osc.statePort,
        HOLD_THRESHOLD_MS: config.controller.holdThresholdMs,
        CROP_STEP_MS: config.controller.cropStepMs,
        ENCODER_THROTTLE_MS: config.controller.encoderThrottleMs,
        PD_PATCH_PATH: config.pd.patchPath,
        PD_SOURCE_PATCH_PATH: config.pd.sourcePatchPath,
        PD_GENERATE_RUNTIME_PATCH: config.pd.generateRuntimePatch ? 1 : 0,
        PD_ADC_LEFT: config.pd.channels.adc[0],
        PD_ADC_RIGHT: config.pd.channels.adc[1],
        PD_DAC_LEFT: config.pd.channels.dac[0],
        PD_DAC_RIGHT: config.pd.channels.dac[1],
        JACK_CARD_NAME_INCLUDES: config.audio.jackCardNameIncludes || '',
        JACK_CAPTURE_LEFT: config.audio.capturePorts ? config.audio.capturePorts[0] : '',
        JACK_CAPTURE_RIGHT: config.audio.capturePorts ? config.audio.capturePorts[1] : '',
        JACK_PLAYBACK_LEFT: config.audio.playbackPorts ? config.audio.playbackPorts[0] : '',
        JACK_PLAYBACK_RIGHT: config.audio.playbackPorts ? config.audio.playbackPorts[1] : '',
        JACK_SAMPLE_RATE: config.jack.sampleRate,
        JACK_PERIOD_SIZE: config.jack.periodSize,
        JACK_PERIODS: config.jack.periods,
    };

    return Object.entries(entries)
        .map(([key, value]) => `${key}=${shellQuote(value)}`)
        .join('\n');
}

module.exports = {
    BASE_CONFIG,
    getRuntimeConfig,
    renderEnginePatch,
    renderShellConfig,
    ensureRuntimePatch,
};
