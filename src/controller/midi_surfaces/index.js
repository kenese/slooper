const simpleSurface = require('./simple_surface');
const x1mk3TwoChannelSurface = require('./x1mk3_2channel_surface');

const SURFACES = {
    simple: simpleSurface,
    'x1mk3-2channel': x1mk3TwoChannelSurface,
};

function loadMidiSurface(midi) {
    const surfaceName = midi.surface || 'simple';
    const surface = SURFACES[surfaceName];
    if (!surface) {
        throw new Error(`Unknown MIDI surface: ${surfaceName}`);
    }
    return surface;
}

module.exports = {
    loadMidiSurface,
};
