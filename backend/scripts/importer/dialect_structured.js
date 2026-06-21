// F2-T1 — Dialecto estructurado (XML BMAD), lógica pura.
//
// 6 skills de 4-implementation usan <workflow><step n goal><action><check if>
// <output><ask><template-output><goto><critical>. NO es XML estricto (comentarios,
// self-closing irregular, {{vars}}, & sin escapar) → scanner tolerante por tags.
//
// Partición de la tesis (clave): por cada <step> se separa
//   - generative.instruction_md = espina generativa INCONDICIONAL (balde 2):
//       <action>/<output>/<critical> que son hijos DIRECTOS del step (no dentro
//       de un <check>). Es el "escribí/hacé esto" verbatim.
//   - checks[] = cada <check if="..."> (cualquier anidamiento) con su subárbol
//       crudo (balde 3, candidatas): condición + ramas + acciones condicionales.
//       NO se importa como prompt; se cataloga para triage backend en T3.
//   - control[] = HALT + <goto step|anchor> (cualquier anidamiento).
//   - asks[] / template_outputs[] = puntos de elicitación / secciones de artefacto.
// Nada se pierde: lo condicional vive en checks[].raw, no en la espina generativa.

// Parsea atributos `k="v"` / `k='v'` de la porción de atributos de un tag.
const parseAttrs = (attrStr) => {
  const attrs = {};
  const re = /([a-zA-Z_][\w-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(attrStr)) !== null) attrs[m[1]] = m[3] !== undefined ? m[3] : m[4];
  return attrs;
};

// Limpia indentación común y colapsa blancos extremos (sin tocar el interior).
const dedent = (s) => {
  const lines = s.replace(/\r\n/g, '\n').split('\n');
  const indents = lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(min)).join('\n').trim();
};

// Encuentra TODOS los bloques <tag ...>...</tag> (cualquier profundidad), con
// emparejamiento por profundidad para tags anidados del mismo nombre.
// Devuelve [{ attrs, inner, openStart, openEnd, closeStart, closeEnd, depth }].
const findBlocks = (body, tag) => {
  const openRe = new RegExp(`<${tag}(\\s[^>]*?)?>`, 'g');
  const blocks = [];
  let m;
  while ((m = openRe.exec(body)) !== null) {
    const openStart = m.index;
    const openEnd = openRe.lastIndex;
    // camina hacia adelante contando <tag ...> / </tag> hasta cerrar.
    const scan = new RegExp(`<${tag}(\\s[^>]*?)?>|</${tag}>`, 'g');
    scan.lastIndex = openEnd;
    let depth = 1;
    let closeStart = -1;
    let closeEnd = -1;
    let s;
    while ((s = scan.exec(body)) !== null) {
      if (s[0][1] === '/') {
        depth--;
        if (depth === 0) { closeStart = s.index; closeEnd = scan.lastIndex; break; }
      } else depth++;
    }
    if (closeStart === -1) { closeStart = body.length; closeEnd = body.length; }
    blocks.push({
      attrs: parseAttrs(m[1] || ''),
      inner: body.slice(openEnd, closeStart),
      openStart, openEnd, closeStart, closeEnd,
    });
  }
  return blocks;
};

// Marca los rangos [start,end) de los bloques top-level (no contenidos en otro).
const topLevelRanges = (blocks) => {
  const sorted = [...blocks].sort((a, b) => a.openStart - b.openStart);
  const ranges = [];
  let coverEnd = -1;
  for (const b of sorted) {
    if (b.openStart >= coverEnd) {
      ranges.push([b.openStart, b.closeEnd]);
      coverEnd = b.closeEnd;
    }
  }
  return ranges;
};

// Quita los rangos dados de un string (devuelve el resto concatenado).
const removeRanges = (body, ranges) => {
  if (!ranges.length) return body;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  let out = '';
  let cur = 0;
  for (const [s, e] of sorted) { out += body.slice(cur, s); cur = e; }
  out += body.slice(cur);
  return out;
};

// De-taggea texto generativo a markdown legible (sin perder texto).
const detag = (s) =>
  s
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?(?:action|output|critical|guideline)(\s[^>]*?)?>/g, '\n')
    .replace(/<[^>]+>/g, '') // anchors, self-closing residuales
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const textOfTags = (body, tags) => {
  let acc = '';
  for (const t of tags) {
    for (const b of findBlocks(body, t)) acc += `\n${b.inner}`;
  }
  return acc;
};

// Parsea un único <step ...>...</step>.
const parseStep = (attrs, inner) => {
  // checks: TODAS las <check if> (cualquier profundidad) → catálogo balde 3.
  const checkBlocks = findBlocks(inner, 'check');
  const checks = checkBlocks.map((b) => ({
    condition_text: (b.attrs.if || '').trim() || null,
    true: null,   // balde 3 NO se auto-compila: ramas para triage manual (T3)
    false: null,
    raw: dedent(b.inner),
  }));

  // control: HALT + <goto> (cualquier profundidad).
  const control = [];
  for (const g of findBlocks(inner, 'goto')) {
    if (g.attrs.step) control.push({ goto: `step:${g.attrs.step}` });
    else if (g.attrs.anchor) control.push({ goto: `anchor:${g.attrs.anchor}` });
  }
  // <goto .../> self-closing (sin cuerpo): captura aparte.
  const selfGoto = inner.match(/<goto\b([^>]*?)\/>/g) || [];
  for (const sg of selfGoto) {
    const a = parseAttrs(sg);
    if (a.step) control.push({ goto: `step:${a.step}` });
    else if (a.anchor) control.push({ goto: `anchor:${a.anchor}` });
  }
  if (/\bHALT\b/.test(inner)) control.push('HALT');

  // asks / template_outputs (cualquier profundidad) — elicitación / artefacto.
  const asks = findBlocks(inner, 'ask').map((b) => dedent(b.inner)).filter(Boolean);
  const template_outputs = findBlocks(inner, 'template-output').map((b) => ({
    attrs: b.attrs,
    text: dedent(b.inner),
  }));

  // espina generativa: el step SIN los subárboles <check> top-level.
  const topChecks = topLevelRanges(checkBlocks);
  const spine = removeRanges(inner, topChecks);
  const instruction_md = detag(spine);

  return {
    n: attrs.n || null,
    goal: attrs.goal || null,
    tag: attrs.tag || null,
    generative: { instruction_md, asks, template_outputs },
    checks,
    control,
  };
};

// Parsea el cuerpo markdown de una skill estructurada → { workflow_critical[], steps[] }.
const parseStructured = (body) => {
  const wfBlocks = findBlocks(body, 'workflow');
  const scope = wfBlocks.length ? wfBlocks[0].inner : body;

  // <critical> a nivel workflow (antes del primer <step>) = constraints globales.
  const firstStep = scope.search(/<step\b/);
  const preamble = firstStep === -1 ? scope : scope.slice(0, firstStep);
  const workflow_critical = findBlocks(preamble, 'critical').map((b) => dedent(b.inner)).filter(Boolean);

  const steps = findBlocks(scope, 'step')
    .filter((b) => true)
    .map((b) => parseStep(b.attrs, b.inner));

  return { workflow_critical, steps };
};

module.exports = { parseStructured, parseStep, findBlocks, parseAttrs, detag, dedent };
