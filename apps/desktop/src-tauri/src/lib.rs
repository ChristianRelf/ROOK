//! The Tauri shell.
//!
//! Deliberately almost empty. Rook's logic lives in the API and the web
//! frontend; the Rust side exists only to host a webview and provide the two
//! things a browser cannot:
//!
//!   * a token store in the OS application-data directory, via the store
//!     plugin, rather than `localStorage`;
//!   * opening a link in the user's real browser rather than inside the app.
//!
//! No custom commands are registered. Every additional command is another
//! piece of native surface area reachable from the frontend, and so far
//! nothing needs one. If performance-sensitive native work is added later
//! (image pre-processing before upload, for instance), it belongs here behind
//! an explicit command and a capability entry.

/// Starts the application.
pub fn run() {
    tauri::Builder::default()
        // Persists the session token outside the webview's storage.
        .plugin(tauri_plugin_store::Builder::new().build())
        // Opens external URLs in the default browser. The frontend validates
        // the scheme before calling in; see src/lib/platform.ts.
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running the Rook desktop application");
}
