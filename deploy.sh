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
# The exact upstream commit this deployment is built from. Upstream may change at any time and
# break the login/sync layer, so the commit is pinned instead of tracking the branch. Only
# `./deploy.sh upgrade` moves it, and only after the build succeeded.
LOCK_FILE="$PROJECT_DIR/upstream.lock"

compose() { docker compose "$@"; }

log() { printf '\n[k] %s\n' "$*"; }

warn() { printf '\n[!] %s\n' "$*"; }

lock_value() {
  [ -f "$LOCK_FILE" ] || return 0
  sed -n "s/^$1=//p" "$LOCK_FILE" | head -1
}

write_lock() {
  local commit="$1"
  # printf instead of a heredoc: backticks in the comments would be executed by an
  # unquoted heredoc, and a quoted one could not expand the variables.
  {
    printf '# Upstream commit this deployment is pinned to.\n'
    printf '# Only the upgrade command changes it; it rolls back when the build fails.\n'
    printf 'UPSTREAM_REPO=%s\n' "$UPSTREAM_REPO"
    printf 'UPSTREAM_BRANCH=%s\n' "$UPSTREAM_BRANCH"
    printf 'UPSTREAM_COMMIT=%s\n' "$commit"
  } >"$LOCK_FILE"
}

has_commit() {
  [ -d "$CACHE_DIR/.git" ] && git -C "$CACHE_DIR" cat-file -e "$1^{commit}" 2>/dev/null
}

# Remote commit of a ref, without fetching the whole history.
remote_commit() {
  local ref="${1:-$UPSTREAM_BRANCH}"
  git ls-remote "$UPSTREAM_REPO" "$ref" 2>/dev/null | awk 'NR==1 {print $1}'
}

# Makes sure the pinned commit exists in the cache clone. Uses the cache without any network
# access when the commit is already there, so a deployment is reproducible and works offline.
fetch_pinned() {
  local sha="$1"
  local cloned=0
  mkdir -p "$(dirname "$CACHE_DIR")"
  if [ ! -d "$CACHE_DIR/.git" ]; then
    log "Clonez $UPSTREAM_REPO in cache ($CACHE_DIR)"
    rm -rf "$CACHE_DIR"
    git clone --quiet --no-checkout "$UPSTREAM_REPO" "$CACHE_DIR"
    cloned=1
  fi
  if has_commit "$sha"; then
    if [ "$cloned" = 1 ]; then
      log "Commitul fixat $sha a venit cu clone-ul nou"
    else
      log "Commitul fixat $sha este deja in cache (fara acces la retea)"
    fi
  else
    log "Aduc commitul fixat $sha"
    # GitHub accepts fetching a commit directly; fall back to the branch history.
    git -C "$CACHE_DIR" fetch --quiet --depth 1 origin "$sha" 2>/dev/null ||
      git -C "$CACHE_DIR" fetch --quiet origin "$UPSTREAM_BRANCH" 2>/dev/null || true
    if ! has_commit "$sha"; then
      git -C "$CACHE_DIR" fetch --quiet --unshallow origin "$UPSTREAM_BRANCH" 2>/dev/null ||
        git -C "$CACHE_DIR" fetch --quiet origin "$UPSTREAM_BRANCH" 2>/dev/null || true
    fi
  fi
  if ! has_commit "$sha"; then
    warn "Commitul fixat $sha nu poate fi adus din $UPSTREAM_REPO."
    warn "Reteaua este oprita? Verifica upstream.lock sau ruleaza ./deploy.sh upgrade."
    exit 1
  fi
}

