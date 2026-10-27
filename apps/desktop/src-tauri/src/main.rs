// Prevents a console window appearing alongside the app on Windows release
// builds. Left enabled in debug builds so `println!` and panics stay visible.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    rook_desktop_lib::run()
}
