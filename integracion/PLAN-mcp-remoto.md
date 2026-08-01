# Plan F6: MCP remoto (el backend expone el endpoint, el cliente no descarga scripts)

> Documento de planificación. Estado y avance se llevan en
> [`TRACKING-mcp-remoto.md`](./TRACKING-mcp-remoto.md).
> Fecha de redacción: 2026-08-01. Rama propuesta: `feat/mcp-remoto`.
> **Regla de oro: se PARA al final de cada fase** (gate de validación humana) antes de pasar a la
> siguiente, igual que en [`PLAN-motor-metodo-cliente.md`](./PLAN-motor-metodo-cliente.md).

## 1. Problema (verificado, no supuesto)

F5 cerró con el motor de método conducible de punta a punta desde un cliente solo-spec. Pero la
superficie sigue siendo un **script stdio local**, y eso arrastra toda la maquinaria de distribución:

- El manifiesto (`GET /api/public/integrar`) publica **13 artefactos**, de los cuales 4 son el
  núcleo ejecutable que el cliente debe descargar y mantener sincronizado: `apts-mcp.js`,
  `apts-client.js`, `contract-check.js`, `package.json`.
- Existe por eso un `artifact_sync_policy` con `updater_contract`, comparación por
  `artifact_version`, `legacy_cleanup_targets` y reglas anti-drift — todo para resolver el problema
  de que el cliente tiene una copia del código del servidor.
- La cadena de una llamada es
  `agente → apts-mcp.js (stdio) → apts-client.js → HTTP → rutas express → resolver`.
  El salto HTTP interno ya existe; el script local solo lo envuelve.
- El manifiesto pesa **~9k tokens** por integración (medido sobre `backend/index.js`: bloque
  `bootstrap` 22,4 KB ≈ 5.600 tokens, `instructions[]` 4,7 KB ≈ 1.160, `artifacts[]` 9,8 KB ≈ 2.450),
  y buena parte de esa prosa existe para explicarle al agente cómo instalar y sincronizar esos
  archivos.
- El registro concreto (`.mcp.json` de Claude Code, `opencode.json` de opencode) **no se publica**:
  lo emite `generate-adapters.js` y `agent_runtime_adapters.mappings` solo cubre `vscode`. Un cliente
  Claude Code tiene que inferirlo de la prosa.

**Nada de eso es necesario si la superficie es un endpoint HTTP del propio backend.** Registrar el
MCP pasa a ser una URL más un token: sin descargas, sin versiones que sincronizar, sin drift.

Lo que ya juega a favor: `dispatch()` en `apts-mcp.js:133` es **transporte-agnóstico** salvo que
escribe en stdout, las tools se derivan del contrato (`contractOperations()`), y las rutas de F5-1
ya siguen el patrón *ruta fina → función de lib* (`method_bootstrap.js`).

## 2. Objetivo

Que el backend de APTS **exponga sus 21 operaciones como servidor MCP remoto** sobre HTTP, de modo
que conectar un proyecto cliente sea registrar una URL con una cabecera de auth.

- **Alcance v1:** endpoint MCP Streamable HTTP sin estado en el backend; paridad demostrada con la
  superficie stdio en las 21 operaciones; el manifiesto publica el bloque de registro remoto por
  runtime; validación end-to-end desde un cliente fresco que **no descarga nada**.
- **Coexistencia obligatoria:** la superficie stdio (`apts-mcp.js`) sigue funcionando durante toda
  F6 y después. F6 es aditivo; no retira nada.
