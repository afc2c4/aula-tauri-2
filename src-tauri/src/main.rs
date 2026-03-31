// Ponto de entrada do binário desktop.
// A lógica real vive em lib.rs para permitir reutilização em targets mobile.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    todo_tauri_lib::run()
}
