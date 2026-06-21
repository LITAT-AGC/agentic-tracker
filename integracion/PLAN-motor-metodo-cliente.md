# Plan F5: motor de método conducible desde el cliente (bootstrap + orquestador)

> Documento de planificación. Estado y avance se llevan en
> [`TRACKING-motor-metodo-cliente.md`](./TRACKING-motor-metodo-cliente.md).
> Fecha de redacción: 2026-06-21. Rama propuesta: `feat/motor-metodo-cliente`.
> **Regla de oro: se PARA al final de cada fase** (gate de validación humana) antes de pasar a la
> siguiente, igual que en [`PLAN-emulacion-bmad.md`](./PLAN-emulacion-bmad.md).

## 1. Problema (verificado, no supuesto)

La emulación BMAD (F0–F4, v1 cerrada) dejó el **motor de método** funcionando en el servidor:
`initiatives → epics → stories`, `workflow_definitions/steps`, `project_state`, `entities` (los 6
agentes: analyst/pm/architect/ux-designer/dev/tech-writer), y las 5 tools del contrato
(`apts_next`, `apts_status`, `apts_set_status`, `apts_workflow_step`, `apts_submit_step`).

**Pero el motor es inalcanzable desde un proyecto cliente.** `aptsNext` arranca leyendo:

- `initiatives` con `status='active'` para el `project_url` → si no hay, devuelve
  `{ next: 'blocked', why: 'sin iniciativa activa en <project_url>' }`.
- `project_state` (puntero del `agent_name`) → si no hay, devuelve
  `{ next: 'blocked', why: "agente '<x>' sin puntero en la iniciativa" }`.

Y **lo único que crea `initiatives` / `project_state` / `epics` son los seeds** `f1_toy_fixture.js`
y `f4_url_shortener.js`, que escriben directo a la DB. No existe **ninguna** tool MCP ni ruta HTTP
de arranque. Verificado por grep sobre todo `backend/` (excluyendo `node_modules`): los únicos
`insert` a esas tablas viven en los dos seeds.

Conclusión: un cliente que invoca el manifiesto recibe las 5 tools del método, pero al llamar
`apts_next` obtiene `blocked` para siempre. Falta (a) la **operación de bootstrap** en el contrato y
(b) el **adaptador orquestador** que conduzca el bucle. El adaptador solo es necesario-pero-no-suficiente.

## 2. Objetivo

Hacer el lifecycle de roles BMAD **conducible de punta a punta desde un proyecto cliente** que solo
tiene la spec, vía tools MCP + un adaptador orquestador empaquetado en el manifiesto:

- **Alcance v1:** que `/apts-method` arranque desde una spec, cree la iniciativa en `analysis`,
  asigne el roster de roles, y conduzca `analysis → planning → solutioning → implementation → done`
  reutilizando el ADN BMAD ya sembrado, sin tocar la DB a mano.
- **No incluido en v1:** UI de gestión del método; edición de flujos/entidades desde el frontend
  (sigue siendo futuro, como en F0–F4).

## 3. Ledger de decisiones (a cerrar en F5-0, antes de codear)

| # | Decisión | Estado |
|---|---|---|
| **Forma del bootstrap** | ¿Una tool `bootstrap_method` (initiative+epic+roster en una) o separadas `create_initiative` + `set_agent_role`? Preferencia inicial: **separadas** (componibles, idempotentes, menor payload). | abierta |
| **Modelo de roster/identidad** | `project_state` tiene `unique(initiative_id, agent_name)` y `aptsNext` compara la entidad REQUERIDA por el step vs la entidad del caller. Un solo `agent_name` = un solo rol. Opciones: (A) registrar N `agent_name` (uno por rol) y que el orquestador rote identidad; (B) que el orquestador pregunte `apts_next` por rol hasta obtener `run_step`. | abierta |
| **La spec como insumo** | La spec del cliente alimenta la fase `analysis` (product-brief). ¿Se pasa como artefacto inicial (`semantic_documents`/`artifacts`) en el bootstrap, o el primer step generativo la lee del repo? | abierta |
| **source_ref / track** | El bootstrap fija `source_ref='bmad:v6.8.0'` y `track` (quick/method/enterprise) para scopear el resolver a la librería BMAD sembrada. Default `track='method'`. | abierta |
| **Epic inicial** | F4 pre-creaba 1 epic vacío (no hay tool de epics; las stories se crean en implementation). ¿El bootstrap crea ese epic o se difiere? | abierta |
| **Publicación en manifiesto** | El nuevo agente orquestador debe entrar en la lista de artefactos del manifiesto público (`/api/public/integrar`) para que el cliente lo reciba; hoy solo publica intake/executor/orchestrator planos. | abierta |
| **Contrato como fuente** | Las tools nuevas entran por `apts_skills.json` → cliente → rutas → regenerar MCP/adaptadores. Sin wrappers paralelos (regla del proyecto). | cerrada |
| **Gate por fase** | Se para en cada gate; si una decisión del ledger resulta mal, se replantea, no se improvisa. | cerrada |

