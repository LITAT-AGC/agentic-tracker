# Deuda posterior a F6 — lo atendido y lo que queda

> Compañero de [`PLAN-mcp-remoto.md`](./PLAN-mcp-remoto.md) y
> [`TRACKING-mcp-remoto.md`](./TRACKING-mcp-remoto.md), que quedaron **cerrados y firmados** el
> 2026-08-01. Este documento recoge el trabajo hecho **después** del cierre sobre la deuda que ese
> informe dejó escrita, y el estado en que queda la que no se tocó.
> Rama: `feat/mcp-remoto`. Fecha: 2026-08-01. Sin dependencias nuevas, sin migraciones.

## Estado

| Tema | Estado |
|---|---|
| **D** — El roster del método, descubrible sin fallar primero | ✅ Hecho, validado contra `APTS_test` |
| **C1** — Plazo de espera a las dos llamadas del panel | ✅ Hecho |
| **C2** — Las dos implementaciones duplicadas del embedding | ✅ Unificada la llamada externa; queda una duplicación menor declarada abajo |
| **E** — Recorte de la prosa del manifiesto | ✅ Hecho: **11.034 → 8.790 unidades (-20,3%)**, con ruptura declarada en 4.0.0 |
| **F** — El bucle de conducción del método, publicado como dato | ✅ Hecho, validado conduciendo a `phase=done` desde un cliente sin descargas |
| **G** — Dieta II: los cuatro artefactos obsoletos, fuera del listado | ✅ Hecho: `artifacts[]` 13 → 9, sus rutas siguen en 200 |
| **H** — Las copias en prosa del bucle, recortadas a un puntero | ✅ Hecho: **20.318 → 13.563 unidades** en cinco archivos |
| Corrida contra PROD | ⬜ Sin tocar — todo lo de abajo está medido contra `APTS_test` |

**`APTS_test` restaurado** a su estado de partida exacto: `initiatives:2`, `epics:2`,
`backlog_items:361`, `tasks:263`. Servidor de pruebas apagado.

## D — El roster del método, descubrible sin fallar primero

**El problema.** Las claves de rol (`entity_key`) que exige `set_agent_role` no las publicaba ninguna
de las 21 operaciones. Un cliente que no descarga el paquete sólo podía aprenderlas **llamando con
una clave inventada y leyendo el rechazo**. F6-4 dejó ese rechazo enumerando las claves, que era la
tirita; esto es la cura.

**Decisión del operador:** publicarlo en `create_initiative` y, condicionalmente, en `apts_status`.
Descartadas: publicarlo sólo en `create_initiative` (un agente que retoma con el contexto limpio se
queda sin vía) y publicarlo siempre en `apts_status` (viaja en todas las llamadas del ciclo, y el
coste recurrente en tokens no compensa).

**Lo implementado:**

- `create_initiative` devuelve `roster: { source_ref, entity_keys }` **en los dos caminos**, alta y
  resume. El de resume es la vía de recuperación: `create_initiative` es idempotente, así que un
  agente sin contexto vuelve a llamarlo y recupera las claves.
- `apts_next` adjunta el mismo roster **sólo** cuando el llamante no tiene puntero de rol —el único
  bloqueo cuya salida es registrar un rol— y su `why` nombra ahora la salida (`set_agent_role`).
  **Alcanza también a `apts_status`**, que compone su recomendación con el mismo resolver.
- El rechazo de `set_agent_role` sigue enumerando las claves, por la **misma fuente**
  (`loadRosterKeys`, `method_bootstrap.js`): ahora es la última red, no la única.

> **Ampliación declarada.** Lo firmado decía "`create_initiative` + `apts_status` condicional". Se
> implementó en el `return` de `apts_next`, que es de donde `apts_status` saca su recomendación, así
> que el roster aparece en las dos. Es un superset de lo firmado, con el mismo coste recurrente
> (cero) y una sola copia de la lógica. Si no interesa, se quita quitando una clave del objeto.

