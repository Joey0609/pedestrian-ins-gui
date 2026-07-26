# WalkingJourney — Multi-device Inertial Navigation Control System
[中文](README.md) | English

**WalkingJourney** is an Electron-based multi-device inertial navigation management and visualization platform. It supports WebSocket / serial port connections, real-time IMU data decoding, 3D attitude visualization, trajectory plotting, and OTA firmware upgrade.

## Features

- **Multi-device Management** — Connect dozens of IMU devices simultaneously (WiFi / Serial)
- **Real-time Data** — Acceleration, gyroscope, quaternion, Euler angles, Kalman displacement
- **3D Visualization** — Three.js-based device attitude rendering
- **Trajectory Mapping** — Real-time multi-device tracking & playback
- **Data Recording** — Raw data recording and export
- **OTA Upgrade** — Batch firmware upgrade over-the-air
- **IMU Detail Page** — Per-device uPlot charts and parameter configuration

## Getting Started

### Prerequisites

- Node.js 18+
- npm 9+

### Install & Run

```bash
git clone https://github.com/Joey0609/WalkingJourney.git
cd WalkingJourney
npm install
npm start
```

### Project Structure

```
WalkingJourney/
├── main.js                 # Electron main process (window, IPC, OTA)
├── preload.js              # Preload script (secure bridge)
├── renderer/
│   ├── index.html          # Main UI
│   ├── renderer.js         # Frontend logic (Three.js 3D, tracks, UI)
│   └── styles.css          # Styles
├── src/
│   ├── imupage.html        # Device IMU detail page (uPlot charts)
│   ├── imuDataProcessor.js # IMU data decoder
│   ├── wsManager.js        # WebSocket / Serial connection manager
│   ├── uplot.js            # uPlot chart library
│   └── uplot.css           # uPlot styles
└── assets/
    └── models/
        ├── PCBmodel.obj    # 3D PCB model
        └── PCBmodel.mtl    # Model material
```
