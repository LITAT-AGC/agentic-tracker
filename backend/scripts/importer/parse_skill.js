// F2-T1 — Orquestador por-skill: archivos de una skill → IR JSON (lógica pura).
//
// Ensambla la IR aprobada (§ Diseño F2). No toca DB ni red; recibe los contenidos
// ya leídos (inyección) para mantenerse puro y testeable. La E/S vive en el entry
// script import-bmad.js.

const cls = require('./classify');
const { parseStructured } = require('./dialect_structured');
const { parseProse } = require('./dialect_prose');
const { buildEntity } = require('./agent');

// Refinamiento IR no-disruptivo (ver coverage-report / ledger):
//  - `checklists[]` hermano de `templates[]`: el esquema aprobado listó solo
//    templates[], pero balde 1 incluye checklists explícitamente y el corpus trae 6.
//  - structured: `workflow_critical[]` (constraints a nivel <workflow>).
//  - prose: `dropped_sections[]` (andamiaje descartado, para auditoría de cobertura).

const SOURCE_BASE = {
  repo: 'github.com/bmad-code-org/BMAD-METHOD',
  tag: 'v6.8.0',
  // tag anotado v6.8.0 → objeto c3769ab, deref al commit 3bcd6c3 (ambos = v6.8.0).
  tag_object_sha: 'c3769ab',
  commit_sha: '3bcd6c3',
};

// inputs: {
//   key, kind:'agent'|'workflow', relPath, skillPath,
//   skillMd, customizeToml?, templates:[{name,body_md}], checklists:[{name,body_md}],
//   route? (del CSV, primera fila) , routes? (todas)
// }
const parseSkill = (inputs) => {
  const { frontmatter, body } = cls.splitFrontmatter(inputs.skillMd);
  const dialect = cls.detectDialect(body);

  const phase =
    cls.normalizeCsvPhase(inputs.route && inputs.route.phase) || cls.phaseFromDir(inputs.relPath);

  const ir = {
    source: { ...SOURCE_BASE, path: inputs.relPath.replace(/\\/g, '/') },
    kind: inputs.kind,
    key: inputs.key,
    phase,
    frontmatter: {
      name: frontmatter.name || null,
      description: frontmatter.description || null,
    },
    dialect,
    entity: null,
    steps: [],
    routing: null,
    templates: inputs.templates || [],
    checklists: inputs.checklists || [],
    unresolved_refs: cls.extractUnresolvedRefs(inputs.skillMd),
  };

  // BALDE 1 — entidad (solo agentes).
  if (inputs.kind === 'agent') {
    ir.entity = buildEntity(frontmatter, body, inputs.customizeToml);
  }

  // BALDE 2 — steps generativos (ambos dialectos producen steps[]).
  if (dialect === 'structured') {
    const { workflow_critical, steps } = parseStructured(body);
    ir.workflow_critical = workflow_critical;
    ir.steps = steps;
  } else {
    const { steps, dropped_sections } = parseProse(body);
    ir.steps = steps;
    ir.dropped_sections = dropped_sections;
  }

  // BALDE 3 (parte CSV) — routing inter-fase declarativo.
  if (inputs.routes && inputs.routes.length) {
    // Une sobre todas las filas (acciones) de la skill.
    const merge = (sel) => [...new Set(inputs.routes.flatMap(sel))].filter(Boolean);
    ir.routing = {
      preceded_by: merge((r) => r.preceded_by),
      followed_by: merge((r) => r.followed_by),
      required: inputs.routes.some((r) => r.required),
      outputs: merge((r) => (r.outputs ? [r.outputs] : [])),
      output_location: merge((r) => (r.output_location ? [r.output_location] : [])),
      actions: inputs.routes.map((r) => ({
        action: r.action,
        phase: r.phase,
        preceded_by: r.preceded_by,
        followed_by: r.followed_by,
        required: r.required,
        outputs: r.outputs,
        output_location: r.output_location,
      })),
    };
  }

  return ir;
};

module.exports = { parseSkill, SOURCE_BASE };
