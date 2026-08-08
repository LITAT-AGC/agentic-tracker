#!/usr/bin/env node
'use strict';

// apts-loop — conductor secuencial del ciclo de implementación de una iniciativa APTS.
//
// QUÉ HACE. Pregunta al motor qué toca, lanza UN agente por unidad de trabajo con el
// contexto limpio, y repite hasta que el motor dice `done` o algo lo frena. La memoria
// entre vueltas no vive aquí: vive en el servidor (`initiatives.phase`,
// `project_state.cursor`, el backlog). Por eso este archivo no guarda estado propio —
// el diario que escribe es sólo evidencia, nunca fuente de verdad.
//
// QUÉ NO HACE. No es un lanzador de agentes de propósito general. No hace intake de
// bugs, no da de alta funcionalidades y no conduce las fases generativas (analysis,
// planning, solutioning): ésas son interactivas, tienen elicitación y su criterio de
// parada es otro. Si el motor recomienda un paso fuera del alcance, este conductor
// PARA y lo dice, en vez de improvisar. El alcance se comprueba en código
// (`--workflows`), no por convención.
//
// GRANULARIDAD. Una vuelta = una unidad de trabajo (una story), no un paso. Los diez
// pasos de `bmad-dev-story` los recorre el agente dentro de su propia sesión: relanzar
// contexto por paso pagaría releer el repositorio diez veces para una sola story.
//
// SECUENCIAL POR DISEÑO. Una unidad a la vez, un solo `agent_name`. Reanudar es gratis
// y no hace falta coordinar a nadie: si el conductor muere a mitad, el puntero del
// motor sigue sosteniendo la story y la siguiente vuelta la retoma donde estaba.
//
// REINTENTOS. El modo de fallo que motiva reintentar es el PROCESO muerto (CLI caída,
// límite de contexto, rate limit), y un agente que ya no existe no puede reintentarse a
// sí mismo; cambiar de modelo, además, exige proceso nuevo por construcción. Así que
// reintenta el conductor. El reintento dentro de la sesión es otra capa y ya está
// delegada: es lo que el prompt dice sobre `control_flow`. El agente reintenta
// decisiones; el conductor, procesos.
//
// El reintento REANUDA, no repite: el claim es idempotente para el propio caller
// (`claimDevStory`) y `aptsWorkflowStep` re-sirve el paso fijado mientras el puntero
// siga `running`, así que el intento siguiente vuelve al paso donde murió el anterior
// con la misma story. De ahí que sea barato, y que escalar de modelo apunte justo a la
// parte que resistió. Lo que NO se puede deshacer es un paso ya entregado: los submits
// sólo avanzan. Un agente que entrega basura y muere después deja un caso que se
// arregla a mano.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const NOMBRE = 'apts-loop';

// Códigos de salida distintos por motivo, para que quien envuelva este proceso pueda
// distinguir "terminó el trabajo" de "hay que mirar algo" sin parsear la salida.
const SALIDA = {
  done: 0,
  config: 1,
  red: 2,
  blocked: 10,
  wait: 11,
  fuera_de_alcance: 12,
  estancado: 13,
  tope_iteraciones: 14,
  agente_fallo: 20,
};

const AYUDA = `
${NOMBRE} — conduce secuencialmente la implementación de una iniciativa APTS.

  node apts-loop.js --agent-cmd "<comando>" [opciones]

Identidad (cae al entorno si se omite):
  --mcp-url URL           APTS_MCP_URL        endpoint MCP remoto (POST /mcp)
  --api-key CLAVE         APTS_API_KEY
  --project-url URL       APTS_PROJECT_URL
  --agent-name NOMBRE     APTS_AGENT_NAME     identidad ESTABLE del conductor: debe ser
                                              la registrada como rol dev en el roster
  --agent-email CORREO    APTS_AGENT_EMAIL

Ejecución:
  --agent-cmd "..."       APTS_LOOP_AGENT_CMD
                          obligatorio. Comando que implementa UNA story: aquí se elige
                          la CLI que conduce (Claude Code, Opencode, la que sea).
                          Debe contener {prompt_file}; admite {story_id} {model}
                          {agent_name} {project_url} {iteration} {attempt}
                          {max_attempts}
  --prompt-file RUTA      plantilla de prompt propia en vez de la de por defecto
  --workflows LISTA       workflows en alcance (por defecto: bmad-dev-story)
  --dotenv RUTA           archivo de entorno a cargar (por defecto .env del directorio
                          actual; que falte NO es error, salvo si lo pides por bandera).
                          No pisa lo que ya esté en el entorno del shell.
                          Se llama así, y no --env-file, porque ese nombre lo reserva
                          Node y lo intercepta incluso detrás del script.

Modelo por intento (dos formas de escribir lo mismo; ver NOTA abajo):
  --model NOMBRE          APTS_LOOP_MODEL              modelo de todos los intentos
  --max-retries N         APTS_LOOP_MAX_RETRIES        N reintentos al mismo --model
  --model-escalation LISTA  APTS_LOOP_MODEL_ESCALATION "sonnet,opus" = 2 intentos, el
                          primero con sonnet y el segundo con opus. Su longitud fija
                          cuántos intentos hay.
                          Las dos formas juntas EN LA MISMA CAPA son error de arranque.
                          Si la línea de comandos dice algo de modelos, la capa de
                          entorno queda fuera entera (y se dice cuál ganó al arrancar).
                          Por defecto: un intento, sin reintentos.

Frenos:
  --max-iterations N      tope duro de vueltas (por defecto 50). Los reintentos NO
                          consumen vueltas: una vuelta es una story, con sus intentos.
  --max-stalls N          vueltas seguidas sin que cambie nada antes de parar (por defecto 2)
  --dry-run               resuelve e informa la primera decisión sin lanzar nada

Avisos al parar:
  --telegram-chat-id ID   APTS_LOOP_TELEGRAM_CHAT_ID   a quién avisar
                          El token se lee SÓLO de APTS_LOOP_TELEGRAM_TOKEN (nunca por
                          bandera: los argumentos se ven con ps y quedan en el historial).
                          Configurar sólo uno de los dos es error de arranque, no de parada.

Salida:
  --journal RUTA          diario JSONL (por defecto .apts/apts-loop.jsonl; "off" lo apaga)
  --on-stop "..."         comando a ejecutar al parar. Recibe el motivo por ENTORNO
                          (APTS_LOOP_REASON, APTS_LOOP_DETAIL, APTS_LOOP_PHASE,
                          APTS_LOOP_STORY_ID, APTS_LOOP_ITERATION, APTS_LOOP_PROJECT_URL,
                          APTS_LOOP_EXIT_CODE), nunca por sustitución de texto.

NOTA sobre el modelo: el conductor lanza un agente por STORY, y los diez pasos de
dev-story corren dentro de esa sesión. Por eso el modelo se elige una vez por intento
sobre una story, y no por paso. Enrutar por paso exigiría lanzar un agente por paso,
que es justo lo que esta granularidad evita. El reintento REANUDA en el paso donde
murió el intento anterior, así que escalar de modelo apunta a la parte que resistió y
no vuelve a pagar los pasos que ya cerraron.

Códigos de salida: 0 done · 1 configuración · 2 red · 10 blocked · 11 wait ·
12 fuera de alcance · 13 estancado · 14 tope de iteraciones · 20 el agente falló.
`;

