const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('engine patch accepts source selection messages', () => {
    const patch = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'engine.pd'), 'utf8');

    assert.match(patch, /route slot1 slot2 monitor connect source/);
    assert.match(patch, /route main ch2 ch3/);
    assert.match(patch, /line~/);
});
