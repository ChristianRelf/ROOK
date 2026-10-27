/**
 * Frontend configuration, read from Vite's build-time environment.
 *
 * Only `VITE_`-prefixed variables reach the bundle, which is the mechanism
 * that keeps a server secret from being shipped to users by accident. Nothing
 * here is sensitive: two URLs the client needs in order to connect.
 *
 * Validated at module load rather than at first use, so a misconfigured build
 * fails immediately and visibly instead of producing a confusing network
 * error on the first request.
 */

function required(name: string, value: string | undefined, protocols: readonly string[]): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is not set. Copy .env.example to .env and rebuild.`);
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL: "${value}"`);
  }

  if (!protocols.includes(parsed.protocol)) {
    throw new Error(`${name} must use one of ${protocols.join(', ')}, got "${parsed.protocol}"`);
  }

  // Trailing slashes would produce `//v1/...` once a path is appended.
  return value.replace(/\/+$/u, '');
}

export const config = {
  apiUrl: required('VITE_API_URL', import.meta.env.VITE_API_URL, ['http:', 'https:']),
  realtimeUrl: `${required('VITE_REALTIME_URL', import.meta.env.VITE_REALTIME_URL, [
    'ws:',
    'wss:',
  ])}/ws`,
} as const;