**Coste en tokens:** ~30 unidades de texto en el arranque y en el estado bloqueado. **Cero en el
ciclo normal**, medido: con puntero registrado, ni `apts_next` ni `apts_status` arrastran el roster.

**Contrato y manifiesto.** Dos descripciones de `apts_skills.json` dicen ahora de dónde salen las
claves. Por la convención vigente, eso obliga a bump: `skills_json.artifactVersion` 3.3.0 → **3.4.0**
y `integrationManifestSchemaVersion` 3.3.0 → **3.4.0**, con la nota añadida al final del histórico
sin reescribir las anteriores.

**Comprobado aditivo contra el manifiesto de `HEAD`**, con el mismo método que F6-3 y F6-4 (se
levantó el backend de `HEAD`, se capturó su manifiesto y se comparó el árbol de claves entero):

| Medición | Número |
|---|---|
| Claves que desaparecen | **0** |
| Claves añadidas | **0** |
| Valores que cambian | **4**, y los cuatro son de versión |
| Artefactos publicados | 13 → 13 |

## C — Plazos del panel y duplicación del embedding

**C1 — Las dos llamadas del panel ya tienen plazo.** F6-2-T4 las dejó fuera a propósito, por no estar
entre las 21 operaciones, y quedaron anotadas. No comparten valor, porque no son lo mismo:

| Llamada | Plazo | Variable | Motivo |
|---|---|---|---|
| `fetchOpenRouterModels` (`index.js`) | **10 s** | `OPENROUTER_MODELS_TIMEOUT_MS` | Es una lectura barata; el mismo valor que el embedding |
| `requestBacklogAnalysis` (`index.js`) | **120 s** | `OPENROUTER_CHAT_TIMEOUT_MS` | Es una generación de un modelo de lenguaje: corta lo colgado sin cortar lo que sólo va lento |

Las dos siguen el patrón de F6-2-T4: `AbortSignal.timeout` y un mensaje que **nombra a OpenRouter**,
que es lo que `isSemanticProviderError()` reconoce para tratarlo como fallo del proveedor.

**C2 — La llamada del embedding ya no está implementada dos veces.**
`requestOpenRouterEmbedding` (`index.js`) tenía su propio `fetch`, sus cabeceras, su plazo y su
lectura de respuesta, copiados de `scripts/lib/semantic_embeddings.js`. Se notaba: F6-2-T4 tuvo que
poner el plazo **dos veces**, una en cada copia. Ahora es sólo el envoltorio HTTP de la única
implementación, con estrategia `bug_dedup`.

Lo que el envoltorio conserva, porque es de esta superficie y no de la librería: **los códigos HTTP**.
Un texto de entrada vacío sigue siendo 400 y una respuesta sin vector sigue siendo 502; la librería,
sola, los daría como 500.

**El riesgo declarado de la unificación se descartó midiendo.** La resolución de modelo de la
librería cae por `LEGACY_STRATEGY_MODEL_CONFIG` en `openrouter_embedding_model`, exactamente la clave
que leía la copia. Comprobado en la base: `embedding_strategy:bug_dedup:model` **no existe**, y
`openrouter_embedding_model` vale `openai/text-embedding-3-small`. **Mismo modelo antes y después.**
⚠️ **Antes de desplegar a PROD hay que repetir esa comprobación en la base de PROD**: si allí sí
existe la clave de estrategia, el modelo de los embeddings de bug cambiaría, y los vectores ya
guardados dejarían de ser comparables con los nuevos.

Código muerto retirado del mismo paso: `OPENROUTER_EMBEDDINGS_URL`, `OPENROUTER_EMBEDDING_TIMEOUT_MS`
y `getEffectiveOpenRouterEmbeddingModel` en `index.js`, que ya no usaba nadie. La variable de entorno
`OPENROUTER_EMBEDDING_TIMEOUT_MS` **sigue funcionando**: la lee la librería.

