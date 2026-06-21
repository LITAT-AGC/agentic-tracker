// F2-T1 — Dialecto prosa (markdown sin <step>), lógica pura.
//
// 23 workflows de análisis/planning/solutioning + 2 core en scope no usan XML:
// estructuran con `# Título` + lead, luego `## Sección` (Discovery/Constraints/
// Finalize…). Decisión F2: cada `## sección` con instrucción = un step generativo;
// se descartan secciones-andamiaje (On Activation/Conventions/Paths) = re-cableado.
// El `# Título` + lead (Overview/Goal) = step de intro (n="0").
//
// Balde 3 en prosa: los `<check>` no existen como tags; el routing/condicionales
// están en prosa natural. NO se intenta extraer reglas acá (sería adivinar) →
// checks=[] siempre; el catálogo balde 3 de estas skills sale del CSV (routing)
// + triage manual en T3. control[] captura HALT textual como señal.

const { isScaffoldHeading } = require('./classify');

// Divide el body en { preamble, sections:[{title, level, body}] } por headings ## .
const splitSections = (body) => {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const sections = [];
  let preambleLines = [];
  let cur = null;
  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+?)\s*$/); // solo h2 abre sección (### queda dentro)
    if (h2) {
      if (cur) sections.push(cur);
      cur = { title: h2[1].trim(), body: [] };
    } else if (cur) {
      cur.body.push(line);
    } else {
      preambleLines.push(line);
    }
  }
  if (cur) sections.push(cur);
  return {
    preamble: preambleLines.join('\n').trim(),
    sections: sections.map((s) => ({ title: s.title, body: s.body.join('\n').trim() })),
  };
};

// Título h1 + lead del preámbulo (sin la línea `# ...`).
const splitPreamble = (preamble) => {
  const lines = preamble.replace(/\r\n/g, '\n').split('\n');
  const m = lines[0] && lines[0].match(/^#\s+(.+?)\s*$/);
  if (!m) return { h1: null, lead: preamble.trim() };
  return { h1: m[1].trim(), lead: lines.slice(1).join('\n').trim() };
};

const proseStep = (n, goal, instruction_md) => ({
  n: String(n),
  goal,
  tag: null,
  generative: {
    instruction_md,
    asks: [],
    template_outputs: [],
  },
  checks: [],
  control: /\bHALT\b/.test(instruction_md) ? ['HALT'] : [],
});

// Parsea el cuerpo markdown de una skill prosa → { workflow_critical[], steps[], dropped_sections[] }.
const parseProse = (body) => {
  const { preamble, sections } = splitSections(body);
  const { h1, lead } = splitPreamble(preamble);
  const steps = [];
  const dropped_sections = [];

  // step "0" = overview/intro si hay lead con contenido.
  if (lead) steps.push(proseStep(0, h1 || 'Overview', lead));

  let order = 1;
  for (const sec of sections) {
    if (isScaffoldHeading(sec.title)) {
      dropped_sections.push(sec.title); // andamiaje (re-cableado), no ADN
      continue;
    }
    if (!sec.body) { dropped_sections.push(`${sec.title} (vacía)`); continue; }
    steps.push(proseStep(order, sec.title, sec.body));
    order++;
  }

  return { workflow_critical: [], steps, dropped_sections };
};

module.exports = { parseProse, splitSections, splitPreamble };
