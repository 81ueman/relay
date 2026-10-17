# ISH-827 — Coding Kit の再現 PoC（ARM64 Docker Sandbox + dsh/Rust/Git/labctl）

**Issue:** ISH-827 (`[sandbox][env] Reproducible lightweight ARM64 Coding Sandbox with
dsh/Rust/Git/labctl`) — ISH-821 設計の「Coding Kit」ゲート。**Date:** 2026-10-17 (UTC),
macOS host。 **Kind:** research / PoC evidence record。Not a spec。

目的は、Docker Sandboxes の検証済み機構（**clone mode + Kit/Template**）だけを使って、
Ishiul の実タスクに必要な**軽量 ARM64 Coding Sandbox** を再現できることを確かめること。
具体的には、kit から sandbox を作り、その中で実 `dsh 0.2.0-rc.2` headless Run・
実 Ishiul の `cargo test`・Git over SSH・host 隔離・Shared Lab 到達性を実測する。
NOS image と containerlab は持ち込まない（それは Shared Lab 側 = ISH-824/825/844）。

成果物は repo 内の Kit 実体 [`sandbox/coding-kit/`](../../sandbox/coding-kit/spec.yaml)
（`schemaVersion: "2"`, `kind: sandbox`, `extends: shell`）である。

> 注記: 個人識別情報（ホスト名・SSH 鍵のメールアドレス等）はマスクしている。
> 掲載する `sbx-cs-…` は **secret ではない** placeholder（実値は host 側に留まる）。

## 1. 環境

| 項目 | 値 |
| --- | --- |
| Host | macOS 26.2, Darwin 25.x, arm64 (Apple silicon), 10 CPU / 32 GiB |
| Docker Sandboxes | `sbx v0.48.0` (commit `5caf923e0587d376848f6f388eca3e0f5ca00e2d`), daemon healthy |
| Base image | `docker/sandbox-templates:shell-docker`（kit は `extends: shell`） |
| Coding Sandbox | `ish827-kit`（Ubuntu, kernel `7.0.14`, aarch64, **4 CPU / 4 GiB** — kit の `sandbox.resources` が実際に適用されることを `sbx inspect --json` で確認） |
| Clone source | host の ishiul **main checkout** `/Users/81ueman/ghq/github.com/81ueman/ishiul`（linked worktree ではない） |
| 実行 HEAD | `ff7d7dbe67ba15d8da63075e68490009ce7e22fb`（`main`） |
| dsh | `0.2.0-rc.2`（`@deepseek-ai/dsh`） |
| Rust | `cargo 1.99.1` / `rustc 1.99.1`（rustup minimal, stable） |
| Python / PyYAML / uv | `Python 3.14.4` / `PyYAML 6.0.3` / `uv 0.9.26` |
| Git / Docker / Node | `git 2.53.0` / `Docker 29.8.1`（sandbox 専有 Engine）/ `node v22.22.1` |

Kit の検証（repo 内）:

```console
$ sbx kit validate ./sandbox/coding-kit
  ✓ ./sandbox/coding-kit — valid (directory)          # exit 0
$ sbx kit inspect ./sandbox/coding-kit
  Name:         ishiul-coding
  Kind:         sandbox
  Schema:       v2
  Policies:
    Network:    26 allow, 0 deny
    Commands:   5 install, 1 startup, 0 init files
    Files:      1 home, 0 workspace
```

## 2. 実施結果

### 2.1 kit からの sandbox 再現（clone mode）

```console
$ sbx create --clone --name ish827-kit ./sandbox/coding-kit \
    /Users/81ueman/ghq/github.com/81ueman/ishiul
  ✓ workspace — Git repository at /Users/81ueman/ghq/github.com/81ueman/ishiul
SANDBOX
  Name:       ish827-kit
  Agent:      ishiul-coding
  Kit:        ./sandbox/coding-kit
  Workspace:  /Users/81ueman/ghq/github.com/81ueman/ishiul (rw)
  Image:      docker/sandbox-templates:shell-docker
  CPU:        4
  Memory:     4 GiB
  Git daemon:  git://127.0.0.1:49224/ishiul
  Remote:      sandbox-ish827-kit                                   # exit 0
# real 1m41s（install 5 コマンド込み）
$ sbx inspect ish827-kit --json          # kit の値が実際に効いていることを確認
  memory 4096m   cpus 4   kits ['…/sandbox/coding-kit']
```

