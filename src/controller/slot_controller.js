const { BASE_CONFIG } = require('../config');

const SlotState = {
    EMPTY: 0,
    RECORDING: 1,
    PLAYING: 2,
    STOPPED: 3,
};

const SlotStateLabel = ['EMPTY', 'RECORDING', 'PLAYING', 'STOPPED'];

function createSlot(id) {
    return {
        id,
        state: SlotState.EMPTY,
        recordStartTime: 0,
        lengthMs: 0,
        originalLengthMs: 0,
        cropOffset: 0,
        startCropOffset: 0,
        pendingDelta: 0,
        pendingStartDelta: 0,
        updateTimer: null,
        startUpdateTimer: null,
    };
}

function slotAddress(id) {
    return `/slot${id}`;
}

function parseSlotId(slotName) {
    const match = String(slotName).match(/^slot([0-9]+)$/);
    return match ? Number(match[1]) : null;
}

class SlotController {
    constructor(options = {}) {
        if (!options.transport) {
            throw new Error('SlotController requires a transport');
        }

        this.transport = options.transport;
        this.config = {
            ...BASE_CONFIG.controller,
            ...(options.config || {}),
        };
        this.onStateChange = options.onStateChange || (() => {});
        this.now = options.now || (() => Date.now());
        this.slots = (options.slots || [1, 2]).map(createSlot);
        this.monitorEnabled = false;
        this.monitorActive = false;
    }

    setNow(now) {
        this.now = now;
    }

    getSlot(id) {
        return this.slots.find((slot) => slot.id === Number(id));
    }

    requireSlot(id) {
        const slot = this.getSlot(id);
        if (!slot) {
            throw new Error(`Unknown slot: ${id}`);
        }
        return slot;
    }

    getState() {
        return {
            slots: this.slots.map((slot) => ({
                id: slot.id,
                state: slot.state,
                stateLabel: SlotStateLabel[slot.state],
                lengthMs: slot.lengthMs,
                originalLengthMs: slot.originalLengthMs,
                cropOffset: slot.cropOffset,
                endCropOffset: slot.cropOffset,
                startCropOffset: slot.startCropOffset,
                currentLengthMs: slot.lengthMs,
            })),
            monitorEnabled: this.monitorEnabled,
            monitorActive: this.monitorActive,
        };
    }

    emitChange() {
        this.onStateChange(this.getState());
    }

    async send(address, ...args) {
        await this.transport.send(address, ...args);
    }

    async tapSlot(id) {
        const slot = this.requireSlot(id);
        const address = slotAddress(slot.id);

        if (slot.state === SlotState.EMPTY) {
            slot.recordStartTime = this.now();
            slot.cropOffset = 0;
            slot.startCropOffset = 0;
            slot.lengthMs = 0;
            slot.originalLengthMs = 0;
            await this.send(address, 'rec', 1);
            slot.state = SlotState.RECORDING;
            this.emitChange();
            return;
        }

        if (slot.state === SlotState.RECORDING) {
            slot.lengthMs = Math.max(0, this.now() - slot.recordStartTime);
            slot.originalLengthMs = slot.lengthMs;
            await this.send(address, 'rec', 0);
            await this.send(address, 'play', 1);
            slot.state = SlotState.PLAYING;
            await this.updateMonitorState();
            this.emitChange();
            return;
        }

        if (slot.state === SlotState.PLAYING) {
            await this.send(address, 'play', 0);
            slot.state = SlotState.STOPPED;
            await this.updateMonitorState();
            this.emitChange();
            return;
        }

        if (slot.state === SlotState.STOPPED) {
            await this.send(address, 'play', 1);
            slot.state = SlotState.PLAYING;
            await this.updateMonitorState();
            this.emitChange();
        }
    }

    async clearSlot(id) {
        const slot = this.requireSlot(id);
        await this.send(slotAddress(slot.id), 'play', 0);
        await this.send(slotAddress(slot.id), 'clear', 1);
        this.resetSlotState(slot);
        await this.updateMonitorState();
        this.emitChange();
    }

    resetSlotState(slot) {
        slot.state = SlotState.EMPTY;
        slot.recordStartTime = 0;
        slot.lengthMs = 0;
        slot.originalLengthMs = 0;
        slot.cropOffset = 0;
        slot.startCropOffset = 0;
        slot.pendingDelta = 0;
        slot.pendingStartDelta = 0;
        if (slot.updateTimer) {
            clearTimeout(slot.updateTimer);
            slot.updateTimer = null;
        }
        if (slot.startUpdateTimer) {
            clearTimeout(slot.startUpdateTimer);
            slot.startUpdateTimer = null;
        }
    }

    async cropSlot(id, delta) {
        const slot = this.requireSlot(id);
        if (slot.state !== SlotState.PLAYING || delta === 0) {
            return;
        }

        slot.cropOffset += delta;
        slot.lengthMs = Math.max(100, slot.lengthMs + delta);
        await this.send(slotAddress(slot.id), 'crop', delta);
        this.emitChange();
    }

