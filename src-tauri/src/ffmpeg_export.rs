//! 基于 FFmpeg 的视频转 GIF 与录屏转 GIF。
//!
//! 视频转 GIF：调用本地 ffmpeg 二进制，从任意格式视频中按指定 FPS 抽 RGB 帧，
//!   再用 `gif` crate 实时编码为 GIF。
//!
//! 录屏转 GIF：调用 ffmpeg 的 avfoundation（macOS）/ gdigrab（Windows）/
//!   x11grab（Linux）后端，按指定时长与区域录制并直接抽帧编码。
//!
//! FFmpeg 二进制位置优先级（由 `lib.rs` 在应用启动时按以下顺序探测并写入 `FFMPEG_PATH`）：
//! 1. 项目根 `resources/ffmpeg/ffmpeg-{target-triple}`（dev 模式首选）
//! 2. 应用安装包内 `resources/ffmpeg/...`
//! 3. 回退到 `ffmpeg-sidecar` 从 GitHub Release 自动下载到本地缓存目录（约 80MB）
//!
//! 重要：本模块**不依赖** ffmpeg-sidecar 的命令执行（其 v2.5.x 不读取 FFMPEG_PATH，
//! 只会到 `FFMPEG_DOWNLOAD_PATH/ffmpeg(.exe)` 找一个固定文件名，与多平台文件名冲突）。
//! 我们用 `std::process::Command` 显式指定二进制路径，raw RGB 输出 / 进度 / stderr
//! 全部自己解析。

use gif::{DisposalMethod, Encoder, Frame, Repeat};
use image::imageops;
use image::{GenericImageView, RgbaImage};
use once_cell::sync::OnceCell;
use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

/// 全局初始化标记：保证 `auto_download` 只跑一次。
static FFMPEG_READY: OnceCell<Result<(), String>> = OnceCell::new();
/// 录屏进程句柄：允许用户中途取消。
static RECORD_CHILD: OnceCell<Mutex<Option<Child>>> = OnceCell::new();
/// 录屏预览进程句柄：用于在用户框选过程中持续刷新屏幕快照。
static PREVIEW_CHILD: OnceCell<Mutex<Option<Child>>> = OnceCell::new();
/// 录屏取消标志
static RECORD_CANCEL: AtomicBool = AtomicBool::new(false);
/// 预览取消标志
static PREVIEW_CANCEL: AtomicBool = AtomicBool::new(false);

/// 解析 ffmpeg 二进制的实际路径：优先 `FFMPEG_PATH` 环境变量，否则用
/// `ffmpeg-sidecar` 的默认路径（其默认会读 `FFMPEG_DOWNLOAD_PATH` + 固定文件名）。
pub fn ffmpeg_bin() -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("FFMPEG_PATH") {
        let path = PathBuf::from(p);
        if path.exists() {
            return Ok(path);
        }
        return Err(format!("FFMPEG_PATH 指向不存在的文件：{}", path.display()));
    }
    let p = ffmpeg_sidecar::paths::ffmpeg_path();
    if p.exists() {
        return Ok(p);
    }
    Err(format!(
        "未找到 ffmpeg 二进制（FFMPEG_PATH 未设置，且默认路径 {} 不存在）",
        p.display()
    ))
}

