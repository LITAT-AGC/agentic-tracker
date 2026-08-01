# Plan F6: MCP remoto (el backend expone el endpoint, el cliente no descarga scripts)

> Documento de planificación. Estado y avance se llevan en
> [`TRACKING-mcp-remoto.md`](./TRACKING-mcp-remoto.md).
> Fecha de redacción: 2026-08-01. Rama de trabajo: `feat/mcp-remoto`, creada desde `main` @ `6fd94ac`.
> **Regla de oro: se PARA al final de cada fase**, a esperar validación humana, antes de pasar a la
> siguiente, igual que en [`PLAN-motor-metodo-cliente.md`](./PLAN-motor-metodo-cliente.md).
>
> **Estado: §3 cerrada y firmada el 2026-08-01.** Las secciones §3, §5, §6 y §7 se actualizaron con
> lo decidido y con lo que se verificó en F6-0; en §7 hay una corrección de diagnóstico respecto a
> la redacción original.

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
que conectar un proyecto cliente sea registrar una URL con unas cabeceras: la de la clave de acceso
y las de identidad (decisión #1).

- **Alcance de esta versión:** ruta MCP Streamable HTTP sin estado en el backend; igualdad
  demostrada con el camino actual en las 21 operaciones; el manifiesto publica el bloque de registro
  remoto por programa cliente; validación de punta a punta desde un cliente nuevo que **no descarga
  nada**.
- **Coexistencia obligatoria:** el camino actual (`apts-mcp.js`, por entrada/salida estándar) sigue
  funcionando durante toda F6 y después. F6 solo añade; no retira nada.
- **No entra en esta versión:** OAuth 2.1 (se usa clave de acceso fija, decisión #5); canal de
  eventos del servidor al cliente; recorte de la prosa del manifiesto (decisión #7: **queda
  fuera**); retirada de los archivos descargables (se marcan obsoletos, no se borran).

## 3. Registro de decisiones — CERRADO Y FIRMADO (2026-08-01)

> Las 7 decisiones se resolvieron en F6-0 y las firmó el operador el 2026-08-01. **La resolución
> completa, con su justificación y la evidencia de código, está en el
> [TRACKING](./TRACKING-mcp-remoto.md).** Lo de abajo es el resumen; ante cualquier duda manda el
> TRACKING.

| # | Decisión | Resolución firmada |
|---|---|---|
| **1. Modelo de identidad** | **Va en la configuración del cliente**, en cabeceras `X-APTS-Project-Url` / `-Agent-Name` / `-Agent-Email`. Lo que traiga la llamada gana a la cabecera; si faltan las dos, error claro. `task_id` y `branch` se escriben en la llamada. **Esto replantea el registro:** no es ninguna de las tres opciones que proponía este PLAN. Las descartadas, con evidencia: una clave por proyecto exigiría una tabla de claves que no existe (`APTS_API_KEY` es un secreto único global, `index.js:165`); guardar la identidad por sesión obligaría a mantener estado, contra la #2. |
| **2. Estado de sesión** | **Sin estado.** No se emite `Mcp-Session-Id`; `GET /mcp` → 405. |
| **3. Ejecución dentro del proceso** | **Llamada directa a las funciones de negocio.** Verificado: **18 de 21 operaciones ya tienen la lógica en una función aparte reutilizable**; las 3 restantes la llevan dentro de la ruta y son de solo lectura. |
| **4. Igualdad de validación** | **Se endurece el servidor**, no se relaja el cliente. De los **6 huecos** encontrados se cierran los **5 que guardan datos**, más `track`, `phase` y `spec_artifact.content` en `create_initiative`. `heartbeat` queda como **diferencia aceptada y declarada**: el servidor descarta esos campos (`index.js:3058`). |
| **5. Auth** | **Clave de acceso fija**, reutilizando `authenticateAgent` (`index.js:159`) sin cambios, comprobada antes de interpretar el mensaje. OAuth 2.1 fuera de esta versión, no bloqueado. |
| **6. Ruta y límites** | Ruta **`/mcp`**. **Tope global de peticiones a 600/min**, un solo contador *(elección del operador; costo asumido: agente y panel comparten cuota)*. **Tamaño de mensaje a 4 MB solo en `/mcp`**: hoy `express.json()` está sin configurar y el tope real son 100 kb (`index.js:109`). |
| **7. Destino de los archivos descargables** | **Convivencia**: los 4 se marcan obsoletos y se siguen sirviendo. `contract-check` pasa además a prueba interna. **El recorte de la prosa del manifiesto queda fuera de F6.** |
| **Coexistencia con el camino actual** | La superficie por entrada/salida estándar sigue viva durante y después de F6. Nada se retira. |
| **Contrato como fuente** | Las operaciones de la ruta remota se derivan de `apts_skills.json`, igual que las actuales. Sin listas paralelas. |
| **Parada por fase** | Se para en cada punto de control; si una decisión resulta mal planteada, se replantea, no se improvisa. |

**Añadido a F6 fuera del registro original**, decidido en la misma sesión: se le pone un **plazo de
espera de 10 segundos** a la llamada a OpenRouter (`semantic_embeddings.js:173`, hoy sin
`AbortSignal`). Motivo en §7.

## 4. Arquitectura objetivo (delta sobre lo existente)

```
Hoy:     agente → apts-mcp.js (stdio) → apts-client.js → HTTP → rutas express → lib → resolver
F6:      agente → HTTP/MCP → POST /mcp (backend) ─────────────────────────────► lib → resolver
         (stdio sigue existiendo intacto en paralelo)

apts-mcp.js       ──► `dispatch()` devuelve la respuesta en vez de escribirla en la salida estándar
backend/index.js  ──► + POST /mcp (JSON-RPC sobre HTTP) + GET /mcp → 405
identidad         ──► cabeceras del registro; la llamada gana a la cabecera (decisión #1)
contrato          ──► sin cambios (mismas 21 operaciones, mismo apts_skills.json)
validación        ──► se endurece del lado del servidor: 5 huecos (decisión #4)
manifiesto        ──► publica el bloque de registro remoto por programa cliente; archivos → obsoletos
contract-check    ──► pasa de archivo distribuido a prueba interna del backend
```

## 5. Forma del transporte (Streamable HTTP, modo sin estado)

Protocolo `2025-06-18`, el mismo que ya declara `apts-mcp.js:24`.

- **`POST /mcp`** — cuerpo = un mensaje JSON-RPC (`initialize`, `tools/list`, `tools/call`, `ping`).
  Respuesta `application/json` con el resultado. Notificación (sin `id`) → `202` con cuerpo vacío.
- **`GET /mcp`** — sería el canal SSE servidor→cliente. **No hace falta**: las 21 ops son
  petición→respuesta. Devolver `405`; la spec lo contempla.
- **Sin `Mcp-Session-Id`** (decisión #2, firmada).
- Validar `Origin` cuando venga (defensa contra DNS-rebinding) **sin rechazar cuando falta**: un
  cliente MCP es un proceso local, no un navegador, y normalmente no lo manda.
- **`Accept`: desviación declarada.** Este documento pedía exigir
  `application/json, text/event-stream`. Lo implementado es más permisivo: solo se rechaza (406) si
  `Accept` viene y **excluye** `application/json`. Motivo: exigir `text/event-stream` en una ruta que
  nunca emite eventos es el mismo falso positivo que ya se evita con `Origin`. Decidido por el
  operador al abrir F6-2. Si algún día `/mcp` emite eventos, se revisa.
- Las formas de respuesta (`content[]` + `structuredContent`, `isError`) se mantienen exactamente
  como en `apts-mcp.js:119-129`.
- **Tamaño de mensaje: 4 MB solo en esta ruta**; el resto del servidor sigue en 100 kb (decisión #6).

Registro del lado cliente (Claude Code). **Las cabeceras de identidad son parte del diseño, no un
extra**: son las que sustituyen a la resolución automática que hacía el script local (decisión #1).

```json
{ "mcpServers": { "apts": {
    "type": "http",
    "url": "https://apts.informaticos.ar/mcp",
    "headers": {
      "Authorization":      "Bearer ${APTS_API_KEY}",
      "X-APTS-Project-Url": "${APTS_PROJECT_URL}",
      "X-APTS-Agent-Name":  "${APTS_AGENT_NAME}",
      "X-APTS-Agent-Email": "${APTS_AGENT_EMAIL}"
    }
}}}
```

Estimación: ~150 líneas nuevas en el backend, **cero dependencias nuevas**, cero migraciones.
Alternativa descartada por ahora: `@modelcontextprotocol/sdk` con `StreamableHTTPServerTransport`
— mete una dependencia para resolver algo que ya está medio resuelto en `dispatch()`.

## 6. Fases de ejecución (cada una PARA en su gate)

### F6-0 — Diseño, verificación y cierre del registro de decisiones ✅ FIRMADA (2026-08-01)
Sin código. Se cerraron las 7 decisiones de §3 y se verificó por inspección del repositorio:
(a) **18 de 21 operaciones** ya tienen la lógica en una función aparte reutilizable;
(b) el camino remoto deja **6 huecos de validación**, 5 de rastro y 1 que llega a la base de datos;
(c) el riesgo de agotar el plazo de espera **no estaba donde suponía este PLAN** — ver §7.
No hizo falta prueba de concepto: se cerró sobre el código y `APTS_test` no se tocó.

### F6-1 — Prueba del transporte Streamable HTTP sin estado ✅ FIRMADA (2026-08-01)
Hacer que `dispatch()` devuelva la respuesta en vez de escribirla, sin romper el camino actual.
`POST /mcp` + `GET /mcp` → 405 en `backend/index.js`. **La ejecución sigue pasando por
`apts-client.js` contra el propio servidor**: el salto HTTP interno se mantiene a propósito, para
aislar el *transporte* de la *ejecución*. Programa de prueba desechable contra `APTS_test`.

**Obligatorio en esta fase, por la decisión #1:** la ruta `/mcp` tiene que resolver la identidad
(llamada, luego cabecera), **metérsela a la llamada antes** de invocar a `apts-client.js`, y
rechazar con error claro si falta. Si no, la resolución automática del cliente leería el Git **del
propio servidor** y escribiría contra el repositorio equivocado, en silencio.

**PARADA:** `initialize` / `tools/list` / `tools/call` funcionan sobre HTTP; se listan las 21
operaciones; un ciclo corto pasa de punta a punta; e **informe sobre la identidad**: si la cabecera
llega de verdad desde el programa cliente, cuántas veces se equivoca el agente con `task_id`, y —lo
más importante— que la resolución automática del cliente **no se dispare nunca**. Si la cabecera no
llega desde algún programa cliente, se replantea la decisión #1 aquí, antes de seguir.

**Resultado (2026-08-01):** todo en verde. 27/27 comprobaciones del programa de prueba; la cabecera
**sí llega** desde Claude Code 2.1.220 y desde opencode 1.18.10, así que **la decisión #1 no se
replantea**; cero identidad del servidor filtrada a `APTS_test`. El recuento de errores del agente
con `task_id` se aplazó a F6-4 (motivo en el TRACKING). Detalle y números en
[Informe de identidad F6-1-T4](./TRACKING-mcp-remoto.md#informe-de-identidad-f6-1-t4).

### F6-2 — Ejecución dentro del proceso + igualdad de validación ✅ FIRMADA (2026-08-01)
Sustituir el salto HTTP interno por llamada directa a las funciones de negocio. Endurecer la
validación del lado del servidor (decisión #4). Ponerle plazo de espera a la llamada a OpenRouter.
`contract-check` pasa a prueba interna del backend.
**PARADA:** **igualdad demostrada** — para las 21 operaciones, la misma llamada da el mismo
resultado por el camino actual y por el remoto, **incluidos los rechazos**. La única diferencia
admitida es la de `heartbeat`, declarada de antemano en la decisión #4. `contract-check` en verde.
El camino actual, intacto.

**Resultado (2026-08-01):** **21 de 21 en verde, cero bloqueos**, incluidos los rechazos y el modo
lote. `apts-mcp.js` y `apts-client.js` no se tocaron: el camino actual no cambió ni una línea, y las
dos suites de regresión del repo pasan enteras. Tres cosas que este PLAN no había previsto se
replantearon con el operador en vez de improvisarlas: el **alcance de los plazos de espera** —§7
señalaba una sola llamada y eran **tres** las alcanzables desde las 21—, la **divergencia de
`top_k`** (única diferencia de veredicto que quedaba fuera de las declaradas) y el **lote parcial de
`create_backlog_item`**. Detalle y tabla en
[Tabla de igualdad F6-2-T5](./TRACKING-mcp-remoto.md#tabla-de-igualdad-f6-2-t5).

### F6-3 — Registro remoto en el manifiesto ✅ FIRMADA (2026-08-01)
El manifiesto publica el bloque de registro remoto por runtime (Claude Code / opencode / vscode) como
**dato, no como prosa**. Artefactos de script marcados `deprecated` pero servibles. Bump aditivo
`schema_version` 3.1.0 → 3.2.0 + nota append-only.
**GATE STOP:** un cliente puede registrar el MCP leyendo **solo** el manifiesto, sin descargar ningún
script; el manifiesto 3.1.0 sigue siendo válido para clientes viejos; stdio sigue funcionando.

**Resultado (2026-08-01):** las tres cosas del gate, medidas. Un Claude Code real registró el
servidor escribiendo el bloque que publica el manifiesto —cero artefactos descargados— y `apts_status`
resolvió la identidad **por cabecera**. El bump es **aditivo comprobado contra el manifiesto de
`HEAD`**: 0 claves desaparecidas, 0 valores cambiados, 66 añadidas, 13 artefactos antes y después. El
camino actual, intacto: 5/5 en el humo por entrada/salida estándar. **La comprobación bloqueante de
`vscode` salió en verde** —envía las tres cabeceras—, así que la decisión #1 queda confirmada en los
tres programas cliente y no se replantea. Dos decisiones se tomaron con el operador: la dirección del
endpoint se publica como campo propio `mcp_endpoint` derivado del host, y la prosa gestionada queda
en **una sola versión neutra** que no dice quién resuelve la identidad. Detalle en
[Evidencia del gate F6-3](./TRACKING-mcp-remoto.md#evidencia-del-gate-f6-3).

### F6-4 — Validación end-to-end desde cliente fresco 🛑 EN GATE (2026-08-01)
Cliente solo-spec, **cero descargas del núcleo ejecutable**, registrado contra el endpoint remoto y
conducido de `analysis` a `phase=done` contra `APTS_test`.
**GATE STOP:** lifecycle completo desde cliente fresco sin artefactos ejecutables locales;
`APTS_test` restaurado al baseline; informe de cierre F6.

**Resultado (2026-08-01):** ciclo completo verificado **en la base**, no en el reporte del agente:
`phase=done`, 2/2 historias y 2/2 tareas en `done`, 8 artefactos tipados. **0 de los 4 artefactos del
núcleo ejecutable descargados**; el `.mcp.json` y el `opencode.json` se escribieron tal cual los
publica el manifiesto. **Dos programas cliente** —Claude Code 2.1.220 y opencode 1.18.10— condujeron
el mismo proyecto por la ruta remota, y el segundo reanudó trabajo del primero. De las **176**
llamadas con identidad resuelta: 161 `project_url` por cabecera, **145 `agent_name` por la llamada**
(el cambio de rol del modelo A), **0 errores del agente con `task_id`** —la medición que F6-1 aplazó
a esta fase, que deja sin usar la salida de emergencia de la decisión #1—, 0 rechazos por identidad
ausente y 0 identidad del servidor filtrada.

**El criterio del gate se replanteó, con el operador:** este PLAN decía "cero descargas" y el
manifiesto **no publica la conducción del método**, que vive en un artefacto de prosa descargable.
Pasa a ser **"cero descargas del núcleo ejecutable"**, que es lo que prometía §1. Otros tres
hallazgos se resolvieron en el momento: el contrato afirmaba resolución automática de identidad en
**16 de 21** descripciones (corregido, con bump 3.2.0 → 3.3.0); un cliente real **pisó la identidad
de proyecto con una ruta de disco inventada** (ahora se rechaza la contradicción, dejando
`agent_name` exento para no romper el cambio de rol); y una historia podía caer en `blocked` sin
salida visible. Detalle en [Hallazgos de F6-4](./TRACKING-mcp-remoto.md#hallazgos-de-f6-4) e
[Informe de cierre F6](./TRACKING-mcp-remoto.md#informe-de-cierre-f6--mcp-remoto).

## 7. Riesgos (revisados tras F6-0)

- **Que la cabecera de identidad no llegue.** Es el riesgo que sustituye al de "identidad
  explícita". Con la decisión #1, la identidad viaja en cabeceras que pone el programa cliente. Si
  algún programa cliente no las envía, el agente se queda sin identidad y la superficie es peor que
  la actual. Se mide en la parada de F6-1, antes de invertir en el resto.
- **Que la resolución automática del cliente se dispare dentro del servidor.** Riesgo **nuevo**,
  descubierto en F6-0. En F6-1 la ruta `/mcp` llama a `apts-client.js` dentro del propio proceso del
  servidor; si una llamada llega sin `project_url`, el cliente resolvería `git remote get-url origin`
  **del servidor** y escribiría contra el repositorio de APTS **en silencio**. Se corta inyectando la
  identidad antes de invocar al cliente y rechazando cuando falte. Es criterio de bloqueo en F6-1.
- **Hueco de validación.** Confirmado en F6-0: son **6**, no una sospecha. Cinco de rastro y uno
  (`create_initiative`) que llega a la base de datos y degrada un rechazo limpio en un error 500 con
  detalle interno filtrado. ✅ **Cerrados en F6-2-T2**, más `top_k` —la que el inventario clasificaba
  como divergencia y era en realidad la última diferencia de veredicto— y un defecto previo de los
  mensajes de error, que no nombraban el campo que faltaba.
- **Llamada externa sin plazo de espera.** ✅ **Cerrado en F6-2-T4, con el alcance corregido:** no
  era una llamada sino **tres** las alcanzables desde las 21 operaciones. Además de la de
  `semantic_embeddings.js:173`, hay una **segunda implementación del embedding** en `index.js:1456`
  —la que usan `search_similar_bug_reports` y el embedding de bug de create/update— y la entrega de
  webhooks en `index.js:2721`, dentro del camino de escritura. Las tres llevan ya plazo. Quedan sin
  plazo, como deuda declarada, los modelos (`:1369`) y el chat (`:1769`) de OpenRouter, que son
  rutas del panel y no están entre las 21. El diagnóstico original decía:
- **Llamada externa sin plazo de espera (diagnóstico original).** **Corrige el diagnóstico anterior de este PLAN**, que
  señalaba al indexado semántico y a `analyze`: verificado en F6-0, ambas son rutas del panel de
  control y **no están entre las 21 operaciones**. El riesgo real es que *toda* escritura de backlog
  llama a OpenRouter con el cliente esperando, mediante `runNonBlockingSemanticOperation`
  (`index.js:609`), que tolera fallos pero **no difiere nada**; y ese `fetch` no lleva `AbortSignal`
  (`semantic_embeddings.js:173`). En modo lote se multiplica por N. Se le pone plazo de 10 s en F6-2.
- **Tope de peticiones.** Los 100/min de `apiLimiter` ya se agotaron en F5-4. En remoto cada
  operación es una petición aparte. Se sube a 600/min (decisión #6). Queda vivo el riesgo asumido de
  que agente y panel compartan cuota.
- **Tamaño de mensaje.** Confirmado: `express.json()` sin configurar deja el tope en **100 kb**
  (`index.js:109`), y `spec_artifact.content` y `apts_submit_step.output` ya lo superan. Se sube a
  4 MB solo en `/mcp` (decisión #6).
- **`Origin` ausente.** Validar `Origin` es correcto para navegadores y da falso positivo con un
  cliente MCP local, que no lo manda. No rechazar por ausencia.
- **Coexistencia.** Dos caminos de entrada a la misma lógica es el escenario clásico de divergencia.
  Se mitiga con el criterio de igualdad de F6-2 y con `dispatch()` compartido.

## 8. Convenciones vigentes (heredadas de F0–F5)

- Contrato como única fuente: las tools se derivan de `apts_skills.json`, nunca se listan a mano.
- Validación contra `APTS_test` (`NODE_ENV=test`), nunca la DB principal.
- **Infra de test:** el prefijo `NODE_ENV=test` inline **no se propaga** a procesos background en
  este entorno → usar el launcher in-process (`backend/scripts/start_test_server.js`,
  `npm run start:test`, puerto 47301) y verificar `environment:test` + identidad de la DB **antes**
  de escribir.
- Adaptadores generados = gestionados (se regeneran, no se editan a mano).
- Todo cambio en el manifiesto público exige bump de `schema_version` + nota append-only.
- Restaurar `APTS_test` a su estado de partida al terminar cada fase; borrar los programas de prueba
  desechables. **Estado de partida real, medido el 2026-08-01 antes de tocar nada:** `initiatives:2`,
  `epics:2`, **`backlog_items:361`**, `tasks:263`. *(Este documento decía `358`; era incorrecto.)*