### Lo que C deja sin unificar, a propósito

Decisión del operador: unificar **sólo la llamada externa**. Estas dos siguen duplicadas, y quedan
escritas aquí con su diferencia medida para quien las ataque:

| Función | En `index.js` | En la librería |
|---|---|---|
| `cosineSimilarity` | devuelve **0** con vectores incompatibles | devuelve **NaN** |
| `parseEmbeddingVector` | tolera JSON inválido | lanza |

La diferencia de `cosineSimilarity` es observable pero **benigna hoy**: la búsqueda filtra por
`Number.isFinite` y por un umbral de 0,78, así que un par incompatible se descarta por las dos vías.
Unificarlas exige medir la búsqueda antes y después.

### Hallazgo no previsto: son tres copias, no dos

El informe de cierre de F6 decía "las **dos** implementaciones duplicadas del embedding". Hay una
**tercera**: `backend/scripts/reembed_bug_embeddings.js` (`:162` y `:204`), con su propio
`getEffectiveOpenRouterEmbeddingModel`, su propio `fetch` y **sin plazo de espera**. Es un script de
mantenimiento fuera de línea, no lo alcanzan ni las 21 operaciones ni el panel, así que **no se tocó**
y queda anotado aquí.

## E — Dieta del manifiesto (schema_version 4.0.0, con ruptura)

**Decisión del operador: no interesa la compatibilidad hacia atrás.** Eso quitó la restricción que
mantenía viva toda la prosa de instalación local, así que no hizo falta ni parámetro de perfil ni dos
formas del manifiesto: se recorta de verdad y se sube a **4.0.0** declarando la ruptura.

**Alcance elegido, entre tres:** el manifiesto deja de explicar la instalación local, pero **los trece
artefactos y sus rutas de descarga se quedan intactos**. Descartadas: retirar además los cuatro
ejecutables del listado (-29%) y la retirada completa del camino de descarga (-39%), que habría
tocado el camino por entrada/salida estándar para clientes nuevos, contra la regla vigente.

**Lo que se fue:**

| Bloque | Unidades |
|---|---|
| `bootstrap.client_download_guidance` | 638 |
| `bootstrap.artifact_sync_policy` (con `updater_contract` y `legacy_cleanup_targets`) | 507 |
| `bootstrap.opencode_ai_guidance` | 168 |
| `bootstrap.ai_agent_recommended_usage` | 158 |
| `bootstrap.official_integration_script_policy` | 146 |
| `recommended_first_steps`: 12 pasos → 7, e `instructions[]`: 30 → 21 | resto |

**Resultado medido: 11.034 → 8.790 unidades por integración (-20,3%)**, mejor que el -16% previsto.
`bootstrap` pasa de 5.017 a 3.107. La función `buildLegacyCleanupTargets` quedó huérfana y se retiró;
los `deprecated_filenames` **se siguen publicando por artefacto**, así que quien mantenga su propio
actualizador conserva el dato: lo que desapareció es la receta, no los archivos.

**Hallazgo del mismo paso, corregido:** tres entradas de `instructions[]` y **todo
`identity_requirements`** seguían afirmando que el servidor MCP resuelve la identidad solo, desde
variables de entorno, `.apts/execution-context.json` o Git. Es la misma afirmación falsa que F6-3
quitó de los adaptadores y F6-4 del contrato; **nadie la había quitado del manifiesto**. Reescritas
en los mismos términos neutros, y `identity_requirements` dice ahora la regla real: la cabecera pone
el valor, la llamada gana —así conmuta de rol el agente—, y un `project_url` contradictorio se
rechaza.

## F — El bucle de conducción del método, publicado como dato

**El problema.** El bucle sólo existía como prosa descargable, dentro de
`method_orchestrator_agent` (2.813 unidades, 13 secciones). Un cliente sin descargas tenía el
transporte y las 21 operaciones, pero no sabía conducir el método: el hueco más claro que dejó F6.

