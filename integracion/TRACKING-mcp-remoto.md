# Tracking F6: MCP remoto

> Compañero de [`PLAN-mcp-remoto.md`](./PLAN-mcp-remoto.md).
> Este doc es **autosuficiente**: una sesión nueva retoma leyendo solo esto + el plan.
> Marca `[x]` al completar cada tarea y actualiza "Estado global" y "Próxima acción".
> Rama: `feat/mcp-remoto`. Base: `main` @ `52e68dc` (F5 cerrada y pusheada).

## Regla de proceso (innegociable)

**Se PARA al final de cada fase** en un GATE de validación humana. No se empieza la fase siguiente
hasta que el operador apruebe el gate de la actual. Si una tarea revela que una decisión del ledger
estaba mal, se detiene y se replantea, no se improvisa.

## Cómo retomar en una sesión nueva

1. Lee este archivo entero y el PLAN.
2. Mira **Estado global** y **Próxima acción** abajo.
3. Confirma los criterios de aceptación de la tarea en curso antes de empezar.
4. Al terminar una tarea: marca el checkbox, anota archivos en el **Log de cambios** y actualiza
   **Próxima acción**.
5. Al llegar a un **GATE**: detente, presenta evidencia, espera aprobación del operador.

## Estado global

| Fase | Estado | Gate | Notas |
|---|---|---|---|
| F6-0 Diseño, verificación y cierre del ledger | ⬜ Pendiente | ⬜ | 7 decisiones abiertas; #1 (identidad) es la dominante |
| F6-1 Espolón: transporte Streamable HTTP | ⬜ Pendiente | ⬜ | Mide el coste real de la identidad explícita |
| F6-2 Ejecución in-process + paridad de validación | ⬜ Pendiente | ⬜ | Criterio duro: paridad stdio ↔ remoto en las 21 ops |
| F6-3 Registro remoto en el manifiesto | ⬜ Pendiente | ⬜ | Bump aditivo 3.1.0 → 3.2.0 |
| F6-4 Validación end-to-end desde cliente fresco | ⬜ Pendiente | ⬜ | Cero descargas; informe de cierre F6 |

Leyenda: ⬜ Pendiente · 🟡 En curso · ✅ Hecho · ⛔ Bloqueado · 🛑 En gate (espera operador)

**Próxima acción:** 🟡 **F6-0** — cerrar el ledger. Empezar por las tres verificaciones de repo
(T1) porque alimentan las decisiones #3 y #4, y en paralelo preparar la recomendación de #1
(identidad) para la firma del operador. **Sin código en esta fase.**

## Contexto de arranque (lo que ya está verificado)

- **F5 cerrada y firmada** (2026-06-21): el motor de método es conducible desde un cliente solo-spec
  vía MCP stdio + adaptador orquestador. Ver [`TRACKING-motor-metodo-cliente.md`](./TRACKING-motor-metodo-cliente.md).
- **`dispatch()` es transporte-agnóstico** salvo que escribe en stdout (`apts-mcp.js:133`; `send()`
  en `:52`). Métodos soportados: `initialize`, `tools/list`, `tools/call`, `ping`, más notificaciones.
- **Las tools se derivan del contrato**: `buildTools()` sobre `contractOperations()`
  (`apts-mcp.js:28`), con `checkMcpContract()` en el arranque. 21 operaciones.
- **Protocolo declarado**: `2025-06-18` (`apts-mcp.js:24`).
- **Auth ya existente**: `authenticateAgent` valida `Bearer <APTS_API_KEY>` (`backend/index.js:159`).
- **`trust proxy` ya configurado** (`backend/index.js:35`).
- **Rate limits actuales**: `loginLimiter` 5/15min, `apiLimiter` 100/min (`backend/index.js:156-157`).
- **Manifiesto**: `schema_version` 3.1.0 (`backend/index.js:1980`), 13 artefactos en
  `integrationArtifacts` (`:1983`), base pública `/api/public/integrar` (`:1981`).
- **Coste medido del manifiesto**: `bootstrap` 22,4 KB (~5.600 tokens), `instructions[]` 4,7 KB
  (~1.160), `artifacts[]` 9,8 KB (~2.450). Total ~9k tokens por integración.
