#!/usr/bin/env bash
# deploy/align.sh — align production to the integration branch and rebuild.
#
# Usage:
#   ssh deploy@<host> 'cd /opt/preyone-portal && bash deploy/align.sh'
#   APP_DIR=/opt/preyone-portal BRANCH=integration/main-merge bash deploy/align.sh
#
# Refuses to run on a dirty tree so a server-side hotfix is never silently
# overwritten — commit or stash it first. That guard exists to stop the exact
# copy-a-file-onto-the-server drift this script replaces.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/preyone-portal}"
BRANCH="${BRANCH:-integration/main-merge}"
PM2_APP="${PM2_APP:-preyone-portal}"
DB_CONTAINER="${DB_CONTAINER:-preyone-db}"
DB_NAME="${DB_NAME:-captive_portal}"
DB_USER="${DB_USER:-postgres}"
BACKUP_DIR="${BACKUP_DIR:-/opt/backups}"

log() { printf '\n==> %s\n' "$*"; }

cd "$APP_DIR"

if [ -n "$(git status --porcelain)" ]; then
  echo "Refusing to deploy: working tree is not clean." >&2
  git status --short >&2
  echo "Commit or stash these changes first." >&2
  exit 1
fi

log "fetch + checkout $BRANCH"
git fetch origin --prune --tags
git checkout -B "$BRANCH" "origin/$BRANCH"
git branch --set-upstream-to="origin/$BRANCH" >/dev/null

log "database backup"
stamp="$(date +%Y%m%d-%H%M%S)"
if docker ps --format '{{.Names}}' | grep -qx "$DB_CONTAINER"; then
  mkdir -p "$BACKUP_DIR"
  docker exec "$DB_CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" \
    | gzip > "$BACKUP_DIR/db-pre-deploy-$stamp.sql.gz"
  echo "wrote $BACKUP_DIR/db-pre-deploy-$stamp.sql.gz"
else
  echo "warning: container $DB_CONTAINER not running; skipping DB backup" >&2
fi

log "install root dependencies"
npm install --no-audit --no-fund

log "migrate"
npm run migrate

log "build server"
npm run build

log "build SPAs"
for d in site invoice pos app; do
  if [ -f "$d/package.json" ]; then
    echo "   - $d"
    ( cd "$d" && npm install --no-audit --no-fund && npm run build )
  fi
done

if node -e "process.exit(require('./site/package.json').scripts.optimize?0:1)" 2>/dev/null; then
  log "optimize site images"
  ( cd site && npm run optimize )
fi

# Builds can rewrite tracked lockfiles and images. Restore them so the deployed
# tree stays byte-identical to the commit (no drift between deploys).
git checkout -- package-lock.json 2>/dev/null || true
for d in site invoice pos app; do
  git checkout -- "$d/package-lock.json" 2>/dev/null || true
done
git checkout -- \
  site/public/images/preyone-logo-mainInverse.avif \
  site/public/images/preyonenoneglow-logo.avif 2>/dev/null || true

log "restart $PM2_APP"
pm2 restart "$PM2_APP" --update-env

log "health check"
sleep 6
curl -fsS -o /dev/null -w 'health=%{http_code}\n' http://127.0.0.1:5000/health

log "final state"
echo "HEAD=$(git rev-parse --short HEAD)  BRANCH=$(git rev-parse --abbrev-ref HEAD)"
if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: working tree is dirty after deploy:" >&2
  git status --short >&2
  exit 1
fi
echo "working tree clean"
