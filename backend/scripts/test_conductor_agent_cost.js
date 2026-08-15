#!/usr/bin/env node
// Prueba dirigida de la lectura del JSON que imprime la CLI del agente.
//
// Uso:  cd backend && node scripts/test_conductor_agent_cost.js
// No necesita servidor ni base: levanta un APTS de mentira en un puerto efimero y lanza
// el conductor de verdad contra el, con un agente falso que imprime la forma EXACTA que
// imprimen las dos CLIs. No toca produccion y no manda avisos.
//
// Lo que motiva la prueba: el conductor mide desde fuera, asi que de una ejecucion solo
// podia anotar modelo, intento, duracion y codigo de salida — el techo de una corrida se
// decia en sesiones y no en dinero. Pedirle JSON a la CLI cierra esa distancia, y lo que
// se comprueba aqui es que se lee bien, que las dos formas no se confunden entre si (la
// de Claude Code viene YA SUMADA y la de opencode hay que sumarla), y sobre todo que un
// comando que NO pide JSON se comporta exactamente igual que antes.

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CONDUCTOR = path.join(__dirname, '..', '..', 'integracion', 'conductor', 'apts-loop.js');
const STORY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const PROYECTO = 'https://example.invalid/prueba-coste-agente';
const AGENTE = 'prueba-coste-dev';

let fallos = 0;
const ok = (cond, etiqueta, detalle) => {
  console.log(`${cond ? '  OK  ' : ' FALLA'} ${etiqueta}${detalle ? ` — ${detalle}` : ''}`);
  if (!cond) fallos += 1;
};

// ---- APTS de mentira ----
//
// Lo minimo: `apts_status` recomendando siempre la misma story y el buzon vacio. Todo lo
// demas devuelve ok, porque el conductor lo llama best-effort y no es lo que se prueba.
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
    const datos = herramienta === 'apts_status'
      ? {
        project_url: PROYECTO,
        phase: 'implementation',
        backlog: { total: 2, by_status: { ready_for_dev: 2 }, done: 0, remaining: 2 },
        recommendation: {
          next: 'run_step',
          target_id: STORY,
          role: 'bmad-agent-dev',
          args: { phase: 'implementation', workflow_key: 'bmad-dev-story', step_key: '1' },
        },
      }
      : {};
    return responder({
      jsonrpc: '2.0',
      id: peticion.id,
      result: { content: [{ type: 'text', text: JSON.stringify(datos) }] },
    });
  });
});

// ---- agente falso ----
//
// Imprime por stdout lo que le diga FALSO_STDOUT, tal cual. Las formas que se le pasan
// mas abajo estan CAPTURADAS de las CLIs de verdad, no deducidas de su documentacion: si
// alguna de las dos cambia su salida, esta prueba es la que tiene que enterarse.
const AGENTE_FALSO = `
process.stdout.write(process.env.FALSO_STDOUT || '');
process.exit(Number(process.env.FALSO_CODIGO || 0));
`;

// `claude -p ... --output-format json`: UN objeto al final, con el total ya sumado.
const CLAUDE_JSON = JSON.stringify({
  is_error: false,
  num_turns: 3,
  session_id: 'eefe8b73-974e-4a2b-977c-d45ce76370e9',
  total_cost_usd: 0.0170669,
  usage: {
    input_tokens: 10,
    cache_creation_input_tokens: 7057,
    cache_read_input_tokens: 21649,
    output_tokens: 39,
  },
  subtype: 'success',
  result: 'listo',
  type: 'result',
}) + '\n';

// El mismo, pero con el fallo impreso COMO RESULTADO y saliendo con 0. Es lo que hace
// Claude Code cuando revienta la autenticacion dentro de la corrida.
const CLAUDE_JSON_FALLO = JSON.stringify({
  is_error: true,
  num_turns: 1,
  session_id: 'ffffffff-0000-0000-0000-000000000000',
  total_cost_usd: 0.0001,
  usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  subtype: 'error_during_execution',
  result: 'Invalid API key · Please run /login',
  type: 'result',
}) + '\n';

// `opencode run --format json`: NDJSON, con coste y tokens POR PASO. Dos pasos aqui, para
// que sumar y no sumar den numeros distintos y la prueba pueda distinguirlos.
const OPENCODE_NDJSON = [
  { type: 'step_start', sessionID: 'ses_xyz', part: { type: 'step-start' } },
  { type: 'text', sessionID: 'ses_xyz', part: { type: 'text', text: 'trabajando' } },
  {
    type: 'step_finish',
    sessionID: 'ses_xyz',
    part: {
      type: 'step-finish',
      reason: 'tool',
      tokens: { total: 7643, input: 7641, output: 2, reasoning: 0, cache: { write: 100, read: 200 } },
      cost: 0.003,
    },
  },
  {
    type: 'step_finish',
    sessionID: 'ses_xyz',
    part: {
      type: 'step-finish',
      reason: 'stop',
      tokens: { total: 500, input: 400, output: 100, reasoning: 0, cache: { write: 0, read: 50 } },
      cost: 0.002,
    },
  },
].map((o) => JSON.stringify(o)).join('\n') + '\n';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apts-loop-coste-'));
const rutaAgente = path.join(tmp, 'falso-agente.js');
fs.writeFileSync(rutaAgente, AGENTE_FALSO);
fs.writeFileSync(path.join(tmp, 'vacio.env'), '');

