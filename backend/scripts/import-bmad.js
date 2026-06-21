#!/usr/bin/env node
// F2-T1 — Entry CLI del importador seed (BMAD v6.8.0 → IR + reporte).
//
// Responsabilidad: E/S y orquestación. La lógica de parseo vive en
// scripts/importer/ (puro). CERO escrituras a DB (eso es T2/T3): este script solo
// lee el clone temporal y escribe la IR committeable en backend/importer/.
//
// Uso:
//   node scripts/import-bmad.js                 # usa %TEMP%/bmad-recon
//   node scripts/import-bmad.js --corpus <dir>  # ruta de clone explícita
//   node scripts/import-bmad.js --clone         # clona v6.8.0 en %TEMP% si falta
//
// Scope v1 (decisión operador): lifecycle completo bmm (6 agentes + 23 workflows,
// saltando 3 DEPRECATED) + core-skills invocados (advanced-elicitation, help) = 31.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const cls = require('./importer/classify');
const { parseRoutingCsv } = require('./importer/routing_csv');
const { parseSkill, SOURCE_BASE } = require('./importer/parse_skill');

const REPO_URL = 'https://github.com/bmad-code-org/BMAD-METHOD';
const TAG = 'v6.8.0';
const CORE_IN_SCOPE = ['bmad-advanced-elicitation', 'bmad-help'];

const OUT_DIR = path.resolve(__dirname, '..', 'importer');
const CORPUS_OUT = path.join(OUT_DIR, 'corpus');

// ---- args ----
const argv = process.argv.slice(2);
const getArg = (name) => {
  const i = argv.indexOf(name);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : null;
};
const wantClone = argv.includes('--clone');
const tmp = process.env.TEMP || process.env.TMP || '/tmp';
const corpusDir = getArg('--corpus') || path.join(tmp, 'bmad-recon');

// ---- resolver corpus ----
const resolveCorpus = () => {
  if (fs.existsSync(path.join(corpusDir, 'src', 'bmm-skills'))) return corpusDir;
  if (wantClone) {
    console.log(`[clone] ${REPO_URL}@${TAG} → ${corpusDir}`);
    fs.rmSync(corpusDir, { recursive: true, force: true });
    execSync(`git clone --depth 1 --branch ${TAG} ${REPO_URL} "${corpusDir}"`, { stdio: 'inherit' });
    return corpusDir;
  }
  console.error(
    `ERROR: corpus no encontrado en ${corpusDir}\n` +
      `  Cloná: git clone --depth 1 --branch ${TAG} ${REPO_URL} "${corpusDir}"\n` +
      `  o pasá --clone, o --corpus <dir>.`
  );
  process.exit(1);
};

// ---- enumeración de skills in-scope ----
const findSkillDirs = (root) => {
  const dirs = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name === 'SKILL.md') dirs.push(dir);
    }
  };
  walk(root);
  return dirs;
};

// Recolecta templates/checklists de un dir de skill (recursivo).
const collectArtifacts = (skillDir) => {
  const templates = [];
  const checklists = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(full); continue; }
      if (ent.name === 'SKILL.md' || ent.name === 'customize.toml') continue;
      const rel = path.relative(skillDir, full).replace(/\\/g, '/');
      if (/template/i.test(ent.name)) templates.push({ name: rel, body_md: fs.readFileSync(full, 'utf8') });
      else if (/checklist/i.test(ent.name)) checklists.push({ name: rel, body_md: fs.readFileSync(full, 'utf8') });
    }
  };
  walk(skillDir);
  templates.sort((a, b) => a.name.localeCompare(b.name));
  checklists.sort((a, b) => a.name.localeCompare(b.name));
  return { templates, checklists };
};

