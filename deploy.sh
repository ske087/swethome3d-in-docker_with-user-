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

compose() { docker compose "$@"; }

log() { printf '\n[k] %s\n' "$*"; }

ensure_src() {
  if [ -d src/.git ]; then
    log "Actualizez sursa upstream ($UPSTREAM_BRANCH)"
    git -C src fetch --depth 1 origin "$UPSTREAM_BRANCH"
    git -C src checkout -q "$UPSTREAM_BRANCH"
    git -C src reset --hard -q "origin/$UPSTREAM_BRANCH"
  else
    log "Clonez $UPSTREAM_REPO in ./src"
    git clone --depth 1 --branch "$UPSTREAM_BRANCH" "$UPSTREAM_REPO" src
  fi
  log "Commit: $(git -C src rev-parse --short HEAD) - $(git -C src log -1 --pretty=%s)"
}

# Copies our login/dashboard/sync layer over the upstream clone. Runs after every clone/update so
# `git reset --hard` cannot remove it. Our files stay untracked in src/ and are cleaned first.
apply_overlay() {
  if [ ! -d overlay ]; then
    log "ATENTIE: overlay/ lipseste - aplicatia porneste fara login si fara sincronizare."
    return
  fi
  log "Aplic stratul local (login, dashboard, sincronizare)"
  mkdir -p data
  git -C src clean -fd --quiet
  cp -R overlay/. src/
}

case "${1:-up}" in
  up)
    ensure_src
    apply_overlay
    log "Construiesc imaginile si pornesc containerele"
    compose up -d --build
    log "Sweet3D ruleaza pe http://localhost:${WEB_PORT}"
    log "Parola initiala de admin: ./deploy.sh logs | grep -A 5 'initial admin account'"
    ;;
  update)
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

  up        cloneaza/actualizeaza sursa, aplica stratul local, construieste si porneste (implicit)
  update    actualizeaza sursa, aplica stratul local si reconstruieste imaginile
  overlay   aplica doar stratul local in src/ (fara reconstruire)
  restart   reporneste containerele
  stop      opreste containerele
  down      opreste si elimina containerele
  logs      urmareste logurile (web + sync server)
  status    starea containerelor
  passwd    parola noua pentru admin (sau pentru utilizatorul dat): ./deploy.sh passwd [user]

Datele (proiecte, utilizatori, fisiere importate) sunt in ./data si supravietuiesc actualizarilor.
EOF
    ;;
esac
