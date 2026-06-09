import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { readFile, writeFile } from "@tauri-apps/plugin-fs";
import { open, save } from "@tauri-apps/plugin-dialog";

import { createScreenCaptureVideo, ScreenGifRecorder } from "./screen_record";
import { pickRecordingRegion } from "./record_region_picker";
import { createGifFromVideo } from "./video_to_gif";

type Item = { id: string; path: string };

type EditionInfo = {
  pro: boolean;
  maxImages: number | null;
};

export function initGifComposer(root: HTMLElement): void {
const listEl = root.querySelector<HTMLUListElement>("#image-list")!;
const delayInput = root.querySelector<HTMLInputElement>("#delay-ms")!;
const statusEl = root.querySelector<HTMLParagraphElement>("#status")!;
const pickBtn = root.querySelector<HTMLButtonElement>("#pick")!;
const clearBtn = root.querySelector<HTMLButtonElement>("#clear")!;
const exportBtn = root.querySelector<HTMLButtonElement>("#export")!;
const recordPanel = root.querySelector<HTMLElement>("#record-panel")!;
const recordHeading = root.querySelector<HTMLHeadingElement>("#record-heading")!;
const recordIntro = root.querySelector<HTMLParagraphElement>("#record-intro")!;
const recordStartBtn = root.querySelector<HTMLButtonElement>("#record-start")!;
const recordStopBtn = root.querySelector<HTMLButtonElement>("#record-stop")!;
const recordFpsInput = root.querySelector<HTMLInputElement>("#record-fps")!;
const recordMaxSecInput = root.querySelector<HTMLInputElement>("#record-max-sec")!;
const videoPanel = root.querySelector<HTMLElement>("#video-panel")!;
const videoIntro = root.querySelector<HTMLParagraphElement>("#video-intro")!;
const videoPickBtn = root.querySelector<HTMLButtonElement>("#video-pick")!;
const videoFpsInput = root.querySelector<HTMLInputElement>("#video-fps")!;
const videoMaxSecInput = root.querySelector<HTMLInputElement>("#video-max-sec")!;

/** 仅 Tauri WebView 会注入 __TAURI_INTERNALS__；用浏览器单独打开 Vite 端口时插件与 invoke 不可用。 */
const inTauri = isTauri();

const PRO_RECORD_MAX_SEC = 60;
const VIDEO_MAX_SEC = 30;
const VIDEO_EXTENSIONS = ["mp4", "m4v"];
const VIDEO_FORMAT_LABEL = "MP4 / M4V（推荐 H.264 编码）";

function guardTauri(): boolean {
  if (!inTauri) {
    setStatus("当前在普通浏览器中运行，无法调用系统对话框与 Rust 命令。请在项目目录执行：npm run tauri dev", true);
    return false;
  }
  return true;
}

function syncPickButtonState(): void {
  if (!inTauri) return;
  pickBtn.disabled = false;
  pickBtn.removeAttribute("title");
}

let dismissRecordRegionOverlay: (() => void) | null = null;

function clearRecordRegionOverlay(): void {
  dismissRecordRegionOverlay?.();
  dismissRecordRegionOverlay = null;
}

async function loadEdition(): Promise<void> {
  if (!inTauri) {
    // editionBadge.textContent = "";
    recordPanel.hidden = true;
    videoPanel.hidden = true;
    return;
  }
  try {
    await invoke<EditionInfo>("edition_info");
  } catch {
    // 版本查询失败时仍按默认 Pro 能力呈现，避免误回受限状态。
  }
  recordPanel.hidden = false;
  // editionBadge.textContent = "Pro · 张数不限";
  // editionBadge.classList.add("pro");
  recordHeading.textContent = "Pro · 录屏转 GIF";
  recordIntro.textContent =
    "系统共享后可在预览中框选区域与大小。最长 " +
    String(PRO_RECORD_MAX_SEC) +
    " 秒，导出无水印。在系统共享控件中结束共享也会自动停止。";
  recordMaxSecInput.readOnly = false;
  recordMaxSecInput.disabled = false;
  recordMaxSecInput.min = "5";
  recordMaxSecInput.max = String(PRO_RECORD_MAX_SEC);
  recordMaxSecInput.value = String(PRO_RECORD_MAX_SEC);
  videoPanel.hidden = false;
  videoIntro.textContent =
    "选择一段本地视频后自动抽帧并保存为 GIF。视频时长最长 " +
    String(VIDEO_MAX_SEC) +
    ` 秒；当前仅支持 ${VIDEO_FORMAT_LABEL}。`;
  videoMaxSecInput.readOnly = true;
  videoMaxSecInput.disabled = false;
  videoMaxSecInput.value = String(VIDEO_MAX_SEC);
  syncPickButtonState();
  syncRecordControls();
  syncVideoControls();
}

let screenRecorder: ScreenGifRecorder | null = null;
let isVideoConverting = false;

function syncRecordControls(): void {
  const running = screenRecorder?.isRunning ?? false;
  recordStartBtn.disabled = running;
  recordStopBtn.disabled = !running;
  recordFpsInput.disabled = running;
  recordMaxSecInput.disabled = running;
}

function syncVideoControls(): void {
  videoPickBtn.disabled = isVideoConverting;
  videoFpsInput.disabled = isVideoConverting;
  videoMaxSecInput.disabled = isVideoConverting;
}

function isAllowedVideoPath(path: string): boolean {
  const ext = path.split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase();
  return !!ext && VIDEO_EXTENSIONS.includes(ext);
}

type SaveGifOptions = {
  defaultPath?: string;
  cancelMessage?: string;
};

async function saveGifToDisk(bytes: Uint8Array | null, context: string, options: SaveGifOptions = {}): Promise<void> {
  if (!bytes?.length) {
    setStatus(`${context}：没有可保存的画面帧。`, true);
    return;
  }
  const outPath = await save({
    defaultPath: options.defaultPath ?? "screen-record.gif",
    filters: [{ name: "GIF", extensions: ["gif"] }],
  });
  if (!outPath) {
    setStatus(options.cancelMessage ?? "已取消保存录屏 GIF。");
    return;
  }
  setStatus("正在写入文件…");
  try {
    await writeFile(outPath, bytes);
    setStatus(`${context} 已保存：${outPath}`);
  } catch (err) {
    setStatus(String(err), true);
  }
}

let items: Item[] = [];

function uid(): string {
  return crypto.randomUUID();
}

function setStatus(message: string, isError = false): void {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function move(from: number, to: number): void {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) {
    return;
  }
  const next = [...items];
  const [picked] = next.splice(from, 1);
  next.splice(to, 0, picked);
  items = next;
  render();
}

function findCardUnder(clientX: number, clientY: number, skipSource: HTMLElement | null): HTMLElement | null {
  const list = document.elementsFromPoint(clientX, clientY);
  for (const node of list) {
    const el = node as HTMLElement;
    const card = el.closest?.(".card") as HTMLElement | null;
    if (card && card !== skipSource) return card;
  }
  return null;
}

/** Tauri / WKWebView 下 HTML5 Drag&Drop 常不可靠，用指针事件实现排序 */
function bindCardPointerReorder(li: HTMLLIElement): void {
  li.addEventListener("pointerdown", (e: PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;

    e.preventDefault();

    const fromIndex = Number(li.dataset.index);
    if (Number.isNaN(fromIndex)) return;

    const pointerId = e.pointerId;
    li.classList.add("dragging-source");

    const clearTargetHighlight = (): void => {
      root.querySelectorAll(".card.drag-target").forEach((c) => c.classList.remove("drag-target"));
    };

    const onMove = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return;
      clearTargetHighlight();
      const targetCard = findCardUnder(ev.clientX, ev.clientY, li);
      if (!targetCard) return;
      const ti = Number(targetCard.dataset.index);
      if (!Number.isNaN(ti) && ti !== fromIndex) targetCard.classList.add("drag-target");
    };

    const finish = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", finish, true);
      window.removeEventListener("pointercancel", finish, true);
      li.classList.remove("dragging-source");
      clearTargetHighlight();

      const targetCard = findCardUnder(ev.clientX, ev.clientY, li);
      if (!targetCard) return;
      const to = Number(targetCard.dataset.index);
      if (!Number.isNaN(to) && to !== fromIndex) move(fromIndex, to);
    };

    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", finish, true);
    window.addEventListener("pointercancel", finish, true);
  });
}

