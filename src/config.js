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

function normalizePositiveInteger(value, fallback, label) {
    const normalized = value === undefined ? fallback : Number(value);
    if (!Number.isInteger(normalized)) {
        throw new Error(`${label} must be an integer`);
    }
    return normalized;
}

function normalizeTopology(options = {}) {
    const channels = normalizePositiveInteger(options.channels, 1, 'channels');
    const slotsPerChannel = normalizePositiveInteger(options.slotsPerChannel, 2, 'slotsPerChannel');

    if (channels < 1 || channels > 4) {
        throw new Error('channels must be between 1 and 4');
    }

    if (![2, 4].includes(slotsPerChannel)) {
        throw new Error('slotsPerChannel must be 2 or 4');
    }

    return {
        channels,
        slotsPerChannel,
        totalSlots: channels * slotsPerChannel,
    };
}

function buildSlots(topology) {
    return Array.from({ length: topology.totalSlots }, (_, index) => {
        const id = index + 1;
        return {
            id,
            name: `slot${id}`,
            channelId: Math.floor(index / topology.slotsPerChannel) + 1,
            indexInChannel: (index % topology.slotsPerChannel) + 1,
        };
    });
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
    const key = String(name).toUpperCase();
    if (!aliases[key]) {
        throw new Error(`Unknown ${label} alias: ${name}`);
    }
    return aliases[key];
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
    if (!control || !control.type) {
        return null;
    }
    return validateMidiControl(control, name, type);
}

function requireMidiControlValue(control, name, type) {
    if (!control) {
        throw new Error(`Missing MIDI control: ${name}`);
    }
    return validateMidiControl(control, name, type);
}

