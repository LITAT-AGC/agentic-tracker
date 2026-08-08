#!/usr/bin/env bash
#
# Despliegue de APTS a produccion. Se ejecuta EN EL SERVIDOR, canalizado por ssh:
#
#   ssh -i ~/.ssh/general_todos root@134.122.62.55 'bash -s' < scripts/deploy_prod.sh
#
# No se guarda una copia en el servidor a proposito: asi siempre corre la version
# del checkout que dispara el despliegue, y no hay que desplegar para actualizar
# el desplegador.
#
# Hace, en este orden: pull con avance rapido, dependencias solo si cambiaron,
# copia de la base solo si hay migraciones pendientes, migraciones, build del
# frontend a un directorio aparte que se intercambia al final, reinicio de pm2 y
# comprobaciones. Si algo falla despues del pull, revierte el codigo y el dist.
#
set -euo pipefail

APP_DIR=/opt/APTS
PM2_NAME=apts-backend
PORT=46315
PUBLIC=https://apts.informaticos.ar
BRANCH=main

log()  { printf '\n=== %s\n' "$*"; }
warn() { printf '\nAVISO: %s\n' "$*"; }
fail() { printf '\nFALLO: %s\n' "$*" >&2; exit 1; }

cd "$APP_DIR"

# --- 0. estado de partida ----------------------------------------------------

[ "$(git branch --show-current)" = "$BRANCH" ] || fail "el servidor no esta en $BRANCH sino en $(git branch --show-current)"

# npm reescribe los dos package-lock al instalar. Son generados: se descartan.
git checkout -- backend/package-lock.json frontend/package-lock.json 2>/dev/null || true

DIRTY=$(git status --porcelain -uno)
[ -z "$DIRTY" ] || fail "el arbol de $APP_DIR tiene cambios sin commitear, no piso nada:
$DIRTY"

PREV=$(git rev-parse HEAD)
SWAPPED=0
log "HEAD de partida: $(git log --oneline -1)"

rollback() {
  printf '\n!!! revirtiendo a %s\n' "${PREV:0:9}" >&2
  cd "$APP_DIR"
  git reset --hard "$PREV" >&2 || true
  if [ "$SWAPPED" = "1" ] && [ -d frontend/dist.prev ]; then
    rm -rf frontend/dist
    mv frontend/dist.prev frontend/dist
    printf 'dist anterior restaurado\n' >&2
  fi
  pm2 restart "$PM2_NAME" --update-env >&2 || true
  sleep 5
  if curl -fsS --max-time 10 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    printf 'el servicio responde de nuevo en %s\n' "${PREV:0:9}" >&2
  else
    printf 'ATENCION: el servicio SIGUE CAIDO tras revertir. Mirar pm2 logs %s\n' "$PM2_NAME" >&2
  fi
}

# --- 1. traer el codigo ------------------------------------------------------

log "trayendo origin/$BRANCH"
git fetch origin "$BRANCH"
trap rollback ERR
git merge --ff-only "origin/$BRANCH"
NEW=$(git rev-parse HEAD)

if [ "$PREV" = "$NEW" ]; then
  log "sin commits nuevos; se reconstruye y reinicia igualmente"
  CHANGED=""
else
  CHANGED=$(git diff --name-only "$PREV" "$NEW")
  log "commits desplegados:"
  git log --oneline "$PREV..$NEW"
fi

changed() { printf '%s\n' "$CHANGED" | grep -q "^$1"; }

# --- 2. dependencias ---------------------------------------------------------

if [ ! -d backend/node_modules ] || changed 'backend/package'; then
  log "backend: npm install"
  (cd backend && npm install --no-audit --no-fund)
else
  log "backend: dependencias sin cambios"
fi

if [ ! -d frontend/node_modules ] || changed 'frontend/package'; then
  log "frontend: npm install"
  (cd frontend && npm install --no-audit --no-fund)
else
  log "frontend: dependencias sin cambios"
fi

# --- 3. base de datos --------------------------------------------------------

cd backend
PENDING_OUT=$(npx --no-install knex migrate:status 2>&1 || true)
if printf '%s' "$PENDING_OUT" | grep -q 'No Pending Migration'; then
  log "sin migraciones pendientes"
else
  log "hay migraciones pendientes; copia de seguridad antes de aplicarlas"
  CONN=$(grep -E '^PG_CONNECTION_STRING=' .env | head -1 | cut -d= -f2- | tr -d '\r"'"'")
  [ -n "$CONN" ] || fail "no encuentro PG_CONNECTION_STRING en $APP_DIR/backend/.env"
  DUMP="apts-backup-$(date +%Y%m%d-%H%M%S)-${PREV:0:9}.dump"
  # El servidor es Ubuntu focal y PGDG ya no publica cliente 17: contenedor de usar y tirar.
  docker run --rm --network host -v /root:/out postgres:17 \
    pg_dump -Fc "$CONN" -f "/out/$DUMP"
  log "copia en /root/$DUMP ($(du -h "/root/$DUMP" | cut -f1))"
  log "aplicando migraciones"
  npm run migrate
  DB_MIGRATED=1
