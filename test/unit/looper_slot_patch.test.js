const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const patchPath = path.join(__dirname, '../../src/looper_slot.pd');

function parsePatch() {
    const lines = fs.readFileSync(patchPath, 'utf8').split(/\n/);
    const objects = [];
    const connections = [];

    for (const line of lines) {
        if (/^#X connect /.test(line)) {
            const [, source, sourceOutlet, target, targetInlet] = line.match(
                /^#X connect (\d+) (\d+) (\d+) (\d+);$/
            );
            connections.push({
                source: Number(source),
                sourceOutlet: Number(sourceOutlet),
                target: Number(target),
                targetInlet: Number(targetInlet),
            });
        } else if (/^#X /.test(line) && !line.startsWith('#X f ')) {
            objects.push(line);
        }
    }

    return { objects, connections };
}

function findObject(objects, pattern) {
    const index = objects.findIndex((line) => pattern.test(line));
    assert.notEqual(index, -1, `Missing Pd object matching ${pattern}`);
    return index;
}

function hasConnection(connections, source, sourceOutlet, target, targetInlet) {
    return connections.some((connection) =>
        connection.source === source &&
        connection.sourceOutlet === sourceOutlet &&
        connection.target === target &&
        connection.targetInlet === targetInlet
    );
}

test('rec stop keeps writing delayed input long enough to capture pre-roll and tail audio', () => {
    const { objects, connections } = parsePatch();

    const recStopTrigger = findObject(objects, /#X obj \d+ \d+ t b b;/);
    const stopMessage = findObject(objects, /#X msg \d+ \d+ stop;/);
    const delayedStop = findObject(objects, /#X obj \d+ \d+ del 2000;/);
    const leftPreWrite = findObject(objects, /delwrite~ \\\$1_pre_L 1000/);
    const leftPreRead = findObject(objects, /delread~ \\\$1_pre_L 1000/);
    const rightPreWrite = findObject(objects, /delwrite~ \\\$1_pre_R 1000/);
    const rightPreRead = findObject(objects, /delread~ \\\$1_pre_R 1000/);
    const leftInput = findObject(objects, /#X obj 13 45 inlet~;/);
    const rightInput = findObject(objects, /#X obj 76 45 inlet~;/);
    const leftTabwrite = findObject(objects, /tabwrite~ \\\$1_data;/);
    const rightTabwrite = findObject(objects, /tabwrite~ \\\$1_data_R;/);

    assert.ok(
        hasConnection(connections, recStopTrigger, 1, delayedStop, 0),
        'rec 0 should schedule a 2000ms delayed tabwrite stop'
    );
    assert.ok(
        hasConnection(connections, delayedStop, 0, stopMessage, 0),
        'delayed stop should send stop to both tabwrite~ buffers'
    );
    assert.equal(
        hasConnection(connections, recStopTrigger, 1, stopMessage, 0),
        false,
        'rec 0 should not stop tabwrite~ immediately'
    );
    assert.ok(hasConnection(connections, leftInput, 0, leftPreWrite, 0));
    assert.ok(hasConnection(connections, leftPreRead, 0, leftTabwrite, 0));
    assert.ok(hasConnection(connections, rightInput, 0, rightPreWrite, 0));
    assert.ok(hasConnection(connections, rightPreRead, 0, rightTabwrite, 0));
});

test('patch exposes cropStart control and offsets playback by pre-roll plus start crop', () => {
    const { objects, connections } = parsePatch();

    const route = findObject(objects, /route rec play crop cropStart reset clear/);
    const startState = findObject(objects, /list prepend \\\$1 start/);
    const offsetBase = findObject(objects, /#X obj \d+ \d+ \+ 1000;/);
    const offsetSignal = findObject(objects, /#X obj \d+ \d+ sig~;/);
    const playbackOffset = findObject(objects, /#X obj \d+ \d+ \+~;/);
    const positionScale = findObject(objects, /#X obj 523 768 \*~;/);
    const leftTabread = findObject(objects, /tabread4~ \\\$1_data;/);
    const rightTabread = findObject(objects, /tabread4~ \\\$1_data_R;/);

    assert.ok(
        connections.some((connection) => connection.source === route && connection.sourceOutlet === 3),
        'cropStart route outlet should be wired'
    );
    assert.ok(
        connections.some((connection) => connection.target === startState),
        'cropStart should emit a start offset state message'
    );
    assert.ok(
        connections.some((connection) => connection.target === offsetBase),
        'start crop should feed the +1000ms pre-roll playback offset'
    );
    assert.ok(hasConnection(connections, offsetSignal, 0, playbackOffset, 1));
    assert.ok(hasConnection(connections, positionScale, 0, playbackOffset, 0));
    assert.ok(hasConnection(connections, playbackOffset, 0, leftTabread, 0));
    assert.ok(hasConnection(connections, playbackOffset, 0, rightTabread, 0));
});
