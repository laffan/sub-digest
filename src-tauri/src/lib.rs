mod gmail;
mod oauth;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(gmail::AuthState::default())
        .manage(gmail::ConnectState::default())
        .invoke_handler(tauri::generate_handler![
            gmail::gmail_connect,
            gmail::gmail_cancel_connect,
            gmail::gmail_status,
            gmail::gmail_disconnect,
            gmail::gmail_search,
            gmail::gmail_get_body,
            gmail::fetch_image,
            gmail::save_pdf,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
