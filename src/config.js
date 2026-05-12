const fs = require('fs');
const path = require('path');

const DEFAULT_PROJECT_ROOT = path.resolve(__dirname, '..');

const AUDIO_ALIASES = {
    XONE: 'config/audio/xone-px5.json',
    Z1: 'config/audio/traktor-z1.json',
    MAC: 'config/audio/blackhole-mac.json',
    BLACKHOLE: 'config/audio/blackhole-mac.json',
};

const MIDI_ALIASES = {
    XONE: 'config/midi/xone-px5.json',
    X1MK3: 'config/midi/traktor-x1mk3.json',
    OSC: 'config/midi/osc.json',
    WEB: 'config/midi/web.json',
};

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
};

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function normalizePlatform(platform = process.platform) {
    return platform === 'darwin' ? 'darwin' : 'linux';
}

function resolveConfigPath(projectRoot, configPath) {
    if (path.isAbsolute(configPath)) {
        return configPath;
    }
    return path.join(projectRoot, configPath);
}

function loadJsonFile(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
        if (err.code === 'ENOENT') {
            throw new Error(`Config file not found: ${filePath}`);
        }
        throw new Error(`Could not read config file ${filePath}: ${err.message}`);
    }
}

function getAliasPath(aliases, name, label) {
    if (!aliases[name]) {
        throw new Error(`Unknown ${label} alias: ${name}`);
    }
    return aliases[name];
}

function getAudioConfigPath(projectRoot, options) {
    if (options.audioConfigPath) {
        return resolveConfigPath(projectRoot, options.audioConfigPath);
    }
    const audioDeviceName = options.audioDevice || 'XONE';
    return resolveConfigPath(DEFAULT_PROJECT_ROOT, getAliasPath(AUDIO_ALIASES, audioDeviceName, 'audio device'));
}

function getMidiConfigPath(projectRoot, options) {
    if (options.midiConfigPath) {
        return resolveConfigPath(projectRoot, options.midiConfigPath);
    }
    const midiDeviceName = options.midiDevice || 'XONE';
    return resolveConfigPath(DEFAULT_PROJECT_ROOT, getAliasPath(MIDI_ALIASES, midiDeviceName, 'MIDI device'));
}

function isPair(value) {
    return Array.isArray(value) && value.length === 2;
}

function normalizeCaptureSource(source, index) {
    if (!source || typeof source !== 'object') {
        throw new Error(`Invalid JACK capturePortPairs entry at index ${index}`);
    }
    if (!source.id) {
        throw new Error(`Missing JACK capture source id at index ${index}`);
    }
    if (!isPair(source.ports)) {
        throw new Error(`Missing JACK capture source ports for ${source.id}`);
    }
    return {
        id: source.id,
        label: source.label || source.id,
        ports: source.ports,
    };
}

function normalizeCaptureSources(jack) {
    if (Array.isArray(jack.capturePortPairs)) {
        if (jack.capturePortPairs.length === 0) {
            throw new Error('Missing JACK capturePortPairs');
        }
        return jack.capturePortPairs.map(normalizeCaptureSource);
    }

    if (!isPair(jack.capturePorts)) {
        throw new Error('Missing JACK capturePorts');
    }

    return [{
        id: 'capture-1',
        label: 'Capture 1',
        ports: jack.capturePorts,
    }];
}

function normalizeMacPdSource(source, index) {
    if (!source || typeof source !== 'object') {
        throw new Error(`Invalid Pd darwinSources entry at index ${index}`);
    }
    if (!source.id) {
        throw new Error(`Missing Pd darwin source id at index ${index}`);
    }
    if (!isPair(source.adc)) {
        throw new Error(`Missing Pd darwin source adc channel pair for ${source.id}`);
    }
    return {
        id: source.id,
        adc: source.adc,
    };
}

function normalizeMacPdSources(pd) {
    if (!Array.isArray(pd.darwinSources)) {
        return [];
    }
    return pd.darwinSources.map(normalizeMacPdSource);
}

function validateAudioConfig(raw) {
    if (!raw.name) {
        throw new Error('Missing audio config name');
    }

    const mode = raw.mode || 'jack';
    if (!['jack', 'native-pd'].includes(mode)) {
        throw new Error(`Unsupported audio mode: ${mode}`);
    }

    if (!raw.pd || !raw.pd.darwin || !raw.pd.linux) {
        throw new Error('Missing Pd channel config for darwin and linux');
    }

    for (const platform of ['darwin', 'linux']) {
        if (!isPair(raw.pd[platform].adc)) {
            throw new Error(`Missing Pd ${platform} adc channel pair`);
        }
        if (!isPair(raw.pd[platform].dac)) {
            throw new Error(`Missing Pd ${platform} dac channel pair`);
        }
    }

    if (mode === 'jack') {
        if (!raw.jack) {
            throw new Error('Missing JACK config');
        }
        normalizeCaptureSources(raw.jack);
        if (!isPair(raw.jack.playbackPorts)) {
            throw new Error('Missing JACK playbackPorts');
        }
    }
}

