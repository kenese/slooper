const AUTO_LOOP_DURATIONS = {
    '1beat': { beats: 1 },
    '2beat': { beats: 2 },
    '4beat': { beats: 4 },
    '2bar': { beats: 8 },
};

class MidiClockTracker {
    constructor(options = {}) {
        this.now = options.now || (() => Date.now());
        this.staleTimeoutMs = options.staleTimeoutMs ?? 750;
        this.maxIntervals = options.maxIntervals ?? 96;
        this.tickTimes = [];
        this.lastTickTime = null;
        this.tickCount = 0;
        this.onBeat = null;
    }

    tick(timeMs = this.now()) {
        this.lastTickTime = timeMs;
        this.tickCount++;
        this.tickTimes.push(timeMs);
        if (this.tickCount % 24 === 0 && this.onBeat) this.onBeat();
        if (this.tickTimes.length > this.maxIntervals + 1) {
            this.tickTimes.shift();
        }
    }

    reset() {
        this.tickTimes = [];
        this.lastTickTime = null;
        this.tickCount = 0;
    }

    isActive(timeMs = this.now()) {
        return this.lastTickTime !== null && timeMs - this.lastTickTime <= this.staleTimeoutMs && this.getBeatMs() !== null;
    }

    getTickMs() {
        if (this.tickTimes.length < 2) {
            return null;
        }

        const intervals = [];
        for (let i = 1; i < this.tickTimes.length; i++) {
            const interval = this.tickTimes[i] - this.tickTimes[i - 1];
            if (interval > 0) {
                intervals.push(interval);
            }
        }

        if (intervals.length === 0) {
            return null;
        }

        return intervals.reduce((sum, interval) => sum + interval, 0) / intervals.length;
    }

    getBeatMs() {
        const tickMs = this.getTickMs();
        return tickMs === null ? null : tickMs * 24;
    }

    getBpm() {
        const beatMs = this.getBeatMs();
        return beatMs === null ? null : 60000 / beatMs;
    }

    getLastBeatTime() {
        if (this.lastTickTime === null) {
            return null;
        }

        const beatMs = this.getBeatMs();
        if (beatMs === null) {
            return null;
        }

        const tickMs = beatMs / 24;
        const ticksSinceBeat = (this.tickCount - 1) % 24;
        return this.lastTickTime - ticksSinceBeat * tickMs;
    }

    getClosestBeatTime(timeMs = this.now()) {
        const beatMs = this.getBeatMs();
        const lastBeatTime = this.getLastBeatTime();
        if (beatMs === null || lastBeatTime === null) {
            return null;
        }

        const beatsFromLast = Math.round((timeMs - lastBeatTime) / beatMs);
        return lastBeatTime + beatsFromLast * beatMs;
    }
}

class TapTempoTracker {
    constructor(options = {}) {
        this.maxTaps = options.maxTaps ?? 5;
        this.resetAfterMs = options.resetAfterMs ?? 2000;
        this.tapTimes = [];
    }

    tap(timeMs = Date.now()) {
        const previous = this.tapTimes[this.tapTimes.length - 1];
        if (previous !== undefined && timeMs - previous > this.resetAfterMs) {
            this.tapTimes = [];
        }

        this.tapTimes.push(timeMs);
        if (this.tapTimes.length > this.maxTaps) {
            this.tapTimes.shift();
        }
    }

    isReady() {
        return this.getBeatMs() !== null;
    }

    getBeatMs() {
        if (this.tapTimes.length < 2) {
            return null;
        }

        const intervals = [];
        for (let i = 1; i < this.tapTimes.length; i++) {
            const interval = this.tapTimes[i] - this.tapTimes[i - 1];
            if (interval > 0 && interval <= this.resetAfterMs) {
                intervals.push(interval);
            }
        }

        if (intervals.length === 0) {
            return null;
        }

        return intervals.reduce((sum, interval) => sum + interval, 0) / intervals.length;
    }

    getBpm() {
        const beatMs = this.getBeatMs();
        return beatMs === null ? null : 60000 / beatMs;
    }
}

class TempoSource {
    constructor(options = {}) {
        this.clock = options.clock || new MidiClockTracker(options.clockOptions);
        this.tap = options.tap || new TapTempoTracker(options.tapOptions);
    }

    getTiming(timeMs = Date.now()) {
        if (this.clock.isActive(timeMs)) {
            return {
                source: 'midi',
                beatMs: this.clock.getBeatMs(),
                startTimeMs: this.clock.getClosestBeatTime(timeMs),
            };
        }

        const tapBeatMs = this.tap.getBeatMs();
        if (tapBeatMs !== null) {
            return {
                source: 'tap',
                beatMs: tapBeatMs,
                startTimeMs: timeMs,
            };
        }

        return null;
    }

    getStatus(timeMs = Date.now()) {
        if (this.clock.isActive(timeMs)) {
            return this.createStatus({
                source: 'midi',
                beatMs: this.clock.getBeatMs(),
                lastBeatTimeMs: this.clock.getClosestBeatTime(timeMs),
                lastTickAgeMs: timeMs - this.clock.lastTickTime,
                timeMs,
            });
        }

        const tapBeatMs = this.tap.getBeatMs();
        if (tapBeatMs !== null) {
            return this.createStatus({
                source: 'tap',
                beatMs: tapBeatMs,
                lastBeatTimeMs: timeMs,
                lastTickAgeMs: null,
                timeMs,
            });
        }

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

    createStatus({ source, beatMs, lastBeatTimeMs, lastTickAgeMs, timeMs }) {
        const beatsFromReference = Math.floor((timeMs - lastBeatTimeMs) / beatMs);
        const currentBeatTimeMs = lastBeatTimeMs + beatsFromReference * beatMs;
        const nextBeatTimeMs = currentBeatTimeMs + beatMs;
        const beatProgress = Math.max(0, Math.min(1, (timeMs - currentBeatTimeMs) / beatMs));

        return {
            source,
            active: true,
            bpm: 60000 / beatMs,
            beatMs,
            beatProgress,
            lastBeatTimeMs: currentBeatTimeMs,
            nextBeatTimeMs,
            lastTickAgeMs,
        };
    }
}

function getAutoLoopDurationMs(durationKey, beatMs) {
    const duration = AUTO_LOOP_DURATIONS[durationKey];
    if (!duration) {
        throw new Error(`Unknown auto-loop duration: ${durationKey}`);
    }
    return duration.beats * beatMs;
}

module.exports = {
    AUTO_LOOP_DURATIONS,
    MidiClockTracker,
    TapTempoTracker,
    TempoSource,
    getAutoLoopDurationMs,
};