/// 构造 ffmpeg 子进程。Windows 上 ffmpeg.exe 是控制台程序，GUI 应用直接 spawn
/// 会弹出黑框；CREATE_NO_WINDOW 让它在后台跑。
fn ffmpeg_command(bin: impl AsRef<Path>) -> Command {
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut cmd = Command::new(bin.as_ref());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// 用 ffmpeg 自带的 -version 命令验证二进制可用，把首行版本字符串写日志。
/// 主要用于诊断「文件存在但 spawn 失败」的情形。
fn verify_ffmpeg(path: &std::path::Path) -> Result<(), String> {
    let metadata =
        std::fs::metadata(path).map_err(|e| format!("无法读取 ffmpeg 元数据：{}", e))?;
    log::info!(
        "ffmpeg 文件大小：{} 字节 ({})",
        metadata.len(),
        path.display()
    );

    let output = ffmpeg_command(path)
        .arg("-version")
        .output()
        .map_err(|e| {
            format!(
                "无法执行 ffmpeg -version：{}（文件可能不是有效的 PE 可执行文件）",
                e
            )
        })?;
    if !output.status.success() {
        return Err(format!(
            "ffmpeg -version 失败（exit={:?}）：\nstderr: {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let version_str = String::from_utf8_lossy(&output.stdout);
    let first_line = version_str.lines().next().unwrap_or("");
    log::info!("ffmpeg 验证成功：{}", first_line);
    Ok(())
}

/// 确保 ffmpeg 二进制已就绪：
/// 1. 若环境变量 `FFMPEG_PATH` 已指向一个可执行文件，验证可用后直接使用；
/// 2. 否则调用 `ffmpeg-sidecar` 的 `auto_download` 从 GitHub Release 下载到本地缓存。
pub fn ensure_ffmpeg() -> Result<(), String> {
    FFMPEG_READY
        .get_or_init(|| {
            if let Ok(p) = std::env::var("FFMPEG_PATH") {
                let path = PathBuf::from(&p);
                if path.exists() {
                    log::info!("FFMPEG_PATH 已就绪：{}", p);
                    return verify_ffmpeg(&path);
                }
                log::warn!("FFMPEG_PATH 指向不存在的文件：{}，回退到自动下载", p);
            }
            ffmpeg_sidecar::download::auto_download()
                .map_err(|e| format!("FFmpeg 自动下载失败：{}", e))?;
            // auto_download 返回 ()，下载完成后通过 ffmpeg_path() 拿实际位置
            let p = ffmpeg_sidecar::paths::ffmpeg_path();
            log::info!("ffmpeg-sidecar 已就绪：{}", p.display());
            if !p.exists() {
                return Err(format!(
                    "FFmpeg 自动下载后仍找不到二进制：{}",
                    p.display()
                ));
            }
            std::env::set_var("FFMPEG_PATH", &p);
            if let Some(parent) = p.parent() {
                std::env::set_var("FFMPEG_DOWNLOAD_PATH", parent);
            }
            verify_ffmpeg(&p)
        })
        .clone()
}

/// ffmpeg 进程在用户机器上的实际位置（首次下载后）。
pub fn ffmpeg_binary_path() -> Result<PathBuf, String> {
    ensure_ffmpeg()?;
    ffmpeg_bin()
}

/// 把任意长度边等比缩放到不超过 max_long_edge。
fn scaled_dims(src_w: u32, src_h: u32, max_long_edge: u32) -> (u32, u32) {
    let long = src_w.max(src_h);
    if long <= max_long_edge || long == 0 {
        return (src_w, src_h);
    }
    let scale = max_long_edge as f64 / long as f64;
    let w = ((src_w as f64) * scale).round().max(1.0) as u32;
    let h = ((src_h as f64) * scale).round().max(1.0) as u32;
    (w, h)
}

/// 构造统一的缩放 filter：等比缩放到不超过 `max_long_edge` 的框内，
/// 边长对齐偶数。用 ffmpeg 原生的 `force_original_aspect_ratio=decrease`，
/// 避免手写 if(gt(...)) 表达式导致宽高比计算错误。
fn scale_filter(max_long_edge: u32) -> String {
    format!(
        "scale=min(iw\\,{e}):min(ih\\,{e}):force_original_aspect_ratio=decrease:force_divisible_by=2",
        e = max_long_edge
    )
}

/// 确保输出文件的父目录存在（前端可能只拼路径、不建目录）。
fn ensure_parent_dir(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("无法创建输出目录 {}：{}", parent.display(), e))?;
        }
    }
    Ok(())
}

/// GIF 延迟单位是 1/100 秒。8fps → 13cs，不要把毫秒直接写进去（否则会变成慢动作）。
fn gif_delay_cs_for_fps(fps: u32) -> u16 {
    let fps = fps.max(1);
    ((100 + fps / 2) / fps).clamp(2, 50) as u16
}

/// 把 raw RGB 帧数据写入已初始化好的 GIF encoder。
fn write_rgb_frame(
    encoder: &mut Encoder<File>,
    width: u16,
    height: u16,
    rgb: &[u8],
    delay_cs: u16,
) -> Result<(), String> {
    // speed 越大越快（1–30）；录屏要跟上实时帧率，质量让一点。
    let mut frame = Frame::from_rgb_speed(width, height, rgb, 20);
    frame.delay = delay_cs;
    frame.dispose = DisposalMethod::Keep;
    encoder
        .write_frame(&frame)
        .map_err(|e| format!("写入 GIF 帧失败：{}", e))
}

#[cfg(target_os = "macos")]
mod macos_tcc {
    use std::sync::atomic::{AtomicBool, Ordering};

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGRequestScreenCaptureAccess() -> bool;
        fn CGPreflightScreenCaptureAccess() -> bool;
    }

    /// 每个进程只弹一次系统授权框。未公证的安装包上 `CGPreflight` 经常误报
    /// 未授权；再调 `CGRequestScreenCaptureAccess` 就会出现「已经勾了还弹窗」。
    static REQUESTED_THIS_PROCESS: AtomicBool = AtomicBool::new(false);

    const RESTART_REQUIRED: &str = "屏幕录制权限需要重新启动后才能生效。\n\
请按 Command+Q 完全退出 OmniKit（只关窗口不够），再重新打开后开始录屏。\n\
开发版和 GitHub 安装包是两套身份，系统设置里可能有多条「OmniKit」，请全部打开。";

    const NOT_GRANTED: &str = "未获得屏幕录制权限。请打开「系统设置 → 隐私与安全性 → 录屏与系统录音」，\
勾选当前这个 OmniKit，然后按 Command+Q 完全退出再打开。";

    pub fn ensure() -> Result<(), String> {
        if has_access() {
            return Ok(());
        }

        // 已经向系统要过一次：不要再弹系统框。
        if REQUESTED_THIS_PROCESS.swap(true, Ordering::SeqCst) {
            return if has_access() {
                Ok(())
            } else {
                Err(RESTART_REQUIRED.into())
            };
        }

        let granted = unsafe { CGRequestScreenCaptureAccess() };
        if has_access() {
            return Ok(());
        }
        if granted {
            return Err(RESTART_REQUIRED.into());
        }
        Err(NOT_GRANTED.into())
    }

    fn has_access() -> bool {
        if unsafe { CGPreflightScreenCaptureAccess() } {
            return true;
        }
        // ad-hoc / 未公证包上 Preflight 常为 false。能读到其他 App 窗口标题，说明已经授权。
        can_read_other_window_titles()
    }

    fn can_read_other_window_titles() -> bool {
        let Ok(windows) = xcap::Window::all() else {
            return false;
        };
        windows.iter().any(|w| {
            let app = w.app_name().unwrap_or_default();
            if app.is_empty() || app == "OmniKit" || app == "Window Server" || app == "Dock" {
                return false;
            }
            !w.title().unwrap_or_default().trim().is_empty()
        })
    }
}