function normalizeAudioConfig(raw) {
    validateAudioConfig(raw);

    const jack = raw.jack || {};
    const pd = raw.pd || {};
    const captureSources = raw.mode === 'jack' || !raw.mode ? normalizeCaptureSources(jack) : [];
    const capturePorts = captureSources[0] ? captureSources[0].ports : [];

    return {
        name: raw.name,
        mode: raw.mode || 'jack',
        jackCardNameIncludes: jack.cardNameIncludes || '',
        capturePorts,
        captureSources,
        playbackPorts: jack.playbackPorts || [],
        macPdChannels: pd.darwin || { adc: [1, 2], dac: [1, 2] },
        macPdSources: normalizeMacPdSources(pd),
        linuxPdChannels: pd.linux || { adc: [1, 2], dac: [1, 2] },
        jack: {
            sampleRate: jack.sampleRate,
            periodSize: jack.periodSize,
            periods: jack.periods,
        },
    };
}

function requireMidiControl(controls, name, type) {
    const control = controls[name];
    if (!control) {
        throw new Error(`Missing MIDI control: ${name}`);
    }
    return validateMidiControl(control, name, type);
}

function optionalMidiControl(controls, name, type) {
    const control = controls[name];
    if (!control) {
        return null;
    }
    return validateMidiControl(control, name, type);
}

function validateMidiControl(control, name, type) {
    if (control.type !== type) {
        throw new Error(`MIDI control ${name} must be type ${type}`);
    }
    if (typeof control.channel !== 'number') {
        throw new Error(`MIDI control ${name} must include numeric channel`);
    }
    if (type === 'note' && typeof control.note !== 'number') {
        throw new Error(`MIDI control ${name} must include numeric note`);
    }
    if (type === 'cc' && typeof control.controller !== 'number') {
        throw new Error(`MIDI control ${name} must include numeric controller`);
    }
    if (type === 'cc' && control.mode !== 'relative-64') {
        throw new Error(`MIDI control ${name} uses unsupported encoder mode: ${control.mode}`);
    }
    return control;
}

function validateMidiConfig(raw) {
    if (!raw.name) {
        throw new Error('Missing MIDI config name');
    }
    if (!raw.match) {
        throw new Error('Missing MIDI match string');
    }
    if (raw.mode === 'virtual') {
        return;
    }

    const controls = raw.controls || {};
    requireMidiControl(controls, 'slot1Button', 'note');
    requireMidiControl(controls, 'slot2Button', 'note');
    requireMidiControl(controls, 'slot1Encoder', 'cc');
    requireMidiControl(controls, 'slot2Encoder', 'cc');
    optionalMidiControl(controls, 'slot1StartEncoder', 'cc');
    optionalMidiControl(controls, 'slot2StartEncoder', 'cc');
    optionalMidiControl(controls, 'slot1AutoLoop1Beat', 'note');
    optionalMidiControl(controls, 'slot1AutoLoop2Beat', 'note');
    optionalMidiControl(controls, 'slot1AutoLoop4Beat', 'note');
    optionalMidiControl(controls, 'slot1AutoLoop2Bar', 'note');
    optionalMidiControl(controls, 'slot2AutoLoop1Beat', 'note');
    optionalMidiControl(controls, 'slot2AutoLoop2Beat', 'note');
    optionalMidiControl(controls, 'slot2AutoLoop4Beat', 'note');
    optionalMidiControl(controls, 'slot2AutoLoop2Bar', 'note');
    optionalMidiControl(controls, 'slot1Half', 'note');
    optionalMidiControl(controls, 'slot1Double', 'note');
    optionalMidiControl(controls, 'slot2Half', 'note');
    optionalMidiControl(controls, 'slot2Double', 'note');
    optionalMidiControl(controls, 'tapTempo', 'note');
    Object.keys(controls)
        .filter((name) => /^captureSource[0-9]+$/.test(name))
        .forEach((name) => optionalMidiControl(controls, name, 'note'));
    requireMidiControl(controls, 'slot1Reset', 'note');
    requireMidiControl(controls, 'slot2Reset', 'note');
    requireMidiControl(controls, 'monitorButton', 'note');
}

function normalizeNoteControl(control) {
    return control ? { note: control.note, channel: control.channel } : undefined;
}

function normalizeAutoLoopControls(controls, slotPrefix) {
    const mappings = [
        ['1beat', `${slotPrefix}AutoLoop1Beat`],
        ['2beat', `${slotPrefix}AutoLoop2Beat`],
        ['4beat', `${slotPrefix}AutoLoop4Beat`],
        ['2bar', `${slotPrefix}AutoLoop2Bar`],
    ];

    return mappings.reduce((autoLoops, [durationKey, controlName]) => {
        const normalized = normalizeNoteControl(controls[controlName]);
        if (normalized) {
            autoLoops[durationKey] = normalized;
        }
        return autoLoops;
    }, {});
}

