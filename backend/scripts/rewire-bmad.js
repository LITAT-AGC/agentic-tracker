#!/usr/bin/env node
// F2-T4 — Entry: re-cableado BMAD→APTS. Emite rewire-map.json + cobertura.
//
// El mapa es DATA editable-by-design; el goteo (F3) lo aplica en serve-time
// (applyRewire). NO muta los instruction_chunk almacenados (ADN verbatim, ledger).
//
// Uso:  cd backend && node scripts/rewire-bmad.js

const fs = require('fs');
const path = require('path');
const { classifyRef } = require('./importer/rewire');

const CORPUS_DIR = path.resolve(__dirname, '..', 'importer', 'corpus');
const MAP_OUT = path.resolve(__dirname, '..', 'importer', 'rewire-map.json');

const main = () => {
  // refs distintas + frecuencia
  const freq = {};
  for (const f of fs.readdirSync(CORPUS_DIR).filter((x) => x.endsWith('.json'))) {
    const ir = JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, f), 'utf8'));
    for (const r of ir.unresolved_refs) freq[r] = (freq[r] || 0) + 1;
  }
  const refs = Object.keys(freq).sort();

  const map = {};
  const byClass = {};
  const uncovered = [];
  for (const ref of refs) {
    const c = classifyRef(ref);
    if (!c) { uncovered.push(ref); continue; }
    map[ref] = { class: c.class, apts: c.apts, note: c.note, count: freq[ref] };
    byClass[c.class] = (byClass[c.class] || 0) + 1;
  }

  const out = {
    source: 'bmad:v6.8.0',
    generated_by: 'backend/scripts/rewire-bmad.js',
    note: 'Mapa declarativo BMAD→APTS. Aplicado en serve-time por el goteo (F3). El ADN almacenado queda verbatim.',
    distinct_refs: refs.length,
    by_class: byClass,
    uncovered,
    map,
  };
  fs.writeFileSync(MAP_OUT, JSON.stringify(out, null, 2) + '\n', 'utf8');

  console.log(`✅ F2-T4: rewire-map → ${path.relative(process.cwd(), MAP_OUT)}`);
  console.log(`   ${refs.length} refs distintas | por clase: ${JSON.stringify(byClass)}`);
  if (uncovered.length) {
    console.error(`   ⚠️ SIN CLASIFICAR (${uncovered.length}): ${uncovered.join(', ')}`);
    process.exit(2);
  }
  console.log(`   cobertura: 100% (todas las refs clasificadas)`);
};

main();
