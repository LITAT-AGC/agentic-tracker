#!/usr/bin/env node
// Prueba dirigida del SUPERVISOR: cuando relanza el conductor y cuando no.
//
// Uso:  cd backend && node scripts/test_supervisor.js
// No necesita servidor ni base: el supervisor no habla con APTS. Lo que se prueba es su
// unica regla, y para eso basta un conductor de mentira que escriba en el diario lo que le
// diga el guion y salga con el codigo que le diga el guion.
//
// Corre el script de ESTA plataforma: `apts-supervisor.ps1` en Windows y
// `apts-supervisor.sh` en POSIX. Son dos archivos porque tienen que serlo —un supervisor
// escrito en Node moriria en el mismo barrido de procesos que mata al conductor, que es el
// caso entero— y por eso hay que probar el que se va a usar aqui. El otro se prueba
// corriendo esto mismo en el otro sistema.
//
// La regla, que es lo unico que se mide:
//
//   arranque y detras parada  -> decidio el          -> respeta su codigo, no relanza
//   arranque y ninguna parada -> lo mataron          -> relanza
//   ni siquiera arranque      -> no llego a conducir -> respeta su codigo, no relanza
//
// El codigo de salida NO decide: el 2026-08-16 el conductor muerto salio con 255, que no es
// ninguno de los suyos. Por eso el conductor de mentira sale con 255 tanto cuando lo
// "matan" como cuando no llego a arrancar, y aun asi el supervisor los distingue.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const WIN = process.platform === 'win32';
const SUPERVISOR = path.join(
  __dirname, '..', '..', 'integracion', 'conductor',
  WIN ? 'apts-supervisor.ps1' : 'apts-supervisor.sh',
);

let fallos = 0;
const ok = (cond, etiqueta, detalle) => {
  console.log(`${cond ? '  OK  ' : ' FALLA'} ${etiqueta}${detalle ? ` — ${detalle}` : ''}`);
  if (!cond) fallos += 1;
};