- **El `.mcp.json` existe pero no se publica**: lo genera `generate-adapters.js` en
  `runtime-adapters/claude/.mcp.json`; el manifiesto declara que los adaptadores generados **no** son
  artefactos descargables (`agent_runtime_adapters.generation.policy`, `backend/index.js:2392`), y
  `agent_runtime_adapters.mappings` (`:2394`) solo tiene entradas `vscode`.

---

## F6-0 — Diseño, verificación y cierre del ledger

> Sin código. Salida: las 7 decisiones de §3 del PLAN cerradas por escrito, con formas JSON fijadas.

- [ ] **F6-0-T1** Verificaciones de repo que alimentan el ledger.
  - *(a)* De las 21 operaciones del contrato, ¿cuántas tienen ya *ruta fina → función de lib*
    reutilizable in-process, y cuántas llevan lógica dentro del handler express? Alimenta #3.
  - *(b)* ¿Dónde vive hoy la validación de cada payload — en `apts-client.js`, en la ruta, o en
    ambos? Listar operación por operación qué hueco deja el camino remoto. Alimenta #4.
  - *(c)* ¿Qué operaciones pueden exceder el timeout típico de un cliente MCP (indexado semántico,
    `analyze`, listados grandes)? Alimenta el riesgo de timeouts.
  - *Aceptación:* tres listas concretas, con rutas de archivo, en el Log de cambios.
- [ ] **F6-0-T2** Recomendación cerrada para **#1 modelo de identidad** (A explícita / B por token /
  C `set_identity` por sesión), con el payload exacto que quedaría por operación bajo la opción
  recomendada. PoC throwaway en `APTS_test` solo si la decisión no se puede cerrar en papel.
  - *Aceptación:* recomendación con justificación y ejemplo de payload; si hubo PoC, `APTS_test`
    restaurado y sin restos.
- [ ] **F6-0-T3** Cerrar las decisiones restantes: #2 estado de sesión, #5 auth, #6 ruta y rate
  limit, #7 destino de los artefactos de script y alcance del adelgazamiento de prosa.
  - *Aceptación:* tabla del ledger con las 7 filas en `cerrada` y su forma fijada.
- [ ] **F6-0-GATE** 🛑 Ledger cerrado y aprobado por el operador. Forma del endpoint y del modelo de
  identidad fijadas por escrito. **No empezar F6-1 sin la firma.**

### Ledger cerrado (F6-0) — pendiente de firma

| # | Decisión | Resolución | Estado |
|---|---|---|---|
| 1 | Modelo de identidad | *(pendiente)* | abierta |
| 2 | Estado de sesión | *(pendiente)* | abierta |
| 3 | Ejecución in-process | *(pendiente)* | abierta |
| 4 | Paridad de validación | *(pendiente)* | abierta |
| 5 | Auth | *(pendiente)* | abierta |
| 6 | Ruta y rate limit | *(pendiente)* | abierta |
| 7 | Destino de los artefactos de script | *(pendiente)* | abierta |

---

## F6-1 — Espolón: transporte Streamable HTTP sin estado

> **La ejecución sigue pasando por `apts-client.js` contra el propio server.** El salto HTTP interno
> se mantiene a propósito en esta fase, para aislar la variable *transporte* de la variable
> *ejecución*. Cambiarlo es F6-2.

- [ ] **F6-1-T1** Refactor de `dispatch()` a transporte-agnóstico: devuelve el objeto respuesta en
  vez de escribir en stdout. `apts-mcp.js` sigue funcionando por stdio exactamente igual.
  - *Aceptación:* stdio validado sin cambio de comportamiento (arranque + `tools/list` + una
    `tools/call` real); `contract-check` verde, 21 ops.
- [ ] **F6-1-T2** `POST /mcp` y `GET /mcp` → 405 en `backend/index.js`: JSON-RPC sobre HTTP,
  sin estado, auth por Bearer, `Origin` validado solo cuando viene, notificaciones → 202.
  - *Aceptación:* `node --check` verde; sin dependencias nuevas; sin migraciones.
