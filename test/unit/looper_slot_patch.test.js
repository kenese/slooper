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
    const delayedStop = findObject(objects, /#X obj \d+ \d+ del 21000;/);
    const leftArray = findObject(objects, /array define \\\$1_data 1968000/);
    const rightArray = findObject(objects, /array define \\\$1_data_R 1968000/);
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
        'rec 0 should schedule a 21000ms delayed tabwrite stop'
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
    assert.ok(leftArray >= 0);
    assert.ok(rightArray >= 0);
});

test('patch exposes cropStart control and offsets playback by pre-roll plus start crop', () => {
    const { objects, connections } = parsePatch();

    const route = findObject(objects, /route rec play crop cropStart reset clear setLength/);
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

test('patch exposes setLength control and emits effective length state', () => {
    const { objects, connections } = parsePatch();

    const route = findObject(objects, /route rec play crop cropStart reset clear setLength/);
    const setLengthTrigger = findObject(objects, /#X obj \d+ \d+ t f b;/);
    const setLengthAdd = findObject(objects, /#X obj 1070 207 \+;/);
    const currentEndClip = findObject(objects, /#X obj 673 385 clip 100 41000;/);
    const currentEnd = findObject(objects, /#X obj 736 302 f;/);
    const startOffsetMemory = findObject(objects, /#X obj 920 171 f;/);
    const lengthState = findObject(objects, /list prepend \\\$1 length/);

    assert.ok(
        hasConnection(connections, route, 6, setLengthTrigger, 0),
        'setLength route outlet should feed setLength trigger'
    );
    assert.ok(
        hasConnection(connections, setLengthTrigger, 1, startOffsetMemory, 0),
        'setLength should bang the current start offset before applying length'
    );
    assert.ok(hasConnection(connections, startOffsetMemory, 0, setLengthAdd, 1));
    assert.ok(
        hasConnection(connections, setLengthTrigger, 0, setLengthAdd, 0),
        'requested effective length should feed + left inlet'
    );
    assert.ok(
        hasConnection(connections, setLengthAdd, 0, currentEndClip, 0),
        'setLength should update current end length through the normal end clip'
    );
    assert.ok(
        hasConnection(connections, currentEndClip, 0, currentEnd, 1),
        'setLength result should update current end length state'
    );
    assert.ok(
        connections.some((connection) => connection.target === lengthState),
        'setLength should reuse length state output'
    );
});
