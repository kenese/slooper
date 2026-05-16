const { BASE_CONFIG } = require('../config');
const { getAutoLoopDurationMs } = require('./tempo');

const SlotState = {
    EMPTY: 0,
    RECORDING: 1,
    PLAYING: 2,
    STOPPED: 3,
    PENDING: 4,
};

const SlotStateLabel = ['EMPTY', 'RECORDING', 'PLAYING', 'STOPPED', 'PENDING'];

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
        pendingMoveDelta: 0,
        updateTimer: null,
        startUpdateTimer: null,
        moveUpdateTimer: null,
        autoStartTimer: null,
        autoStopTimer: null,
        pendingAutoRecord: null,
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
        this.setTimeout = options.setTimeout || ((fn, ms) => setTimeout(fn, ms));
        this.clearTimeout = options.clearTimeout || ((timer) => clearTimeout(timer));
        this.tempo = options.tempo || null;
        this.slots = (options.slots || [1, 2]).map(createSlot);
        this.monitorEnabled = true;
        this.monitorActive = true;
        this.inputSources = options.inputSources || [];
        this.selectedInputSourceId = this.inputSources[0] ? this.inputSources[0].id : null;
        this.inputRouter = options.inputRouter || null;
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
            inputRouting: {
                mode: this.inputSources.length > 1 ? 'switching' : 'send',
                selectedSourceId: this.selectedInputSourceId,
                sources: [...this.inputSources],
            },
            tempo: this.getTempoStatus(),
        };
    }

    getTempoStatus() {
        if (!this.tempo || typeof this.tempo.getStatus !== 'function') {
            return {
                source: 'none',
                active: false,
                bpm: null,
                beatMs: null,
                beatProgress: 0,
                lastBeatTimeMs: null,
                nextBeatTimeMs: null,
                lastTickAgeMs: null,
            };
        }

        return this.tempo.getStatus(this.now());
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

        if (slot.state === SlotState.PENDING) {
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
        slot.pendingMoveDelta = 0;
        if (slot.updateTimer) {
            this.clearTimeout(slot.updateTimer);
            slot.updateTimer = null;
        }
        if (slot.startUpdateTimer) {
            this.clearTimeout(slot.startUpdateTimer);
            slot.startUpdateTimer = null;
        }
        if (slot.moveUpdateTimer) {
            this.clearTimeout(slot.moveUpdateTimer);
            slot.moveUpdateTimer = null;
        }
        this.clearAutoTimers(slot);
    }

    clearAutoTimers(slot) {
        if (slot.autoStartTimer) {
            this.clearTimeout(slot.autoStartTimer);
            slot.autoStartTimer = null;
        }
        if (slot.autoStopTimer) {
            this.clearTimeout(slot.autoStopTimer);
            slot.autoStopTimer = null;
        }
        slot.pendingAutoRecord = null;
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

        slot.updateTimer = this.setTimeout(async () => {
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

        slot.startUpdateTimer = this.setTimeout(async () => {
            const pending = slot.pendingStartDelta;
            slot.pendingStartDelta = 0;
            slot.startUpdateTimer = null;
            await this.cropStartSlot(slot.id, pending);
            if (onFlush) onFlush(slot, pending);
        }, this.config.encoderThrottleMs);
    }

    scheduleMove(id, delta, onFlush) {
        const slot = this.requireSlot(id);
        if (slot.state !== SlotState.PLAYING || delta === 0) {
            return;
        }

        slot.pendingMoveDelta += delta;
        if (slot.moveUpdateTimer) {
            return;
        }

        slot.moveUpdateTimer = this.setTimeout(async () => {
            const pending = slot.pendingMoveDelta;
            slot.pendingMoveDelta = 0;
            slot.moveUpdateTimer = null;
            await this.moveSlot(slot.id, pending);
            if (onFlush) onFlush(slot, pending);
        }, this.config.encoderThrottleMs);
    }

    getTempoTiming() {
        if (!this.tempo || typeof this.tempo.getTiming !== 'function') {
            return null;
        }

        return this.tempo.getTiming(this.now());
    }

    async autoLoopSlot(id, durationKey) {
        const slot = this.requireSlot(id);
        if (slot.state === SlotState.RECORDING) {
            return { ok: false, reason: 'slot-recording' };
        }
        if (slot.state === SlotState.PENDING || slot.pendingAutoRecord) {
            return { ok: false, reason: 'auto-record-pending' };
        }

        const timing = this.getTempoTiming();
        if (!timing || !timing.beatMs) {
            return { ok: false, reason: 'tempo-unavailable' };
        }

        const durationMs = getAutoLoopDurationMs(durationKey, timing.beatMs);
        if (slot.state === SlotState.EMPTY) {
            return this.scheduleAutoRecord(slot, timing, durationMs);
        }

        await this.setSlotLength(slot.id, durationMs);
        return {
            ok: true,
            action: 'set-length',
            source: timing.source,
            durationMs,
        };
    }

    scheduleAutoRecord(slot, timing, durationMs) {
        const startDelayMs = Math.max(0, Math.round(timing.startTimeMs - this.now()));
        slot.state = SlotState.PENDING;
        slot.pendingAutoRecord = {
            durationMs,
            source: timing.source,
            startTimeMs: timing.startTimeMs,
        };
        slot.autoStartTimer = this.setTimeout(async () => {
            slot.autoStartTimer = null;
            const myRecord = slot.pendingAutoRecord;
            slot.recordStartTime = this.now();
            slot.cropOffset = 0;
            slot.startCropOffset = 0;
            slot.lengthMs = 0;
            slot.originalLengthMs = 0;
            await this.send(slotAddress(slot.id), 'rec', 1);
            if (slot.pendingAutoRecord !== myRecord) {
                // clearSlot fired while the rec 1 OSC was in flight — undo it.
                await this.send(slotAddress(slot.id), 'rec', 0);
                await this.send(slotAddress(slot.id), 'clear', 1);
                return;
            }
            slot.state = SlotState.RECORDING;
            this.emitChange();

            slot.autoStopTimer = this.setTimeout(async () => {
                slot.autoStopTimer = null;
                if (slot.pendingAutoRecord !== myRecord) return;
                slot.pendingAutoRecord = null;
                slot.lengthMs = durationMs;
                slot.originalLengthMs = durationMs;
                await this.send(slotAddress(slot.id), 'rec', 0);
                await this.send(slotAddress(slot.id), 'play', 1);
                slot.state = SlotState.PLAYING;
                await this.updateMonitorState();
                this.emitChange();
            }, durationMs);
        }, startDelayMs);
        this.emitChange();

        return {
            ok: true,
            action: 'scheduled-record',
            source: timing.source,
            durationMs,
            startDelayMs,
        };
    }

    async setSlotLength(id, lengthMs) {
        const slot = this.requireSlot(id);
        if (![SlotState.PLAYING, SlotState.STOPPED].includes(slot.state)) {
            return { ok: false, reason: 'slot-not-ready' };
        }

        const nextLengthMs = Math.max(100, Math.round(lengthMs));
        slot.lengthMs = nextLengthMs;
        await this.send(slotAddress(slot.id), 'setLength', nextLengthMs);
        this.emitChange();
        return { ok: true, action: 'set-length', durationMs: nextLengthMs };
    }

    async multiplySlotLength(id, factor) {
        const slot = this.requireSlot(id);
        if (![SlotState.PLAYING, SlotState.STOPPED].includes(slot.state)) {
            return { ok: false, reason: 'slot-not-ready' };
        }

        return this.setSlotLength(slot.id, slot.lengthMs * factor);
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

    async selectInputSource(sourceId) {
        const source = this.inputSources.find((candidate) => candidate.id === sourceId);
        if (!source) {
            throw new Error(`Unknown input source: ${sourceId}`);
        }

        if (source.id === this.selectedInputSourceId) {
            return { ok: true, action: 'select-input-source', sourceId: source.id };
        }

        if (this.inputRouter && typeof this.inputRouter.selectSource === 'function') {
            await this.inputRouter.selectSource(source, this.inputSources);
        }

        await this.send('/source', source.id);

        this.selectedInputSourceId = source.id;
        this.emitChange();
        return { ok: true, action: 'select-input-source', sourceId: source.id };
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