// El prompt no reexplica el ciclo: apunta al manifiesto, que es la fuente autoritativa
// (`method_conduction`). Reescribirlo aquí crearía una segunda copia que se
// desincronizaría del motor, que es exactamente lo que el manifiesto vino a evitar.
const PROMPT_POR_DEFECTO = `Implementa UNA unidad de trabajo de una iniciativa BMAD conducida por APTS.

Actúa siempre como agent_name "{agent_name}". Esa identidad sostiene el claim de la
unidad: no la cambies ni la inventes en los payloads.

Unidad asignada: story {story_id} (proyecto {project_url}).

Antes de nada, lee \`method_conduction\` del manifiesto público (GET /api/public/integrar)
y sigue \`dev_story_completion_rule\` al pie. Es autoritativo; si algo de este prompt lo
contradice, gana el manifiesto.

En resumen de lo que se espera de ti:
1. \`apts_workflow_step\` para que el servidor te sirva el paso actual.
2. Haz lo que el paso pide y entrégalo con \`apts_submit_step\`. Cada submit avanza un
   paso, salvo que declares una rama (ver CONTROL DE FLUJO).
3. Repite hasta que la unidad quede cerrada (\`workflow_complete\` / \`iterable_unit_done\`),
   entregando \`output: { status: "done", code_ref: "<hash del commit>" }\` en el paso que
   declara el output de estado.
4. Si no puedes continuar, reporta el bloqueo en APTS y detente. NO cierres la story
   como done.

ELICITACIÓN. El paso de entrada de dev-story llega con \`mode: "await_input"\` y preguntas
de BMAD del tipo "¿qué story quieres desarrollar?". Bajo APTS esa pregunta ya está
respondida: el motor te asignó la story {story_id}. Reanuda tú mismo llamando otra vez a
\`apts_workflow_step\` con \`answers\` apuntando a esa story; no pares a preguntarle a nadie.
Esa licencia es SÓLO para lo que la asignación ya determina. Si un paso posterior elicita
algo que la asignación no decide, no lo inventes: reporta el bloqueo y detente.

CONTROL DE FLUJO. El payload del paso puede traer \`control_flow\` con \`branches\` —las
ramas que el método declara— y \`conditions\`, las condiciones en prosa que las gobiernan.
Con \`enforced: true\` el cursor del motor las aplica, pero no las decide: el motor no
puede evaluar "ANY validation fails" porque no ve tu árbol de trabajo. Lo decides tú y
lo declaras al entregar:

  \`output: { control: {"goto":"step:5"}, control_why: "los tests de X siguen rojos" }\`
  \`output: { control: "HALT", control_why: "no puedo resolver el conflicto de esquema" }\`

Reglas:
- \`control\` debe ser un elemento LITERAL de \`branches\`, copiado tal cual. Cualquier otra
  cosa se rechaza con \`ok:false\` y no captura nada.
- Sin \`control\`, el cursor avanza al paso siguiente: es el camino normal y no hace falta
  declarar nada para tomarlo.
- \`{"goto":"step:N"}\` mueve el cursor a ese paso, también hacia atrás — así se vuelve a
  implementar cuando la validación falla, que es justo lo que el paso 8 de dev-story
  declara. Los saltos hacia atrás están topados por unidad: agotado el tope, el motor
  degrada el salto a HALT y responde \`halted:true\` diciéndolo.
- \`HALT\` NO avanza el cursor y conserva lo ya capturado. Declararlo es parar: reporta
  además el bloqueo en APTS y termina la sesión. No lo uses para hacer una pausa.
- Un paso puede traer \`conditions\` y ninguna rama honrable. Ahí no hay nada que declarar:
  son guía del método, no una promesa del motor.

No toques el ciclo más allá de esta unidad: no arranques iniciativas, no conduzcas
fases generativas y no cierres otras stories.`;

// Se añade SÓLO a partir del segundo intento: en el camino feliz cuesta cero tokens.
// Existe porque el conductor no mira el repositorio y no puede saber si el intento
// muerto dejó el árbol a medias; el agente sí puede mirarlo, y hay que decirle que lo
// haga antes de rehacer nada.
const SUFIJO_REINTENTO = `

REINTENTO. Éste es el intento {attempt} de {max_attempts} sobre esta unidad: un intento
anterior murió sin cerrarla. El motor conservó tu claim y tu paso, así que
\`apts_workflow_step\` te va a servir el MISMO paso en el que se quedó, no el primero.
Antes de rehacer nada, mira ese paso y comprueba en qué estado quedó el árbol de
trabajo: el intento anterior pudo dejar ediciones a medias. Lo que ya esté entregado no
se puede deshacer —los submits sólo avanzan—; si lo entregado te impide continuar,
reporta el bloqueo y detente en vez de cerrar la unidad como done.`;

// ---- utilidades ----

const parsearArgs = (argv) => {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq !== -1) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const sig = argv[i + 1];
    if (sig === undefined || sig.startsWith('--')) { out[a.slice(2)] = true; continue; }
    out[a.slice(2)] = sig;
    i += 1;
  }
  return out;
};

const entero = (valor, porDefecto) => {
  const n = Number.parseInt(valor, 10);
  return Number.isFinite(n) && n >= 0 ? n : porDefecto;
};

// Sustitución sólo para el COMANDO del agente, y sólo con valores que no traen saltos
// de línea ni comillas (identificadores y números). El prompt entero nunca se sustituye
// en una línea de shell: viaja por archivo, porque interpolar prosa en un comando es
// una inyección esperando a pasar.
const sustituir = (plantilla, valores) => plantilla.replace(
  /\{(\w+)\}/g,
  (todo, clave) => (valores[clave] === undefined ? todo : String(valores[clave])),
);

