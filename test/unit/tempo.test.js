const test = require('node:test');
const assert = require('node:assert/strict');

const {
    AUTO_LOOP_DURATIONS,
    MidiClockTracker,
    TapTempoTracker,
    TempoSource,
    getAutoLoopDurationMs,
} = require('../../src/controller/tempo');

test('MIDI clock estimates BPM from 24 pulses per beat', () => {
    const clock = new MidiClockTracker({ now: () => 0 });

    for (let i = 0; i <= 48; i++) {
        clock.tick(i * 20);
    }

    assert.equal(clock.isActive(960), true);
    assert.ok(Math.abs(clock.getBpm() - 125) < 0.001);
    assert.ok(Math.abs(clock.getBeatMs() - 480) < 0.001);
});

test('MIDI clock becomes inactive when ticks are stale', () => {
    const clock = new MidiClockTracker({ staleTimeoutMs: 500 });

    for (let i = 0; i <= 24; i++) {
        clock.tick(i * 25);
    }

    assert.equal(clock.isActive(700), true);
    assert.equal(clock.isActive(1200), false);
});

test('MIDI clock finds nearest beat around press time', () => {
    const clock = new MidiClockTracker();

    for (let i = 0; i <= 72; i++) {
        clock.tick(i * 20);
    }

    assert.equal(clock.getClosestBeatTime(1455), 1440);
    assert.equal(clock.getClosestBeatTime(1710), 1920);
});

test('tap tempo averages recent tap intervals', () => {
    const tap = new TapTempoTracker();

    tap.tap(1000);
    tap.tap(1500);
    tap.tap(2000);
    tap.tap(2500);

    assert.equal(tap.isReady(), true);
    assert.equal(tap.getBpm(), 120);
    assert.equal(tap.getBeatMs(), 500);
});

test('tap tempo resets after a long gap', () => {
    const tap = new TapTempoTracker({ resetAfterMs: 2000 });

    tap.tap(1000);
    tap.tap(1500);
    assert.equal(tap.isReady(), true);

    tap.tap(5000);
    assert.equal(tap.isReady(), false);

    tap.tap(5600);
    assert.equal(tap.isReady(), true);
    assert.equal(tap.getBeatMs(), 600);
});

test('auto loop durations convert beat counts to milliseconds', () => {
    assert.equal(AUTO_LOOP_DURATIONS['1beat'].beats, 1);
    assert.equal(AUTO_LOOP_DURATIONS['2bar'].beats, 8);
    assert.equal(getAutoLoopDurationMs('4beat', 500), 2000);
    assert.equal(getAutoLoopDurationMs('2bar', 500), 4000);
    assert.throws(() => getAutoLoopDurationMs('nope', 500), /Unknown auto-loop duration/);
});

test('tempo source prefers active MIDI clock and snaps to closest beat', () => {
    const clock = new MidiClockTracker();
    const tap = new TapTempoTracker();
    const source = new TempoSource({ clock, tap });

    tap.tap(1000);
    tap.tap(1500);
    for (let i = 0; i <= 48; i++) {
        clock.tick(i * 20);
    }

    assert.deepEqual(source.getTiming(955), {
        source: 'midi',
        beatMs: 480,
        startTimeMs: 960,
    });
});

test('tempo source falls back to tap tempo with immediate start', () => {
    const clock = new MidiClockTracker();
    const tap = new TapTempoTracker();
    const source = new TempoSource({ clock, tap });

    tap.tap(1000);
    tap.tap(1600);

    assert.deepEqual(source.getTiming(2200), {
        source: 'tap',
        beatMs: 600,
        startTimeMs: 2200,
    });
});