function render(): void {
  listEl.innerHTML = "";

  items.forEach((item, index) => {
    const li = document.createElement("li");
    li.className = "card";
    li.dataset.index = String(index);

    const thumb = document.createElement("img");
    thumb.alt = `第 ${index + 1} 帧预览`;
    thumb.draggable = false;
    thumb.src = inTauri ? convertFileSrc(item.path) : "";

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `第 ${index + 1} 帧 · 按住卡片拖动排序`;

    const actions = document.createElement("div");
    actions.className = "row";

    const up = document.createElement("button");
    up.type = "button";
    up.textContent = "上移";
    up.disabled = index === 0;
    up.addEventListener("click", () => move(index, index - 1));

    const down = document.createElement("button");
    down.type = "button";
    down.textContent = "下移";
    down.disabled = index === items.length - 1;
    down.addEventListener("click", () => move(index, index + 1));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "移除";
    remove.className = "danger";
    remove.addEventListener("click", () => {
      items.splice(index, 1);
      render();
    });

    actions.append(up, down, remove);
    li.append(thumb, meta, actions);

    bindCardPointerReorder(li);

    listEl.appendChild(li);
  });
  syncPickButtonState();
}

pickBtn.addEventListener("click", async () => {
  if (!guardTauri()) return;
  const selected = await open({
    multiple: true,
    filters: [
      {
        name: "图片",
        extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"],
      },
    ],
  });
  if (!selected) return;

  const paths = Array.isArray(selected) ? selected : [selected];
  for (const p of paths) {
    items.push({ id: uid(), path: p });
  }
  render();
  setStatus(`本次添加 ${paths.length} 张，列表共 ${items.length} 张。`);
});