- **No incluido en v1:** OAuth 2.1 (auth por Bearer estático, ver ledger #5); canal SSE
  servidor→cliente; adelgazamiento de la prosa del manifiesto (ledger #7 decide si entra);
  retirada de los artefactos de script (se marcan deprecated, no se borran).

## 3. Ledger de decisiones (a cerrar en F6-0, antes de codear)

| # | Decisión | Estado |
|---|---|---|
| **1. Modelo de identidad** | `apts-client.js` hace autofill local (`project_url` ← git remote, `agent_name` ← git config, `branch` ← git branch, contexto en `.apts/execution-context.json`). **Un servidor remoto no ve nada de eso.** Opciones: (A) el agente manda identidad explícita en cada llamada; (B) identidad ligada al token (una API key por proyecto); (C) tool `set_identity` cacheada contra la sesión MCP. Recomendación: **A**, con C como escape si duele. Es la decisión que condiciona todo. | abierta |
| **2. Estado de sesión** | Sin estado (no se emite `Mcp-Session-Id`, `GET /mcp` devuelve 405) vs. con sesión. Acoplada a #1: la opción C obliga a estado. Recomendación: **sin estado**. | abierta |
| **3. Ejecución in-process** | El endpoint puede (a) seguir llamando a `apts-client.js` por HTTP contra sí mismo — una sola ruta de código, un salto de red interno — o (b) invocar directo las funciones de negocio. Recomendación: **(b)**, pero verificando primero cuántas de las 21 ops tienen ya *ruta fina → función de lib* reutilizable. | abierta |
| **4. Paridad de validación** | Hoy `apts-client.js` valida el payload contra el contrato **antes** de mandarlo (`validateCreateInitiativeInput`, `validateSetAgentRoleInput`, …). En remoto esa validación debe vivir en el servidor o se abre un hueco: el endpoint remoto aceptaría payloads que la superficie stdio rechaza. Hay que verificar qué valida hoy cada ruta y portar lo que falte. | abierta |
| **5. Auth** | Bearer estático reutilizando `authenticateAgent` (`index.js:159`, ya valida `APTS_API_KEY`) vs. OAuth 2.1 con *protected resource metadata* como pide la spec MCP para servidores remotos. Recomendación: **Bearer** para v1 (un operador, key existente); OAuth no queda bloqueado para después. | abierta |
| **6. Ruta y rate limit** | Ruta `/mcp` (convención MCP) vs. `/api/mcp`. Y: `apiLimiter` son 100/min — F5-4 ya lo golpeó con un lifecycle completo. Si el MCP remoto es *toda* la superficie, ese límite es demasiado justo. Decidir límite propio para `/mcp`. | abierta |
| **7. Destino de los artefactos de script** | ¿`mcp_server`/`js_client`/`contract_check`/`package_manifest` se marcan `deprecated` en el manifiesto pero se siguen sirviendo (recomendado, un ciclo de convivencia), o se retiran? Y: ¿entra en alcance de F6 el adelgazamiento de la prosa del manifiesto (~6,8k tokens de `bootstrap` + `instructions`)? Recomendación: convivencia sí, adelgazamiento **fuera de alcance** (trabajo aparte). | abierta |
| **Coexistencia con stdio** | La superficie stdio sigue viva y funcionando durante y después de F6. Nada se retira en esta fase. | cerrada |
| **Contrato como fuente** | Las tools del endpoint remoto se derivan de `apts_skills.json` igual que las de stdio. Sin listas paralelas de tools. | cerrada |
| **Gate por fase** | Se para en cada gate; si una decisión del ledger resulta mal, se replantea, no se improvisa. | cerrada |

## 4. Arquitectura objetivo (delta sobre lo existente)

```
Hoy:     agente → apts-mcp.js (stdio) → apts-client.js → HTTP → rutas express → lib → resolver
F6:      agente → HTTP/MCP → POST /mcp (backend) ─────────────────────────────► lib → resolver
         (stdio sigue existiendo intacto en paralelo)

apts-mcp.js       ──► `dispatch()` refactorizado: devuelve la respuesta en vez de escribir stdout
backend/index.js  ──► + POST /mcp (JSON-RPC sobre HTTP) + GET /mcp → 405
contrato          ──► sin cambios (mismas 21 ops, mismo apts_skills.json)
validación        ──► la del cliente se porta/asegura del lado servidor (ledger #4)
manifiesto        ──► publica el bloque de registro remoto por runtime; scripts → deprecated
contract-check    ──► pasa de artefacto distribuido a test interno del backend
```

## 5. Forma del transporte (Streamable HTTP, modo sin estado)

Protocolo `2025-06-18`, el mismo que ya declara `apts-mcp.js:24`.

- **`POST /mcp`** — cuerpo = un mensaje JSON-RPC (`initialize`, `tools/list`, `tools/call`, `ping`).
  Respuesta `application/json` con el resultado. Notificación (sin `id`) → `202` con cuerpo vacío.
- **`GET /mcp`** — sería el canal SSE servidor→cliente. **No hace falta**: las 21 ops son
  petición→respuesta. Devolver `405`; la spec lo contempla.
- **Sin `Mcp-Session-Id`** (sujeto a ledger #2).
- Validar `Origin` cuando venga (defensa DNS-rebinding) **sin romper cuando falta** — un cliente MCP
  es un proceso local, no un navegador, y normalmente no manda `Origin`.
- Exigir `Accept: application/json, text/event-stream`.
- Las formas de respuesta de tool (`content[]` + `structuredContent`, `isError`) se mantienen
  exactamente como en `apts-mcp.js:119-129`.

Registro del lado cliente (Claude Code):

```json
{ "mcpServers": { "apts": {
    "type": "http",
    "url": "https://apts.informaticos.ar/mcp",
    "headers": { "Authorization": "Bearer ${APTS_API_KEY}" }
}}}
```

Estimación: ~150 líneas nuevas en el backend, **cero dependencias nuevas**, cero migraciones.
Alternativa descartada por ahora: `@modelcontextprotocol/sdk` con `StreamableHTTPServerTransport`
— mete una dependencia para resolver algo que ya está medio resuelto en `dispatch()`.

## 6. Fases de ejecución (cada una PARA en su gate)

### F6-0 — Diseño, verificación y cierre del ledger
Sin código. Cerrar las 7 decisiones abiertas de §3. Verificar por inspección del repo:
(a) cuántas de las 21 ops ya tienen *ruta fina → función de lib* reutilizable in-process;
(b) dónde vive hoy la validación de cada payload (cliente vs. ruta) y qué hueco deja el remoto;
(c) qué operaciones pueden exceder el timeout típico de un cliente MCP (indexado semántico,
`analyze`) y si necesitan tratamiento aparte. PoC throwaway en `APTS_test` si hace falta cerrar #1.
**GATE STOP:** ledger cerrado y aprobado por el operador; forma del endpoint y del modelo de
identidad fijadas por escrito.

### F6-1 — Espolón: transporte Streamable HTTP sin estado
Refactor de `dispatch()` a transporte-agnóstico (devuelve, no escribe) sin romper stdio.
`POST /mcp` + `GET /mcp` → 405 en `backend/index.js`. **La ejecución sigue pasando por
`apts-client.js` contra el propio server** — se mantiene el salto HTTP interno a propósito, para
aislar la variable *transporte* de la variable *ejecución*. Driver JSON-RPC sobre HTTP contra
`APTS_test`.
**GATE STOP:** `initialize` / `tools/list` / `tools/call` funcionan sobre HTTP; se listan las 21
tools; un lifecycle corto pasa end-to-end; **informe explícito sobre el coste real de la identidad
explícita** (cuántos campos por llamada, cuántos tokens, cuántos errores del agente). Si aquí la
identidad resulta intolerable, se replantea el ledger #1 antes de seguir.

### F6-2 — Ejecución in-process + paridad de validación
Sustituir el salto HTTP interno por invocación directa de las funciones de negocio. Portar/asegurar
la validación del contrato del lado servidor (ledger #4). `contract-check` pasa a test interno del
backend.
**GATE STOP:** **paridad demostrada** — para las 21 operaciones, el mismo payload produce el mismo
resultado por stdio y por remoto, incluidos los rechazos (lo que el cliente validaba, el servidor lo
rechaza igual). `contract-check` verde. stdio intacto.

### F6-3 — Registro remoto en el manifiesto
El manifiesto publica el bloque de registro remoto por runtime (Claude Code / opencode / vscode) como
**dato, no como prosa**. Artefactos de script marcados `deprecated` pero servibles. Bump aditivo
`schema_version` 3.1.0 → 3.2.0 + nota append-only.
**GATE STOP:** un cliente puede registrar el MCP leyendo **solo** el manifiesto, sin descargar ningún
script; el manifiesto 3.1.0 sigue siendo válido para clientes viejos; stdio sigue funcionando.

### F6-4 — Validación end-to-end desde cliente fresco
Cliente solo-spec, **cero descargas**, registrado contra el endpoint remoto y conducido de
`analysis` a `phase=done` contra `APTS_test`.
**GATE STOP:** lifecycle completo desde cliente fresco sin artefactos locales; `APTS_test` restaurado
al baseline; informe de cierre F6.

## 7. Riesgos

- **Identidad (ledger #1) es el riesgo dominante.** Si la identidad explícita resulta inmanejable
  para el agente, F6-2/3/4 se construyen sobre una superficie peor que la actual. Mitigación: el
  gate de F6-1 exige medirla antes de invertir en lo demás.
- **Hueco de validación.** `apts-client.js` valida antes de mandar; si las rutas no replican esa
  validación, el endpoint remoto es más laxo que el stdio y acepta payloads inválidos. Mitigación:
  verificación explícita en F6-0(b), criterio de paridad en el gate de F6-2.
- **Rate limit.** `apiLimiter` 100/min ya se golpeó en F5-4 con un lifecycle completo; si el remoto
  es toda la superficie, hay que dimensionarlo (ledger #6).
- **Timeouts en operaciones largas.** Indexado semántico y `analyze` pueden exceder el timeout de un
  cliente MCP, algo que por stdio no se notaba igual. Verificar en F6-0(c).
- **Tamaño de payload.** `express.json()` tiene límite por defecto; los artefactos y
  `acceptance_criteria` pueden ser grandes (el fix de paginación `25b1111` sugiere que hay volumen).
- **`Origin` ausente.** Validar `Origin` es correcto para navegadores y **falso positivo** para un
  cliente MCP local, que no lo manda. No rechazar por ausencia.
- **Coexistencia.** Dos caminos de entrada a la misma lógica es el escenario clásico de divergencia.
  Mitigación: el criterio de paridad de F6-2 y `dispatch()` compartido.

## 8. Convenciones vigentes (heredadas de F0–F5)

- Contrato como única fuente: las tools se derivan de `apts_skills.json`, nunca se listan a mano.
- Validación contra `APTS_test` (`NODE_ENV=test`), nunca la DB principal.
- **Infra de test:** el prefijo `NODE_ENV=test` inline **no se propaga** a procesos background en
  este entorno → usar el launcher in-process (`backend/scripts/start_test_server.js`,
  `npm run start:test`, puerto 47301) y verificar `environment:test` + identidad de la DB **antes**
  de escribir.
- Adaptadores generados = gestionados (se regeneran, no se editan a mano).
- Todo cambio en el manifiesto público exige bump de `schema_version` + nota append-only.
- Restaurar `APTS_test` a su baseline al terminar cada fase (2 initiatives preexistentes,
  `epics:2`, `backlog_items:358`); borrar harnesses y drivers throwaway.
