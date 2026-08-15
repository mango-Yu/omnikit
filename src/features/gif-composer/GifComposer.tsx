import { useEffect, useRef } from 'react';
import { initGifComposer } from './initGifComposer';
import './gif-composer.css';

export default function GifComposer() {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (rootRef.current) {
      initGifComposer(rootRef.current);
    }
  }, []);

  return (
    <div ref={rootRef} className="gif-composer-root h-full overflow-y-auto">
      <main className="app">
        <header className="hero">
          <h1>GIF 合成器</h1>
          <p className="sub">
            选择多张图片，拖拽或按钮调整顺序，设置帧间隔后导出为 GIF。
          </p>
        </header>

        <section className="toolbar">
          <div className="toolbar-group">
            <button id="pick" type="button">选择图片</button>
            <button id="clear" type="button" className="ghost">清空列表</button>
          </div>
          <div className="toolbar-group">
            <label className="delay">
              每帧间隔（毫秒）
              <input id="delay-ms" type="number" min={20} step={10} defaultValue={2000} />
            </label>
            <button id="export" type="button" className="primary">生成并保存 GIF</button>
          </div>
        </section>

        <section id="record-panel" className="pro-record-panel" hidden>
          <h3 id="record-heading" className="pro-record-title">录屏转 GIF</h3>
          <p id="record-intro" className="pro-record-desc" />
          <div className="pro-record-row">
            <label className="pro-record-label">
              帧率（FPS）
              <input id="record-fps" type="number" min={1} max={24} step={1} defaultValue={8} />
            </label>
            <label className="pro-record-label">
              最长（秒）
              <input id="record-max-sec" type="number" min={5} max={60} step={1} defaultValue={60} />
            </label>
            <button id="record-start" type="button" className="record-btn">开始录屏</button>
            <button id="record-stop" type="button" className="record-btn primary" disabled>
              停止并保存 GIF
            </button>
          </div>
        </section>

        <section id="video-panel" className="pro-record-panel" hidden>
          <h3 className="pro-record-title">上传视频转 GIF</h3>
          <p id="video-intro" className="pro-record-desc" />
          <div className="pro-record-row">
            <label className="pro-record-label">
              帧率（FPS）
              <input id="video-fps" type="number" min={1} max={24} step={1} defaultValue={8} />
            </label>
            <label className="pro-record-label">
              最长（秒）
              <input id="video-max-sec" type="number" min={1} max={60} step={1} defaultValue={60} readOnly />
            </label>
            <button id="video-pick" type="button" className="record-btn primary">
              选择视频并保存 GIF
            </button>
          </div>
        </section>

        <p id="status" className="status" />
        <div id="progress-bar" className="progress-bar" style={{ display: "none" }}>
          <div id="progress-bar-fill" className="progress-bar-fill" />
        </div>
        <ul id="image-list" className="grid" />
      </main>
    </div>
  );
}
