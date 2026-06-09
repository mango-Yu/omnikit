import { GIFEncoder, applyPalette, quantize } from "gifenc";

export type VideoGifOptions = {
  videoSrc: string;
  fps: number;
  maxSeconds: number;
  maxLongEdge: number;
  onProgress?: (done: number, total: number) => void;
};

function waitForEvent<T extends keyof HTMLMediaElementEventMap>(
  el: HTMLMediaElement,
  eventName: T,
): Promise<HTMLMediaElementEventMap[T]> {
  return new Promise((resolve, reject) => {
    const onEvent = (event: HTMLMediaElementEventMap[T]): void => {
      cleanup();
      resolve(event);
    };
    const onError = (): void => {
      cleanup();
      reject(new Error("无法解码该视频文件，请换一个系统支持的视频格式。"));
    };
    const cleanup = (): void => {
      el.removeEventListener(eventName, onEvent as EventListener);
      el.removeEventListener("error", onError);
    };

    el.addEventListener(eventName, onEvent as EventListener, { once: true });
    el.addEventListener("error", onError, { once: true });
  });
}

function waitForVideoFrameDecoded(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    const fallback = window.setTimeout(() => resolve(), 500);
    const rvfc = (video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (_now: number, _meta: unknown) => void) => number;
    }).requestVideoFrameCallback;
    if (typeof rvfc === "function") {
      rvfc.call(video, () => {
        window.clearTimeout(fallback);
        resolve();
      });
      return;
    }
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        window.clearTimeout(fallback);
        resolve();
      }),
    );
  });
}

function waitForSeekComplete(video: HTMLVideoElement, targetTime: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let done = false;

    const finish = (): void => {
      if (done) return;
      done = true;
      cleanup();
      resolve();
    };
    const fail = (): void => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error("视频抽帧超时，请换一个更常见的 MP4/H.264 视频。"));
    };
    const isReady = (): boolean => {
      return !video.seeking && Math.abs(video.currentTime - targetTime) < 0.25 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
    };
    const check = (): void => {
      if (isReady()) {
        finish();
        return;
      }
      if (Date.now() - startedAt > 5000) {
        fail();
      }
    };
    const interval = window.setInterval(check, 50);
    const timeout = window.setTimeout(fail, 5500);
    const cleanup = (): void => {
      window.clearInterval(interval);
      window.clearTimeout(timeout);
      video.removeEventListener("seeked", check);
      video.removeEventListener("loadeddata", check);
      video.removeEventListener("timeupdate", check);
      video.removeEventListener("error", fail);
    };

    video.addEventListener("seeked", check);
    video.addEventListener("loadeddata", check);
    video.addEventListener("timeupdate", check);
    video.addEventListener("error", fail);
    check();
  });
}

async function seekVideo(video: HTMLVideoElement, time: number): Promise<void> {
  if (Math.abs(video.currentTime - time) < 0.001) {
    await waitForVideoFrameDecoded(video);
    return;
  }

  video.currentTime = time;
  await waitForSeekComplete(video, time);
  await waitForVideoFrameDecoded(video);
}

export async function createGifFromVideo(options: VideoGifOptions): Promise<Uint8Array> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";

  try {
    const metadataLoaded = waitForEvent(video, "loadedmetadata");
    const firstFrameLoaded = waitForEvent(video, "loadeddata");
    video.src = options.videoSrc;
    video.load();
    await metadataLoaded;
    await firstFrameLoaded;

    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error("无法读取视频时长，请换一个本地视频文件。");
    }
    if (duration > options.maxSeconds + 0.05) {
      throw new Error(`视频时长为 ${duration.toFixed(1)} 秒，最长只能转换 ${options.maxSeconds} 秒。`);
    }

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) {
      throw new Error("无法读取视频画面尺寸，请换一个系统支持的视频格式。");
    }

    let tw = vw;
    let th = vh;
    const longEdge = Math.max(tw, th);
    if (longEdge > options.maxLongEdge) {
      const scale = options.maxLongEdge / longEdge;
      tw = Math.max(1, Math.round(tw * scale));
      th = Math.max(1, Math.round(th * scale));
    }

    const canvas = document.createElement("canvas");
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      throw new Error("无法创建画布上下文。");
    }

    const fps = Math.max(1, options.fps);
    const delayMs = Math.max(20, Math.round(1000 / fps));
    const totalFrames = Math.max(1, Math.ceil(duration * fps));
    const gif = GIFEncoder({ initialCapacity: 1024 * 512 });

    for (let i = 0; i < totalFrames; i += 1) {
      const frameTime = Math.min(i / fps, Math.max(0, duration - 0.001));
      await seekVideo(video, frameTime);
      ctx.drawImage(video, 0, 0, vw, vh, 0, 0, tw, th);
      const { data } = ctx.getImageData(0, 0, tw, th);
      const palette = quantize(data, 256);
      const index = applyPalette(data, palette);
      gif.writeFrame(index, tw, th, {
        palette,
        delay: delayMs,
        ...(i === 0 ? { repeat: 0 } : {}),
      });
      options.onProgress?.(i + 1, totalFrames);
    }

    gif.finish();
    return gif.bytes();
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}
