#!/bin/bash

# Slooper Startup Script
# Starts Pure Data and the selected Node controller without mutating tracked Pd patches.

set -euo pipefail

cd "$(dirname "$0")"

PID_DIR=".runtime/pids"
RESTART_JACK=false
STOP_JACK=false
STOP_ONLY=false
STATUS_ONLY=false
FORCE_CLEANUP=false
APPLIANCE_MODE=false
PRINT_CONFIG=false

for arg in "$@"; do
    case "$arg" in
        --restart-jack)
            RESTART_JACK=true
            ;;
        --stop-jack)
            STOP_JACK=true
            ;;
        --stop)
            STOP_ONLY=true
            ;;
        --status)
            STATUS_ONLY=true
            ;;
        --force-cleanup)
            FORCE_CLEANUP=true
            ;;
        --appliance)
            APPLIANCE_MODE=true
            STOP_JACK=true
            ;;
        --print-config)
            PRINT_CONFIG=true
            ;;
    esac
done

mkdir -p "$PID_DIR"

eval "$(node scripts/runtime_config.js --shell "$@")"

write_pid() {
    local name="$1"
    local pid="$2"
    echo "$pid" > "$PID_DIR/$name.pid"
}

stop_pid() {
    local name="$1"
    local file="$PID_DIR/$name.pid"

    if [ ! -f "$file" ]; then
        return
    fi

    local pid
    pid="$(cat "$file")"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        echo "   Stopping $name ($pid)"
        kill "$pid" 2>/dev/null || true
        sleep 1
        if kill -0 "$pid" 2>/dev/null; then
            kill -9 "$pid" 2>/dev/null || true
        fi
    fi

    rm -f "$file"
}

stop_untracked_macos_pd() {
    if [[ "$OSTYPE" != "darwin"* ]]; then
        return
    fi

    echo "   Stopping untracked macOS Pure Data processes"
    killall "Pd-0.56-2" 2>/dev/null || true
    killall Pd 2>/dev/null || true
    killall pd 2>/dev/null || true
    lsof -nP -iUDP:9000 -iUDP:9001 -iTCP:3000 2>/dev/null || true
}

tracked_cleanup() {
    echo "Cleaning up Slooper-managed processes..."
    stop_pid "controller"
    stop_pid "pd"
    stop_untracked_macos_pd
    if [ "$STOP_JACK" = true ]; then
        stop_pid "jack"
    fi
}

