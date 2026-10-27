/**
 * The platform adapter.
 *
 * This is the **only** module in the frontend allowed to touch a Tauri API.
 * Everything else talks to `platform`, which means the same React code can run
 * in a browser later with no changes beyond a different implementation here —
 * the spec's requirement that the frontend stay independent of Tauri.
 *
 * It exists for exactly one capability the web cannot provide well: persisting
 * the session token somewhere better than `localStorage`. In the Tauri build
 * that is the store plugin, writing to the OS application-data directory. In a
 * browser it falls back to `localStorage`, which is documented as weaker — a
 * token there is reachable from any script that achieves XSS.
 *
 * Detection is by feature, not by user agent: Tauri injects `__TAURI_INTERNALS__`
 * into the window, so its absence means we are in a plain browser.
 */

export interface TokenStore {
  read: () => Promise<string | undefined>;
  write: (token: string) => Promise<void>;
  clear: () => Promise<void>;
}

export interface Platform {
  /** True when running inside the Tauri shell. */
  readonly isDesktop: boolean;
  readonly tokens: TokenStore;
  /** Opens a URL in the user's real browser rather than the app webview. */
  openExternal: (url: string) => Promise<void>;
}

const TOKEN_KEY = 'session.token';
const STORE_FILE = 'rook.session.dat';

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Token storage backed by the Tauri store plugin.
 *
 * The plugin is imported lazily so the browser build never pulls in Tauri
 * code at all — a static import would end up in the bundle and throw on load
 * outside the shell.
 */
function createDesktopTokenStore(): TokenStore {
  // Cached because loading the store re-reads the file from disk.
  let storePromise:
    | Promise<{
        get: <T>(key: string) => Promise<T | undefined>;
        set: (key: string, value: unknown) => Promise<void>;
        delete: (key: string) => Promise<boolean>;
        save: () => Promise<void>;
      }>
    | undefined;

  async function store() {
    storePromise ??= import('@tauri-apps/plugin-store').then((module) =>
      module.load(STORE_FILE, { autoSave: false }),
    );
    return storePromise;
  }

  return {
    async read() {
      try {
        const value = await (await store()).get<string>(TOKEN_KEY);
        return typeof value === 'string' && value.length > 0 ? value : undefined;
      } catch {
        // A missing or corrupt store file is equivalent to "not signed in".
        // Failing here would lock the user out of the sign-in screen itself.
        return undefined;
      }
    },

    async write(token) {
      const handle = await store();
      await handle.set(TOKEN_KEY, token);
      // Explicit save: autoSave is off so a write is never left in memory
      // when the process exits.
      await handle.save();
    },

    async clear() {
      const handle = await store();
      await handle.delete(TOKEN_KEY);
      await handle.save();
    },
  };
}

/**
 * Browser fallback.
 *
 * Weaker than the desktop path, and knowingly so: see docs/limitations.md.
 * Every access is wrapped because `localStorage` throws outright in a private
 * window with site data blocked.
 */
function createBrowserTokenStore(): TokenStore {
  return {
    read: () =>
      Promise.resolve(
        (() => {
          try {
            return window.localStorage.getItem(TOKEN_KEY) ?? undefined;
          } catch {
            return undefined;
          }
        })(),
      ),

    write: (token) =>
      Promise.resolve(
        (() => {
          try {
            window.localStorage.setItem(TOKEN_KEY, token);
          } catch {
            // Storage unavailable: the session still works for this tab,
            // it just will not survive a reload.
          }
        })(),
      ),

    clear: () =>
      Promise.resolve(
        (() => {
          try {
            window.localStorage.removeItem(TOKEN_KEY);
          } catch {
            // Nothing to do.
          }
        })(),
      ),
  };
}

const desktop = isTauri();

export const platform: Platform = {
  isDesktop: desktop,
  tokens: desktop ? createDesktopTokenStore() : createBrowserTokenStore(),

  async openExternal(url) {
    // Only ever http(s). Without this check a crafted link could hand the OS
    // a `file:` or custom-scheme URL to open.
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Refusing to open a ${parsed.protocol} URL`);
    }

    if (desktop) {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(parsed.href);
      return;
    }

    window.open(parsed.href, '_blank', 'noopener,noreferrer');
  },
};
