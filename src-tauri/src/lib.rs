mod gif_export;
mod ffmpeg_export;

use crate::db::{Category, Record};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Position, Size};

pub mod db;

/// 录屏区域框选时把主窗口临时全屏置顶，退出时恢复原始窗口状态。
#[derive(Default, Clone)]
struct MainWindowSnapshot {
    size: Option<PhysicalSize<u32>>,
    position: Option<PhysicalPosition<i32>>,
    decorations: Option<bool>,
    fullscreen: Option<bool>,
    always_on_top: Option<bool>,
}

/// 列出可录屏的窗口（带标题且尺寸合理、可见、当前未被最小化）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowInfo {
    id: u32,
    title: String,
    app_name: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    is_minimized: bool,
}

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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VideoToGifArgs {
    input_path: String,
    output_path: String,
    fps: u32,
    max_long_edge: u32,
    max_seconds: u32,
}

#[tauri::command]
async fn video_to_gif_cmd(
    app: AppHandle,
    args: VideoToGifArgs,
) -> Result<(), String> {
    let app_clone = app.clone();
    ffmpeg_export::video_to_gif(
        &args.input_path,
        &args.output_path,
        args.fps,
        args.max_long_edge,
        args.max_seconds,
        &mut |done, total| {
            // 实时把进度推送到前端
            let _ = app_clone.emit(
                "video-to-gif-progress",
                serde_json::json!({ "done": done, "total": total }),
            );
        },
    )?;
    let _ = app.emit(
        "video-to-gif-progress",
        serde_json::json!({ "done": 0, "total": 0, "finished": true }),
    );
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordToGifArgs {
    output_path: String,
    fps: u32,
    max_long_edge: u32,
    max_seconds: u32,
    /// (x, y, width, height)，全屏时为 null
    region: Option<[u32; 4]>,
}

#[tauri::command]
async fn record_to_gif_cmd(
    app: AppHandle,
    args: RecordToGifArgs,
) -> Result<(), String> {
    let region = args.region.map(|r| (r[0], r[1], r[2], r[3]));
    let app_clone = app.clone();
    ffmpeg_export::record_to_gif(
        &args.output_path,
        args.fps,
        args.max_long_edge,
        args.max_seconds,
        region,
        &mut |done, total| {
            let _ = app_clone.emit(
                "record-progress",
                serde_json::json!({ "done": done, "total": total }),
            );
        },
    )?;
    let _ = app.emit(
        "record-progress",
        serde_json::json!({ "done": 0, "total": 0, "finished": true }),
    );
    Ok(())
}

#[tauri::command]
fn stop_record_cmd() -> Result<(), String> {
    ffmpeg_export::kill_record_child();
    Ok(())
}

#[tauri::command]
fn ensure_ffmpeg_cmd() -> Result<String, String> {
    let p = ffmpeg_export::ffmpeg_binary_path()?;
    Ok(p.to_string_lossy().to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CapturePreviewArgs {
    output_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CapturePreviewResult {
    path: String,
    width: u32,
    height: u32,
}

/// 启动实时屏幕预览（3 FPS 把当前桌面持续覆写到同一张 PNG）。
#[tauri::command]
async fn start_record_preview_cmd(args: CapturePreviewArgs) -> Result<CapturePreviewResult, String> {
    let (w, h) = ffmpeg_export::start_record_preview(&args.output_path)?;
    Ok(CapturePreviewResult {
        path: args.output_path,
        width: w,
        height: h,
    })
}

/// 停止实时屏幕预览。
#[tauri::command]
fn stop_record_preview_cmd() -> Result<(), String> {
    ffmpeg_export::stop_record_preview();
    Ok(())
}

/// 把主窗口临时全屏 + 置顶，供录屏区域框选覆盖整个屏幕使用。
/// 之前的状态（尺寸/位置/装饰/全屏/置顶）会被保存到 state，退出时恢复。
#[tauri::command]
fn enter_region_picker_mode_cmd(
    app: AppHandle,
    state: tauri::State<'_, Mutex<Option<MainWindowSnapshot>>>,
) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let snap = MainWindowSnapshot {
        size: window.outer_size().ok(),
        position: window.outer_position().ok(),
        decorations: window.is_decorated().ok(),
        fullscreen: window.is_fullscreen().ok(),
        always_on_top: window.is_always_on_top().ok(),
    };
    *guard = Some(snap);
    // 任意顺序：先关装饰再全屏，能避免 Windows 上出现一闪的标题栏。
    let _ = window.set_always_on_top(true);
    let _ = window.set_decorations(false);
    window
        .set_fullscreen(true)
        .map_err(|e| format!("无法将主窗口全屏：{e}"))?;
    log::info!("enter_region_picker_mode: 主窗口已临时全屏置顶");
    Ok(())
}

/// 恢复 enter_region_picker_mode_cmd 之前的窗口状态。
#[tauri::command]
fn exit_region_picker_mode_cmd(
    app: AppHandle,
    state: tauri::State<'_, Mutex<Option<MainWindowSnapshot>>>,
) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let Some(snap) = guard.take() else {
        return Ok(());
    };
    let _ = window.set_fullscreen(false);
    let _ = window.set_always_on_top(false);
    if let Some(d) = snap.decorations {
        let _ = window.set_decorations(d);
    }
    if let (Some(s), Some(p)) = (snap.size, snap.position) {
        let _ = window.set_size(Size::Physical(s));
        let _ = window.set_position(Position::Physical(p));
    }
    log::info!("exit_region_picker_mode: 主窗口已恢复");
    Ok(())
}

/// 列出当前可录屏的窗口（用于「选窗口」录屏）。
/// 过滤掉没有标题、过小、隐藏、最小化或自身主窗口的窗口。
#[tauri::command]
fn list_recordable_windows_cmd(
    app: AppHandle,
) -> Result<Vec<WindowInfo>, String> {
    use xcap::Window;

    let main_size = app
        .get_webview_window("main")
        .and_then(|w| w.outer_size().ok())
        .map(|s| (s.width, s.height));

    let mut out: Vec<WindowInfo> = Vec::new();
    let windows = Window::all().map_err(|e| format!("枚举窗口失败：{e}"))?;
    for w in windows {
        // xcap 0.9 所有字段都返回 Result<T>
        let title = w.title().unwrap_or_default();
        if title.trim().is_empty() {
            continue;
        }
        if title == "OmniKit" {
            continue;
        }
        let width = w.width().unwrap_or(0);
        let height = w.height().unwrap_or(0);
        if width < 120 || height < 80 {
            continue;
        }
        let app = w.app_name().unwrap_or_default();
        let x = w.x().unwrap_or(0);
        let y = w.y().unwrap_or(0);
        let info = WindowInfo {
            id: w.id().unwrap_or(0),
            title,
            app_name: app,
            x,
            y,
            width,
            height,
            is_minimized: w.is_minimized().unwrap_or(false),
        };
        if let Some((mw, mh)) = main_size {
            if info.x == 0
                && info.y == 0
                && info.width == mw
                && info.height == mh
            {
                continue;
            }
        }
        out.push(info);
    }
    out.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    Ok(out)
}

/// 获取主显示器尺寸（用于「整屏录屏」）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PrimaryScreenInfo {
    width: u32,
    height: u32,
    x: i32,
    y: i32,
    scale_factor: f64,
}

#[tauri::command]
fn primary_screen_info_cmd(app: AppHandle) -> Result<PrimaryScreenInfo, String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let monitor = window
        .current_monitor()
        .map_err(|e| format!("获取主显示器失败：{e}"))?
        .ok_or_else(|| "未检测到显示器".to_string())?;
    Ok(PrimaryScreenInfo {
        width: monitor.size().width,
        height: monitor.size().height,
        x: monitor.position().x,
        y: monitor.position().y,
        scale_factor: monitor.scale_factor(),
    })
}

