/**
 * The platform adapter.
 *
 * This is the **only** module in the frontend that touches a Tauri API.
 * Everything else talks to `platform`, so the same React code can run in a
 * browser with no change beyond a different implementation here -- which is
 * the spec's requirement that the frontend stay independent of Tauri.
 *
 * It provides two things a browser cannot do well:
 *
 *   * **Persistence outside web storage.** In the Tauri build this is the
 *     store plugin, writing to the OS application-data directory. In a browser
 *     it falls back to `localStorage`, which is weaker -- a value there is
 *     reachable from any script that achieves XSS. See docs/limitations.md.
 *   * **Opening a URL in the user's real browser**, rather than inside the
 *     app's webview.
 *
 * Detection is by feature, not user agent: Tauri injects
 * `__TAURI_INTERNALS__` into the window, so its absence means a plain browser.
 */

export interface Platform {
  /** True when running inside the Tauri shell. */
  readonly isDesktop: boolean;

  /** Reads a persisted string, or undefined when absent. */
  readSetting: (key: string) => Promise<string | undefined>;
  writeSetting: (key: string, value: string) => Promise<void>;
  deleteSetting: (key: string) => Promise<void>;

  /** Opens a URL in the user's real browser. Only http(s) is permitted. */
  openExternal: (url: string) => Promise<void>;
}

const STORE_FILE = 'rook.settings.dat';

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** Minimal shape of the store plugin's handle, so it need not be imported as a type. */
interface StoreHandle {
  get: <T>(key: string) => Promise<T | undefined>;
  set: (key: string, value: unknown) => Promise<void>;
  delete: (key: string) => Promise<boolean>;
  save: () => Promise<void>;
}

/**
 * Persistence via the Tauri store plugin.
 *
 * The plugin is imported lazily so the browser build never pulls Tauri code
 * into its bundle -- a static import would end up there and throw on load
 * outside the shell.
 */
function createDesktopPlatform(): Omit<Platform, 'isDesktop' | 'openExternal'> {
  // Cached, because loading the store re-reads the file from disk.
  let storePromise: Promise<StoreHandle> | undefined;

  async function store(): Promise<StoreHandle> {
    storePromise ??= import('@tauri-apps/plugin-store').then(
      (module) => module.load(STORE_FILE, { autoSave: false }) as unknown as Promise<StoreHandle>,
    );
    return storePromise;
  }

  return {
    async readSetting(key) {
      try {
        const value = await (await store()).get<string>(key);
        return typeof value === 'string' && value.length > 0 ? value : undefined;
      } catch {
        // A missing or corrupt store file is equivalent to "not set". Throwing
        // would lock the user out of the sign-in screen itself.
        return undefined;
      }
    },

    async writeSetting(key, value) {
      const handle = await store();
      await handle.set(key, value);
      // Explicit save: autoSave is off, so a write is never left in memory
      // when the process exits.
      await handle.save();
    },

    async deleteSetting(key) {
      try {
        const handle = await store();
        await handle.delete(key);
        await handle.save();
      } catch {
        // Nothing persisted, nothing to remove.
      }
    },
  };
}

/**
 * Browser fallback.
 *
 * Every access is wrapped because `localStorage` throws outright in a private
 * window with site data blocked.
 */
function createBrowserPlatform(): Omit<Platform, 'isDesktop' | 'openExternal'> {
  return {
    readSetting: (key) =>
      Promise.resolve(
        (() => {
          try {
            return window.localStorage.getItem(key) ?? undefined;
          } catch {
            return undefined;
          }
        })(),
      ),

    writeSetting: (key, value) =>
      Promise.resolve(
        (() => {
          try {
            window.localStorage.setItem(key, value);
          } catch {
            // Storage unavailable: the value still applies for this session,
            // it just will not survive a reload.
          }
        })(),
      ),

    deleteSetting: (key) =>
      Promise.resolve(
        (() => {
          try {
            window.localStorage.removeItem(key);
          } catch {
            // Nothing to do.
          }
        })(),
      ),
  };
}

const desktop = isTauri();
const storage = desktop ? createDesktopPlatform() : createBrowserPlatform();

export const platform: Platform = {
  isDesktop: desktop,
  ...storage,

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

/**
 * The session token, as a named wrapper over the settings store.
 *
 * Kept separate so the sensitive value has one obvious place in the codebase,
 * rather than being one string key among many.
 */
const TOKEN_KEY = 'session.token';

export const tokenStore = {
  read: () => platform.readSetting(TOKEN_KEY),
  write: (token: string) => platform.writeSetting(TOKEN_KEY, token),
  clear: () => platform.deleteSetting(TOKEN_KEY),
};
