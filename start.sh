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
CHANNELS=1
SLOTS_PER_CHANNEL=2
WEB_ENABLED=false
GREEN=$'\033[32m'
RED=$'\033[31m'
RESET=$'\033[0m'

for arg in "$@"; do
    case "$arg" in
        --web)
            WEB_ENABLED=true
            ;;
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
        channels=*)
            CHANNELS="${arg#*=}"
            ;;
        slots-per-channel=*)
            SLOTS_PER_CHANNEL="${arg#*=}"
            ;;
    esac
done

mkdir -p "$PID_DIR"

eval "$(node scripts/runtime_config.js --shell "$@" "channels=$CHANNELS" "slots-per-channel=$SLOTS_PER_CHANNEL")"

log_success() {
    printf "%b%s%b\n" "$GREEN" "$1" "$RESET"
}

log_error() {
    printf "%b%s%b\n" "$RED" "$1" "$RESET" >&2
}

runtime_mode_label() {
    if [ "$AUDIO_ROUTING_MODE" = "send" ]; then
        echo "Send Mode"
    elif [ "$CHANNELS" = "1" ]; then
        echo "Channel Mode (1 channel)"
    else
        echo "Channel Mode ($CHANNELS channels)"
    fi
}

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

check_web_port_available() {
    if [ "$MIDI_DEVICE" != "OSC" ] && [ "$MIDI_DEVICE" != "WEB" ] && [ "$WEB_ENABLED" != true ]; then
        return
    fi

    local web_port="${SLOOPER_WEB_PORT:-3000}"
    if ! command -v lsof >/dev/null 2>&1; then
        return
    fi

    local listeners
    listeners="$(lsof -nP -iTCP:"$web_port" -sTCP:LISTEN 2>/dev/null || true)"
    if [ -z "$listeners" ]; then
        return
    fi

    log_error "Web controller port $web_port is already in use:"
    echo "$listeners"
    log_error "Stop the process using port $web_port or set SLOOPER_WEB_PORT to a free port before starting Slooper."
    exit 1
}

if [ "$PRINT_CONFIG" = true ]; then
    node scripts/runtime_config.js --json "$@" "channels=$CHANNELS" "slots-per-channel=$SLOTS_PER_CHANNEL"
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
check_web_port_available

