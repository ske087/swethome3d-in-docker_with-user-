#!/usr/bin/env bash
# Deploy Sweet3D (https://github.com/Paul6552/sweet3D) as a static site plus a small sync/auth API.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

UPSTREAM_REPO="${UPSTREAM_REPO:-https://github.com/Paul6552/sweet3D.git}"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-main}"
WEB_PORT="${WEB_PORT:-8180}"
# The upstream clone lives outside the workspace: src/ is plain source without its own .git, so
# the editor only ever sees this repository. Override to keep the cache elsewhere.
CACHE_DIR="${CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/swethome3d-upstream}"

compose() { docker compose "$@"; }

log() { printf '\n[k] %s\n' "$*"; }

# Fetches the upstream branch into the cache clone (shallow, so updates stay small).
ensure_upstream() {
  if [ -d "$CACHE_DIR/.git" ]; then
    log "Actualizez sursa upstream ($UPSTREAM_BRANCH)"
    git -C "$CACHE_DIR" fetch --depth 1 --quiet origin "$UPSTREAM_BRANCH"
    git -C "$CACHE_DIR" checkout --quiet "$UPSTREAM_BRANCH"
    git -C "$CACHE_DIR" reset --hard --quiet "origin/$UPSTREAM_BRANCH"
  else
    log "Clonez $UPSTREAM_REPO in cache ($CACHE_DIR)"
    rm -rf "$CACHE_DIR"
    mkdir -p "$(dirname "$CACHE_DIR")"
    git clone --quiet --depth 1 --branch "$UPSTREAM_BRANCH" "$UPSTREAM_REPO" "$CACHE_DIR"
  fi
  UPSTREAM_REV="$(git -C "$CACHE_DIR" rev-parse --short HEAD)"
  UPSTREAM_SUBJECT="$(git -C "$CACHE_DIR" log -1 --pretty=%s)"
  log "Commit: $UPSTREAM_REV - $UPSTREAM_SUBJECT"
}

# Copies the tracked upstream files into src/ as plain files, so no nested repository (and no
# "changes" in Source Control) is left behind. Skipped when the commit did not change.
ensure_src() {
  if [ -f src/.source-rev ] && [ "$(cat src/.source-rev)" = "$UPSTREAM_REV" ] && [ -d src/src ]; then
    log "Sursa upstream neschimbata ($UPSTREAM_REV)"
    return
  fi
  log "Copiez sursa upstream $UPSTREAM_REV in ./src"
  rm -rf src
  mkdir -p src
  git -C "$CACHE_DIR" archive "$UPSTREAM_REV" | tar -x -C src
  printf '%s\n' "$UPSTREAM_REV" > src/.source-rev
}

# Copies our login/dashboard/sync layer over the upstream source. Runs after every sync, so updated
# upstream files overwrite the previous overlay. Files of an older overlay version are removed first.
apply_overlay() {
  if [ ! -d overlay ]; then
    log "ATENTIE: overlay/ lipseste - aplicatia porneste fara login si fara sincronizare."
    return
  fi
  log "Aplic stratul local (login, dashboard, sincronizare)"
  mkdir -p data
  (
    cd overlay
    find . -type f -print0 | while IFS= read -r -d '' file; do
      rm -f "../src/${file#./}"
    done
  )
  cp -R overlay/. src/
}

case "${1:-up}" in
  up)
    ensure_upstream
    ensure_src
    apply_overlay
    log "Construiesc imaginile si pornesc containerele"
    compose up -d --build
    log "Sweet3D ruleaza pe http://localhost:${WEB_PORT}"
    log "Parola initiala de admin: ./deploy.sh logs | grep -A 5 'initial admin account'"
    ;;
  update)
    ensure_upstream
    ensure_src
    apply_overlay
    log "Reconstruiesc imaginile (fara cache pentru dependinte)"
    compose build --pull
    compose up -d
    log "Actualizare finalizata: http://localhost:${WEB_PORT}"
    ;;
  overlay)
    apply_overlay
    log "Stratul local este aplicat in src/. Ruleaza ./deploy.sh update pentru reconstruire."
    ;;
  restart)
    compose restart
    ;;
  stop)
    compose stop
    ;;
  down)
    compose down
    ;;
  logs)
    compose logs -f --tail=100
    ;;
  status)
    compose ps
    ;;
  passwd)
    log "Setez o parola noua pentru utilizatorul ${2:-${ADMIN_USER:-admin}}"
    compose run --rm server node index.mjs --reset-password "${2:-${ADMIN_USER:-admin}}"
    ;;
  *)
    cat <<EOF
Utilizare: ./deploy.sh [comanda]

  up        aduce sursa upstream, aplica stratul local, construieste si porneste (implicit)
  update    actualizeaza upstream, aplica stratul local si reconstruieste imaginile
  overlay   aplica doar stratul local in src/ (fara reconstruire)
  restart   reporneste containerele
  stop      opreste containerele
  down      opreste si elimina containerele
  logs      urmareste logurile (web + sync server)
  status    starea containerelor
  passwd    parola noua pentru admin (sau pentru utilizatorul dat): ./deploy.sh passwd [user]

Sursa upstream este clonata in $CACHE_DIR, nu in acest proiect. In src/ ajung doar
fisierele sursa (fara .git), peste care se copiaza overlay/. Asa editorul vede un singur
repository: acesta. Sterge cache-ul doar daca vrei sa reclonezi de la zero.

Datele (proiecte, utilizatori, fisiere importate) sunt in ./data si supravietuiesc actualizarilor.
EOF
    ;;
esac
