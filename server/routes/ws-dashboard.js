/**
 * WebSocket route for /ws/dashboard.
 * Pushes real-time $SYS broker metrics to connected clients.
 */
export default async function wsDashboard(app) {
  const clients = new Set();

  function safeSend(socket, msg) {
    try {
      socket.send(msg);
    } catch {
      clients.delete(socket);
    }
  }

  function broadcast(message) {
    const msg = JSON.stringify(message);
    for (const socket of clients) {
      safeSend(socket, msg);
    }
  }

  // Listen for SysBrokerService events and broadcast to all clients
  app.sysBrokerService.on('update', (state) => {
    broadcast({ type: 'sys_state', ...state });
  });

  app.sysBrokerService.on('connection_status', (status) => {
    broadcast({ type: 'connection_status', ...status });
  });

  app.get('/ws/dashboard', { websocket: true }, (socket) => {
    clients.add(socket);

    // Send full current state on connect
    const state = app.sysBrokerService.getState();
    safeSend(socket, JSON.stringify({ type: 'sys_state', ...state }));
    safeSend(socket, JSON.stringify({
      type: 'connection_status',
      connected: app.sysBrokerService.isConnected(),
    }));

    socket.on('close', () => {
      clients.delete(socket);
    });
  });
}
