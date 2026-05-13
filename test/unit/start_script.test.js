const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const startScript = fs.readFileSync(path.join(__dirname, '..', '..', 'start.sh'), 'utf8');

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
