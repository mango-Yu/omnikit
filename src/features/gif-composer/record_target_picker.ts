// 录屏目标选择：让用户在主 webview 内通过模态对话框选择
//  - 整屏（用主显示器尺寸作为 region）
//  - 选择窗口（从 xcap 枚举的窗口里点一个）
//  - 手动框选（交给 pickRecordingRegion，浏览器全屏覆盖）
// 取消时返回 null。

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";
import { pickRecordingRegion } from "./record_region_picker";

export type RecordTargetRect = { x: number; y: number; w: number; h: number };
export type RecordTargetSource = "screen" | "window" | "region";

export type RecordTargetResult = {
  rect: RecordTargetRect;
  source: RecordTargetSource;
  /** 录制过程中的状态面板（仅 region 模式需要），结束时必须调用 */
  dismissOverlay?: () => void;
  /** 用户在状态面板里点"停止"时通知 main */
  onStopRequested?: (cb: () => void) => void;
  /** 录屏时显示给用户的来源描述 */
  label: string;
};

type WindowInfo = {
  id: number;
  title: string;
  appName: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isMinimized: boolean;
};

type ScreenInfo = {
  width: number;
  height: number;
  x: number;
  y: number;
  scaleFactor: number;
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts: { className?: string; text?: string; html?: string } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (opts.className) node.className = opts.className;
  if (opts.text !== undefined) node.textContent = opts.text;
  if (opts.html !== undefined) node.innerHTML = opts.html;
  return node;
}

function findModalRoot(): HTMLElement {
  // 优先挂在 .gif-composer-root 下，CSS 变量（--surface / --text ...）能继承到 modal
  const root = document.querySelector<HTMLElement>(".gif-composer-root");
  return root ?? document.body;
}

function buildBackdrop(): {
  backdrop: HTMLDivElement;
  panel: HTMLDivElement;
  close: () => void;
} {
  const host = findModalRoot();
  const backdrop = el("div", { className: "record-target-backdrop" });
  const panel = el("div", { className: "record-target-panel" });
  backdrop.appendChild(panel);
  host.appendChild(backdrop);

  const close = (): void => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  return { backdrop, panel, close };
}

type Mode = "screen" | "window" | "region";

async function showModeDialog(): Promise<Mode | null> {
  return new Promise<Mode | null>((resolve) => {
    const { panel, close } = buildBackdrop();
    let done = false;
    const finish = (m: Mode | null): void => {
      if (done) return;
      done = true;
      close();
      resolve(m);
    };
    const title = el("h2", {
      className: "record-target-title",
      text: "选择录制范围",
    });
    const sub = el("p", {
      className: "record-target-sub",
      text: "整屏会录制主显示器；选窗口可挑一个具体应用；手动框选可拖框选任意区域。",
    });

    const cards = el("div", { className: "record-target-cards" });
    const makeCard = (
      m: Mode,
      icon: string,
      head: string,
      desc: string,
    ): HTMLButtonElement => {
      const btn = el("button", { className: "record-target-card" });
      btn.type = "button";
      btn.append(
        el("div", { className: "record-target-card-icon", text: icon }),
        el("div", { className: "record-target-card-head", text: head }),
        el("div", { className: "record-target-card-desc", text: desc }),
      );
      btn.addEventListener("click", () => finish(m));
      return btn;
    };

    cards.append(
      makeCard("screen", "▣", "整屏录制", "录制主显示器（多屏时仅主屏）"),
      makeCard(
        "window",
        "▭",
        "选择窗口",
        "列出当前可见窗口，点选要录制的那一个",
      ),
      makeCard(
        "region",
        "✂",
        "手动框选",
        "进入全屏，拖出绿框自定义范围",
      ),
    );

    const footer = el("div", { className: "record-target-footer" });
    const cancel = el("button", {
      className: "record-target-btn ghost",
      text: "取消",
    });
    cancel.type = "button";
    cancel.addEventListener("click", () => finish(null));
    footer.appendChild(cancel);

    panel.append(title, sub, cards, footer);
  });
}

async function pickWindow(): Promise<WindowInfo | null> {
  // 拿主屏 + 窗口列表
  let wins: WindowInfo[];
  try {
    wins = await invoke<WindowInfo[]>("list_recordable_windows_cmd");
  } catch (err) {
    window.alert(`无法列出窗口：${String(err)}`);
    return null;
  }

  return new Promise<WindowInfo | null>((resolve) => {
    const { panel, close } = buildBackdrop();
    let done = false;
    const finish = (w: WindowInfo | null): void => {
      if (done) return;
      done = true;
      close();
      resolve(w);
    };

    const title = el("h2", {
      className: "record-target-title",
      text: "选择要录制的窗口",
    });
    const sub = el("p", {
      className: "record-target-sub",
      text: "列表只显示有标题、尺寸正常的窗口；OmniKit 自身已隐藏。",
    });

    const list = el("div", { className: "record-target-list" });
    if (wins.length === 0) {
      list.appendChild(
        el("p", {
          className: "record-target-empty",
          text: "当前没有可录的窗口。",
        }),
      );
    } else {
      for (const w of wins) {
        const row = el("button", { className: "record-target-row" });
        row.type = "button";
        const rowHead = el("div", { className: "record-target-row-head" });
        const titleSpan = el("span", {
          className: "record-target-row-title",
          text: w.title,
        });
        rowHead.appendChild(titleSpan);
        if (w.appName) {
          rowHead.appendChild(
            el("span", { className: "record-target-row-app", text: w.appName }),
          );
        }
        const size = el("div", {
          className: "record-target-row-size",
          text: `${w.width} × ${w.height}  @ (${w.x}, ${w.y})`,
        });
        row.append(rowHead, size);
        row.addEventListener("click", () => finish(w));
        list.appendChild(row);
      }
    }

    const footer = el("div", { className: "record-target-footer" });
    const back = el("button", {
      className: "record-target-btn ghost",
      text: "← 返回",
    });
    back.type = "button";
    back.addEventListener("click", () => finish(null));
    const cancel = el("button", {
      className: "record-target-btn ghost",
      text: "取消",
    });
    cancel.type = "button";
    cancel.addEventListener("click", () => finish(null));
    footer.append(back, cancel);

    panel.append(title, sub, list, footer);
  });
}

