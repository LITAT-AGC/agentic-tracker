#!/usr/bin/env node
// Prueba de la guia de integracion en HTML.
//
// Uso:  cd backend && node scripts/test_integration_guide.js
// No necesita servidor ni base: `renderIntegrationGuide` es una funcion pura del manifiesto
// y del contrato, y se la llama con datos de mentira.
//
// Lo que se vigila, en este orden de importancia:
//   1. Que ESCAPE. Por la pagina pasa texto que no escribio esta plantilla —descripciones
//      del contrato, prosa del manifiesto, URLs— y basta un `<` sin escapar para romper el
//      documento o algo peor.
//   2. Que RENDERICE lo que le dan en vez de traer su propia copia: si manana el manifiesto
//      publica otra URL o el contrato otra operacion, la pagina tiene que cambiar sola.
//   3. Que no pida nada a otro host: se sirve detras de Cloudflare y tiene que verse igual
//      sin red.

const { renderIntegrationGuide } = require('./lib/integration_guide');

let fallos = 0;
const ok = (cond, etiqueta, detalle) => {
  console.log(`${cond ? '  OK  ' : ' FALLA'} ${etiqueta}${detalle ? ` — ${detalle}` : ''}`);
  if (!cond) fallos += 1;
};

const MANIFIESTO = {
  service: 'APTS',
  schema_version: '9.9.9',
  entrypoint: 'https://ejemplo.invalid/api/public/integrar',
  mcp_endpoint: {
    url: 'https://ejemplo.invalid/mcp',
    transport: 'streamable_http',
    session: 'stateless',
    headers: ['Authorization', 'X-APTS-Project-Url', 'X-APTS-Agent-Name', 'X-APTS-Agent-Email'],
    registration_by_runtime: {
      claudecode: {
        config_file: '.mcp.json',
        value_substitution: 'Environment variables expand as ${VAR}.',
        loop_agent_cmd: {
          agent_cmd: 'cli-falsa -p "$(cat {prompt_file})" --model {model}',
          agent_cmd_windows: 'type {prompt_file} | cli-falsa -p --model {model}',
          model_escalation_example: 'modelo-barato,modelo-caro',
        },
        config: { mcpServers: { apts: { type: 'http', url: 'https://ejemplo.invalid/mcp' } } },
      },
      opencode: {
        config_file: 'opencode.json',
        loop_agent_cmd: {
          agent_cmd: 'otra-cli run -m {model} -f {prompt_file}',
          model_escalation_example: 'proveedor/barato,proveedor/caro',
        },
        config: { mcp: { apts: { type: 'remote', url: 'https://ejemplo.invalid/mcp' } } },
      },
    },
  },
  method_conduction: {
    summary: 'un resumen que NO debe salir como bloque plegable',
    drive_loop: 'la regla del bucle',
    dev_story_completion_rule: 'la regla del cierre',
  },
  artifacts: [
    {
      id: 'loop_conductor',
      artifact_version: '1.7.1',
      url: 'https://ejemplo.invalid/api/public/integrar/conductor/apts-loop.js?v=1.7.1',
      description: 'El conductor del bucle.',
    },
    {
      id: 'surface_spec',
      artifact_version: '1.0.2',
      url: 'https://ejemplo.invalid/api/public/integrar/runtime-adapters/spec/apts-surface.json?v=1.0.2',
      description: 'El spec de superficie.',
    },
    {
      id: 'adapter_generator',
      artifact_version: '1.1.0',
      url: 'https://ejemplo.invalid/api/public/integrar/scripts/generate-adapters.js?v=1.1.0',
      description: 'El generador.',
    },
    {
      id: 'skills_json',
      artifact_version: '1.0.2',
      url: 'https://ejemplo.invalid/api/public/integrar/skills.json?v=1.0.2',
      description: 'El contrato.',
    },
    {
      id: 'loop_conductor_readme',
      artifact_version: '1.7.0',
      url: 'https://ejemplo.invalid/api/public/integrar/conductor/README.md?v=1.7.0',
      description: 'El manual del conductor.',
    },
  ],
};

const OPERACIONES = [
  { name: 'register_task', description: 'Crea o reanuda una tarea. Segunda frase que no deberia salir.' },
  { name: 'apts_next', description: 'Pide el siguiente paso.' },
];

const html = renderIntegrationGuide({ manifest: MANIFIESTO, operations: OPERACIONES });

console.log('1) escapado: nada de lo ajeno entra crudo en el documento');
const conVeneno = renderIntegrationGuide({
  manifest: {
    ...MANIFIESTO,
    service: '<script>alert(1)</script>',
    entrypoint: 'https://ejemplo.invalid/"><script>alert(2)</script>',
    method_conduction: { drive_loop: '<img src=x onerror=alert(3)>' },
    artifacts: [{
      id: '<b>id</b>', artifact_version: '1', url: 'https://ejemplo.invalid/a',
      description: '<script>alert(4)</script>',
    }],
  },
  operations: [{ name: 'op_rara', description: '<script>alert(5)</script> y mas.' }],
});
// Se comprueba que la ETIQUETA no sobreviva sin escapar, no que el texto no aparezca:
// `&lt;img src=x onerror=…&gt;` dentro de un <pre> es texto inerte y tiene que poder verse,
// que para eso la pagina muestra las reglas del manifiesto tal cual.
ok(!conVeneno.includes('<script>alert('), 'ningun <script> inyectado sobrevive como etiqueta');
ok(!conVeneno.includes('<img'), 'ningun <img> inyectado sobrevive como etiqueta');
ok(conVeneno.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'lo peligroso aparece escapado, no descartado');
ok(conVeneno.includes('onerror=alert(3)') && conVeneno.includes('&lt;img'),
  'y el texto inerte sigue siendo legible');
