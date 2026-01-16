#!/bin/bash

# Slooper Startup Script
# Quits Pd if running, opens engine.pd with DSP auto-on, and starts Node controller

cd "$(dirname "$0")"

echo "🔄 Stopping any running instances..."
pkill -f "node src/index.js" 2>/dev/null
osascript -e 'tell application "Pd-0.55-2" to quit' 2>/dev/null || \
osascript -e 'tell application "Pd" to quit' 2>/dev/null || \
pkill -9 pd 2>/dev/null

sleep 1

echo "🎛️  Opening Pure Data..."
open src/engine.pd

sleep 3

echo "🚀 Starting Node controller..."
node src/index.js
