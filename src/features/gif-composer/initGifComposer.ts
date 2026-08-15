import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { appDataDir, join } from "@tauri-apps/api/path";

import { recordToGif, stopRecordGif, ScreenCropRect } from "./screen_record";
import { createGifFromVideo } from "./video_to_gif";
import { pickRecordTarget, showRecordFloater } from "./record_target_picker";

type Item = { id: string; path: string };

type EditionInfo = {
  pro: boolean;
  maxImages: number | null;
};

export function initGifComposer(root: HTMLElement): void {
  // React StrictMode（dev）会把 useEffect 跑两遍，避免重复绑定事件监听
  if (root.dataset.gifComposerInit === "1") return;
  root.dataset.gifComposerInit = "1";
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
const VIDEO_MAX_SEC = 60;
const VIDEO_EXTENSIONS = [
  "mp4", "m4v", "mov", "avi", "mkv", "webm", "flv", "wmv", "mpg", "mpeg", "ts", "m2ts", "3gp", "ogv",
];
const VIDEO_FORMAT_LABEL = "常见视频格式（MP4 / MOV / AVI / MKV / WebM 等，FFmpeg 自动解码）";

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
    "通过 FFmpeg 抓屏（macOS avfoundation / Windows gdigrab / Linux x11grab）。最长 " +
    String(PRO_RECORD_MAX_SEC) +
    " 秒，导出无水印。先抓一张全屏快照，用户在快照上框选区域后开始录制。";
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
  videoMaxSecInput.max = String(VIDEO_MAX_SEC);
  syncPickButtonState();
  syncRecordControls();
  syncVideoControls();

  // 监听 Rust 端发来的实时进度事件
  setupProgressListeners();
}

let activeRecordRunId = 0;
let isVideoConverting = false;
let progressBarEl: HTMLElement | null = null;
let progressBarFillEl: HTMLElement | null = null;

function setProgress(done: number, total: number, show: boolean): void {
  if (!progressBarEl || !progressBarFillEl) {
    progressBarEl = document.getElementById("progress-bar");
    progressBarFillEl = document.getElementById("progress-bar-fill");
  }
  if (!progressBarEl || !progressBarFillEl) return;
  progressBarEl.style.display = show ? "block" : "none";
  if (!show) {
    progressBarFillEl.style.width = "0%";
    return;
  }
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  progressBarFillEl.style.width = `${pct}%`;
}

function setupProgressListeners(): void {
  if (!isTauri()) return;
  void listen<{ done: number; total: number; finished?: boolean }>(
    "video-to-gif-progress",
    (e) => {
      if (e.payload.finished) {
        setProgress(0, 0, false);
        return;
      }
      setProgress(e.payload.done, e.payload.total, e.payload.total > 0);
      if (e.payload.total > 0) {
        setStatus(`正在用 FFmpeg 抽帧… ${e.payload.done}/${e.payload.total}`);
      }
    },
  );

  void listen<{ done: number; total: number; finished?: boolean }>(
    "record-progress",
    (e) => {
      if (e.payload.finished) {
        setProgress(0, 0, false);
        return;
      }
      setProgress(e.payload.done, e.payload.total, e.payload.total > 0);
      if (e.payload.total > 0) {
        setStatus(`正在录屏并编码 GIF… ${e.payload.done}/${e.payload.total} 帧`);
      }
    },
  );
}

