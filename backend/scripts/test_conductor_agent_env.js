#!/usr/bin/env node
// Prueba dirigida de las condiciones del ENTORNO del agente en el conductor del bucle.
//
// Uso:  cd backend && node scripts/test_conductor_agent_env.js
// No necesita servidor ni base: levanta un APTS de mentira en un puerto efimero y lanza
// el conductor de verdad contra el, con un agente falso que imprime lo que se le diga.
// No toca produccion, no escribe en ninguna base y no manda avisos.
//
// Lo que motiva la prueba: un intento fallido puede serlo por la story —para eso esta la
// escalera de modelos— o porque el agente no llego a trabajar. El 2026-08-08 y otra vez
// el 09, el limite de uso de la CLI mato los dos intentos —el segundo en 3,5 segundos,
// porque el limite es de la CUENTA y no del modelo— y quedo escrito `agente_fallo`, que
// manda a buscar el problema en la story. Lo que se comprueba aqui es que eso ya no pasa,
// y sobre todo que el camino normal NO cambio: un fallo de verdad sigue gastando la
// escalera entera.

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CONDUCTOR = path.join(__dirname, '..', '..', 'integracion', 'conductor', 'apts-loop.js');
const STORY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const PROYECTO = 'https://example.invalid/prueba-entorno-agente';
const AGENTE = 'prueba-entorno-dev';

let fallos = 0;
const ok = (cond, etiqueta, detalle) => {
  console.log(`${cond ? '  OK  ' : ' FALLA'} ${etiqueta}${detalle ? ` — ${detalle}` : ''}`);
  if (!cond) fallos += 1;
};

// ---- APTS de mentira ----
//
// Contesta lo minimo: `apts_status` recomendando siempre la misma story, y el buzon
// vacio. Todo lo demas devuelve ok, porque el conductor lo llama best-effort y lo que
// se esta probando no es eso. Cuenta las llamadas para poder afirmar que el reintento
// pregunto al motor (o que no llego a preguntar).
const llamadas = [];
// Cuando vale un texto, `apts_status` contesta con un error de operacion cuyo `error` es
// un OBJETO, que es exactamente lo que devuelve APTS. Sirve para la comprobacion 8.
let errorObjeto = null;
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
    llamadas.push(herramienta);

    if (errorObjeto && herramienta === 'apts_status') {
      return responder({
        jsonrpc: '2.0',
        id: peticion.id,
        result: {
          isError: true,
          content: [{
            type: 'text',
            text: JSON.stringify({
              ok: false,
              error: { name: 'AptsClientError', message: errorObjeto, code: 'BAD_REQUEST', statusCode: 400 },
            }),
          }],
        },
      });
    }

    const datos = herramienta === 'apts_status'
      ? {
        project_url: PROYECTO,
        phase: 'implementation',
        backlog: { total: 3, by_status: { done: 1, ready_for_dev: 2 }, done: 1, remaining: 2 },
        recommendation: {
          next: 'run_step',
          target_id: STORY,
          role: 'bmad-agent-dev',
          args: { phase: 'implementation', workflow_key: 'bmad-dev-story', step_key: '1' },
        },
      }
      : {};

    // El conductor lee `result.content[0].text` y lo parsea: es lo que devuelve el
    // servidor de verdad, y `structuredContent` no lo mira. Contestar en el formato
    // equivocado le deja `datos` en null y todo termina en un error de red enganoso.
    return responder({
      jsonrpc: '2.0',
      id: peticion.id,
      result: { content: [{ type: 'text', text: JSON.stringify(datos) }] },
    });
  });
});