// ---- conductor de mentira ----
//
// Cuenta sus propias invocaciones en un archivo, porque «cuantas veces lo relanzo» es
// exactamente lo que hay que medir y el supervisor no lo dice en ningun sitio.
const CONDUCTOR_FALSO = `
const fs = require('node:fs');
const j = process.argv[process.argv.indexOf('--journal') + 1];
const modo = process.env.FALSO_MODO || 'muerto';
const dormir = Number(process.env.FALSO_DORMIR_MS || 0);
const cuenta = j + '.veces';
let veces = 0;
try { veces = Number(fs.readFileSync(cuenta, 'utf8')) || 0; } catch (_) { /* primera */ }
veces += 1;
fs.writeFileSync(cuenta, String(veces));

const anotar = (obj) => fs.appendFileSync(j, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\\n');

if (modo === 'sin-arranque') { process.stderr.write('falta configuracion\\n'); process.exit(255); }

anotar({ evento: 'arranque', project_url: 'https://example.invalid/supervisado', agent_name: 'falso-dev' });
// Una linea que CITA una parada dentro de un valor. JSON.stringify la escapa, asi que el
// filtro por texto del supervisor no puede confundirla con la clave de verdad.
anotar({ evento: 'estado', detalle: 'el diario decia {"evento":"parada"} y no era' });

const terminar = () => {
  if (modo === 'decide' || (modo === 'decide-a-la-2' && veces >= 2)) {
    anotar({ evento: 'parada', motivo: 'tope_iteraciones', detalle: 'de mentira', exit_code: 14 });
    process.exit(14);
  }
  process.exit(255);
};
if (dormir > 0) setTimeout(terminar, dormir); else terminar();
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apts-supervisor-'));
const rutaConductor = path.join(tmp, 'falso-conductor.js');
fs.writeFileSync(rutaConductor, CONDUCTOR_FALSO);

let corrida = 0;
const correr = ({ modo, maxRelanzamientos = 2, dormirMs = 0, extra = [], esperarSalida = true }) => {
  corrida += 1;
  const diario = path.join(tmp, `diario-${corrida}.jsonl`);
  const comando = [process.execPath, rutaConductor, '--journal', diario, ...extra];

  const args = WIN
    ? ['-NoProfile', '-NonInteractive', '-File', SUPERVISOR,
      '-Diario', diario, '-Dotenv', path.join(tmp, 'no-existe.env'),
      '-MaxRelanzamientos', String(maxRelanzamientos), ...comando]
    : [SUPERVISOR, '--diario', diario, '--dotenv', path.join(tmp, 'no-existe.env'),
      '--max-relanzamientos', String(maxRelanzamientos), '--', ...comando];

  const hijo = spawn(WIN ? (process.env.APTS_PWSH || 'powershell') : 'sh', args, {
    env: {
      ...process.env,
      FALSO_MODO: modo,
      FALSO_DORMIR_MS: String(dormirMs),
      // Sin esto cada relanzamiento costaria treinta segundos de reloj.
      APTS_SUPERVISOR_BACKOFF_MS: '200',
      APTS_LOOP_TELEGRAM_TOKEN: '',
      APTS_LOOP_TELEGRAM_CHAT_ID: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let visto = '';
  hijo.stdout.on('data', (d) => { visto += d.toString(); });
  hijo.stderr.on('data', (d) => { visto += d.toString(); });
  const fin = new Promise((resolve) => {
    hijo.on('close', (codigo) => {
      if (process.env.PRUEBA_VERBOSA) console.log(`--- supervisor ${corrida} (salida ${codigo}) ---\n${visto}---`);
      const eventos = fs.existsSync(diario)
        ? fs.readFileSync(diario, 'utf8').trim().split('\n').filter(Boolean).map((l) => {
          try { return JSON.parse(l); } catch (_) { return { evento: '(ilegible)', linea: l }; }
        })
        : [];
      let veces = 0;
      try { veces = Number(fs.readFileSync(`${diario}.veces`, 'utf8')) || 0; } catch (_) { /* ninguna */ }
      resolve({ codigo, visto, eventos, veces, diario });
    });
  });
  return esperarSalida ? fin : { hijo, fin, diario };
};

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const nombres = (r) => r.eventos.filter((e) => String(e.evento).startsWith('supervisor_')).map((e) => e.evento);

(async () => {
  console.log(`supervisor bajo prueba: ${path.basename(SUPERVISOR)}\n`);

  console.log('1) el conductor paro por su cuenta: no se relanza y se respeta su codigo');
  let r = await correr({ modo: 'decide' });
  ok(r.codigo === 14, 'sale con el codigo del conductor, no con uno propio', String(r.codigo));
  ok(r.veces === 1, 'y lo lanzo una sola vez', String(r.veces));
  ok(nombres(r).includes('supervisor_parada'), 'lo deja escrito en el diario', JSON.stringify(nombres(r)));
  ok(!nombres(r).includes('supervisor_relanza'), 'sin relanzar nada');
  console.log();

  console.log('2) lo mataron a mitad: se relanza, y la segunda vez si decide');
  r = await correr({ modo: 'decide-a-la-2' });
  ok(r.veces === 2, 'lo lanzo dos veces', String(r.veces));
  ok(r.codigo === 14, 'y sale con el codigo de la corrida que si decidio', String(r.codigo));
  const muerte = r.eventos.find((e) => e.evento === 'supervisor_muerte');
  ok(muerte && muerte.exit_code === 255,
    'la muerte queda anotada con el codigo que no significa nada (255)', muerte && String(muerte.exit_code));
  console.log();

  console.log('3) lo matan siempre: relanza hasta el tope y se rinde diciendolo');
  r = await correr({ modo: 'muerto', maxRelanzamientos: 2 });
  ok(r.veces === 3, 'tres lanzamientos: el original y dos relanzamientos', String(r.veces));
  ok(r.codigo === 42, 'sale con codigo propio (42), no con el del conductor', String(r.codigo));
  ok(nombres(r).includes('supervisor_rendicion'), 'y lo dice en el diario', JSON.stringify(nombres(r)));
  console.log();

  console.log('4) ni llego a escribir su arranque: es un error de configuracion, no una muerte');
  r = await correr({ modo: 'sin-arranque' });
  ok(r.veces === 1, 'no lo relanza para que repita el mismo error', String(r.veces));
  ok(r.codigo === 255, 'y respeta su codigo', String(r.codigo));
  const p = r.eventos.find((e) => e.evento === 'supervisor_parada');
  ok(p && p.motivo === 'no_llego_a_conducir', 'con su motivo', p && p.motivo);
  console.log();

  console.log('5) una parada CITADA dentro de otro evento no cuenta como parada');
  // El conductor de mentira escribe siempre esa linea. Si contara, el caso 3 habria salido
  // 255 a la primera y esta prueba no haria falta; se comprueba aparte porque es la unica
  // forma de que quien lea el codigo sepa que el filtro por texto esta pensado.
  r = await correr({ modo: 'muerto', maxRelanzamientos: 1 });
  ok(r.veces === 2, 'siguio relanzando pese a la cita', String(r.veces));
  ok(r.eventos.some((e) => e.evento === 'estado'), 'y la linea citada estaba ahi');
  console.log();

  console.log('6) --daemon no se supervisa, y se dice por que');
  r = await correr({ modo: 'decide', extra: ['--daemon'] });
  ok(r.codigo === 40, 'sale con el codigo de configuracion del supervisor', String(r.codigo));
  ok(r.veces === 0, 'sin llegar a lanzar nada', String(r.veces));
  ok(/daemon/.test(r.visto), 'y lo explica', r.visto.trim().split('\n').pop());
  console.log();

  console.log('7) dos supervisores sobre el mismo diario: el segundo no arranca');
  const primero = correr({ modo: 'decide', dormirMs: 4000, esperarSalida: false });
  await dormir(1500);
  const segundo = await correr({ modo: 'decide' });
  // El segundo apunta a SU diario, asi que hay que comprobar el cerrojo del primero: se
  // corre a proposito con el mismo `-Diario` para que el cerrojo sea el mismo archivo.
  const tercero = await new Promise((resolve) => {
    const args = WIN
      ? ['-NoProfile', '-NonInteractive', '-File', SUPERVISOR, '-Diario', primero.diario,
        '-Dotenv', path.join(tmp, 'no-existe.env'), process.execPath, rutaConductor, '--journal', primero.diario]
      : [SUPERVISOR, '--diario', primero.diario, '--dotenv', path.join(tmp, 'no-existe.env'),
        '--', process.execPath, rutaConductor, '--journal', primero.diario];
    const h = spawn(WIN ? (process.env.APTS_PWSH || 'powershell') : 'sh', args, {
      env: { ...process.env, FALSO_MODO: 'decide', APTS_SUPERVISOR_BACKOFF_MS: '200' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let visto = '';
    h.stdout.on('data', (d) => { visto += d.toString(); });
    h.stderr.on('data', (d) => { visto += d.toString(); });
    h.on('close', (codigo) => resolve({ codigo, visto }));
  });
  ok(tercero.codigo === 41, 'sale con el codigo del cerrojo (41)', String(tercero.codigo));
  ok(/ya hay un supervisor vivo/.test(tercero.visto), 'diciendo lo que pasa', tercero.visto.trim().split('\n').pop());
  ok(segundo.codigo === 14, 'y un supervisor sobre OTRO diario no se estorba', String(segundo.codigo));
  const r1 = await primero.fin;
  ok(r1.codigo === 14, 'el primero termina normal', String(r1.codigo));
  ok(!fs.existsSync(`${primero.diario}.lock`), 'y suelta el cerrojo al irse');

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* da igual */ }
  console.log(`\n${fallos === 0 ? 'TODO OK' : `${fallos} COMPROBACIONES FALLARON`}`);
  process.exit(fallos === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