let corrida = 0;
const correr = (puerto, { stdout, codigo = 0 }) => {
  corrida += 1;
  const diario = path.join(tmp, `diario-${corrida}.jsonl`);
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
      '--no-task-log',
      '--no-journal-remote',
    ], {
      env: {
        ...process.env,
        FALSO_STDOUT: stdout,
        FALSO_CODIGO: String(codigo),
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
      resolve({ codigoSalida, visto, eventos });
    });
  });
};

const agente = (r) => r.eventos.find((e) => e.evento === 'agente') || {};
const parada = (r) => r.eventos.find((e) => e.evento === 'parada') || {};

(async () => {
  const servidor = crearApts();
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const puerto = servidor.address().port;
  console.log(`APTS de mentira en el ${puerto}\n`);

  try {
    console.log('1) Claude Code: el objeto unico se lee y NO se acumula por objeto');
    let r = await correr(puerto, { stdout: CLAUDE_JSON });
    let a = agente(r);
    ok(a.runtime === 'claudecode', 'reconoce el runtime', a.runtime);
    ok(a.coste_usd === 0.0170669, 'el coste es el que dijo la CLI', String(a.coste_usd));
    ok(a.tokens && a.tokens.entrada === 10 && a.tokens.salida === 39,
      'entrada y salida', JSON.stringify(a.tokens));
    ok(a.tokens && a.tokens.cache_lectura === 21649 && a.tokens.cache_escritura === 7057,
      'la cache va separada: es la diferencia entre trabajar y releer el repositorio');
    ok(a.turnos === 3 && a.sesion === 'eefe8b73-974e-4a2b-977c-d45ce76370e9',
      'turnos y sesion');
    ok(parada(r).tokens_total === 10 + 39 + 21649 + 7057,
      'el total de la corrida suma los cuatro', String(parada(r).tokens_total));
    ok(Math.abs(parada(r).coste_usd_total - 0.0170669) < 1e-9,
      'y el coste no se duplica', String(parada(r).coste_usd_total));
    ok(/gasto de la corrida/.test(r.visto), 'se dice en voz alta al parar');
    console.log();

    console.log('2) opencode: los step_finish SI se suman');
    r = await correr(puerto, { stdout: OPENCODE_NDJSON });
    a = agente(r);
    ok(a.runtime === 'opencode', 'reconoce el runtime', a.runtime);
    ok(Math.abs(a.coste_usd - 0.005) < 1e-9, 'suma el coste de los dos pasos', String(a.coste_usd));
    ok(a.tokens && a.tokens.entrada === 8041 && a.tokens.salida === 102,
      'suma entrada y salida', JSON.stringify(a.tokens));
    ok(a.tokens && a.tokens.cache_lectura === 250 && a.tokens.cache_escritura === 100,
      'y la cache de los dos', JSON.stringify(a.tokens));
    ok(a.turnos === 2, 'un turno por paso', String(a.turnos));
    ok(a.sesion === 'ses_xyz', 'la sesion es la de opencode', a.sesion);
    console.log();

    console.log('3) sin JSON: el bucle se comporta exactamente igual que antes');
    r = await correr(puerto, { stdout: 'trabajando en la story...\nlisto\n' });
    a = agente(r);
    ok(a.exit_code === 0, 'la vuelta va bien igual', String(a.exit_code));
    ok(a.coste_usd === undefined && a.tokens === undefined && a.runtime === undefined,
      'y no inventa campos de coste', JSON.stringify({ c: a.coste_usd, t: a.tokens }));
    ok(parada(r).tokens_total === undefined,
      'la parada tampoco lleva contabilidad', String(parada(r).tokens_total));
    ok(!/gasto de la corrida/.test(r.visto), 'ni se anuncia un gasto que no se midio');
    console.log();

    console.log('4) texto que empieza por llave pero no es JSON: no rompe nada');
    r = await correr(puerto, { stdout: '{esto no es json}\n{"suelto": 1}\nlisto\n' });
    a = agente(r);
    ok(a.exit_code === 0, 'la vuelta sigue yendo bien', String(a.exit_code));
    ok(a.runtime === undefined, 'y ningun lector lo reclama', String(a.runtime));
    console.log();

    console.log('5) el fallo con codigo 0: `is_error` manda sobre el codigo de salida');
    r = await correr(puerto, { stdout: CLAUDE_JSON_FALLO, codigo: 0 });
    a = agente(r);
    ok(a.exit_code !== 0, 'el intento NO pasa por bueno', String(a.exit_code));
    ok(/is_error/.test(String(a.error || '')), 'y el diario dice por que', String(a.error));
    // La cola contiene el JSON, asi que el texto del error de dentro sigue disparando la
    // condicion de entorno de siempre: credenciales, y no un fallo de la story.
    ok(r.codigoSalida === 23, 'sale con 23 (sin credenciales), no con 0', String(r.codigoSalida));
    ok(a.coste_usd === 0.0001, 'un intento que fallo tambien se pago, y se cuenta', String(a.coste_usd));
    console.log();

    console.log('6) el eco: la salida del agente se sigue viendo en consola');
    ok(r.visto.includes('Invalid API key'),
      'lo que la CLI escribe llega al terminal aunque ahora se parsee');
  } finally {
    servidor.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* da igual */ }
  }

  console.log(`\n${fallos === 0 ? 'TODO OK' : `${fallos} COMPROBACIONES FALLARON`}`);
  process.exit(fallos === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