function validateMidiControl(control, name, type) {
    if (!control || typeof control !== 'object') {
        throw new Error(`MIDI control ${name} must be type ${type}`);
    }
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

function validateDynamicAutoLoopControls(slotControls, controlName) {
    if (slotControls.autoLoops === undefined) {
        return;
    }
    if (!slotControls.autoLoops || typeof slotControls.autoLoops !== 'object' || Array.isArray(slotControls.autoLoops)) {
        throw new Error(`MIDI control ${controlName}.autoLoops must be an object`);
    }
    Object.entries(slotControls.autoLoops).forEach(([durationKey, control]) => {
        validateMidiControl(control, `${controlName}.autoLoops.${durationKey}`, 'note');
    });
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
    if (controls.slots) {
        Object.entries(controls.slots).forEach(([slotName, slotControls]) => {
            const controlName = `slots.${slotName}`;
            if (!slotControls || typeof slotControls !== 'object') {
                throw new Error(`Missing MIDI slot controls for ${slotName}`);
            }
            requireMidiControlValue(slotControls.button, `${controlName}.button`, 'note');
            requireMidiControlValue(slotControls.endEncoder, `${controlName}.endEncoder`, 'cc');
            optionalMidiControl(slotControls, 'startEncoder', 'cc');
            optionalMidiControl(slotControls, 'moveEncoder', 'cc');
            optionalMidiControl(slotControls, 'half', 'note');
            optionalMidiControl(slotControls, 'double', 'note');
            validateDynamicAutoLoopControls(slotControls, controlName);
            requireMidiControlValue(slotControls.reset, `${controlName}.reset`, 'note');
        });
        optionalMidiControl(controls, 'tapTempo', 'note');
        Object.keys(controls)
            .filter((name) => /^captureSource[0-9]+$/.test(name))
            .forEach((name) => optionalMidiControl(controls, name, 'note'));
        requireMidiControl(controls, 'monitorButton', 'note');
        return;
    }

    requireMidiControl(controls, 'slot1Button', 'note');
    requireMidiControl(controls, 'slot2Button', 'note');
    requireMidiControl(controls, 'slot1EndEncoder', 'cc');
    requireMidiControl(controls, 'slot2EndEncoder', 'cc');
    optionalMidiControl(controls, 'slot1StartEncoder', 'cc');
    optionalMidiControl(controls, 'slot2StartEncoder', 'cc');
    optionalMidiControl(controls, 'slot1MoveEncoder', 'cc');
    optionalMidiControl(controls, 'slot2MoveEncoder', 'cc');
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

function normalizeDynamicAutoLoopControls(autoLoops = {}) {
    return Object.entries(autoLoops).reduce((normalized, [durationKey, control]) => {
        normalized[durationKey] = normalizeNoteControl(control);
        return normalized;
    }, {});
}

function normalizeSlotControl(control = {}) {
    return {
        note: control.button && control.button.note,
        channel: control.button && control.button.channel,
        encoderCC: control.endEncoder && control.endEncoder.controller,
        encoderChannel: control.endEncoder && control.endEncoder.channel,
        encoderMode: control.endEncoder && control.endEncoder.mode,
        startEncoderCC: control.startEncoder ? control.startEncoder.controller : undefined,
        startEncoderChannel: control.startEncoder ? control.startEncoder.channel : undefined,
        startEncoderMode: control.startEncoder ? control.startEncoder.mode : undefined,
        moveEncoderCC: control.moveEncoder ? control.moveEncoder.controller : undefined,
        moveEncoderChannel: control.moveEncoder ? control.moveEncoder.channel : undefined,
        moveEncoderMode: control.moveEncoder ? control.moveEncoder.mode : undefined,
        autoLoops: normalizeDynamicAutoLoopControls(control.autoLoops),
        half: normalizeNoteControl(control.half),
        double: normalizeNoteControl(control.double),
        reset: normalizeNoteControl(control.reset),
    };
}

function normalizeLegacySlotControl(controls, slotName) {
    return normalizeSlotControl({
        button: controls[`${slotName}Button`],
        endEncoder: controls[`${slotName}EndEncoder`],
        startEncoder: controls[`${slotName}StartEncoder`],
        moveEncoder: controls[`${slotName}MoveEncoder`],
        reset: controls[`${slotName}Reset`],
        half: controls[`${slotName}Half`],
        double: controls[`${slotName}Double`],
        autoLoops: normalizeAutoLoopControls(controls, slotName),
    });
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
    const slots = {};
    if (controls.slots) {
        Object.entries(controls.slots).forEach(([slotName, control]) => {
            slots[slotName] = normalizeSlotControl(control);
        });
    } else {
        slots.slot1 = normalizeLegacySlotControl(controls, 'slot1');
        slots.slot2 = normalizeLegacySlotControl(controls, 'slot2');
    }

    return {
        name: raw.name,
        midiName: raw.match,
        controls,
        slots,
        slot1: slots.slot1,
        slot2: slots.slot2,
        monitor: {
            note: controls.monitorButton.note,
            channel: controls.monitorButton.channel,
        },
        encoderPress1: slots.slot1 && slots.slot1.reset,
        encoderPress2: slots.slot2 && slots.slot2.reset,
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
    const generateRuntimePatch = true;
    const topology = normalizeTopology(options);
    const slots = buildSlots(topology);

    return {
        projectRoot,
        platform,
        topology,
        slots,
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
    const pattern = new RegExp(`(?<=^#X obj \\d+ \\d+ )${objectName}~(?:\\s+[0-9]+)+`, 'gm');
    return source.replace(pattern, `${objectName}~ ${channels.join(' ')}`);
}

function parsePdObjects(source) {
    const objects = [];

    source.split('\n').forEach((line) => {
        if (line.startsWith('#X ') && !line.startsWith('#X connect ')) {
            objects.push({ id: objects.length, line });
        }
    });

    return objects;
}

function getRouteItems(line) {
    const match = line.match(/^#X obj \d+ \d+ route (.+);$/);
    return match ? match[1].trim().split(/\s+/) : [];
}

function rewriteMacSourceSelectorConnections(source, config) {
    if (!config.pd.generateRuntimePatch || config.audio.macPdSources.length === 0) {
        return source;
    }

    const objects = parsePdObjects(source);
    const adc = objects.find((object) => /^#X obj \d+ \d+ adc~ /.test(object.line));
    const sourceRoute = objects.find((object) => /^#X obj \d+ \d+ route main ch2 ch3;$/.test(object.line));

    if (!adc || !sourceRoute) {
        return source;
    }

    const routeSources = getRouteItems(sourceRoute.line);
    const sourceOutletMap = new Map();
    config.audio.macPdSources.forEach((sourceConfig, index) => {
        sourceOutletMap.set(sourceConfig.id, index * 2);
    });

    const lines = source.split('\n');
    const adcInputConnectionPattern = new RegExp(`^#X connect ${adc.id} \\d+ (\\d+) (\\d+);$`);
    const sourceInputConnections = [];

    lines.forEach((line, index) => {
        const match = line.match(adcInputConnectionPattern);
        if (match) {
            sourceInputConnections.push({
                index,
                target: Number(match[1]),
                targetInlet: Number(match[2]),
            });
        }
    });

    if (sourceInputConnections.length !== routeSources.length * 2) {
        throw new Error('Pd source selector input connections do not match source route');
    }

    sourceInputConnections.forEach((connection, index) => {
        const sourceId = routeSources[Math.floor(index / 2)];
        const sourceOutlet = sourceOutletMap.get(sourceId);
        if (sourceOutlet === undefined) {
            throw new Error(`Missing mac Pd source channel mapping for ${sourceId}`);
        }
        const adcOutlet = sourceOutlet + (index % 2);
        lines[connection.index] = `#X connect ${adc.id} ${adcOutlet} ${connection.target} ${connection.targetInlet};`;
    });

    return lines.join('\n');
}

function buildPdChannelList(pairCount) {
    return Array.from({ length: pairCount * 2 }, (_, index) => index + 1);
}

function renderGeneratedEnginePatch(config) {
    const topology = config.topology;
    const slots = config.slots;
    const audioChannels = buildPdChannelList(topology.channels);
    const abstraction = topology.slotsPerChannel === 4 ? 'channel_4slot' : 'channel_2slot';
    const monitorRoutes = Array.from(
        { length: topology.channels },
        (_, index) => `monitor${index + 1}`
    );
    const lines = [
        '#N canvas 171 24 1100 700 10;',
        '#X declare -path ../src;',
        '#X obj 13 8 netreceive -u -b 9000;',
        '#X obj 14 29 oscparse;',
        '#X obj 14 63 list trim;',
        `#X obj 201 112 route connect source ${monitorRoutes.join(' ')};`,
        `#X obj 14 130 adc~ ${audioChannels.join(' ')};`,
        `#X obj 184 560 dac~ ${audioChannels.join(' ')};`,
        '#X obj 535 8 loadbang;',
        '#X msg 535 63 \\; pd dsp 1;',
        '#X obj 505 398 netsend -u -b;',
        '#X obj 505 318 loadbang;',
        '#X msg 505 364 connect 127.0.0.1 9001;',
    ];

    const netreceive = 0;
    const oscparse = 1;
    const listTrim = 2;
    const route = 3;
    const adc = 4;
    const dac = 5;
    const dspLoadbang = 6;
    const dspMessage = 7;
    const netsend = 8;
    const netsendLoadbang = 9;
    const connectMessage = 10;
    const channelStart = 11;
    const monitorMessageStart = channelStart + topology.channels;

    for (let channelIndex = 0; channelIndex < topology.channels; channelIndex += 1) {
        const channelSlots = slots
            .filter((slot) => slot.channelId === channelIndex + 1)
            .map((slot) => slot.name);
        lines.push(
            `#X obj ${14 + channelIndex * 260} 283 ${abstraction} ${channelSlots.join(' ')};`
        );
    }

    for (let channelIndex = 0; channelIndex < topology.channels; channelIndex += 1) {
        lines.push(`#X msg ${14 + channelIndex * 260} 224 monitor \\$1;`);
    }

    const connections = [
        `#X connect ${netreceive} 0 ${oscparse} 0;`,
        `#X connect ${oscparse} 0 ${listTrim} 0;`,
        `#X connect ${listTrim} 0 ${route} 0;`,
        `#X connect ${route} 0 ${connectMessage} 0;`,
        `#X connect ${dspLoadbang} 0 ${dspMessage} 0;`,
        `#X connect ${netsendLoadbang} 0 ${connectMessage} 0;`,
        `#X connect ${connectMessage} 0 ${netsend} 0;`,
    ];

    for (let channelIndex = 0; channelIndex < topology.channels; channelIndex += 1) {
        const channelObject = channelStart + channelIndex;
        const monitorMessage = monitorMessageStart + channelIndex;
        const monitorOutlet = 2 + channelIndex;
        const unmatchedOutlet = 2 + topology.channels;
        connections.push(`#X connect ${route} ${unmatchedOutlet} ${channelObject} 2;`);
        connections.push(`#X connect ${route} ${monitorOutlet} ${monitorMessage} 0;`);
        connections.push(`#X connect ${monitorMessage} 0 ${channelObject} 2;`);
        connections.push(`#X connect ${adc} ${channelIndex * 2} ${channelObject} 0;`);
        connections.push(`#X connect ${adc} ${channelIndex * 2 + 1} ${channelObject} 1;`);
        connections.push(`#X connect ${channelObject} 0 ${dac} ${channelIndex * 2};`);
        connections.push(`#X connect ${channelObject} 1 ${dac} ${channelIndex * 2 + 1};`);
        connections.push(`#X connect ${channelObject} 2 ${netsend} 0;`);
    }

    return `${lines.join('\n')}\n${connections.join('\n')}\n`;
}

function renderEnginePatch(source, config) {
    if (config.topology) {
        return renderGeneratedEnginePatch(config);
    }

    const adcChannels = config.pd.generateRuntimePatch && config.audio.macPdSources.length > 0
        ? config.audio.macPdSources.flatMap((sourceConfig) => sourceConfig.adc)
        : config.pd.channels.adc;
    let rendered = replacePdChannels(source, 'adc', adcChannels);
    rendered = replacePdChannels(rendered, 'dac', config.pd.channels.dac);
    rendered = rewriteMacSourceSelectorConnections(rendered, config);
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
