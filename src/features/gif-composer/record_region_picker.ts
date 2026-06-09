import { trimBlackMargins } from "./screen_record";

/** 视频帧内的裁剪矩形（像素，相对 video.videoWidth/Height） */
export type PixelCropRect = { x: number; y: number; w: number; h: number };

/** 用户确认选区后的结果；录制过程中浮层保持显示，结束后请调用 dismissOverlay */
export type RecordingRegionPickResult = {
  crop: PixelCropRect;
  dismissOverlay: () => void;
  onStopRequested: (cb: () => void) => void;
};

const HANDLE = 12;
const MIN_SEL = 24;

type DragMode = "none" | "create" | "move" | "resize";
type Corner = "nw" | "ne" | "sw" | "se";

/**
 * 在实时预览上框选区域。
 * - 取消（或 Esc）返回 null，调用方应停止 MediaStream。
 * - 确认后返回 crop 与 dismissOverlay：**录制结束前勿调用 dismissOverlay**，绿色选框会一直在预览上。
 */
export function pickRecordingRegion(
  video: HTMLVideoElement,
): Promise<RecordingRegionPickResult | null> {
  return new Promise((resolve) => {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) {
      resolve(null);
      return;
    }

    const maxW = Math.min(window.innerWidth * 0.92, 1200);
    const maxH = window.innerHeight * 0.68;
    let dispW = maxW;
    let dispH = (vh / vw) * dispW;
    if (dispH > maxH) {
      dispH = maxH;
      dispW = (vw / vh) * dispH;
    }
    dispW = Math.round(dispW);
    dispH = Math.round(dispH);

    let dismissed = false;
    let recordingLocked = false;

    const dismissOverlay = (): void => {
      if (dismissed) return;
      dismissed = true;
      window.removeEventListener("keydown", onKey);
      backdrop.remove();
    };

    const backdrop = document.createElement("div");
    backdrop.className = "record-region-backdrop";

    const panel = document.createElement("div");
    panel.className = "record-region-panel";
    panel.style.position = "relative";

    const title = document.createElement("p");
    title.className = "record-region-title";
    title.style.cursor = "move";
    title.title = "按住此处可拖动面板";
    title.textContent =
      "拖动绿色框调整区域与大小（可拖内部移动、拖四角缩放），选好后点「开始录制」；需整幅画面点「整幅画面」。";

    let isDraggingPanel = false;
    let panelTx = 0;
    let panelTy = 0;
    let mouseStartX = 0;
    let mouseStartY = 0;

    title.addEventListener("pointerdown", (e) => {
      isDraggingPanel = true;
      mouseStartX = e.clientX;
      mouseStartY = e.clientY;
      title.setPointerCapture(e.pointerId);
    });

    title.addEventListener("pointermove", (e) => {
      if (!isDraggingPanel) return;
      const dx = e.clientX - mouseStartX;
      const dy = e.clientY - mouseStartY;
      panel.style.transform = `translate(${panelTx + dx}px, ${panelTy + dy}px)`;
    });

    const onTitleUp = (e: PointerEvent) => {
      if (!isDraggingPanel) return;
      isDraggingPanel = false;
      panelTx += e.clientX - mouseStartX;
      panelTy += e.clientY - mouseStartY;
      try {
        title.releasePointerCapture(e.pointerId);
      } catch {}
    };

    title.addEventListener("pointerup", onTitleUp);
    title.addEventListener("pointercancel", onTitleUp);

    const hint = document.createElement("p");
    hint.className = "record-region-hint";

    const stage = document.createElement("div");
    stage.className = "record-region-stage";
    stage.style.width = `${dispW}px`;
    stage.style.height = `${dispH}px`;

    video.classList.add("record-region-video");
    video.style.width = "100%";
    video.style.height = "100%";
    video.style.objectFit = "contain"; // 改为 contain 保持原始比例
    video.style.display = "block";
    stage.appendChild(video);

    const canvas = document.createElement("canvas");
    canvas.width = dispW;
    canvas.height = dispH;
    canvas.className = "record-region-canvas";
    stage.appendChild(canvas);

    let sel = { x: 0, y: 0, w: dispW, h: dispH };

    // 自动检测并裁掉四边黑边，使绿框初始就贴合实际内容
    try {
      const probe = document.createElement("canvas");
      probe.width = vw;
      probe.height = vh;
      const pctx = probe.getContext("2d", { willReadFrequently: true });
      if (pctx) {
        pctx.drawImage(video, 0, 0, vw, vh);
        const probeData = pctx.getImageData(0, 0, vw, vh).data;
        // 这里的 trimBlackMargins 需要在顶部 import
        const trimmed = trimBlackMargins(probeData, vw, vh);
        if (trimmed) {
          sel = {
            x: (trimmed.x / vw) * dispW,
            y: (trimmed.y / vh) * dispH,
            w: (trimmed.w / vw) * dispW,
            h: (trimmed.h / vh) * dispH,
          };
        }
      }
    } catch {
      // 忽略探测失败
    }

    let mode: DragMode = "none";
    let corner: Corner | null = null;
    let startMX = 0;
    let startMY = 0;
    let startSel = { ...sel };
    let moveOffX = 0;
    let moveOffY = 0;
    let showHandles = true;

    const toLocal = (e: PointerEvent): { x: number; y: number } => {
      const r = canvas.getBoundingClientRect();
      return {
        x: ((e.clientX - r.left) / r.width) * canvas.width,
        y: ((e.clientY - r.top) / r.height) * canvas.height,
      };
    };

    const hitCorner = (x: number, y: number): Corner | null => {
      const c: [Corner, number, number][] = [
        ["nw", sel.x, sel.y],
        ["ne", sel.x + sel.w, sel.y],
        ["sw", sel.x, sel.y + sel.h],
        ["se", sel.x + sel.w, sel.y + sel.h],
      ];
      for (const [name, cx, cy] of c) {
        if (Math.abs(x - cx) <= HANDLE && Math.abs(y - cy) <= HANDLE) return name;
      }
      return null;
    };

    const hitInside = (x: number, y: number): boolean =>
      x >= sel.x && x <= sel.x + sel.w && y >= sel.y && y <= sel.y + sel.h;

    const clampSel = (): void => {
      if (sel.w < MIN_SEL) sel.w = MIN_SEL;
      if (sel.h < MIN_SEL) sel.h = MIN_SEL;
      sel.x = Math.max(0, Math.min(sel.x, dispW - sel.w));
      sel.y = Math.max(0, Math.min(sel.y, dispH - sel.h));
      if (sel.x + sel.w > dispW) sel.x = dispW - sel.w;
      if (sel.y + sel.h > dispH) sel.y = dispH - sel.h;
    };

    const updateHint = (): void => {
      const px = Math.max(1, Math.round((sel.w / dispW) * vw));
      const py = Math.max(1, Math.round((sel.h / dispH) * vh));
      if (recordingLocked) {
        hint.textContent = `录制中 · 选区约 ${px} × ${py} px（绿框内将写入 GIF）`;
      } else {
        hint.textContent = `输出约 ${px} × ${py} 像素（最终长边仍可能按设置缩小）`;
      }
    };

    const redraw = (): void => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, dispW, dispH);
      ctx.fillStyle = "rgba(0,0,0,0.52)";
      ctx.fillRect(0, 0, dispW, dispH);
      ctx.clearRect(sel.x, sel.y, sel.w, sel.h);
      ctx.strokeStyle = "#4ade80";
      ctx.lineWidth = 2;
      ctx.strokeRect(sel.x, sel.y, sel.w, sel.h);
      if (showHandles) {
        const corners: [number, number][] = [
          [sel.x, sel.y],
          [sel.x + sel.w, sel.y],
          [sel.x, sel.y + sel.h],
          [sel.x + sel.w, sel.y + sel.h],
        ];
        ctx.fillStyle = "#fff";
        ctx.strokeStyle = "#15803d";
        for (const [cx, cy] of corners) {
          ctx.fillRect(cx - HANDLE / 2, cy - HANDLE / 2, HANDLE, HANDLE);
          ctx.strokeRect(cx - HANDLE / 2, cy - HANDLE / 2, HANDLE, HANDLE);
        }
      }
      updateHint();
    };

    const onPointerDown = (e: PointerEvent): void => {
      if (dismissed || recordingLocked) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      const { x, y } = toLocal(e);
      const hc = hitCorner(x, y);
      if (hc) {
        mode = "resize";
        corner = hc;
        startMX = x;
        startMY = y;
        startSel = { ...sel };
        return;
      }
      if (hitInside(x, y)) {
        mode = "move";
        moveOffX = x - sel.x;
        moveOffY = y - sel.y;
        startMX = x;
        startMY = y;
        return;
      }
      mode = "create";
      startMX = x;
      startMY = y;
      sel = { x, y, w: 0, h: 0 };
    };

    const onPointerMove = (e: PointerEvent): void => {
      if (mode === "none" || dismissed || recordingLocked) return;
      const { x, y } = toLocal(e);
      if (mode === "create") {
        const x0 = Math.min(startMX, x);
        const y0 = Math.min(startMY, y);
        const x1 = Math.max(startMX, x);
        const y1 = Math.max(startMY, y);
        sel = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
        redraw();
        return;
      }
      if (mode === "move") {
        sel.x = x - moveOffX;
        sel.y = y - moveOffY;
        clampSel();
        redraw();
        return;
      }
      if (mode === "resize" && corner) {
        const s = { ...startSel };
        switch (corner) {
          case "nw":
            s.x = x;
            s.y = y;
            s.w = startSel.x + startSel.w - x;
            s.h = startSel.y + startSel.h - y;
            break;
          case "ne":
            s.y = y;
            s.w = x - startSel.x;
            s.h = startSel.y + startSel.h - y;
            break;
          case "sw":
            s.x = x;
            s.w = startSel.x + startSel.w - x;
            s.h = y - startSel.y;
            break;
          case "se":
            s.w = x - startSel.x;
            s.h = y - startSel.y;
            break;
        }
        if (s.w < 0) {
          s.x += s.w;
          s.w = -s.w;
        }
        if (s.h < 0) {
          s.y += s.h;
          s.h = -s.h;
        }
        if (s.w >= MIN_SEL && s.h >= MIN_SEL) {
          sel = s;
          clampSel();
        }
        redraw();
      }
    };

    const onPointerUp = (e: PointerEvent): void => {
      if (recordingLocked || dismissed) return;
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      if (mode === "create") {
        if (sel.w < MIN_SEL || sel.h < MIN_SEL) {
          sel = { x: 0, y: 0, w: dispW, h: dispH };
        }
        clampSel();
        redraw();
      }
      mode = "none";
      corner = null;
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);

    const btnRow = document.createElement("div");
    btnRow.className = "record-region-actions";

    const btnFull = document.createElement("button");
    btnFull.type = "button";
    btnFull.className = "record-region-btn ghost";
    btnFull.textContent = "整幅画面";
    btnFull.addEventListener("click", () => {
      if (recordingLocked || dismissed) return;
      sel = { x: 0, y: 0, w: dispW, h: dispH };
      redraw();
    });

    const btnCancel = document.createElement("button");
    btnCancel.type = "button";
    btnCancel.className = "record-region-btn ghost";
    btnCancel.textContent = "取消";
    btnCancel.addEventListener("click", () => {
      if (recordingLocked || dismissed) return;
      dismissOverlay();
      resolve(null);
    });

    const btnOk = document.createElement("button");
    btnOk.type = "button";
    btnOk.className = "record-region-btn primary";
    btnOk.textContent = "开始录制";

    const btnStop = document.createElement("button");
    btnStop.type = "button";
    btnStop.className = "record-region-btn primary";
    btnStop.style.background = "linear-gradient(180deg, #ef4444, #dc2626)";
    btnStop.style.borderColor = "#b91c1c";
    btnStop.textContent = "停止并保存 GIF";
    btnStop.style.display = "none";

    let stopCb: (() => void) | null = null;
    btnStop.addEventListener("click", () => {
      if (stopCb) stopCb();
    });

    btnOk.addEventListener("click", () => {
      if (recordingLocked || dismissed) return;
      clampSel();
      let x = Math.round((sel.x / dispW) * vw);
      let y = Math.round((sel.y / dispH) * vh);
      let w = Math.round((sel.w / dispW) * vw);
      let h = Math.round((sel.h / dispH) * vh);
      x = Math.max(0, Math.min(x, vw - 1));
      y = Math.max(0, Math.min(y, vh - 1));
      w = Math.max(16, w);
      h = Math.max(16, h);
      if (x + w > vw) w = vw - x;
      if (y + h > vh) h = vh - y;
      if (w < 16 || h < 16) {
        hint.textContent = "选区过小，请扩大绿色框。";
        return;
      }

      recordingLocked = true;
      showHandles = false;
      canvas.style.pointerEvents = "none";
      btnFull.style.display = "none";
      btnCancel.style.display = "none";
      btnOk.style.display = "none";
      btnStop.style.display = "inline-block";
      
      /** 录制中不拦截指针，避免挡住主窗口「停止并保存」等按钮 */
      backdrop.classList.add("record-region-passthrough");
      title.textContent =
        "录制中：绿框内为写入 GIF 的区域（按住此处可拖动本面板）。完成后请点击下方「停止并保存 GIF」。";
      redraw();

      resolve({
        crop: { x, y, w, h },
        dismissOverlay,
        onStopRequested: (cb) => {
          stopCb = cb;
        },
      });
    });

    btnRow.append(btnFull, btnCancel, btnOk, btnStop);
    panel.append(title, hint, stage, btnRow);
    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);

    const onKey = (ev: KeyboardEvent): void => {
      if (dismissed || recordingLocked) return;
      if (ev.key === "Escape") {
        dismissOverlay();
        resolve(null);
      }
    };
    window.addEventListener("keydown", onKey);

    redraw();
  });
}
