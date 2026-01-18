const { Server } = require('node-osc');

const server = new Server(9001, '0.0.0.0', () => {
    console.log('Osc Server listening on 9001');
});

server.on('message', (msg) => {
    console.log(`Received: ${JSON.stringify(msg)}`);
});
