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
| Publicar el bucle de conducción del método como dato | ⬜ Sin tocar |
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

## Lo que sigue pendiente

1. **Publicar el bucle de conducción del método como dato**: hoy vive en un artefacto de prosa
   descargable de 2.813 unidades. Es el hueco más claro que dejó F6. Ojo con la expectativa: pasarlo
   al manifiesto **no ahorra tokens**, los mueve de la descarga al manifiesto; lo que compra es
   cerrar "cero descargas" y que el bucle no pueda desincronizarse del motor.
2. **Seguir la dieta**, si interesa: `artifacts` es ahora el bloque mayor (3.756), y **1.410 de esos
   son los metadatos de los cuatro artefactos obsoletos**. Retirarlos del listado deja el manifiesto
   en ~7.400 sin dejar de servir los archivos.
3. **Unificar `cosineSimilarity` y `parseEmbeddingVector`**, con medición de la búsqueda antes y
   después.
4. **La tercera copia del embedding** en `reembed_bug_embeddings.js`, sin plazo de espera.
5. **Corrida contra PROD**, con la comprobación de `embedding_strategy:bug_dedup:model` **antes** de
   desplegar. Con 4.0.0 hay además una decisión de despliegue: cualquier cliente ya integrado que
   dependiera de `artifact_sync_policy` deja de encontrarla.