const log = (msg) => process.stdout.write(`[${NOMBRE}] ${msg}\n`);

class ErrorConfig extends Error {}
class ErrorRed extends Error {}

// La parada viaja como excepción en vez de llamar a process.exit() en el sitio. En
// Windows la salida estándar hacia una tubería es asíncrona, así que salir de golpe
// tras escribir trunca el mensaje y el proceso aborta con 0xC0000409 en vez de con el
// código que le pusimos — o sea, quien envuelva el bucle recibiría basura justo en el
// momento en que más necesita saber por qué paró. Dejamos que Node salga solo.
class Parada extends Error {
  constructor(motivo, codigo) { super(motivo); this.motivo = motivo; this.codigo = codigo; }
}

// ---- entorno ----
//
// Se lee con el builtin de Node, no con dotenv: este script no requiere nada fuera de
// `node:*` y esa propiedad vale más que la comodidad — es un archivo que un operador
// copia y ejecuta, y el `dotenv` que hay en el repo es del servidor. `loadEnvFile` NO
// pisa lo que ya está en el entorno, así que la precedencia sale gratis y sin escribir
// una sola línea: bandera > entorno del shell > .env.
//
// La bandera se llama `--dotenv` y NO `--env-file`, que sería el nombre obvio: ese lo
// reserva Node y lo intercepta aunque venga detrás de la ruta del script. Peor aún, lo
// hace de forma asimétrica — medido en Node 24.11: si el archivo existe deja pasar la
// bandera a `process.argv` sin cargar nada, y si falta mata el proceso con exit 9 y un
// mensaje del runtime. O sea, se quedaría justo con el caso que aquí queremos reportar
// bien.
const cargarEnv = (ruta) => {
  const explicito = typeof ruta === 'string' && ruta.trim() ? ruta.trim() : '';
  const destino = path.resolve(explicito || '.env');
  try {
    process.loadEnvFile(destino);
    return destino;
  } catch (error) {
    // Que falte no es error: la mayoría de las corridas pasan la identidad por entorno.
    // Señalado a mano y ausente, sí: quien escribe --dotenv espera que se lea.
    if (explicito) throw new ErrorConfig(`no se pudo leer --dotenv ${destino}: ${error.message}`);
    return null;
  }
};

// ---- política de modelo por intento ----
//
// La escalera es la ÚNICA fuente del modelo de cada intento: `--model-escalation
// "sonnet,opus"` son dos intentos, el primero con sonnet y el segundo con opus. Su
// longitud fija cuántos hay, así que no existe un segundo mando capaz de
// contradecirla. `--model` con `--max-retries` es la otra forma de escribir lo mismo
// cuando todos los peldaños son iguales.
//
// Las dos formas juntas se rechazan AL ARRANCAR —un campo que contradice se rechaza,
// no se ignora— pero sólo dentro de una MISMA capa. Si la línea de comandos dice algo
// sobre modelos, la capa de entorno queda entera fuera: obligar a editar el .env para
// probar una escalera desde la consola sería justo el coste que esta comprobación no
// debe tener, y "la bandera pisa al archivo" no es una contradicción silenciosa sino lo
// que cualquiera espera. Lo que sí sería silencioso es no decir cuál ganó — y por eso
// la política se anuncia al arrancar y va al diario.
const CLAVES_MODELO = ['model', 'max-retries', 'model-escalation'];
const ETIQUETA_ENV = {
  model: 'APTS_LOOP_MODEL',
  'max-retries': 'APTS_LOOP_MAX_RETRIES',
  'model-escalation': 'APTS_LOOP_MODEL_ESCALATION',
};
const etiqueta = (fuente, clave) => (fuente === 'bandera' ? `--${clave}` : ETIQUETA_ENV[clave]);

const componerEscalera = (capa, fuente) => {
  const { model, 'max-retries': maxRetries, 'model-escalation': escalada } = capa;
  if (!model && !maxRetries && !escalada) return null;

  if (escalada && (model || maxRetries)) {
    const otras = CLAVES_MODELO
      .filter((k) => k !== 'model-escalation' && capa[k])
      .map((k) => etiqueta(fuente, k));
    throw new ErrorConfig(
      `${etiqueta(fuente, 'model-escalation')} ya dice cuántos intentos hay y con qué modelo cada uno; `
      + `${otras.join(' y ')} dice lo mismo por otra vía. Usa una sola de las dos formas.`,
    );
  }

  if (escalada) {
    const peldanos = escalada.split(',').map((s) => s.trim()).filter(Boolean);
    if (!peldanos.length) throw new ErrorConfig(`${etiqueta(fuente, 'model-escalation')} no nombra ningún modelo`);
    return { escalera: peldanos, fuente };
  }

  // Sin escalera: `--max-retries N` repite `--model` N+1 veces. Sin `--model`, repite el
  // modelo por defecto de la CLI del agente, que también es un caso legítimo.
  if (maxRetries && !/^\d+$/.test(maxRetries)) {
    throw new ErrorConfig(`${etiqueta(fuente, 'max-retries')} debe ser un entero >= 0 (recibido '${maxRetries}')`);
  }
  const intentos = (maxRetries ? Number.parseInt(maxRetries, 10) : 0) + 1;
  return { escalera: Array.from({ length: intentos }, () => model), fuente };
};

const resolverPolitica = (args) => {
  for (const k of CLAVES_MODELO) {
    if (args[k] === true) throw new ErrorConfig(`--${k} necesita un valor`);
  }
  const capa = (leer) => Object.fromEntries(CLAVES_MODELO.map((k) => [k, leer(k)]));
  const deArgs = capa((k) => (typeof args[k] === 'string' ? args[k].trim() : ''));
  const deEnv = capa((k) => (process.env[ETIQUETA_ENV[k]] || '').trim());

  // La capa de bandera se resuelve primero y corta: si gana, la de entorno ni siquiera
  // se valida. Un .env contradictorio no debe impedir un experimento desde la consola.
  const porBandera = componerEscalera(deArgs, 'bandera');
  if (porBandera) {
    return { ...porBandera, ignorado: CLAVES_MODELO.filter((k) => deEnv[k]).map((k) => ETIQUETA_ENV[k]) };
  }
  const porEntorno = componerEscalera(deEnv, 'entorno');
  if (porEntorno) return { ...porEntorno, ignorado: [] };
  return { escalera: [''], fuente: 'defecto', ignorado: [] };
};

