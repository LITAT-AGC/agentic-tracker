#!/usr/bin/env node
// Prueba dirigida de que el conductor reintenta un fallo PASAJERO que llega por la
// superficie MCP, y no reintenta el que no lo es.
//
// Uso:  cd backend && node scripts/test_conductor_reintento_transitorio.js
// No necesita servidor ni base: levanta un APTS de mentira y lanza el conductor real.
//
// Lo que motiva la prueba, medido en "tickets" el 2026-08-17: una conexion del pool de
// Postgres que el otro extremo habia cerrado en silencio se entrego igualmente, revento
// el `select * from "tasks"` de `log_agent_progress` y el servidor devolvio un 500. La
// anotacion se perdio sin un solo reintento —y la llamada siguiente, contra el mismo
// servidor, funciono—. El conductor tenia tres reintentos configurados y no gasto
// ninguno: `intentarMcp` marcaba `reintentable = false` para TODO error de operacion.
//
// La asimetria es el defecto: el mismo 500, si llega como HTTP 5xx por el cable, si se
// reintenta. APTS ya manda `retriable` y `statusCode` dentro del objeto de error —se
// comprobo contra PROD—, asi que la informacion estaba ahi y se tiraba.
//
// Las dos mitades se fijan aqui: el error transitorio se reintenta hasta salir bien, y el
// definitivo se rinde a la primera sin gastar esperas.

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CONDUCTOR = path.join(__dirname, '..', '..', 'integracion', 'conductor', 'apts-loop.js');
const STORY = 'aaaaaaaa-1111-2222-3333-555555555555';
const OTRA = 'bbbbbbbb-5555-6666-7777-999999999999';
const TAREA = 'cccccccc-9999-0000-1111-333333333333';
const PROYECTO = 'https://example.invalid/prueba-reintento';
const AGENTE = 'prueba-reintento-dev';

let fallos = 0;
const ok = (cond, etiqueta, detalle) => {
  console.log(`${cond ? '  OK  ' : ' FALLA'} ${etiqueta}${detalle ? ` — ${detalle}` : ''}`);
  if (!cond) fallos += 1;
};

// El sobre de error tal y como lo devuelve APTS de verdad. Copiado de una respuesta real
// de PROD (`buildMcpExecutionError`): HTTP 200, `isError`, y el detalle dentro del texto.
// Se copia entero a proposito: si alla cambiara la forma, esta prueba seguiria pasando
// mientras el conductor deja de reintentar, y alguien tendria que venir a mirar por que.
const errorApts = (statusCode, mensaje, retriable) => ({
  ok: false,
  error: {
    name: 'AptsClientError',
    message: mensaje,
    code: statusCode === 404 ? 'NOT_FOUND' : 'INTERNAL',
    statusCode,
    retriable,
    details: { error: mensaje },
  },
});

let estadoTarea = 'in_progress';
let llamadas = 0;
let anotaciones = 0;      // cuantas veces se pidio log_agent_progress
let guionAnotar = null;   // que hacer en cada una

const crearApts = () => http.createServer((req, res) => {
  let cuerpo = '';
  req.on('data', (d) => { cuerpo += d; });
  req.on('end', () => {
    const responder = (obj) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.url.startsWith('/api/conductor/orders/next')) return responder({ order: null });
    if (req.url.startsWith('/api/conductor/journal')) return responder({ ok: true });

    let peticion = {};
    try { peticion = JSON.parse(cuerpo || '{}'); } catch (_) { /* da igual */ }
    const herramienta = (peticion.params && peticion.params.name) || '';
    const sobre = (datos, isError) => responder({
      jsonrpc: '2.0',
      id: peticion.id,
      result: { content: [{ type: 'text', text: JSON.stringify(datos) }], ...(isError ? { isError: true } : {}) },
    });

    if (herramienta === 'status') {
      llamadas += 1;
      const cerrando = llamadas > 1;
      return sobre({
        project_url: PROYECTO,
        phase: 'implementation',
        backlog: { total: 2, by_status: { ready_for_dev: 1, done: 1 }, done: 1, remaining: 1 },
        recommendation: {
          next: 'run_step',
          target_id: cerrando ? OTRA : STORY,
          role: 'bmad-agent-dev',
          args: { phase: 'implementation', workflow_key: 'bmad-dev-story', step_key: '1' },
        },
      });
    }
    if (herramienta === 'register_task') return sobre({ task_id: TAREA });
    if (herramienta === 'get_task') return sobre({ task: { id: TAREA, status: estadoTarea } });
    if (herramienta === 'update_task_status') {
      estadoTarea = (peticion.params.arguments || {}).status || estadoTarea;
      return sobre({ task: { id: TAREA, status: estadoTarea } });
    }
    if (herramienta === 'log_agent_progress') {
      anotaciones += 1;
      const fallar = guionAnotar && anotaciones <= guionAnotar.veces;
      if (fallar) return sobre(errorApts(guionAnotar.statusCode, guionAnotar.mensaje, guionAnotar.retriable), true);
      return sobre({ success: true, log: { id: anotaciones } });
    }
    return sobre({});
  });
});

