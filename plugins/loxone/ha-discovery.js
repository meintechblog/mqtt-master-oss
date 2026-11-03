/**
 * Home Assistant MQTT Discovery publisher for Loxone controls.
 * Extracted from LoxonePlugin to separate HA-specific concerns.
 */

/** Map Loxone control types to Home Assistant MQTT Discovery components */
const HA_TYPE_MAP = {
  Switch: 'switch',
  Dimmer: 'light',
  Jalousie: 'cover',
  InfoOnlyAnalog: 'sensor',
  InfoOnlyDigital: 'binary_sensor',
};

/**
 * Map a Loxone control type to a Home Assistant component type.
 * @param {string} type
 * @returns {string}
 */
export function loxoneTypeToHaComponent(type) {
  return HA_TYPE_MAP[type] || 'sensor';
}

/**
 * Publish Home Assistant MQTT Discovery config for all enabled controls.
 *
 * @param {object} opts
 * @param {object} opts.structure - LoxoneStructure instance
 * @param {object} opts.mqttService - MQTT service for publishing
 * @param {string} opts.prefix - MQTT topic prefix (e.g. 'loxone')
 * @param {(uuid: string) => boolean} opts.isEnabled - check if control is enabled
 */
export function publishHaDiscovery({ structure, mqttService, prefix, isEnabled }) {
  const controls = structure.getAll();
  const nodeId = 'loxone_bridge';

  for (const ctrl of controls) {
    if (!isEnabled(ctrl.uuid)) continue;

    const component = loxoneTypeToHaComponent(ctrl.type);
    const objectId = structure.slugify(ctrl.name);
    const discoveryTopic = `homeassistant/${component}/${nodeId}/${objectId}/config`;

    const config = {
      name: ctrl.name,
      unique_id: `loxone_${ctrl.uuid.replace(/-/g, '')}`,
      state_topic: `${ctrl.topic}/state`,
      value_template: '{{ value_json.value }}',
      availability_topic: `${prefix}/bridge/status`,
      device: {
        identifiers: [nodeId],
        name: 'Loxone Miniserver',
        manufacturer: 'Loxone',
        model: 'Miniserver',
        via_device: 'mqtt-master',
      },
    };

    // Add command_topic for actuator types
    if (['switch', 'light', 'cover'].includes(component)) {
      config.command_topic = `${ctrl.topic}/cmd`;
    }

    mqttService.publish(discoveryTopic, JSON.stringify(config), { retain: true });
  }
}

/**
 * Clear retained HA Discovery messages for a control topic.
 * @param {object} mqttService
 * @param {string} baseTopic
 */
export function clearHaDiscovery(mqttService, baseTopic) {
  const slug = baseTopic.split('/').pop();
  for (const component of ['sensor', 'switch', 'light', 'cover', 'binary_sensor']) {
    mqttService.publish(`homeassistant/${component}/loxone_bridge/${slug}/config`, '', { retain: true });
  }
}
