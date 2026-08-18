#!/usr/bin/env node
// Prueba dirigida del AGENTE HUERFANO: lo que el conductor hace al arrancar cuando la
// corrida anterior dejo un agente vivo.
//
// Uso:  cd backend && node scripts/test_conductor_huerfano.js
// No necesita servidor ni base: levanta un APTS de mentira en un puerto efimero y lanza el
// conductor de verdad contra el, dos veces, con un agente falso que se deja matar.
//
// Lo que motiva la prueba: al conductor lo pueden matar desde fuera y NO se lleva a su
// agente. El 2026-08-16, a mitad de una corrida de 25 unidades sobre "tickets", una sesion
// de otra ventana cerro un servidor Vite matando por nombre de imagen (`Stop-Process -Name
// node`) y se llevo los catorce procesos `node` de la maquina, incluido el conductor.
// `opencode` no es `node`, asi que sobrevivio y siguio trabajando. Relanzar el conductor
// encima habria puesto DOS agentes escribiendo en el mismo repositorio, con dos tandas de
// commits: peor que la parada que se venia a arreglar.
//
// Lo dificil no es esperar: es IDENTIFICAR. Un pid suelto no identifica nada porque el
// sistema los recicla, y esperar una hora a un desconocido para acabar matandolo mata el
// trabajo de alguien. Por eso hay cuatro casos aqui y no uno: el huerfano que se corta, el
// que termina solo, el numero reciclado que no se toca, y el conductor que sigue vivo y al
// que no se le pisa el agente.

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const CONDUCTOR = path.join(__dirname, '..', '..', 'integracion', 'conductor', 'apts-loop.js');
const STORY = 'aaaaaaaa-1111-2222-3333-444444444444';
const PROYECTO = 'https://example.invalid/prueba-huerfano';
const AGENTE = 'prueba-huerfano-dev';
const WIN = process.platform === 'win32';

let fallos = 0;
const ok = (cond, etiqueta, detalle) => {
  console.log(`${cond ? '  OK  ' : ' FALLA'} ${etiqueta}${detalle ? ` — ${detalle}` : ''}`);
  if (!cond) fallos += 1;
};

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- APTS de mentira ----
//
// Siempre la misma unidad: lo que se mide aqui pasa ANTES de la primera vuelta.
const recomendacion = {
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
    if (herramienta === 'status') {
      datos = {
        project_url: PROYECTO,
        phase: 'implementation',
        backlog: { total: 2, by_status: { ready_for_dev: 2 }, done: 0, remaining: 2 },
        recommendation: recomendacion,
      };
    } else if (herramienta === 'register_task') {
      datos = { task_id: 'cccccccc-9999-0000-1111-222222222222' };
    }

    return responder({
      jsonrpc: '2.0', id: peticion.id, result: { content: [{ type: 'text', text: JSON.stringify(datos) }] },
    });
  });
});

// ---- agentes falsos ----
//
// El que se queda vivo escribe una marca en cuanto arranca —para saber CUANDO matar al
// conductor sin carreras— y despues no termina nunca por su cuenta si no se le dice.
const AGENTE_VIVO = `
const fs = require('node:fs');
fs.writeFileSync(process.argv[2], String(process.pid));
const hasta = Number(process.argv[3] || 0);
if (hasta > 0) setTimeout(() => process.exit(0), hasta);
else setInterval(() => {}, 1000);
`;
const AGENTE_RAPIDO = 'process.stdout.write("listo\\n"); process.exit(0);\n';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apts-huerfano-'));
const rutaVivo = path.join(tmp, 'agente-vivo.js');
const rutaRapido = path.join(tmp, 'agente-rapido.js');
fs.writeFileSync(rutaVivo, AGENTE_VIVO);
fs.writeFileSync(rutaRapido, AGENTE_RAPIDO);
fs.writeFileSync(path.join(tmp, 'vacio.env'), '');

const vivo = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

// Matar SOLO al conductor y no a su arbol: es exactamente lo que hace un barrido por nombre
// de imagen, que es el caso real. Si aqui se usara `/t` (o el grupo) no quedaria huerfano
// que detectar y la prueba pasaria en verde sin probar nada.
const matarSoloAlConductor = (pid) => {
  if (WIN) spawnSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' });
  else { try { process.kill(pid, 'SIGKILL'); } catch (_) { /* ya no estaba */ } }
};

