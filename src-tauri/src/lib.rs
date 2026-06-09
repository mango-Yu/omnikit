mod gif_export;

use crate::db::{Category, Record};
use serde::Serialize;
use std::sync::Mutex;
use tauri::Manager;

pub mod db;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditionInfo {
    pub pro: bool,
    pub max_images: Option<u32>,
}

#[tauri::command]
fn edition_info() -> EditionInfo {
    EditionInfo {
        pro: true,
        max_images: None,
    }
}

#[tauri::command]
fn create_gif(paths: Vec<String>, delay_ms: u32, output_path: String) -> Result<(), String> {
    gif_export::create_gif_from_paths(&paths, delay_ms, &output_path)
}

#[tauri::command]
async fn add_record_cmd(
    state: tauri::State<'_, Mutex<rusqlite::Connection>>,
    record: Record,
) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;

    let count: i32 = conn
        .query_row(
            "SELECT COUNT(*) FROM records WHERE path = ?1",
            rusqlite::params![record.path],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    if count > 0 {
        return Err("该文件或文件夹已存在于库中".to_string());
    }

    crate::db::add_record(&conn, &record).map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_records_cmd(
    state: tauri::State<'_, Mutex<rusqlite::Connection>>,
) -> Result<Vec<Record>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    crate::db::get_records(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_record_cmd(
    state: tauri::State<'_, Mutex<rusqlite::Connection>>,
    id: String,
) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    crate::db::delete_record(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
fn check_path_is_dir(path: String) -> bool {
    std::fs::metadata(&path)
        .map(|m| m.is_dir())
        .unwrap_or(false)
}

#[tauri::command]
async fn get_categories_cmd(
    state: tauri::State<'_, Mutex<rusqlite::Connection>>,
) -> Result<Vec<Category>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    crate::db::get_categories(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
async fn add_category_cmd(
    state: tauri::State<'_, Mutex<rusqlite::Connection>>,
    category: Category,
) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    crate::db::add_category(&conn, &category).map_err(|e| e.to_string())
}

#[tauri::command]
async fn update_category_cmd(
    state: tauri::State<'_, Mutex<rusqlite::Connection>>,
    category: Category,
) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    crate::db::update_category(&conn, &category).map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_category_cmd(
    state: tauri::State<'_, Mutex<rusqlite::Connection>>,
    id: String,
) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    crate::db::delete_category(&conn, &id).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("Failed to get app data dir");
            std::fs::create_dir_all(&app_data_dir).expect("Failed to create app data dir");
            let db_path = app_data_dir.join("quickopen.db");

            let conn = crate::db::init_db(db_path).expect("Failed to initialize database");
            app.manage(Mutex::new(conn));

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            edition_info,
            create_gif,
            add_record_cmd,
            get_records_cmd,
            delete_record_cmd,
            check_path_is_dir,
            get_categories_cmd,
            add_category_cmd,
            update_category_cmd,
            delete_category_cmd
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
