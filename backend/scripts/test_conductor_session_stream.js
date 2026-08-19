#!/usr/bin/env node
// Prueba dirigida del envio a APTS de la sesion del agente.
//
// Uso:  cd backend && node scripts/test_conductor_session_stream.js
// No necesita servidor ni base: levanta un APTS de mentira en un puerto efimero y lanza el
// conductor de verdad contra el, con un agente falso que imprime la forma EXACTA que
// imprime Claude Code con `--output-format stream-json --verbose`. No toca produccion y no
// manda avisos.
//
// El fixture esta CAPTURADO de la CLI real (version 2.1.233): una corrida de dos turnos que
// lee un archivo. Lo unico editado son las dos rutas largas, acortadas para que el archivo
// se pueda leer — siguen siendo rutas absolutas de Windows, que es lo que importa cuando se
// mira si esto filtra informacion de la maquina. Si Claude Code cambia su salida, esta
// prueba es la que tiene que enterarse.
//
// Lo que se comprueba, por orden de importancia:
//   1. que la contabilidad del coste sigue saliendo IGUAL con stream-json, que es la unica
//      regresion que este cambio puede causar en algo que ya funcionaba;
//   2. que `tool_use_result` —el duplicado que trae el archivo entero— no llega nunca;
//   3. que con la bandera apagada no se manda ni una peticion.

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CONDUCTOR = path.join(__dirname, '..', '..', 'integracion', 'conductor', 'apts-loop.js');
const STORY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const TAREA = '11111111-2222-3333-4444-555555555555';
const PROYECTO = 'https://example.invalid/prueba-sesion-agente';
const AGENTE = 'prueba-sesion-dev';

let fallos = 0;
const ok = (cond, etiqueta, detalle) => {
  console.log(`${cond ? '  OK  ' : ' FALLA'} ${etiqueta}${detalle ? ` — ${detalle}` : ''}`);
  if (!cond) fallos += 1;
};

// ---- fixture: stream-json capturado de Claude Code ----

const INIT = '{"type":"system","subtype":"init","cwd":"C:\\\\repos\\\\demo","session_id":"3ed5c115-5fba-451f-945a-e19e73d7c9e9","tools":["Task","Bash","Glob","Grep","Read","Edit","Write"],"mcp_servers":[{"name":"apts","status":"connected"},{"name":"otro","status":"needs-auth"}],"model":"claude-opus-5","permissionMode":"acceptEdits","slash_commands":["init","doctor"],"apiKeySource":"none","claude_code_version":"2.1.233","output_style":"default","agents":["Explore"],"skills":["run"],"plugins":[],"analytics_disabled":false,"uuid":"66411e34-1b92-4d5e-b9ae-daeccfa0ce58"}';

const RATE_LIMIT = '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1786822200,"rateLimitType":"five_hour","overageStatus":"rejected","isUsingOverage":false},"uuid":"ec080fe1-a97e-4616-8201-1d8f2c9b2928","session_id":"3ed5c115-5fba-451f-945a-e19e73d7c9e9"}';

const TEXTO = '{"type":"assistant","message":{"model":"claude-opus-5","id":"msg_011Ce4wBFbKatPDFe3Q6kr2A","type":"message","role":"assistant","content":[{"type":"text","text":"I\'ll read the file."}],"stop_reason":null,"usage":{"input_tokens":2,"cache_creation_input_tokens":6257,"cache_read_input_tokens":20673,"output_tokens":1}},"parent_tool_use_id":null,"session_id":"3ed5c115-5fba-451f-945a-e19e73d7c9e9","uuid":"2b82f490-4693-40c2-b70b-dbf895541b96","timestamp":"2026-08-15T17:33:13.227Z","request_id":"req_011Ce4wBEjDtwrfWdok9GHCC"}';

const TOOL_USE = '{"type":"assistant","message":{"model":"claude-opus-5","id":"msg_011Ce4wBFbKatPDFe3Q6kr2A","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01VUk7KevoFPC8HNz41jVMEJ","name":"Read","input":{"file_path":"C:\\\\repos\\\\demo\\\\hola.txt"},"caller":{"type":"direct"}}],"stop_reason":null,"usage":{"input_tokens":2,"cache_creation_input_tokens":6257,"cache_read_input_tokens":20673,"output_tokens":1}},"parent_tool_use_id":null,"session_id":"3ed5c115-5fba-451f-945a-e19e73d7c9e9","uuid":"8079c1b5-344a-4b53-ab5d-d6cb634ff447","timestamp":"2026-08-15T17:33:14.808Z","request_id":"req_011Ce4wBEjDtwrfWdok9GHCC"}';

