#!/usr/bin/env bash
# relay のローカルセットアップ（CLI ビルド成果物 + OpenCode プラグイン）
#
# 使い方:
#   scripts/install.sh
#
# 重要 (T338): インストールされる CLI は **ビルド成果物** であり、repo のソース
# ではない。したがって src/ を編集しても、rebuild + reinstall するまで live CLI
# には反映されない（未完成の中間状態が全 fleet の `relay` を壊す事故を防ぐ）。
#
# 再インストール:
#   bun run build && cp dist/cli.js ~/.local/share/relay/cli.js
#   （または scripts/install.sh を再実行）
#
# スキル (agent-worker / parallel-worktrees) は APM が配る:
#   apm install -g --target agent-skills 81ueman/relay

set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$repo"

if ! command -v bun >/dev/null 2>&1; then
  echo "error: bun が見つかりません。https://bun.sh から導入してください" >&2
  exit 1
fi

# インストール先（repo の外の STABLE な場所）とランチャー。
install_dir="${RELAY_INSTALL_DIR:-$HOME/.local/share/relay}"
bin_dir="${RELAY_BIN_DIR:-$HOME/.bin}"
# bun が使う bin ディレクトリを優先（PATH 上にあることが多い）。
if command -v bun >/dev/null 2>&1; then
  bun_bin="$(bun pm bin -g 2>/dev/null || true)"
  [ -n "$bun_bin" ] && bin_dir="$bun_bin"
fi
launcher="$bin_dir/relay"

echo "[1/4] bun install"
bun install

echo "[2/4] bun run build (embeds version + source commit)"
bun run build

echo "[3/4] install the BUILT artifact to $install_dir/cli.js"
mkdir -p "$install_dir" "$bin_dir"
cp dist/cli.js "$install_dir/cli.js"
chmod +x "$install_dir/cli.js"
# ランチャーはビルド成果物を exec するだけ。ソースへ symlink しない。
cat > "$launcher" <<EOF
#!/bin/sh
# relay launcher: runs the INSTALLED build (decoupled from the repo source).
# Reinstall: cd <relay-repo> && bun run build && cp dist/cli.js $install_dir/cli.js
exec bun "$install_dir/cli.js" "\$@"
EOF
chmod +x "$launcher"

echo "[4/4] OpenCode plugin symlink"
plugins="$HOME/.config/opencode/plugins"
mkdir -p "$plugins"
ln -sfn "$repo/.opencode/plugins/relay.ts" "$plugins/relay.ts"

echo
echo "relay  : $launcher -> $install_dir/cli.js (built artifact)"
echo "version: $("$launcher" --version 2>/dev/null || echo '?')"
echo "plugin : $plugins/relay.ts -> $repo/.opencode/plugins/relay.ts"
echo
echo "NOTE: live CLI はビルド成果物。src/ を変えたら reinstall:"
echo "  bun run build && cp dist/cli.js $install_dir/cli.js"
echo
echo "スキルは APM で配備する:"
echo "  apm install -g --target agent-skills 81ueman/relay"
