mod anthropic;
mod gmail;
mod log;
mod oauth;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .manage(gmail::AuthState::default())
        .manage(gmail::ConnectState::default())
        .setup(|app| {
            // Route OAuth redirects delivered by custom URL scheme (iOS) into
            // the pending sign-in. Harmless on desktop, where loopback is used.
            use tauri_plugin_deep_link::DeepLinkExt;
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    gmail::deliver_deep_link(&handle, url.as_str());
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            gmail::gmail_connect,
            gmail::gmail_cancel_connect,
            gmail::gmail_status,
            gmail::gmail_disconnect,
            gmail::gmail_search,
            gmail::gmail_get_body,
            gmail::fetch_image,
            gmail::save_file,
            anthropic::anthropic_test,
            anthropic::anthropic_process,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
