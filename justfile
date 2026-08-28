set shell := ["bash", "-euo", "pipefail", "-c"]

# `just release` writes $GITEA_REGISTRY_TOKEN into a throwaway DOCKER_CONFIG instead of
# running `docker login`: on macOS the keychain store can only add, never replace, so an
# entry left by any other project kills the login with -25299 and `docker logout` can't clear it
server_image := "gitea.susie.se/coaster/miu2d-server"
web_image := "gitea.susie.se/coaster/miu2d-web"
game_image := "gitea.susie.se/coaster/miu2d-game-"

_default:
    @just --list --unsorted --list-heading '' --list-prefix='- '

# install all dependencies
setup:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "→ ensuring env files"
    [ -f .env ] || cp .env.example .env
    [ -f packages/server/.env ] || cp packages/server/.env.example packages/server/.env
    echo "→ installing node dependencies"
    bun install
    echo "→ generating prisma client"
    bun run --filter=@miu2d/server db:generate
    echo "→ building shared types"
    bun run --filter=@miu2d/types build
    echo "✓ setup complete"

# start db container
db verb:
    @just _db-{{verb}}

[private]
_db-up:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "→ starting db"
    env -u DOCKER_DEFAULT_PLATFORM docker compose up -d db
    echo "✓ container up (postgres :5533)"

[private]
_db-down:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "→ stopping containers"
    docker compose down
    echo "✓ containers stopped"

[private]
_db-migrate:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "→ running migrations"
    bun run --filter=@miu2d/server db:migrate
    echo "✓ migrations applied"

[private]
_db-migrate-dev:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "→ running dev migrations (prisma migrate dev)"
    bun run --filter=@miu2d/server db:migrate:dev
    echo "✓ done"

[private]
_db-seed:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "→ seeding database"
    bun run --filter=@miu2d/server db:seed
    echo "✓ seed complete"

[private]
_db-studio:
    bun run --filter=@miu2d/server db:studio

[private]
_db-generate:
    bun run --filter=@miu2d/server db:generate

# start full dev stack (web :5274 + server :4100)
dev: (db "up")
    bun run dev

# start server only
dev-server: (db "up")
    bun run dev:server

# build production web bundle
build:
    #!/usr/bin/env bash
    set -euo pipefail
    log=$(mktemp); trap 'rm -f "$log"' EXIT
    run_quiet() {
        local label="$1"; shift
        echo "→ $label"
        "$@" >"$log" 2>&1 || { local rc=$?; echo "✗ $label failed:" >&2; cat "$log" >&2; exit $rc; }
    }
    run_quiet "building shared types"  bun run --filter=@miu2d/types build
    run_quiet "generating prisma client" bun run --filter=@miu2d/server db:generate
    run_quiet "generating trpc types"  bun run --filter=@miu2d/server gen:trpc
    run_quiet "building web"           bun run --filter=@miu2d/web build
    echo "✓ build complete"

# build rust converter binaries
build-converter:
    #!/usr/bin/env bash
    set -euo pipefail
    log=$(mktemp); trap 'rm -f "$log"' EXIT
    echo "→ building miu2d-converter (release)"
    cargo build --release --manifest-path packages/converter/Cargo.toml >"$log" 2>&1 || {
        echo "✗ cargo build failed:" >&2; cat "$log" >&2; exit 1
    }
    echo "✓ binaries in packages/converter/target/release/"

# run biome lint + format check
lint:
    bun run check
    bash packages/server/scripts/check-router-providers.sh

# convert all game resources (encoding + asf + mpc + map + video), deletes originals
convert:
    #!/usr/bin/env bash
    set -euo pipefail
    read -r -p "convert ALL resources and DELETE originals afterwards? [y/N] " ans
    [[ "$ans" == [yY] ]] || { echo "aborted"; exit 0; }
    cargo run --release --manifest-path packages/converter/Cargo.toml --bin convert-all -- resources --delete-originals