// ---- main ----
const main = () => {
  const root = resolveCorpus();
  const srcBmm = path.join(root, 'src', 'bmm-skills');
  const srcCore = path.join(root, 'src', 'core-skills');

  // routing CSV
  const csvPath = path.join(srcBmm, 'module-help.csv');
  const routing = parseRoutingCsv(fs.readFileSync(csvPath, 'utf8'));

  // candidatos: todo bmm + los 2 core en scope
  const candidates = findSkillDirs(srcBmm);
  for (const c of CORE_IN_SCOPE) {
    const d = path.join(srcCore, c);
    if (fs.existsSync(path.join(d, 'SKILL.md'))) candidates.push(d);
  }
  candidates.sort();

  fs.rmSync(CORPUS_OUT, { recursive: true, force: true });
  fs.mkdirSync(CORPUS_OUT, { recursive: true });

  const results = [];
  const skipped = [];

  for (const skillDir of candidates) {
    const key = path.basename(skillDir);
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
    const { frontmatter, body } = cls.splitFrontmatter(skillMd);

    if (cls.isDeprecated(frontmatter, body)) {
      skipped.push({ key, reason: 'DEPRECATED', desc: frontmatter.description || '' });
      continue;
    }

    const tomlPath = path.join(skillDir, 'customize.toml');
    const customizeToml = fs.existsSync(tomlPath) ? fs.readFileSync(tomlPath, 'utf8') : null;
    const { templates, checklists } = collectArtifacts(skillDir);
    const relPath = path.relative(root, skillDir).replace(/\\/g, '/');
    const kind = /^bmad-agent-/.test(key) ? 'agent' : 'workflow';
    const routes = routing.bySkill.get(key) || [];

    const ir = parseSkill({
      key, kind, relPath, skillPath: skillDir,
      skillMd, customizeToml, templates, checklists,
      route: routes[0] || null, routes,
    });

    fs.writeFileSync(path.join(CORPUS_OUT, `${key}.json`), JSON.stringify(ir, null, 2) + '\n', 'utf8');
    results.push(ir);
  }

  writeReport({ results, skipped, routing, candidates });
  writeNotice(root);

  console.log(`\n✅ F2-T1: ${results.length} skills → IR en ${path.relative(process.cwd(), CORPUS_OUT)}`);
  console.log(`   ${skipped.length} skipped (DEPRECATED): ${skipped.map((s) => s.key).join(', ')}`);
  console.log(`   reporte: ${path.relative(process.cwd(), path.join(OUT_DIR, 'coverage-report.md'))}`);
};

