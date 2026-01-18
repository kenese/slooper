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

echo "🎛️  Opening Pure Data..."
open src/engine.pd

sleep 3

echo "🚀 Starting Node controller..."
node src/index.js