// El `user` que devuelve el resultado. Trae el MISMO contenido dos veces: en
// `message.content[].content` y otra vez entero, con su ruta absoluta, en `tool_use_result`.
// Esa segunda copia es la que crece con el tamano del repositorio y la que no debe viajar.
const conResultado = (contenido) => JSON.stringify({
  type: 'user',
  message: { role: 'user', content: [{ tool_use_id: 'toolu_01VUk7KevoFPC8HNz41jVMEJ', type: 'tool_result', content: contenido }] },
  parent_tool_use_id: null,
  session_id: '3ed5c115-5fba-451f-945a-e19e73d7c9e9',
  uuid: 'fa83e511-2a97-485e-be08-ec7f3fc8e0a3',
  timestamp: '2026-08-15T17:33:14.830Z',
  tool_use_result: {
    type: 'text',
    file: { filePath: 'C:\\repos\\demo\\hola.txt', content: contenido, numLines: 2, startLine: 1, totalLines: 2 },
  },
});

const TOOL_RESULT = conResultado('1\tping\n2\t');

// El objeto final, identico al de `--output-format json`: es lo que hace que el lector de
// coste sobreviva al cambio de formato sin tocar una linea.
const RESULT = JSON.stringify({
  is_error: false,
  duration_ms: 12000,
  num_turns: 2,
  session_id: '3ed5c115-5fba-451f-945a-e19e73d7c9e9',
  total_cost_usd: 0.0923545,
  usage: {
    input_tokens: 4, cache_creation_input_tokens: 6415, cache_read_input_tokens: 47603, output_tokens: 150,
  },
  subtype: 'success',
  result: 'listo',
  type: 'result',
});

const STREAM = [INIT, RATE_LIMIT, TEXTO, TOOL_USE, TOOL_RESULT, RESULT].join('\n') + '\n';

// NDJSON de opencode, la misma forma que usa la prueba del coste.
const OPENCODE = [
  { type: 'step_start', sessionID: 'ses_xyz', part: { type: 'step-start' } },
  { type: 'text', sessionID: 'ses_xyz', part: { type: 'text', text: 'trabajando en la unidad' } },
  {
    type: 'step_finish',
    sessionID: 'ses_xyz',
    part: { type: 'step-finish', reason: 'stop', tokens: { total: 7643, input: 7641, output: 2, cache: { write: 100, read: 200 } }, cost: 0.003 },
  },
].map((o) => JSON.stringify(o)).join('\n') + '\n';

// ---- APTS de mentira ----

const recibidos = { lotes: [], eventos: [], peticiones: 0 };
let responderSesion = (res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ received: 0, stored: 0 })); };

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
    if (req.url.startsWith('/api/conductor/session')) {
      recibidos.peticiones += 1;
      let lote = {};
      try { lote = JSON.parse(cuerpo || '{}'); } catch (_) { /* se vera en las aserciones */ }
      recibidos.lotes.push(lote);
      for (const e of lote.events || []) recibidos.eventos.push(e);
      return responderSesion(res);
    }

    let peticion = {};
    try { peticion = JSON.parse(cuerpo || '{}'); } catch (_) { /* da igual */ }
    const herramienta = (peticion.params && peticion.params.name) || '';
    let datos = {};
    if (herramienta === 'status') {
      datos = {
        project_url: PROYECTO,
        phase: 'implementation',
        backlog: { total: 2, by_status: { ready_for_dev: 2 }, done: 0, remaining: 2 },
        recommendation: {
          next: 'run_step',
          target_id: STORY,
          role: 'bmad-agent-dev',
          args: { phase: 'implementation', workflow_key: 'bmad-dev-story', step_key: '1' },
        },
      };
    } else if (herramienta === 'register_task') {
      // La tarea es imprescindible aqui: la sesion cuelga de ella, igual que el diario.
      datos = { task_id: TAREA, owns_backlog_item: false };
    } else if (herramienta === 'get_backlog_item') {
      datos = { item: { id: STORY, title: 'Una unidad de prueba' } };
    }
    return responder({
      jsonrpc: '2.0',
      id: peticion.id,
      result: { content: [{ type: 'text', text: JSON.stringify(datos) }] },
    });
  });
});

// ---- agente falso ----

