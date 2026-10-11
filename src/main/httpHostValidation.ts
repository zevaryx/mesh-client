import { isValidConnectHost, parseConnectHostPort } from '../shared/connectHost';

export { isValidConnectHost as isValidHttpHostname } from '../shared/connectHost';

const MAX_HOST_LENGTH = 253;

/**
 * Validate a radio host passed over IPC. Shared by the Electron main process and the headless
 * server so both reject the same inputs.
 */
export function validateHttpHost(host: unknown): asserts host is string {
  if (typeof host !== 'string' || host.length === 0 || host.length > MAX_HOST_LENGTH) {
    throw new Error('Invalid host');
  }
  // http:preflight/http:connect pass an authority string with a port already
  // appended (formatHostForUrl); meshcore:tcp-connect passes a bare host.
  // Strip a trailing port before validating so both call sites work.
  const bareHost = parseConnectHostPort(host, 0).host;
  if (!isValidConnectHost(bareHost)) {
    throw new Error('Invalid host format');
  }
}
