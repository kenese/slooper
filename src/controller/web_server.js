const http = require('http');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');

const HTML_PATH = path.join(__dirname, '..', '..', 'public', 'dev-controller.html');

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

function createWebServer({ controller, tapTempo, runtimeConfig }) {
    const { cropStepMs } = runtimeConfig.controller;

    async function handleAction(action, slotId) {
        if (action === 'monitor') {
            await controller.toggleMonitor();
            return;
        }
        if (action === 'tapTempo') {
            tapTempo.tap(Date.now());
            broadcast(controller.getState());
            return;
        }
        if (action.startsWith('source:')) {
            await controller.selectInputSource(action.split(':')[1]);
            return;
        }
        if (action === 'tap') await controller.tapSlot(slotId);
        else if (action.startsWith('autoLoop:')) await controller.autoLoopSlot(slotId, action.split(':')[1]);
        else if (action === 'half') await controller.multiplySlotLength(slotId, 0.5);
        else if (action === 'double') await controller.multiplySlotLength(slotId, 2);
        else if (action === 'clear') await controller.clearSlot(slotId);
        else if (action === 'cropStartDown') await controller.cropStartSlot(slotId, -cropStepMs);
        else if (action === 'cropStartUp') await controller.cropStartSlot(slotId, cropStepMs);
        else if (action === 'cropDown') await controller.cropSlot(slotId, -cropStepMs);
        else if (action === 'cropUp') await controller.cropSlot(slotId, cropStepMs);
        else if (action === 'moveDown') await controller.moveSlot(slotId, -cropStepMs);
        else if (action === 'moveUp') await controller.moveSlot(slotId, cropStepMs);
        else if (action === 'reset') await controller.resetSlot(slotId);
        else throw new Error(`Unknown action: ${action}`);
    }

    const server = http.createServer(async (req, res) => {
        try {
            if (req.method === 'GET' && req.url === '/') {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(fs.readFileSync(HTML_PATH, 'utf8'));
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

    const wss = new WebSocketServer({ server });

    wss.on('connection', (ws) => {
        ws.send(JSON.stringify(controller.getState()));
        ws.on('error', () => {});
    });

    function broadcast(state) {
        const msg = JSON.stringify(state);
        for (const client of wss.clients) {
            if (client.readyState === client.OPEN) {
                client.send(msg);
            }
        }
    }

    return {
        broadcast,
        listen(port, host) {
            return new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(port, host, () => {
                    resolve(server.address().port);
                });
            });
        },
        close() {
            return new Promise((resolve) => {
                for (const client of wss.clients) client.terminate();
                wss.close(() => server.close(resolve));
            });
        },
    };
}

module.exports = { createWebServer };
