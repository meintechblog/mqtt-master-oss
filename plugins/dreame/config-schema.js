/**
 * Dreame plugin config-form schema (auto-rendered by the webapp's generic
 * plugin-config page, same shape as the unifi / loxone schemas).
 *
 * Not part of the form, configured in config.json (the generic renderer has no
 * editor for arrays of objects and would turn them into a string):
 *   devices: [{ key: "eg"|"og", did | name | model, befehlThema, befehlVorlaeufer }]
 *     key          topic segment, [a-z0-9-]+ (never a device id)
 *     did/name/model  how to find the robot in the account list (first match wins)
 *     befehlThema  Loxone state topic carrying the command value
 *     befehlVorlaeufer  Loxone uuids that feed the command control in the
 *                  Miniserver logic (e.g. visualised pause inputs); the Loxone
 *                  plugin refuses writes to them; list the
 *                  control uuid (lowercase), it covers the control's states
 *   refreshToken   written by the plugin itself (stored encrypted)
 *
 * @returns {object} JSON-Schema-shaped config form definition.
 */
export function getConfigSchema() {
  return {
    type: 'object',
    properties: {
      username: {
        type: 'string',
        title: 'Dreamehome Account (e-mail)',
        description: 'Dreamehome account of the robots (account type "dreame").',
      },
      password: {
        type: 'string',
        title: 'Password',
        format: 'password',
        description: 'Stored encrypted. Used to obtain the refresh key; later logins use the stored refresh key, '
          + 'the password only once more when the cloud rejects that key.',
      },
      country: {
        type: 'string',
        title: 'Cloud region',
        default: 'eu',
        description: 'Two-letter region of the Dreame cloud (eu, us, cn, sg, ru, kr).',
      },
      topicRoot: {
        type: 'string',
        title: 'MQTT topic root',
        default: 'haus/sauger',
        description: 'State topics are published below <root>/<key>/..., availability on <root>/online.',
      },
      pollSeconds: {
        type: 'integer',
        title: 'Poll interval (s)',
        default: 60,
        minimum: 15,
        description: 'Cloud poll interval; cloud push updates arrive in between when available.',
      },
      autoStart: {
        type: 'boolean',
        title: 'Auto-start',
        default: false,
        description: 'Start the plugin automatically when the server starts.',
      },
    },
  };
}