function syncRecordControls(): void {
  const running = activeRecordRunId > 0;
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
  if (activeRecordRunId > 0) return;

  const fps = Math.min(24, Math.max(1, Number(recordFpsInput.value) || 8));
  const maxSeconds = Math.min(PRO_RECORD_MAX_SEC, Math.max(5, Number(recordMaxSecInput.value) || PRO_RECORD_MAX_SEC));

  recordStartBtn.disabled = true;
  recordFpsInput.disabled = true;
  recordMaxSecInput.disabled = true;

  // 1) 让用户选「整屏 / 选窗口 / 手动框选」并确定区域
  setStatus("选择录制范围（整屏 / 选窗口 / 手动框选）…");
  const target = await pickRecordTarget();
  if (!target) {
    recordStartBtn.disabled = false;
    recordFpsInput.disabled = false;
    recordMaxSecInput.disabled = false;
    setStatus("已取消录屏。");
    return;
  }

  // 2) 立即把 ffmpeg 录到临时路径，停止时再让用户选保存位置
  let tempPath: string;
  try {
    const dir = await appDataDir();
    const tmpDir = await join(dir, "tmp");
    const filename = `screen-record-${Date.now()}.gif`;
    tempPath = await join(tmpDir, filename);
  } catch (err) {
    target.dismissOverlay?.();
    recordStartBtn.disabled = false;
    recordFpsInput.disabled = false;
    recordMaxSecInput.disabled = false;
    setStatus(`无法获取临时目录：${String(err)}`, true);
    return;
  }

  const runId = Date.now();
  activeRecordRunId = runId;
  syncRecordControls();
  if (target.dismissOverlay) {
    dismissRecordRegionOverlay = target.dismissOverlay;
  }
  target.onStopRequested?.(() => {
    if (activeRecordRunId === runId) recordStopBtn.click();
  });

  // 整屏 / 选窗口 模式没有 picker overlay，必须用浮层告诉用户"正在录屏"+ 给个停止入口。
  // region 模式 picker panel 自带停止按钮，这里也挂一份浮层做兜底（双保险）。
  const hideFloater = showRecordFloater(target.label, () => {
    if (activeRecordRunId === runId) recordStopBtn.click();
  });

  setStatus(`正在录屏（${target.label}）… 录完点「停止」会弹保存框。`);
  const cropRect: ScreenCropRect = target.rect;

  try {
    await recordToGif({
      outputPath: tempPath,
      fps,
      maxSeconds,
      maxLongEdge: 960,
      cropRect,
    });
    // recordToGif 自身会等到 ffmpeg 结束（用户点 stop）。到这一步说明已停止。
    if (activeRecordRunId === runId) {
      // 询问保存位置
      const dest = await save({
        defaultPath: "screen-record.gif",
        filters: [{ name: "GIF", extensions: ["gif"] }],
      });
      activeRecordRunId = 0;
      clearRecordRegionOverlay();
      syncRecordControls();
      if (!dest) {
        // 用户取消保存：删除临时文件
        try {
          await invoke("delete_gif_file_cmd", { path: tempPath });
        } catch {
          /* ignore */
        }
        setStatus("已取消保存录屏 GIF。");
        return;
      }
      try {
        await invoke("move_gif_file_cmd", { src: tempPath, dest });
        setStatus(`录屏 GIF 已保存：${dest}`);
      } catch (err) {
        setStatus(`录屏 GIF 保存失败：${String(err)}，临时文件仍在：${tempPath}`, true);
      }
    }
  } catch (err) {
    if (activeRecordRunId === runId) {
      activeRecordRunId = 0;
      clearRecordRegionOverlay();
      syncRecordControls();
      // 失败时也清理临时文件
      try {
        await invoke("delete_gif_file_cmd", { path: tempPath });
      } catch {
        /* ignore */
      }
      setStatus(String(err), true);
    }
  } finally {
    hideFloater();
  }
});

recordStopBtn.addEventListener("click", async () => {
  if (!guardTauri()) return;
  if (activeRecordRunId === 0) return;
  try {
    setStatus("正在停止录屏…");
    await stopRecordGif();
  } catch (err) {
    setStatus(String(err), true);
  }
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
  const outPath = await save({
    defaultPath: "video.gif",
    filters: [{ name: "GIF", extensions: ["gif"] }],
  });
  if (!outPath) {
    setStatus("已取消保存视频 GIF。");
    return;
  }

  isVideoConverting = true;
  syncVideoControls();
  setProgress(0, 1, true);
  setStatus("正在用 FFmpeg 抽帧并生成 GIF…");

  try {
    await createGifFromVideo({
      inputPath: selected,
      outputPath: outPath,
      fps,
      maxSeconds: VIDEO_MAX_SEC,
      maxLongEdge: 960,
    });
    setProgress(0, 0, false);
    setStatus(`视频 GIF 已保存：${outPath}`);
  } catch (err) {
    setProgress(0, 0, false);
    setStatus(String(err), true);
  } finally {
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
