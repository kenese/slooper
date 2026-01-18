#!/bin/bash

# Slooper Startup Script
# Quits Pd if running, opens engine.pd with DSP auto-on, and starts Node controller

cd "$(dirname "$0")"


# Define cleanup function
cleanup() {
    echo ""
    echo "🛑 Shutting down..."
    # Force kill any Pd instances
    killall "Pd-0.55-2" 2>/dev/null
    killall Pd 2>/dev/null
    killall pd 2>/dev/null
    pkill -9 "Pd" 2>/dev/null
    pkill -9 "pd" 2>/dev/null
}

# Trap EXIT signal (happens on ctrl+c or normal exit) to run cleanup
trap cleanup EXIT

echo "🔄 Stopping any running instances..."
pkill -f "node src/index.js" 2>/dev/null
cleanup

sleep 1

# Parse arguments for local use
AUDIO_DEVICE="XONE"
for arg in "$@"
do
    case $arg in
        audio-device=*)
        AUDIO_DEVICE="${arg#*=}"
        ;;
    esac
done

echo "🎛️  Configuring Audio for: $AUDIO_DEVICE"

if [ "$AUDIO_DEVICE" == "Z1" ]; then
    # Z1: adc 1 2, dac 3 4
    sed -i '' 's/adc~ [0-9]* [0-9]*/adc~ 1 2/' src/engine.pd
    sed -i '' 's/dac~ [0-9]* [0-9]*/dac~ 3 4/' src/engine.pd
elif [ "$AUDIO_DEVICE" == "XONE" ]; then
    # XONE: adc 9 10, dac 1 2
    sed -i '' 's/adc~ [0-9]* [0-9]*/adc~ 9 10/' src/engine.pd
    sed -i '' 's/dac~ [0-9]* [0-9]*/dac~ 1 2/' src/engine.pd
else
    echo "⚠️ Unknown audio device: $AUDIO_DEVICE. Using current settings."
fi


echo "🎛️  Opening Pure Data..."
open src/engine.pd

sleep 3

echo "🚀 Starting Node controller..."
node src/index.js "$@"
