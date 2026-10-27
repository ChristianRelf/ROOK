import { create } from 'zustand';
import { platform } from './platform.js';

/**
 * Which server this client talks to, resolved at runtime rather than baked in.
 *
 * Vite inlines `import.meta.env` at build time, so a URL compiled into the
 * bundle can only be changed by rebuilding and redistributing the binary. For
 * a self-hosted deployment that is the wrong trade: a home server's address
 * changes, a tunnel hostname changes, and someone testing on a LAN needs a
 * different address than someone coming in over the internet.
 *
 * So the built-in URLs are only *defaults*. The sign-in screen exposes the
 * server address, and whatever the user sets is persisted and used from then
 * on.
 *
 * The realtime URL is derived from the server URL rather than asked for
 * separately, because the two are the same origin in any sane deployment --
 * one hostname through a reverse proxy, with the gateway on `/ws`. The build
 * defaults keep them independent so local development can run them on separate
 * ports without a proxy.
 */

const STORAGE_KEY = 'server.url';

/** Compiled-in defaults. Used until the user sets something else. */
const defaults = {
  apiUrl: (import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/u, ''),
  realtimeUrl: `${(import.meta.env.VITE_REALTIME_URL ?? 'ws://127.0.0.1:4001').replace(
    /\/+$/u,
    '',
  )}/ws`,
} as const;

export interface Endpoints {
  readonly apiUrl: string;
  readonly realtimeUrl: string;
}

export class InvalidServerUrlError extends Error {}

/**
 * Normalises a user-entered server address and derives the realtime URL.
 *
 * Accepts a bare host (`rook.example.com`) and assumes https, because that is
 * what people type. Rejects anything that is not http(s), so a typo cannot
 * produce a URL the client will try to open.
 */
export function deriveEndpoints(input: string): Endpoints {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new InvalidServerUrlError('Enter a server address.');
  }

  // A bare hostname is the common case when someone reads an address aloud.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new InvalidServerUrlError('That does not look like a valid address.');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InvalidServerUrlError('The address must start with http:// or https://');
  }

  // Strip any path: the API lives at the origin, and a trailing path would
  // produce URLs like `/rook//v1/auth/login`.
  const origin = `${url.protocol}//${url.host}`;
  const socketScheme = url.protocol === 'https:' ? 'wss:' : 'ws:';

  return {
    apiUrl: origin,
    // Same origin, `/ws` path. A deployment behind one hostname routes `/ws`
    // to the gateway; see docs/self-hosting.md.
    realtimeUrl: `${socketScheme}//${url.host}/ws`,
  };
}

export interface ServerState {
  readonly endpoints: Endpoints;
  /** What the user typed, kept so the field can show it back unchanged. */
  readonly serverUrl: string;
  /** False until the persisted value has been read. */
  readonly loaded: boolean;
  /** True when running against the compiled-in default. */
  readonly isDefault: boolean;

  load: () => Promise<void>;
  /** Validates, persists and applies a new address. */
  setServerUrl: (input: string) => Promise<void>;
  reset: () => Promise<void>;
}

export const useServerStore = create<ServerState>((set) => ({
  endpoints: defaults,
  serverUrl: defaults.apiUrl,
  loaded: false,
  isDefault: true,

  async load() {
    const stored = await platform.readSetting(STORAGE_KEY);

    if (stored === undefined || stored.length === 0) {
      set({ endpoints: defaults, serverUrl: defaults.apiUrl, loaded: true, isDefault: true });
      return;
    }

    try {
      set({
        endpoints: deriveEndpoints(stored),
        serverUrl: stored,
        loaded: true,
        isDefault: false,
      });
    } catch {
      // A corrupt stored value must not prevent the app from starting; fall
      // back to the default and let the user correct it.
      set({ endpoints: defaults, serverUrl: defaults.apiUrl, loaded: true, isDefault: true });
    }
  },

  async setServerUrl(input) {
    // Throws InvalidServerUrlError, which the sign-in screen renders.
    const endpoints = deriveEndpoints(input);

    await platform.writeSetting(STORAGE_KEY, input.trim());
    set({ endpoints, serverUrl: input.trim(), isDefault: false });
  },

  async reset() {
    await platform.deleteSetting(STORAGE_KEY);
    set({ endpoints: defaults, serverUrl: defaults.apiUrl, isDefault: true });
  },
}));

/** The compiled-in default, for display in settings. */
export const defaultEndpoints: Endpoints = defaults;
