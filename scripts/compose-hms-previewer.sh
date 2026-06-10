#!/usr/bin/env bash
# 合成一个可解析 HMS @kit/@hms 的 previewer 工作目录（cwd）。
#
# 背景：DevEco 的 HMS previewer 是叠加包（无 rich 二进制）——rich Previewer 来自 openharmony，
# HMS 提供 module/(原生)、systemHsp/(系统组件 .hsp)、apiMock/。运行时按 cwd 找 ./module，
# 按 -hsp 找 <hsp>/systemHsp。本脚本把两边 module 合并到一个 cwd 目录，供 Previewer 以它为
# 工作目录启动（二进制 @rpath 与 cwd 无关，故可异地）。
#
# 用法:  compose-hms-previewer.sh [OUT_DIR]
# 之后:  cd <OUT_DIR>; <OH>/common/bin/Previewer ... -hsp <HMS_PREVIEWER_DIR> -d ...
#        或 previewer-host --sim <OH>/common/bin/Previewer --hsp <HMS_PREVIEWER_DIR> --debug ...
#        （HMS @kit 应用须 --debug：debug 走 ability_simulator 正确加载 Stage ETS；非 debug 走 JS 前端）
set -euo pipefail

SDK="${DEVECO_SDK:-/Applications/DevEco-Studio.app/Contents/sdk/default}"
OH="$SDK/openharmony/previewer"
HMS="$SDK/hms/previewer"
OUT="${1:-/tmp/hms-previewer-cwd}"

[ -x "$OH/common/bin/Previewer" ] || { echo "找不到 openharmony Previewer: $OH" >&2; exit 1; }
[ -d "$HMS/module" ] || { echo "找不到 HMS module: $HMS" >&2; exit 1; }

rm -rf "$OUT"; mkdir -p "$OUT/module"
# cwd 相对依赖：fonts / fontconfig / icu（符号链接 OH 的）
for f in fonts fontconfig_ohos.json fontconfig.json icudt74l.dat; do
  ln -sf "$OH/common/bin/$f" "$OUT/$f"
done
# ../resources（systemResourcesPath = cwd/../resources）
ln -sfn "$OH/common/resources" "$(dirname "$OUT")/$(basename "$OUT")_resources" 2>/dev/null || true
ln -sfn "$OH/common/resources" "$(dirname "$OUT")/resources"
# 合并 module：OH 原生 + HMS 原生（命名空间子目录 ai/collaboration/core）
for d in "$OH/common/bin/module"/*; do ln -sf "$d" "$OUT/module/$(basename "$d")"; done
for d in "$HMS/module"/*; do ln -sf "$d" "$OUT/module/$(basename "$d")"; done

echo "✅ 合成完成: $OUT"
echo "   Previewer 二进制: $OH/common/bin/Previewer"
echo "   -hsp 传:          $HMS"
echo "   以 $OUT 为 cwd 启动 Previewer（HMS @kit 应用需 -d 调试模式 + arkts-dap attach 解阻塞）。"
echo
echo "注意：系统组件版本须匹配。实测 sample_in_harmonyos 的 @hms:hds.* (HdsNavigation) 在 DevEco 6.1"
echo "      systemHsp 中不存在 → 需与应用编译期一致的 UIDesignKit 版本（SDK 供给问题，与本工具无关）。"