## 4. Arquitectura objetivo (delta sobre lo existente)

```
Contrato (apts_skills.json)  ──►  + create_initiative, + set_agent_role   (bootstrap del método)
Cliente (apts-client.js)     ──►  + exports correspondientes + autofill
Backend (index.js + lib)     ──►  + rutas finas → method_resolver / nuevo método_bootstrap
Resolver                     ──►  sin cambios de lógica de routing; solo nuevas escrituras de arranque
Manifiesto público           ──►  publica el artefacto del orquestador del método
Superficie (apts-surface.json) ─► + agente apts-method-orchestrator + comando /apts-method
Adaptadores generados        ──►  regenerados (claude/opencode/vscode), idempotentes
```

Ningún cambio rompe el flujo plano existente (orquestador de backlog `/apts-next`): es aditivo.

## 5. Contrato nuevo (alto nivel, a fijar en F5-1)

- **`create_initiative`** `{ project_url, track?, source_ref?, phase?, title?, brief_artifact? }`
  → `{ initiative_id, phase, created|resumed }`. Idempotente por `project_url` + `status='active'`.
- **`set_agent_role`** `{ project_url, agent_name, entity_key }` → upsert de `project_state`
  (`unique(initiative_id, agent_name)`), devuelve `{ project_state_id, role }`.
- (Opcional) **`create_epic`** o pliegue dentro de `create_initiative`.

## 6. Fases de ejecución (cada una PARA en su gate)

### F5-0 — Diseño y cierre del ledger
Cerrar las decisiones abiertas de §3 (forma del bootstrap, modelo de roster, spec como insumo,
epic inicial, publicación en manifiesto). Sin código.
**GATE STOP:** ledger cerrado y aprobado por el operador; formas JSON de las tools nuevas fijadas.

### F5-1 — Backend: operaciones de bootstrap
`create_initiative` + `set_agent_role` (+ epic según ledger) en `apts_skills.json`, `apts-client.js`,
rutas en `index.js`, y la lógica de escritura (nuevo `method_bootstrap.js` o extensión del resolver).
Idempotentes, validadas en `APTS_test`. `contract-check.js` alineado.
**GATE STOP:** bootstrap crea initiative+roster(+epic) idempotente; `apts_next` deja de devolver
`blocked` tras el bootstrap y entrega el primer step real; `contract-check` verde.

### F5-2 — Regeneración de superficie MCP + manifiesto
Regenerar adaptadores (idempotentes), publicar el contrato nuevo, y exponer el artefacto del
orquestador del método en el manifiesto público. Bump aditivo de `schema_version` + nota append-only.
**GATE STOP:** MCP expone las tools nuevas; manifiesto lista el nuevo agente; `generate-adapters`
idempotente; versión del manifiesto subida con nota.

### F5-3 — Adaptador orquestador del método
Agente `apts-method-orchestrator` + comando `/apts-method` en `apts-surface.json`. Conduce:
bootstrap si falta → bucle `apts_next` → step generativo (`apts_workflow_step` → produce artefacto →
`apts_submit_step`) → step `dev-story` delega al executor existente → maneja `wait`/`await-input`/
`done`/`blocked`. Regenerar adaptadores.
**GATE STOP:** el orquestador conduce un lifecycle real (toy o proyecto chico) end-to-end contra
`APTS_test` vía el adaptador, no por harness directo.

### F5-4 — Validación end-to-end desde cliente limpio
Integrar un proyecto **solo-spec** invocando el manifiesto del server desplegado, y correr
`analysis → … → implementation` con `/apts-method`.
**GATE STOP:** proyecto real gestionado de punta a punta desde un cliente fresco; informe de cierre F5.

## 7. Riesgos

- **Modelo de roster/identidad** (decisión #2) es el punto más delicado: el `unique(agent_name)` y el
  role-matching del resolver condicionan cómo un orquestador "es" varios roles. Mitigación: cerrarlo
  en F5-0 con una prueba de concepto sobre `APTS_test` antes de tocar el contrato.
- **Publicación en manifiesto**: el generador del manifiesto público puede tener su propia fuente;
  hay que ubicarla para no dejar el agente fuera del paquete que recibe el cliente.
- **Goteo sin embeddings en vivo** (heredado de F3-T2): los `needs[]` se sirven por slice acotado;
  la recuperación semántica embedding-ranked sigue como refinamiento opcional, no bloqueante.
- **Compatibilidad con el flujo plano**: todo es aditivo; vigilar que `contract-check` y los
  adaptadores del orquestador de backlog no cambien de forma.

## 8. Convenciones vigentes (heredadas de F0–F4)

- Contrato como única fuente: tools nuevas → `apts_skills.json` → cliente → regenerar adaptadores.
- Validación contra `APTS_test` (`NODE_ENV=test`), nunca la DB principal.
- Adaptadores generados = gestionados (se regeneran, no se editan a mano).
- Todo cambio en el manifiesto público exige bump de `schema_version` + nota append-only.
- Seeds env-aware (fix 2026-06-21): producción vía `npm run deploy:prod`; fixtures bloqueadas en prod.
