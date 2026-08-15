---
name: desplegar-produccion
description: Despliega APTS a produccion (apts.informaticos.ar) de punta a punta - push, pull en el servidor, dependencias, copia de la base, migraciones, build del frontend, reinicio de pm2 y comprobaciones, con reversion automatica si algo falla. Usalo cuando Javier diga "despliega el sistema a produccion", "sube esto a prod", "desplegar", "publicar en produccion" o equivalente.
---

# Desplegar APTS a produccion

Un solo despliegue completo: backend **y** frontend. Lo mecanico lo hace
`scripts/deploy_prod.sh`, que corre en el servidor canalizado por ssh. Tu trabajo
es la comprobacion previa en local, lanzarlo y leer lo que devuelve.

## Donde vive produccion

| | |
|---|---|
| Servidor | `root@134.122.62.55`, clave `C:/Users/jntac/.ssh/general_todos` |
| Aplicacion | `/opt/APTS`, rama `main`, remoto `github.com/LITAT-AGC/agentic-tracker` |
| Backend | pm2 `apts-backend`, fork, cwd `backend/`, puerto 46315 |
| Frontend | nginx sirve `/opt/APTS/frontend/dist` en `https://apts.informaticos.ar` |
| Base | `10.110.0.10:46452/APTS`, PostgreSQL 17, usuario `apt_user` |

El despliegue es manual: **no** lo gestiona el deploy-hub de `/opt/deploy-system`,
aunque ese proceso conviva en el mismo pm2. No lo toques.

Ningun secreto esta guardado en local. Los que hacen falta se leen en el momento
del `.env` del propio servidor, que git ignora y el script no imprime.

## 1. Antes de tocar el servidor

Todo esto en el checkout local, y **para** si algo no cuadra:

1. `git status --porcelain` — el arbol tiene que estar limpio. Si hay cambios sin
   commitear, no decidas tu: enseñalos y pregunta si se commitean, se dejan fuera
   o se aborta.
2. Rama `main`.
3. `git fetch origin && git rev-list --left-right --count origin/main...HEAD` — si
   hay commits locales sin subir, **haz push**: el servidor despliega desde
   `origin/main`, no desde tu disco. Si hay commits en origin que no tienes,
   avisa antes: desplegarias trabajo ajeno sin haberlo visto.
4. Resume en dos lineas que se va a desplegar (`git log --oneline origin/main..HEAD`
   antes del push) y si entra alguna migracion nueva
   (`git diff --name-only origin/main..HEAD -- backend/migrations`).

## 2. Lanzarlo

```bash
ssh -i C:/Users/jntac/.ssh/general_todos -o ConnectTimeout=25 \
  root@134.122.62.55 'bash -s' < scripts/deploy_prod.sh
```

El script no se guarda en el servidor a proposito: asi el que corre es siempre el
del checkout, y actualizar el desplegador no exige desplegar.

Dale timeout holgado (unos 10 minutos): el build del frontend tarda, y si hay
migraciones pendientes la copia de la base se hace con un contenedor `postgres:17`
que puede tener que descargarse la primera vez.

Lo que hace, en orden: descarta los dos `package-lock.json` que npm reescribe en
el servidor y aborta si queda cualquier otro cambio local; `merge --ff-only` de
`origin/main`; `npm install` solo donde cambio el `package.json`; si hay
migraciones pendientes, `pg_dump -Fc` a `/root/apts-backup-<fecha>-<sha>.dump` y
despues `npm run migrate`; build del frontend a `dist.new` y intercambio
(`dist` pasa a `dist.prev`); `pm2 restart apts-backend --update-env`; y las
comprobaciones.

## 3. Que significa lo que devuelve

Sale con 0 solo si todas las comprobaciones pasaron. Comprueba, y en este orden
importan: `/api/health` en el 46315, el manifiesto con `mcp_endpoint`, la ruta
`/mcp` del backend, `/api/health` a traves de nginx, y que el `index.html` que
sirve nginx pida un bundle que **este en el dist recien compilado** — eso es lo
unico que demuestra que el frontend desplegado es el nuevo.

Dos cosas que hay que saber leer:

- **Reinicios en bucle.** Los dos auto-chequeos de arranque abortan con `exit 3`
  antes de escuchar: el contrato contra `apts_skills.json`, y las lineas
  `--agent-cmd` que publica el manifiesto contra el README del conductor. pm2
  reintenta, asi que el sintoma es el contador de reinicios subiendo. El script lo
  detecta y te enseña el log de error. (El segundo fue durante un tiempo el de las
  plantillas contra `apts-surface.json`, retirado con VS Code el 2026-08-08.)
- **El aviso de `/mcp`.** nginx no tiene `location /mcp`, asi que
  `https://apts.informaticos.ar/mcp` cae en `try_files` y la sirve como estatico
  (un POST recibe 405 de nginx). El manifiesto publica esa URL como punto de
  integracion, de modo que mientras el aviso salga, ningun cliente MCP externo
  puede usar la superficie. No es una regresion del despliegue y el script no lo
  arregla solo: hace falta añadir el `location` con `proxy_pass` a
  `127.0.0.1:46315` en `/etc/nginx/sites-enabled/apts.informaticos.ar`. Si sale
  el aviso, dilo en el resumen.

Ojo con `try_files`: una ruta inexistente responde 200 con el `index.html`, asi
que **una URL que devuelve 200 no prueba nada**. Comprueba siempre contra
contenido, como hace el script.

## 4. Si falla

El script revierte solo cuando el fallo llega despues del pull: `git reset --hard`
al sha de partida, restaura `frontend/dist.prev` si ya habia intercambiado, y
reinicia. Te dice si el servicio volvio a responder o si sigue caido.

Lo que **no** puede revertir es la base. Si el fallo llego despues de aplicar
migraciones, el codigo vuelve atras pero el esquema no; el dump previo esta en
`/root/`. En ese caso no improvises: informa del sha, del dump y de que
comprobacion fallo, y pregunta.

## 5. Al terminar

Resume en pocas lineas: sha desplegado, commits que entraron, si hubo migraciones
y donde quedo la copia, y el resultado de cada comprobacion. Si `integracion/ESTADO.md`
describe produccion con datos que este despliegue deja viejos, actualizalo.

## Lo que este despliegue no hace

- No rota la contraseña de `apt_user`, que sigue pendiente desde que se expuso en
  claro el 2026-08-02.
- No toca nginx ni el `.env` del servidor.
- No siembra el metodo. `npm run seed:method` es una operacion aparte y deliberada:
  hace upsert por clave natural y conserva los UUID, pero borra lo que el corpus ya
  no trae. Solo si se pide.