log_success "Configuring audio for: $AUDIO_DEVICE"
log_success "$(runtime_mode_label)"
if [ "$PD_GENERATE_RUNTIME_PATCH" = "1" ]; then
    node scripts/runtime_config.js --ensure-runtime-patch "$@" "channels=$CHANNELS" "slots-per-channel=$SLOTS_PER_CHANNEL"
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
            log_success "   Found $JACK_CARD_NAME_INCLUDES on card $JACK_CARD"
            JACK_DEVICE="hw:$JACK_CARD"
        else
            log_error "   Audio card matching '$JACK_CARD_NAME_INCLUDES' not found, trying hw:3"
            JACK_DEVICE="hw:3"
        fi

        echo "   Latency target: $JACK_PERIOD_SIZE frames x $JACK_PERIODS periods @ ${JACK_SAMPLE_RATE}Hz"
        jackd -d alsa -d "$JACK_DEVICE" -r "$JACK_SAMPLE_RATE" -p "$JACK_PERIOD_SIZE" -n "$JACK_PERIODS" &
        write_pid "jack" "$!"
        sleep 3
    else
        echo "JACK already running; Slooper will not stop it by default."
    fi
    log_success "JACK connected"

    PD_AUDIO_CHANNELS="$((CHANNELS * 2))"
    pd -nogui -jack -nomidi -inchannels "$PD_AUDIO_CHANNELS" -outchannels "$PD_AUDIO_CHANNELS" "$PD_PATCH_PATH" &
    write_pid "pd" "$!"

    echo "Waiting for Pure Data to register JACK ports..."
    for _ in {1..10}; do
        if jack_lsp 2>/dev/null | grep -q "pure_data"; then
            log_success "   Pure Data ports found."
            break
        fi
        sleep 1
    done

    echo "Connecting JACK audio ports..."
    IFS=';' read -r -a CAPTURE_PAIRS <<< "$JACK_CAPTURE_PORT_PAIRS"
    IFS=';' read -r -a PLAYBACK_PAIRS <<< "$JACK_PLAYBACK_PORT_PAIRS"

    disconnect_pd_input_connections() {
        local pd_port="$1"
        local connected_port
        while read -r connected_port; do
            [ -n "$connected_port" ] || continue
            jack_disconnect "$connected_port" "$pd_port" 2>/dev/null || true
        done < <(jack_lsp -c "$pd_port" 2>/dev/null | awk 'NR > 1 { print $1 }')
    }

    disconnect_pd_output_connections() {
        local pd_port="$1"
        local connected_port
        while read -r connected_port; do
            [ -n "$connected_port" ] || continue
            jack_disconnect "$pd_port" "$connected_port" 2>/dev/null || true
        done < <(jack_lsp -c "$pd_port" 2>/dev/null | awk 'NR > 1 { print $1 }')
    }

    clear_pd_jack_port_connections() {
        disconnect_pd_input_connections "$PD_IN_LEFT"
        disconnect_pd_input_connections "$PD_IN_RIGHT"
        disconnect_pd_output_connections "$PD_OUT_LEFT"
        disconnect_pd_output_connections "$PD_OUT_RIGHT"
    }

    jack_port_connected() {
        local source_port="$1"
        local target_port="$2"
        jack_lsp -c "$source_port" 2>/dev/null | awk -v target="$target_port" 'NR > 1 && $1 == target { found = 1 } END { exit found ? 0 : 1 }'
    }

    connect_jack_port() {
        local source_port="$1"
        local target_port="$2"
        local label="$3"
        local connect_error

        if jack_port_connected "$source_port" "$target_port"; then
            log_success "   $label connected: $source_port -> $target_port"
            return
        fi

        if connect_error="$(jack_connect "$source_port" "$target_port" 2>&1)"; then
            log_success "   $label connected: $source_port -> $target_port"
            return
        fi

        log_error "   Warning: could not connect $source_port to $target_port"
        if [ -n "$connect_error" ]; then
            log_error "   $connect_error"
        fi
    }

    for ((i = 0; i < CHANNELS; i++)); do
        IFS=',' read -r CAPTURE_LEFT CAPTURE_RIGHT <<< "${CAPTURE_PAIRS[$i]}"
        IFS=',' read -r PLAYBACK_LEFT PLAYBACK_RIGHT <<< "${PLAYBACK_PAIRS[$i]}"
        PD_IN_LEFT="pure_data:input_$((i * 2 + 1))"
        PD_IN_RIGHT="pure_data:input_$((i * 2 + 2))"
        PD_OUT_LEFT="pure_data:output_$((i * 2 + 1))"
        PD_OUT_RIGHT="pure_data:output_$((i * 2 + 2))"

        clear_pd_jack_port_connections

        echo "   Input: $CAPTURE_LEFT/$CAPTURE_RIGHT -> $PD_IN_LEFT/$PD_IN_RIGHT"
        echo "   Output: $PD_OUT_LEFT/$PD_OUT_RIGHT -> $PLAYBACK_LEFT/$PLAYBACK_RIGHT"

        connect_jack_port "$CAPTURE_LEFT" "$PD_IN_LEFT" "Input"
        connect_jack_port "$CAPTURE_RIGHT" "$PD_IN_RIGHT" "Input"
        connect_jack_port "$PD_OUT_LEFT" "$PLAYBACK_LEFT" "Output"
        connect_jack_port "$PD_OUT_RIGHT" "$PLAYBACK_RIGHT" "Output"
    done
fi

sleep 3

if [ "$MIDI_DEVICE" = "OSC" ] || [ "$MIDI_DEVICE" = "WEB" ]; then
    log_success "Starting OSC web controller..."
    log_success "Open http://127.0.0.1:3000"
    node src/dev_controller.js "$@" &
else
    log_success "Starting Node MIDI controller..."
    node src/index.js "$@" &
fi

write_pid "controller" "$!"
wait "$(cat "$PID_DIR/controller.pid")"