**Decisión del operador, nueve casos cerrados uno a uno:** publicar **sólo la mitad que es del
motor** (1.562 de las 2.813), como **cinco cadenas de markdown** en un campo nuevo
**`method_conduction`, hermano de `mcp_endpoint`**; marcar el artefacto **obsoleto** sin retirarlo; y
exigir como validación **una conducción completa a `phase=done` desde un cliente fresco**.

**Lo que se publica y lo que no:**

| Se publica (del motor) | Unid. | Se queda en la plantilla (del cliente) | Unid. |
|---|---|---|---|
| `bootstrap_rule` | 318 | frontmatter del agente | 185 |
| `identity_switching_rule` | 174 | `Mission` | 204 |
| `drive_loop` | 330 | `Surface` (redundante con `tools/list`) | 230 |
| `generative_step_rule` | 398 | delegación en el subagente worker | 174 |
| `dev_story_completion_rule` | 342 | resiliencia, reintentos, límites, informe | 458 |

**Coste medido: 8.790 → 9.402 unidades.** No ahorra: mueve. Lo que compra es cerrar "cero
descargas" y que el bucle no pueda desincronizarse del motor que lo sirve.

### El hueco que encontró la validación (y que no habría encontrado una revisión)

`generative_step_rule` heredaba de la plantilla un "e.g. `{ title, content }` … `{ stories: [...] }`"
y **callaba que un paso puede declarar varias salidas**. El cliente fresco condujo hasta
`implementation` y **se colgó para siempre, con todas las llamadas en verde**:

- `output` es **un objeto plano**, y el motor toma de él lo que pide **cada** entrada de `outputs[]`.
- `bmad-create-epics-and-stories/2` declara **dos**: `{artifact: epics}` y `{backlog_items}`.
  Contestando sólo al artefacto, el submit devuelve `ok=true` y **no crea ninguna historia**. La fase
  avanza a `implementation` sin unidades y `dev-story` responde `wait` para siempre.

La regla dice ahora el mapa completo (`artifact` → `title`+`content`, `backlog_items` → `stories[]`,
`status` → `status`+`code_ref`, `code_ref` → `code_ref`), que hay que cubrir **todas** las
declaraciones en la misma llamada, y que **`captured[]` es la única confirmación** de que cada salida
se tomó. Coste de la corrección: **+191 unidades**. Sin ella, el dato publicado no bastaba.

## G — Dieta II: los cuatro artefactos obsoletos, fuera del listado

**Decisión del operador:** retirarlos, **plegado dentro de 4.0.0** en vez de abrir 5.0.0 — 4.0.0 no
estaba desplegado, así que ningún cliente vio una 4.0.0 sin esto y el histórico por debajo no se
toca.

- `artifacts[]` pasa de **13 a 9**. Sus definiciones se quedan porque de ellas sale la ruta.
- **Las cuatro rutas siguen respondiendo 200**, y se publican en corto bajo
  **`legacy_download_routes`** (150 unidades, derivado de las mismas entradas para que no puedan
  desalinearse). Sin ese bloque seguirían vivas pero **no descubribles**.
- **El `recommended: true` de `mcp_server` se va con su entrada.** Se mantuvo hasta 3.4.0 para que un
  cliente 3.1.0 conservara superficie; recomendar el camino muerto contradice esta versión.
- **Referencia colgante corregida:** `adapter_generator` declaraba `contract_check` en
  `depends_on_artifact_ids`. La comprobación corre ya dentro del backend al arrancar, nunca fue una
  entrada del generador, y dejarla habría apuntado a un id que el manifiesto ya no publica.

**Balance de las dos:** `artifacts[]` −1.410, `legacy_download_routes` +150, `method_conduction`
+1.592, obsolescencia del artefacto +45, corrección de la regla +191.

