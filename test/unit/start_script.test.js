const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const startScript = fs.readFileSync(path.join(__dirname, '..', '..', 'start.sh'), 'utf8');
const projectRoot = path.join(__dirname, '..', '..');

test('start.sh does not mutate tracked Pd source with sed', () => {
    assert.doesNotMatch(startScript, /sed -i/);
    assert.doesNotMatch(startScript, /run_sed/);
    assert.doesNotMatch(startScript, /src\/engine\.pd\s*$/m);
});

test('start.sh exposes dry-run runtime config mode', () => {
    assert.match(startScript, /--print-config/);
    assert.match(startScript, /scripts\/runtime_config\.js --json/);
});

test('start.sh mac cleanup stops untracked Pd processes and inspects common dev ports', () => {
    assert.match(startScript, /stop_untracked_macos_pd\(\)/);
    assert.match(startScript, /killall "Pd-0\.56-2" 2>\/dev\/null \|\| true/);
    assert.match(startScript, /killall Pd 2>\/dev\/null \|\| true/);
    assert.match(startScript, /killall pd 2>\/dev\/null \|\| true/);
    assert.match(startScript, /lsof -nP -iUDP:9000 -iUDP:9001 -iTCP:3000 2>\/dev\/null \|\| true/);
});

test('start.sh avoids awk built-in names for JACK card lookup variables', () => {
    assert.doesNotMatch(startScript, /awk -v match=/);
});

test('start.sh parses numeric ALSA card id from aplay output for JACK', () => {
    assert.ok(startScript.includes('sub(/:$/, "", $2); print $2; exit'));
    assert.doesNotMatch(startScript, /sub\(\/\^card \//);
});

test('start.sh force cleanup stops Slooper MIDI diagnostics that can hold ALSA ports', () => {
    assert.match(startScript, /pkill -f "node src\/midi_logger\.js" 2>\/dev\/null \|\| true/);
});

test('start script forwards topology arguments into runtime config', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../start.sh'), 'utf8');

    assert.match(source, /CHANNELS=/);
    assert.match(source, /SLOTS_PER_CHANNEL=/);
    assert.match(source, /"channels=\$CHANNELS"/);
    assert.match(source, /"slots-per-channel=\$SLOTS_PER_CHANNEL"/);
});

test('start.sh --print-config applies forwarded topology arguments', () => {
    const output = execFileSync('bash', [
        'start.sh',
        '--print-config',
        'channels=2',
        'slots-per-channel=4',
    ], {
        cwd: projectRoot,
        encoding: 'utf8',
    });
    const config = JSON.parse(output);

    assert.equal(config.topology.channels, 2);
    assert.equal(config.topology.slotsPerChannel, 4);
    assert.equal(config.topology.totalSlots, 8);
});

test('start.sh --print-config rejects topology values with embedded spaces', () => {
    assert.throws(
        () => execFileSync('bash', [
            'start.sh',
            '--print-config',
            'channels=2 3',
            'slots-per-channel=4',
        ], {
            cwd: projectRoot,
            encoding: 'utf8',
            stdio: 'pipe',
        }),
        /channels must be an integer/
    );
});
