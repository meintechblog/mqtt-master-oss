import { signal } from '@preact/signals';
import { createWsClient } from './ws-factory.js';

/** Reactive state for dashboard metrics from $SYS topics */
export const dashboardState = signal({ data: {}, topics: {} });

/** Whether the MQTT broker is connected (from backend connection_status messages) */
export const brokerConnected = signal(false);

const client = createWsClient({
  path: '/ws/dashboard',
  onMessage(msg) {
    switch (msg.type) {
      case 'sys_state':
        dashboardState.value = { data: msg.data, topics: msg.topics };
        break;
      case 'connection_status':
        brokerConnected.value = msg.connected;
        break;
    }
  },
});

/** Whether the WebSocket transport itself is open */
export const wsConnected = client.connected;

export const connectDashboardWs = client.connect;
export const disconnectDashboardWs = client.disconnect;

// Auto-connect on module import
connectDashboardWs();