clearBtn.addEventListener("click", () => {
  items = [];
  render();
  setStatus("列表已清空。");
});

exportBtn.addEventListener("click", async () => {
  if (!guardTauri()) return;
  if (!items.length) {
    setStatus("请先添加至少一张图片。", true);
    return;
  }

  const delay = Math.max(20, Number(delayInput.value) || 200);
  const outputPath = await save({
    defaultPath: "animation.gif",
    filters: [{ name: "GIF", extensions: ["gif"] }],
  });

  if (!outputPath) {
    setStatus("已取消保存。");
    return;
  }

  setStatus("正在生成 GIF…");
  try {
    await invoke("create_gif", {
      paths: items.map((i) => i.path),
      delayMs: delay,
      outputPath,
    });
    setStatus(`已保存：${outputPath}`);
  } catch (err) {
    setStatus(String(err), true);
  }
});

recordStartBtn.addEventListener("click", async () => {
  if (!guardTauri()) return;
  if (screenRecorder?.isRunning) return;

  const fps = Math.min(24, Math.max(1, Number(recordFpsInput.value) || 8));
  const maxSeconds = Math.min(PRO_RECORD_MAX_SEC, Math.max(5, Number(recordMaxSecInput.value) || PRO_RECORD_MAX_SEC));

  recordStartBtn.disabled = true;
  recordFpsInput.disabled = true;
  recordMaxSecInput.disabled = true;
  setStatus("正在请求屏幕共享…");

  let capture: Awaited<ReturnType<typeof createScreenCaptureVideo>> | null = null;
  try {
    capture = await createScreenCaptureVideo(fps);
  } catch (err) {
    recordStartBtn.disabled = false;
    recordFpsInput.disabled = false;
    recordMaxSecInput.disabled = false;
    setStatus(String(err), true);
    return;
  }

  setStatus("在预览中框选要录入 GIF 的范围，或点「整幅画面」后「开始录制」。");
  const pick = await pickRecordingRegion(capture.video);
  if (!pick) {
    capture.stream.getTracks().forEach((t) => t.stop());
    recordStartBtn.disabled = false;
    recordFpsInput.disabled = false;
    recordMaxSecInput.disabled = false;
    setStatus("已取消录屏。");
    return;
  }

  dismissRecordRegionOverlay = pick.dismissOverlay;
  pick.onStopRequested(() => {
    recordStopBtn.click();
  });
  const cropRect = pick.crop;

  screenRecorder = new ScreenGifRecorder();
  try {
    await screenRecorder.start({
      fps,
      maxSeconds,
      maxLongEdge: 960,
      cropRect,
      existingCapture: capture,
      onAutoEnd: async (bytes, reason) => {
        clearRecordRegionOverlay();
        screenRecorder = null;
        syncRecordControls();
        if (!bytes?.length) {
          if (reason === "error") setStatus("录屏采集过程出现异常。", true);
          else if (reason === "stream") setStatus("屏幕共享已结束（若尚未保存，可能没有有效画面）。");
          else setStatus("未达到可保存的帧数。");
          return;
        }
        const label =
          reason === "limit" ? "已达时长上限" : reason === "stream" ? "共享已结束" : "采集结束";
        await saveGifToDisk(bytes, label);
      },
    });
    syncRecordControls();
    setStatus("正在录屏… 完成后点「停止并保存 GIF」，或在系统中结束共享。");
  } catch (err) {
    clearRecordRegionOverlay();
    screenRecorder = null;
    capture.stream.getTracks().forEach((t) => t.stop());
    syncRecordControls();
    setStatus(String(err), true);
  }
});

