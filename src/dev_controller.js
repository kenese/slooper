const http = require('http');
const path = require('path');
const fs = require('fs');

const { getRuntimeConfig } = require('./config');
const { createController } = require('./controller/slot_controller');
const { OscTransport } = require('./controller/osc_transport');

const HOST = '127.0.0.1';
const PORT = Number(process.env.SLOOPER_WEB_PORT || 3000);
const htmlPath = path.join(__dirname, '..', 'public', 'dev-controller.html');

const runtimeConfig = getRuntimeConfig({
    audioDevice: process.env.SLOOPER_AUDIO_DEVICE || 'MAC',
    midiDevice: 'WEB',
});

runtimeConfig.osc.sendPort = Number(process.env.SLOOPER_OSC_SEND_PORT || runtimeConfig.osc.sendPort);
runtimeConfig.osc.statePort = Number(process.env.SLOOPER_OSC_STATE_PORT || runtimeConfig.osc.statePort);

let controller;
const transport = new OscTransport({
    host: runtimeConfig.osc.host,
    sendPort: runtimeConfig.osc.sendPort,
    statePort: runtimeConfig.osc.statePort,
    onState: (args) => {
        if (controller) controller.applyPdState(args);
    },
});

controller = createController({
    transport,
    config: runtimeConfig.controller,
});

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

async function handleAction(action, slotId) {
    if (action === 'monitor') {
        await controller.toggleMonitor();
        return;
    }

    if (action === 'tap') await controller.tapSlot(slotId);
    else if (action === 'clear') await controller.clearSlot(slotId);
    else if (action === 'cropDown') await controller.cropSlot(slotId, -runtimeConfig.controller.cropStepMs);
    else if (action === 'cropUp') await controller.cropSlot(slotId, runtimeConfig.controller.cropStepMs);
    else if (action === 'reset') await controller.resetSlot(slotId);
    else throw new Error(`Unknown action: ${action}`);
}

const server = http.createServer(async (req, res) => {
    try {
        if (req.method === 'GET' && req.url === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(fs.readFileSync(htmlPath, 'utf8'));
            return;
        }

        if (req.method === 'GET' && req.url === '/api/state') {
            sendJson(res, 200, controller.getState());
            return;
        }

        if (req.method === 'POST' && req.url === '/api/action') {
            const body = await readJson(req);
            await handleAction(body.action, Number(body.slot));
            sendJson(res, 200, controller.getState());
            return;
        }

        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
    } catch (err) {
        sendJson(res, 500, { error: err.message, ...controller.getState() });
    }
});

server.listen(PORT, HOST, () => {
    console.log(`OSC web controller: http://${HOST}:${PORT}`);
    console.log(`Sending OSC to ${runtimeConfig.osc.host}:${runtimeConfig.osc.sendPort}`);
    console.log(`Listening for Pd state on ${runtimeConfig.osc.host}:${runtimeConfig.osc.statePort}`);
});

function shutdown() {
    server.close(() => {
        transport.close();
        process.exit(0);
    });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
