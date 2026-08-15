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
use image::GenericImageView;
use once_cell::sync::OnceCell;
use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

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

    let output = Command::new(path)
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

/// 把 raw RGB 帧数据写入已初始化好的 GIF encoder。
fn write_rgb_frame(
    encoder: &mut Encoder<File>,
    width: u16,
    height: u16,
    rgb: &[u8],
    delay_cs: u16,
) -> Result<(), String> {
    // RGB -> RGBA
    let mut rgba = Vec::with_capacity(rgb.len() / 3 * 4);
    for px in rgb.chunks_exact(3) {
        rgba.push(px[0]);
        rgba.push(px[1]);
        rgba.push(px[2]);
        rgba.push(255);
    }
    let mut frame = Frame::from_rgba_speed(width, height, &mut rgba, 10);
    frame.delay = delay_cs;
    frame.dispose = DisposalMethod::Background;
    encoder
        .write_frame(&frame)
        .map_err(|e| format!("写入 GIF 帧失败：{}", e))
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
        let mut cmd = Command::new(bin);
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
        let status = Command::new(&bin)
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

    let delay_cs: u16 = ((1000 / fps) / 10).max(1) as u16;
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
    ensure_ffmpeg()?;
    let bin = ffmpeg_bin()?;

    let fps = fps.clamp(1, 30);
    let max_long_edge = max_long_edge.clamp(64, 4096);
    let max_seconds = max_seconds.clamp(1, 120);
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

    let mut probe_cmd = Command::new(&bin);
    probe_cmd.args(["-hide_banner", "-y"]);
    configure_record_input_std(&mut probe_cmd, fps, max_long_edge, max_seconds, region);
    probe_cmd
        .args(["-frames:v", "1", "-update", "1"])
        .arg(&probe_path);
    let probe_status = probe_cmd
        .status()
        .map_err(|e| format!("启动 ffmpeg 录屏探测失败：{}（bin={}）", e, bin.display()))?;
    if !probe_status.success() {
        return Err(format!(
            "ffmpeg 录屏探测失败（exit={:?}）",
            probe_status.code()
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
    let mut cmd = Command::new(&bin);
    cmd.args(["-hide_banner", "-y"]);
    configure_record_input_std(&mut cmd, fps, max_long_edge, max_seconds, region);
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
            if line.starts_with("[error]") || line.starts_with("[fatal]") {
                log::error!("[ffmpeg record] {}", line);
                stderr_failed_clone.store(true, Ordering::SeqCst);
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
    let delay_cs: u16 = ((1000 / fps) / 10).max(1) as u16;
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
            return Err("录屏已取消".into());
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

/// 为不同平台注入录屏输入参数（macOS / Windows / Linux），写入 std::process::Command。
fn configure_record_input_std(
    cmd: &mut Command,
    fps: u32,
    max_long_edge: u32,
    max_seconds: u32,
    region: Option<(u32, u32, u32, u32)>,
) {
    #[cfg(target_os = "macos")]
    {
        // avfoundation: "-i <screen_index>:" 0=摄像头，1=屏幕
        let device = "1:".to_string();
        if let Some((x, y, w, h)) = region {
            cmd.args(["-f", "avfoundation", "-i", &device])
                .args([
                    "-vf",
                    &format!(
                        "crop={}:{}:{}:{},fps={},{}",
                        w, h, x, y, fps, scale_filter(max_long_edge)
                    ),
                ])
                .args(["-t", &max_seconds.to_string()]);
        } else {
            cmd.args(["-f", "avfoundation", "-i", &device])
                .args(["-vf", &format!("fps={},{}", fps, scale_filter(max_long_edge))])
                .args(["-t", &max_seconds.to_string()]);
        }
    }
    #[cfg(target_os = "windows")]
    {
        let input = "desktop".to_string();
        if let Some((x, y, w, h)) = region {
            cmd.args([
                "-f", "gdigrab", "-framerate", &fps.to_string(), "-offset_x", &x.to_string(),
                "-offset_y", &y.to_string(), "-video_size", &format!("{}x{}", w, h), "-i", &input,
            ])
            .args(["-t", &max_seconds.to_string()])
            .args(["-vf", &scale_filter(max_long_edge)]);
        } else {
            cmd.args(["-f", "gdigrab", "-framerate", &fps.to_string(), "-i", &input])
                .args(["-t", &max_seconds.to_string()])
                .args(["-vf", &format!("fps={},{}", fps, scale_filter(max_long_edge))]);
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
        .args(["-t", &max_seconds.to_string()])
        .args(["-vf", &format!("fps={},{}", fps, scale_filter(max_long_edge))]);
    }
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

/// 抓一帧屏幕快照，保存为 PNG，返回 (width, height)。
fn capture_preview_png_inner(output_path: &str) -> Result<(u32, u32), String> {
    let bin = ffmpeg_bin()?;
    // 目标目录可能不存在（前端只拼了路径），先建好再让 ffmpeg 写
    if let Some(parent) = Path::new(output_path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建快照目录 {}：{}", parent.display(), e))?;
    }
    let mut cmd = Command::new(&bin);
    cmd.args(["-hide_banner", "-y"]);

    #[cfg(target_os = "macos")]
    {
        cmd.args(["-f", "avfoundation", "-i", "1:", "-frames:v", "1", "-update", "1"])
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
        .status()
        .map_err(|e| format!("启动 ffmpeg 抓屏快照失败：{}（bin={}）", e, bin.display()))?;
    if !status.success() {
        return Err(format!(
            "ffmpeg 抓屏快照失败（exit={:?}）",
            status.code()
        ));
    }

    let img = image::open(Path::new(output_path))
        .map_err(|e| format!("无法读取快照：{}", e))?;
    let (w, h) = img.dimensions();
    Ok((w, h))
}

/// 启动"实时屏幕预览"：以 3 FPS 把当前桌面不断覆写到同一张 PNG。
/// 前端用 convertFileSrc + cache-bust 即可看到近似实时的画面。
/// 该函数**启动后立即返回**，不会阻塞。
/// 返回 (屏幕宽度, 屏幕高度)，对应被覆写的 PNG 的原始尺寸。
pub fn start_record_preview(png_path: &str) -> Result<(u32, u32), String> {
    ensure_ffmpeg()?;
    // 若已有实例在跑，先杀掉
    if let Some(cell) = PREVIEW_CHILD.get() {
        if let Ok(mut guard) = cell.lock() {
            if let Some(c) = guard.as_mut() {
                let _ = c.kill();
                let _ = c.wait();
            }
            *guard = None;
        }
    }
    PREVIEW_CANCEL.store(false, Ordering::SeqCst);

    // 先快速抓一帧，确保前端能立刻看到画面
    let (w, h) = capture_preview_png_inner(png_path)?;

    // 再启动持续覆写进程：3 FPS，updateflag=1 表示一直覆写同一文件
    let bin = ffmpeg_bin()?;
    let mut cmd = Command::new(&bin);
    cmd.args(["-hide_banner", "-y"]);
    #[cfg(target_os = "macos")]
    {
        cmd.args(["-f", "avfoundation", "-i", "1:"])
            .args(["-vf", &format!("fps=3,{}", scale_filter(1920))])
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
