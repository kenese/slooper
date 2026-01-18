const { Client } = require('node-osc');
const config = { ip: '127.0.0.1', port: 9000 };
const client = new Client(config.ip, config.port);

const addr = process.argv[2];
const args = process.argv.slice(3).map(a => !isNaN(a) ? Number(a) : a);

client.send(addr, ...args, () => {
    console.log(`Sent: ${addr} ${args.join(' ')}`);
    client.close();
});