# Resolves the commit to build from: the pinned one, or the current upstream HEAD when no lock
# file exists yet (first run of an existing installation).
ensure_upstream() {
  if [ -f "$LOCK_FILE" ]; then
    UPSTREAM_REPO="$(lock_value UPSTREAM_REPO)"
    UPSTREAM_BRANCH="$(lock_value UPSTREAM_BRANCH)"
    UPSTREAM_REV="$(lock_value UPSTREAM_COMMIT)"
    if [ -z "$UPSTREAM_REV" ]; then
      warn "upstream.lock nu contine UPSTREAM_COMMIT; regenerez fisierul."
      UPSTREAM_REV="$(remote_commit)"
      [ -n "$UPSTREAM_REV" ] || { warn "Nu pot determina commitul upstream (reteaua?)."; exit 1; }
      write_lock "$UPSTREAM_REV"
    fi
    log "Versiune upstream fixata: ${UPSTREAM_REV:0:7}"
  else
    log "Nu exista upstream.lock, fixez versiunea curenta"
    UPSTREAM_REV="$(remote_commit)"
    [ -n "$UPSTREAM_REV" ] || { warn "Nu pot determina commitul upstream (reteaua?)."; exit 1; }
    write_lock "$UPSTREAM_REV"
    log "Creat upstream.lock cu ${UPSTREAM_REV:0:7}"
  fi
  fetch_pinned "$UPSTREAM_REV"
  UPSTREAM_SUBJECT="$(git -C "$CACHE_DIR" log -1 --pretty=%s "$UPSTREAM_REV" 2>/dev/null || echo '?')"
  log "Commit: ${UPSTREAM_REV:0:7} - $UPSTREAM_SUBJECT"
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

# Overlay files that also exist upstream. These are the files where an upstream change can
# silently break our login/sync layer, so `upgrade` reports them.
overlay_paths() {
  (
    cd overlay
    find . -type f | sed 's|^\./||' | while IFS= read -r file; do
      [ -e "$PROJECT_DIR/src/$file" ] && printf '%s\n' "$file"
    done
  )
}

# Files changed upstream between two commits that our overlay also overwrites.
upstream_conflicts() {
  local from="$1" to="$2"
  local paths
  paths="$(overlay_paths)"
  [ -n "$paths" ] || return 0
  # shellcheck disable=SC2086
  git -C "$CACHE_DIR" diff --name-only "$from" "$to" -- $paths 2>/dev/null || true
}

# Moves the pin to a newer upstream commit. The build has to succeed, otherwise the previous
# commit is restored, so a broken upstream update can never reach a running deployment.
upgrade() {
  local target="${1:-$UPSTREAM_BRANCH}"
  ensure_upstream # makes sure the cache exists and the current pin is complete
  local previous="$UPSTREAM_REV"

  log "Caut cea mai noua versiune upstream ($target)"
  local next
  next="$(remote_commit "$target")"
  if [ -z "$next" ]; then
    warn "Nu pot citi $target din $UPSTREAM_REPO (reteaua?)."
    exit 1
  fi
  if [ "$next" = "$previous" ]; then
    log "Versiunea fixata ${previous:0:7} este deja cea mai noua"
    log "Ruleaza ./deploy.sh update doar daca vrei sa reconstruiesti imaginile."
    return 0
  fi

  fetch_pinned "$next"
  log "Upstream nou: ${previous:0:7} -> ${next:0:7}"

  local touched
  touched="$(upstream_conflicts "$previous" "$next")"
  if [ -n "$touched" ]; then
    warn "Upstream a modificat fisiere pe care le suprascrie overlay-ul:"
    printf '      %s\n' $touched
    warn "Verifica dupa build ca login-ul, dashboardul si sincronizarea functioneaza."
  else
    log "Niciun fisier din overlay nu a fost atins de upstream"
  fi

  write_lock "$next"
  UPSTREAM_REV="$next"
  ensure_src
  apply_overlay

  log "Construiesc imaginile cu ${next:0:7}"
  if ! compose build; then
    warn "Build-ul a esuat cu ${next:0:7}. Revin la ${previous:0:7}."
    write_lock "$previous"
    UPSTREAM_REV="$previous"
    ensure_src
    apply_overlay
    warn "Versiunea fixata a ramas ${previous:0:7}. Containerul care ruleaza este neatins."
    exit 1
  fi
  compose up -d
  log "Upgrade finalizat: ${next:0:7} - http://localhost:${WEB_PORT}"
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
    log "Reconstruiesc imaginile din versiunea fixata ${UPSTREAM_REV:0:7}"
    compose build --pull
    compose up -d
    log "Actualizare finalizata: http://localhost:${WEB_PORT}"
    ;;
  upgrade)
    upgrade "${2:-}"
    ;;
  pin)
    ensure_upstream
    log "Repo:    $UPSTREAM_REPO"
    log "Branch:  $UPSTREAM_BRANCH"
    log "Commit:  $UPSTREAM_REV"
    log "Subiect: $UPSTREAM_SUBJECT"
    log "Sursa:   src/.source-rev = $(cat src/.source-rev 2>/dev/null || echo '(nesincronizat)')"
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

  up        construieste si porneste din versiunea upstream fixata (implicit)
  update    reconstruieste imaginile din versiunea fixata (nu schimba upstream)
  upgrade   muta fixarea pe cel mai nou upstream; revine automat daca build-ul esueaza
            ./deploy.sh upgrade <ref> pentru un commit/tag anume
  pin       arata versiunea upstream fixata
  overlay   aplica doar stratul local in src/ (fara reconstruire)
  restart   reporneste containerele
  stop      opreste containerele
  down      opreste si elimina containerele
  logs      urmareste logurile (web + sync server)
  status    starea containerelor
  passwd    parola noua pentru admin (sau pentru utilizatorul dat): ./deploy.sh passwd [user]

Versiunea upstream este fixata in upstream.lock si clonata in $CACHE_DIR, nu in acest
proiect. In src/ ajung doar fisierele sursa (fara .git), peste care se copiaza overlay/.
Astfel editorul vede un singur repository, iar o schimbare upstream nu poate strica
login-ul fara sa rulezi explicit ./deploy.sh upgrade.

Datele (proiecte, utilizatori, fisiere importate) sunt in ./data si supravietuiesc actualizarilor.
EOF
    ;;
esac