recordStopBtn.addEventListener("click", async () => {
  if (!guardTauri()) return;
  const rec = screenRecorder;
  if (!rec?.isRunning) return;

  clearRecordRegionOverlay();
  setStatus("正在编码 GIF…");
  const bytes = rec.stopAndBytes();
  screenRecorder = null;
  syncRecordControls();
  await saveGifToDisk(bytes, "录屏");
});

videoPickBtn.addEventListener("click", async () => {
  if (!guardTauri()) return;
  if (isVideoConverting) return;

  const selected = await open({
    multiple: false,
    filters: [
      {
        name: VIDEO_FORMAT_LABEL,
        extensions: VIDEO_EXTENSIONS,
      },
    ],
  });
  if (!selected || Array.isArray(selected)) return;
  if (!isAllowedVideoPath(selected)) {
    setStatus(`当前仅支持 ${VIDEO_FORMAT_LABEL} 视频。`, true);
    return;
  }

  const fps = Math.min(24, Math.max(1, Number(videoFpsInput.value) || 8));
  isVideoConverting = true;
  syncVideoControls();
  setStatus("正在读取视频并生成 GIF…");

  let videoObjectUrl: string | null = null;
  try {
    // convertFileSrc 在 Windows WebView2 下常与页面不同源，drawImage + getImageData 会污染画布；
    // 读入内存后使用 blob URL 与页面同源，可正常抽帧。
    const fileBytes = await readFile(selected);
    const blob = new Blob([fileBytes], { type: "video/mp4" });
    videoObjectUrl = URL.createObjectURL(blob);
    const bytes = await createGifFromVideo({
      videoSrc: videoObjectUrl,
      fps,
      maxSeconds: VIDEO_MAX_SEC,
      maxLongEdge: 960,
      onProgress: (done, total) => {
        setStatus(`正在转换视频… ${done}/${total} 帧`);
      },
    });
    await saveGifToDisk(bytes, "视频 GIF", {
      defaultPath: "video.gif",
      cancelMessage: "已取消保存视频 GIF。",
    });
  } catch (err) {
    setStatus(String(err), true);
  } finally {
    if (videoObjectUrl) URL.revokeObjectURL(videoObjectUrl);
    isVideoConverting = false;
    syncVideoControls();
  }
});

render();
if (!inTauri) {
  pickBtn.disabled = true;
  exportBtn.disabled = true;
  delayInput.disabled = true;
  // editionBadge.textContent = "";
  recordPanel.hidden = true;
  recordStartBtn.disabled = true;
  recordStopBtn.disabled = true;
  recordFpsInput.disabled = true;
  recordMaxSecInput.disabled = true;
  videoPanel.hidden = true;
  videoPickBtn.disabled = true;
  videoFpsInput.disabled = true;
  videoMaxSecInput.disabled = true;
  setStatus("当前在普通浏览器中运行，无法调用系统对话框与 Rust 命令。请使用：npm run tauri dev（会打开带壳窗口，不要只用浏览器访问 localhost）。", true);
} else {
  void loadEdition().then(() => {
    setStatus("点击「选择图片」开始，可拖拽缩略图调整顺序。");
  });
}
}
