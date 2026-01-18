const fs = require('fs');

const content = fs.readFileSync('src/engine.pd', 'utf8');
const lines = content.split('\n');

const objects = [];
const connections = [];

lines.forEach((line, i) => {
    if (line.startsWith('#X obj') || line.startsWith('#X msg') || line.startsWith('#X floatatom') || line.startsWith('#X text')) {
        objects.push({ index: objects.length, line, lineNum: i + 1 });
    } else if (line.startsWith('#X connect')) {
        const parts = line.split(' ');
        connections.push({
            from: parseInt(parts[2]),
            outlet: parseInt(parts[3]),
            to: parseInt(parts[4]),
            inlet: parseInt(parts[5].replace(';', ''))
        });
    }
});

console.log('--- OBJECTS ---');
objects.forEach(o => {
    console.log(`${o.index}: ${o.line.trim()}`);
});

console.log('\n--- CONNECTIONS ---');
connections.forEach(c => {
    // resolve object names
    const fromObj = objects[c.from] ? objects[c.from].line.trim() : 'UNKNOWN';
    const toObj = objects[c.to] ? objects[c.to].line.trim() : 'UNKNOWN';
    console.log(`${c.from} (${fromObj}) [${c.outlet}] -> ${c.to} (${toObj}) [${c.inlet}]`);
});
