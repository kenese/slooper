const { execFile } = require('child_process');

function execFilePromise(command, args) {
    return new Promise((resolve, reject) => {
        execFile(command, args, (err) => {
            if (err) {
                reject(err);
                return;
            }
            resolve();
        });
    });
}

class JackCaptureRouter {
    constructor(options = {}) {
        this.runCommand = options.runCommand || execFilePromise;
        this.pdInputs = options.pdInputs || ['pure_data:input_1', 'pure_data:input_2'];
    }

    async selectSource(source, sources) {
        for (const candidate of sources) {
            await this.disconnectSource(candidate);
        }

        await this.runCommand('jack_connect', [source.ports[0], this.pdInputs[0]]);
        await this.runCommand('jack_connect', [source.ports[1], this.pdInputs[1]]);
    }

    async disconnectSource(source) {
        await this.ignoreDisconnectError(this.runCommand('jack_disconnect', [source.ports[0], this.pdInputs[0]]));
        await this.ignoreDisconnectError(this.runCommand('jack_disconnect', [source.ports[1], this.pdInputs[1]]));
    }

    async ignoreDisconnectError(promise) {
        try {
            await promise;
        } catch (_err) {
            // JACK returns an error when a port pair is already disconnected.
        }
    }
}

module.exports = {
    JackCaptureRouter,
};
