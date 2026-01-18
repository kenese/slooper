# slooper

A DIY raspberry pi looper built using Node.js and Pure Data (Pd). This is a vibe coded fuck around so bear that in mind before relying too much on any of it. AI also wrote most of this page so it is pretty dorky. I just corrected some errors

## Features

- **Dual-Slot Looping**: Two independent looping slots with dedicated hardware controls.
- **Dynamic Hardware Support**:
Currently hardcoded to support the following but should work with any usb midi devices and class compliant audio interfaces
  - **MIDI Controllers**: Allen & Heath PX5 and Native Instruments Traktor X1 MK3.
  - **Audio Interfaces**: Allen & Heath PX5 and Traktor Z1.
- **Loop Management**:
  - **Record/Play**: Seamless recording and playback states.
  - **Clear**: Hold button for 500ms to clear a slot.
  - **Crop/Extend**: Rotate encoder to adjust loop length in real-time. 500ms of audio is recorded after your loop so you can both reduce and extend loop length
  - **Reset**: Press encoder to reset loop length to original recording. This shit not working tho 
- **Audio Processing**:
  - **Glitch-Free Looping**: Trapezoidal amplitude windowing to prevent clicks at loop points.
  - **Monitoring**: Smart monitoring that auto-mutes when loops are playing.
- **Visual Feedback**:
  - **LED Sync**: Accurate hardware LED states for Recording, Playing, and Empty states.
  - **Console Logging**: Detailed OSC and state logging for debugging.

## Getting Started

### Prerequisites

- **Node.js**: (v14+ recommended)
- **Pure Data**: (Tested with Pd-0.55-2)
- **Git**

### Installation

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd slooper
   ```
2. Install dependencies:
   ```bash
   npm install
   ```

### Running

Start the application using the provided shell script. This will automatically configure audio settings, start Pure Data, and launch the Node.js controller.

```bash
./start.sh
```

### Configuration

You can customize the hardware setup using command-line arguments:

**Select MIDI Device:**
```bash
# Default (XONE)
./start.sh

# Traktor X1 MK3
./start.sh midi-device=X1MK3
```

**Select Audio Device:**
```bash
# Default (XONE: adc 9 10, dac 1 2)
./start.sh

# Traktor Z1 (adc 1 2, dac 3 4)
./start.sh audio-device=Z1
```

**Combine Arguments:**
```bash
./start.sh midi-device=X1MK3 audio-device=Z1
```

## TODO

- [ ] Fix adjust/crop reset
- [ ] Pre-record/delay so the loop start can also be adjusted
- [ ] Visual feedback of loop position in PD
