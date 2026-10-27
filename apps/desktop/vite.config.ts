import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Vite configuration for the Tauri frontend.
 *
 * Tauri-specific settings and why they are needed:
 *
 *   * A fixed port with `strictPort`. Tauri's dev window is pointed at an
 *     exact URL, so silently falling back to another port leaves the window
 *     showing nothing.
 *   * `clearScreen: false` so Rust compiler output is not wiped by Vite.
 *   * `envPrefix` limited to VITE_ and TAURI_, which is what keeps a server
 *     secret in the environment from being inlined into the bundle.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],

  // Workspace packages are consumed as TypeScript source, so Vite compiles
  // them as part of the app. That means no build step for @rook/ui and no
  // stale dist to go out of sync.
  resolve: {
    preserveSymlinks: false,
  },

  server: {
    port: 1420,
    strictPort: true,
    // Tauri's webview connects over the loopback interface.
    host: '127.0.0.1',
    watch: {
      // Rust sources are watched by Tauri itself; watching them here would
      // trigger pointless frontend reloads during a Rust rebuild.
      ignored: ['**/src-tauri/**'],
    },
  },

  clearScreen: false,
  envPrefix: ['VITE_', 'TAURI_'],

  build: {
    // Tauri ships a modern webview on every platform it targets, so there is
    // no reason to down-level to older syntax.
    target: 'esnext',
    // Source maps are kept: a stack trace from a packaged desktop app is
    // otherwise unreadable, and they are not served over the network.
    sourcemap: true,
    minify: 'esbuild',
    outDir: 'dist',
    emptyOutDir: true,
  },
});