fi
cd "$APP_DIR"

# --- 4. frontend -------------------------------------------------------------

log "compilando el frontend"
cd frontend
rm -rf dist.new
npm run build -- --outDir dist.new --emptyOutDir
[ -s dist.new/index.html ] || fail "el build no dejo index.html"
rm -rf dist.prev
if [ -d dist ]; then mv dist dist.prev; fi
mv dist.new dist
SWAPPED=1
log "dist intercambiado ($(ls dist/assets | wc -l) ficheros en assets); el anterior queda en dist.prev"
cd "$APP_DIR"

# --- 5. reinicio -------------------------------------------------------------

restarts() {
  pm2 jlist 2>/dev/null | node -e "
    let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
      const p=JSON.parse(s).find(x=>x.name===process.argv[1]);
      process.stdout.write(String(p ? p.pm2_env.restart_time : -1));
    });" "$PM2_NAME" || echo -1
}

R_BEFORE=$(restarts)
log "reiniciando $PM2_NAME (reinicios acumulados: $R_BEFORE)"
pm2 restart "$PM2_NAME" --update-env
sleep 10

# Los dos auto-chequeos de arranque abortan con exit 3; pm2 lo reintentaria en
# bucle, asi que un contador que sigue subiendo es exactamente ese fallo.
R_AFTER=$(restarts)
if [ "$R_AFTER" -gt "$((R_BEFORE + 1))" ]; then
  printf '\n--- ultimas lineas del log de error ---\n' >&2
  tail -30 /root/.pm2/logs/apts-backend-error.log >&2 || true
  fail "el proceso esta reiniciando en bucle ($R_BEFORE -> $R_AFTER): mira si es un auto-chequeo de arranque (exit 3)"
fi

# --- 6. comprobaciones -------------------------------------------------------

log "comprobando"

HEALTH=$(curl -fsS --max-time 15 "http://127.0.0.1:$PORT/api/health") || fail "/api/health no responde en el 46315"
printf '%s' "$HEALTH" | grep -q '"status":"ok"' || fail "/api/health responde pero no esta ok: $HEALTH"
echo "  local  /api/health          -> $HEALTH"

curl -fsS --max-time 15 "http://127.0.0.1:$PORT/api/public/integrar" | grep -q '"mcp_endpoint"' \
  || fail "el manifiesto no publica mcp_endpoint"
echo "  local  /api/public/integrar -> 200 con mcp_endpoint"

# GET /mcp no pide credenciales: sirve para saber si la ruta esta viva.
curl -sS --max-time 15 "http://127.0.0.1:$PORT/mcp" | grep -q 'jsonrpc\|405\|POST' \
  || fail "la ruta /mcp del backend no contesta"
echo "  local  GET /mcp             -> el backend contesta"

curl -fsS --max-time 20 "$PUBLIC/api/health" | grep -q '"status":"ok"' \
  || fail "nginx no llega al backend: $PUBLIC/api/health"
echo "  publico /api/health         -> ok"

# El index servido tiene que referenciar un asset del build que acabamos de dejar.
ASSET=$(curl -fsS --max-time 20 "$PUBLIC/" | grep -o 'assets/index-[A-Za-z0-9_-]*\.js' | head -1)
[ -n "$ASSET" ] || fail "el index publicado no referencia ningun bundle"
[ -f "frontend/dist/$ASSET" ] || fail "nginx sirve un index que pide $ASSET, que no esta en el dist nuevo"
curl -fsS --max-time 20 -o /dev/null "$PUBLIC/$ASSET" || fail "$ASSET no se descarga"
echo "  publico /                   -> $ASSET, presente en el dist nuevo"

# nginx no tiene location para /mcp: cae en try_files y responde HTML.
# El manifiesto publica esa URL, asi que mientras esto avise, la superficie
# publicada no es alcanzable desde fuera.
if curl -sS --max-time 20 "$PUBLIC/mcp" | grep -qi 'jsonrpc'; then
  echo "  publico GET /mcp            -> el backend contesta"
else
  warn "$PUBLIC/mcp lo sirve nginx como estatico, no el backend. El manifiesto
  publica esa URL como punto de integracion, asi que ningun cliente MCP externo
  puede usarla. Falta un 'location /mcp' con proxy_pass a 127.0.0.1:$PORT en
  /etc/nginx/sites-enabled/apts.informaticos.ar."
fi

trap - ERR

log "desplegado $(git log --oneline -1)"
if [ "${DB_MIGRATED:-0}" = "1" ]; then
  log "se aplicaron migraciones; la copia previa esta en /root/"
fi
exit 0
