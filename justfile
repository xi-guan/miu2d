set shell := ["bash", "-euo", "pipefail", "-c"]

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
    pnpm install
    echo "→ generating prisma client"
    pnpm --filter @miu2d/server db:generate
    echo "→ building shared types"
    pnpm --filter @miu2d/types build
    echo "✓ setup complete"

# start db + rustfs containers
db verb:
    @just _db-{{verb}}

[private]
_db-up:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "→ starting db and rustfs"
    docker compose up -d db rustfs
    echo "✓ containers up (postgres :5533, rustfs api :9110 console :9101)"

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
    pnpm --filter @miu2d/server db:migrate
    echo "✓ migrations applied"

[private]
_db-migrate-dev:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "→ running dev migrations (prisma migrate dev)"
    pnpm --filter @miu2d/server db:migrate:dev
    echo "✓ done"

[private]
_db-seed:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "→ seeding database"
    pnpm --filter @miu2d/server db:seed
    echo "✓ seed complete"

[private]
_db-studio:
    pnpm --filter @miu2d/server db:studio

[private]
_db-generate:
    pnpm --filter @miu2d/server db:generate

# start full dev stack (web :5274 + server :4100)
dev: (db "up")
    pnpm dev

# start server only
dev-server: (db "up")
    pnpm dev:server

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
    run_quiet "building shared types"  pnpm --filter @miu2d/types build
    run_quiet "generating prisma client" pnpm --filter @miu2d/server db:generate
    run_quiet "generating trpc types"  pnpm --filter @miu2d/server gen:trpc
    run_quiet "building engine"        pnpm --filter @miu2d/engine build
    run_quiet "building web"           pnpm --filter @miu2d/web build
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
    pnpm check
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
