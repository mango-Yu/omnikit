import { GIFEncoder, applyPalette, quantize } from "gifenc";

/** 与共享画面 videoWidth/videoHeight 对齐的裁剪矩形 */
export type ScreenCropRect = { x: number; y: number; w: number; h: number };

export type ExistingScreenCapture = {
  stream: MediaStream;
  video: HTMLVideoElement;
};

export type ScreenRecordStartOptions = {
  fps: number;
  maxSeconds: number;
  /** 长边最大像素，减轻体积与编码压力 */
  maxLongEdge: number;
  /** 用户框选区域（视频像素）；不传则自动裁黑边 */
  cropRect?: ScreenCropRect;
  /** 已发起的共享流（与框选 UI 配合使用） */
  existingCapture?: ExistingScreenCapture;
  /** 达到时长上限、系统结束共享、采集中异常而结束时回调 */
  onAutoEnd?: (bytes: Uint8Array | null, reason: "stream" | "limit" | "error") => void;
};

function clampCropRect(r: ScreenCropRect, vw: number, vh: number): ScreenCropRect {
  let x = Math.max(0, Math.min(Math.floor(r.x), vw - 1));
  let y = Math.max(0, Math.min(Math.floor(r.y), vh - 1));
  let w = Math.max(16, Math.floor(r.w));
  let h = Math.max(16, Math.floor(r.h));
  if (x + w > vw) w = vw - x;
  if (y + h > vh) h = vh - y;
  if (w < 16 || h < 16) {
    throw new Error("录制区域过小，请重新框选更大的范围。");
  }
  return { x, y, w, h };
}

/** 请求屏幕共享并解码首帧（供框选 UI 使用） */
export async function createScreenCaptureVideo(fps: number): Promise<ExistingScreenCapture> {
  if (!window.isSecureContext) {
    throw new Error(
      "当前页面不是安全上下文（isSecureContext=false），浏览器会禁用屏幕采集。请使用 Tauri 应用或 https://localhost 等安全来源打开。",
    );
  }
  const md = navigator.mediaDevices;
  const gdm = md && typeof md.getDisplayMedia === "function" ? md.getDisplayMedia.bind(md) : null;
  if (!gdm) {
    const hint =
      typeof navigator.platform === "string" && /Mac/i.test(navigator.platform)
        ? "macOS：除「录屏与系统录音」权限外，请在 `src-tauri/Info.plist` 中保留 NSScreenCaptureUsageDescription、NSCameraUsageDescription、NSMicrophoneUsageDescription（WebKit 常需后两项才会挂载 navigator.mediaDevices；若系统询问摄像头/麦克风，可选用「不允许」）。保存后**完全退出**应用再执行 `npm run dev:tauri`。"
        : "Windows：请安装或更新 WebView2 运行时（https://developer.microsoft.com/microsoft-edge/webview2/）；Linux：需较新 WebKitGTK 与桌面门户（如 xdg-desktop-portal）。";
    throw new Error(`当前环境未提供 getDisplayMedia（navigator.mediaDevices=${md ? "存在" : "不存在"}）。${hint}`);
  }

  const stream = await gdm({
    video: {
      frameRate: { ideal: Math.min(30, fps * 2), max: 60 },
    },
    audio: false,
  });

  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  await video.play();

  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error("无法读取屏幕画面尺寸，请重试或更换共享区域。");
  }

  await waitForVideoFrameDecoded(video);
  return { stream, video };
}

export function trimBlackMargins(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  lumThreshold = 14,
): { x: number; y: number; w: number; h: number } | null {
  const lumAt = (xi: number, yi: number) => {
    const o = (yi * width + xi) * 4;
    const r = data[o];
    const g = data[o + 1];
    const b = data[o + 2];
    return 0.299 * r + 0.587 * g + 0.114 * b;
  };
  const rowAllDark = (y: number) => {
    for (let x = 0; x < width; x += 1) {
      if (lumAt(x, y) > lumThreshold) return false;
    }
    return true;
  };
  const colAllDark = (x: number) => {
    for (let y = 0; y < height; y += 1) {
      if (lumAt(x, y) > lumThreshold) return false;
    }
    return true;
  };
  let top = 0;
  let bottom = height - 1;
  let left = 0;
  let right = width - 1;
  while (top <= bottom && rowAllDark(top)) top += 1;
  while (bottom >= top && rowAllDark(bottom)) bottom -= 1;
  while (left <= right && colAllDark(left)) left += 1;
  while (right >= left && colAllDark(right)) right -= 1;
  if (top > bottom || left > right) return null;
  const w = right - left + 1;
  const h = bottom - top + 1;
  if (w < 16 || h < 16) return null;
  return { x: left, y: top, w, h };
}

/** 录屏并按帧写入 GIF（不缓存整段视频的原始像素） */
export class ScreenGifRecorder {
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private gif = GIFEncoder({ initialCapacity: 1024 * 512 });
  private frameCount = 0;
  private w = 0;
  private h = 0;
  private delayMs = 100;
  private maxFrames = 0;
  private active = false;
  /** 防止 stop 轨道同步触发 ended 导致二次收尾 */
  private stopped = false;
  private opts: ScreenRecordStartOptions | null = null;
  private cropX = 0;
  private cropY = 0;
  private cropW = 0;
  private cropH = 0;

  get isRunning(): boolean {
    return this.active;
  }

  get capturedFrames(): number {
    return this.frameCount;
  }

