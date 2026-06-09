//! 多图按序合成 GIF：画布取首图尺寸，其余图等比缩放后居中贴在白底上。

use gif::{DisposalMethod, Encoder, Frame, Repeat};
use image::imageops;
use image::{GenericImageView, Rgba, RgbaImage};
use std::fs::File;
use std::path::Path;

const WHITE: Rgba<u8> = Rgba([255, 255, 255, 255]);

fn compose_on_canvas(
    canvas_w: u32,
    canvas_h: u32,
    img: image::DynamicImage,
) -> Result<RgbaImage, String> {
    let resized = img.thumbnail(canvas_w, canvas_h);
    let rgba = resized.to_rgba8();
    let (tw, th) = rgba.dimensions();
    let ox = (canvas_w.saturating_sub(tw)) / 2;
    let oy = (canvas_h.saturating_sub(th)) / 2;

    let mut canvas = RgbaImage::from_pixel(canvas_w, canvas_h, WHITE);
    imageops::overlay(&mut canvas, &rgba, i64::from(ox), i64::from(oy));
    Ok(canvas)
}

/// `delay_ms`：每帧停留毫秒数；GIF 延迟以 1/100 秒为单位。
pub fn create_gif_from_paths(paths: &[String], delay_ms: u32, output_path: &str) -> Result<(), String> {
    if paths.is_empty() {
        return Err("至少需要一张图片".into());
    }

    let first = image::open(Path::new(&paths[0])).map_err(|e| format!("无法读取图片：{}", e))?;
    let (canvas_w, canvas_h) = first.dimensions();
    if canvas_w == 0 || canvas_h == 0 {
        return Err("首张图片尺寸无效".into());
    }

    let delay_cs: u16 = ((delay_ms / 10).max(1)).min(u16::MAX as u32) as u16;

    let file = File::create(Path::new(output_path)).map_err(|e| format!("无法创建输出文件：{}", e))?;
    let mut encoder =
        Encoder::new(file, canvas_w as u16, canvas_h as u16, &[]).map_err(|e| e.to_string())?;
    // 无限循环播放
    encoder.set_repeat(Repeat::Infinite).map_err(|e| e.to_string())?;

    for path in paths {
        let dyn_img = image::open(Path::new(path)).map_err(|e| format!("无法读取 {}：{}", path, e))?;
        let frame_rgba = compose_on_canvas(canvas_w, canvas_h, dyn_img)?;
        let mut pixels = frame_rgba.into_raw();
        let mut frame = Frame::from_rgba_speed(canvas_w as u16, canvas_h as u16, &mut pixels, 10);
        frame.delay = delay_cs;
        frame.dispose = DisposalMethod::Background;
        encoder.write_frame(&frame).map_err(|e| e.to_string())?;
    }

    Ok(())
}
