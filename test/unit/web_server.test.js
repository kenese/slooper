const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createWebServer } = require('../../src/controller/web_server');

function makeRequest(port, method, urlPath, body) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const req = http.request(
            {
                hostname: '127.0.0.1',
                port,
                path: urlPath,
                method,
                headers: payload
                    ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
                    : {},
            },
            (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    const isJson = (res.headers['content-type'] || '').includes('application/json');
                    resolve({
                        status: res.statusCode,
                        contentType: res.headers['content-type'] || '',
                        body: isJson ? JSON.parse(data) : data,
                    });
                });
            }
        );
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

function createFakeController() {
    const calls = [];
    return {
        calls,
        getState() { return { slots: [{ id: 1, state: 0 }], monitorEnabled: false }; },
        async tapSlot(id) { calls.push(['tapSlot', id]); },
        async clearSlot(id) { calls.push(['clearSlot', id]); },
        async resetSlot(id) { calls.push(['resetSlot', id]); },
        async toggleMonitor() { calls.push(['toggleMonitor']); },
        async selectInputSource(id) { calls.push(['selectInputSource', id]); },
        async autoLoopSlot(id, key) { calls.push(['autoLoopSlot', id, key]); },
        async multiplySlotLength(id, factor) { calls.push(['multiplySlotLength', id, factor]); },
        async cropStartSlot(id, delta) { calls.push(['cropStartSlot', id, delta]); },
        async cropSlot(id, delta) { calls.push(['cropSlot', id, delta]); },
        async moveSlot(id, delta) { calls.push(['moveSlot', id, delta]); },
    };
}

function createFakeTapTempo() {
    const calls = [];
    return { calls, tap(ts) { calls.push(['tap', ts]); } };
}

async function startTestServer() {
    const controller = createFakeController();
    const tapTempo = createFakeTapTempo();
    const runtimeConfig = { controller: { cropStepMs: 30 } };
    const webServer = createWebServer({ controller, tapTempo, runtimeConfig });
    const port = await webServer.listen(0, '127.0.0.1');
    return { webServer, controller, tapTempo, port };
}

test('GET /api/state returns controller state as JSON', async () => {
    const { webServer, controller, port } = await startTestServer();
    try {
        const res = await makeRequest(port, 'GET', '/api/state');
        assert.equal(res.status, 200);
        assert.deepEqual(res.body, controller.getState());
    } finally {
        await webServer.close();
    }
});

test('POST /api/action tap calls controller.tapSlot with slot id', async () => {
    const { webServer, controller, port } = await startTestServer();
    try {
        const res = await makeRequest(port, 'POST', '/api/action', { action: 'tap', slot: 1 });
        assert.equal(res.status, 200);
        assert.deepEqual(controller.calls, [['tapSlot', 1]]);
    } finally {
        await webServer.close();
    }
});

test('POST /api/action monitor calls controller.toggleMonitor', async () => {
    const { webServer, controller, port } = await startTestServer();
    try {
        const res = await makeRequest(port, 'POST', '/api/action', { action: 'monitor' });
        assert.equal(res.status, 200);
        assert.deepEqual(controller.calls, [['toggleMonitor']]);
    } finally {
        await webServer.close();
    }
});

test('POST /api/action tapTempo calls tapTempo.tap', async () => {
    const { webServer, tapTempo, port } = await startTestServer();
    try {
        await makeRequest(port, 'POST', '/api/action', { action: 'tapTempo' });
        assert.equal(tapTempo.calls.length, 1);
        assert.equal(tapTempo.calls[0][0], 'tap');
    } finally {
        await webServer.close();
    }
});

test('POST /api/action cropUp calls controller.cropSlot with +cropStepMs', async () => {
    const { webServer, controller, port } = await startTestServer();
    try {
        await makeRequest(port, 'POST', '/api/action', { action: 'cropUp', slot: 2 });
        assert.deepEqual(controller.calls, [['cropSlot', 2, 30]]);
    } finally {
        await webServer.close();
    }
});

test('POST /api/action cropDown calls controller.cropSlot with -cropStepMs', async () => {
    const { webServer, controller, port } = await startTestServer();
    try {
        await makeRequest(port, 'POST', '/api/action', { action: 'cropDown', slot: 1 });
        assert.deepEqual(controller.calls, [['cropSlot', 1, -30]]);
    } finally {
        await webServer.close();
    }
});

test('POST /api/action cropStartUp calls controller.cropStartSlot with +cropStepMs', async () => {
    const { webServer, controller, port } = await startTestServer();
    try {
        await makeRequest(port, 'POST', '/api/action', { action: 'cropStartUp', slot: 1 });
        assert.deepEqual(controller.calls, [['cropStartSlot', 1, 30]]);
    } finally {
        await webServer.close();
    }
});

test('POST /api/action moveUp calls controller.moveSlot with +cropStepMs', async () => {
    const { webServer, controller, port } = await startTestServer();
    try {
        await makeRequest(port, 'POST', '/api/action', { action: 'moveUp', slot: 1 });
        assert.deepEqual(controller.calls, [['moveSlot', 1, 30]]);
    } finally {
        await webServer.close();
    }
});

test('POST /api/action source: calls controller.selectInputSource', async () => {
    const { webServer, controller, port } = await startTestServer();
    try {
        await makeRequest(port, 'POST', '/api/action', { action: 'source:ch2' });
        assert.deepEqual(controller.calls, [['selectInputSource', 'ch2']]);
    } finally {
        await webServer.close();
    }
});

test('POST /api/action autoLoop: calls controller.autoLoopSlot', async () => {
    const { webServer, controller, port } = await startTestServer();
    try {
        await makeRequest(port, 'POST', '/api/action', { action: 'autoLoop:1beat', slot: 1 });
        assert.deepEqual(controller.calls, [['autoLoopSlot', 1, '1beat']]);
    } finally {
        await webServer.close();
    }
});

test('POST /api/action unknown action returns 500 with error', async () => {
    const { webServer, port } = await startTestServer();
    try {
        const res = await makeRequest(port, 'POST', '/api/action', { action: 'bogus', slot: 1 });
        assert.equal(res.status, 500);
        assert.ok(typeof res.body.error === 'string');
        assert.ok(res.body.error.includes('Unknown action'));
    } finally {
        await webServer.close();
    }
});

test('GET / returns HTML with 200', async () => {
    const { webServer, port } = await startTestServer();
    try {
        const res = await makeRequest(port, 'GET', '/');
        assert.equal(res.status, 200);
        assert.ok(res.contentType.startsWith('text/html'));
    } finally {
        await webServer.close();
    }
});

test('GET /unknown returns 404', async () => {
    const { webServer, port } = await startTestServer();
    try {
        const res = await makeRequest(port, 'GET', '/unknown');
        assert.equal(res.status, 404);
    } finally {
        await webServer.close();
    }
});