const AGENTE_FALSO = `
process.stdout.write(process.env.FALSO_STDOUT || '');
process.exit(Number(process.env.FALSO_CODIGO || 0));
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apts-loop-sesion-'));
const rutaAgente = path.join(tmp, 'falso-agente.js');
fs.writeFileSync(rutaAgente, AGENTE_FALSO);
fs.writeFileSync(path.join(tmp, 'vacio.env'), '');

let corrida = 0;
const correr = (puerto, {
  stdout, codigo = 0, stream = true, env = {}, vueltas = 1,
}) => {
  corrida += 1;
  recibidos.lotes = [];
  recibidos.eventos = [];
  recibidos.peticiones = 0;
  const diario = path.join(tmp, `diario-${corrida}.jsonl`);
  return new Promise((resolve) => {
    const args = [
      CONDUCTOR,
      '--mcp-url', `http://127.0.0.1:${puerto}/mcp`,
      '--api-key', 'clave-de-mentira',
      '--project-url', PROYECTO,
      '--agent-name', AGENTE,
      '--agent-email', 'prueba@example.invalid',
      '--agent-cmd', `"${process.execPath}" "${rutaAgente}" {prompt_file}`,
      '--max-iterations', String(vueltas),
      '--max-stalls', '99',
      '--journal', diario,
      '--dotenv', path.join(tmp, 'vacio.env'),
      '--no-journal-remote',
    ];
    if (stream) args.push('--session-stream');

    const hijo = spawn(process.execPath, args, {
      env: {
        ...process.env,
        FALSO_STDOUT: stdout,
        FALSO_CODIGO: String(codigo),
        APTS_LOOP_TELEGRAM_TOKEN: '',
        APTS_LOOP_TELEGRAM_CHAT_ID: '',
        ...env,
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
      resolve({
        codigoSalida,
        visto,
        diario: eventos,
        sesion: recibidos.eventos.slice(),
        lotes: recibidos.lotes.slice(),
        peticiones: recibidos.peticiones,
      });
    });
  });
};

const agente = (r) => r.diario.find((e) => e.evento === 'agente') || {};
const deTipo = (r, kind) => r.sesion.filter((e) => e.kind === kind);
const crudo = (r) => JSON.stringify(r.lotes);

