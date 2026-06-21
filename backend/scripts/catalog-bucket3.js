#!/usr/bin/env node
// F2-T3 — Entry: cataloga el balde 3 (routing/gates) → bucket3-catalog.md.
//
// NO escribe DB y NO compila reglas (regla del ledger: balde 3 se extrae y
// cataloga para triage backend, nunca auto-compila). El routing inter-fase
// declarativo (CSV) ya quedó en workflow_definitions.metadata.routing (T2).
// Este script produce el documento de triage + la LISTA de primitivas a
// implementar en F3-T1.
//
// Uso:  cd backend && node scripts/catalog-bucket3.js

const fs = require('fs');
const path = require('path');
const { analyzeBucket3 } = require('./importer/bucket3');

const CORPUS_DIR = path.resolve(__dirname, '..', 'importer', 'corpus');
const OUT = path.resolve(__dirname, '..', 'importer', 'bucket3-catalog.md');

const loadCorpus = () =>
  fs.readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, f), 'utf8')));

const CAT_LABEL = {
  runtime: 'runtime — rama conversacional / input de usuario / elicitación → estado **await-input** del goteo (F3). NO es primitiva.',
  file_model: 'file_model — chequeo del modelo-de-archivos de BMAD → bajo APTS el estado vive en DB: **MOOT** o mapea a `artifact-exists`. Sin primitiva nueva.',
  maps_existing: 'maps_existing — gate determinista que mapea a una **primitiva ya implementada** (`artifact-exists`/`count-threshold`/`all-children-status`).',
  needs_new: 'needs_new — gate determinista de servidor SIN equivalente → **candidato a primitiva NUEVA** (ver propuesta).',
};

const main = () => {
  const corpus = loadCorpus();
  const a = analyzeBucket3(corpus);
  const n = (c) => a.byCat[c].length;
  const pct = (x) => (a.totalConditions ? Math.round((x / a.totalConditions) * 1000) / 10 : 0);

  let md = '';
  md += `# F2-T3 — Catálogo del balde 3 (routing/gates deterministas)\n\n`;
  md += `> Generado por \`backend/scripts/catalog-bucket3.js\` desde la IR (\`importer/corpus/\`).\n`;
  md += `> **El balde 3 NO se auto-compila** (ledger §9): esto es triage léxico para confirmación\n`;
  md += `> humana + la lista de primitivas a implementar en **F3-T1**. La clasificación es ayuda, no autoridad.\n\n`;

  md += `## Resumen\n\n`;
  md += `Total de condiciones \`<check>\` (6 skills estructuradas): **${a.totalConditions}**.\n\n`;
  md += `| Categoría | Conteo | % | Significado |\n|---|--:|--:|---|\n`;
  for (const c of ['needs_new', 'maps_existing', 'file_model', 'runtime']) {
    md += `| \`${c}\` | ${n(c)} | ${pct(n(c))}% | ${CAT_LABEL[c].split('—')[1].trim()} |\n`;
  }
  md += `\n`;
  md += `**Lectura:** la mayoría de los \`<check>\` de BMAD son **runtime** (elicitación/elección de\n`;
  md += `usuario) o **file_model** (chequeos sobre \`sprint-status.yaml\`/story files que desaparecen\n`;
  md += `cuando el estado es servidor-autoritativo en APTS). El determinismo de servidor real se\n`;
  md += `concentra en \`maps_existing\` + \`needs_new\`, y el **routing inter-fase ya es dato** (CSV).\n\n`;

  md += `## Routing inter-fase declarativo (de \`module-help.csv\`, NO de \`<check>\`)\n\n`;
  md += `Ya cargado en \`workflow_definitions.metadata.routing\` (T2). Es el DAG que \`apts_next\` recorre.\n\n`;
  md += `| Skill | fase | required | preceded_by | followed_by |\n|---|---|:--:|---|---|\n`;
  for (const r of a.routing) {
    md += `| ${r.skill} | ${r.phase} | ${r.required ? '✓' : ''} | ${(r.preceded_by || []).join(', ') || '—'} | ${(r.followed_by || []).join(', ') || '—'} |\n`;
  }
  md += `\n`;

  md += `## Primitivas existentes (F1, implementadas)\n\n`;
  for (const p of a.existingPrimitives) md += `- \`${p}\`\n`;
  md += `\n`;

  md += `## ⭐ Primitivas NUEVAS requeridas (a implementar en F3-T1)\n\n`;
  md += `Propuesta de ingeniería derivada del bucket \`needs_new\` (${n('needs_new')} condiciones).\n`;
  md += `Cada una se **confirma a mano** contra las condiciones reales antes de implementar.\n\n`;
  for (const p of a.proposedPrimitives) {
    md += `### \`${p.key}\` — ${p.name} (${p.category})\n\n`;
    md += `${p.description}\n\n`;
    md += `\`params_schema\`: \`${JSON.stringify(p.params_schema)}\`\n\n`;
  }

  md += `## Condiciones por categoría (worklist de triage)\n\n`;
  for (const cat of ['needs_new', 'maps_existing', 'file_model', 'runtime']) {
    md += `### \`${cat}\` (${n(cat)})\n\n`;
    md += `${CAT_LABEL[cat]}\n\n`;
    let last = null;
    for (const c of a.byCat[cat]) {
      if (c.skill !== last) { md += `\n**${c.skill}**\n\n`; last = c.skill; }
      md += `- (step ${c.step}) \`${(c.condition || '∅ sin condición').replace(/`/g, "'")}\`\n`;
    }
    md += `\n`;
  }

  fs.writeFileSync(OUT, md, 'utf8');
  console.log(`✅ F2-T3: catálogo balde 3 → ${path.relative(process.cwd(), OUT)}`);
  console.log(`   ${a.totalConditions} condiciones: needs_new=${n('needs_new')} maps_existing=${n('maps_existing')} file_model=${n('file_model')} runtime=${n('runtime')}`);
  console.log(`   primitivas nuevas propuestas: ${a.proposedPrimitives.map((p) => p.key).join(', ')}`);
};

main();
