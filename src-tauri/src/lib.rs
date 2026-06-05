use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

mod tray;

#[tauri::command]
fn toggle_main_window(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.set_focus();
        }
    } else {
        let _ = WebviewWindowBuilder::new(&app, "main", WebviewUrl::default())
            .title("Paw - 工作台")
            .inner_size(480.0, 640.0)
            .resizable(true)
            .build();
    }
}

#[tauri::command]
fn pet_drag_start(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("pet") {
        let _ = window.start_dragging();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            tray::create_tray(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            toggle_main_window,
            pet_drag_start,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