#[cfg(target_os = "macos")]
fn macos_primary_monitor() -> Result<xcap::Monitor, String> {
    let mut monitors = xcap::Monitor::all().map_err(|e| format!("枚举显示器失败：{e}"))?;
    if monitors.is_empty() {
        return Err("未检测到显示器".into());
    }
    let idx = monitors
        .iter()
        .position(|m| m.is_primary().unwrap_or(false))
        .unwrap_or(0);
    Ok(monitors.remove(idx))
}

/// 前端传来的 region 是物理像素；xcap::capture_region 要逻辑点（相对显示器）。
#[cfg(target_os = "macos")]
fn macos_physical_to_logical_region(
    monitor: &xcap::Monitor,
    region: (u32, u32, u32, u32),
) -> Result<(u32, u32, u32, u32), String> {
    let scale = monitor.scale_factor().unwrap_or(1.0) as f64;
    let scale = if scale > 0.1 { scale } else { 1.0 };
    let mw = monitor.width().unwrap_or(0).max(1);
    let mh = monitor.height().unwrap_or(0).max(1);
    let (x, y, w, h) = region;
    let mut lx = ((x as f64) / scale).floor() as u32;
    let mut ly = ((y as f64) / scale).floor() as u32;
    let mut lw = ((w as f64) / scale).ceil().max(1.0) as u32;
    let mut lh = ((h as f64) / scale).ceil().max(1.0) as u32;
    if lx >= mw {
        lx = mw - 1;
    }
    if ly >= mh {
        ly = mh - 1;
    }
    lw = lw.min(mw - lx).max(1);
    lh = lh.min(mh - ly).max(1);
    Ok((lx, ly, lw, lh))
}

#[cfg(target_os = "macos")]
fn macos_grab_frame(region: Option<(u32, u32, u32, u32)>) -> Result<RgbaImage, String> {
    let monitor = macos_primary_monitor()?;
    match region {
        None => monitor
            .capture_image()
            .map_err(|e| format!("截取屏幕失败：{e}")),
        Some(r) => {
            let (x, y, w, h) = macos_physical_to_logical_region(&monitor, r)?;
            monitor
                .capture_region(x, y, w, h)
                .map_err(|e| format!("截取区域失败：{e}"))
        }
    }
}

fn rgba_to_rgb(img: &RgbaImage) -> Vec<u8> {
    let mut rgb = Vec::with_capacity(img.len() / 4 * 3);
    for px in img.pixels() {
        rgb.push(px[0]);
        rgb.push(px[1]);
        rgb.push(px[2]);
    }
    rgb
}

fn prepare_record_frame(img: RgbaImage, max_long_edge: u32) -> (u32, u32, Vec<u8>) {
    let (w, h) = img.dimensions();
    let (mut tw, mut th) = scaled_dims(w, h, max_long_edge);
    tw = tw.max(2) & !1;
    th = th.max(2) & !1;
    let out = if tw == w && th == h {
        img
    } else {
        // thumbnail 适合大图缩小，比 Triangle resize 快，录屏才能跟上 8fps
        imageops::thumbnail(&img, tw, th)
    };
    let rgb = rgba_to_rgb(&out);
    (out.width(), out.height(), rgb)
}

