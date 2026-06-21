// F2-T1 — Clasificación y utilidades transversales del parser (lógica pura).
//
// Cubre: frontmatter YAML mínimo, detección de dialecto, mapeo de fase,
// secciones-andamiaje (re-cableado BMAD, NO ADN) y extracción de refs sin
// resolver (worklist de re-cableado para T4).

// --- Frontmatter YAML mínimo (solo `key: scalar`, lo único que usa el corpus) ---
// Devuelve { frontmatter:{...}, body } . Acepta valores con/sin comillas.
const splitFrontmatter = (md) => {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: md };
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith("'") && val.endsWith("'")) || (val.startsWith('"') && val.endsWith('"'))) {
      val = val.slice(1, -1);
    }
    fm[key] = val;
  }
  return { frontmatter: fm, body: m[2] };
};

// --- Dialecto: el corpus v6.8 tiene 2 (decisión F2). Auto-detección por <step>. ---
const detectDialect = (body) => (/<step\b/.test(body) ? 'structured' : 'prose');

// --- DEPRECATED: la skill forwardea a otra canónica; se salta (decisión F2). ---
const isDeprecated = (frontmatter, body) =>
  /^deprecated\b/i.test(frontmatter.description || '') || /^#+\s*DEPRECATED\b/im.test(body);

// --- Mapeo de fase. Prefiere la fila del CSV; fallback al prefijo de directorio. ---
// Dirs: 1-analysis, 2-plan-workflows, 3-solutioning, 4-implementation.
const DIR_PHASE = {
  '1-analysis': 'analysis',
  '2-plan-workflows': 'planning',
  '3-solutioning': 'solutioning',
  '4-implementation': 'implementation',
};
// Fase del CSV: anytime | 1-analysis | 2-planning | 3-solutioning | 4-implementation.
const CSV_PHASE = {
  anytime: 'anytime',
  '1-analysis': 'analysis',
  '2-planning': 'planning',
  '3-solutioning': 'solutioning',
  '4-implementation': 'implementation',
};
const phaseFromDir = (relPath) => {
  for (const seg of relPath.split(/[/\\]/)) {
    if (DIR_PHASE[seg]) return DIR_PHASE[seg];
  }
  return 'anytime'; // core-skills y transversales
};
const normalizeCsvPhase = (raw) => CSV_PHASE[(raw || '').trim()] || (raw || '').trim() || null;

// --- Secciones-andamiaje (re-cableado, NO ADN). Se descartan como steps. ---
// Coincidencia por título de heading (case-insensitive, exacto tras trim).
const SCAFFOLD_HEADINGS = new Set([
  'on activation',
  'conventions',
  'paths',
]);
const isScaffoldHeading = (title) => SCAFFOLD_HEADINGS.has((title || '').trim().toLowerCase());

// --- Refs sin resolver: worklist de re-cableado BMAD→APTS para T4. ---
// Captura placeholders de config/ruta {…} (p. ej. {project-root}, {planning_artifacts}),
// rutas _bmad y scripts .py del andamiaje. EXCLUYE las vars de runtime/template
// `{{…}}` (Handlebars/estado del workflow): son ADN generativo, no re-cableado.
const PLACEHOLDER_RE = /(?<!\{)\{[a-zA-Z0-9_\-.\/]+\}(?!\})/g;
const BMAD_PATH_RE = /\{?project-root\}?\/_bmad\/[^\s`'")]+/g;
const PY_SCRIPT_RE = /[a-zA-Z0-9_\-./{}]*resolve_customization\.py/g;

const extractUnresolvedRefs = (text) => {
  const refs = new Set();
  for (const re of [PLACEHOLDER_RE, BMAD_PATH_RE, PY_SCRIPT_RE]) {
    const found = text.match(re);
    if (found) for (const r of found) refs.add(r);
  }
  return [...refs].sort();
};

module.exports = {
  splitFrontmatter,
  detectDialect,
  isDeprecated,
  phaseFromDir,
  normalizeCsvPhase,
  isScaffoldHeading,
  extractUnresolvedRefs,
  DIR_PHASE,
  CSV_PHASE,
};