> fix round 1（finding 4）: 以前の sandbox は host 既定の 8 GiB で作られており、コミット済み
> `memory: 4g` が実際に適用される証拠が無かった。supersede した旧 sandbox を削除し、
> **コミット済みの kit から作り直して** `Memory: 4 GiB` / `sbx inspect memory=4096m` を確認した
> （`free -m` でも `Mem total=3989 MiB`）。

install は kit の `setup.install` が行う（npm→apt→rustup→uv→PATH 固定）。
作成後の実バージョン:

```console
$ sbx exec ish827-kit bash -lc 'for c in dsh cargo rustc uv python3 labctl git docker node npm; do printf "%s: " "$c"; "$c" --version 2>&1 | head -1; done'
dsh: 0.2.0-rc.2
cargo: cargo 1.99.1 (5f94df478 2026-08-27)
rustc: rustc 1.99.1 (58cf8f9c3 2026-10-13)
uv: uv 0.9.26
python3: Python 3.14.4
labctl: usage: labctl [-h] {deploy,inspect,exec,destroy,purge} ...
git: git version 2.53.0
docker: Docker version 29.8.1, build 4a63305
node: v22.22.1
npm: 9.2.0
$ python3 -c "import yaml; print(yaml.__version__)"
6.0.3
```

`labctl` は kit の `setup.startup` が、clone 済み workspace の
`labs/labctl/labctl.py` を `/usr/local/bin/labctl` へ install する（**labctl の二重管理をしない**）。

### 2.2 NOS image を持たず、通常タスクが軽量

```console
$ sbx exec ish827-kit bash -lc 'docker info --format "{{.DockerRootDir}}"; docker images; df -h /var/lib/docker | tail -1'
Docker Root Dir: /var/lib/docker
IMAGE   ID             DISK USAGE   CONTENT SIZE   EXTRA     # image なし
/dev/vdd        9.8G  856K  9.3G   1% /var/lib/docker
$ sbx exec ish827-kit bash -lc '(docker images | grep -Ei "ceos|srlinux|nokia|arista" && echo NOS-IMAGE-PRESENT) || echo "NO NOS IMAGE in coding sandbox"'
NO NOS IMAGE in coding sandbox
$ sbx exec ish827-kit bash -lc '(command -v containerlab && echo CONTAINERLAB-PRESENT) || echo "no containerlab binary"'
no containerlab binary
```

`crate` 依存と Rust target 以外の重いものは無い。`cargo test` を 2 crate 分実行した後の
root overlay 使用量は `1.7G / 20G`、`target/` は `420M`（§2.5）。

### 2.3 host 隔離（否定テスト）

```console
$ sbx exec ish827-kit bash -lc 'echo HOME=$HOME; mount | grep /run/sandbox/source; touch /run/sandbox/source/X'
HOME=/home/agent
host on /run/sandbox/source type virtiofs (ro,nosuid,nodev,relatime)
touch: cannot touch '/run/sandbox/source/X': Read-only file system

# host-absolute（= host 側）を直接 probe。`~` は VM 内なので vacuous:
absent: /Users/81ueman/ISH827_HOST_HOME_SENTINEL.txt
absent: /Users/81ueman/Documents/ISH827_HOST_DOCUMENTS_SENTINEL.txt
absent: /Users/81ueman/.ssh/id_ed25519
absent: /Users/81ueman/.orbstack/run/docker.sock
absent: /private/var/folders/…/ish827-other-repo/secret.txt

$ ls -l /var/run/docker.sock   → /run/docker.sock（sandbox 専有 Engine）
$ grep -rIl "BEGIN OPENSSH PRIVATE KEY" /home/agent /tmp | wc -l   → 0
```

host 側の sentinel/repo は実行前に存在を確認済み（host 側 `ls -l`）。clone は**別の
writable copy** で、sandbox の commit は host に現れない（§2.6）。

### 2.4 Git over SSH（forwarded agent）