const describirPolitica = (politica, maxIterations) => {
  const nombres = politica.escalera.map((m) => m || 'el modelo por defecto de la CLI');
  const cuerpo = politica.escalera.length === 1
    ? `${nombres[0]}, sin reintentos`
    : `escalera ${nombres.join(' → ')} (${politica.escalera.length} intentos por story)`;
  const origen = politica.fuente === 'defecto' ? 'sin configurar' : politica.fuente;
  const ignorado = politica.ignorado.length ? `; se ignora ${politica.ignorado.join(', ')} del entorno` : '';
  // El techo se dice en voz alta porque es lo que cuesta dinero: cada intento es una
  // sesión de agente entera, y multiplicarlo por las vueltas es fácil de no ver.
  const techo = politica.escalera.length > 1
    ? `; techo de sesiones: ${maxIterations} × ${politica.escalera.length} = ${maxIterations * politica.escalera.length}`
    : '';
  return `${cuerpo} [${origen}${ignorado}]${techo}`;
};

// ---- cliente MCP (la superficie declarada; no se construye un wrapper REST paralelo) ----

let idSeq = 0;

// Reintentos de red. La caída típica no es el servidor caído sino un parpadeo —una
// resolución de DNS que falla, un keepalive que el otro extremo cortó—, y el sitio donde
// muerde es la llamada a `apts_status` inmediatamente después de cerrar una unidad.
// Pasó tres veces en cuatro vueltas el 2026-08-08, siempre ahí, con el endpoint
// respondiendo 200 un minuto después. Sin esto el bucle desatendido se para y hace falta
// una persona para relanzarlo, que es exactamente el trabajo que el bucle vino a ahorrar.
//
// Se reintenta SÓLO lo que puede salir distinto: el fetch que no llegó a hablar, un 429 y
// los 5xx —la misma política que el aviso por Telegram ya aplicaba—. Un 400 es una llamada
// mal hecha, y un error JSON-RPC es el servidor contestando que no: repetirlos no cambia
// nada y esconde el motivo detrás de tres esperas. Agotados los reintentos, la parada por
// red es la misma de antes.
//
// No es una bandera. Que un parpadeo no tumbe el bucle no es una política que el operador
// tenga que afinar; y si la red está caída de verdad, la parada con código 2 sigue ahí
// veintiséis segundos después.
const REINTENTOS_RED = 3;
const ESPERA_RED_MS = [2000, 6000, 18000];

const errorRed = (mensaje, reintentable) => Object.assign(new ErrorRed(mensaje), { reintentable });

const intentarMcp = async (cfg, herramienta, argumentos) => {
  let respuesta;
  try {
    respuesta = await fetch(cfg.mcpUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
        'X-APTS-Project-Url': cfg.projectUrl,
        'X-APTS-Agent-Name': cfg.agentName,
        'X-APTS-Agent-Email': cfg.agentEmail,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `${NOMBRE}-${(idSeq += 1)}`,
        method: 'tools/call',
        params: { name: herramienta, arguments: argumentos || {} },
      }),
    });
  } catch (error) {
    throw errorRed(`no se pudo alcanzar el endpoint MCP: ${error.message}`, true);
  }

  if (!respuesta.ok) {
    const texto = await respuesta.text().catch(() => '');
    // 401/403 es configuración del operador, no algo que reintentar.
    if (respuesta.status === 401 || respuesta.status === 403) {
      throw new ErrorConfig(`${herramienta}: HTTP ${respuesta.status} ${texto.slice(0, 300)}`);
    }
    const transitorio = respuesta.status === 429 || respuesta.status >= 500;
    throw errorRed(`${herramienta}: HTTP ${respuesta.status} ${texto.slice(0, 300)}`, transitorio);
  }

  const sobre = await respuesta.json();
  if (sobre.error) throw errorRed(`${herramienta}: ${sobre.error.message || 'error JSON-RPC'}`, false);

  const texto = sobre.result && sobre.result.content && sobre.result.content[0]
    ? sobre.result.content[0].text
    : null;
  const datos = texto ? JSON.parse(texto) : null;
  if (sobre.result && sobre.result.isError) {
    throw errorRed(`${herramienta}: ${(datos && (datos.error || datos.message)) || 'la operación devolvió error'}`, false);
  }
  return datos;
};

// Los reintentos quedan en el diario, no sólo en la salida estándar: un servidor que se
// degrada se ve como reintentos que aparecen y se multiplican, y esconderlos convertiría
// esta red de seguridad en una forma de no enterarse.
const llamarMcp = async (cfg, herramienta, argumentos) => {
  for (let intento = 0; ; intento += 1) {
    try {
      return await intentarMcp(cfg, herramienta, argumentos);
    } catch (error) {
      const agotado = intento >= REINTENTOS_RED;
      if (!(error instanceof ErrorRed) || !error.reintentable || agotado) throw error;
      const espera = ESPERA_RED_MS[intento];
      log(`red: ${error.message}; reintento ${intento + 1}/${REINTENTOS_RED} en ${espera / 1000}s`);
      registrar(cfg, {
        evento: 'reintento_red',
        herramienta,
        intento: intento + 1,
        de: REINTENTOS_RED,
        espera_ms: espera,
        detalle: error.message,
      });
      await dormir(espera);
    }
  }
};

// ---- huella de progreso ----

// Todo lo que, si no cambia entre dos vueltas, significa que la vuelta no sirvió de
// nada. Se compone en el cliente a partir de lo que `apts_status` ya devuelve, así que
// no necesita ningún contador nuevo en el servidor.
const huella = (estado) => {
  const r = estado.recommendation || {};
  const args = r.args || {};
  return JSON.stringify([
    estado.phase || null,
    r.next || null,
    r.role || null,
    args.workflow_key || null,
    args.step_key || null,
    r.target_id || null,
    (estado.backlog && estado.backlog.by_status) || {},
  ]);
};

// ---- diario ----

const registrar = (cfg, evento) => {
  if (!cfg.journal) return;
  try {
    fs.mkdirSync(path.dirname(cfg.journal), { recursive: true });
    fs.appendFileSync(cfg.journal, `${JSON.stringify({ ts: new Date().toISOString(), ...evento })}\n`, 'utf8');
  } catch (error) {
    log(`aviso: no se pudo escribir el diario (${error.message})`);
  }
};

