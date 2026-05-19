const simpleSurface = require('./simple_surface');

function createSurface(delegate) {
    return {
        name: 'x1mk3-2channel',
        setup(context) {
            return delegate.setup(context);
        },
    };
}

module.exports = {
    ...createSurface(simpleSurface),
    createForTest: createSurface,
};
