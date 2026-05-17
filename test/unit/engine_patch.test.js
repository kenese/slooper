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

test('channel_2slot abstraction routes two slots and one monitor path', () => {
    const patchPath = path.join(__dirname, '..', '..', 'src', 'channel_2slot.pd');
    assert.equal(fs.existsSync(patchPath), true);

    const patch = fs.readFileSync(patchPath, 'utf8');

    assert.match(patch, /route \\\$1 \\\$2 monitor/);
    assert.match(patch, /looper_slot \\\$1/);
    assert.match(patch, /looper_slot \\\$2/);
    assert.match(patch, /line~/);
    assert.equal((patch.match(/looper_slot/g) || []).length, 2);
    assert.equal((patch.match(/route \\\$1 \\\$2 monitor/g) || []).length, 1);
    assert.equal((patch.match(/line~/g) || []).length, 1);
});

test('channel_4slot abstraction routes four slots and one monitor path', () => {
    const patchPath = path.join(__dirname, '..', '..', 'src', 'channel_4slot.pd');
    assert.equal(fs.existsSync(patchPath), true);

    const patch = fs.readFileSync(patchPath, 'utf8');

    assert.match(patch, /route \\\$1 \\\$2 \\\$3 \\\$4 monitor/);
    assert.match(patch, /looper_slot \\\$1/);
    assert.match(patch, /looper_slot \\\$2/);
    assert.match(patch, /looper_slot \\\$3/);
    assert.match(patch, /looper_slot \\\$4/);
    assert.match(patch, /line~/);
    assert.equal((patch.match(/looper_slot/g) || []).length, 4);
    assert.equal((patch.match(/route \\\$1 \\\$2 \\\$3 \\\$4 monitor/g) || []).length, 1);
    assert.equal((patch.match(/line~/g) || []).length, 1);
});
