// 视频转 GIF：完全交给 Rust 端通过 ffmpeg 完成。
//
// 调用 `video_to_gif_cmd` Tauri 命令，参数为：
//   {
//     inputPath: string,
//     outputPath: string,
//     fps: number,
//     maxLongEdge: number,
//     maxSeconds: number,
//   }
//
// 进度通过返回的 Promise 在完成时一次性感知；若需要实时进度，可以让后端 emit 事件。
// 当前实现以前端"开始转码 → 等到结束"为主，状态文字由调用方更新。

import { invoke } from "@tauri-apps/api/core";

export type VideoGifOptions = {
  /** 本地视频文件绝对路径 */
  inputPath: string;
  /** 目标 GIF 文件绝对路径 */
  outputPath: string;
  /** 抽帧 FPS */
  fps: number;
  /** 时长上限（秒） */
  maxSeconds: number;
  /** 视频长边最大像素 */
  maxLongEdge: number;
};

/**
 * 调用 Rust 端 video_to_gif_cmd。
 * 进度回调（done, total）在每一帧被写入 GIF 后触发一次。
 */
export async function createGifFromVideo(options: VideoGifOptions): Promise<void> {
  await invoke("video_to_gif_cmd", {
    args: {
      inputPath: options.inputPath,
      outputPath: options.outputPath,
      fps: options.fps,
      maxLongEdge: options.maxLongEdge,
      maxSeconds: options.maxSeconds,
    },
  });
}