kit の `files/home/.ssh/config` が `github.com` を公開の `ssh.github.com:443` へ向ける
（sandbox の egress policy に `:22` ルールが無いため。ISH-822 §8）。

```console
$ sbx exec ish827-kit bash -lc 'echo $SSH_AUTH_SOCK; ssh-add -l'
SSH_AUTH_SOCK=/run/ssh-agent.sock
256 SHA256:NS4st6… <redacted> (ED25519)          # host の forwarded agent。鍵ファイルは無い
$ sbx exec ish827-kit bash -lc 'GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new" git ls-remote git@github.com:81ueman/ishiul.git HEAD refs/heads/main'
ff7d7dbe67ba15d8da63075e68490009ce7e22fb  HEAD
ff7d7dbe67ba15d8da63075e68490009ce7e22fb  refs/heads/main        # exit 0
$ … git fetch --depth=1 git@github.com:81ueman/ishiul.git main
 * branch  main -> FETCH_HEAD                                     # read-only, exit 0
```

`git@github.com` がそのまま通る（config 経由で 443）。

### 2.5 実 Ishiul の `cargo test`

clone 済みの実コード（HEAD `ff7d7dbe`）で、小〜中規模の維持 crate を実行した。

```console
$ sbx exec ish827-kit bash -lc 'cd "$WORKSPACE_DIR" && cargo test -p dataplane-schedule'
    Finished `test` profile … in 12.19s
running 9 tests
test cancel_vs_complete_consistent_state ... ok
… 9 passed; 0 failed; 0 ignored                # exit 0, real 12.4s

$ … cargo test -p dataplane-core --lib
running 115 tests
test result: ok. 115 passed; 0 failed; 0 ignored   # exit 0, real 15.0s
```

### 2.6 実 `dsh` headless Run

host に `DEEPSEEK_API_KEY` が無いため、ISH-822 と同様に host の Ollama Cloud provider
（OpenAI 互換 API 上の DeepSeek モデル）を `--patch` overlay で選択し、鍵は
`sbx secret set-custom` の placeholder 経由（実値は VM に入らない）。

```console
$ sbx secret set-custom --sandbox ish827-kit --host ollama.com \
    --env OLLAMA_CLOUD_V41_API_KEY --command /abs/get-ollama-key.sh
  Generated placeholder:  <placeholder>                          # secret ではない

$ sbx exec -e OLLAMA_CLOUD_V41_API_KEY=<placeholder> ish827-kit bash -lc \
    'cd "$WORKSPACE_DIR"; DSH_PERMISSION_MODE=workspace-write \
     dsh --profile headless --patch /home/agent/dsh-overlay.yml --json "$TASK"'
DSH_EXIT=0
session session-2093ac35-20a2-4a96-b180-b66f635961bd
status (turn/step) ×11
thinking ×4
text ×2
tool_call read call_02az27xf
tool_call bash call_i9mcxyz3
tool_call write call_6n4yd8zm
tool_call bash call_wv9mh7gp     # git add && git commit
tool_call bash call_n7do0o4k
tool_result ×5
{"type":"final","text":"DSH_KIT_OK"}
$ git log --oneline -1
faf828bd7 ISH-827: sandbox dsh commit
$ git rev-parse HEAD
faf828bd7b069ef28ec5ef1ce8706b9ef6fd947e
```

JSONL は `session → status → tool_call → tool_result → final` を欠落なく含む。この Run では
dsh が sandbox clone の `main` に直接 commit した（使い捨ての private clone 内。host `main` は
不変。先行 run では branch `devin/ish-827-sandbox-dsh` に commit していた）。

**host 回収:** sandbox の commit は host 側で fetch できる（clone mode の `git daemon`）:

```console
$ git -C /Users/81ueman/ghq/github.com/81ueman/ishiul fetch sandbox-ish827-kit
 * [new branch]  main -> sandbox-ish827-kit/main
   ff7d7dbe..faf828bd  main -> refs/sandboxes/ish827-kit/main
```

**host 不変:** fetch 後も host main は `ff7d7dbe` のまま、`ish827-note.txt` は host に無い
（clone は別 copy）。

### 2.7 Shared Lab 到達性（labctl 配布 + 固定 host port の allow）

