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

test('start.sh checks web port availability before launching Pure Data', () => {
    assert.match(startScript, /check_web_port_available\(\)/);
    assert.match(
        startScript,
        /echo "Stopping previously tracked Slooper processes\.\.\."\ntracked_cleanup\ncheck_web_port_available\n\nlog_success "Configuring audio for: \$AUDIO_DEVICE"/
    );
});

test('start.sh exposes colored success and error log helpers', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../start.sh'), 'utf8');

    assert.match(source, /GREEN=\$'\\033\[32m'/);
    assert.match(source, /RED=\$'\\033\[31m'/);
    assert.match(source, /log_success\(\)/);
    assert.match(source, /log_error\(\)/);
});

test('start.sh prints selected explicit audio routing mode in green', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../start.sh'), 'utf8');

    assert.match(source, /runtime_mode_label\(\)/);
    assert.match(source, /echo "Send Mode"/);
    assert.match(source, /echo "Channel Mode \(1 channel\)"/);
    assert.match(source, /echo "Channel Mode \(\$CHANNELS channels\)"/);
    assert.match(source, /log_success "\$\(runtime_mode_label\)"/);
});

test('start.sh --print-config reports explicit channel routing mode', () => {
    const output = execFileSync('bash', [
        'start.sh',
        '--print-config',
        'audio-device=XONE_2C',
        'midi-device=X1MK3_2C',
        'channels=2',
        'slots-per-channel=2',
    ], {
        cwd: projectRoot,
        encoding: 'utf8',
    });
    const config = JSON.parse(output);

    assert.equal(config.audio.routingMode, 'channel');
    assert.equal(config.topology.channels, 2);
});

test('start script forwards topology arguments into runtime config', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../start.sh'), 'utf8');

    assert.match(source, /CHANNELS=/);
    assert.match(source, /SLOTS_PER_CHANNEL=/);
    assert.match(source, /"channels=\$CHANNELS"/);
    assert.match(source, /"slots-per-channel=\$SLOTS_PER_CHANNEL"/);
});

test('start script connects configured JACK port pairs for each channel', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../start.sh'), 'utf8');

    assert.match(source, /JACK_CAPTURE_PORT_PAIRS/);
    assert.match(source, /JACK_PLAYBACK_PORT_PAIRS/);
    assert.match(source, /for \(\(i = 0; i < CHANNELS; i\+\+\)\); do/);
    assert.match(source, /PD_IN_LEFT="pure_data:input_\$\(\(i \* 2 \+ 1\)\)"/);
    assert.match(source, /PD_OUT_RIGHT="pure_data:output_\$\(\(i \* 2 \+ 2\)\)"/);
    assert.match(source, /connect_jack_port "\$CAPTURE_LEFT" "\$PD_IN_LEFT" "Input"/);
    assert.match(source, /connect_jack_port "\$PD_OUT_RIGHT" "\$PLAYBACK_RIGHT" "Output"/);
    assert.doesNotMatch(source, /jack_connect "\$JACK_CAPTURE_LEFT" pure_data:input_1/);
});

test('start script opens enough Pure Data JACK ports for configured channels', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../start.sh'), 'utf8');

    assert.match(source, /PD_AUDIO_CHANNELS="\$\(\(CHANNELS \* 2\)\)"/);
    assert.match(source, /pd -nogui -jack -nomidi -inchannels "\$PD_AUDIO_CHANNELS" -outchannels "\$PD_AUDIO_CHANNELS" "\$PD_PATCH_PATH"/);
});

test('start script clears automatic JACK links before applying configured routing', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../start.sh'), 'utf8');

    assert.match(source, /clear_pd_jack_port_connections\(\)/);
    assert.doesNotMatch(source, /port_index <= 32/);
    assert.match(source, /disconnect_pd_input_connections "\$PD_IN_LEFT"/);
    assert.match(source, /disconnect_pd_output_connections "\$PD_OUT_RIGHT"/);
    assert.match(source, /jack_lsp -c "\$pd_port"/);
    assert.match(source, /jack_disconnect "\$connected_port" "\$pd_port"/);
    assert.match(source, /jack_disconnect "\$pd_port" "\$connected_port"/);
    assert.match(source, /clear_pd_jack_port_connections\n\n        echo "   Input:/);
});

test('start.sh --print-config applies forwarded topology arguments', () => {
    const output = execFileSync('bash', [
        'start.sh',
        '--print-config',
        'audio-device=MAC',
        'midi-device=WEB',
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
