#!/usr/bin/env node
// Prueba dirigida de la VUELTA DE CIERRE: lo que el conductor reporta cuando lo para el
// tope de vueltas y no un veredicto del motor.
//
// Uso:  cd backend && node scripts/test_conductor_cierre_por_tope.js
// No necesita servidor ni base: levanta un APTS de mentira en un puerto efimero y lanza
// el conductor de verdad contra el, con un agente falso que sale bien sin hacer nada.
//
// Lo que motiva la prueba: una vuelta de trabajo termina en cuanto el agente entrega, y
// quien puede decir si la unidad cerro es el motor. Dentro del bucle eso lo contesta la
// vuelta siguiente; con el tope agotado esa vuelta no existia y el conductor afirmaba
// «sin llegar a done» sin haber preguntado. El 2026-08-16, en "tickets", US-AUTH-01 cerro
// a las 07:16:48Z y la corrida salio 14 cincuenta segundos despues diciendo que no.
//
// Lo caro no era el texto: con `--max-iterations 1` —la forma de lanzar una corrida de
// comprobacion— un `blocked` declarado en la ultima vuelta tambien salia 14, asi que el
// codigo 10 no se veia nunca. Aqui se fija que los cuatro finales se distingan.

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CONDUCTOR = path.join(__dirname, '..', '..', 'integracion', 'conductor', 'apts-loop.js');
const STORY = 'aaaaaaaa-1111-2222-3333-444444444444';
const OTRA = 'bbbbbbbb-5555-6666-7777-888888888888';
const PROYECTO = 'https://example.invalid/prueba-cierre-por-tope';
const AGENTE = 'prueba-cierre-dev';

let fallos = 0;
const ok = (cond, etiqueta, detalle) => {
  console.log(`${cond ? '  OK  ' : ' FALLA'} ${etiqueta}${detalle ? ` — ${detalle}` : ''}`);
  if (!cond) fallos += 1;
};

// ---- APTS de mentira ----
//
// `apts_status` contesta lo de siempre en las vueltas de TRABAJO y lo que diga el guion en
// la de cierre. El reparto de una a otra es por numero de llamada: con `--max-iterations 1`
// el conductor pregunta dos veces —la vuelta de trabajo y la de cierre— y ninguna mas,
// porque el agente falso sale con 0 y no hay reintentos que consultar.
let guion = null;
let llamadas = 0;

const recomendacionDeTrabajo = {
  next: 'run_step',
  target_id: STORY,
  role: 'bmad-agent-dev',
  args: { phase: 'implementation', workflow_key: 'bmad-dev-story', step_key: '1' },
};

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

    let datos = {};
    if (herramienta === 'apts_status') {
      llamadas += 1;
      const cerrando = llamadas > guion.vueltas;
      datos = {
        project_url: PROYECTO,
        phase: 'implementation',
        backlog: cerrando ? guion.backlog : { total: 2, by_status: { ready_for_dev: 2 }, done: 0, remaining: 2 },
        recommendation: cerrando ? guion.cierre : recomendacionDeTrabajo,
      };
    } else if (herramienta === 'register_task') {
      datos = { task_id: 'cccccccc-9999-0000-1111-222222222222' };
    } else if (herramienta === 'apts_next') {
      // Solo la llama la rama `done`, para persistir el avance de fase.
      datos = { next: 'done' };
    }

    return responder({
      jsonrpc: '2.0',
      id: peticion.id,
      result: { content: [{ type: 'text', text: JSON.stringify(datos) }] },
    });
  });
});

// ---- agente falso ----
//
// Entrega y se calla. Lo que esta prueba mide no es lo que hace el agente sino lo que el
// conductor concluye DESPUES, que es cosa del motor y no suya.
const AGENTE_FALSO = 'process.stdout.write("listo\\n"); process.exit(0);\n';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apts-cierre-'));
const rutaAgente = path.join(tmp, 'falso-agente.js');
fs.writeFileSync(rutaAgente, AGENTE_FALSO);
fs.writeFileSync(path.join(tmp, 'vacio.env'), '');

let corrida = 0;
const correr = (puerto, { vueltas = 1, cierre, backlog, maxStalls }) => {
  corrida += 1;
  llamadas = 0;
  guion = {
    vueltas,
    cierre,
    backlog: backlog || { total: 2, by_status: { ready_for_dev: 1, done: 1 }, done: 1, remaining: 1 },
  };
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
      '--max-iterations', String(vueltas),
      ...(maxStalls ? ['--max-stalls', String(maxStalls)] : []),
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
      resolve({ codigoSalida, visto, eventos });
    });
  });
};

const parada = (r) => r.eventos.find((e) => e.evento === 'parada') || {};
const tareas = (r) => r.eventos.filter((e) => e.evento === 'tarea');
const agentes = (r) => r.eventos.filter((e) => e.evento === 'agente');

