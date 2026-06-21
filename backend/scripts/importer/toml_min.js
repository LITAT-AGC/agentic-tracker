// F2-T1 — Parser TOML mínimo (subconjunto), lógica pura.
//
// NO es un parser TOML general. Cubre exactamente el subconjunto que usan los
// `customize.toml` de BMAD v6.8.0 (verificado contra los 6 agentes + workflows):
//   - comentarios `# ...` (línea completa; no inline dentro de strings)
//   - tablas        `[agent]`, `[workflow]`
//   - arrays-de-tabla `[[agent.menu]]` (se acumulan en un array)
//   - escalares     key = "..." | 'literal' | true/false | número
//   - arrays        key = [] o multilínea key = [\n "a",\n "b",\n ]
//
// Decisión (ledger): no se agrega dependencia de TOML (igual criterio que F1-T5
// con el tokenizer). El importador es one-shot y la entrada es acotada y estable.
// Si un customize.toml futuro excede este subconjunto, el parser DEBE fallar
// ruidosamente (throw) en vez de adivinar — es preferible detenerse a corromper la IR.

// Quita un comentario de fin de línea SOLO si está fuera de comillas.
const stripComment = (line) => {
  let inS = false; // single-quote
  let inD = false; // double-quote
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === '#' && !inS && !inD) return line.slice(0, i);
  }
  return line;
};

// Parsea un valor escalar TOML simple.
const parseScalar = (raw) => {
  const v = raw.trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d*\.\d+$/.test(v)) return parseFloat(v);
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\');
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) {
    return v.slice(1, -1); // literal string: sin escapes
  }
  throw new Error(`toml_min: escalar no soportado: ${JSON.stringify(raw)}`);
};

// Divide el cuerpo de un array TOML en elementos top-level (respeta comillas).
// No soporta arrays anidados (no aparecen en el corpus).
const splitArrayItems = (body) => {
  const items = [];
  let cur = '';
  let inS = false;
  let inD = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    if (c === ',' && !inS && !inD) {
      if (cur.trim()) items.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  if (cur.trim()) items.push(cur.trim());
  return items;
};

// Asigna `value` en `obj` siguiendo la ruta de tabla actual (p. ej. ['agent']).
const assign = (root, tablePath, key, value) => {
  let node = root;
  for (const seg of tablePath) {
    if (!(seg in node) || typeof node[seg] !== 'object' || Array.isArray(node[seg])) node[seg] = {};
    node = node[seg];
  }
  node[key] = value;
};

// Asegura el contenedor de un array-de-tabla y empuja un objeto vacío, devolviéndolo.
const pushArrayTable = (root, dottedPath) => {
  const segs = dottedPath.split('.');
  let node = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    if (!(seg in node) || typeof node[seg] !== 'object') node[seg] = {};
    node = node[seg];
  }
  const last = segs[segs.length - 1];
  if (!Array.isArray(node[last])) node[last] = [];
  const entry = {};
  node[last].push(entry);
  return entry;
};

// Parsea TOML (subconjunto) → objeto plano. `target` es opcional: si se da un
// objeto destino actual (p. ej. una entrada de array-de-tabla), las claves caen ahí.
const parse = (text) => {
  const root = {};
  let tablePath = [];          // tabla normal activa (p. ej. ['agent'])
  let arrayTableTarget = null; // entrada de array-de-tabla activa
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    let line = stripComment(lines[i]);
    if (!line.trim()) continue;

    const trimmed = line.trim();

    // [[a.b]] array-de-tabla
    let m = trimmed.match(/^\[\[([^\]]+)\]\]$/);
    if (m) {
      arrayTableTarget = pushArrayTable(root, m[1].trim());
      tablePath = [];
      continue;
    }
    // [a.b] tabla normal
    m = trimmed.match(/^\[([^\]]+)\]$/);
    if (m) {
      tablePath = m[1].trim().split('.').map((s) => s.trim());
      arrayTableTarget = null;
      continue;
    }

    // key = ...
    const eq = trimmed.indexOf('=');
    if (eq === -1) throw new Error(`toml_min: línea no reconocida: ${JSON.stringify(lines[i])}`);
    const key = trimmed.slice(0, eq).trim();
    let rhs = trimmed.slice(eq + 1).trim();

    let value;
    if (rhs.startsWith('[')) {
      // array (posiblemente multilínea)
      let buf = rhs;
      while (!/\]\s*$/.test(stripComment(buf)) && i < lines.length - 1) {
        i++;
        buf += '\n' + stripComment(lines[i]);
      }
      const inner = buf.slice(buf.indexOf('[') + 1, buf.lastIndexOf(']'));
      value = splitArrayItems(inner).map(parseScalar);
    } else {
      value = parseScalar(rhs);
    }

    if (arrayTableTarget) arrayTableTarget[key] = value;
    else assign(root, tablePath, key, value);
  }

  return root;
};

module.exports = { parse, parseScalar, splitArrayItems, stripComment };