/// 录屏写临时路径，停止后用户选目标位置，再把临时文件 move 过去。
#[tauri::command]
fn move_gif_file_cmd(src: String, dest: String) -> Result<(), String> {
    let src_path = std::path::Path::new(&src);
    if !src_path.exists() {
        return Err(format!("录屏临时文件不存在：{src}"));
    }
    if let Some(parent) = std::path::Path::new(&dest).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建目录失败：{e}"))?;
        }
    }
    match std::fs::rename(&src, &dest) {
        Ok(_) => Ok(()),
        Err(_) => {
            std::fs::copy(&src, &dest)
                .map_err(|e| format!("复制录屏文件失败：{e}"))?;
            std::fs::remove_file(&src)
                .map_err(|e| format!("清理临时文件失败：{e}"))?;
            Ok(())
        }
    }
}

/// 删除临时文件（用户取消保存时清理）。
#[tauri::command]
fn delete_gif_file_cmd(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if p.exists() {
        std::fs::remove_file(p).map_err(|e| format!("删除录屏临时文件失败：{e}"))?;
    }
    Ok(())
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

            // 探测打包内嵌的 ffmpeg：Tauri 把 resources 解析到应用所在目录或安装包内。
            // 期望布局（以 .dmg / NSIS 安装后为例）：
            //   <app>                   (可执行文件)
            //   <app>.app/              (macOS .app 包)
            //   resources/ffmpeg/...    (Tauri 拷贝的资源目录)
            // 我们在多种候选路径里找 ffmpeg 二进制，找到就写到 FFMPEG_PATH 环境变量，
            // ffmpeg_export::ensure_ffmpeg 会优先使用。
            if let Some(p) = locate_bundled_ffmpeg() {
                log::info!("设置 FFMPEG_PATH = {}", p.display());
                std::env::set_var("FFMPEG_PATH", &p);
                if let Some(parent) = p.parent() {
                    std::env::set_var("FFMPEG_DOWNLOAD_PATH", parent);
                }
            } else {
                log::warn!("未找到打包内嵌的 ffmpeg，将回退到 ffmpeg-sidecar 自动下载");
            }

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
            video_to_gif_cmd,
            record_to_gif_cmd,
            stop_record_cmd,
            ensure_ffmpeg_cmd,
            start_record_preview_cmd,
            stop_record_preview_cmd,
            enter_region_picker_mode_cmd,
            exit_region_picker_mode_cmd,
            list_recordable_windows_cmd,
            primary_screen_info_cmd,
            move_gif_file_cmd,
            delete_gif_file_cmd,
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

/// 在多个候选路径里查找打包内嵌的 ffmpeg 二进制，返回第一个存在的路径。
///
/// Tauri v2 的 `bundle.resources` 会把 `src-tauri/resources/**` 原样拷到目标平台下：
/// - macOS .app：`<App.app>/Contents/Resources/_up_/ffmpeg/...`
/// - Windows：与应用可执行文件同目录的 `resources/ffmpeg/...`
/// - Linux AppImage：解压到 `/tmp/.mount_*/resources/ffmpeg/...`
///
/// 搜索顺序（命中即返回）：
/// 1. 项目根 `resources/ffmpeg/`（dev 模式，编译期通过 CARGO_MANIFEST_DIR 确定）
/// 2. 可执行文件同级 `resources/ffmpeg/`
/// 3. 可执行文件同级 `ffmpeg/`
/// 4. 可执行文件同级 `_up_/ffmpeg/`（Tauri v2 实际拷贝位置）
/// 5. macOS bundle `../Resources/ffmpeg/`
fn locate_bundled_ffmpeg() -> Option<std::path::PathBuf> {
    use std::path::PathBuf;

    fn platform_filename() -> &'static str {
        if cfg!(target_os = "macos") {
            if cfg!(target_arch = "aarch64") {
                "ffmpeg-aarch64-apple-darwin"
            } else {
                "ffmpeg-x86_64-apple-darwin"
            }
        } else if cfg!(target_os = "windows") {
            "ffmpeg-x86_64-pc-windows-msvc.exe"
        } else {
            "ffmpeg-x86_64-unknown-linux-gnu"
        }
    }

    let target_name = platform_filename();
    let generic_name = if cfg!(target_os = "windows") { "ffmpeg.exe" } else { "ffmpeg" };
    let mut search_dirs: Vec<PathBuf> = Vec::new();

    // 1) 项目根（编译期常量，dev 模式直接命中 `g:/workspace/omnikit/resources/ffmpeg/`）
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    if let Some(project_root) = manifest_dir.parent() {
        search_dirs.push(project_root.join("resources").join("ffmpeg"));
    }

    // 2-5) 围绕可执行文件的多类候选目录
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            search_dirs.push(parent.join("resources").join("ffmpeg"));
            search_dirs.push(parent.join("ffmpeg"));
            // Tauri v2 dev 模式实际把资源拷到 `<profile>/_up_/ffmpeg/...`
            search_dirs.push(parent.join("_up_").join("ffmpeg"));
            // Tauri v2 macOS bundle 内：`<App>.app/Contents/MacOS/<exe> -> ../Resources/`
            search_dirs.push(parent.join("..").join("Resources").join("ffmpeg"));
        }
    }

    // 兜底：APPDATA
    if let Some(appdata) = std::env::var_os("APPDATA") {
        search_dirs.push(PathBuf::from(appdata).join("..").join("Local").join("resources").join("ffmpeg"));
    }

    for dir in &search_dirs {
        for name in [target_name, generic_name] {
            let p = dir.join(name);
            if p.exists() {
                log::info!("locate_bundled_ffmpeg 命中：{}", p.display());
                return Some(p);
            }
        }
    }
    log::warn!(
        "locate_bundled_ffmpeg 未命中。已搜索：\n  {}",
        search_dirs
            .iter()
            .map(|d| format!("  - {}", d.join(target_name).display()))
            .collect::<Vec<_>>()
            .join("\n")
    );
    None
}
