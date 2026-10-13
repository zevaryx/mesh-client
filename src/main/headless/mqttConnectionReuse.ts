/**
 * Headless shared viewing: every browser tab auto-connects MQTT when it opens. Reconnecting the
 * broker each time would drop it for every tab, so a connect with the settings of the live (or
 * still connecting) connection keeps it. New settings, or a connection that dropped or failed,
 * reconnect as on desktop.
 */
import type { MQTTSettings, MQTTStatus } from '../../renderer/lib/types';

export function createMqttConnectionReuse(): (
  protocol: 'meshtastic' | 'meshcore',
  settings: MQTTSettings,
  status: MQTTStatus,
) => boolean {
  const lastKey = new Map<string, string>();
  return (protocol, settings, status) => {
    const key = JSON.stringify(settings);
    const live = status === 'connected' || status === 'connecting';
    if (live && lastKey.get(protocol) === key) {
      console.debug(
        `[headless] mqtt:connect (${protocol}): same settings, keeping the live connection`,
      );
      return true;
    }
    lastKey.set(protocol, key);
    return false;
  };
}