(async () => {
  const servidor = crearApts();
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const puerto = servidor.address().port;
  console.log(`APTS de mentira en el ${puerto}\n`);

  try {
    console.log('1) el motor paso a otra unidad: la corrida hizo su trabajo y lo dice');
    let r = await correr(puerto, { cierre: { ...recomendacionDeTrabajo, target_id: OTRA } });
    let p = parada(r);
    ok(r.codigoSalida === 14, 'sigue saliendo 14: quien la paro fue el tope', String(r.codigoSalida));
    ok(p.motivo === 'tope_iteraciones', 'y el motivo es el del tope', p.motivo);
    ok(p.unidad_cerrada === true, 'pero el diario dice que la unidad cerro', JSON.stringify(p.unidad_cerrada));
    ok(/cerró/.test(p.detalle || ''), 'y el detalle ya no afirma lo contrario', p.detalle);
    ok(!/sin llegar a done/.test(p.detalle || ''), 'la frase que mentia no vuelve');
    ok(p.story_id === STORY, 'la parada nombra la unidad trabajada', p.story_id);
    console.log();

    console.log('   y la tarea de esa unidad se cierra como done, no se suelta en review');
    const cerradas = tareas(r).filter((e) => e.accion === 'done');
    ok(cerradas.length === 1 && cerradas[0].story_id === STORY,
      'queda una tarea cerrada con la autoridad del motor', JSON.stringify(tareas(r).map((e) => e.accion)));
    ok(!tareas(r).some((e) => e.accion === 'soltada'), 'y ninguna queda suelta');
    console.log();

    console.log('2) el motor sigue apuntando a la misma: eso tampoco se disfraza');
    r = await correr(puerto, { cierre: recomendacionDeTrabajo });
    p = parada(r);
    ok(r.codigoSalida === 14, 'sale 14', String(r.codigoSalida));
    ok(p.unidad_cerrada === false, 'el diario dice que NO cerro', JSON.stringify(p.unidad_cerrada));
    ok(/sigue en marcha/.test(p.detalle || ''), 'y el detalle lo dice en prosa', p.detalle);
    ok(tareas(r).some((e) => e.accion === 'soltada'),
      'la tarea se suelta en review, que es lo que paso', JSON.stringify(tareas(r).map((e) => e.accion)));
    console.log();

    console.log('3) el ciclo termino en la ULTIMA vuelta: 0, no 14');
    r = await correr(puerto, {
      cierre: { next: 'done', target_id: null, role: null, why: 'lifecycle completo' },
      backlog: { total: 2, by_status: { done: 2 }, done: 2, remaining: 0 },
    });
    p = parada(r);
    ok(r.codigoSalida === 0, 'sale 0: el ciclo acabo de verdad', String(r.codigoSalida));
    ok(p.motivo === 'done', 'y el motivo es done', p.motivo);
    ok(r.eventos.some((e) => e.evento === 'cierre'), 'con el avance de fase persistido');
    console.log();

    console.log('4) la ultima vuelta dejo un bloqueo: 10, que es el codigo que existe para verlo');
    r = await correr(puerto, {
      cierre: { next: 'blocked', target_id: STORY, role: 'bmad-agent-dev', why: `la unidad '${STORY}' está bloqueada` },
    });
    p = parada(r);
    ok(r.codigoSalida === 10, 'sale 10 y no 14', String(r.codigoSalida));
    ok(p.motivo === 'blocked', 'el motivo es el bloqueo', p.motivo);
    ok(/bloqueada/.test(p.detalle || ''), 'y el detalle trae el `why` del motor', p.detalle);
    console.log();

    console.log('5) la vuelta de cierre lee y nada mas');
    ok(agentes(r).length === 1, 'no lanza un segundo agente', String(agentes(r).length));
    // El diario no puede nombrar una vuelta 2 cuando el tope era 1: quien lo lea contaria
    // un trabajo que no se hizo. La de cierre se distingue por su propio campo.
    ok(p.iteracion === 1, 'ni se cuenta como vuelta', String(p.iteracion));
    ok(p.cierre === true, 'pero se sabe que el bloqueo lo trajo la vuelta de cierre', JSON.stringify(p.cierre));
    const lecturas = r.eventos.filter((e) => e.evento === 'estado');
    ok(lecturas.length === 2 && lecturas[0].cierre === undefined && lecturas[1].cierre === true,
      'dos lecturas del motor por corrida, y la segunda va marcada',
      JSON.stringify(lecturas.map((e) => [e.iteracion, e.cierre])));
    console.log();

    console.log('6) el estancamiento no se mide contra la vuelta de cierre');
    // Con `--max-stalls 1` y una sola vuelta de trabajo, la huella de la vuelta de cierre
    // es identica por construccion —entre las dos no ha corrido ningun agente—, asi que
    // sin la guarda el tope se reportaria como 13.
    r = await correr(puerto, { cierre: recomendacionDeTrabajo, maxStalls: 1 });
    ok(r.codigoSalida === 14, 'para por el tope (14) y no por estancamiento (13)', String(r.codigoSalida));
    ok(parada(r).motivo === 'tope_iteraciones', 'con su motivo', parada(r).motivo);
  } finally {
    servidor.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* da igual */ }
  }

  console.log(`\n${fallos === 0 ? 'TODO OK' : `${fallos} COMPROBACIONES FALLARON`}`);
  process.exit(fallos === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
