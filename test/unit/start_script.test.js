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
