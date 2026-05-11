#!/usr/bin/env node

const {
    getRuntimeConfig,
    renderShellConfig,
    ensureRuntimePatch,
} = require('../src/config');

function parseArgs(argv) {
    const options = {
        mode: 'shell',
    };

    for (const arg of argv) {
        if (arg === '--shell') options.mode = 'shell';
        else if (arg === '--json') options.mode = 'json';
        else if (arg === '--ensure-runtime-patch') options.mode = 'ensure-runtime-patch';
        else if (arg.startsWith('device=')) options.audioDevice = arg.split('=')[1];
        else if (arg.startsWith('audio-device=')) options.audioDevice = arg.split('=')[1];
        else if (arg.startsWith('midi-device=')) options.midiDevice = arg.split('=')[1];
    }

    return options;
}

const options = parseArgs(process.argv.slice(2));
const config = getRuntimeConfig(options);

if (options.mode === 'json') {
    process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
} else if (options.mode === 'ensure-runtime-patch') {
    process.stdout.write(`${ensureRuntimePatch(config)}\n`);
} else {
    process.stdout.write(`${renderShellConfig(config)}\n`);
}