(async () => {
  const servidor = crearApts();
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const puerto = servidor.address().port;
  console.log(`APTS de mentira en el ${puerto}\n`);

  try {
    console.log('1) stream-json de Claude Code: la sesion llega, normalizada');
    let r = await correr(puerto, { stdout: STREAM });
    ok(r.sesion.length === 6, 'seis eventos (init, rate_limit, texto, herramienta, resultado, fin)', String(r.sesion.length));
    ok(r.sesion.every((e) => e.task_id === undefined) && r.lotes.every((l) => l.task_id === TAREA),
      'el task_id va una vez por lote y no por evento');
    ok(r.sesion.map((e) => e.kind).join(',') === 'init,aviso,texto,herramienta,resultado,fin',
      'y en el orden en que ocurrieron', r.sesion.map((e) => e.kind).join(','));
    ok(r.sesion.every((e, i) => e.seq === i + 1), 'el seq es monotono y arranca en 1',
      r.sesion.map((e) => e.seq).join(','));
    ok(r.sesion.every((e) => typeof e.ts === 'string' && !Number.isNaN(Date.parse(e.ts))), 'cada evento lleva su reloj');
    console.log();

    console.log('2) LA REGRESION QUE IMPORTA: el lector de coste sobrevive a stream-json');
    const a = agente(r);
    ok(a.runtime === 'claudecode', 'sigue reconociendo el runtime', a.runtime);
    ok(a.coste_usd === 0.0923545, 'el coste es el que dijo la CLI', String(a.coste_usd));
    ok(a.tokens && a.tokens.entrada === 4 && a.tokens.salida === 150
      && a.tokens.cache_lectura === 47603 && a.tokens.cache_escritura === 6415,
      'los cuatro numeros de tokens', JSON.stringify(a.tokens));
    ok(a.turnos === 2, 'y los turnos', String(a.turnos));
    ok(!/objeto `type:"result"`/.test(r.visto), 'sin avisos raros');
    console.log();

    console.log('3) el duplicado que trae el archivo entero NO viaja');
    ok(!crudo(r).includes('tool_use_result'), 'ni la clave `tool_use_result`');
    ok(!crudo(r).includes('numLines'), 'ni nada de la estructura de archivo que cuelga de ella');
    const resultado = deTipo(r, 'resultado')[0];
    ok(resultado && resultado.payload.id === 'toolu_01VUk7KevoFPC8HNz41jVMEJ',
      'del resultado se conserva el id de la llamada');
    ok(resultado && resultado.payload.salida.includes('ping'), 'y su contenido', resultado && resultado.payload.salida);
    console.log();

    console.log('4) el init se reduce: lo que cambia por corrida, no las listas estaticas');
    const init = deTipo(r, 'init')[0];
    ok(init && init.payload.modelo === 'claude-opus-5' && init.payload.sesion === '3ed5c115-5fba-451f-945a-e19e73d7c9e9',
      'modelo y sesion');
    ok(init && init.payload.herramientas === 7, 'las herramientas se cuentan, no se copian', String(init && init.payload.herramientas));
    ok(!crudo(r).includes('"Glob"'), 'la lista de herramientas no viaja');
    ok(!crudo(r).includes('slash_commands'), 'ni los comandos');
    ok(init && Array.isArray(init.payload.mcp) && init.payload.mcp.includes('otro:needs-auth'),
      'el estado de los MCP si viaja: explica una story entera que no llego a nada');
    console.log();

    console.log('5) el aviso de limite trae la hora de reset, antes de que muerda');
    const aviso = deTipo(r, 'aviso')[0];
    ok(aviso && aviso.payload.subtipo === 'rate_limit', 'se reconoce el evento');
    ok(aviso && aviso.payload.reset === new Date(1786822200 * 1000).toISOString(),
      'y el unix se convierte a fecha', aviso && aviso.payload.reset);
    console.log();

    console.log('6) los deltas de mensaje parcial se descartan');
    const conDeltas = [INIT, '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"ho"}}}',
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"la"}}}', TEXTO, RESULT].join('\n') + '\n';
    r = await correr(puerto, { stdout: conDeltas });
    ok(r.sesion.length === 3, 'tres eventos, no cinco', String(r.sesion.length));
    ok(!crudo(r).includes('stream_event'), 'y ni rastro de los deltas');
    console.log();

    console.log('7) un tipo desconocido se conserva reducido en vez de tirarse');
    r = await correr(puerto, { stdout: [INIT, '{"type":"invento_futuro","cosa":"que todavia no existe"}', RESULT].join('\n') + '\n' });
    const otro = deTipo(r, 'otro')[0];
    ok(otro && otro.payload.tipo === 'invento_futuro', 'con su tipo', otro && otro.payload.tipo);
    ok(otro && otro.payload.muestra.includes('todavia no existe'), 'y una muestra');
    console.log();

    console.log('8) redaccion: un secreto dentro de un tool_result no llega tal cual');
    const conSecreto = [INIT, TOOL_USE,
      conResultado('OPENAI_API_KEY=sk-proj-A1b2C3d4E5f6G7h8I9j0K1l2M3n4\nAWS: AKIAIOSFODNN7EXAMPLE\npassword = tremendamenteSecreta'),
      RESULT].join('\n') + '\n';
    r = await correr(puerto, { stdout: conSecreto });
    ok(!crudo(r).includes('sk-proj-A1b2C3d4E5f6G7h8I9j0K1l2M3n4'), 'la clave estilo sk- se redacta');
    ok(!crudo(r).includes('AKIAIOSFODNN7EXAMPLE'), 'la de AWS tambien');
    ok(!crudo(r).includes('tremendamenteSecreta'), 'y la asignacion de password');
    ok(crudo(r).includes('[redactado]'), 'y se dice que se redacto, en vez de borrarlo sin mas');
    console.log();

    console.log('9) recorte: un resultado enorme no viaja entero');
    r = await correr(puerto, { stdout: [INIT, TOOL_USE, conResultado('x'.repeat(20000)), RESULT].join('\n') + '\n' });
    const gordo = deTipo(r, 'resultado')[0];
    ok(gordo && gordo.payload.salida.length < 700, 'se recorta a la altura del tope', String(gordo && gordo.payload.salida.length));
    ok(gordo && /\[\+\d+\]$/.test(gordo.payload.salida), 'y dice cuanto se dejo fuera', gordo && gordo.payload.salida.slice(-20));
    ok(JSON.stringify(r.lotes).length < 8000, 'el lote entero se queda pequeno', String(JSON.stringify(r.lotes).length));
    console.log();

    console.log('10) se agrupa: no hay una peticion por evento');
    const largo = [INIT, ...Array.from({ length: 30 }, () => [TEXTO, TOOL_USE, TOOL_RESULT]).flat(), RESULT].join('\n') + '\n';
    r = await correr(puerto, { stdout: largo });
    ok(r.sesion.length === 92, 'llegan los 92 eventos', String(r.sesion.length));
    ok(r.peticiones > 0 && r.peticiones <= 4, 'en cuatro peticiones o menos', String(r.peticiones));
    ok(r.sesion.every((e, i) => e.seq === i + 1), 'sin huecos ni repeticiones en el seq');
    console.log();

    console.log('11) el tope por unidad para el envio, y lo dice');
    r = await correr(puerto, { stdout: largo, env: { APTS_LOOP_SESSION_MAX_EVENTS: '10' } });
    const recorte = deTipo(r, 'recorte')[0];
    ok(recorte, 'llega un evento `recorte`');
    ok(recorte && recorte.payload.motivo === 'tope por unidad', 'nombrando el motivo', recorte && recorte.payload.motivo);
    ok(r.sesion.length === 11, 'diez eventos mas el aviso de recorte, y nada mas', String(r.sesion.length));
    ok(/tope por unidad/.test(r.visto), 'y se dice tambien en consola');
    console.log();

    console.log('12) un APTS anterior a esta ruta: se deja de insistir y la corrida sigue');
    // Cuatro vueltas y no una: el cortacircuitos cuenta 404 de la CORRIDA entera, asi que
    // con una sola unidad no llegaria a dispararse. Es justo lo que hay que comprobar —que
    // no se paga el descubrimiento una vez por story— y por eso la prueba conduce varias.
    responderSesion = (res) => { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"Not Found"}'); };
    r = await correr(puerto, { stdout: largo, vueltas: 4 });
    ok(r.peticiones === 2, 'exactamente dos peticiones en cuatro vueltas', String(r.peticiones));
    ok(/no tiene el endpoint de sesión/.test(r.visto), 'y se dice por que');
    // Lo que fija este caso es que la falta del endpoint de sesion no cambia el final de
    // la corrida: para por el tope. Cual de sus dos codigos salga —14 con la unidad
    // cerrada, 17 con la unidad a medias— no lo decide esto.
    ok([14, 17].includes(r.codigoSalida), 'la corrida termina como siempre (tope de vueltas)', String(r.codigoSalida));
    ok(agente(r).exit_code === 0, 'y la vuelta fue bien igual', String(agente(r).exit_code));
    responderSesion = (res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"received":0,"stored":0}'); };
    console.log();

    console.log('13) opencode: se normaliza lo que hay capturado, y el resto no se inventa');
    r = await correr(puerto, { stdout: OPENCODE });
    ok(deTipo(r, 'texto').length === 1, 'su texto se reconoce', String(deTipo(r, 'texto').length));
    ok(deTipo(r, 'fin_paso').length === 1, 'y el cierre de paso', String(deTipo(r, 'fin_paso').length));
    ok(agente(r).runtime === 'opencode', 'el coste se sigue leyendo', agente(r).runtime);
    console.log();

    console.log('14) SIN la bandera no se manda absolutamente nada');
    r = await correr(puerto, { stdout: STREAM, stream: false });
    ok(r.peticiones === 0, 'cero peticiones a /api/conductor/session', String(r.peticiones));
    ok(agente(r).coste_usd === 0.0923545, 'y la contabilidad del coste sigue igual', String(agente(r).coste_usd));
    ok(!r.diario.some((e) => e.evento === 'sesion'), 'ni se abre la sesion en el diario');
    console.log();

    console.log('15) pedir el stream y no recibirlo se avisa, nombrando el arreglo');
    r = await correr(puerto, { stdout: `${RESULT}\n` });
    ok(/no emitió stream|no emitio stream/.test(r.visto), 'se dice que no llego stream');
    ok(/stream-json/.test(r.visto), 'y con que bandera se arregla');
    console.log();

    console.log('16) el diario local NO se lleva la sesion');
    r = await correr(puerto, { stdout: STREAM });
    const diarioCrudo = JSON.stringify(r.diario);
    ok(!diarioCrudo.includes('I\'ll read the file'), 'el texto del agente no acaba en el JSONL');
    ok(!diarioCrudo.includes('hola.txt'), 'ni las rutas que leyo');
    ok(r.diario.some((e) => e.evento === 'sesion' && e.accion === 'cerrada' && e.eventos === 6),
      'sólo queda la cuenta de cuantos eventos se mandaron');
  } finally {
    servidor.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* da igual */ }
  }

  console.log(`\n${fallos === 0 ? 'TODO OK' : `${fallos} COMPROBACIONES FALLARON`}`);
  process.exit(fallos === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
