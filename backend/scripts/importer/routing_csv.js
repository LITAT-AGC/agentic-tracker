// F2-T1 — Parser de `src/bmm-skills/module-help.csv` (lógica pura).
//
// El CSV es la fuente del routing inter-fase (decisión F2: el DAG de lifecycle
// ya es dato, NO se deriva de los <check>). Columnas reales (v6.8.0):
//   module,skill,display-name,menu-code,description,action,args,phase,
//   preceded-by,followed-by,required,output-location,outputs
// Notas del corpus: hay filas múltiples por skill (una por `action`/menu item);
// `preceded-by`/`followed-by` pueden referenciar `skill:action`; algunas filas
// son ragged (menos columnas) → se parsean defensivamente y se reportan.

// CSV RFC4180-ish: comillas dobles, "" como escape, comas dentro de comillas.
const parseCsv = (text) => {
  const rows = [];
  let row = [];
  let field = '';
  let inQ = false;
  const src = text.replace(/\r\n/g, '\n');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQ) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length && r.some((x) => x.trim() !== ''));
};

// Parsea el CSV → { bySkill: Map<skill, route[]>, malformed: [], header }.
// Cada `route` = { action, phase, preceded_by[], followed_by[], required, output_location, outputs, raw }.
const parseRoutingCsv = (text) => {
  const rows = parseCsv(text);
  if (!rows.length) return { bySkill: new Map(), malformed: [], header: [] };
  const header = rows[0].map((h) => h.trim());
  const idx = (name) => header.indexOf(name);
  const col = {
    skill: idx('skill'),
    action: idx('action'),
    phase: idx('phase'),
    preceded: idx('preceded-by'),
    followed: idx('followed-by'),
    required: idx('required'),
    outloc: idx('output-location'),
    outputs: idx('outputs'),
  };
  const bySkill = new Map();
  const malformed = [];
  const splitRefs = (s) => (s || '').split('|').map((x) => x.trim()).filter(Boolean);

  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const get = (i) => (i >= 0 && i < cells.length ? (cells[i] || '').trim() : '');
    const skill = get(col.skill);
    if (!skill || skill === '_meta') continue; // _meta = doc del módulo, no skill
    if (cells.length !== header.length) {
      malformed.push({ line: r + 1, skill, got: cells.length, expected: header.length });
    }
    const route = {
      action: get(col.action) || null,
      phase: get(col.phase) || null,
      preceded_by: splitRefs(get(col.preceded)),
      followed_by: splitRefs(get(col.followed)),
      required: get(col.required) === 'true',
      output_location: get(col.outloc) || null,
      outputs: get(col.outputs) || null,
      raw: cells,
    };
    if (!bySkill.has(skill)) bySkill.set(skill, []);
    bySkill.get(skill).push(route);
  }
  return { bySkill, malformed, header };
};

module.exports = { parseRoutingCsv, parseCsv };
