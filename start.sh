#!/bin/bash

# Slooper Startup Script
# Quits Pd if running, opens engine.pd with DSP auto-on, and starts Node controller

cd "$(dirname "$0")"



# Define cleanup function
cleanup() {
    echo ""
    echo "🧹 Close running instances..."
    # Force kill any Pd instances
    if [[ "$OSTYPE" == "darwin"* ]]; then
        killall "Pd-0.55-2" 2>/dev/null
        killall Pd 2>/dev/null
        killall pd 2>/dev/null
        pkill -9 "Pd" 2>/dev/null
    else
        killall pd 2>/dev/null
        pkill -9 pd 2>/dev/null
    fi
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

# Function to run sed compatibly
run_sed() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' -e "$1" "$2"
    else
        sed -i -e "$1" "$2"
    fi
}

if [ "$AUDIO_DEVICE" == "Z1" ]; then
    # Z1: adc 1 2, dac 3 4
    run_sed 's/adc~ [0-9]* [0-9]*/adc~ 1 2/' src/engine.pd
    run_sed 's/dac~ [0-9]* [0-9]*/dac~ 3 4/' src/engine.pd
elif [ "$AUDIO_DEVICE" == "XONE" ]; then
    # XONE: adc 9 10, dac 1 2
    run_sed 's/adc~ [0-9]* [0-9]*/adc~ 9 10/' src/engine.pd
    run_sed 's/dac~ [0-9]* [0-9]*/dac~ 1 2/' src/engine.pd
else
    echo "⚠️ Unknown audio device: $AUDIO_DEVICE. Using current settings."
fi

# On Linux (JACK), Pd ports are always logical 1/2 regardless of hardware channel
if [[ "$OSTYPE" != "darwin"* ]]; then
    run_sed 's/adc~ [0-9]* [0-9]*/adc~ 1 2/' src/engine.pd
    run_sed 's/dac~ [0-9]* [0-9]*/dac~ 1 2/' src/engine.pd
fi


echo "🎛️  Opening Pure Data..."
if [[ "$OSTYPE" == "darwin"* ]]; then
    open src/engine.pd
else
    # Linux: Start JACK if not running
    if ! pgrep -x jackd > /dev/null && ! pgrep -x jackdbus > /dev/null; then
        echo "🔊 Starting JACK audio server..."
        jackd -d alsa -d hw:0 -r 48000 -p 256 -n 3 &
        sleep 2
    else
        echo "✅ JACK already running"
    fi
    
    # Linux/Patchbox: Run with JACK support, disable Pd MIDI to let Node.js use it
    pd -nogui -jack -nomidi src/engine.pd &
    
    # Wait for Pd to start and register ports
    sleep 5
    
    # Auto-connect Pd to system audio (adjust ports if needed)
    echo "🔗 Connecting JACK audio ports..."
    jack_connect system:capture_1 pure_data:input_1 2>/dev/null
    jack_connect system:capture_2 pure_data:input_2 2>/dev/null
    jack_connect pure_data:output_1 system:playback_1 2>/dev/null
    jack_connect pure_data:output_2 system:playback_2 2>/dev/null
    
    echo "🔍 JACK Connections:"
    jack_lsp -c
fi

sleep 3

echo "🚀 Starting Node controller..."
node src/index.js "$@"
