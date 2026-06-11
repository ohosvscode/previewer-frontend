#!/usr/bin/env bash
# 跨平台分发：为每个 VSCode target 各构建 host 二进制并打一个平台专属 vsix。
# 能在本机交叉编译的就打（darwin 两架构本机可建；linux/win 需对应工具链或 CI）。
# 用法：bash scripts/package-vsix-all.sh
set -uo pipefail
cd "$(dirname "$0")/.."                 # → host/integrations/vscode
VSCODE_DIR="$(pwd)"
HOST_DIR="$(cd ../.. && pwd)"           # → host/（Cargo.toml）
OUT="$VSCODE_DIR/dist"; mkdir -p "$OUT"

# rust-target | vscode-target | exe 名
MATRIX=(
  "aarch64-apple-darwin|darwin-arm64|previewer-host"
  "x86_64-apple-darwin|darwin-x64|previewer-host"
  "aarch64-unknown-linux-musl|linux-arm64|previewer-host"
  "x86_64-unknown-linux-musl|linux-x64|previewer-host"
  "x86_64-pc-windows-gnu|win32-x64|previewer-host.exe"
)

built=(); skipped=()
for row in "${MATRIX[@]}"; do
  IFS='|' read -r RT VT EXE <<< "$row"
  echo "────── $VT ($RT) ──────"
  rustup target add "$RT" >/dev/null 2>&1
  if cargo build --release --manifest-path "$HOST_DIR/Cargo.toml" --target "$RT" >"/tmp/cargo_$RT.log" 2>&1; then
    BIN="$HOST_DIR/target/$RT/release/$EXE"
    if [ -f "$BIN" ]; then
      if OHPREV_HOST_BIN="$BIN" OHPREV_HOST_EXE="$EXE" \
         npx --yes @vscode/vsce package --target "$VT" -o "$OUT/oh-previewer-$VT-0.0.1.vsix" >"/tmp/vsce_$VT.log" 2>&1; then
        echo "  ✓ $(basename "$OUT")/oh-previewer-$VT-0.0.1.vsix"; built+=("$VT")
      else
        echo "  ✗ vsce package 失败（见 /tmp/vsce_$VT.log）"; skipped+=("$VT:package")
      fi
    else
      echo "  ✗ 无构建产物 $BIN"; skipped+=("$VT:no-bin")
    fi
  else
    echo "  ✗ cargo build 失败（多半缺交叉工具链，见 /tmp/cargo_$RT.log）"; skipped+=("$VT:build")
  fi
done

echo
echo "已打包: ${built[*]:-（无）}"
echo "跳过:   ${skipped[*]:-（无）}"
echo "产物:"; ls -la "$OUT"/*.vsix 2>/dev/null | awk '{printf "  %.2f MB  %s\n",$5/1048576,$9}'