kit は Shared Lab の **公開 host port を固定で pin する**。`host.docker.internal` /
`localhost` を port 指定なしで allow すると host の全 TCP port（TCP の docker API、sshd、
他 sandbox の `0.0.0.0` publish 等）が到達可能になるため、Scope 3（汎用の host network 全開放は
不要）に反する。両 alias を pin するのは、egress proxy が publish 済み binding を
**`localhost:<port>` として認可**し、client は `host.docker.internal:<port>` へ dial するため:

```yaml
permissions:
  network:
    allow:
      …
      - host.docker.internal:49170   # clab-api-server HTTPS (host 49170 -> 8090)
      - localhost:49170
      - host.docker.internal:18002   # SR Linux gNMI TLS (1:1)
      - localhost:18002
```

認可の確認（daemon の authorizer、read-only）:

```console
$ for r in host.docker.internal:49170 localhost:49170 host.docker.internal:18002 localhost:18002; do sbx policy check network --sandbox ish827-kit "$r"; done
Allowed:  host.docker.internal:49170
Allowed:  localhost:49170
Allowed:  host.docker.internal:18002
Allowed:  localhost:18002
```

Shared Lab `ish824-lab` の固定 publish（`0.0.0.0:49170 -> 8090`）に対し、Coding Sandbox から
実 API へ到達する:

```console
$ sbx exec ish827-kit bash -lc 'H=https://host.docker.internal:49170; …'
health: 200   {"status":"healthy",…,"version":"v0.8.0"}
swagger: 200  Containerlab API Server 1.0
login: 200    {"token":"eyJ…"}            # JWT, len 172
$ … LABCTL_USER=agent LABCTL_PASSWORD=… labctl inspect --json --api $H --insecure
{}                                        # exit 0（lab なし = 空）
```

**否定 probe（finding 2 の本題）:** Shared Lab 以外の host port は拒否される:

```console
$ sbx policy check network --sandbox ish827-kit host.docker.internal:2375   → Denied
$ sbx policy check network --sandbox ish827-kit host.docker.internal:22     → Denied
$ sbx policy check network --sandbox ish827-kit localhost:11434             → Denied
$ # in-sandbox:
example.com http=403
2375 http=403
11434 http=000            # NO_PROXY 経由で sandbox 自身の loopback、listener なし
```

> 注意（`sbx policy check` は runtime と一致しないことがある）: `policy check network --sandbox
> ish827-kit host.docker.internal:49170` は **静的には Allowed** と出るが、runtime の認可 key は
> `localhost:<port>`。したがって allow は **両 alias + 明示 port** で pin する。

**egress 境界の正確な記述（finding 3）:** 到達可否は kit の allowlist **単独ではなく**、
operator のグローバル policy（本 host は Balanced、`local-policy` = 194 allow、`applies_to: all`）と
kit の rules の **和** で決まる。kit は Scope 3 のとおり「Balanced を起点に必要先を足す」もの:

```console
$ sbx policy check network --sandbox ish827-kit chatgpt.com      → Allowed   # kit には無い（global）
$ sbx policy check network --sandbox ish827-kit example.com      → Denied
$ sbx policy check network host.docker.internal:2375             → Denied    # global context では host は全拒否
```

したがって「egress は kit の 24 host に絞られる」という記述は誤りで、正しくは
**「グローバル Balanced policy ∪ kit の allow」**。グローバル policy は operator 前提条件である。

### 2.8 VM リソース初期値の実測

| 軸 | 実測 |
| --- | --- |
| CPU | sandbox `nproc` = **4**。`cargo test -p dataplane-core --lib` は user 31.9s / real 15.0s |
| Memory | idle used ~314–468 MiB。`cargo test -p dataplane-core --lib` の **peak used = 745 MiB** |
| Disk（root overlay） | 20 GiB 中 2 crate の build 後で **1.7 GiB** 使用（`target/` 420 MiB） |
| Disk（sandbox 専有 Engine） | `/dev/vdd` 9.8 GiB、NAS image なしで **856 KiB** |
| 内訳 | `~/.rustup` 497 MiB、`~/.cargo` 61 MiB、`target/` 420 MiB |

