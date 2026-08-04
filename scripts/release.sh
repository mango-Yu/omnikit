#!/usr/bin/env bash
# OmniKit 一键发版：同步版本号 → 提交 → 推送 → 打 tag → 触发 GitHub Actions 打包
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

usage() {
  cat <<'EOF'
用法:
  npm run release -- <版本号> [选项]
  ./scripts/release.sh <版本号> [选项]

示例:
  npm run release -- 0.1.1
  npm run release -- v0.2.0
  npm run release -- 0.2.0-beta.1 --yes
  npm run release -- 0.1.1 --dry-run

选项:
  -y, --yes         跳过确认，直接执行
  --no-push         只本地提交并打 tag，不推送到远程
  --allow-dirty     允许工作区有其它未提交改动（仍只提交版本号文件）
  --dry-run         只预览将要执行的操作，不改文件、不提交
  -h, --help        显示帮助

说明:
  会同步更新 package.json / src-tauri/tauri.conf.json /
  src-tauri/Cargo.toml / src-tauri/Cargo.lock 中的版本号，
  然后提交、推送，并推送 tag 触发 CI 打包 .dmg 与 .exe。
EOF
}

log()  { printf "${CYAN}→${NC} %s\n" "$*"; }
ok()   { printf "${GREEN}✓${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}!${NC} %s\n" "$*"; }
die()  { printf "${RED}✗${NC} %s\n" "$*" >&2; exit 1; }

VERSION_RAW=""
YES=0
NO_PUSH=0
DRY_RUN=0
ALLOW_DIRTY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    -y|--yes) YES=1; shift ;;
    --no-push) NO_PUSH=1; shift ;;
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -*)
      die "未知选项: $1（使用 --help 查看用法）"
      ;;
    *)
      if [[ -n "$VERSION_RAW" ]]; then
        die "只能指定一个版本号，多余参数: $1"
      fi
      VERSION_RAW="$1"
      shift
      ;;
  esac
done

[[ -n "$VERSION_RAW" ]] || { usage; exit 1; }

VERSION="${VERSION_RAW#v}"
TAG="v${VERSION}"

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  die "版本号格式无效: ${VERSION_RAW}（示例: 0.1.1 / v0.2.0 / 0.2.0-beta.1）"
fi

current_pkg="$(node -p "require('./package.json').version")"
current_tauri="$(node -p "require('./src-tauri/tauri.conf.json').version")"
current_cargo="$(python3 - <<'PY'
from pathlib import Path
text = Path("src-tauri/Cargo.toml").read_text().splitlines()
in_package = False
for line in text:
    if line.strip() == "[package]":
        in_package = True
        continue
    if in_package and line.startswith("["):
        break
    if in_package and line.startswith("version"):
        print(line.split('"')[1])
        break
PY
)"

log "当前版本: package=${current_pkg}  tauri=${current_tauri}  cargo=${current_cargo}"
log "目标版本: ${VERSION}  (tag: ${TAG})"

if [[ "$VERSION" == "$current_pkg" && "$VERSION" == "$current_tauri" && "$VERSION" == "$current_cargo" ]]; then
  die "目标版本与当前版本相同（${VERSION}），无需发版"
fi

if git rev-parse "$TAG" >/dev/null 2>&1; then
  die "本地已存在 tag ${TAG}，请换版本号或先删除旧 tag"
fi

if git ls-remote --tags origin "refs/tags/${TAG}" 2>/dev/null | grep -q "$TAG"; then
  die "远程已存在 tag ${TAG}，请换版本号"
fi

branch="$(git branch --show-current)"
if [[ "$branch" != "main" && "$branch" != "master" ]]; then
  warn "当前分支是 ${branch}，建议在 main 上发版"
fi

if [[ -n "$(git status --porcelain)" ]]; then
  if [[ $ALLOW_DIRTY -eq 0 && $DRY_RUN -eq 0 ]]; then
    git status --short
    die "工作区有未提交改动。请先提交/暂存，或加 --allow-dirty（仍只提交版本号文件）"
  fi
  warn "工作区有未提交改动，发版将只提交版本号相关文件"
  git status --short
fi

echo
printf "将执行:\n"
echo "  1. 更新版本号为 ${VERSION}"
echo "  2. git commit -m \"chore(release): 发布 ${TAG}\""
if [[ $NO_PUSH -eq 0 ]]; then
  echo "  3. git push origin ${branch}"
  echo "  4. git tag -a ${TAG} && git push origin ${TAG}"
  echo "  5. 触发 GitHub Actions 打包 .dmg / .exe"
else
  echo "  3. git tag -a ${TAG}（不推送远程）"
fi
echo

if [[ $DRY_RUN -eq 1 ]]; then
  ok "dry-run 结束，未做任何修改"
  exit 0
fi

if [[ $YES -eq 0 ]]; then
  read -r -p "确认发版？[y/N] " reply
  [[ "$reply" == "y" || "$reply" == "Y" ]] || die "已取消"
fi

log "更新版本号文件..."
node -e '
  const fs = require("fs");
  const version = process.argv[1];
  for (const p of process.argv.slice(2)) {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    j.version = version;
    fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
  }
' "$VERSION" package.json src-tauri/tauri.conf.json

VERSION="$VERSION" CURRENT_CARGO="$current_cargo" python3 - <<'PY'
import os
from pathlib import Path

version = os.environ["VERSION"]
current_cargo = os.environ["CURRENT_CARGO"]

cargo = Path("src-tauri/Cargo.toml")
lines = cargo.read_text().splitlines(keepends=True)
out = []
in_package = False
replaced = False
for line in lines:
    stripped = line.strip()
    if stripped == "[package]":
        in_package = True
        out.append(line)
        continue
    if in_package and stripped.startswith("[") and stripped != "[package]":
        in_package = False
    if in_package and stripped.startswith("version") and not replaced:
        out.append(f'version = "{version}"\n')
        replaced = True
        continue
    out.append(line)
if not replaced:
    raise SystemExit("未在 Cargo.toml [package] 中找到 version")
cargo.write_text("".join(out))

lock = Path("src-tauri/Cargo.lock")
text = lock.read_text()
old = f'name = "omnikit"\nversion = "{current_cargo}"'
new = f'name = "omnikit"\nversion = "{version}"'
if old not in text:
    raise SystemExit(f"未在 Cargo.lock 中找到 omnikit@{current_cargo}")
lock.write_text(text.replace(old, new, 1))
PY

ok "版本已更新为 ${VERSION}"

log "提交改动..."
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "$(cat <<EOF
chore(release): 发布 ${TAG}

EOF
)"

log "创建 tag ${TAG}..."
git tag -a "$TAG" -m "release: ${TAG}"

if [[ $NO_PUSH -eq 1 ]]; then
  ok "本地发版完成（未推送）"
  echo "之后可手动执行:"
  echo "  git push origin ${branch}"
  echo "  git push origin ${TAG}"
  exit 0
fi

log "推送分支 ${branch}..."
git push origin "$branch"

log "推送 tag ${TAG}（将触发 CI 打包）..."
git push origin "$TAG"

remote_url="$(git remote get-url origin)"
repo_web="${remote_url%.git}"
repo_web="${repo_web/git@github.com:/https:\/\/github.com\/}"

ok "发版流程已完成"
echo
echo "后续:"
echo "  1. Actions:  ${repo_web}/actions"
echo "  2. Releases: ${repo_web}/releases  （下载 .dmg / .exe，不要看 Tags）"
echo