async function pickRegionViaFullscreenPicker(
  previewPath: string,
  previewWidth: number,
  previewHeight: number,
  getFrameUrl: () => string,
): Promise<RecordTargetResult | null> {
  // 进入全屏 picker
  let enterOk = false;
  try {
    await invoke("enter_region_picker_mode_cmd");
    enterOk = true;
  } catch {
    enterOk = false;
  }

  const img = new Image();
  const pick = await pickRecordingRegion(
    img,
    previewWidth,
    previewHeight,
    getFrameUrl,
    enterOk,
  );
  if (enterOk) {
    try {
      await invoke("exit_region_picker_mode_cmd");
    } catch {
      /* ignore */
    }
  }
  if (!pick) return null;
  return {
    rect: pick.crop,
    source: "region",
    dismissOverlay: pick.dismissOverlay,
    onStopRequested: pick.onStopRequested,
    label: `自定义区域 ${pick.crop.w}×${pick.crop.h}`,
  };
}

async function startPreview(): Promise<{
  previewPath: string;
  previewWidth: number;
  previewHeight: number;
  getFrameUrl: () => string;
} | null> {
  let previewPath: string;
  let previewWidth: number;
  let previewHeight: number;
  try {
    const dir = await appDataDir();
    const tmpDir = await join(dir, "tmp");
    const filename = `record-preview-${Date.now()}.png`;
    const out = await join(tmpDir, filename);
    const result = await invoke<{ path: string; width: number; height: number }>(
      "start_record_preview_cmd",
      { args: { outputPath: out } },
    );
    previewPath = result.path;
    previewWidth = result.width;
    previewHeight = result.height;
  } catch (err) {
    window.alert(`启动屏幕预览失败：${String(err)}`);
    return null;
  }
  const getFrameUrl = (): string =>
    `${convertFileSrc(previewPath)}?t=${Date.now()}`;
  return { previewPath, previewWidth, previewHeight, getFrameUrl };
}

export async function pickRecordTarget(): Promise<RecordTargetResult | null> {
  // 1) 模式
  const mode = await showModeDialog();
  if (!mode) return null;

  if (mode === "screen") {
    // 直接拿主显示器尺寸
    let info: ScreenInfo;
    try {
      info = await invoke<ScreenInfo>("primary_screen_info_cmd");
    } catch (err) {
      window.alert(`无法获取主显示器：${String(err)}`);
      return null;
    }
    return {
      rect: {
        x: info.x,
        y: info.y,
        w: info.width,
        h: info.height,
      },
      source: "screen",
      label: `整屏 ${info.width}×${info.height}`,
    };
  }

  if (mode === "window") {
    // 列出窗口，点选
    const win = await pickWindow();
    if (!win) {
      // 用户从窗口列表返回上一层；可再次选择模式。简化：直接 null，让外层从头开始。
      return null;
    }
    return {
      rect: { x: win.x, y: win.y, w: win.width, h: win.height },
      source: "window",
      label: `窗口「${win.title}」 ${win.width}×${win.height}`,
    };
  }

  // mode === "region"：启动预览 + 全屏 picker
  const preview = await startPreview();
  if (!preview) return null;
  const result = await pickRegionViaFullscreenPicker(
    preview.previewPath,
    preview.previewWidth,
    preview.previewHeight,
    preview.getFrameUrl,
  );
  // 不论是否成功选择，停止预览
  try {
    await invoke("stop_record_preview_cmd");
  } catch {
    /* ignore */
  }
  return result;
}

/**
 * 录屏中浮层：整屏 / 选窗口 模式没有 picker overlay，靠它告诉用户"正在录屏"+ 给个明显的停止按钮。
 * 返回 hide() 用于结束录屏后清理。
 */
export function showRecordFloater(label: string, onStop: () => void): () => void {
  const host = findModalRoot();
  const el = document.createElement("div");
  el.className = "record-status-floater";
  const dot = document.createElement("span");
  dot.className = "dot";
  const text = document.createElement("span");
  text.className = "label";
  text.textContent = `正在录屏 · ${label}`;
  const stopBtn = document.createElement("button");
  stopBtn.type = "button";
  stopBtn.className = "stop-btn";
  stopBtn.textContent = "停止";
  stopBtn.addEventListener("click", () => {
    onStop();
  });
  el.append(dot, text, stopBtn);
  host.appendChild(el);
  return (): void => {
    el.remove();
  };
}
