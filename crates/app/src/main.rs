// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod crypto;
mod menu;
mod metastore;
mod state;

use state::AppState;
use tauri::Manager;

fn main() {
    // Initialize tauri-plugin-stronghold.
    // Password/salt derivation approach for Stronghold:
    // We derive the 32-byte key from the vault password using SHA-256.
    // The vault password itself is backed by a machine-local secret file (`.vault_key`) created in `app_data_dir`.
    // This approach was chosen because on minimal/headless Linux systems without an OS keyring daemon (gnome-keyring/KWallet),
    // there is no OS secret service running. Generating a 256-bit random key saved in `app_data_dir` (protected by Unix 0600 file permissions)
    // allows Stronghold vault encryption to work automatically without forcing the user to enter a master password on app startup.
    let stronghold_plugin = tauri_plugin_stronghold::Builder::new(|password| {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(password);
        hasher.finalize().to_vec()
    })
    .build();

    tauri::Builder::default()
        .plugin(stronghold_plugin)
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("Failed to get app_data_dir: {}", e))?;

            crypto::init_crypto(&app_data_dir)?;

            let db_path = app_data_dir.join("zebraa.db");
            let db = metastore::initialize_database(&db_path)
                .map_err(|e| format!("Failed to initialize metastore: {}", e))?;

            app.manage(AppState::new(db));

            let menu = menu::build_menu(app.handle())?;
            app.set_menu(menu)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::connections_list,
            commands::connections_test,
            commands::connections_create,
            commands::connections_update,
            commands::connections_delete,
            commands::schema_get,
            commands::query_execute,
            commands::query_explain,
            commands::table_sample,
            commands::table_stats,
            commands::crypto_get_backend,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