function normalizeCaptureSourceControls(controls) {
    return Object.keys(controls)
        .filter((name) => /^captureSource[0-9]+$/.test(name))
        .sort((a, b) => Number(a.replace('captureSource', '')) - Number(b.replace('captureSource', '')))
        .map((name) => normalizeNoteControl(controls[name]));
}

function normalizeMidiConfig(raw) {
    validateMidiConfig(raw);

    if (raw.mode === 'virtual') {
        return {
            name: raw.name,
            midiName: raw.match,
            mode: raw.mode,
        };
    }

    const controls = raw.controls || {};
    const slot1StartEncoder = controls.slot1StartEncoder || {};
    const slot2StartEncoder = controls.slot2StartEncoder || {};

    return {
        name: raw.name,
        midiName: raw.match,
        controls,
        slot1: {
            note: controls.slot1Button.note,
            channel: controls.slot1Button.channel,
            encoderCC: controls.slot1Encoder.controller,
            encoderChannel: controls.slot1Encoder.channel,
            encoderMode: controls.slot1Encoder.mode,
            startEncoderCC: slot1StartEncoder.controller,
            startEncoderChannel: slot1StartEncoder.channel,
            startEncoderMode: slot1StartEncoder.mode,
            autoLoops: normalizeAutoLoopControls(controls, 'slot1'),
            half: normalizeNoteControl(controls.slot1Half),
            double: normalizeNoteControl(controls.slot1Double),
        },
        slot2: {
            note: controls.slot2Button.note,
            channel: controls.slot2Button.channel,
            encoderCC: controls.slot2Encoder.controller,
            encoderChannel: controls.slot2Encoder.channel,
            encoderMode: controls.slot2Encoder.mode,
            startEncoderCC: slot2StartEncoder.controller,
            startEncoderChannel: slot2StartEncoder.channel,
            startEncoderMode: slot2StartEncoder.mode,
            autoLoops: normalizeAutoLoopControls(controls, 'slot2'),
            half: normalizeNoteControl(controls.slot2Half),
            double: normalizeNoteControl(controls.slot2Double),
        },
        monitor: {
            note: controls.monitorButton.note,
            channel: controls.monitorButton.channel,
        },
        encoderPress1: {
            note: controls.slot1Reset.note,
            channel: controls.slot1Reset.channel,
        },
        encoderPress2: {
            note: controls.slot2Reset.note,
            channel: controls.slot2Reset.channel,
        },
        tapTempo: normalizeNoteControl(controls.tapTempo),
        captureSources: normalizeCaptureSourceControls(controls),
    };
}

function getRuntimeConfig(options = {}) {
    const projectRoot = options.projectRoot || DEFAULT_PROJECT_ROOT;
    const platform = normalizePlatform(options.platform);
    const audioConfigPath = getAudioConfigPath(projectRoot, options);
    const midiConfigPath = getMidiConfigPath(projectRoot, options);
    const audio = normalizeAudioConfig(loadJsonFile(audioConfigPath));
    const midi = normalizeMidiConfig(loadJsonFile(midiConfigPath));
    const sourcePatchPath = path.join(projectRoot, 'src', 'engine.pd');
    const runtimePatchPath = path.join(projectRoot, '.runtime', 'engine.pd');
    const pdChannels = platform === 'darwin' ? audio.macPdChannels : audio.linuxPdChannels;
    const generateRuntimePatch = platform === 'darwin';

    return {
        projectRoot,
        platform,
        audioDeviceName: options.audioConfigPath ? audio.name : (options.audioDevice || 'XONE'),
        midiDeviceName: options.midiConfigPath ? midi.name : (options.midiDevice || 'XONE'),
        audioConfigPath,
        midiConfigPath,
        osc: clone(BASE_CONFIG.osc),
        controller: clone(BASE_CONFIG.controller),
        jack: {
            ...clone(BASE_CONFIG.jack),
            ...Object.fromEntries(Object.entries(audio.jack).filter(([, value]) => value !== undefined)),
        },
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
    const pattern = new RegExp(`${objectName}~(?:\\s+[0-9]+)+`, 'g');
    return source.replace(pattern, `${objectName}~ ${channels.join(' ')}`);
}

function renderEnginePatch(source, config) {
    const adcChannels = config.pd.generateRuntimePatch && config.audio.macPdSources.length > 0
        ? config.audio.macPdSources.flatMap((sourceConfig) => sourceConfig.adc)
        : config.pd.channels.adc;
    let rendered = replacePdChannels(source, 'adc', adcChannels);
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