    async cropStartSlot(id, delta) {
        const slot = this.requireSlot(id);
        if (slot.state !== SlotState.PLAYING || delta === 0) {
            return;
        }

        const nextOffset = Math.max(-1000, Math.min(1000, slot.startCropOffset + delta));
        const clippedDelta = nextOffset - slot.startCropOffset;
        if (clippedDelta === 0) {
            return;
        }

        slot.startCropOffset = nextOffset;
        slot.lengthMs = Math.max(100, slot.lengthMs - clippedDelta);
        await this.send(slotAddress(slot.id), 'cropStart', clippedDelta);
        this.emitChange();
    }

    async moveSlot(id, delta) {
        const slot = this.requireSlot(id);
        if (slot.state !== SlotState.PLAYING || delta === 0) {
            return;
        }

        const currentEndLength = slot.lengthMs + slot.startCropOffset;
        const minDelta = Math.max(-1000 - slot.startCropOffset, 100 - currentEndLength);
        const maxDelta = 1000 - slot.startCropOffset;
        const clippedDelta = Math.max(minDelta, Math.min(maxDelta, delta));
        if (clippedDelta === 0) {
            return;
        }

        slot.startCropOffset += clippedDelta;
        slot.cropOffset += clippedDelta;
        await this.send(slotAddress(slot.id), 'cropStart', clippedDelta);
        await this.send(slotAddress(slot.id), 'crop', clippedDelta);
        this.emitChange();
    }

    scheduleCrop(id, delta, onFlush) {
        const slot = this.requireSlot(id);
        if (slot.state !== SlotState.PLAYING || delta === 0) {
            return;
        }

        slot.pendingDelta += delta;
        if (slot.updateTimer) {
            return;
        }

        slot.updateTimer = setTimeout(async () => {
            const pending = slot.pendingDelta;
            slot.pendingDelta = 0;
            slot.updateTimer = null;
            await this.cropSlot(slot.id, pending);
            if (onFlush) onFlush(slot, pending);
        }, this.config.encoderThrottleMs);
    }

    scheduleStartCrop(id, delta, onFlush) {
        const slot = this.requireSlot(id);
        if (slot.state !== SlotState.PLAYING || delta === 0) {
            return;
        }

        slot.pendingStartDelta += delta;
        if (slot.startUpdateTimer) {
            return;
        }

        slot.startUpdateTimer = setTimeout(async () => {
            const pending = slot.pendingStartDelta;
            slot.pendingStartDelta = 0;
            slot.startUpdateTimer = null;
            await this.cropStartSlot(slot.id, pending);
            if (onFlush) onFlush(slot, pending);
        }, this.config.encoderThrottleMs);
    }

    async resetSlot(id) {
        const slot = this.requireSlot(id);
        if (slot.state !== SlotState.PLAYING) {
            return;
        }

        slot.cropOffset = 0;
        slot.startCropOffset = 0;
        slot.lengthMs = slot.originalLengthMs || slot.lengthMs;
        await this.send(slotAddress(slot.id), 'reset', 1);
        this.emitChange();
    }

    async toggleMonitor() {
        this.monitorEnabled = !this.monitorEnabled;
        await this.updateMonitorState();
        this.emitChange();
    }

    async updateMonitorState() {
        const anyPlaying = this.slots.some((slot) => slot.state === SlotState.PLAYING);
        this.monitorActive = this.monitorEnabled && !anyPlaying;
        await this.send('/monitor', this.monitorActive ? 1 : 0);
    }

    refreshMonitorActive() {
        const anyPlaying = this.slots.some((slot) => slot.state === SlotState.PLAYING);
        this.monitorActive = this.monitorEnabled && !anyPlaying;
    }

    applyPdState(args) {
        const [slotName, stateOrType, value] = args;
        const slotId = parseSlotId(slotName);
        if (!slotId) {
            return;
        }

        const slot = this.getSlot(slotId);
        if (!slot) {
            return;
        }

        if (stateOrType === 'length') {
            slot.lengthMs = Number(value) || 0;
            if (slot.lengthMs === 0) {
                slot.originalLengthMs = 0;
                slot.cropOffset = 0;
                slot.startCropOffset = 0;
            } else if (slot.originalLengthMs === 0) {
                slot.originalLengthMs = slot.lengthMs;
            }
            this.emitChange();
            return;
        }

        if (stateOrType === 'start') {
            slot.startCropOffset = Number(value) || 0;
            this.emitChange();
            return;
        }

        if (stateOrType === 'recording') {
            slot.state = SlotState.RECORDING;
        } else if (stateOrType === 'playing') {
            slot.state = SlotState.PLAYING;
        } else if (stateOrType === 'paused') {
            slot.state = slot.lengthMs === 0 ? SlotState.EMPTY : SlotState.STOPPED;
        } else if (stateOrType === 'stopped') {
            slot.state = slot.lengthMs === 0 ? SlotState.EMPTY : SlotState.STOPPED;
        }

        this.refreshMonitorActive();
        this.emitChange();
    }
}

function createController(options) {
    return new SlotController(options);
}

module.exports = {
    SlotController,
    SlotState,
    SlotStateLabel,
    createController,
};
