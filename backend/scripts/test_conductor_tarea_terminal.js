#!/usr/bin/env node
// Prueba dirigida de que el conductor no reanima una tarea que ya esta cerrada.
//
// Uso:  cd backend && node scripts/test_conductor_tarea_terminal.js
// No necesita servidor ni base: levanta un APTS de mentira —con la MISMA tabla de
// transiciones que el de verdad— y lanza el conductor real contra el.
//
// Lo que motiva la prueba: `moverTarea` reanima a `in_progress` cuando una transicion
// falla. Se escribio para un caso concreto —la vigilancia de latidos marca `stalled` una
// tarea cuyo agente seguia trabajando, porque el conductor no puede latir mientras
// `spawnSync` le bloquea el proceso— y se aplicaba a CUALQUIER fallo, incluido el
// contrario: que la tarea ya este en `done`, desde donde no hay ninguna transicion legal.
//
// Visto en "tickets" el 2026-08-16: el agente cerro el mismo la tarea que el conductor le
// habia prestado y el conductor apunto un `tarea_fallo` por intentar moverla a `review`
// despues. La unidad habia cerrado bien. Es el mismo vicio que la corrida que decia «sin
// llegar a done» sin mirar: afirmar sobre un estado que no se ha consultado.
//
// Las dos mitades se fijan aqui: la tarea terminal ya no se reanima, y la `stalled` —el
// caso para el que la reanimacion existe— se sigue reanimando.

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CONDUCTOR = path.join(__dirname, '..', '..', 'integracion', 'conductor', 'apts-loop.js');
const STORY = 'aaaaaaaa-1111-2222-3333-555555555555';
const OTRA = 'bbbbbbbb-5555-6666-7777-999999999999';
const TAREA = 'cccccccc-9999-0000-1111-333333333333';
const PROYECTO = 'https://example.invalid/prueba-tarea-terminal';
const AGENTE = 'prueba-tarea-dev';

let fallos = 0;
const ok = (cond, etiqueta, detalle) => {
  console.log(`${cond ? '  OK  ' : ' FALLA'} ${etiqueta}${detalle ? ` — ${detalle}` : ''}`);
  if (!cond) fallos += 1;
};

// La tabla del servidor de verdad, copiada de `backend/index.js`. Copiarla es el sentido
// de la prueba: si alla se ampliara `done` con alguna salida, aqui habria que tocarla a
// mano y alguien tendria que mirar por que.
const TRANSICIONES = {
  todo: ['in_progress', 'stalled'],
  in_progress: ['todo', 'review', 'stalled'],
  review: ['in_progress', 'done', 'stalled'],
  stalled: ['todo', 'in_progress'],
  done: [],
};

let estadoTarea = 'in_progress';
let vistas = [];       // toda transicion pedida, salga bien o mal
let guion = null;
let llamadas = 0;

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
    // El agente falso cierra por aqui la tarea que le prestaron, que es exactamente lo que
    // hizo el de verdad.
    if (req.url.startsWith('/prueba/cerrar-tarea')) {
      estadoTarea = 'done';
      return responder({ ok: true });
    }

    let peticion = {};
    try { peticion = JSON.parse(cuerpo || '{}'); } catch (_) { /* da igual */ }
    const herramienta = (peticion.params && peticion.params.name) || '';
    const args = (peticion.params && peticion.params.arguments) || {};
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
      const quiere = args.status;
      vistas.push(`${estadoTarea}->${quiere}`);
      if (quiere === estadoTarea) return sobre({ task: { id: TAREA, status: estadoTarea } });
      if (!TRANSICIONES[estadoTarea].includes(quiere)) {
        return sobre({ error: `Invalid task status transition from ${estadoTarea} to ${quiere}` }, true);
      }
      estadoTarea = quiere;
      return sobre({ task: { id: TAREA, status: estadoTarea } });
    }
    return sobre({});
  });
});

// El agente falso: entrega y, si se le dice, cierra antes la tarea que le prestaron.
const AGENTE_FALSO = `
(async () => {
  if (process.env.FALSO_CIERRA_TAREA === '1') {
    try { await fetch(process.env.FALSO_APTS + '/prueba/cerrar-tarea'); } catch (_) {}
  }
  process.stdout.write('listo\\n');
  process.exit(0);
})();
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apts-tarea-'));
const rutaAgente = path.join(tmp, 'falso-agente.js');
fs.writeFileSync(rutaAgente, AGENTE_FALSO);
fs.writeFileSync(path.join(tmp, 'vacio.env'), '');

let corrida = 0;
const correr = (puerto, { estadoInicial = 'in_progress', cierraElAgente = false }) => {
  corrida += 1;
  llamadas = 0;
  vistas = [];
  estadoTarea = estadoInicial;
  guion = { estadoInicial };
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
      '--no-journal-remote',
    ], {
      env: {
        ...process.env,
        FALSO_CIERRA_TAREA: cierraElAgente ? '1' : '0',
        FALSO_APTS: `http://127.0.0.1:${puerto}`,
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
      resolve({ codigoSalida, visto, eventos, transiciones: [...vistas], estadoFinal: estadoTarea });
    });
  });
};

const fallosDeTarea = (r) => r.eventos.filter((e) => e.evento === 'tarea_fallo');

(async () => {
  const servidor = crearApts();
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const puerto = servidor.address().port;
  console.log(`APTS de mentira en el ${puerto}\n`);

  try {
    console.log('1) el agente cerro la tarea el mismo: el conductor no la reanima ni se queja');
    let r = await correr(puerto, { cierraElAgente: true });
    ok(fallosDeTarea(r).length === 0,
      'ningun tarea_fallo en el diario',
      JSON.stringify(fallosDeTarea(r).map((e) => e.detalle)));
    ok(!r.transiciones.includes('done->in_progress'),
      'y no intenta resucitarla a in_progress',
      JSON.stringify(r.transiciones));
    ok(/ya estaba en 'done'/.test(r.visto), 'lo dice en voz alta en vez de callarlo');
    ok(r.estadoFinal === 'done', 'la tarea se queda cerrada', r.estadoFinal);
    console.log();

    console.log('2) el caso para el que existe la reanimacion sigue funcionando');
    // La vigilancia la marco `stalled` mientras el agente trabajaba: desde ahi `review` no
    // es legal, y reanimar es lo correcto.
    r = await correr(puerto, { estadoInicial: 'stalled' });
    ok(r.transiciones.includes('stalled->review'),
      'lo intenta primero por el camino directo',
      JSON.stringify(r.transiciones));
    ok(r.transiciones.includes('stalled->in_progress'),
      'y al fallar SI reanima',
      JSON.stringify(r.transiciones));
    ok(fallosDeTarea(r).length === 0, 'sin apuntar un fallo que no lo es');
    console.log();

    console.log('3) el camino normal no paga la consulta de mas');
    r = await correr(puerto, { estadoInicial: 'in_progress' });
    ok(r.transiciones.includes('in_progress->review'), 'mueve a review de una',
      JSON.stringify(r.transiciones));
    ok(fallosDeTarea(r).length === 0, 'sin fallos');
    ok(!/ya estaba en/.test(r.visto), 'y sin preguntar el estado, que solo se pregunta al fallar');
  } finally {
    servidor.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* da igual */ }
  }

  console.log(`\n${fallos === 0 ? 'TODO OK' : `${fallos} COMPROBACIONES FALLARON`}`);
  process.exit(fallos === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