const AGENTE_FALSO = `
(async () => {
  process.stdout.write('listo\\n');
  process.exit(0);
})();
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apts-reintento-'));
const rutaAgente = path.join(tmp, 'falso-agente.js');
fs.writeFileSync(rutaAgente, AGENTE_FALSO);
fs.writeFileSync(path.join(tmp, 'vacio.env'), '');

let corrida = 0;
const correr = (puerto, guion) => {
  corrida += 1;
  llamadas = 0;
  anotaciones = 0;
  estadoTarea = 'in_progress';
  guionAnotar = guion;
  const diario = path.join(tmp, `diario-${corrida}.jsonl`);
  const arrancado = Date.now();
  return new Promise((resolve) => {
    const hijo = spawn(process.execPath, [
      CONDUCTOR,
      '--mcp-url', `http://127.0.0.1:${puerto}/mcp`,
      '--api-key', 'clave-de-mentira',
      '--project-url', PROYECTO,
      '--agent-name', AGENTE,
      '--agent-email', 'prueba@example.invalid',
      '--agent-cmd', `"${process.execPath}" "${rutaAgente}" {prompt_file}`,
      '--max-iterations', '1',
      '--journal', diario,
      '--dotenv', path.join(tmp, 'vacio.env'),
      '--no-journal-remote',
    ], {
      env: {
        ...process.env,
        APTS_LOOP_TELEGRAM_TOKEN: '',
        APTS_LOOP_TELEGRAM_CHAT_ID: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let visto = '';
    hijo.stdout.on('data', (d) => { visto += d.toString(); });
    hijo.stderr.on('data', (d) => { visto += d.toString(); });
    hijo.on('close', (codigoSalida) => {
      if (process.env.PRUEBA_VERBOSA) console.log(`--- conductor (salida ${codigoSalida}) ---\n${visto}---`);
      const eventos = fs.existsSync(diario)
        ? fs.readFileSync(diario, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
        : [];
      resolve({ codigoSalida, visto, eventos, anotaciones, tardo: Date.now() - arrancado });
    });
  });
};

const fallosDeTarea = (r) => r.eventos.filter((e) => e.evento === 'tarea_fallo');
const reintentos = (r) => r.eventos.filter((e) => e.evento === 'reintento_red');

// El conductor anota DOS veces por vuelta y conviene tenerlo delante al leer los numeros
// de abajo: una al abrir el intento del agente (`intento 1/N`) y otra al cerrar la tarea.
// Asi que las llamadas que cuenta el servidor son estas dos mas las que aporte un
// reintento, y no una por vuelta como parecia.
const ANOTACIONES_POR_VUELTA = 2;

(async () => {
  const servidor = crearApts();
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const puerto = servidor.address().port;
  console.log(`APTS de mentira en el ${puerto}\n`);

  try {
    console.log('1) un 500 pasajero al anotar: se reintenta y la anotacion acaba entrando');
    // Exactamente el fallo de PROD: `retriable: true` porque el statusCode es 500.
    let r = await correr(puerto, {
      veces: 1, statusCode: 500, retriable: true, mensaje: 'Failed to log agent progress',
    });
    ok(r.anotaciones === ANOTACIONES_POR_VUELTA + 1,
      'la anotacion que fallo se repite: una llamada de mas, no una perdida',
      `llamadas=${r.anotaciones} (esperadas ${ANOTACIONES_POR_VUELTA + 1})`);
    ok(reintentos(r).length === 1, 'y el reintento queda en el diario',
      JSON.stringify(reintentos(r).map((e) => e.herramienta)));
    ok(fallosDeTarea(r).length === 0, 'sin apuntar un fallo, porque no lo hubo',
      JSON.stringify(fallosDeTarea(r).map((e) => e.detalle)));
    ok(!/no se pudo anotar el progreso/.test(r.visto), 'y sin el aviso que se leyo en "tickets"');
    console.log();

    console.log('2) el mismo fallo sin `retriable`: se deduce del statusCode 500');
    r = await correr(puerto, {
      veces: 1, statusCode: 500, retriable: undefined, mensaje: 'Failed to log agent progress',
    });
    ok(r.anotaciones === ANOTACIONES_POR_VUELTA + 1, 'tambien lo reintenta',
      `llamadas=${r.anotaciones} (esperadas ${ANOTACIONES_POR_VUELTA + 1})`);
    ok(fallosDeTarea(r).length === 0, 'y tampoco apunta fallo');
    console.log();

    console.log('3) un error DEFINITIVO no se reintenta: rendirse a la primera es lo correcto');
    r = await correr(puerto, {
      veces: 99, statusCode: 404, retriable: false, mensaje: 'Task not found',
    });
    ok(r.anotaciones === ANOTACIONES_POR_VUELTA,
      'cada anotacion se rinde a la primera: ni una llamada de mas',
      `llamadas=${r.anotaciones} (esperadas ${ANOTACIONES_POR_VUELTA})`);
    ok(reintentos(r).length === 0, 'ningun reintento en el diario');
    ok(fallosDeTarea(r).length === ANOTACIONES_POR_VUELTA,
      'y los fallos SI se apuntan, con su motivo',
      JSON.stringify(fallosDeTarea(r).map((e) => e.detalle)));
    ok(/Task not found/.test(r.visto), 'el mensaje del servidor llega entero al aviso');
    // Sin esto, un 404 en bucle se comeria 26 segundos de esperas por nada.
    ok(r.tardo < 15000, 'y no paga las esperas de los reintentos', `${r.tardo} ms`);
  } finally {
    servidor.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* da igual */ }
  }

  console.log(`\n${fallos === 0 ? 'TODO OK' : `${fallos} COMPROBACIONES FALLARON`}`);
  process.exit(fallos === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