| Hito | Unidades |
|---|---|
| Antes de toda dieta | 11.034 |
| Tras la dieta I (4.0.0, commit `1f496ee`) | 8.790 |
| **Estado actual** | **9.402** |

## H — Las copias en prosa del bucle, recortadas a un puntero

**El planteamiento inicial estaba mal dimensionado.** Se había anotado "recortar la plantilla". Al
medir aparecieron **seis** copias del bucle, y **dos** de ellas editables a mano:

| Copia | Antes | Después | Origen |
|---|---|---|---|
| `method_conduction` (manifiesto) | — | 1.592 | **la fuente autoritativa** |
| `plantillas-agentes/…orchestrator.agent.md` | 2.813 | **1.483** | copia a mano; es el artefacto servido |
| `runtime-adapters/spec/apts-surface.json` | 9.129 | **7.760** | copia a mano; **fuente de los adaptadores** |
| adaptador vscode | 2.827 | **1.475** | generado desde la spec |
| adaptador claude | 2.769 | **1.417** | generado desde la spec |
| adaptador opencode | 2.780 | **1.428** | generado desde la spec |

Recortar sólo la plantilla habría dejado el bucle entero en la spec y en los tres adaptadores. Se
comprobó que `generate-adapters.js` emite **sólo** `runtime-adapters/{claude,opencode,vscode}/` y no
toca `plantillas-agentes/`, así que son dos fuentes independientes que hay que recortar a la vez.

**Decisión del operador:** recortar **las dos fuentes** y regenerar los adaptadores; dejar en el
hueco un **puntero con la ruta y los cinco campos**; subir `artifact_version` de los dos artefactos a
**4.0.0**, plegado en el schema 4.0.0; y validar con **generador idempotente + diff + rutas**, sin
reconducir (este paso no toca `method_conduction` ni el motor).

**Lo que se va y lo que se queda.** Se van las cuatro secciones de motor (bootstrap, cambio de rol,
bucle, paso generativo) y la mitad de motor de `Delegation Rule`. Se queda la mitad de cliente: el
envoltorio de agente, la lista de herramientas, a quién se delega, el registro de resiliencia, la
política de reintentos, los límites y el formato de informe. **Total: 20.318 → 13.563 unidades
(−6.755).**

De `Delegation Rule` se conserva una advertencia corta que no se podía perder: el worker cierra en
`review`, que **no es terminal**, así que hay que seguir `dev_story_completion_rule` del manifiesto o
la historia nunca llega a `done`.

### Hallazgo del mismo paso: la plantilla y la spec ya no decían lo mismo

Al comparar los dos cuerpos aparecieron **cuatro líneas divergentes, anteriores a este trabajo**. La
plantilla seguía afirmando que *"the official MCP server auto-resolves `project_url` and `agent_name`
from env / managed context / Git"*. Es **la misma afirmación falsa** que F6-3 quitó de los
adaptadores, F6-4 del contrato y 4.0.0(a) del manifiesto: la `surface_spec` ya estaba corregida y
**nadie había corregido la plantilla**. Ahora coinciden palabra por palabra.

## Validación

Todo contra `APTS_test` (`environment:test`, puerto 47301), con el arranque haciendo su auto-chequeo
de contrato en verde (`operations: 21`).