// ---- reporte de cobertura ----
const writeReport = ({ results, skipped, routing }) => {
  const agents = results.filter((r) => r.kind === 'agent');
  const workflows = results.filter((r) => r.kind === 'workflow');
  const structured = results.filter((r) => r.dialect === 'structured');
  const prose = results.filter((r) => r.dialect === 'prose');

  const byPhase = {};
  for (const r of results) byPhase[r.phase] = (byPhase[r.phase] || 0) + 1;

  const totalSteps = results.reduce((a, r) => a + r.steps.length, 0);
  const totalChecks = results.reduce((a, r) => a + r.steps.reduce((b, s) => b + s.checks.length, 0), 0);
  const totalAsks = results.reduce((a, r) => a + r.steps.reduce((b, s) => b + s.generative.asks.length, 0), 0);
  const totalTmplOut = results.reduce(
    (a, r) => a + r.steps.reduce((b, s) => b + s.generative.template_outputs.length, 0), 0);
  const totalTemplates = results.reduce((a, r) => a + r.templates.length, 0);
  const totalChecklists = results.reduce((a, r) => a + r.checklists.length, 0);

  // cobertura balde 1-2 (automática)
  const agentsWithEntity = agents.filter((r) => r.entity && r.entity.name).length;
  const wfWithSteps = workflows.filter((r) => r.steps.length > 0).length;
  const withRouting = results.filter((r) => r.routing).length;
  const noRouting = results.filter((r) => !r.routing).map((r) => r.key);

  // catálogo balde 3 (condiciones distintas de los <check>)
  const checkConditions = [];
  for (const r of structured) {
    for (const s of r.steps) {
      for (const c of s.checks) {
        if (c.condition_text) checkConditions.push({ skill: r.key, step: s.n, condition: c.condition_text });
      }
    }
  }

  const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);

  let md = '';
  md += `# F2 — Reporte de cobertura del importador (T1)\n\n`;
  md += `> Generado por \`backend/scripts/import-bmad.js\`. Fuente: ${SOURCE_BASE.repo} @ ${SOURCE_BASE.tag}\n`;
  md += `> (tag anotado \`${SOURCE_BASE.tag_object_sha}\` → commit \`${SOURCE_BASE.commit_sha}\`). **Cero escrituras a DB** (T1).\n\n`;

  md += `## Resumen\n\n`;
  md += `| Métrica | Valor |\n|---|---|\n`;
  md += `| Skills parseadas → IR | **${results.length}** (${agents.length} agentes, ${workflows.length} workflows) |\n`;
  md += `| Saltadas (DEPRECATED) | ${skipped.length} (${skipped.map((s) => s.key).join(', ') || '—'}) |\n`;
  md += `| Dialecto | ${structured.length} structured, ${prose.length} prose |\n`;
  md += `| Steps generativos (balde 2) | ${totalSteps} |\n`;
  md += `| \`<ask>\` (elicitación) | ${totalAsks} |\n`;
  md += `| \`<template-output>\` | ${totalTmplOut} |\n`;
  md += `| Templates (balde 1) | ${totalTemplates} |\n`;
  md += `| Checklists (balde 1) | ${totalChecklists} |\n`;
  md += `| \`<check>\` candidatas (balde 3) | ${totalChecks} |\n\n`;

  md += `### Por fase\n\n| Fase | Skills |\n|---|---|\n`;
  for (const p of Object.keys(byPhase).sort()) md += `| ${p} | ${byPhase[p]} |\n`;
  md += `\n`;

  md += `## Cobertura automática baldes 1–2\n\n`;
  md += `- **Entidades (balde 1):** ${agentsWithEntity}/${agents.length} agentes con persona extraída = **${pct(agentsWithEntity, agents.length)}%**.\n`;
  md += `- **Steps generativos (balde 2):** ${wfWithSteps}/${workflows.length} workflows con ≥1 step = **${pct(wfWithSteps, workflows.length)}%**.\n`;
  md += `- **Routing (CSV):** ${withRouting}/${results.length} skills con fila en \`module-help.csv\`.\n`;
  if (noRouting.length) md += `  - Sin fila de routing: ${noRouting.join(', ')}.\n`;
  md += `\n`;

  md += `## Catálogo balde 3 (NO auto-compilado — triage T3)\n\n`;
  md += `Los \`<check if>\` son lenguaje natural (decisión F2): se extraen como candidatas, no se compilan.\n`;
  md += `Total: **${totalChecks}** \`<check>\` en ${structured.length} skills estructuradas`;
  md += ` (${checkConditions.length} con condición textual; ${totalChecks - checkConditions.length} sin atributo \`if\`).\n`;
  md += `El routing inter-fase determinista sale de \`module-help.csv\` (ver IR \`.routing\`).\n`;
  md += `La **lista de primitivas faltantes** a implementar en backend se decide en **T3** a partir de este catálogo.\n\n`;
  md += `<details><summary>Condiciones \`&lt;check&gt;\` por skill (${checkConditions.length})</summary>\n\n`;
  let lastSkill = null;
  for (const c of checkConditions) {
    if (c.skill !== lastSkill) { md += `\n**${c.skill}**\n\n`; lastSkill = c.skill; }
    md += `- (step ${c.step}) \`${c.condition.replace(/`/g, "'")}\`\n`;
  }
  md += `\n</details>\n\n`;

  md += `## Por skill\n\n`;
  md += `| Skill | kind | dialecto | fase | steps | checks | asks | tmpl-out | templates | checklists | refs |\n`;
  md += `|---|---|---|---|--:|--:|--:|--:|--:|--:|--:|\n`;
  for (const r of results) {
    const checks = r.steps.reduce((b, s) => b + s.checks.length, 0);
    const asks = r.steps.reduce((b, s) => b + s.generative.asks.length, 0);
    const to = r.steps.reduce((b, s) => b + s.generative.template_outputs.length, 0);
    md += `| ${r.key} | ${r.kind} | ${r.dialect} | ${r.phase} | ${r.steps.length} | ${checks} | ${asks} | ${to} | ${r.templates.length} | ${r.checklists.length} | ${r.unresolved_refs.length} |\n`;
  }
  md += `\n`;

  if (routing.malformed.length) {
    md += `## CSV: filas ragged (balde 3, robustez)\n\n`;
    for (const m of routing.malformed) md += `- línea ${m.line} (\`${m.skill}\`): ${m.got} cols (esperaba ${m.expected})\n`;
    md += `\n`;
  }

  md += `## Notas de implementación (refinamientos IR no-disruptivos)\n\n`;
  md += `- \`checklists[]\` agregado como hermano de \`templates[]\`: el esquema aprobado listó solo\n`;
  md += `  \`templates[]\`, pero balde 1 incluye checklists explícitamente y el corpus trae ${totalChecklists}.\n`;
  md += `- structured: \`workflow_critical[]\` (constraints \`<critical>\` a nivel \`<workflow>\`).\n`;
  md += `- prose: \`dropped_sections[]\` (secciones-andamiaje descartadas: On Activation/Conventions/Paths).\n`;
  md += `- Censo corregido: bmm tiene **32 SKILL.md** (6 agentes + 26 workflows), no 38. El "44/38" del\n`;
  md += `  diseño contaba bmm+core juntos (32+12). Scope intent ("lifecycle completo bmm" + 2 core) intacto.\n`;
  md += `- \`source.sha\`: el tag anotado \`v6.8.0\` es objeto \`c3769ab\`; deref al commit \`3bcd6c3\`. Mismo \`v6.8.0\`.\n`;

  fs.writeFileSync(path.join(OUT_DIR, 'coverage-report.md'), md, 'utf8');
};

