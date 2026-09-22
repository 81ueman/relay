---
name: parallel-worktrees
description: 複数のエージェントで並列作業するときに使う。worktree を切ってその中でさらに worktree を切る再帰的なレーン分割、relay + herdr 前提の worker 起動・attach、統合エージェントが自分の subtree を merge する分担をまとめる。「並列でやって」「worktree 切って」「lane を分けて」「統合エージェントに任せて」などで使う。
---

# parallel-worktrees

## 概要

relay + herdr 上で、複数の OpenCode worker に並列で作業させるための型。
**worktree を切り、その中でさらに worktree を切る**再帰的な分割を許し、
各レベルの**統合エージェントが自分の subtree の merge まで面倒を見る**。

relay に agent hierarchy は無い（worker は全員 peer）。階層は
**task subtree + role + dependency + durable messaging** で表現する。

```
Human
  └── Top-Level Integration (program-coord 等)
        └── プログラム/レーン Integration Agent (task root を所有)
              ├── child worker A (必要ならさらに子 worktree)
              ├── child worker B
              └── child worker C
```

## いつ使うか

- 大きめのプログラムを複数 worker に並列で進めたいとき
- 「worktree 切って並列で」「レーン分けて」「統合エージェントに任せて」と言われたとき
- 既存レーンの上に新しいプログラムレーンを追加するとき

## 前提

- relay（`.relay/state.db` が source of truth）が稼働していること
- herdr（`HERDR_ENV=1`）内で動いていること
- worker は **OpenCode**（Codex は operator が明示したときだけ。理由なく使わない）
- 1 repo / 1 canonical relay DB / **active daemon は 1 つだけ**

## 不変条件（壊すと壊れる）

- **worktree ごとに relay daemon を起動しない。** daemon は 1 つ。worktree は git common dir 経由で同じ `.relay` を解決するので `.relay` symlink は不要。
- **worktree ごとに独立した `.relay/state.db` を作らない。**
- task の完了は SQLite の state が authority。worker の「done と言った」や idle pane は完了ではない。`submit` → review 承認 → `done`。
- 子の完了は **immediate parent にだけ** `child_done` が届く。grandchild は grandparent に bubble しない。2 段分解なら parent owner が子を統合して自分を submit する。
- merge は**統合エージェントが担当**。commit は path-scoped。`git add -A` / `git add .` / `git reset --hard` / destructive checkout 禁止。

## 手順

### 1. レーン用 worktree + workspace を作る

herdr の worktree 機能で、worktree と workspace をセットで作る（既存レーンと同じ形）。

```sh
herdr worktree create --branch <lane> --base main --label <LANE> --no-focus
# 返り値の worktree path と workspace id / root pane id を使う
```

既存 worktree を開き直す場合:

```sh
herdr worktree open --branch <lane> --label <LANE> --no-focus
```

### 2. OpenCode worker を起動して attach

```sh
# root pane に agent を起動（pane は対話プロンプトの shell であること）
herdr agent start <worker-name> --kind opencode --pane <pane-id> --timeout 90000
```

worker を relay に登録する:

```sh
relay worker register <worker-name> --role <role> --runtime <pane-id> --cwd <worktree-path>
```

session を attach する（`agent_attach` は OpenCode plugin の custom tool）。
`--session` は最初のターンまで永続化されないため、**agent 自身に呼ばせる**のが確実:

```sh
herdr agent prompt <worker-name> \
  'Call the agent_attach tool with worker_id="<worker-name>" and pane_id="<pane-id>". Reply one line.'
```

確認:

```sh
relay worker status <worker-name>   # opencode_session_id が入り state が動けば OK
```

### 3. ルートタスクを作り、統合エージェントに委任する

```sh
relay task add "<program の目的・acceptance・hard constraint>" \
  --title <LANE>-ROOT --priority <N> --role <role> --parent <上位 root> --plan <PLAN>
```

統合エージェントへミッションを durable message で渡す。必ず次を含める:

- **責任範囲**: 自分の subtree 全体（decomposition / dependency / child worktree / child 統合 / acceptance / evidence）
- **merge 分担**: 自分の subtree の merge は自分。**main への merge は上位**（merge-ready な branch + 統合証拠を渡す）
- **並列化の指示**: 「並列化できる仕事は並列化せよ。子 task を早期に並列投入し、`--depends-on` で DAG を表現せよ」
- **runtime**: OpenCode 限定
- **失敗時**: block/note して具体論点を返す

```sh
relay send <worker-name> '<mission>'
```

### 4. 統合エージェントは子を並列分解する

統合エージェントは root を claim したら、いきなり全部実装しない。
architecture survey → 最小の interface 固定 → 子 task を並列投入。

- `relay task add ... --parent <root> --role <child-role> --depends-on T1,T2`
- **依存が `done` になるまで downstream を runnable にしない**（「まだ早いので release」で調整しない）
- 子 task の note に `scope / expected files / inputs / outputs / dependencies / acceptance` を書く
- 同じ file を複数 worker が触るなら、**先に interface を分離**するか **child worktree を切る**