# verify asf/mpc → msf conversion is lossless
convert-verify:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "→ verifying asf/msf lossless"
    cargo run --release --manifest-path packages/converter/Cargo.toml --bin verify -- resources/asf
    echo "→ verifying mpc/msf lossless"
    cargo run --release --manifest-path packages/converter/Cargo.toml --bin verify_mpc -- resources/mpc

# 构建并推送镜像 — 不带参数进 fzf 多选; 也可 just release web server
release *targets:
    #!/usr/bin/env bash
    set -euo pipefail
    menu=(
        "all             5 个镜像全推"
        "server          {{server_image}}"
        "web             {{web_image}} (含 dashboard)"
        "game-yueying    {{game_image}}yueying — 素材 + DB 种子"
        "game-sword1     {{game_image}}sword1"
        "game-sword2     {{game_image}}sword2"
    )
    picked="{{targets}}"
    from_menu=0
    if [ -z "$picked" ]; then
        command -v fzf >/dev/null || {
            echo "✗ 没装 fzf — brew install fzf, 或者直接写目标: just release web"
            printf '  %s\n' "${menu[@]}"
            exit 1
        }
        # 外观交给 $FZF_DEFAULT_OPTS; 这里只要多选和一行说明
        picked=$(printf '%s\n' "${menu[@]}" \
            | fzf -m --header='Tab 多选, Enter 确认, Esc 取消' \
            | awk '{print $1}' | tr '\n' ' ')
        [ -n "$picked" ] || { echo "aborted"; exit 0; }
        from_menu=1
    fi
    build=()
    for x in $picked; do
        case "$x" in
            server|web|game-yueying|game-sword1|game-sword2) build+=("$x") ;;
            all)
                # 只在命令行直接敲 all 时问一次: 五个镜像里 server 那条是 --no-cache 双架构,
                # 打错字的代价是十几分钟; 菜单里选的时候已经看见列表了, 不再多问
                if [ "$from_menu" -eq 0 ]; then
                    read -r -p "构建并推送全部 5 个镜像? [y/N] " ans
                    [[ "$ans" == [yY] ]] || { echo "aborted"; exit 0; }
                fi
                build=(server web game-yueying game-sword1 game-sword2)
                break
                ;;
            *) echo "✗ 未知目标 $x — 跑 just release 看可选项"; exit 1 ;;
        esac
    done
    # dirty builds once poisoned the buildx cache with a broken bundle layer — refuse outright
    [ -z "$(git status --porcelain)" ] || { echo "✗ uncommitted changes — commit first"; exit 1; }
    : "${GITEA_REGISTRY_TOKEN:?未设置 — 在放其他 registry token 的地方加一行, scope 要 write:package}"
    export BUILDX_CONFIG="${BUILDX_CONFIG:-$HOME/.docker/buildx}"
    export DOCKER_CONFIG="$(mktemp -d)"
    trap 'rm -rf "$DOCKER_CONFIG"' EXIT
    # cli plugins are looked up under DOCKER_CONFIG too, so an empty one loses `docker buildx`
    ln -s "$HOME/.docker/cli-plugins" "$DOCKER_CONFIG/cli-plugins"
    auth=$(printf 'dcsp:%s' "$GITEA_REGISTRY_TOKEN" | base64 | tr -d '\n')
    printf '{"auths":{"gitea.susie.se":{"auth":"%s"}}}' "$auth" > "$DOCKER_CONFIG/config.json"
    # multi-arch manifest needs a docker-container builder; the classic docker driver can't export one
    docker buildx inspect miu2d >/dev/null 2>&1 || docker buildx create --name miu2d --driver docker-container
    # the sub-recipes inherit DOCKER_CONFIG through the environment, so credentials are written once
    for x in "${build[@]}"; do
        case "$x" in
            server)  just _release-server ;;
            web)     just _release-web ;;
            game-*)  just _release-game "${x#game-}" ;;
        esac
    done
    echo ""
    echo "── 上线: NAS (192.168.1.63) 的 /volume1/docker/miu2d 下 ──"
    echo "  sudo docker compose pull && sudo docker compose up -d"

