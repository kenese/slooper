const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../../public/dev-controller.html'), 'utf8');

test('dev controller exposes separate start and end crop controls', () => {
    assert.match(html, /Start Crop/);
    assert.match(html, /End Crop/);
    assert.match(html, /data-action="cropStartDown"/);
    assert.match(html, /data-action="cropStartUp"/);
    assert.match(html, /data-action="cropDown"/);
    assert.match(html, /data-action="cropUp"/);
});

test('dev controller exposes move controls and displays rounded whole milliseconds', () => {
    assert.match(html, /data-action="moveDown"/);
    assert.match(html, /data-action="moveUp"/);
    assert.match(html, /Move -30/);
    assert.match(html, /Move \+30/);
    assert.match(html, /function wholeMs\(value\)/);
    assert.match(html, /\$\{wholeMs\(slot\.currentLengthMs\)\} ms/);
    assert.match(html, /\$\{signed\(startCrop\)\} ms/);
    assert.match(html, /\$\{signed\(endCrop\)\} ms/);
});
