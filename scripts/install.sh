#!/usr/bin/env bash
# relay のローカルセットアップ（CLI + OpenCode プラグイン）
#
# 使い方:
#   scripts/install.sh
#
# スキル (agent-worker) は APM が配る:
#   apm install -g --target agent-skills 81ueman/relay

set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$repo"

if ! command -v bun >/dev/null 2>&1; then
  echo "error: bun が見つかりません。https://bun.sh から導入してください" >&2
  exit 1
fi

echo "[1/4] bun install"
bun install

echo "[2/4] bun run build"
bun run build

echo "[3/4] bun link"
bun link

echo "[4/4] OpenCode plugin symlink"
plugins="$HOME/.config/opencode/plugins"
mkdir -p "$plugins"
ln -sfn "$repo/.opencode/plugins/relay.ts" "$plugins/relay.ts"

echo
echo "relay  : $(command -v relay)"
echo "plugin : $plugins/relay.ts -> $repo/.opencode/plugins/relay.ts"
echo
echo "スキルは APM で配備する:"
echo "  apm install -g --target agent-skills 81ueman/relay"
