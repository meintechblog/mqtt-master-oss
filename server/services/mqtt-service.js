import { EventEmitter } from 'node:events';
import mqtt from 'mqtt';

export class MqttService extends EventEmitter {
  constructor(brokerUrl) {
    super();
    this.brokerUrl = brokerUrl;
    this.client = null;
    this.connected = false;
  }

  async connect() {
    return new Promise((resolve) => {
      this.client = mqtt.connect(this.brokerUrl, {
        clientId: `mqtt-master-${Date.now()}`,
        clean: true,
        reconnectPeriod: 5000,
      });

      this.client.on('connect', () => {
        this.connected = true;
        this.emit('connected');
        resolve();
      });

      this.client.on('error', (err) => {
        // Only emit if there are listeners; EventEmitter throws on
        // unhandled 'error' events which would crash the process.
        if (this.listenerCount('error') > 0) {
          this.emit('error', err);
        }
      });

      this.client.on('close', () => {
        this.connected = false;
        this.emit('disconnected');
      });

      this.client.on('message', (topic, payload, packet) => {
        this.emit('message', {
          topic,
          payload: payload.toString(),
          timestamp: Date.now(),
          // `packet.retain` is the broker's retain flag for THIS delivery.
          // Note the MQTT subtlety: it is reliably true only for the initial
          // retained dump at subscribe time; live publishes that arrive while
          // we're already subscribed carry retain=false even though the broker
          // still holds a retained copy. Consumers that want "does a retained
          // value exist for this topic" should treat it as sticky.
          retain: !!packet?.retain,
        });
      });

      // Timeout for initial connection -- don't block startup
      setTimeout(() => {
        if (!this.connected) {
          resolve();
        }
      }, 5000);
    });
  }

  subscribe(topic) {
    if (this.client) this.client.subscribe(topic);
  }

  unsubscribe(topic) {
    if (this.client) this.client.unsubscribe(topic);
  }

  publish(topic, payload, opts) {
    if (this.client) this.client.publish(topic, payload, opts);
  }

  isConnected() {
    return this.connected;
  }
}