/// macOS：在本进程用 xcap 连续截屏。ffmpeg 子进程的 avfoundation 在新系统上
/// 往往只吐出一帧，且不会弹出 OmniKit 的屏幕录制授权。
#[cfg(target_os = "macos")]
fn record_to_gif_macos(
    output_path: &str,
    fps: u32,
    max_long_edge: u32,
    max_seconds: u32,
    region: Option<(u32, u32, u32, u32)>,
    on_progress: &mut dyn FnMut(u32, u32),
) -> Result<(), String> {
    macos_tcc::ensure()?;
    RECORD_CANCEL.store(false, Ordering::SeqCst);

    let first = macos_grab_frame(region)?;
    let (canvas_w, canvas_h, first_rgb) = prepare_record_frame(first, max_long_edge);
    if canvas_w == 0 || canvas_h == 0 {
        return Err("录屏首帧尺寸无效".into());
    }

    let max_frames = fps * max_seconds;
    let target_delay = gif_delay_cs_for_fps(fps);
    ensure_parent_dir(Path::new(output_path))?;
    let file = File::create(Path::new(output_path))
        .map_err(|e| format!("无法创建输出文件：{}", e))?;
    let mut encoder = Encoder::new(file, canvas_w as u16, canvas_h as u16, &[])
        .map_err(|e| e.to_string())?;
    encoder
        .set_repeat(Repeat::Infinite)
        .map_err(|e| e.to_string())?;

    write_rgb_frame(
        &mut encoder,
        canvas_w as u16,
        canvas_h as u16,
        &first_rgb,
        target_delay,
    )?;
    let mut written: u32 = 1;
    on_progress(written, max_frames);

    let interval = Duration::from_millis((1000 / fps.max(1)) as u64);
    let deadline = Instant::now() + Duration::from_secs(max_seconds as u64);

    while written < max_frames && Instant::now() < deadline {
        if RECORD_CANCEL.load(Ordering::SeqCst) {
            break;
        }
        let tick = Instant::now();
        match macos_grab_frame(region) {
            Ok(img) => {
                let (w, h, rgb) = prepare_record_frame(img, max_long_edge);
                let frame_rgb = if w == canvas_w && h == canvas_h {
                    rgb
                } else {
                    let dyn_img = image::RgbImage::from_raw(w, h, rgb)
                        .ok_or_else(|| "无法重建帧缓冲".to_string())?;
                    let resized = imageops::thumbnail(&dyn_img, canvas_w, canvas_h);
                    resized.into_raw()
                };
                write_rgb_frame(
                    &mut encoder,
                    canvas_w as u16,
                    canvas_h as u16,
                    &frame_rgb,
                    target_delay,
                )?;
                written += 1;
                on_progress(written, max_frames);
            }
            Err(e) => {
                log::warn!("录屏抓帧失败：{e}");
                if written == 0 {
                    return Err(e);
                }
            }
        }
        let remain = interval.saturating_sub(tick.elapsed());
        if !remain.is_zero() {
            let until = Instant::now() + remain;
            while Instant::now() < until {
                if RECORD_CANCEL.load(Ordering::SeqCst) {
                    break;
                }
                thread::sleep(Duration::from_millis(10));
            }
        }
    }

    if written < 2 {
        return Err("录屏未产生足够的帧，请确认已允许屏幕录制权限后重试".into());
    }
    Ok(())
}

/// 从 ffmpeg 的 stdout 按 `width*height*3` 字节读取一帧 RGB。读到 0 字节返回 false。
fn read_rgb_frame<R: Read>(
    reader: &mut R,
    width: u32,
    height: u32,
    out: &mut Vec<u8>,
) -> std::io::Result<bool> {
    let frame_bytes = (width as usize) * (height as usize) * 3;
    out.resize(frame_bytes, 0);
    reader.read_exact(&mut out[..])?;
    Ok(true)
}

/// 启动一个 ffmpeg 子进程，把其 stdout 当成 raw RGB 流（rgb24）持续读取。
/// stderr 由独立线程消费，仅用于日志。
struct RawRgbProcess {
    child: Child,
    stdout: std::process::ChildStdout,
    frame_w: u32,
    frame_h: u32,
    stderr_thread: Option<std::thread::JoinHandle<()>>,
    stderr_failed: std::sync::Arc<AtomicBool>,
}

impl RawRgbProcess {
    fn spawn(
        bin: &Path,
        args: Vec<String>,
        frame_w: u32,
        frame_h: u32,
    ) -> Result<Self, String> {
        let mut cmd = ffmpeg_command(bin);
        cmd.args(["-hide_banner", "-y"]);
        cmd.args(&args);
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("启动 ffmpeg 失败：{}（bin={}）", e, bin.display()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or("无法获取 ffmpeg stdout".to_string())?;
        let stderr_failed = std::sync::Arc::new(AtomicBool::new(false));
        let mut stderr = child
            .stderr
            .take()
            .ok_or("无法获取 ffmpeg stderr".to_string())?;
        let stderr_failed_clone = stderr_failed.clone();
        let stderr_thread = std::thread::spawn(move || {
            let reader = BufReader::new(&mut stderr);
            for line in reader.lines().map_while(Result::ok) {
                if line.to_lowercase().contains("error") || line.starts_with("[error]") {
                    log::error!("[ffmpeg] {}", line);
                    stderr_failed_clone.store(true, Ordering::SeqCst);
                } else if line.starts_with("[fatal]") {
                    log::error!("[ffmpeg] {}", line);
                    stderr_failed_clone.store(true, Ordering::SeqCst);
                }
            }
        });
        Ok(Self {
            child,
            stdout,
            frame_w,
            frame_h,
            stderr_thread: Some(stderr_thread),
            stderr_failed,
        })
    }

    fn read_frame(&mut self, buf: &mut Vec<u8>) -> Result<bool, String> {
        match read_rgb_frame(&mut self.stdout, self.frame_w, self.frame_h, buf) {
            Ok(b) => Ok(b),
            Err(e) => {
                // 读到末尾是正常退出
                if e.kind() == std::io::ErrorKind::UnexpectedEof {
                    Ok(false)
                } else {
                    Err(format!("读取 ffmpeg RGB 帧失败：{}", e))
                }
            }
        }
    }

    fn wait(&mut self) -> Result<std::process::ExitStatus, String> {
        let status = self
            .child
            .wait()
            .map_err(|e| format!("等待 ffmpeg 失败：{}", e))?;
        if let Some(t) = self.stderr_thread.take() {
            let _ = t.join();
        }
        if !status.success() || self.stderr_failed.load(Ordering::SeqCst) {
            return Err(format!("ffmpeg 退出码非 0：{:?}", status.code()));
        }
        Ok(status)
    }

    fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(t) = self.stderr_thread.take() {
            let _ = t.join();
        }
    }
}