### 5. さらに下へ worktree を切る（再帰）

統合エージェントは子用に worktree を追加で切ってよい（同じ手順 1–2）。深いレーンでは
「worktree → その中の worktree」というネストが起きるが、relay から見れば全 worker は peer、
階層は task subtree で表現される。

```sh
herdr worktree create --branch <child-lane> --base <parent-lane> --label <CHILD> --no-focus
```

### 6. 統合とマージ

- 統合エージェント: 子の branch を自分のレーンブランチへ統合 → combined gate → 自分の root を submit
- Top-Level: レーンブランチを main へ merge（path-scoped、combined gate 実行）→ 人間へ program 単位で報告

### 6.1 landing の直列化（構造的リスク）

**問題**: 1 ブランチに複数 task の commit を載せ、そのうち 1 つがまだ in-flight だと、
done になった他の task の commit が「ブランチ全体をマージできない」ため landing されず滞留する。
完了したのに成果が main に入らない、という見えにくい直列化。

**これは worktree のトポロジ問題ではない。** 本質は **branch 粒度と landing 規律**の問題で、
「worktree をさらに切れば自動的に直る」類ではない。worktree を 1 worker 1 本に切ると
結果的に 1 task 1 branch になりやすい、というだけ。逆に、worktree を切っていても
1 branch に複数 task を載せれば同じ滞留が起きる（実際 perf/bgp で起きた）。

**根因**: 1 branch = 複数 task。→ 対策は branch 粒度を task に合わせること。

**対策（worker 側）**:
- 「完了した task」と「進行中 task」は**別ブランチに分ける**。1 branch 1 task が原則。
- 完了したら即 `relay submit` して、統合エージェントが拾える状態にする。
- どうしても同一ブランチに載るなら、完了 task の commit を先頭にまとめ、in-flight の commit と混ぜない。

**対策（統合エージェント側・救済）**:
- 既に branch が混ざっている場合、done task の commit を in-flight とは**独立に cherry-pick で landing**:
  `git cherry-pick -x <sha> [<sha>...]`（`-x` で出所を記録）。
- まず衝突しにくいもの（docs / bench / 独立ファイル）から入れる。production code は gate を通してから。
- cherry-pick 後も branch は in-flight task のために残す（force push しない）。

**検出**: 統合エージェントは定期的に各レーンブランチの
`git log --oneline main..<branch>` を確認し、**state=done の task に対応する commit が未マージで滞留していないか**を見る。

## 並列化の判断

```
同じ file を触る？ ── yes ──> interface を先に固定 or worktree を分ける
        │
        no ──> 並列で流す（worker を増やす）
```

- 独立した測定・benchmark・review は file 衝突が無ければ並行可
- 「便利そう」だけの並列化はしない。contract/type 境界が未確定なまま複数実装を走らせない
- reviewer は実装者と分ける（自己 approve 禁止）

## よく使うコマンド

```sh
herdr worktree create --branch <b> --base main --label <L> --no-focus
herdr worktree list
herdr pane list --workspace <w>
herdr agent start <name> --kind opencode --pane <p> --timeout 90000
herdr agent prompt <name> '<text>' --wait --timeout 120000
herdr agent get <name>
herdr pane move <pane> --new-workspace --label <L> --no-focus   # 狭い workspace から退避

relay worker register <name> --role <r> --runtime <pane> --cwd <path>
relay worker status <name>
relay session list
relay task add "..." --title <T> --parent <P> --role <r> --depends-on T1,T2
relay task depend T3 T1 T2
relay claim <T> --worker <name>
relay note <T> "progress"
relay submit <T> --evidence "..."
relay send <worker> "message"
relay inbox --worker <name> --claim
relay status
```

## アンチパターン

- worktree ごとに relay daemon を起動する / 独立 `.relay/state.db` を作る
- worker の「done」や idle pane を task completion とみなす
- 依存を `--depends-on` で表現せず、worker が自分で release して順序を調整する
- 統合エージェントを飛ばして Top-Level が個別最適化タスクを直接管理する
- 同じ file を複数 worker に同時編集させる
- `git add -A` / `git add .` / `git reset --hard` / destructive checkout
- 理由なく Codex worker を使う（operator の明示が無い限り OpenCode）
- merge を統合エージェントに任せず、各 worker が main を直接いじる

## チェックリスト

- [ ] レーン worktree + workspace を作った（`herdr worktree create`）
- [ ] worker を OpenCode で起動し attach した（`opencode_session_id` を確認）
- [ ] role を register した
- [ ] root task を parent 付き・role 付きで作った
- [ ] 統合エージェントへ責任範囲・merge 分担・並列化指示を durable で渡した
- [ ] 子 task を `--depends-on` の DAG で並列投入した
- [ ] 統合エージェントが自分の subtree を merge し、Top-Level が main へ merge する分担になっている
- [ ] **1 branch 1 task**（完了 task と in-flight task を同一 branch に混ぜていない）
- [ ] 各レーンブランチで **done task の commit が滞留していない**（`git log main..<branch>` で確認）
- [ ] daemon は 1 つ、commit は path-scoped