# 私有 — 凭据、buildx builder、干净工作区的检查都由 `just release` 备好
_release-server:
    #!/usr/bin/env bash
    set -euo pipefail
    hash=$(git rev-parse --short HEAD)
    echo "→ building {{server_image}} (amd64 + arm64) @ $hash"
    # --no-cache: a warm cache twice produced a broken image (poisoned bundle, then
    # rolldown mis-resolving @miu2d/types → shared/locales). the workspace-symlink
    # resolution is cache-sensitive; a clean build is the only reliably-correct one
    docker buildx build --builder miu2d --no-cache --platform linux/amd64,linux/arm64 \
        --file packages/server/Dockerfile --target runner \
        --tag {{server_image}}:$hash --tag {{server_image}}:latest \
        --push .
    echo "✓ pushed {{server_image}}:$hash (amd64 + arm64)"
    echo "  验证: 本机 arm64 可 docker pull {{server_image}}:latest"
    echo "  验证: sudo docker ps | grep miu2d-server        # Up, not Restarting"
    # 别用 /trpc/auth.me —— 没有这个 procedure，恒 404，分不出好坏。这条穿透 nginx→server→db
    echo "  验证: curl -s -o /dev/null -w '%{http_code}\\n' http://localhost:8090/game/yueying/api/config   # 200"

_release-web:
    #!/usr/bin/env bash
    set -euo pipefail
    hash=$(git rev-parse --short HEAD)
    echo "→ building {{web_image}} (amd64 + arm64) @ $hash"
    # VITE_* / STATIC_ONLY are left at their Dockerfile defaults on purpose: verified
    # against the deployed image (no resource domain = same origin, nginx.conf not
    # nginx.static.conf). passing them explicitly would only create a second place
    # to keep in sync
    docker buildx build --builder miu2d --no-cache --platform linux/amd64,linux/arm64 \
        --file packages/web/Dockerfile --target runner \
        --build-arg COMMIT_HASH=$hash \
        --tag {{web_image}}:$hash --tag {{web_image}}:latest \
        --push .
    echo "✓ pushed {{web_image}}:$hash (amd64 + arm64)"

_release-game slug:
    #!/usr/bin/env bash
    set -euo pipefail
    hash=$(git rev-parse --short HEAD)
    [ -d "resources/{{slug}}" ] || { echo "✗ resources/{{slug}} not found"; exit 1; }
    echo "→ exporting {{slug}} seed from local db (needs: just db up)"
    (cd packages/server && bunx tsx --tsconfig tsconfig.dev.json scripts/export-game-seed.ts {{slug}})
    docker buildx inspect miu2d >/dev/null 2>&1 || docker buildx create --name miu2d --driver docker-container
    echo "→ building {{game_image}}{{slug}} (amd64 + arm64) @ $hash"
    # no --no-cache here (unlike `release`): this image is pure COPY with no
    # workspace/bundler resolution, so it has none of the non-determinism that
    # poisoned the server image's cache
    docker buildx build --builder miu2d --platform linux/amd64,linux/arm64 \
        --file docker/game-content.Dockerfile \
        --build-context assets=resources/{{slug}} \
        --build-context seed=.data/game-seeds \
        --build-arg SLUG={{slug}} --build-arg REV=$hash \
        --tag {{game_image}}{{slug}}:$hash --tag {{game_image}}{{slug}}:latest \
        --push docker/
    echo "✓ pushed {{game_image}}{{slug}}:$hash (amd64 + arm64)"
    echo "  验证: sudo docker logs miu2d-game-{{slug}}     # assets installed / up-to-date"
    # 种子只填空库(seed-games.ts: already present, skipped), 库里已有该 slug 就不会被覆盖
    echo "  验证: sudo docker logs miu2d-server | grep seed"