// ---- agente falso ----
//
// Imprime por stderr lo que le diga el entorno y sale con el codigo que le digan. Por
// stdout escribe una marca, que es lo que permite comprobar que el eco sigue llegando a
// la consola despues de dejar de heredar la salida.
//
// Con FALSO_MUDO_MS hace otra cosa: saluda y se calla. Es el agente colgado —el que ni
// falla ni termina— que dejaba el ciclo plantado hasta que una persona lo matara.
const AGENTE_FALSO = `
const mudo = Number(process.env.FALSO_MUDO_MS || 0);
if (mudo) {
  process.stdout.write('marca-de-eco-del-agente\\n');
  setTimeout(() => { process.stdout.write('desperte\\n'); process.exit(0); }, mudo);
} else {
  const dormir = Number(process.env.FALSO_DORMIR_MS || 0);
  setTimeout(() => {
    process.stdout.write('marca-de-eco-del-agente\\n');
    if (process.env.FALSO_SALIDA) process.stderr.write(process.env.FALSO_SALIDA + '\\n');
    process.exit(Number(process.env.FALSO_CODIGO || 0));
  }, dormir);
}
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apts-loop-prueba-'));
const rutaAgente = path.join(tmp, 'falso-agente.js');
fs.writeFileSync(rutaAgente, AGENTE_FALSO);
fs.writeFileSync(path.join(tmp, 'vacio.env'), '');

let corridas = 0;
const correr = (puerto, {
  salida, codigo, dormirMs = 0, escalera = 'modelo-a,modelo-b', arranqueMaxMs = 1500,
  mudoMs = 0, silencioMs = null, dotenv = null,
}) => {
  corridas += 1;
  const diario = path.join(tmp, `diario-${corridas}.jsonl`);
  try { fs.unlinkSync(diario); } catch (_) { /* no existia */ }

  return new Promise((resolve) => {
    const hijo = spawn(process.execPath, [
      CONDUCTOR,
      '--mcp-url', `http://127.0.0.1:${puerto}/mcp`,
      '--api-key', 'clave-de-mentira',
      '--project-url', PROYECTO,
      '--agent-name', AGENTE,
      '--agent-email', 'prueba@example.invalid',
      '--agent-cmd', `"${process.execPath}" "${rutaAgente}" {prompt_file} {model}`,
      // Sin escalera no se pasa la bandera: la linea de comandos que habla de modelos deja
      // fuera la capa de entorno entera, y la prueba 13 necesita justo esa capa.
      ...(escalera ? ['--model-escalation', escalera] : []),
      '--max-iterations', '1',
      '--journal', diario,
      '--dotenv', dotenv || path.join(tmp, 'vacio.env'),
      '--no-task-log',
      '--no-journal-remote',
    ], {
      env: {
        ...process.env,
        FALSO_SALIDA: salida,
        FALSO_CODIGO: String(codigo),
        FALSO_DORMIR_MS: String(dormirMs),
        FALSO_MUDO_MS: String(mudoMs),
        APTS_LOOP_STARTUP_MAX_MS: String(arranqueMaxMs),
        // Sin tocar salvo que la prueba lo pida: asi las otras corridas usan el valor por
        // defecto de verdad (20 min), que no puede dispararse en una prueba de segundos.
        ...(silencioMs == null ? {} : { APTS_LOOP_AGENT_SILENCE_MS: String(silencioMs) }),
        // La espera entre intentos, al minimo: lo que se mide es cuantos hubo, no cuanto
        // tardaron. Y los avisos, apagados: una prueba no manda Telegram.
        APTS_LOOP_RETRY_MS: '1',
        APTS_LOOP_TELEGRAM_TOKEN: '',
        APTS_LOOP_TELEGRAM_CHAT_ID: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let visto = '';
    hijo.stdout.on('data', (d) => { visto += d.toString(); });
    hijo.stderr.on('data', (d) => { visto += d.toString(); });
    hijo.on('close', (codigoSalida) => {
      // Con PRUEBA_VERBOSA=1 se ve lo que el conductor escribio. Cuando una comprobacion
      // falla, eso es lo primero que hace falta y sin esto hay que instrumentar a mano.
      if (process.env.PRUEBA_VERBOSA) console.log(`--- conductor (salida ${codigoSalida}) ---\n${visto}---`);
      const eventos = fs.existsSync(diario)
        ? fs.readFileSync(diario, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
        : [];
      resolve({ codigoSalida, visto, eventos });
    });
  });
};

const parada = (r) => r.eventos.find((e) => e.evento === 'parada') || {};
const intentos = (r) => r.eventos.filter((e) => e.evento === 'agente');