force_cleanup() {
    echo "Force cleanup requested. Stopping matching Pd, Node, and JACK processes..."
    pkill -f "node src/index.js" 2>/dev/null || true
    pkill -f "node src/dev_controller.js" 2>/dev/null || true
    pkill -f "node src/midi_logger.js" 2>/dev/null || true
    pkill -f "pd .*engine.pd" 2>/dev/null || true
    pkill -f "Pd.*engine.pd" 2>/dev/null || true
    pkill jackd 2>/dev/null || true
    pkill jackdbus 2>/dev/null || true
    rm -f "$PID_DIR"/*.pid
}

show_status() {
    echo "Slooper status:"
    for name in controller pd jack; do
        local file="$PID_DIR/$name.pid"
        if [ -f "$file" ]; then
            local pid
            pid="$(cat "$file")"
            if kill -0 "$pid" 2>/dev/null; then
                echo "   $name: running ($pid)"
            else
                echo "   $name: stale pid ($pid)"
            fi
        else
            echo "   $name: not tracked"
        fi
    done
}

if [ "$PRINT_CONFIG" = true ]; then
    node scripts/runtime_config.js --json "$@"
    exit 0
fi

if [ "$STATUS_ONLY" = true ]; then
    show_status
    exit 0
fi

if [ "$FORCE_CLEANUP" = true ]; then
    force_cleanup
    if [ "$STOP_ONLY" = true ]; then
        exit 0
    fi
elif [ "$STOP_ONLY" = true ]; then
    tracked_cleanup
    exit 0
fi

cleanup_on_exit() {
    echo ""
    tracked_cleanup
    if [ "$APPLIANCE_MODE" = true ]; then
        echo "Appliance mode cleanup complete. Safe to unplug audio device."
    else
        echo "Stopped Slooper-managed processes."
    fi
}

trap cleanup_on_exit EXIT INT TERM

echo "Stopping previously tracked Slooper processes..."
tracked_cleanup

echo "Configuring audio for: $AUDIO_DEVICE"
if [ "$PD_GENERATE_RUNTIME_PATCH" = "1" ]; then
    node scripts/runtime_config.js --ensure-runtime-patch "$@"
fi

echo "Pure Data patch: $PD_PATCH_PATH"

if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "Opening Pure Data..."
    open "$PD_PATCH_PATH"
else
    if [ "$RESTART_JACK" = true ]; then
        echo "Restarting JACK (--restart-jack flag)..."
        pkill jackd 2>/dev/null || true
        pkill jackdbus 2>/dev/null || true
        rm -f "$PID_DIR/jack.pid"
        sleep 1
    fi

    if ! pgrep -x jackd > /dev/null && ! pgrep -x jackdbus > /dev/null; then
        echo "Starting JACK audio server..."

        JACK_CARD="$(aplay -l 2>/dev/null | awk -v card_pattern="$JACK_CARD_NAME_INCLUDES" 'BEGIN { IGNORECASE=1 } $0 ~ card_pattern { sub(/:$/, "", $2); print $2; exit }')"

        if [ -n "$JACK_CARD" ]; then
            echo "   Found $JACK_CARD_NAME_INCLUDES on card $JACK_CARD"
            JACK_DEVICE="hw:$JACK_CARD"
        else
            echo "   Audio card matching '$JACK_CARD_NAME_INCLUDES' not found, trying hw:3"
            JACK_DEVICE="hw:3"
        fi

        echo "   Latency target: $JACK_PERIOD_SIZE frames x $JACK_PERIODS periods @ ${JACK_SAMPLE_RATE}Hz"
        jackd -d alsa -d "$JACK_DEVICE" -r "$JACK_SAMPLE_RATE" -p "$JACK_PERIOD_SIZE" -n "$JACK_PERIODS" &
        write_pid "jack" "$!"
        sleep 3
    else
        echo "JACK already running; Slooper will not stop it by default."
    fi

    pd -nogui -jack -nomidi "$PD_PATCH_PATH" &
    write_pid "pd" "$!"

    echo "Waiting for Pure Data to register JACK ports..."
    for _ in {1..10}; do
        if jack_lsp 2>/dev/null | grep -q "pure_data"; then
            echo "   Pure Data ports found."
            break
        fi
        sleep 1
    done

    echo "Connecting JACK audio ports..."
    echo "   Input: $JACK_CAPTURE_LEFT/$JACK_CAPTURE_RIGHT -> pure_data:input_1/2"
    echo "   Output: pure_data:output_1/2 -> $JACK_PLAYBACK_LEFT/$JACK_PLAYBACK_RIGHT"

    jack_connect "$JACK_CAPTURE_LEFT" pure_data:input_1 2>/dev/null || true
    jack_connect "$JACK_CAPTURE_RIGHT" pure_data:input_2 2>/dev/null || true
    jack_connect pure_data:output_1 "$JACK_PLAYBACK_LEFT" 2>/dev/null || true
    jack_connect pure_data:output_2 "$JACK_PLAYBACK_RIGHT" 2>/dev/null || true
fi

sleep 3

if [ "$MIDI_DEVICE" = "OSC" ] || [ "$MIDI_DEVICE" = "WEB" ]; then
    echo "Starting OSC web controller..."
    echo "Open http://127.0.0.1:3000"
    node src/dev_controller.js "$@" &
else
    echo "Starting Node MIDI controller..."
    node src/index.js "$@" &
fi

write_pid "controller" "$!"
wait "$(cat "$PID_DIR/controller.pid")"