/// 视频转 GIF 入口（被 Tauri 命令调用）。
///
/// 先用一次 ffmpeg 进程拿首帧像素以确定画布尺寸，再用第二次 ffmpeg 进程
/// 把所有帧依次写入 GIF encoder。
pub fn video_to_gif(
    input_path: &str,
    output_path: &str,
    fps: u32,
    max_long_edge: u32,
    max_seconds: u32,
    on_progress: &mut dyn FnMut(u32, u32),
) -> Result<(), String> {
    ensure_ffmpeg()?;

    if !Path::new(input_path).exists() {
        return Err(format!("找不到视频文件：{}", input_path));
    }

    let bin = ffmpeg_bin()?;
    let fps = fps.clamp(1, 60);
    let max_long_edge = max_long_edge.clamp(64, 4096);
    let max_seconds = max_seconds.clamp(1, 600);
    let max_frames = fps * max_seconds;

    // 第一次：让 ffmpeg 把首帧写到临时 PNG，拿到尺寸 + 像素数据
    let (probe_w, probe_h, first_frame) = {
        let probe_png = std::env::temp_dir().join(format!(
            "omnikit-probe-{}.png",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let probe_path = probe_png.to_string_lossy().to_string();
        let status = ffmpeg_command(&bin)
            .args(["-v", "error", "-y", "-i", input_path])
            .args(["-vf", &scale_filter(max_long_edge)])
            .args(["-frames:v", "1", "-update", "1"])
            .arg(&probe_path)
            .status()
            .map_err(|e| format!("启动 ffmpeg 探测尺寸失败：{}", e))?;
        if !status.success() {
            return Err(format!("ffmpeg 探测尺寸失败（exit={:?}）", status.code()));
        }
        let img = image::open(&probe_png).map_err(|e| format!("无法读取探测帧：{}", e))?;
        let (w, h) = img.dimensions();
        let rgb = img.to_rgb8();
        let mut first = Vec::with_capacity(rgb.len());
        first.extend_from_slice(rgb.as_raw());
        let _ = std::fs::remove_file(&probe_png);
        (w, h, first)
    };

    let (canvas_w, canvas_h) = scaled_dims(probe_w, probe_h, max_long_edge);
    if canvas_w == 0 || canvas_h == 0 {
        return Err("视频画面尺寸无效".into());
    }

    let delay_cs: u16 = gif_delay_cs_for_fps(fps);
    ensure_parent_dir(Path::new(output_path))?;
    let file = File::create(Path::new(output_path))
        .map_err(|e| format!("无法创建输出文件：{}", e))?;
    let mut encoder = Encoder::new(file, canvas_w as u16, canvas_h as u16, &[])
        .map_err(|e| e.to_string())?;
    encoder
        .set_repeat(Repeat::Infinite)
        .map_err(|e| e.to_string())?;

    // 把首帧写进 GIF
    write_rgb_frame(
        &mut encoder,
        canvas_w as u16,
        canvas_h as u16,
        &first_frame,
        delay_cs,
    )?;
    on_progress(1, max_frames);

    // 第二次：完整抽帧
    let args = vec![
        "-v".to_string(),
        "error".to_string(),
        "-i".to_string(),
        input_path.to_string(),
        "-vf".to_string(),
        scale_filter(max_long_edge),
        "-frames:v".to_string(),
        max_frames.to_string(),
        "-f".to_string(),
        "rawvideo".to_string(),
        "-pix_fmt".to_string(),
        "rgb24".to_string(),
        "-".to_string(),
    ];
    let mut proc = RawRgbProcess::spawn(&bin, args, canvas_w, canvas_h)?;
    let mut written: u32 = 1;
    let mut frame_buf: Vec<u8> = Vec::new();
    loop {
        match proc.read_frame(&mut frame_buf) {
            Ok(true) => {
                write_rgb_frame(
                    &mut encoder,
                    canvas_w as u16,
                    canvas_h as u16,
                    &frame_buf,
                    delay_cs,
                )?;
                written += 1;
                on_progress(written, max_frames);
            }
            Ok(false) => break,
            Err(e) => {
                proc.kill();
                return Err(e);
            }
        }
    }
    proc.wait()?;

    if written < 2 {
        return Err("视频时长过短或抽帧失败，未能生成任何帧".into());
    }
    Ok(())
}

/// 屏幕录制 → GIF（基于 ffmpeg 的 avfoundation / gdigrab / x11grab）。
///
/// 一次性启动 ffmpeg 进程，录指定秒数、抽帧、边录边编码 GIF。
/// `region` 可选 (x, y, width, height) 用于框选屏幕区域。
pub fn record_to_gif(
    output_path: &str,
    fps: u32,
    max_long_edge: u32,
    max_seconds: u32,
    region: Option<(u32, u32, u32, u32)>,
    on_progress: &mut dyn FnMut(u32, u32),
) -> Result<(), String> {
    let fps = fps.clamp(1, 30);
    let max_long_edge = max_long_edge.clamp(64, 4096);
    let max_seconds = max_seconds.clamp(1, 120);

    #[cfg(target_os = "macos")]
    {
        return record_to_gif_macos(
            output_path,
            fps,
            max_long_edge,
            max_seconds,
            region,
            on_progress,
        );
    }

    #[cfg(not(target_os = "macos"))]
    {
    ensure_ffmpeg()?;
    let bin = ffmpeg_bin()?;
    let max_frames = fps * max_seconds;

    // 探测首帧尺寸：让 ffmpeg 抓一帧到 PNG，再读尺寸
    let probe_png = std::env::temp_dir().join(format!(
        "omnikit-rec-probe-{}.png",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let probe_path = probe_png.to_string_lossy().to_string();

    let mut probe_cmd = ffmpeg_command(&bin);
    probe_cmd.args(["-hide_banner", "-y"]);
    configure_record_input_std(&mut probe_cmd, fps, max_long_edge, None, region)?;
    probe_cmd
        .args(["-frames:v", "1", "-update", "1"])
        .arg(&probe_path);
    probe_cmd.stderr(Stdio::piped());
    let probe_output = probe_cmd
        .output()
        .map_err(|e| format!("启动 ffmpeg 录屏探测失败：{}（bin={}）", e, bin.display()))?;
    if !probe_output.status.success() {
        return Err(ffmpeg_status_error(
            "ffmpeg 录屏探测失败",
            &probe_output.status,
            &String::from_utf8_lossy(&probe_output.stderr),
        ));
    }
    let probe_img = image::open(&probe_png).map_err(|e| format!("无法读取探测帧：{}", e))?;
    let (probe_w, probe_h) = probe_img.dimensions();
    let _ = std::fs::remove_file(&probe_png);
    let (canvas_w, canvas_h) = scaled_dims(probe_w, probe_h, max_long_edge);
    if canvas_w == 0 || canvas_h == 0 {
        return Err("录屏首帧尺寸无效".into());
    }

    // 启动完整录屏进程
    let mut cmd = ffmpeg_command(&bin);
    cmd.args(["-hide_banner", "-y"]);
    configure_record_input_std(&mut cmd, fps, max_long_edge, Some(max_seconds), region)?;
    cmd.args(["-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    RECORD_CANCEL.store(false, Ordering::SeqCst);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动 ffmpeg 录屏失败：{}（bin={}）", e, bin.display()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or("无法获取 ffmpeg stdout".to_string())?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or("无法获取 ffmpeg stderr".to_string())?;

    // stderr 由独立线程消费（错误检测）
    let stderr_failed = std::sync::Arc::new(AtomicBool::new(false));
    let stderr_failed_clone = stderr_failed.clone();
    let stderr_thread = std::thread::spawn(move || {
        let reader = BufReader::new(&mut stderr);
        for line in reader.lines().map_while(Result::ok) {
            let lower = line.to_lowercase();
            if lower.contains("error") || line.starts_with("[fatal]") {
                log::error!("[ffmpeg record] {}", line);
                stderr_failed_clone.store(true, Ordering::SeqCst);
            } else {
                log::debug!("[ffmpeg record] {}", line);
            }
        }
    });

    // 存进全局句柄，便于 kill
    {
        let cell = RECORD_CHILD.get_or_init(|| Mutex::new(None));
        if let Ok(mut guard) = cell.lock() {
            *guard = Some(child);
        }
    }

    // 读取 raw RGB 帧
    let delay_cs: u16 = gif_delay_cs_for_fps(fps);
    ensure_parent_dir(Path::new(output_path))?;
    let file = File::create(Path::new(output_path))
        .map_err(|e| format!("无法创建输出文件：{}", e))?;
    let mut encoder = Encoder::new(file, canvas_w as u16, canvas_h as u16, &[])
        .map_err(|e| e.to_string())?;
    encoder
        .set_repeat(Repeat::Infinite)
        .map_err(|e| e.to_string())?;

    let mut stdout = BufReader::new(stdout);
    let mut written: u32 = 0;
    let mut frame_buf: Vec<u8> = Vec::new();
    loop {
        if RECORD_CANCEL.load(Ordering::SeqCst) {
            kill_record_child();
            if written == 0 {
                return Err("录屏已取消".into());
            }
            break;
        }
        let frame_bytes = (canvas_w as usize) * (canvas_h as usize) * 3;
        frame_buf.resize(frame_bytes, 0);
        match stdout.read_exact(&mut frame_buf) {
            Ok(()) => {
                write_rgb_frame(
                    &mut encoder,
                    canvas_w as u16,
                    canvas_h as u16,
                    &frame_buf,
                    delay_cs,
                )?;
                written += 1;
                on_progress(written, max_frames);
            }
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => {
                kill_record_child();
                return Err(format!("读取 ffmpeg RGB 帧失败：{}", e));
            }
        }
    }
    kill_record_child();
    let _ = stderr_thread.join();

    if written == 0 {
        return Err("录屏未产生任何帧".into());
    }
    if stderr_failed.load(Ordering::SeqCst) {
        log::warn!("录屏过程中 ffmpeg 报告错误，但已成功写入 {} 帧", written);
    }
    Ok(())
    }
}

/// 解析 ffmpeg stderr，把非 0 退出码转成可读错误。
#[cfg(not(target_os = "macos"))]
fn ffmpeg_status_error(label: &str, status: &std::process::ExitStatus, stderr: &str) -> String {
    let detail = stderr.trim();
    if detail.is_empty() {
        format!("{label}（exit={:?}）", status.code())
    } else {
        format!("{label}（exit={:?}）：{detail}", status.code())
    }
}

/// 为不同平台注入录屏输入参数（Windows / Linux），写入 std::process::Command。
/// `duration_secs` 为 None 时不限制时长（探测首帧用）。
#[cfg(not(target_os = "macos"))]
fn configure_record_input_std(
    cmd: &mut Command,
    fps: u32,
    max_long_edge: u32,
    duration_secs: Option<u32>,
    region: Option<(u32, u32, u32, u32)>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let input = "desktop".to_string();
        if let Some((x, y, w, h)) = region {
            cmd.args([
                "-f", "gdigrab", "-framerate", &fps.to_string(), "-offset_x", &x.to_string(),
                "-offset_y", &y.to_string(), "-video_size", &format!("{}x{}", w, h), "-i", &input,
            ])
            .args(["-vf", &scale_filter(max_long_edge)]);
        } else {
            cmd.args(["-f", "gdigrab", "-framerate", &fps.to_string(), "-i", &input])
                .args(["-vf", &scale_filter(max_long_edge)]);
        }
        if let Some(t) = duration_secs {
            cmd.args(["-t", &t.to_string()]);
        }
    }
    #[cfg(target_os = "linux")]
    {
        let input = region
            .map(|(x, y, _, _)| format!(":0.0+{},{}", x, y))
            .unwrap_or_else(|| ":0.0+0,0".to_string());
        let size = region
            .map(|(_, _, w, h)| format!("{}x{}", w, h))
            .unwrap_or_else(|| "1920x1080".to_string());
        cmd.args([
            "-f", "x11grab", "-framerate", &fps.to_string(), "-video_size", &size, "-i", &input,
        ])
        .args(["-vf", &scale_filter(max_long_edge)]);
        if let Some(t) = duration_secs {
            cmd.args(["-t", &t.to_string()]);
        }
    }
    let _ = (cmd, fps, max_long_edge, duration_secs, region);
    Ok(())
}

/// 主动结束当前录屏进程（用户点停止时调用）。
/// 用 `child.kill()` 投递 SIGKILL / TerminateProcess 后立即返回——
/// 不能再调用 `child.wait()`，因为 `record_to_gif` 主循环的
/// `stdout.read_exact` 会因 stdout 管道关闭而返回 UnexpectedEof
/// 并 break 退出；Tauri 异步 worker 不应被 `wait()` 阻塞，否则
/// `stop_record_cmd` 与 `record_to_gif_cmd` 调度到同一 worker 时
/// 会互相等待，导致前端 `await recordToGif()` 永远不返回、
/// 保存对话框无法弹出。
pub fn kill_record_child() {
    RECORD_CANCEL.store(true, Ordering::SeqCst);
    if let Some(cell) = RECORD_CHILD.get() {
        if let Ok(mut guard) = cell.lock() {
            if let Some(child) = guard.as_mut() {
                // best-effort: 杀完即走，进程在后台 reap 即可
                let _ = child.kill();
            }
            // 不调用 child.wait()：让子进程由系统在后台回收，
            // 也避免主线程被阻塞。
            *guard = None;
        }
    }
}

/// 把预览帧原子写入 PNG：先写临时文件再 rename，避免前端读到写到一半的文件。
/// 长边超过 1920 时缩小，减轻 WKWebView 反复解码大图导致的闪烁。
/// 返回值仍是屏幕原始宽高，框选坐标按物理像素映射。
#[cfg(target_os = "macos")]
fn save_preview_png_atomic(img: &RgbaImage, output_path: &str) -> Result<(u32, u32), String> {
    let (orig_w, orig_h) = img.dimensions();
    let (tw, th) = scaled_dims(orig_w, orig_h, 1920);
    let scaled;
    let to_save: &RgbaImage = if tw == orig_w && th == orig_h {
        img
    } else {
        scaled = imageops::thumbnail(img, tw, th);
        &scaled
    };

    let dest = Path::new(output_path);
    let tmp = dest.with_file_name(format!(
        ".{}.tmp.png",
        dest.file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("preview")
    ));
    to_save
        .save(&tmp)
        .map_err(|e| format!("无法写入预览：{e}"))?;
    std::fs::rename(&tmp, dest).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("无法提交预览：{e}")
    })?;
    Ok((orig_w, orig_h))
}

/// 抓一帧屏幕快照，保存为 PNG，返回 (width, height)。
fn capture_preview_png_inner(output_path: &str) -> Result<(u32, u32), String> {
    if let Some(parent) = Path::new(output_path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建快照目录 {}：{}", parent.display(), e))?;
    }

    #[cfg(target_os = "macos")]
    {
        macos_tcc::ensure()?;
        let img = macos_grab_frame(None)?;
        return save_preview_png_atomic(&img, output_path);
    }

    #[cfg(not(target_os = "macos"))]
    {
    let bin = ffmpeg_bin()?;
    let mut cmd = ffmpeg_command(&bin);
    cmd.args(["-hide_banner", "-y"]);

    #[cfg(target_os = "macos")]
    {
        let device = macos_avfoundation_screen_device()?;
        cmd.args(macos_avfoundation_input_args(&device, 1))
            .args(["-frames:v", "1", "-update", "1"])
            .args(["-vf", &scale_filter(1920)])
            .arg(output_path);
    }
    #[cfg(target_os = "windows")]
    {
        cmd.args(["-f", "gdigrab", "-i", "desktop", "-frames:v", "1", "-update", "1"])
            .args(["-vf", &scale_filter(1920)])
            .arg(output_path);
    }
    #[cfg(target_os = "linux")]
    {
        cmd.args([
            "-f", "x11grab", "-video_size", "1920x1080", "-i", ":0.0+0,0", "-frames:v", "1",
            "-update", "1",
        ])
        .args(["-vf", &scale_filter(1920)])
        .arg(output_path);
    }

    let status = cmd
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("启动 ffmpeg 抓屏快照失败：{}（bin={}）", e, bin.display()))?;
    if !status.status.success() {
        return Err(ffmpeg_status_error(
            "ffmpeg 抓屏快照失败",
            &status.status,
            &String::from_utf8_lossy(&status.stderr),
        ));
    }

    let img = image::open(Path::new(output_path))
        .map_err(|e| format!("无法读取快照：{}", e))?;
    let (w, h) = img.dimensions();
    Ok((w, h))
    }
}

/// 启动"实时屏幕预览"：以 3 FPS 把当前桌面不断覆写到同一张 PNG。
/// 前端用 convertFileSrc + cache-bust 即可看到近似实时的画面。
/// 该函数**启动后立即返回**，不会阻塞。
/// 返回 (屏幕宽度, 屏幕高度)，对应被覆写的 PNG 的原始尺寸。
pub fn start_record_preview(png_path: &str) -> Result<(u32, u32), String> {
    if let Some(cell) = PREVIEW_CHILD.get() {
        if let Ok(mut guard) = cell.lock() {
            if let Some(c) = guard.as_mut() {
                let _ = c.kill();
                let _ = c.wait();
            }
            *guard = None;
        }
    }
    PREVIEW_CANCEL.store(true, Ordering::SeqCst);
    thread::sleep(Duration::from_millis(40));
    PREVIEW_CANCEL.store(false, Ordering::SeqCst);

    let (w, h) = capture_preview_png_inner(png_path)?;

    #[cfg(target_os = "macos")]
    {
        let path = png_path.to_string();
        thread::spawn(move || {
            while !PREVIEW_CANCEL.load(Ordering::SeqCst) {
                thread::sleep(Duration::from_millis(330));
                if PREVIEW_CANCEL.load(Ordering::SeqCst) {
                    break;
                }
                if let Ok(img) = macos_grab_frame(None) {
                    let _ = save_preview_png_atomic(&img, &path);
                }
            }
        });
        return Ok((w, h));
    }

    #[cfg(not(target_os = "macos"))]
    {
    ensure_ffmpeg()?;
    let bin = ffmpeg_bin()?;
    let mut cmd = ffmpeg_command(&bin);
    cmd.args(["-hide_banner", "-y"]);
    #[cfg(target_os = "macos")]
    {
        let device = macos_avfoundation_screen_device()?;
        cmd.args(macos_avfoundation_input_args(&device, 3))
            .args(["-vf", &scale_filter(1920)])
            .args(["-update", "1"])
            .arg(png_path);
    }
    #[cfg(target_os = "windows")]
    {
        cmd.args(["-f", "gdigrab", "-i", "desktop"])
            .args(["-vf", &format!("fps=3,{}", scale_filter(1920))])
            .args(["-update", "1"])
            .arg(png_path);
    }
    #[cfg(target_os = "linux")]
    {
        cmd.args([
            "-f", "x11grab", "-video_size", "1920x1080", "-i", ":0.0+0,0",
        ])
        .args(["-vf", &format!("fps=3,{}", scale_filter(1920))])
        .args(["-update", "1"])
        .arg(png_path);
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("启动预览 ffmpeg 失败：{}（bin={}）", e, bin.display()))?;

    let cell = PREVIEW_CHILD.get_or_init(|| Mutex::new(None));
    if let Ok(mut guard) = cell.lock() {
        *guard = Some(child);
    }
    Ok((w, h))
    }
}

/// 主动停止实时预览进程。
pub fn stop_record_preview() {
    PREVIEW_CANCEL.store(true, Ordering::SeqCst);
    if let Some(cell) = PREVIEW_CHILD.get() {
        if let Ok(mut guard) = cell.lock() {
            if let Some(c) = guard.as_mut() {
                let _ = c.kill();
                let _ = c.wait();
            }
            *guard = None;
        }
    }
}
