/// <reference types="vite/client" />

/**
 * Build-time environment available to the frontend.
 *
 * Declared explicitly rather than relying on the index signature Vite
 * provides, so a typo in a variable name is a compile error instead of
 * `undefined` at runtime.
 */
interface ImportMetaEnv {
  readonly VITE_API_URL: string | undefined;
  readonly VITE_REALTIME_URL: string | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