// ---- aviso por Telegram ----
//
// `--on-stop` ya permite un curl, así que esto sólo se gana el sitio por lo que el curl
// hace mal: en Windows las comillas de cmd.exe destrozan un curl con texto libre dentro;
// Telegram corta a 4096 caracteres y el `detalle` del servidor puede pasarse; y un aviso
// que falla no debe cambiar el código de salida del bucle. Nada de esto se arregla en una
// línea de shell.
const TELEGRAM_MAX_CHARS = 3500; // margen cómodo bajo el tope de 4096 de Telegram
const TELEGRAM_TIMEOUT_MS = 10000;
const TELEGRAM_REINTENTOS = 2; // misma política que el resto: sólo red, 429 y 5xx

const MARCA = {
  done: '✅', blocked: '⛔', wait: '⏸', fuera_de_alcance: '🚧',
  estancado: '🔁', tope_iteraciones: '⏱', agente_fallo: '❌', desconocido: '❓',
  red: '📡',
};

const dormir = (ms) => new Promise((res) => setTimeout(res, ms));

const notificarTelegram = async (cfg, datos) => {
  if (!cfg.telegramToken || !cfg.telegramChatId) return;

  // El token va dentro de la URL, así que cualquier mensaje de error puede arrastrarlo a
  // la salida o al diario. Se tapa antes de imprimir nada.
  const sinToken = (txt) => String(txt).split(cfg.telegramToken).join('<token>');

  const lineas = [
    `${MARCA[datos.motivo] || 'ℹ️'} APTS · ${datos.motivo}`,
    '',
    String(datos.detalle || '').slice(0, TELEGRAM_MAX_CHARS - 400),
    '',
    `proyecto: ${cfg.projectUrl}`,
    `agente: ${cfg.agentName}`,
  ];
  if (datos.fase) lineas.push(`fase: ${datos.fase}`);
  if (datos.storyId) lineas.push(`story: ${datos.storyId}`);
  if (datos.iteracion != null) lineas.push(`vuelta: ${datos.iteracion}`);
  lineas.push(`salida: ${datos.codigo}`);
  const texto = lineas.join('\n').slice(0, TELEGRAM_MAX_CHARS);

  for (let intento = 0; intento <= TELEGRAM_REINTENTOS; intento += 1) {
    try {
      const r = await fetch(`${cfg.telegramApi}/bot${cfg.telegramToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Sin `parse_mode` a propósito: el detalle viene del servidor y puede traer
        // _ * [ ` que Telegram interpretaría como formato y le harían rechazar el
        // mensaje entero — justo el mensaje que más falta hace.
        body: JSON.stringify({ chat_id: cfg.telegramChatId, text: texto, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
      });
      if (r.ok) {
        // Se dice en voz alta: un envío correcto en silencio deja al operador sin saber
        // si el aviso salió, que es lo único que quería comprobar al configurarlo.
        log('aviso enviado por Telegram');
        registrar(cfg, { evento: 'telegram', enviado: true, intento });
        return;
      }
      // 4xx que no sea 429 es configuración (chat o token equivocados): insistir no lo
      // arregla y sólo retrasa la parada.
      if (r.status !== 429 && r.status < 500) {
        const cuerpo = await r.text().catch(() => '');
        log(`aviso: Telegram rechazó el mensaje (HTTP ${r.status}) ${sinToken(cuerpo).slice(0, 200)}`);
        registrar(cfg, { evento: 'telegram', enviado: false, http: r.status });
        return;
      }
      if (intento === TELEGRAM_REINTENTOS) {
        log(`aviso: Telegram devolvió HTTP ${r.status} tras ${intento + 1} intentos`);
        registrar(cfg, { evento: 'telegram', enviado: false, http: r.status });
        return;
      }
    } catch (error) {
      if (intento === TELEGRAM_REINTENTOS) {
        log(`aviso: no se pudo avisar por Telegram (${sinToken(error.message)})`);
        registrar(cfg, { evento: 'telegram', enviado: false, error: sinToken(error.message) });
        return;
      }
    }
    await dormir(500 * (intento + 1));
  }
};

// ---- parada ----

const parar = async (cfg, { motivo, detalle, codigo, fase, storyId, iteracion }) => {
  log(`PARADA (${motivo}): ${detalle}`);
  registrar(cfg, { evento: 'parada', motivo, detalle, fase, story_id: storyId, iteracion, exit_code: codigo });

  // Primero el aviso y después el hook: el hook es un proceso del operador que puede
  // colgarse, y el aviso es justo lo que no debe quedarse esperándolo.
  await notificarTelegram(cfg, { motivo, detalle, codigo, fase, storyId, iteracion });

  if (cfg.onStop) {
    // El motivo viaja por ENTORNO, no sustituido en la línea de comandos: `detalle`
    // trae texto del servidor con comillas y saltos de línea, y meterlo en un shell
    // sería una inyección.
    const r = spawnSync(cfg.onStop, {
      shell: true,
      stdio: 'inherit',
      env: {
        ...process.env,
        APTS_LOOP_REASON: motivo,
        APTS_LOOP_DETAIL: detalle,
        APTS_LOOP_PHASE: fase || '',
        APTS_LOOP_STORY_ID: storyId || '',
        APTS_LOOP_ITERATION: String(iteracion == null ? '' : iteracion),
        APTS_LOOP_PROJECT_URL: cfg.projectUrl,
        APTS_LOOP_EXIT_CODE: String(codigo),
      },
    });
    if (r.status !== 0) log(`aviso: --on-stop terminó con código ${r.status}`);
  }
  throw new Parada(motivo, codigo);
};

// ---- lanzamiento del agente ----

const lanzarAgente = (cfg, contexto) => {
  // El número de intento entra en el nombre: si el intento 1 falla, su prompt es lo
  // primero que hace falta para diagnosticar, y el intento 2 no debe pisarlo.
  const ficheroPrompt = path.join(
    os.tmpdir(),
    `${NOMBRE}-${contexto.iteration}-${contexto.intento}-${String(contexto.story_id).slice(0, 8)}.md`,
  );
  fs.writeFileSync(ficheroPrompt, contexto.prompt, 'utf8');

  const comando = sustituir(cfg.agentCmd, {
    prompt_file: ficheroPrompt,
    story_id: contexto.story_id,
    model: contexto.modelo || '',
    agent_name: cfg.agentName,
    project_url: cfg.projectUrl,
    iteration: contexto.iteration,
    attempt: contexto.intento,
    max_attempts: cfg.escalera.length,
  });

  const cual = cfg.escalera.length > 1 ? ` (intento ${contexto.intento}/${cfg.escalera.length}${contexto.modelo ? `, ${contexto.modelo}` : ''})` : '';
  log(`vuelta ${contexto.iteration}: story ${contexto.story_id}${cual} → ${comando}`);
  const inicio = Date.now();
  const r = spawnSync(comando, { shell: true, stdio: 'inherit' });
  const ms = Date.now() - inicio;

  if (r.status === 0) {
    try { fs.unlinkSync(ficheroPrompt); } catch (_) { /* el prompt es desechable */ }
  } else {
    // Si falló, el prompt se conserva: es lo primero que hace falta para diagnosticar.
    log(`el prompt de esta vuelta queda en ${ficheroPrompt}`);
  }
  return { codigo: r.status, ms, error: r.error ? r.error.message : null };
};

// ---- configuración ----

const construirConfig = (args) => {
  const val = (clave, env) => {
    const v = args[clave.replace(/-(\w)/g, (_, c) => c.toUpperCase())] ?? args[clave];
    if (typeof v === 'string' && v.trim()) return v.trim();
    const e = process.env[env];
    return typeof e === 'string' && e.trim() ? e.trim() : '';
  };

  const cfg = {
    mcpUrl: val('mcp-url', 'APTS_MCP_URL'),
    apiKey: val('api-key', 'APTS_API_KEY'),
    projectUrl: val('project-url', 'APTS_PROJECT_URL'),
    agentName: val('agent-name', 'APTS_AGENT_NAME'),
    agentEmail: val('agent-email', 'APTS_AGENT_EMAIL'),
    // Cae al entorno como el resto: es la bandera que decide QUÉ CLI conduce (Claude
    // Code, Opencode, otra), y eso es preferencia de cada desarrollador, no del comando.
    // No se recorta con trim ni se normaliza: es una línea de shell y los espacios de
    // dentro son suyos.
    agentCmd: typeof args['agent-cmd'] === 'string' ? args['agent-cmd'] : (process.env.APTS_LOOP_AGENT_CMD || ''),
    onStop: typeof args['on-stop'] === 'string' ? args['on-stop'] : '',
    // El token SÓLO por entorno, nunca por bandera: los argumentos de un proceso los ve
    // cualquiera con `ps` o el administrador de tareas, y quedan en el historial del
    // shell. El chat id no es secreto, así que ése sí admite bandera.
    telegramToken: (process.env.APTS_LOOP_TELEGRAM_TOKEN || '').trim(),
    telegramChatId: val('telegram-chat-id', 'APTS_LOOP_TELEGRAM_CHAT_ID'),
    telegramApi: (process.env.APTS_LOOP_TELEGRAM_API || 'https://api.telegram.org').trim(),
    maxIterations: entero(args['max-iterations'], 50),
    maxStalls: entero(args['max-stalls'], 2),
    dryRun: Boolean(args['dry-run']),
    workflows: new Set(String(args.workflows || 'bmad-dev-story').split(',').map((s) => s.trim()).filter(Boolean)),
  };

  cfg.politica = resolverPolitica(args);
  cfg.escalera = cfg.politica.escalera;

  const journal = typeof args.journal === 'string' ? args.journal : path.join('.apts', `${NOMBRE}.jsonl`);
  cfg.journal = journal === 'off' ? null : path.resolve(journal);

  const faltan = [];
  if (!cfg.mcpUrl) faltan.push('--mcp-url / APTS_MCP_URL');
  if (!cfg.apiKey) faltan.push('--api-key / APTS_API_KEY');
  if (!cfg.projectUrl) faltan.push('--project-url / APTS_PROJECT_URL');
  if (!cfg.agentName) faltan.push('--agent-name / APTS_AGENT_NAME');
  if (!cfg.agentEmail) faltan.push('--agent-email / APTS_AGENT_EMAIL');
  if (faltan.length) throw new ErrorConfig(`falta configuración: ${faltan.join(', ')}`);

  if (!cfg.dryRun && !cfg.agentCmd) {
    throw new ErrorConfig('--agent-cmd es obligatorio (o usa --dry-run para inspeccionar sin lanzar nada)');
  }
  // El comando se valida SIEMPRE que exista, también en --dry-run: la documentación
  // manda empezar por ahí, y un ensayo que no comprueba el comando no sirve de ensayo.
  if (cfg.agentCmd) {
    // Sin este marcador el prompt no llegaría al agente y la vuelta giraría en vacío.
    if (!cfg.agentCmd.includes('{prompt_file}')) {
      throw new ErrorConfig('--agent-cmd debe contener {prompt_file}: el prompt viaja por archivo, no interpolado en el shell');
    }
    // Misma clase de comprobación, y cierra el último agujero silencioso: montar una
    // escalera sonnet→opus, que el comando no reciba {model}, y que los tres intentos
    // corran contra el modelo por defecto de la CLI mientras el diario dice que escaló.
    if (cfg.escalera.some(Boolean) && !cfg.agentCmd.includes('{model}')) {
      throw new ErrorConfig('hay política de modelo configurada pero --agent-cmd no contiene {model}: el modelo elegido no llegaría al agente');
    }
  }
  if (cfg.maxIterations < 1) throw new ErrorConfig('--max-iterations debe ser al menos 1');

  // El aviso a medio configurar se rechaza AL ARRANCAR, no al parar. Descubrir que el
  // notificador no funcionaba en el momento exacto en que algo se rompió es el peor
  // momento posible: es justo cuando ya nadie está mirando la consola.
  if (Boolean(cfg.telegramToken) !== Boolean(cfg.telegramChatId)) {
    throw new ErrorConfig(cfg.telegramToken
      ? 'hay APTS_LOOP_TELEGRAM_TOKEN pero falta el chat: pon --telegram-chat-id o APTS_LOOP_TELEGRAM_CHAT_ID'
      : 'hay chat de Telegram configurado pero falta APTS_LOOP_TELEGRAM_TOKEN (el token sólo se lee del entorno)');
  }
  return cfg;
};

// ---- bucle ----

// Espera entre intentos. Sin bandera: frente a una sesión de agente que dura minutos es
// ruido, y frente a un rate limit es el seguro más barato que hay. Se puede bajar por
// entorno igual que `APTS_LOOP_TELEGRAM_API`, y por el mismo motivo: para poder probar
// el bucle sin quedarse esperando de verdad.
const REINTENTO_ESPERA_MS = entero(process.env.APTS_LOOP_RETRY_DELAY_MS, 15000);

// El detalle que lee el operador a las tres de la mañana. Con un solo intento se dice
// como siempre; con varios, lo único que importa es qué modelos se probaron y con qué
// resultado, porque de ahí sale si escalar más habría servido de algo.
const describirIntentos = (intentos) => {
  if (intentos.length === 1) {
    const i = intentos[0];
    return `el agente terminó con código ${i.exit_code}${i.error ? ` (${i.error})` : ''}`;
  }
  const detalle = intentos
    .map((i) => `${i.intento}: ${i.modelo || 'modelo por defecto'} → código ${i.exit_code}`)
    .join('; ');
  return `el agente falló en los ${intentos.length} intentos (${detalle})`;
};

// Se guarda aparte porque el manejador de errores de abajo necesita poder avisar, y para
// entonces `cfg` ya no está en alcance. Un bucle desatendido que se cae porque APTS no
// responde es justo el caso en el que hace falta el aviso, y sin esto era el único que
// no lo mandaba.
let cfgActual = null;

const main = async () => {
  const args = parsearArgs(process.argv.slice(2));
  if (args.help || args.h) { process.stdout.write(AYUDA); return; }

  // Antes de componer nada: la identidad y la política de modelo pueden venir de ahí.
  const envCargado = cargarEnv(args.dotenv);

  const cfg = construirConfig(args);
  cfgActual = cfg;
  const plantillaPrompt = typeof args['prompt-file'] === 'string'
    ? fs.readFileSync(args['prompt-file'], 'utf8')
    : PROMPT_POR_DEFECTO;

  registrar(cfg, {
    evento: 'arranque',
    project_url: cfg.projectUrl,
    agent_name: cfg.agentName,
    max_iterations: cfg.maxIterations,
    max_stalls: cfg.maxStalls,
    workflows: [...cfg.workflows],
    dry_run: cfg.dryRun,
    env_file: envCargado,
    modelos: cfg.escalera,
    politica_fuente: cfg.politica.fuente,
    politica_ignorado: cfg.politica.ignorado,
  });
  log(`conduciendo ${cfg.projectUrl} como '${cfg.agentName}' (alcance: ${[...cfg.workflows].join(', ')})`);
  if (envCargado) log(`entorno cargado de ${envCargado}`);
  log(`política de modelo: ${describirPolitica(cfg.politica, cfg.maxIterations)}`);

  let huellaPrevia = null;
  let estancadas = 0;

  for (let iteracion = 1; iteracion <= cfg.maxIterations; iteracion += 1) {
    // `apts_status` es de sólo lectura: computa la misma recomendación que `apts_next`
    // pero dentro de una transacción que se rollbackea, así que el conductor NUNCA
    // reclama una story. El claim lo hace el agente cuando arranca — que es quien va a
    // sostenerlo.
    //
    // `agent_name` va explícito a propósito: en la tabla de identidad del MCP,
    // `apts_status` sólo exige `project_url` —para poder leer los conteos sin
    // identidad—, así que la cabecera no se inyecta y sin este argumento la
    // recomendación vuelve sin resolver. Los argumentos ganan a la cabecera, y aquí
    // ambos dicen lo mismo, así que no hay conflicto que rechazar.
    const estado = await llamarMcp(cfg, 'apts_status', { agent_name: cfg.agentName });
    const rec = (estado && estado.recommendation) || {};
    const fase = estado ? estado.phase : null;
    const args_ = rec.args || {};
    const b = estado && estado.backlog ? estado.backlog : { done: 0, total: 0 };

    log(`vuelta ${iteracion}: fase=${fase} next=${rec.next} backlog=${b.done}/${b.total} ${args_.workflow_key ? `wf=${args_.workflow_key}` : ''}`);
    registrar(cfg, {
      evento: 'estado', iteracion, fase, next: rec.next, role: rec.role, target_id: rec.target_id, args: args_, backlog: b,
    });

    const h = huella(estado);
    if (h === huellaPrevia) {
      estancadas += 1;
      log(`nada cambió respecto de la vuelta anterior (${estancadas}/${cfg.maxStalls})`);
      if (estancadas >= cfg.maxStalls) {
        await parar(cfg, {
          motivo: 'estancado',
          detalle: `${estancadas} vueltas seguidas sin que cambie el estado del método; el agente no está avanzando`,
          codigo: SALIDA.estancado,
          fase,
          storyId: rec.target_id,
          iteracion,
        });
      }
    } else {
      estancadas = 0;
      huellaPrevia = h;
    }

    if (rec.next === 'done') {
      // Única llamada mutante del conductor, y sólo aquí. `apts_status` resuelve la
      // recomendación dentro de una transacción que se rollbackea, y el avance de fase
      // que hace el motor va dentro: si nadie llama nunca a `apts_next`, el ciclo
      // termina de verdad pero `initiatives.phase` se queda clavado en la última fase
      // trabajada y el panel enseña un proyecto a medias que ya está hecho. Con la
      // recomendación en `done` no hay nada que reclamar, así que esta llamada sólo
      // persiste el recorrido de fases.
      const confirmado = await llamarMcp(cfg, 'apts_next', {});
      if (confirmado.next !== 'done') {
        log(`aviso: apts_status dijo done pero apts_next devolvió '${confirmado.next}' (${confirmado.why || ''})`);
      }
      registrar(cfg, { evento: 'cierre', iteracion, confirmado: confirmado.next });
      await parar(cfg, { motivo: 'done', detalle: rec.why || 'lifecycle completo', codigo: SALIDA.done, fase, iteracion });
    }
    if (rec.next === 'blocked') {
      await parar(cfg, { motivo: 'blocked', detalle: rec.why || 'bloqueado', codigo: SALIDA.blocked, fase, iteracion });
    }
    if (rec.next === 'wait') {
      // Secuencial y un solo agente: aquí `wait` no es "espera a otro", es una anomalía.
      // Casi siempre significa que este agent_name no está registrado con el rol que el
      // paso exige, y no se arregla insistiendo.
      await parar(cfg, {
        motivo: 'wait',
        detalle: `${rec.why || 'el motor pide esperar'}${rec.role ? ` (rol requerido: ${rec.role})` : ''}`,
        codigo: SALIDA.wait,
        fase,
        iteracion,
      });
    }
    if (rec.next !== 'run_step') {
      await parar(cfg, { motivo: 'desconocido', detalle: `el motor devolvió next='${rec.next}'`, codigo: SALIDA.blocked, fase, iteracion });
    }

    // ---- guarda de alcance ----
    const esUnidad = Boolean(rec.target_id) && !(estado.initiative && rec.target_id === estado.initiative.id);
    if (!cfg.workflows.has(args_.workflow_key) || !esUnidad) {
      await parar(cfg, {
        motivo: 'fuera_de_alcance',
        detalle: `el motor pide '${args_.workflow_key}/${args_.step_key}' como ${esUnidad ? 'unidad' : 'paso generativo'}, `
          + `fuera del alcance de este conductor (${[...cfg.workflows].join(', ')}). `
          + 'Condúcelo a mano o con el orquestador de método y vuelve a lanzar el bucle.',
        codigo: SALIDA.fuera_de_alcance,
        fase,
        storyId: rec.target_id,
        iteracion,
      });
    }

    if (cfg.dryRun) {
      log(`--dry-run: lanzaría un agente para la story ${rec.target_id} (rol ${rec.role}, paso ${args_.step_key})`);
      registrar(cfg, { evento: 'dry_run', iteracion, story_id: rec.target_id });
      return;
    }

    // ---- intentos sobre esta story ----
    //
    // Los reintentos viven DENTRO de la vuelta, por debajo de la medición de huella.
    // De ahí salen dos propiedades sin escribir ninguna regla especial: no consumen
    // `--max-iterations` (una vuelta es una story, con todos sus intentos), y un atasco
    // no puede sumar dos paradas — si los intentos se agotan, la vuelta termina en
    // `agente_fallo` y el bucle para sin llegar a la comprobación de estancamiento de
    // la vuelta siguiente.
    const storyId = rec.target_id;
    const intentos = [];
    let ultimo = null;
    let seguir = false; // el motor dejó de apuntar a esta story: sigue el bucle, no reintentes

    for (let intento = 1; intento <= cfg.escalera.length; intento += 1) {
      const modelo = cfg.escalera[intento - 1];
      const plantilla = intento === 1 ? plantillaPrompt : plantillaPrompt + SUFIJO_REINTENTO;
      const prompt = sustituir(plantilla, {
        story_id: storyId,
        agent_name: cfg.agentName,
        project_url: cfg.projectUrl,
        role: rec.role || '',
        iteration: iteracion,
        attempt: intento,
        max_attempts: cfg.escalera.length,
      });

      ultimo = lanzarAgente(cfg, { story_id: storyId, iteration: iteracion, intento, modelo, prompt });
      intentos.push({ intento, modelo: modelo || null, exit_code: ultimo.codigo, error: ultimo.error });
      registrar(cfg, {
        evento: 'agente',
        iteracion,
        intento,
        intentos_totales: cfg.escalera.length,
        story_id: storyId,
        modelo: modelo || null,
        exit_code: ultimo.codigo,
        ms: ultimo.ms,
        error: ultimo.error,
      });

      if (ultimo.codigo === 0) break;
      if (intento === cfg.escalera.length) break; // agotados: se decide justo debajo

      // Antes de gastar otro intento —y otro modelo, que puede ser más caro— se le
      // pregunta al motor. Cuesta CERO tokens y evita los dos derroches obvios: quemar
      // una sesión de opus en una story que el agente ya cerró antes de morir al salir,
      // e insistir sobre un bloqueo que el agente reportó correctamente.
      log(`intento ${intento}/${cfg.escalera.length} falló (código ${ultimo.codigo}); preguntando al motor antes de reintentar`);
      const revision = await llamarMcp(cfg, 'apts_status', { agent_name: cfg.agentName });
      const rev = (revision && revision.recommendation) || {};
      if (rev.next !== 'run_step' || rev.target_id !== storyId) {
        // No se decide aquí qué significa: la vuelta siguiente lo resuelve con el mismo
        // código de siempre (done, blocked, wait, fuera de alcance). Duplicar ese
        // enrutado aquí sería una segunda copia que se desincronizaría de la primera.
        log(`tras el fallo el motor ya no apunta a ${storyId} (next=${rev.next}${rev.target_id ? `, target=${rev.target_id}` : ''}); no se gasta reintento`);
        registrar(cfg, {
          evento: 'reintento_innecesario', iteracion, intento, story_id: storyId, next: rev.next, target_id: rev.target_id || null,
        });
        seguir = true;
        break;
      }
      await dormir(REINTENTO_ESPERA_MS);
    }

    if (seguir) continue;

    if (ultimo.codigo !== 0) {
      await parar(cfg, {
        motivo: 'agente_fallo',
        detalle: describirIntentos(intentos),
        codigo: SALIDA.agente_fallo,
        fase,
        storyId,
        iteracion,
      });
    }
    const gastados = intentos.length > 1 ? ` tras ${intentos.length} intentos` : '';
    log(`vuelta ${iteracion} completada en ${Math.round(ultimo.ms / 1000)}s${gastados}`);
  }

  await parar(cfg, {
    motivo: 'tope_iteraciones',
    detalle: `se alcanzó el tope de ${cfg.maxIterations} vueltas sin llegar a done`,
    codigo: SALIDA.tope_iteraciones,
    iteracion: cfg.maxIterations,
  });
};

main().catch(async (error) => {
  // Salida por `exitCode` y nunca por `process.exit()`: así Node vacía la salida
  // estándar antes de irse y el código llega entero (ver la clase Parada).
  if (error instanceof Parada) {
    process.exitCode = error.codigo;
    return;
  }
  const esConfig = error instanceof ErrorConfig;
  // La clave nunca se imprime: sólo viaja en la cabecera de la petición.
  process.exitCode = esConfig ? SALIDA.config : SALIDA.red;
  process.stderr.write(`[${NOMBRE}] ${esConfig ? 'configuración' : 'error'}: ${error.message}\n`);

  // Un error de configuración ocurre al lanzar, con el operador delante de la consola;
  // uno de red puede ocurrir horas después, sin nadie mirando. Sólo ése se avisa.
  if (!esConfig && cfgActual) {
    registrar(cfgActual, { evento: 'parada', motivo: 'red', detalle: error.message, exit_code: SALIDA.red });
    await notificarTelegram(cfgActual, { motivo: 'red', detalle: error.message, codigo: SALIDA.red });
  }
});
