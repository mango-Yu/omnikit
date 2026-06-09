# QuickKit

QuickKit 是一款基于 **Tauri 2** 的跨平台（macOS / Windows）桌面工具集，将 **快开（QuickOpen）** 与 **GIF 合成器** 整合在同一应用中。左侧导航可一键切换模块，数据与功能彼此独立。

---

## 模块概览

| 模块 | 说明 |
|------|------|
| **快开** | 记录高频文件/文件夹，卡片式展示，一键打开、右键定位 |
| **GIF 合成器** | 多图合成 GIF、录屏转 GIF、本地视频转 GIF |

---

## 快开

将工作与生活中**高频使用、但容易忘记路径**的文件或文件夹统一收录，以卡片瀑布流展示，支持**一键打开**与**右键在访达/资源管理器中定位**。

### 核心特性

- **原生体验**：Tauri v2 构建，体积小、内存占用低
- **智能图标**：内置常见格式图标，无需截图也能辨识类型
- **极简交互**：
  - **左键**：用系统默认程序打开
  - **右键**：在文件管理器中定位并高亮
  - **悬浮删除**：仅从库中移除记录，**不删除源文件**
- **搜索与排序**：按名称或路径模糊搜索，支持按时间/名称排序
- **分类过滤**：左侧按文件类型分组，点击即可筛选
- **拖拽添加**：将文件或文件夹拖入窗口即可入库
- **纯本地**：记录存于本机 SQLite，不联网

![添加与分类展示](add.png)

![添加文件与文件夹、按类型分组](file.png)

![删除记录](delete.png)

![搜索与排序](filter.png)

### 支持的文件类型

图片、视频、音频、压缩包、磁盘镜像、应用程序、脚本、电子表格、幻灯片、文档、产品与设计、数据库、配置文件、代码文件、字体等；未匹配格式归入**其他文件**。

---

## GIF 合成器

基于 **Vite + TypeScript**，在 macOS 与 Windows 上可将多张图片合成 GIF，也可录屏或上传短视频转 GIF 并保存到本地。

### 功能

- 选择多张本地图片（PNG / JPEG / GIF / WebP / BMP）
- 列表支持**拖拽排序**，或用「上移 / 下移」微调
- 设置**每帧间隔（毫秒）**，循环播放
- 画布以**第一张图**为基准，其余图等比缩放并居中铺白底
- 系统对话框选择路径导出 `.gif`
- **录屏转 GIF**：共享屏幕后可框选区域；最长 60 秒、无水印
- **视频转 GIF**：支持 MP4 / M4V（推荐 H.264），时长最长 30 秒

![主界面：多图合成与录屏转 GIF](1.png)

![帧列表：拖拽排序、上移 / 下移与移除](2.png)

![录屏：框选区域或整幅画面后开始录制](3.png)

### 使用说明

- GIF 每帧经颜色量化，体积与观感会有折中
- **录屏**依赖 `getDisplayMedia`；macOS 需在「隐私与安全性 → 录屏与系统录音」中允许本应用，并在 `src-tauri/Info.plist` 中保留屏幕/摄像头/麦克风用途说明（后两项系统询问时可选「不允许」）
- **视频转 GIF**使用 WebView 解码，不内置 FFmpeg，故仅支持 MP4 / M4V

---

## 技术栈

- **底层**：[Tauri v2](https://v2.tauri.app/)（Rust）
- **前端**：[React 19](https://react.dev/) + [Vite](https://vitejs.dev/) + [TypeScript](https://www.typescriptlang.org/)
- **UI**：[Tailwind CSS v3](https://tailwindcss.com/) + [Lucide React](https://lucide.dev/)
- **快开存储**：[SQLite](https://sqlite.org/)（`rusqlite`）
- **GIF 编码**：Rust `gif` / `image` + 前端 `gifenc`

---

## 环境要求

1. [Node.js](https://nodejs.org/) >= 18
2. [Rust](https://www.rust-lang.org/tools/install) >= 1.70（通过 rustup 安装）
3. 系统构建环境：
   - **macOS**：Xcode Command Line Tools（`xcode-select --install`）
   - **Windows**：Visual Studio Build Tools（含 MSVC）+ WebView2

### 安装 Rust（简要）

**macOS / Linux：**

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
cargo --version
```

**Windows：** 从 [rustup.rs](https://rustup.rs/) 安装，或使用 `winget install Rustlang.Rustup`。

---

## 开发与打包

```bash
git clone https://github.com/mango-Yu/quickkit.git
cd quickkit
npm install
npm run tauri:dev    # 开发（热更新）
npm run tauri:build  # 打包
```

安装包输出目录：`src-tauri/target/release/bundle/`（macOS：`.app` / `.dmg`；Windows：`.exe` 等，依配置而定）。

首次 `tauri dev` 会编译 Rust 依赖，可能需要数分钟；之后启动会快很多。

### 提交规范（可选）

若不希望提交信息中出现 Cursor 自动署名，可启用仓库钩子（仅需一次）：

```bash
git config core.hooksPath .githooks
```

---

## macOS：提示「已损坏，无法打开」

从网上下载的未签名应用可能触发 Gatekeeper。在信任来源的前提下，对 `.app` 执行：

```bash
xattr -cr "/Applications/QuickKit.app"
```

也可在 Finder 中**右键 → 打开 → 打开**。路径请按实际安装位置调整。

---

## 路线图

**快开**

- [x] 拖拽添加
- [x] 分类标签系统
- [ ] 全局快捷键（如读取剪贴板路径）
- [ ] 剪贴板截图作为卡片封面
- [ ] 多端同步

**GIF 合成器**

- [x] 多图合成、录屏转 GIF、视频转 GIF
- [ ] 更多视频格式（需评估是否引入 FFmpeg）

---

## 许可证

见仓库根目录（如有）。图标替换可使用：

```bash
npx tauri icon ./your-icon.png
```