| Comprobación | Resultado |
|---|---|
| Roster descubrible, por la ruta remota `/mcp` | **14 / 14** |
| Unificación del embedding, con llamada real a OpenRouter | **8 / 9** (ver nota) |
| Humo por entrada/salida estándar — el camino actual | **7 / 7** |
| `scripts/test_agent_api.js` (regresión del repositorio) | completo, en verde |
| `scripts/test_agent_api_batch.js` (lotes, vuelta atrás estricta, regresiones) | completo, en verde |
| Bump del manifiesto a 3.4.0, aditivo contra `HEAD` | 0 claves perdidas, 0 añadidas, 13 → 13 |
| Dieta del manifiesto (4.0.0) | **15 / 15** |
| **Conducción a `phase=done` desde cliente fresco (F)** | **`next=done`, dos corridas** |
| **Diff de F y G contra el manifiesto de `HEAD`** | 0 claves perdidas, 11 añadidas, `artifacts[]` 13 → 9 |
| **Las 13 rutas de artefacto, tras delistar cuatro** | **13 / 13 en 200** |
| **Regresiones del repositorio, de nuevo** | `test_agent_api.js` y `test_agent_api_batch.js`, en verde |
| **Humo por entrada/salida estándar** | 21 operaciones; `apts_status` coincide con la superficie remota |
| **Generador de adaptadores, tras el recorte (H)** | idempotente: 2.ª corrida sin cambios |
| **Diff de los adaptadores (H)** | −4 secciones, +1 (`Conduction Loop`); 41 inserciones, 297 borrados |
| **Diff del manifiesto tras H** | 0 claves perdidas, 0 añadidas; sólo cambian las dos versiones |
| **Plantilla y spec servidas tras H** | sin `## Drive Loop`, sin `auto-resolves`, con `Conduction Loop` |

### Lo medido en la conducción (F)

Un programa cliente que **sólo** lee el manifiesto público y habla por `/mcp` —sin descargar ningún
artefacto— condujo el ciclo entero, **dos veces con el mismo resultado**:

| Medición | Número |
|---|---|
| Estado final | **`next=done`, `phase=done`** |
| Workflows generativos completados | 7 (`product-brief`, `prd`, `create-architecture`, `create-epics-and-stories`, `check-implementation-readiness`, `sprint-planning`, `create-story`) |
| Unidades `dev-story` cerradas | 2, de 10 pasos cada una |
| Cambios de identidad de rol | 5 |
| Elicitaciones (`await_input`) resueltas | 3 |
| `apts_submit_step` en total | 52 |
| Claves de rol publicadas por `create_initiative` | 6 |

**`APTS_test` restaurado al estado de partida exacto**, comprobado tras la limpieza:
`initiatives:2`, `epics:2`, `backlog_items:361`, `tasks:263`. Se borró también lo que dejaron las
regresiones del repositorio (5 tasks y 5 backlog_items de sus proyectos de prueba). Servidor apagado
y **puerto 47301 comprobado libre por PID**, no sólo la tarea de fondo.

Lo medido en las 15 de la dieta: los cinco bloques retirados ya no se publican y no queda rastro de
`updater_contract` ni de `legacy_cleanup_targets`; **no queda ninguna afirmación de resolución
automática de identidad** en todo el manifiesto; `mcp_endpoint` sigue con sus tres runtimes; siguen
los 13 artefactos, los 4 obsoletos siguen listados y **sus cuatro rutas de descarga siguen
respondiendo 200**; y un cliente registrado con el bloque publicado **recibe las 21 operaciones**.

Lo medido en las 14 del roster: el roster llega en alta y en resume; `apts_next` sin puntero lo trae
y dice dónde está la salida; una clave del roster publicado **es aceptada** por `set_agent_role`; el
rechazo sigue enumerando; y **con el puntero puesto, ni `apts_next` ni `apts_status` lo arrastran**.

Lo medido en la del embedding: el vector se calcula y persiste (1536 dimensiones,
`openai/text-embedding-3-small`, el mismo modelo de antes), la búsqueda vectoriza la consulta y
puntúa contra lo indexado, y una consulta vacía sigue siendo un rechazo del llamante y no un 500.
*(La única casilla en rojo era de la propia comprobación, que buscaba el identificador en un campo
que no es: el match viene como `{ similarity_score, backlog_item }`. El bug sí se encontró.)*

**El camino actual por entrada/salida estándar no cambió**: `apts-mcp.js` y `apts-client.js` no se
tocaron.

## Archivos tocados

