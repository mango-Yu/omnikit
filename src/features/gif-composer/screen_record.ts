// 录屏转 GIF：完全交给 Rust 端通过 ffmpeg 完成。
//
// 调用 `record_to_gif_cmd` Tauri 命令。
// - macOS：本进程 xcap 连续截屏（会走系统屏幕录制授权）。
// - Windows：gdigrab 抓 desktop。
// - Linux：x11grab 抓 :0.0。
//
// 用户中途点"停止"时调用 `stop_record_cmd` 杀掉 ffmpeg 子进程。

import { invoke } from "@tauri-apps/api/core";

export type ScreenCropRect = { x: number; y: number; w: number; h: number };

export type RecordToGifOptions = {
  outputPath: string;
  fps: number;
  maxSeconds: number;
  /** 长边最大像素 */
  maxLongEdge: number;
  /** 用户框选区域（屏幕物理像素）。null 表示全屏。 */
  cropRect?: ScreenCropRect | null;
};

/**
 * 启动后台录屏并实时编码 GIF。
 * 返回的 Promise 在以下任一情况完成：
 *  1. 达到 `maxSeconds` 时长上限后 ffmpeg 自动结束；
 *  2. 用户调用 `stopRecordGif()` 主动结束；
 *  3. ffmpeg 报错（Promise 拒绝）。
 */
export async function recordToGif(opts: RecordToGifOptions): Promise<void> {
  const region = opts.cropRect
    ? [
        Math.max(0, Math.floor(opts.cropRect.x)),
        Math.max(0, Math.floor(opts.cropRect.y)),
        Math.max(16, Math.floor(opts.cropRect.w)),
        Math.max(16, Math.floor(opts.cropRect.h)),
      ]
    : null;

  await invoke("record_to_gif_cmd", {
    args: {
      outputPath: opts.outputPath,
      fps: opts.fps,
      maxLongEdge: opts.maxLongEdge,
      maxSeconds: opts.maxSeconds,
      region,
    },
  });
}

/** 主动停止当前录屏；之后 `recordToGif()` 返回的 Promise 会以 "录屏已取消" 拒绝。 */
export async function stopRecordGif(): Promise<void> {
  await invoke("stop_record_cmd");
}