(async () => {
  const servidor = crearApts();
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const puerto = servidor.address().port;
  console.log(`APTS de mentira en el ${puerto}\n`);

  try {
    console.log('1) limite de uso: no gasta la escalera y para con motivo propio');
    llamadas.length = 0;
    let r = await correr(puerto, {
      salida: "You've hit your session limit · resets 11:20pm (America/Buenos_Aires)",
      codigo: 1,
    });
    ok(r.codigoSalida === 21, 'sale con 21 y no con 20', `salio ${r.codigoSalida}`);
    ok(parada(r).motivo === 'limite_de_uso', 'el motivo es limite_de_uso', parada(r).motivo);
    ok(intentos(r).length === 1, 'gasta UN intento, no los dos', `gasto ${intentos(r).length}`);
    ok(String(parada(r).reset || '').startsWith('11:20pm'),
      'el diario se queda con la hora de reset', JSON.stringify(parada(r).reset));
    ok(/no se gastan|Quedaba/i.test(parada(r).detalle || ''),
      'el detalle dice que quedaba escalera sin gastar');
    ok(!llamadas.includes('apts_next'), 'no reclama nada al parar');
    console.log();

    console.log('2) fallo normal del agente: el camino de siempre NO cambia');
    r = await correr(puerto, { salida: 'algo revento a mitad de la story', codigo: 1 });
    ok(r.codigoSalida === 20, 'sigue saliendo con 20', `salio ${r.codigoSalida}`);
    ok(parada(r).motivo === 'agente_fallo', 'sigue siendo agente_fallo', parada(r).motivo);
    ok(intentos(r).length === 2, 'gasta la escalera entera', `gasto ${intentos(r).length}`);
    // Sin motivo reconocido, la ultima linea en prosa es lo unico que separa «el agente
    // fallo» de la causa. El caso que lo pidio: una CLI diciendo «File not found: Implementa
    // la unidad...» por una bandera mal ordenada, con el conductor reportando solo el 20.
    ok((parada(r).detalle || '').includes('algo revento a mitad de la story'),
      'y el detalle se lleva la ultima linea que escribio el agente', parada(r).detalle);
    console.log();

    console.log('3) el comando no existe: configuracion, no fallo del agente');
    r = await correr(puerto, { salida: "'claude' is not recognized as an internal or external command", codigo: 1 });
    ok(r.codigoSalida === 22, 'sale con 22', `salio ${r.codigoSalida}`);
    ok(intentos(r).length === 1, 'tampoco gasta la escalera', `gasto ${intentos(r).length}`);
    console.log();

    console.log('4) el cerrojo de duracion: lo mismo, pero despues de trabajar un rato');
    r = await correr(puerto, {
      salida: 'bash: cosa: command not found',
      codigo: 1,
      dormirMs: 400,
      arranqueMaxMs: 200,
    });
    ok(r.codigoSalida === 20, 'pasado el umbral ya no lo trata como binario ausente', `salio ${r.codigoSalida}`);
    ok(intentos(r).length === 2, 'y vuelve a gastar la escalera, que es lo correcto', `gasto ${intentos(r).length}`);
    console.log();

    console.log('5) el limite NO lleva ese cerrojo: llega tras horas de trabajo');
    r = await correr(puerto, {
      salida: "You've hit your session limit · resets 11:20pm",
      codigo: 1,
      dormirMs: 400,
      arranqueMaxMs: 200,
    });
    ok(r.codigoSalida === 21, 'sigue reconociendose', `salio ${r.codigoSalida}`);
    console.log();

    console.log('6) el eco: la salida del agente sigue viendose');
    ok(r.visto.includes('marca-de-eco-del-agente'),
      'lo que el agente escribe por stdout llega a la consola del conductor');
    ok(r.visto.includes('session limit'),
      'y lo que escribe por stderr, tambien');
    console.log();

    console.log('7) un agente que va bien no dispara nada de esto');
    r = await correr(puerto, { salida: 'trabajo hecho', codigo: 0 });
    ok(r.codigoSalida !== 21 && r.codigoSalida !== 22 && r.codigoSalida !== 23,
      'ninguna condicion del entorno se activa con salida 0', `salio ${r.codigoSalida}`);
    ok(intentos(r).length === 1, 'un solo intento, como siempre');
    console.log();

    console.log('8) un error del servidor que viene como objeto se lee, no sale [object Object]');
    errorObjeto = 'Task id must be a valid UUID';
    r = await correr(puerto, { salida: 'da igual', codigo: 0 });
    errorObjeto = null;
    ok(r.visto.includes('Task id must be a valid UUID'),
      'el mensaje de dentro del objeto llega al aviso');
    ok(!r.visto.includes('[object Object]'),
      'y no queda ni un [object Object] por el camino');
    console.log();

    console.log('9) el vigilante de silencio: un agente que ni falla ni termina');
    // Es el caso de campo del 2026-08-15: la story implementada, el commit hecho, las tres
    // capas de la revision adversaria lanzadas en paralelo y la sesion bloqueada esperando
    // un retorno que no llego. Veinticinco minutos sin una linea, con el conductor latiendo.
    r = await correr(puerto, {
      salida: 'da igual', codigo: 0, mudoMs: 60000, silencioMs: 700, escalera: 'modelo-a',
    });
    ok(r.codigoSalida === 24, 'sale con 24 y no con 20', `salio ${r.codigoSalida}`);
    ok(parada(r).motivo === 'agente_mudo', 'el motivo es agente_mudo', parada(r).motivo);
    ok(r.eventos.some((e) => e.evento === 'agente_mudo' && e.silencio_ms >= 700),
      'el diario deja el evento con cuanto silencio hubo');
    ok(!r.visto.includes('desperte'),
      'el agente no llego a despertar: se le corto el arbol de verdad');
    ok(/sin salida durante/.test(JSON.stringify(intentos(r))),
      'el intento se anota diciendo por que murio');
    console.log();

    console.log('10) y gasta la escalera, al reves que los codigos 21 a 23');
    r = await correr(puerto, {
      salida: 'da igual', codigo: 0, mudoMs: 60000, silencioMs: 700, escalera: 'modelo-a,modelo-b',
    });
    ok(intentos(r).length === 2, 'reintentar SI puede salir distinto, asi que reintenta', `gasto ${intentos(r).length}`);
    ok(r.codigoSalida === 24, 'y si el ultimo tambien queda mudo, sale 24', `salio ${r.codigoSalida}`);
    console.log();

    console.log('11) con --agent-silence 0 no hay vigilante');
    r = await correr(puerto, {
      salida: 'da igual', codigo: 0, mudoMs: 900, silencioMs: 0, escalera: 'modelo-a',
    });
    ok(r.visto.includes('desperte'), 'el agente llega a despertar solo');
    ok(r.codigoSalida !== 24, 'y nadie lo da por mudo', `salio ${r.codigoSalida}`);
    console.log();

    console.log('12) el freno viene puesto: 20 minutos por defecto');
    r = await correr(puerto, { salida: 'trabajo hecho', codigo: 0 });
    const arranque = r.eventos.find((e) => e.evento === 'arranque') || {};
    ok(arranque.silencio_min === 20, 'el diario deja escrito el valor por defecto', String(arranque.silencio_min));
    console.log();

    console.log('13) un .env con BOM UTF-8 se lee igual');
    // Node no lo ignora: la primera clave pasa a llamarse "﻿APTS_LOOP_MODEL" y el
    // conductor abortaba con «falta configuracion» teniendo el valor delante. Se comprueba
    // con --model porque es lo unico del .env que el conductor repite por consola: la
    // identidad ya va por bandera en esta prueba.
    const conBom = path.join(tmp, 'con-bom.env');
    fs.writeFileSync(conBom, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('APTS_LOOP_MODEL=modelo-del-dotenv\n', 'utf8')]));
    r = await correr(puerto, { salida: 'trabajo hecho', codigo: 0, escalera: '', dotenv: conBom });
    ok(r.visto.includes('modelo-del-dotenv'),
      'la PRIMERA clave del archivo llega al conductor pese al BOM');
    ok(/BOM/.test(r.visto), 'y el conductor dice que se lo encontro');
  } finally {
    servidor.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* da igual */ }
  }

  console.log(`\n${fallos === 0 ? 'TODO OK' : `${fallos} COMPROBACIONES FALLARON`}`);
  process.exit(fallos === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
