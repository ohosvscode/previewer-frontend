#!/usr/bin/env bash
# 一键：rich(Stage) 应用 浏览器实时预览 + 断点调试（共用同一个 Previewer 进程）。
#
# 架构（两条独立通道，互不干扰）：
#   previewer-host  ──命令通道(LocalSocket)+图像通道(WS)──►  浏览器 UI  (预览/交互)
#   arkts-dap / VSCode  ──CDP(WebSocket :cdpPort)──►  同一个 Previewer  (断点调试)
#
# 注意：debug 模式下运行时启动即阻塞，画面要等调试器 attach 并 continue 过 break-on-start 后才出现。
#
# 用法:
#   preview-and-debug.sh <APP_INTERMEDIATES_DIR> [MODULE] [ABILITY] [CDP_PORT] [BIND]
# 例:
#   preview-and-debug.sh ~/DevEcoStudioProjects/MyApplication2/entry/build/default/intermediates
set -euo pipefail

APPB="${1:?app intermediates dir}"
MODULE="${2:-entry}"; ABILITY="${3:-EntryAbility}"
CDP_PORT="${4:-29900}"; BIND="${5:-127.0.0.1:9000}"
SDK_PREV="${SDK_PREV:-$HOME/Library/OpenHarmony/Sdk/23/previewer}"
HOST_DIR="$(cd "$(dirname "$0")/../host" && pwd)"
UI_DIR="$(cd "$(dirname "$0")/../ui" && pwd)"

cargo build --manifest-path "$HOST_DIR/Cargo.toml" --bin previewer-host >/dev/null

echo "════════════════════════════════════════════════════════════"
echo " 浏览器预览:  http://$BIND"
echo " 断点调试:    arkts-dap --cdp-port $CDP_PORT"
echo "              （或 VSCode: {\"type\":\"arkts\",\"request\":\"attach\",\"cdpPort\":$CDP_PORT}）"
echo " 提示: debug 模式下，attach 调试器并 continue 后浏览器画面才出现。"
echo "════════════════════════════════════════════════════════════"

exec "$HOST_DIR/target/debug/previewer-host" \
  --sim "$SDK_PREV/common/bin/Previewer" \
  --app "$APPB/loader_out/default/ets" \
  --ui "$UI_DIR" --bind "$BIND" \
  --device phone --shape rect --width 1080 --height 2340 \
  --project-model Stage \
  --arp "$APPB/res/default" \
  --pages "$APPB/res/default/resources/base/profile/main_pages.json" \
  --url pages/Index --bundle "$MODULE" \
  --debug --cdp-port "$CDP_PORT" \
  --debug-module "$MODULE" --debug-ability "$ABILITY" \
  --ljpath "$APPB/loader/default/loader.json"
