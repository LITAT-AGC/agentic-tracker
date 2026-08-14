// Guia de integracion en HTML, para personas.
//
// El manifiesto de `/api/public/integrar` esta escrito para agentes: es JSON, esta en
// ingles y su prosa son reglas ejecutables. Una persona que llega por primera vez y
// quiere conectar su repositorio no tiene por donde empezar; el README del repo lo
// explica, pero exige clonar APTS, que es justo lo que un cliente no hace.
//
// La regla que gobierna este archivo: **la guia no repite datos, los renderiza**. Todo lo
// que se puede sacar del manifiesto o del contrato se saca de ahi —la URL del endpoint,
// las cabeceras, los bloques de registro por runtime, los artefactos con su version, las
// 22 operaciones, las reglas de conduccion— y lo unico que se escribe aqui es lo que esas
// dos fuentes no pueden llevar: el orden en que se hacen las cosas y por que. Una tercera
// copia de la superficie se desincronizaria en silencio, que es el fallo que este
// repositorio ya ha pagado dos veces.
//
// Sin recursos externos: CSS embebido y ni una peticion a otro host. Se sirve detras de
// Cloudflare y tiene que verse igual sin red.

const escaparHtml = (valor) => String(valor == null ? '' : valor)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

// Un bloque de codigo. El contenido se escapa SIEMPRE: aqui dentro entra JSON del
// manifiesto y descripciones del contrato, que son texto ajeno a esta plantilla.
const bloque = (texto, etiqueta) => [
  '<figure class="bloque">',
  etiqueta ? `<figcaption>${escaparHtml(etiqueta)}</figcaption>` : '',
  `<pre><code>${escaparHtml(texto)}</code></pre>`,
  '</figure>',
].join('');

const ESTILO = `
:root {
  --fondo: #fbfbfa; --texto: #1c1c1a; --tenue: #6b6b66; --linea: #e2e1dd;
  --acento: #7c4a1e; --codigo-fondo: #f4f3f0; --aviso: #fdf6e7; --aviso-linea: #d9b45f;
}
@media (prefers-color-scheme: dark) {
  :root {
    --fondo: #17171a; --texto: #e8e7e3; --tenue: #9c9b95; --linea: #2f2f34;
    --acento: #e0a06a; --codigo-fondo: #1f1f24; --aviso: #2a2416; --aviso-linea: #8a6d2f;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--fondo); color: var(--texto);
  font: 16px/1.65 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
.envoltura { max-width: 52rem; margin: 0 auto; padding: 3rem 1.25rem 6rem; }
h1 { font-size: 1.9rem; line-height: 1.2; margin: 0 0 .4rem; letter-spacing: -.01em; }
h2 {
  font-size: 1.3rem; margin: 3rem 0 .75rem; padding-top: 1.4rem;
  border-top: 1px solid var(--linea); letter-spacing: -.01em;
}
h3 { font-size: 1.05rem; margin: 1.8rem 0 .5rem; }
p, li { margin: .6rem 0; }
a { color: var(--acento); }
code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: .875em; background: var(--codigo-fondo); padding: .1em .35em; border-radius: 3px;
}
.bloque { margin: 1rem 0; }
.bloque figcaption { font-size: .8rem; color: var(--tenue); margin-bottom: .3rem; }
pre {
  background: var(--codigo-fondo); border: 1px solid var(--linea); border-radius: 6px;
  padding: .85rem 1rem; overflow-x: auto; margin: 0;
}
pre code { background: none; padding: 0; font-size: .82rem; line-height: 1.55; }
table { border-collapse: collapse; width: 100%; margin: 1rem 0; font-size: .9rem; display: block; overflow-x: auto; }
th, td { text-align: left; padding: .45rem .7rem; border-bottom: 1px solid var(--linea); vertical-align: top; }
th { font-weight: 600; color: var(--tenue); font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; }
.entrada { color: var(--tenue); font-size: .95rem; margin-top: 0; }
.cita { color: var(--tenue); font-size: .85rem; margin: .3rem 0 .6rem; }
.aviso {
  background: var(--aviso); border-left: 3px solid var(--aviso-linea);
  padding: .75rem 1rem; margin: 1.25rem 0; border-radius: 0 4px 4px 0;
}
.aviso p:first-child { margin-top: 0; } .aviso p:last-child { margin-bottom: 0; }
details { margin: 1rem 0; border: 1px solid var(--linea); border-radius: 6px; padding: .6rem .9rem; }
summary { cursor: pointer; font-weight: 600; font-size: .95rem; }
details[open] summary { margin-bottom: .6rem; }
.pasos { counter-reset: paso; list-style: none; padding-left: 0; }
.pasos > li { counter-increment: paso; position: relative; padding-left: 2.4rem; margin: 2rem 0; }
.pasos > li::before {
  content: counter(paso); position: absolute; left: 0; top: .05rem;
  width: 1.7rem; height: 1.7rem; border-radius: 50%; background: var(--codigo-fondo);
  border: 1px solid var(--linea); display: grid; place-items: center;
  font-size: .85rem; font-weight: 600; color: var(--tenue);
}
.pasos > li > h3 { margin-top: 0; }
footer { margin-top: 4rem; padding-top: 1.2rem; border-top: 1px solid var(--linea); color: var(--tenue); font-size: .85rem; }
`;