- [ ] **F6-1-T3** Driver JSON-RPC sobre HTTP (throwaway) contra `APTS_test`: `initialize` →
  `tools/list` → lifecycle corto con identidad explícita.
  - *Aceptación:* se listan las 21 tools; el lifecycle corto pasa; `APTS_test` restaurado; driver
    borrado.
- [ ] **F6-1-T4** **Informe de coste de la identidad explícita**: cuántos campos por llamada, cuántos
  tokens añade sobre el camino stdio, cuántos errores cometió el agente por identidad faltante o mal
  resuelta.
  - *Aceptación:* números concretos, no impresiones.
- [ ] **F6-1-GATE** 🛑 Transporte funcionando + informe de identidad. **Si la identidad explícita
  resulta intolerable, se replantea el ledger #1 aquí, antes de invertir en F6-2/3/4.**

---

## F6-2 — Ejecución in-process + paridad de validación

- [ ] **F6-2-T1** Sustituir el salto HTTP interno por invocación directa de las funciones de negocio
  (según lo cerrado en ledger #3, sobre el inventario de F6-0-T1a).
- [ ] **F6-2-T2** Portar/asegurar la validación del contrato del lado servidor (ledger #4), cubriendo
  el hueco listado en F6-0-T1b.
- [ ] **F6-2-T3** `contract-check` como test interno del backend (sigue publicándose como artefacto
  mientras dure la convivencia, según ledger #7).
- [ ] **F6-2-T4** **Prueba de paridad**: para las 21 operaciones, mismo payload → mismo resultado por
  stdio y por remoto, **incluidos los rechazos**.
  - *Aceptación:* tabla de 21 filas con el veredicto de cada una; cualquier divergencia es un
    bloqueo, no una nota.
- [ ] **F6-2-GATE** 🛑 Paridad demostrada; `contract-check` verde; stdio intacto.

---

## F6-3 — Registro remoto en el manifiesto

- [ ] **F6-3-T1** El manifiesto publica el bloque de registro remoto por runtime **como dato**
  (Claude Code / opencode / vscode), no como prosa en `instructions[]`.
- [ ] **F6-3-T2** Artefactos `mcp_server` / `js_client` / `contract_check` / `package_manifest`
  marcados `deprecated` pero servibles (según ledger #7).
- [ ] **F6-3-T3** Bump `integrationManifestSchemaVersion` 3.1.0 → 3.2.0 + nota append-only en el
  comentario de `backend/index.js:1975`.
- [ ] **F6-3-GATE** 🛑 Un cliente puede registrar el MCP leyendo **solo** el manifiesto, sin
  descargar ningún script; el manifiesto sigue siendo válido para clientes 3.1.0; stdio funciona.

---

## F6-4 — Validación end-to-end desde cliente fresco

- [ ] **F6-4-T1** Cliente solo-spec throwaway fuera del repo, registrado contra el endpoint remoto
  con **cero descargas** (solo el bloque de registro + `APTS_API_KEY`).
- [ ] **F6-4-T2** Conducirlo de `analysis` a `phase=done` contra `APTS_test` vía el endpoint remoto,
  con conmutación de identidad multi-rol.
- [ ] **F6-4-T3** Restaurar `APTS_test` al baseline (2 initiatives preexistentes, `epics:2`,
  `backlog_items:358`, 0 restos); borrar cliente fresco y harness; apagar el server de test.
- [ ] **F6-4-GATE** 🛑 Lifecycle completo desde cliente fresco sin artefactos locales; informe de
  cierre F6 redactado en este TRACKING.

---

## Log de cambios

*(Entradas nuevas arriba. Anotar archivos tocados, migraciones, y estado de `APTS_test`.)*

- 2026-08-01 — Creados PLAN y TRACKING F6 tras verificar el problema: la superficie MCP es un script
  stdio distribuido, lo que obliga a 4 artefactos ejecutables descargables, `artifact_sync_policy`
  con `updater_contract`, y ~9k tokens de manifiesto por integración (medido). `dispatch()`
  (`apts-mcp.js:133`) ya es transporte-agnóstico salvo el `send()` a stdout, y `authenticateAgent`
  (`backend/index.js:159`) ya valida el Bearer que usaría el endpoint remoto. Sin cambios de código.