// ---- NOTICE de atribución (la IR committeada porta ADN MIT verbatim) ----
const writeNotice = (root) => {
  let license = '';
  const lpath = path.join(root, 'LICENSE');
  try { license = fs.readFileSync(lpath, 'utf8'); } catch (e) { license = '(LICENSE no encontrado en el clone)'; }
  const notice =
`# NOTICE — Atribución del corpus importado

Este directorio (\`backend/importer/corpus/\`) contiene una Representación Intermedia
(IR) derivada del método **BMAD** ("BMad Method"), importado UNA VEZ como semilla.

- Fuente: ${REPO_URL} @ tag \`${TAG}\`
  (tag anotado \`${SOURCE_BASE.tag_object_sha}\` → commit \`${SOURCE_BASE.commit_sha}\`).
- Licencia original: MIT (BMad Code, LLC, 2025). Ver el texto completo abajo.
- La IR reproduce verbatim el ADN generativo (personas, principios, instrucciones,
  templates, checklists) del corpus original; el andamiaje determinista se cataloga
  para reimplementación en el servidor APTS.

Decisiones de IP (cerradas en el ledger del proyecto):
- BMAD es **semilla, no spec**: ingesta one-shot de v6.8.0, sin re-sync.
- APTS **no usa la marca "BMAD"/"BMad"** como identidad de producto.
- Esta atribución (NOTICE) acompaña al corpus importado por requisito de la licencia MIT.

---

## LICENSE original (BMAD-METHOD @ ${TAG})

${license}
`;
  fs.writeFileSync(path.join(OUT_DIR, 'NOTICE'), notice, 'utf8');
};

main();