これに基づき kit の `sandbox.resources` を **cpu: 4 / memory: 4g** とした
（measured peak 745 MiB に対し ~5× の余裕）。disk は host 設定 `sandbox.disk.dockerVolume`
（既定 10g）が管理する。

**コミット済みの値が実際に適用されることを確認**（finding 4）: コミット済み kit からの
`sbx create` は `Memory: 4 GiB`、`sbx inspect ish827-kit --json` は `memory: 4096m` / `cpus: 4`、
sandbox 内 `free -m` は `Mem total=3989 MiB`（=4 GiB VM の実測 total）。以前の sandbox は
host 既定の 8 GiB で作られており、この値は適用されていなかった。

### 2.9 後片付け

```console
# fix round 1: supersede した 8 GiB の旧 sandbox を削除し、コミット済み kit から作り直した
$ sbx rm --force ish827-kit
Removed sandbox ish827-kit
$ sbx stop ish824-lab; sbx stop ish827-kit            # どちらも保持（削除は sbx rm --force）
$ sbx secret rm --placeholder <placeholder> --sandbox ish827-kit -f
$ sbx secret ls → No secrets found
$ sbx ls → ish822-poc / ish824-lab / ish827-kit すべて stopped
```

今回の到達性テストは Shared Lab の既存固定 publish（`0.0.0.0:49170 -> 8090`）を使ったため、
追加 publish はしていない（旧 round で足した `49171` は unpublish 済み）。`--clone` が host main
checkout に足す `sandbox-ish827-kit` remote は sandbox の stop で sbx 自身が外す
（`Git remote sandbox-ish827-kit is restored when the sandbox next starts.`）。sandbox の commit は
`refs/sandboxes/ish827-kit/main`（`faf828bd`）として host に回収済み。host sentinel と検証用 repo は
削除した。

> 副作用（記録）: 到達性テストのため停止中の `ish824-lab` を start / stop した。sbx は停止/再開で
> **ephemeral loopback publish の host port を再割当て**する。固定 host port の publish
> （18001/18002/49170 等）は不変。`ish824-lab` は ISH-824 の artifact で、これらのポートは PoC 用に
> 再 publish 可能。

## 3. Done-when 判定

| Done-when | 判定 | 根拠 |
| --- | --- | --- |
| ARM64 Kit/Template から軽量 Coding Sandbox を再現、dsh headless JSONL/Git/Rust tests 実行 | **PASS** | §2.1 kit から作成、§2.6 実 dsh headless（exit 0 / JSONL / commit）、§2.4 Git SSH、§2.5 実 cargo test |
| cEOS/SR Linux image が Coding Sandbox に含まれず、通常 Task が軽量 | **PASS** | §2.2 image 0・containerlab なし・Engine 856 KiB |
| SSH Agent が Coding 側では正常に使え、host 秘密ファイル・Docker 等は不可 | **PASS** | §2.4 forwarded agent で Git SSH、§2.3 host 絶対パス/別 repo/host docker socket 不可・鍵ファイル無し |
| labctl 導入可能な配布手順と Shared Lab 到達性の設定が確認できる | **PASS** | §2.1 `labctl` を workspace から install、§2.7 別 sandbox から API health/swagger/login 200 と `labctl inspect` |
| 公式の既存 Kit/Template 活用、独自 Runner Framework 無し | **PASS** | `kind: sandbox` + `extends: shell`（公式 sbx kit 機構）、image は公式 `docker/sandbox-templates:shell-docker`。独自 VM/Runner は追加していない |

## 4. 未検証 / Not measured

- **`cargo test --workspace` 全体**（`dataplane-engine` / `control` / `vendor-config-core` は
  88k–118k 行）は sandbox 内で実行していない。§2.5 は `dataplane-schedule`（9 tests）と
  `dataplane-core --lib`（115 tests）。4 GiB はこの実測に基づく**初期値**であり、全 workspace
  build には不足しうる。
- **DeepSeek 公式 endpoint（`api.deepseek.com`）での dsh Run** は未検証（host に
  `DEEPSEEK_API_KEY` が無い）。§2.6 は Ollama Cloud 上の DeepSeek モデル。kit は
  `api.deepseek.com` を allow 済み。
