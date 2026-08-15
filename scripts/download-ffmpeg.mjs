// 把 ffmpeg 静态二进制下载到 resources/ffmpeg/，供 Tauri 打包进安装包。
//
// 用法：
//   node scripts/download-ffmpeg.mjs                       # 下载当前平台
//   node scripts/download-ffmpeg.mjs --target=macos-arm64 # 指定平台
//   node scripts/download-ffmpeg.mjs --all                 # 下载所有平台
//
// 重复执行会跳过已存在的目标。

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { platform, arch } from "node:process";
import { extract as tarExtract } from "tar";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const OUT_DIR = resolve(PROJECT_ROOT, "resources", "ffmpeg");

// BtbN nightly 静态构建（GPL，开箱即用）
// 国内下载慢时可设置环境变量切换镜像：
//   set FFMPEG_MIRROR=https://ghfast.top    (Windows cmd)
//   $env:FFMPEG_MIRROR="https://ghfast.top"  (PowerShell)
//   export FFMPEG_MIRROR=https://ghfast.top (macOS/Linux)
const FFMPEG_MIRROR = process.env.FFMPEG_MIRROR || "";
const SOURCES = {
  "windows-x86_64": "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
  "macos-x86_64":   "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-macos64-gpl.tar.xz",
  "macos-arm64":    "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-macosarm64-gpl.tar.xz",
  "linux-x86_64":   "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz",
};

function withMirror(url) {
  if (!FFMPEG_MIRROR) return url;
  // 把 https://github.com/... 替换为 <镜像>/https://github.com/...
  if (url.startsWith("https://github.com/")) {
    return `${FFMPEG_MIRROR.replace(/\/$/, "")}/${url}`;
  }
  return url;
}

const FILENAMES = {
  "windows-x86_64": "ffmpeg-x86_64-pc-windows-msvc.exe",
  "macos-x86_64": "ffmpeg-x86_64-apple-darwin",
  "macos-arm64": "ffmpeg-aarch64-apple-darwin",
  "linux-x86_64": "ffmpeg-x86_64-unknown-linux-gnu",
};

function detectCurrentTarget() {
  if (platform === "win32" && arch === "x64") return "windows-x86_64";
  if (platform === "darwin" && arch === "x64") return "macos-x86_64";
  if (platform === "darwin" && arch === "arm64") return "macos-arm64";
  if (platform === "linux" && arch === "x64") return "linux-x86_64";
  throw new Error(`当前平台暂不支持自动下载：${platform}-${arch}。请手动放置 ffmpeg 二进制到 ${OUT_DIR}`);
}

function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

/** 在 dir 下递归找名为 name 的文件，返回完整路径；找不到返回 null。 */
function findFile(dir, name) {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const e of readdirSync(cur, { withFileTypes: true })) {
      const full = join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name === name) return full;
    }
  }
  return null;
}

async function download(url, dest) {
  console.log(`下载 ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`下载失败：${res.status} ${res.statusText}`);

  const total = Number(res.headers.get("content-length") || 0);
  let received = 0;
  let lastPrint = 0;

  // 用流式写入并显示进度
  const { createWriteStream } = await import("node:fs");
  const writer = createWriteStream(dest);
  const reader = res.body.getReader();

  const formatBytes = (b) => {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
    return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!writer.write(value)) {
        await new Promise((r) => writer.once("drain", r));
      }
      received += value.length;
      const now = Date.now();
      if (now - lastPrint > 500 || (total && received === total)) {
        lastPrint = now;
        const pct = total ? Math.round((received / total) * 100) : 0;
        const speed = received / ((now - lastPrint + 1) / 1000);
        process.stdout.write(
          `\r  ${formatBytes(received)} / ${total ? formatBytes(total) : "??"}  ${pct}%  ${formatBytes(speed)}/s   `,
        );
      }
    }
  } finally {
    writer.end();
    await new Promise((r) => writer.on("close", r));
  }
  process.stdout.write("\n");
}

async function extractArchive(archivePath) {
  const tmp = join(OUT_DIR, "__tmp__");
  ensureDir(tmp);
  if (archivePath.endsWith(".zip")) {
    if (platform === "win32") {
      execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `Expand-Archive -Path '${archivePath}' -DestinationPath '${tmp}' -Force`,
        ],
        { stdio: "inherit" },
      );
    } else {
      execFileSync("unzip", ["-o", archivePath, "-d", tmp], { stdio: "inherit" });
    }
  } else if (archivePath.endsWith(".tar.xz")) {
    await tarExtract({ file: archivePath, cwd: tmp });
  } else {
    throw new Error("未知归档格式：" + archivePath);
  }
}

async function processTarget(target) {
  if (!SOURCES[target]) {
    console.error(`未知 target: ${target}（可选：${Object.keys(SOURCES).join(", ")}）`);
    return false;
  }
  const finalName = FILENAMES[target];
  const targetPath = join(OUT_DIR, finalName);
  if (existsSync(targetPath)) {
    console.log(`已存在 ${targetPath}，跳过`);
    return true;
  }

  const url = SOURCES[target];
  const isZip = url.endsWith(".zip");
  const archivePath = join(OUT_DIR, isZip ? "ffmpeg-dl.zip" : "ffmpeg-dl.tar.xz");
  if (existsSync(archivePath)) rmSync(archivePath);

  await download(url, archivePath);
  await extractArchive(archivePath);

  const exeName = target.startsWith("windows") ? "ffmpeg.exe" : "ffmpeg";
  const found = findFile(join(OUT_DIR, "__tmp__"), exeName);
  if (!found) throw new Error("在归档中找不到 ffmpeg 二进制");
  renameSync(found, targetPath);
  if (platform !== "win32") chmodSync(targetPath, 0o755);
  rmSync(join(OUT_DIR, "__tmp__"), { recursive: true, force: true });
  rmSync(archivePath, { force: true });
  console.log(`✓ ${targetPath}  (${(statSync(targetPath).size / 1024 / 1024).toFixed(1)} MB)`);
  return true;
}

function parseArgs(argv) {
  const out = { all: false, target: null };
  for (const a of argv) {
    if (a === "--all") out.all = true;
    else if (a.startsWith("--target=")) out.target = a.slice("--target=".length);
  }
  return out;
}

async function main() {
  ensureDir(OUT_DIR);
  const args = parseArgs(process.argv.slice(2));
  const targets = args.all
    ? Object.keys(SOURCES)
    : [args.target || detectCurrentTarget()];

  let ok = true;
  for (const t of targets) {
    try {
      const success = await processTarget(t);
      if (!success) ok = false;
    } catch (e) {
      console.error(`✗ ${t} 失败：${e.message ?? e}`);
      ok = false;
    }
  }
  process.exit(ok ? 0 : 1);
}

main();