  async start(opts: ScreenRecordStartOptions): Promise<void> {
    if (this.active) return;
    this.opts = opts;

    let stream: MediaStream;
    let video: HTMLVideoElement;
    if (opts.existingCapture) {
      stream = opts.existingCapture.stream;
      video = opts.existingCapture.video;
    } else {
      const cap = await createScreenCaptureVideo(opts.fps);
      stream = cap.stream;
      video = cap.video;
    }

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error("无法读取屏幕画面尺寸，请重试或更换共享区域。");
    }

    await waitForVideoFrameDecoded(video);

    let sx: number;
    let sy: number;
    let sw: number;
    let sh: number;

    if (opts.cropRect) {
      try {
        const c = clampCropRect(opts.cropRect, vw, vh);
        sx = c.x;
        sy = c.y;
        sw = c.w;
        sh = c.h;
      } catch (e) {
        stream.getTracks().forEach((t) => t.stop());
        throw e;
      }
    } else {
      const probe = document.createElement("canvas");
      probe.width = vw;
      probe.height = vh;
      const pctx = probe.getContext("2d", { willReadFrequently: true });
      if (!pctx) {
        stream.getTracks().forEach((t) => t.stop());
        throw new Error("无法创建探测画布。");
      }
      pctx.drawImage(video, 0, 0, vw, vh);
      const probeData = pctx.getImageData(0, 0, vw, vh).data;
      const trimmed = trimBlackMargins(probeData, vw, vh);
      sx = 0;
      sy = 0;
      sw = vw;
      sh = vh;
      if (trimmed) {
        sx = trimmed.x;
        sy = trimmed.y;
        sw = trimmed.w;
        sh = trimmed.h;
      }
    }

    let tw = sw;
    let th = sh;
    const longEdge = Math.max(tw, th);
    if (longEdge > opts.maxLongEdge) {
      const s = opts.maxLongEdge / longEdge;
      tw = Math.max(1, Math.round(tw * s));
      th = Math.max(1, Math.round(th * s));
    }

    const canvas = document.createElement("canvas");
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error("无法创建画布上下文。");
    }

    this.stream = stream;
    this.video = video;
    this.ctx = ctx;
    this.cropX = sx;
    this.cropY = sy;
    this.cropW = sw;
    this.cropH = sh;
    this.w = tw;
    this.h = th;
    this.frameCount = 0;
    this.delayMs = Math.max(20, Math.round(1000 / Math.max(1, opts.fps)));
    this.maxFrames = Math.max(1, Math.ceil(opts.maxSeconds * opts.fps));
    this.gif = GIFEncoder({ initialCapacity: 1024 * 512 });
    this.active = true;
    this.stopped = false;

    const [track] = stream.getVideoTracks();
    track.addEventListener("ended", () => {
      const bytes = this.finishInternal();
      const cb = this.opts?.onAutoEnd;
      this.opts = null;
      cb?.(bytes, "stream");
    });

    this.timer = setInterval(() => {
      this.captureTick();
    }, this.delayMs);
  }

  private captureTick(): void {
    if (!this.active || !this.video || !this.ctx) return;

    if (this.frameCount >= this.maxFrames) {
      const bytes = this.finishInternal();
      const reason = "limit" as const;
      const cb = this.opts?.onAutoEnd;
      this.opts = null;
      cb?.(bytes, reason);
      return;
    }

    try {
      this.ctx.drawImage(this.video, this.cropX, this.cropY, this.cropW, this.cropH, 0, 0, this.w, this.h);
      const { data } = this.ctx.getImageData(0, 0, this.w, this.h);
      const palette = quantize(data, 256);
      const index = applyPalette(data, palette);
      const first = this.frameCount === 0;
      this.gif.writeFrame(index, this.w, this.h, {
        palette,
        delay: this.delayMs,
        ...(first ? { repeat: 0 } : {}),
      });
      this.frameCount += 1;
    } catch {
      const bytes = this.finishInternal();
      const cb = this.opts?.onAutoEnd;
      this.opts = null;
      cb?.(bytes, "error");
    }
  }

  /** 用户点击停止：返回 GIF；无帧则为 null（并取消自动结束回调，避免与 ended 重复弹保存） */
  stopAndBytes(): Uint8Array | null {
    this.opts = null;
    return this.finishInternal();
  }

  /** 放弃本次录制 */
  cancel(): void {
    this.finishInternal(false);
    this.opts = null;
  }

  /**
   * @param encode 为 false 时丢弃已采帧（仅清理资源）
   */
  private finishInternal(encode = true): Uint8Array | null {
    if (this.stopped) return null;
    if (!this.active && !this.stream && !this.timer) {
      return null;
    }
    this.stopped = true;

    this.active = false;
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    this.video = null;
    this.ctx = null;

    const n = this.frameCount;
    this.frameCount = 0;

    if (!encode || n === 0) {
      this.gif = GIFEncoder({ initialCapacity: 4096 });
      return null;
    }

    this.gif.finish();
    const bytes = this.gif.bytes();
    this.gif = GIFEncoder({ initialCapacity: 4096 });
    return bytes;
  }
}

function waitForVideoFrameDecoded(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    const rvfc = (video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (_now: number, _meta: unknown) => void) => number;
    }).requestVideoFrameCallback;
    if (typeof rvfc === "function") {
      rvfc.call(video, () => resolve());
      return;
    }
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