// `manifest` es la salida de buildIntegrationManifest: de ahi salen URL, cabeceras,
// bloques de registro y artefactos. `operations` es la lista de apts_skills.json, que es
// la fuente del CONTRATO. Ninguna de las dos se copia aqui.
const renderIntegrationGuide = ({ manifest, operations = [] }) => {
  const mcp = manifest.mcp_endpoint || {};
  const registros = mcp.registration_by_runtime || {};
  const artefactos = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  const porId = Object.fromEntries(artefactos.map((a) => [a.id, a]));
  const urlDe = (id) => (porId[id] ? porId[id].url : null);

  const cabeceras = (mcp.headers || [])
    .map((h) => (typeof h === 'string' ? h : h.name || h.header || JSON.stringify(h)));

  const seccionRuntime = (clave, titulo) => {
    const r = registros[clave];
    if (!r) return '';
    return [
      `<h3>${escaparHtml(titulo)}</h3>`,
      `<p>Pegalo en <code>${escaparHtml(r.config_file || '')}</code>, en la raiz de tu repositorio.</p>`,
      // Se cita en vez de traducirse: es texto del manifiesto, y una traduccion aqui seria
      // una copia que se queda vieja el dia que cambie la sintaxis de sustitucion.
      r.value_substitution
        ? `<p class="cita">Del manifiesto: <em>${escaparHtml(r.value_substitution)}</em></p>`
        : '',
      bloque(JSON.stringify(r.config, null, 2), r.config_file),
    ].join('');
  };

  const filaOperacion = (op) => {
    // La descripcion del contrato es larga a proposito —la lee un agente—; aqui se corta
    // en la primera frase, que es lo que una persona necesita para ubicarla.
    const corta = String(op.description || '').split(/(?<=\.)\s/)[0];
    return `<tr><td><code>${escaparHtml(op.name)}</code></td><td>${escaparHtml(corta)}</td></tr>`;
  };

  const filaArtefacto = (a) => [
    '<tr>',
    `<td><a href="${escaparHtml(a.url)}"><code>${escaparHtml(a.id)}</code></a></td>`,
    `<td>${escaparHtml(a.artifact_version || '')}</td>`,
    `<td>${escaparHtml(a.description || '')}</td>`,
    '</tr>',
  ].join('');

  const reglas = manifest.method_conduction || {};
  const filaRegla = ([clave, valor]) => (clave === 'summary' ? '' : [
    '<details>',
    `<summary>${escaparHtml(clave)}</summary>`,
    `<pre><code>${escaparHtml(valor)}</code></pre>`,
    '</details>',
  ].join(''));

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Integrarse con APTS — guia</title>
<meta name="description" content="Como conectar un repositorio a APTS: registrar el endpoint MCP, instalar agentes y comandos, y conducir el metodo BMAD.">
<style>${ESTILO}</style>
</head>
<body>
<main class="envoltura">

<h1>Integrarse con APTS</h1>
<p class="entrada">
  Como conectar un repositorio a este servicio: registrar la superficie, dejar que tu agente
  la use, y —si quieres— conducir el metodo BMAD de punta a punta.
  Esta pagina se genera desde el mismo manifiesto y el mismo contrato que consume tu agente,
  asi que no puede quedarse vieja respecto de ellos.
</p>

<div class="aviso">
  <p><strong>Hay una sola superficie: el endpoint MCP remoto.</strong>
  Se registra con una URL y cuatro cabeceras, y las operaciones llegan solas por
  <code>tools/list</code>. <strong>No hay nada que descargar para llamarlas</strong>, ningun
  proceso local que arrancar y ninguna version de cliente que mantener al dia.</p>
  <p>Lo que si se descarga —agentes, comandos, el conductor del bucle— es opcional y sirve
  para <em>conducir</em>, no para llamar.</p>
</div>

<h2>Antes de empezar</h2>
<p>Necesitas cuatro valores. Uno es un secreto y te lo da el operador de APTS; los otros tres
los eliges tu, con una condicion: que sean <strong>estables</strong>.</p>

<table>
  <thead><tr><th>Valor</th><th>Que es</th></tr></thead>
  <tbody>
    <tr><td><code>APTS_API_KEY</code></td><td>El secreto. <strong>Pidelo al operador</strong>; no lo inventes ni lo commitees. Va en un <code>.env</code> fuera de control de versiones.</td></tr>
    <tr><td><code>APTS_PROJECT_URL</code></td><td>La URL del repositorio, por ejemplo <code>https://github.com/org/repo</code>. APTS la normaliza, asi que la forma <code>git@…</code> y la <code>https://…</code> son el mismo proyecto.</td></tr>
    <tr><td><code>APTS_AGENT_NAME</code></td><td>El nombre de tu agente. Tiene que repetirse entre sesiones: es el puntero por el que APTS reconoce a quien vuelve.</td></tr>
    <tr><td><code>APTS_AGENT_EMAIL</code></td><td>Un correo de contacto para ese agente.</td></tr>
  </tbody>
</table>

<div class="aviso">
  <p><strong>La identidad viaja en el registro, no en el entorno del servidor.</strong>
  APTS no mira tu sistema de archivos, ni tus variables, ni tu Git: lee esas cabeceras y nada
  mas. Un valor enviado en los argumentos de una llamada gana a la cabecera —asi conmuta de rol
  un agente— y un <code>project_url</code> que contradiga a la cabecera se rechaza.</p>
</div>

<h2>Los tres pasos</h2>

<ol class="pasos">

<li>
<h3>Registrar el endpoint MCP</h3>
<p>Es el unico paso obligatorio. El endpoint es
<code>${escaparHtml(mcp.url || '')}</code> (${escaparHtml(mcp.transport || '')}, ${escaparHtml(mcp.session || '')})
y lleva estas cabeceras: ${cabeceras.map((h) => `<code>${escaparHtml(h)}</code>`).join(', ')}.</p>
${seccionRuntime('claudecode', 'Claude Code')}
${seccionRuntime('opencode', 'opencode')}
<p>Y los valores que ese bloque referencia, en el <code>.env</code> del proyecto:</p>
${bloque([
    'APTS_API_KEY="…"',
    'APTS_PROJECT_URL="https://github.com/org/repo"',
    'APTS_AGENT_NAME="mi-agente"',
    'APTS_AGENT_EMAIL="mi-agente@example.com"',
  ].join('\n'), '.env')}
<div class="aviso">
  <p><strong>Ningun runtime carga el <code>.env</code> por su cuenta.</strong> Las variables
  tienen que estar en el <strong>entorno del proceso</strong> cuando arranca la herramienta. Si
  tu agente no ve el servidor MCP, esta es la causa nueve de cada diez veces.</p>
  <p>La excepcion es <strong>opencode</strong>, y solo si haces el paso 2: el adaptador generado
  trae un plugin (<code>.opencode/plugin/apts-env.js</code>) que lee ese <code>.env</code> al
  arrancar y mete los valores en el registro MCP. Con el, un <code>.env</code> en la raiz basta.
  El entorno del proceso, si define la misma variable, sigue ganando.</p>
</div>
</li>

<li>
<h3>Instalar los agentes y los comandos</h3>
<p>Opcional para llamar a las operaciones, <strong>necesario para conducir</strong>. Sin este
paso tu proyecto se queda sin el orquestador de metodo y sin ningun comando, y el ciclo hay
que llevarlo a mano.</p>
<p>Los adaptadores no se descargan hechos: se <em>generan</em> desde un spec unico, para que
no exista una segunda copia que se separe en silencio.</p>
${bloque([
    `curl -o apts-surface.json "${urlDe('surface_spec') || ''}"`,
    `curl -o generate-adapters.js "${urlDe('adapter_generator') || ''}"`,
    `curl -o apts_skills.json  "${urlDe('skills_json') || ''}"`,
    '',
    '# El generador espera este arbol:',
    '#   ./apts_skills.json',
    '#   ./scripts/generate-adapters.js',
    '#   ./runtime-adapters/spec/apts-surface.json',
    'node scripts/generate-adapters.js',
  ].join('\n'))}
<p>Eso emite <code>runtime-adapters/claude/</code> y <code>runtime-adapters/opencode/</code>.
Copia <strong>el directorio entero de tu runtime</strong> a la raiz de tu proyecto conservando
las rutas relativas: trae de una vez el registro MCP, el archivo de instrucciones, los
permisos, los cuatro agentes y los cinco comandos
(<code>apts-next</code>, <code>apts-method</code>, <code>apts-bug</code>,
<code>apts-status</code>, <code>apts-resume</code>).</p>
<p>Los archivos generados son <strong>gestionados</strong>: llevan un banner que lo dice y no
se editan a mano. Se edita el spec y se regenera.</p>
</li>

<li>
<h3>Comprobar que funciona</h3>
<p>Antes de darlo por bueno, pregunta al endpoint que operaciones ofrece. Si esto contesta, el
registro es correcto y la clave vale:</p>
${bloque([
    `curl -sS -X POST "${mcp.url || ''}" \\`,
    '  -H "Content-Type: application/json" \\',
    '  -H "Accept: application/json, text/event-stream" \\',
    '  -H "Authorization: Bearer $APTS_API_KEY" \\',
    '  -H "X-APTS-Project-Url: $APTS_PROJECT_URL" \\',
    '  -H "X-APTS-Agent-Name: $APTS_AGENT_NAME" \\',
    '  -H "X-APTS-Agent-Email: $APTS_AGENT_EMAIL" \\',
    `  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
  ].join('\n'))}
<p>Despues, desde tu agente: registra una tarea con <code>register_task</code>, escribe un
hito con <code>log_agent_progress</code>, y compruebalo en el panel. Si el proyecto y la tarea
aparecen ahi, la integracion esta hecha.</p>
</li>

</ol>

<h2>Conducir el metodo BMAD</h2>
<p>Lo anterior te deja reportando trabajo. Esto es otra cosa: dejar que APTS <strong>dirija</strong>
el desarrollo. El motor del metodo vive en el servidor y decide en que fase esta la
iniciativa, que paso toca, que rol lo ejecuta y que artefacto hace falta para cerrarlo. Tu
cliente pregunta y obedece; lo que aporta es contenido, nunca estructura.</p>
<p>El ciclo es <code>analysis → planning → solutioning → implementation → done</code>, y cada
fase se cierra produciendo documentos concretos: el brief, el PRD, la arquitectura, los epics
con sus stories, el plan de sprint. La ultima fase reparte las stories una a una, y cada una
se cierra con su commit y su revision adversaria; sin esa revision el cierre se rechaza.</p>
<p>Arrancar son dos llamadas idempotentes: <code>create_initiative</code> (pasandole tu spec
como <code>spec_artifact</code>, si la tienes) y un <code>set_agent_role</code> por rol. A
partir de ahi, <code>apts_next</code> manda.</p>
<div class="aviso">
  <p><strong>Una spec no salta fases.</strong> Se guarda como <code>doc_type: spec</code>
  precisamente para no cerrar ninguna: es la entrada del analyst y del PM, no un sustituto de
  sus artefactos. Arrancar en una fase adelantada se rechaza si los artefactos de las fases
  anteriores no existen ya.</p>
</div>
<p>Las reglas completas son parte del manifiesto —<code>method_conduction</code>— y son la
fuente autoritativa. Estan aqui tal cual las lee tu agente:</p>
${Object.entries(reglas).map(filaRegla).join('')}

<h2>El bucle desatendido</h2>
<p>Con la iniciativa ya en <code>implementation</code>, el conductor mastica el backlog solo:
pregunta al motor que toca, lanza <strong>un proceso de agente por story con contexto
limpio</strong>, espera, y vuelve a preguntar. Para cuando el motor dice <code>done</code> o
salta un freno. No conduce las fases generativas, que son interactivas.</p>
${bloque([
    `curl -O "${urlDe('loop_conductor') || ''}"`,
    `curl -O "${urlDe('loop_conductor_readme') || ''}"`,
    '',
    '# Empieza SIEMPRE con --dry-run: resuelve la primera decision sin ejecutar nada.',
    'node apts-loop.js --agent-name mi-dev --dry-run \\',
    `  --agent-cmd 'claude -p "$(cat {prompt_file})" --model {model} --permission-mode acceptEdits'`,
  ].join('\n'))}
<p>El script es autocontenido (CommonJS, solo builtins de Node), pero <strong>no se puede usar
sin su manual</strong>: <code>--agent-cmd</code> es obligatorio y su forma depende del runtime
—en Windows el <code>$(cat …)</code> no existe y hay que usar <code>type</code>—. Por eso los
dos artefactos van juntos.</p>

<h2>Referencia</h2>

<h3>Operaciones del contrato (${operations.length})</h3>
<p>Llegan solas por <code>tools/list</code>; no hay que instalarlas. La fuente formal de
parametros y tipos es <code>apts_skills.json</code>, y es la unica.</p>
<table>
  <thead><tr><th>Operacion</th><th>Para que</th></tr></thead>
  <tbody>${operations.map(filaOperacion).join('')}</tbody>
</table>

<h3>Artefactos descargables</h3>
<p>Todos opcionales. La version viaja en la URL a proposito: asi una version nueva estrena
clave de cache y ningun intermediario puede servirte los bytes de la anterior.</p>
<table>
  <thead><tr><th>Artefacto</th><th>Version</th><th>Que es</th></tr></thead>
  <tbody>${artefactos.map(filaArtefacto).join('')}</tbody>
</table>

<h3>Si algo no funciona</h3>
<table>
  <thead><tr><th>Sintoma</th><th>Que suele ser</th></tr></thead>
  <tbody>
    <tr><td>El runtime no ve el servidor MCP</td><td>Las variables no estan en el entorno del proceso. Ningun runtime lee el <code>.env</code> por su cuenta.</td></tr>
    <tr><td><code>401</code> / <code>403</code></td><td>La clave falta o no vale. No es reintentable: revisa <code>APTS_API_KEY</code> y la cabecera bearer.</td></tr>
    <tr><td>Los agentes y comandos no aparecen</td><td>No copiaste el directorio entero conservando rutas: los agentes van en <code>.claude/agents/</code> o <code>.opencode/agent/</code>, los comandos en <code>.claude/commands/</code> o <code>.opencode/command/</code>.</td></tr>
    <tr><td><code>INVALID_ARGUMENT</code></td><td>Falta un campo, un UUID no es valido o un enum no existe. El servidor nombra el campo: no es un valor a adivinar.</td></tr>
    <tr><td><code>PHASE_NOT_REACHABLE</code></td><td>Intentaste arrancar la iniciativa en una fase adelantada sin los artefactos que cierran las anteriores.</td></tr>
    <tr><td><code>apts_next</code> devuelve <code>wait</code> para siempre</td><td>Falta el roster: un rol sin <code>entity_key</code> resuelto deja el motor esperando. Registralos todos con <code>set_agent_role</code>.</td></tr>
    <tr><td><code>429</code> o <code>5xx</code></td><td>Transitorio. Reintenta, como mucho dos veces.</td></tr>
  </tbody>
</table>

<footer>
  <p>${escaparHtml(manifest.service || 'APTS')} · manifiesto <code>schema_version ${escaparHtml(manifest.schema_version || '')}</code> ·
  el original en JSON, para agentes, esta en <a href="${escaparHtml(manifest.entrypoint || '')}">${escaparHtml(manifest.entrypoint || '')}</a>.</p>
  <p>Esta pagina se genera desde ese manifiesto y desde el contrato en cada peticion: si un dato
  de aqui esta viejo, lo esta en la fuente.</p>
</footer>

</main>
</body>
</html>`;
};

module.exports = { renderIntegrationGuide, escaparHtml };
