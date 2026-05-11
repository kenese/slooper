const { Client, Server } = require('node-osc');

class OscTransport {
    constructor(options = {}) {
        this.host = options.host || '127.0.0.1';
        this.sendPort = options.sendPort || 9000;
        this.statePort = options.statePort || 9001;
        this.onState = options.onState || (() => {});
        this.client = new Client(this.host, this.sendPort);
        this.server = null;

        if (options.listen !== false) {
            this.listen();
        }
    }

    listen() {
        this.server = new Server(this.statePort, this.host, () => {});
        this.server.on('message', (msg) => {
            const [address, ...args] = msg;
            if (address === '/state') {
                this.onState(args);
            }
        });
        this.server.on('error', (err) => {
            console.warn(`OSC state listener error on ${this.host}:${this.statePort}: ${err.message}`);
        });
    }

    send(address, ...args) {
        return new Promise((resolve, reject) => {
            this.client.send(address, ...args, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    close() {
        this.client.close();
        if (this.server) {
            this.server.close();
        }
    }
}

module.exports = {
    OscTransport,
};
