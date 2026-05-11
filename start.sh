#!/bin/bash

# Slooper Startup Script
# Quits Pd if running, opens engine.pd with DSP auto-on, and starts Node controller

cd "$(dirname "$0")"



# Define cleanup function
cleanup() {
    echo ""
    echo "🧹 Cleaning up..."
    
    # Kill Node controllers
    pkill -f "node src/index.js" 2>/dev/null
    pkill -f "node src/dev_controller.js" 2>/dev/null
    
    # Force kill any Pd instances
    if [[ "$OSTYPE" == "darwin"* ]]; then
        killall "Pd-0.55-2" 2>/dev/null
        killall Pd 2>/dev/null
        killall pd 2>/dev/null
        pkill -9 "Pd" 2>/dev/null
    else
        killall pd 2>/dev/null
        pkill -9 pd 2>/dev/null
        # Also stop JACK on Linux so USB audio can be safely unplugged
        pkill jackd 2>/dev/null
        pkill jackdbus 2>/dev/null
    fi
    
    echo "✅ Stopped. Safe to unplug audio device."
}

# Trap EXIT signal (happens on ctrl+c or normal exit) to run cleanup
trap cleanup EXIT

# Parse arguments first (need to check for --stop early)
AUDIO_DEVICE="XONE"
MIDI_DEVICE="XONE"
RESTART_JACK=false
STOP_ONLY=false

for arg in "$@"
do
    case $arg in
        device=*)
        AUDIO_DEVICE="${arg#*=}"
        ;;
        audio-device=*)
        AUDIO_DEVICE="${arg#*=}"
        ;;
        midi-device=*)
        MIDI_DEVICE="${arg#*=}"
        ;;
        --restart-jack)
        RESTART_JACK=true
        ;;
        --stop)
        STOP_ONLY=true
        ;;
    esac
done

# Handle --stop flag (just cleanup and exit)
if [ "$STOP_ONLY" = true ]; then
    echo "🛑 Stopping slooper..."
    cleanup
    trap - EXIT  # Remove trap since we already cleaned up
    exit 0
fi

echo "🔄 Stopping any running instances..."
cleanup
trap cleanup EXIT  # Re-enable trap after manual cleanup

sleep 1

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
elif [ "$AUDIO_DEVICE" == "MAC" ] || [ "$AUDIO_DEVICE" == "BLACKHOLE" ]; then
    # Mac dev: BlackHole 2ch input, built-in/headphone output
    run_sed 's/adc~ [0-9]* [0-9]*/adc~ 1 2/' src/engine.pd
    run_sed 's/dac~ [0-9]* [0-9]*/dac~ 1 2/' src/engine.pd
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
    # Linux: Kill JACK if restart requested
    if [ "$RESTART_JACK" = true ]; then
        echo "🔄 Restarting JACK (--restart-jack flag)..."
        pkill -9 jackd 2>/dev/null
        pkill -9 jackdbus 2>/dev/null
        sleep 1
    fi
    
    # Linux: Start JACK if not running
    if ! pgrep -x jackd > /dev/null && ! pgrep -x jackdbus > /dev/null; then
        echo "🔊 Starting JACK audio server..."
        
        # Auto-detect XONE:PX5 card number
        XONE_CARD=$(aplay -l 2>/dev/null | grep -i "XONE" | head -1 | sed 's/card \([0-9]*\):.*/\1/')
        
        if [ -n "$XONE_CARD" ]; then
            echo "   Found XONE:PX5 on card $XONE_CARD"
            JACK_DEVICE="hw:$XONE_CARD"
        else
            echo "   ⚠️  XONE not found, trying hw:3 (common USB position)"
            JACK_DEVICE="hw:3"
        fi
        
        # Start JACK with low-latency settings
        # Buffer: 128 frames × 2 periods = ~5.3ms latency at 48kHz
        # If you get xruns (audio glitches), increase to: -p 256 -n 2 (~10.7ms)
        echo "   Latency target: ~5ms (128 frames × 2 periods @ 48kHz)"
        jackd -d alsa -d "$JACK_DEVICE" -r 48000 -p 128 -n 2 &
        sleep 3
    else
        echo "✅ JACK already running"
    fi
    
    # Linux/Patchbox: Run with JACK support, disable Pd MIDI to let Node.js use it
    pd -nogui -jack -nomidi src/engine.pd &
    
    # Wait for Pd to start and register ports
    echo "⏳ Waiting for Pure Data to register JACK ports..."
    for i in {1..10}; do
        if jack_lsp 2>/dev/null | grep -q "pure_data"; then
            echo "   ✅ Pure Data ports found!"
            break
        fi
        sleep 1
    done
    
    # Show available ports for debugging
    echo ""
    echo "📋 Available JACK ports:"
    jack_lsp 2>/dev/null || echo "   (Could not list ports)"
    echo ""
    
    # Auto-connect Pd to system audio
    # XONE:PX5 uses channels 9-10 for main stereo input (same as Mac)
    # Output goes to channels 1-2 (main stereo output)
    echo "🔗 Connecting JACK audio ports..."
    echo "   (Input: capture_9/10 → Pd, Output: Pd → playback_1/2)"
    
    # Disconnect any existing connections first
    jack_disconnect system:capture_1 pure_data:input_1 2>/dev/null
    jack_disconnect system:capture_2 pure_data:input_2 2>/dev/null
    
    # Connect the correct XONE channels
    jack_connect system:capture_9 pure_data:input_1 && echo "   ✅ capture_9 → input_1" || echo "   ⚠️ capture_9 → input_1 (may already be connected)"
    jack_connect system:capture_10 pure_data:input_2 && echo "   ✅ capture_10 → input_2" || echo "   ⚠️ capture_10 → input_2 (may already be connected)"
    jack_connect pure_data:output_1 system:playback_1 && echo "   ✅ output_1 → playback_1" || echo "   ⚠️ output_1 → playback_1 (may already be connected)"
    jack_connect pure_data:output_2 system:playback_2 && echo "   ✅ output_2 → playback_2" || echo "   ⚠️ output_2 → playback_2 (may already be connected)"
    
    echo ""
    echo "🔍 Active JACK Connections:"
    jack_lsp -c 2>/dev/null || echo "   (Could not list connections)"
    echo ""
fi

sleep 3

if [ "$MIDI_DEVICE" == "OSC" ] || [ "$MIDI_DEVICE" == "WEB" ]; then
    echo "🚀 Starting OSC web controller..."
    echo "🌐 Open http://127.0.0.1:3000"
    node src/dev_controller.js
else
    echo "🚀 Starting Node MIDI controller..."
    node src/index.js "$@"
fi
