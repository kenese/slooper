const http = require('http');
const path = require('path');
const fs = require('fs');
const { Client } = require('node-osc');

const HOST = '127.0.0.1';
const PORT = Number(process.env.SLOOPER_WEB_PORT || 3000);
const OSC_HOST = '127.0.0.1';
const OSC_PORT = 9000;
const CROP_STEP_MS = 30;

const client = new Client(OSC_HOST, OSC_PORT);
const htmlPath = path.join(__dirname, '..', 'public', 'dev-controller.html');

const slots = [
    { id: 1, state: 0, recordStartTime: 0, originalLength: 0, cropOffset: 0 },
    { id: 2, state: 0, recordStartTime: 0, originalLength: 0, cropOffset: 0 },
];

let monitorEnabled = false;

function sendOSC(address, ...args) {
    return new Promise((resolve, reject) => {
        client.send(address, ...args, (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

function serializeSlot(slot) {
    return {
        id: slot.id,
        state: slot.state,
        stateLabel: ['EMPTY', 'RECORDING', 'PLAYING', 'STOPPED'][slot.state],
        lengthMs: slot.originalLength,
        cropOffset: slot.cropOffset,
        currentLengthMs: Math.max(0, slot.originalLength + slot.cropOffset),
    };
}

function getState() {
    return {
        slots: slots.map(serializeSlot),
        monitorEnabled,
        monitorActive: monitorEnabled && !slots.some((slot) => slot.state === 2),
    };
}

async function updateMonitorState() {
    const anyPlaying = slots.some((slot) => slot.state === 2);
    await sendOSC('/monitor', monitorEnabled && !anyPlaying ? 1 : 0);
}

async function tapSlot(slot) {
    const address = `/slot${slot.id}`;

    if (slot.state === 0) {
        slot.recordStartTime = Date.now();
        slot.cropOffset = 0;
        await sendOSC(address, 'rec', 1);
        slot.state = 1;
        return;
    }

    if (slot.state === 1) {
        slot.originalLength = Date.now() - slot.recordStartTime;
        await sendOSC(address, 'rec', 0);
        await sendOSC(address, 'play', 1);
        slot.state = 2;
        await updateMonitorState();
        return;
    }

    if (slot.state === 2) {
        await sendOSC(address, 'play', 0);
        slot.state = 3;
        await updateMonitorState();
        return;
    }

    if (slot.state === 3) {
        await sendOSC(address, 'play', 1);
        slot.state = 2;
        await updateMonitorState();
    }
}

async function clearSlot(slot) {
    const address = `/slot${slot.id}`;
    await sendOSC(address, 'play', 0);
    await sendOSC(address, 'clear', 1);
    slot.state = 0;
    slot.recordStartTime = 0;
    slot.originalLength = 0;
    slot.cropOffset = 0;
    await updateMonitorState();
}

async function cropSlot(slot, delta) {
    if (slot.state !== 2) return;
    slot.cropOffset += delta;
    await sendOSC(`/slot${slot.id}`, 'crop', delta);
}

async function resetSlot(slot) {
    if (slot.state !== 2) return;
    slot.cropOffset = 0;
    await sendOSC(`/slot${slot.id}`, 'reset', 1);
}

async function handleAction(action, slotId) {
    const slot = slots[slotId - 1];

    if (action === 'monitor') {
        monitorEnabled = !monitorEnabled;
        await updateMonitorState();
        return;
    }

    if (!slot) {
        throw new Error(`Unknown slot: ${slotId}`);
    }

    if (action === 'tap') await tapSlot(slot);
    else if (action === 'clear') await clearSlot(slot);
    else if (action === 'cropDown') await cropSlot(slot, -CROP_STEP_MS);
    else if (action === 'cropUp') await cropSlot(slot, CROP_STEP_MS);
    else if (action === 'reset') await resetSlot(slot);
    else throw new Error(`Unknown action: ${action}`);
}

function readJson(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
            if (body.length > 1e6) {
                req.destroy();
                reject(new Error('Request too large'));
            }
        });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (err) {
                reject(err);
            }
        });
        req.on('error', reject);
    });
}

function sendJson(res, statusCode, data) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
    try {
        if (req.method === 'GET' && req.url === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(fs.readFileSync(htmlPath, 'utf8'));
            return;
        }

        if (req.method === 'GET' && req.url === '/api/state') {
            sendJson(res, 200, getState());
            return;
        }

        if (req.method === 'POST' && req.url === '/api/action') {
            const body = await readJson(req);
            await handleAction(body.action, Number(body.slot));
            sendJson(res, 200, getState());
            return;
        }

        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
    } catch (err) {
        sendJson(res, 500, { error: err.message, ...getState() });
    }
});

server.listen(PORT, HOST, () => {
    console.log(`OSC web controller: http://${HOST}:${PORT}`);
    console.log(`Sending OSC to ${OSC_HOST}:${OSC_PORT}`);
});

function shutdown() {
    server.close(() => {
        client.close();
        process.exit(0);
    });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