- `backend/scripts/lib/method_bootstrap.js` — `loadRosterKeys` como fuente única; `create_initiative`
  publica el roster en los dos caminos; el rechazo de `set_agent_role` pasa a usar la misma fuente.
- `backend/scripts/lib/method_resolver.js` — `apts_next` adjunta el roster cuando el llamante no
  tiene puntero, y su `why` nombra la salida.
- `backend/index.js` — `requestOpenRouterEmbedding` delega en la librería; plazos de modelos y chat;
  código muerto retirado; bump del manifiesto a 3.4.0 con nota al final del histórico.
- `integracion/paquete-apts/apts_skills.json` — dos descripciones dicen de dónde salen las claves de
  rol. Ninguna operación, esquema ni veredicto cambia.
- `integracion/DEUDA-post-F6.md` (este), `integracion/TRACKING-mcp-remoto.md`.

## Archivos tocados por la dieta

- `backend/index.js` — cinco bloques de `bootstrap` retirados; `recommended_first_steps` de 12 a 7 y
  `instructions[]` de 30 a 21; `identity_requirements` reescrito; `buildLegacyCleanupTargets`
  retirada; `operator_prompt_template` y `mcp_endpoint.identity_rule` reescritos;
  `integrationManifestSchemaVersion` 3.4.0 → **4.0.0** con la nota de ruptura al final del histórico.
- `README.md` — la sección de sincronización de artefactos describía la política retirada.

## Archivos tocados por F y G

- `backend/index.js` — `METHOD_CONDUCTION` y su publicación como `method_conduction`;
  `method_orchestrator_agent` marcado obsoleto; los cuatro artefactos marcados `listed: false` y
  `buildLegacyDownloadRoutes`; `adapter_generator` pierde `contract_check`; la nota de 4.0.0 se
  completa con (a) y (b). **Es el único archivo de código tocado.**
- `integracion/DEUDA-post-F6.md` (este).

## Archivos tocados por H

- `integracion/plantillas-agentes/apts-method-orchestrator.agent.md` — bucle fuera, puntero dentro, y
  las cuatro líneas de identidad alineadas con la spec.
- `integracion/paquete-apts/runtime-adapters/spec/apts-surface.json` — el mismo recorte en
  `agents[].body` del orquestador del método.
- Tres adaptadores **regenerados** con `scripts/generate-adapters.js` (claude, opencode, vscode). No
  se editaron a mano: son archivos gestionados.
- `backend/index.js` — `artifact_version` de `method_orchestrator_agent` y `surface_spec` a 4.0.0, y
  el apartado (c) de la nota de 4.0.0.

**El camino actual por entrada/salida estándar no cambió**: comprobado que `1f496ee..HEAD` no toca
`apts-mcp.js` ni `apts-client.js`.

## Lo que sigue pendiente

1. **Unificar `cosineSimilarity` y `parseEmbeddingVector`**, con medición de la búsqueda antes y
   después.
2. **La tercera copia del embedding** en `reembed_bug_embeddings.js`, sin plazo de espera.
3. **Corrida contra PROD**, con la comprobación de `embedding_strategy:bug_dedup:model` **antes** de
   desplegar. Con 4.0.0 hay además una decisión de despliegue: cualquier cliente ya integrado que
   dependiera de `artifact_sync_policy` deja de encontrarla, y con G también de los cuatro
   artefactos en `artifacts[]` — aunque sus rutas sigan sirviéndose y estén publicadas en
   `legacy_download_routes`.
4. **Nada impide que las copias en prosa vuelvan a divergir.** H las alineó a mano y comprobó que la
   plantilla y el cuerpo de la spec son idénticos, pero **no hay nada que lo verifique de forma
   automática**: son dos archivos que se editan por separado. Un chequeo que compare los dos cuerpos
   —y que falle el arranque si difieren, como ya hace el auto-chequeo de contrato— cerraría el
   agujero de raíz. No se hizo: no estaba en el alcance acordado.