// El entrypoint envenenado lleva `/"><script…`: si la comilla no se escapara, cerraria el
// href y abriria una etiqueta. Se comprueba por los dos lados —que la secuencia peligrosa
// no exista, y que la comilla si aparezca convertida— porque lo primero solo tambien lo
// cumpliria una plantilla que hubiera tirado el valor entero.
ok(!conVeneno.includes('/"><script'), 'un valor con comillas no se sale de su atributo');
ok(conVeneno.includes('&quot;&gt;&lt;script&gt;'), 'la comilla viaja escapada dentro del href');

console.log('\n2) renderiza el manifiesto, no una copia propia');
ok(html.includes('https://ejemplo.invalid/mcp'), 'la URL del endpoint sale del manifiesto');
ok(html.includes('streamable_http') && html.includes('stateless'), 'transporte y sesion tambien');
ok(html.includes('X-APTS-Agent-Email'), 'las cuatro cabeceras salen del manifiesto');
ok(html.includes('mcpServers'), 'el bloque de registro de Claude Code se renderiza entero');
ok(html.includes('opencode.json'), 'y el de opencode');
ok(html.includes('1.7.1'), 'las versiones de los artefactos vienen del manifiesto');
ok(html.includes('conductor/apts-loop.js?v=1.7.1'), 'y sus URLs versionadas');
ok(html.includes('9.9.9'), 'el pie declara la schema_version que le dieron');

console.log('\n3) renderiza el contrato');
ok(html.includes('register_task') && html.includes('apts_next'), 'estan las operaciones que le pasaron');
ok(html.includes('Crea o reanuda una tarea.'), 'con su descripcion');
ok(!html.includes('Segunda frase que no deberia salir'),
  'recortada en la primera frase: la del contrato es larga porque la lee un agente');

console.log('\n4) las reglas de conduccion, tal cual');
ok(html.includes('drive_loop') && html.includes('la regla del bucle'), 'cada regla es un bloque plegable');
ok(!html.includes('un resumen que NO debe salir como bloque plegable'),
  'el summary no se repite como regla');

console.log('\n5) la invocacion del conductor sale del manifiesto, no de la plantilla');
// La guia tenia su propia copia de la linea de Claude Code. Ahora se renderiza desde
// `registration_by_runtime.<runtime>.loop_agent_cmd`, que es donde vive la fuente unica:
// con una CLI de mentira en el manifiesto, en la pagina no puede quedar rastro de la real.
ok(html.includes('cli-falsa -p') && html.includes('otra-cli run'),
  'las dos lineas --agent-cmd vienen del manifiesto');
ok(!html.includes('claude -p') && !html.includes('opencode run'),
  'y la plantilla no conserva ninguna copia propia');
ok(html.includes('type {prompt_file} | cli-falsa'), 'la variante de Windows tambien se muestra');
ok(html.includes('Vale igual en Windows'),
  'y el runtime que no la declara lo dice, en vez de dejar el hueco');
ok(html.includes('modelo-barato,modelo-caro') && html.includes('proveedor/barato,proveedor/caro'),
  'cada runtime muestra su escalera de ejemplo');
// El bloque de ejemplo usa la primera invocacion publicada, no una escrita a mano.
// Va dentro de un <pre> escapado, asi que la comilla viaja como &#39;.
ok(html.includes('--agent-cmd &#39;cli-falsa -p'), 'el ejemplo de --dry-run usa una de ellas');

console.log('\n6) autocontenida');
ok(!/(src|href)="https?:\/\/(?!ejemplo\.invalid)/.test(html), 'no pide nada a otro host');
ok(!/<link\b/i.test(html) && !/<script\b/i.test(html), 'ni hoja de estilos externa ni scripts');
ok(html.includes('<style>'), 'el CSS va embebido');

console.log('\n7) documento bien formado');
ok(html.startsWith('<!doctype html>'), 'declara HTML5');
ok(html.includes('<html lang="es">'), 'declara el idioma');
ok(html.includes('name="viewport"'), 'es usable en un telefono');
ok(html.trimEnd().endsWith('</html>'), 'cierra el documento');
const abiertas = (html.match(/<details\b/g) || []).length;
const cerradas = (html.match(/<\/details>/g) || []).length;
ok(abiertas === cerradas && abiertas > 0, 'los plegables abren y cierran igual', `${abiertas}/${cerradas}`);

console.log('\n8) aguanta un manifiesto incompleto sin reventar');
let minimo = null;
try {
  minimo = renderIntegrationGuide({ manifest: { artifacts: [] }, operations: [] });
} catch (error) {
  ok(false, 'no lanza con un manifiesto vacio', error.message);
}
ok(minimo !== null && minimo.startsWith('<!doctype html>'), 'sigue devolviendo un documento');
ok(minimo !== null && !minimo.includes('undefined'),
  'y no escribe "undefined" en la pagina');

console.log(`\n${fallos === 0 ? 'TODO OK' : `${fallos} COMPROBACIONES FALLARON`}`);
process.exit(fallos === 0 ? 0 : 1);
