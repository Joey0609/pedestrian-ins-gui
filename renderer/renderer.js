// Composition root only: domain modules own state, rendering and event handling.
import '../src/imuDataProcessor.js';
import { createDialogs } from './dialogs.js';
import { showNotification } from './notifications.js';
import { createAttitudeView } from './attitude-view.js';
import { createTracks } from './tracks.js';
import { createRecording } from './recording.js';
import { createDevices } from './devices.js';
import { createAppUpdates } from './app-updates.js';
import { createOtaDialog } from './ota-dialog.js';
import { createDiscovery } from './discovery.js';
import { createRuntimeMonitor } from './runtime-monitor.js';
import { bindToolbar } from './toolbar.js';

const electronAPI = window.electronAPI;
let devices, discovery;
const dialogs = createDialogs({ onHide: () => discovery.reset() });
const tracks = createTracks();
const recording = createRecording({ electronAPI, dialogs, showNotification });
const attitude = createAttitudeView({ electronAPI, getConnections: () => devices.getConnections() });
devices = createDevices({ electronAPI, attitude, tracks, recording, dialogs, showNotification });
const updates = createAppUpdates({ electronAPI, dialogs, showNotification });
const ota = createOtaDialog({ electronAPI, getConnections: devices.getConnections, getTransportTypeById: devices.getTransportTypeById, listConns: devices.listConns, dialogs, showNotification });
discovery = createDiscovery({ electronAPI, listConns: devices.listConns, dialogs, showNotification });
const monitor = createRuntimeMonitor({
  getModelCache: attitude.getModelCache,
  getCaches: () => ({ ...tracks.getCacheData(), ...recording.getCacheData(), ...discovery.getCacheData(), connections: devices.getConnections() }),
});

// Register once, after every dependency has been constructed. No module has
// import-time timers, DOM listeners, IPC subscriptions or hardware operations.
monitor.start();
devices.bindFrameMessages();
updates.start();
discovery.start();
bindToolbar({ electronAPI, devices, recording, ota, dialogs, showNotification });
devices.start();
ota.start();
tracks.initialize();
devices.startPolling();