let corrida = 0;
const lanzarConductor = (puerto, diario, { agente, marca, viveMs, esperaMs, sondeoMs, extra } = {}) => {
  corrida += 1;
  const args = [
    CONDUCTOR,
    '--mcp-url', `http://127.0.0.1:${puerto}/mcp`,
    '--api-key', 'clave-de-mentira',
    '--project-url', PROYECTO,
    '--agent-name', AGENTE,
    '--agent-email', 'prueba@example.invalid',
    '--agent-cmd', agente === 'vivo'
      ? `"${process.execPath}" "${rutaVivo}" "${marca}" ${viveMs || 0} {prompt_file}`
      : `"${process.execPath}" "${rutaRapido}" {prompt_file}`,
    '--max-iterations', '1',
    '--journal', diario,
    '--dotenv', path.join(tmp, 'vacio.env'),
    '--no-journal-remote',
    ...(extra || []),
  ];
  const hijo = spawn(process.execPath, args, {
    env: {
      ...process.env,
      APTS_LOOP_TELEGRAM_TOKEN: '',
      APTS_LOOP_TELEGRAM_CHAT_ID: '',
      APTS_LOOP_ORPHAN_WAIT_MS: String(esperaMs == null ? 4000 : esperaMs),
      APTS_LOOP_ORPHAN_POLL_MS: String(sondeoMs || 200),
      // La corrida no debe pararse sola mientras se la mata a mano.
      APTS_LOOP_AGENT_SILENCE_MS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let visto = '';
  hijo.stdout.on('data', (d) => { visto += d.toString(); });
  hijo.stderr.on('data', (d) => { visto += d.toString(); });
  const fin = new Promise((resolve) => {
    hijo.on('close', (codigo) => {
      if (process.env.PRUEBA_VERBOSA) console.log(`--- conductor ${corrida} (salida ${codigo}) ---\n${visto}---`);
      resolve({ codigo, visto });
    });
  });
  return { hijo, fin, verSalida: () => visto };
};

const eventos = (diario) => (fs.existsSync(diario)
  ? fs.readFileSync(diario, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : []);
const huerfanos = (diario) => eventos(diario).filter((e) => e.evento === 'agente_huerfano');

const esperarA = async (cond, ms, que) => {
  const limite = Date.now() + ms;
  while (Date.now() < limite) {
    if (cond()) return true;
    await dormir(100);
  }
  throw new Error(`se agoto la espera de: ${que}`);
};

(async () => {
  const servidor = crearApts();
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const puerto = servidor.address().port;
  console.log(`APTS de mentira en el ${puerto}\n`);

  const aMatar = [];
  try {
    // ---------------------------------------------------------------------------
    console.log('1) al conductor lo matan y su agente sobrevive: queda escrito quien es');
    const diario = path.join(tmp, 'diario-1.jsonl');
    const marca = path.join(tmp, 'marca-1.txt');
    const uno = lanzarConductor(puerto, diario, { agente: 'vivo', marca });
    await esperarA(() => fs.existsSync(marca), 20000, 'que el agente falso arranque');
    const pidAgente = Number(fs.readFileSync(marca, 'utf8'));
    aMatar.push(pidAgente);
    matarSoloAlConductor(uno.hijo.pid);
    const r1 = await uno.fin;

    // El `|| {}` no es defensa contra un caso raro: es lo que hace que, sin el arreglo,
    // esto se lea como comprobaciones que fallan y no como un TypeError.
    const lanzado = eventos(diario).filter((e) => e.evento === 'agente_lanzado');
    const primero = lanzado[0] || {};
    ok(lanzado.length === 1 && Number.isFinite(primero.pid),
      'el conductor apunto el pid de su agente al lanzarlo', JSON.stringify(lanzado.map((e) => e.pid)));
    ok(primero.conductor_pid === uno.hijo.pid,
      'y su propio pid al lado, que es lo que distingue un huerfano del agente de otro conductor vivo',
      `${lanzado[0].conductor_pid} vs ${uno.hijo.pid}`);
    ok(!eventos(diario).some((e) => e.evento === 'agente'),
      'el par no se cerro: nadie escribio el resultado del intento');
    ok(!eventos(diario).some((e) => e.evento === 'parada'),
      'y no hay ninguna parada: esta muerte no la decidio el conductor');
    ok(vivo(pidAgente), 'el agente sigue vivo despues de morir su conductor', `pid ${pidAgente}`);
    ok(r1.codigo !== 0, 'el codigo de salida no dice nada util', String(r1.codigo));
    console.log();

    // ---------------------------------------------------------------------------
    console.log('2) el conductor siguiente lo ve, lo espera y —agotada la espera— lo corta');
    const dos = lanzarConductor(puerto, diario, { agente: 'rapido', esperaMs: 2500, sondeoMs: 200 });
    await dos.fin;
    const h = huerfanos(diario);
    ok(h.some((e) => e.accion === 'detectado' && e.pid === primero.pid),
      'lo detecta por el pid que dejo escrito su antecesor', JSON.stringify(h.map((e) => e.accion)));
    ok(h.some((e) => e.accion === 'cortado'), 'y lo corta al agotarse la espera');
    const cortado = h.find((e) => e.accion === 'cortado');
    ok(cortado && cortado.esperado_ms >= 2000,
      'despues de haber esperado de verdad, no de matarlo de entrada', cortado ? String(cortado.esperado_ms) : 'sin evento');
    await esperarA(() => !vivo(pidAgente), 10000, 'que el huerfano muera').catch(() => {});
    ok(!vivo(pidAgente), 'el arbol del huerfano esta muerto', `pid ${pidAgente}`);
    ok(dos.verSalida().includes('quedó vivo el agente de la corrida anterior'),
      'y lo dice por consola, que es donde mira quien esta delante');
    console.log();

    // ---------------------------------------------------------------------------
    console.log('3) el huerfano que termina solo no se corta: se le espera y ya');
    const diario3 = path.join(tmp, 'diario-3.jsonl');
    const marca3 = path.join(tmp, 'marca-3.txt');
    // Vive lo justo para que el conductor siguiente llegue a verlo y a esperarlo: si se
    // fuera antes de que arrancara, esta prueba pasaria en verde sin medir la espera.
    const tres = lanzarConductor(puerto, diario3, { agente: 'vivo', marca: marca3, viveMs: 9000 });
    await esperarA(() => fs.existsSync(marca3), 20000, 'que el agente falso arranque');
    const pid3 = Number(fs.readFileSync(marca3, 'utf8'));
    aMatar.push(pid3);
    matarSoloAlConductor(tres.hijo.pid);
    await tres.fin;
    // Espera larga: el agente se va solo a los 3 s y el conductor tiene que darse cuenta.
    const cuatro = lanzarConductor(puerto, diario3, { agente: 'rapido', esperaMs: 60000, sondeoMs: 200 });
    await cuatro.fin;
    const h3 = huerfanos(diario3);
    ok(h3.some((e) => e.accion === 'terminado'), 'el diario dice que termino por su cuenta',
      JSON.stringify(h3.map((e) => e.accion)));
    ok(!h3.some((e) => e.accion === 'cortado'), 'y que no hizo falta cortar nada');
    console.log();

    // ---------------------------------------------------------------------------
    console.log('4) un numero reciclado no se toca (el falso positivo que mataria el trabajo de alguien)');
    const diario4 = path.join(tmp, 'diario-4.jsonl');
    // Este proceso esta vivo y es `node`, no el arbol que deja el conductor: ni `cmd.exe`
    // en Windows ni lider de su propio grupo en POSIX.
    fs.writeFileSync(diario4, `${JSON.stringify({
      ts: new Date().toISOString(), evento: 'agente_lanzado', iteracion: 1, intento: 1, story_id: STORY, pid: process.pid, conductor_pid: 999999, plataforma: process.platform,
    })}\n`);
    const cinco = lanzarConductor(puerto, diario4, { agente: 'rapido', esperaMs: 60000 });
    const r5 = await cinco.fin;
    const h4 = huerfanos(diario4);
    ok(h4.length === 1 && h4[0].accion === 'ignorado',
      'lo ignora en vez de esperarlo una hora y matarlo', JSON.stringify(h4.map((e) => e.accion)));
    ok(r5.codigo === 14, 'y la corrida sigue su curso normal', String(r5.codigo));
    ok(vivo(process.pid), 'el proceso ajeno sigue vivo');
    console.log();

    // ---------------------------------------------------------------------------
    console.log('5) si el conductor que lo lanzo SIGUE VIVO, no es un huerfano: no se arranca encima');
    const diario5 = path.join(tmp, 'diario-5.jsonl');
    // El pid de esta prueba hace de conductor anterior: esta vivo y es `node`, que es
    // exactamente lo que se comprueba.
    fs.writeFileSync(diario5, `${JSON.stringify({
      ts: new Date().toISOString(), evento: 'agente_lanzado', iteracion: 1, intento: 1, story_id: STORY, pid: process.pid, conductor_pid: process.pid, plataforma: process.platform,
    })}\n`);
    const seis = lanzarConductor(puerto, diario5, { agente: 'rapido' });
    const r6 = await seis.fin;
    ok(r6.codigo === 16, 'para con codigo propio (16) en vez de poner dos agentes en el mismo repositorio', String(r6.codigo));
    const p6 = eventos(diario5).find((e) => e.evento === 'parada');
    ok(p6 && p6.motivo === 'otro_conductor', 'con su motivo en el diario', p6 && p6.motivo);
    ok(p6 && /dos agentes/.test(p6.detalle || ''), 'y el detalle dice por que importa', p6 && p6.detalle);
    ok(!eventos(diario5).some((e) => e.evento === 'agente_lanzado' && e.conductor_pid !== process.pid),
      'no llego a lanzar ningun agente');
  } finally {
    servidor.close();
    for (const pid of aMatar) {
      if (!vivo(pid)) continue;
      if (WIN) spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
      else { try { process.kill(pid, 'SIGKILL'); } catch (_) { /* ya no estaba */ } }
    }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* da igual */ }
  }

  console.log(`\n${fallos === 0 ? 'TODO OK' : `${fallos} COMPROBACIONES FALLARON`}`);
  process.exit(fallos === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
