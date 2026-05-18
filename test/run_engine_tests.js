const { spawn } = require('node:child_process');
const path = require('node:path');
const {
    getRuntimeConfig,
    ensureRuntimePatch,
} = require('../src/config');

const projectRoot = path.resolve(__dirname, '..');
const config = getRuntimeConfig({
    audioDevice: 'MAC',
    midiDevice: 'WEB',
    platform: process.platform,
    projectRoot,
    channels: 2,
    slotsPerChannel: 2,
});
const patchPath = ensureRuntimePatch(config);
const pdCommand = process.env.SLOOPER_PD_CMD || 'pd';
const pdArgs = process.env.SLOOPER_PD_ARGS
    ? process.env.SLOOPER_PD_ARGS.split(/\s+/).filter(Boolean)
    : ['-nogui', '-nomidi', patchPath];

let pd;

function shutdown(code) {
    if (pd && !pd.killed) {
        pd.kill('SIGTERM');
    }
    process.exit(code);
}

pd = spawn(pdCommand, pdArgs, {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
});

pd.on('error', (err) => {
    console.error(`Unable to start Pure Data with "${pdCommand}": ${err.message}`);
    shutdown(1);
});

pd.stdout.on('data', (chunk) => process.stdout.write(chunk));
pd.stderr.on('data', (chunk) => process.stderr.write(chunk));

setTimeout(() => {
    const tests = spawn(process.execPath, ['test/test_engine.js'], {
        cwd: projectRoot,
        stdio: 'inherit',
    });

    tests.on('exit', (code) => shutdown(code || 0));
}, 1500);

process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(143));