- **cargo build のピーク RSS** は 2 crate のみ。大 crate の並列 rustc/link は未測定。
- **SSH agent の sandbox 単位隔離**: ISH-824 §3.5 のとおり `ssh.agentForwardingEnabled` は
  host 全体設定で、per-sandbox に無効化できない。本 kit も host agent を forwarded する
  （§2.4 で鍵ファイルは無いが、agent 署名は使える）。恒久策は Owner 判断（ISH-824 §4）。
- **実 GitHub push / PR / Linear 変更**は行っていない（既存 Owner 承認ルール）。
- **Template 経路**（`sbx template save` で保存した image からの起動）は未検証。
  Kit からの毎回 install は §2.1 のとおり約 2m19s で、初期 Kit としては十分。
- `sbx kit` は **experimental** であり、`spec.yaml` 形式・CLI は将来変わりうる。

## 5. 推奨（次アクション）

1. **ISH-828（Relay Sandbox lifecycle）** は本 kit を `git+https://github.com/81ueman/ishiul.git#ref=<sha>&dir=sandbox/coding-kit`
   で参照し、`sbx create --clone` する。kit は Relay に依存しない。
2. **dsh provider は kit に入れない**: provider/model と `DEEPSEEK_API_KEY` の注入は
   deployment（credential binding）の責務。kit は `api.deepseek.com` を allow するだけに留める。
3. **`cargo test --workspace` 用の memory 再チューニング**: 最初の実タスクで peak を測り、
   4 GiB で足りなければ `sandbox.resources.memory` を上げる。
4. **SSH agent forwarding** の恒久策（host 全体設定の扱い）は ISH-824 §4 の Owner 判断に合わせる。
5. `sbx kit push`（OCI）と `sbx kit sign` による配布は、Kit が安定してから。現状は repo 内
   ディレクトリ参照で十分。

## 6. 関連

- ISH-821（親設計）、ISH-822（`dsh`/SSH/隔離 PoC）、ISH-824（Shared Lab + API）、
  ISH-825（image 再利用）、ISH-844（`labs/labctl/`）、ISH-828/829/830（後続）。
- `../labs/labctl/README.md`（本 kit が PyYAML と `labctl` を provision する）。

## 7. Fix round 1（PR #712 first review）

独立レビュー（NG, head `11cacd8e`）の 5 findings への対応:

1. **root-layout gate（ISH-749）**: 新 top-level `sandbox/` を `scripts/root-layout-policy.json`
   の `directories` に追加。`python3 scripts/root-layout-gate.py check` → `40 tracked top-level
   entries, 0 violations`、`python3 scripts/tests/test_root_layout_gate.py` → `Ran 10 tests … OK`。
2. **bare host/localhost allow**: `host.docker.internal` / `localhost`（port なし）を削除し、
   Shared Lab の固定 port `49170`（API）と `18002`（gNMI）だけを **両 alias + 明示 port** で pin。
   非 Shared Lab port（`2375`/`22`/`11434`）は `policy check` で Denied、sandbox 内 curl も
   403/000（§2.7）。到達性の positive probe も再実行（health/swagger/login 200）。
3. **egress 境界の記述**: 「kit の allowlist に絞られる」を撤回し、正しくは
   **グローバル Balanced policy（`local-policy` 194 allow, `applies_to: all`）∪ kit** と明記。
   `chatgpt.com` が Allowed（kit 外）／`example.com` が Denied の negative probe を記録（§2.7）。
   operator のグローバル policy を前提条件として明記。PR body の Security review / Threat model も同様に修正。
4. **`memory: 4g` 未検証**: 8 GiB の旧 sandbox を削除し、コミット済み kit から作り直して
   `Memory: 4 GiB` / `sbx inspect memory=4096m` / `free -m total=3989 MiB` を確認（§2.1, §2.8）。
   その sandbox で `cargo test -p dataplane-schedule`（9 passed）と dsh headless Run
   （exit 0, commit `faf828bd7b069ef28ec5ef1ce8706b9ef6fd947e`）を再実行。
5. **secret_scan の placeholder リテラル**: evidence 内の `sbx-cs-…` 実文字列を `<placeholder>` に置換
   （sandbox 側の scan finding を除去）。
