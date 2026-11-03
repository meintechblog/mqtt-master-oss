import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebSocket from '@fastify/websocket';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ConfigService } from './services/config-service.js';
import { MqttService } from './services/mqtt-service.js';
import { SysBrokerService } from './services/sys-broker-service.js';
import { TopicCacheService } from './services/topic-cache-service.js';
import { PluginManager } from './services/plugin-manager.js';
import wsDashboard from './routes/ws-dashboard.js';
import wsMessages from './routes/ws-messages.js';
import apiPlugins from './routes/api-plugins.js';
import apiSystem from './routes/api-system.js';
import apiHealth from './routes/api-health.js';
import apiDiscovery from './routes/api-discovery.js';
import apiUpdate from './routes/api-update.js';
import apiBridges from './routes/api-bridges.js';
import { UpdateService } from './services/update-service.js';
import { BridgeService } from './services/bridge-service.js';
import { installWriteGuard, DEFAULT_WRITE_ALLOW } from './lib/write-guard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Write guard, REST/WebSocket routes and SPA fallback, in this order.
 * Exported so the tests exercise exactly the wiring start() uses.
 */
export async function registerRoutes(app, config) {
  // writes only from the allowlist until the UI has a login
  installWriteGuard(app, { allow: config.get('web.writeAllow', DEFAULT_WRITE_ALLOW) });

  // REST API routes (before SPA fallback so /api/* routes match)
  await app.register(apiPlugins);
  await app.register(apiSystem);
  await app.register(apiHealth);
  await app.register(apiDiscovery);
  await app.register(apiUpdate);
  await app.register(apiBridges);

  // WebSocket routes
  await app.register(wsDashboard);
  await app.register(wsMessages);

  // SPA fallback: serve index.html for unmatched routes
  app.setNotFoundHandler((request, reply) => {
    return reply.sendFile('index.html');
  });
}

export async function start(opts = {}) {
  const configPath = opts.configPath || '/opt/mqtt-master/config.json';
  const config = new ConfigService(configPath);
  await config.load();

  const app = Fastify({
    logger: {
      level: config.get('logLevel', 'info'),
    },
  });

  // Static files -- serve webapp/
  await app.register(fastifyStatic, {
    root: join(__dirname, '..', 'webapp'),
    prefix: '/',
  });

  // WebSocket support (registered early, used in Phase 2+)
  await app.register(fastifyWebSocket);

  // MQTT service -- connect to broker
  const mqttService = new MqttService(config.get('mqtt.broker', 'mqtt://localhost:1883'));
  await mqttService.connect();

  // Decorate Fastify with shared services
  app.decorate('mqttService', mqttService);
  app.decorate('configService', config);

  // SysBrokerService -- aggregates $SYS metrics from broker
  const sysBrokerService = new SysBrokerService(mqttService);
  app.decorate('sysBrokerService', sysBrokerService);

  // TopicCacheService -- remembers every topic seen since startup so the
  // dashboard's Topic Browser doesn't depend on slow republish cadences.
  const topicCacheService = new TopicCacheService(mqttService);
  app.decorate('topicCacheService', topicCacheService);

  // UpdateService -- periodic GitHub poll + auto-apply via the sibling
  // mqtt-master-updater.service unit.
  const updateService = new UpdateService({ config, logger: app.log });
  app.decorate('updateService', updateService);
  updateService.start();

  // BridgeService -- manages mosquitto-native broker bridges declared under
  // `bridges.list` in config.json. Constructed BEFORE the plugin manager so
  // the $SYS/broker/connection/+/state subscription is up by the time
  // mosquitto publishes any retained state for existing bridges.
  const bridgeService = new BridgeService({ config, mqttService, logger: app.log });
  app.decorate('bridgeService', bridgeService);

  // Plugin system
  const pluginManager = new PluginManager({
    pluginDir: config.get('pluginDir', join(__dirname, '..', 'plugins')),
    configService: config,
    mqttService,
    logger: app.log,
  });
  await pluginManager.discover();
  app.decorate('pluginManager', pluginManager);

  await registerRoutes(app, config);

  const port = opts.port ?? config.get('web.port', 80);
  const host = opts.host || '0.0.0.0';
  await app.listen({ port, host });

  return app;
}

// Auto-start when run directly
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  start().catch((err) => {
    console.error('Failed to start:', err);
    process.exit(1);
  });
}
