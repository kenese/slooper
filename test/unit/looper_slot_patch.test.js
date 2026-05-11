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

test('rec stop keeps writing one second of tail audio before stopping tabwrite buffers', () => {
    const { objects, connections } = parsePatch();

    const recStopTrigger = findObject(objects, /#X obj \d+ \d+ t b b;/);
    const stopMessage = findObject(objects, /#X msg \d+ \d+ stop;/);
    const delayedStop = findObject(objects, /#X obj \d+ \d+ del 1000;/);

    assert.ok(
        hasConnection(connections, recStopTrigger, 1, delayedStop, 0),
        'rec 0 should schedule a 1000ms delayed tabwrite stop'
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
});
