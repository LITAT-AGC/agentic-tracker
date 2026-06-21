// F2-T4 — Re-cableado de referencias BMAD → APTS (lógica pura, declarativa).
//
// Decisión (ledger): el ADN generativo se importa VERBATIM; solo se re-cablea el
// andamiaje. Por eso el re-cableado NO muta los instruction_chunk almacenados:
// es un MAPA declarativo (editable-by-design) que el driver de goteo (F3) aplica
// en serve-time. Acá vive el mapa + el clasificador + el aplicador, y el entry
// (scripts/rewire-bmad.js) emite rewire-map.json + cobertura.
//
// Clases de re-cableado:
//   server_resolved  — andamiaje de activación/customización/config de BMAD que
//                      APTS resuelve en el servidor → se ELIMINA del prompt servido.
//   persona_field    — {agent.*} → campos de la entity (ya en tabla `entities`).
//   config           — locale/usuario/fecha → config de proyecto/sesión APTS.
//   artifact_location— rutas de artefactos de archivo → store de artefactos APTS (sin FS).
//   artifact_content — {*_content}/contexto → recuperación de artefactos (semántica).
//   template         — {*_template} → templates de la IR (workflow_steps.template_slice).
//   state            — estado runtime/punteros → estado servidor-autoritativo (DB).
//
// Cada clase trae `apts`: el token de reemplazo que sirve el goteo (o '' si se elimina).

const REWIRE_RULES = [
  // --- server_resolved: andamiaje BMAD que desaparece bajo APTS ---
  { class: 'server_resolved', apts: '', note: 'script de resolución de customización BMAD; APTS resuelve la entity/workflow en servidor',
    test: /_bmad\/scripts\/.*\.py$|resolve_custom|resolve_config/ },
  { class: 'server_resolved', apts: '', note: 'config.yaml / custom toml / _config de BMAD; APTS guarda config en DB',
    test: /_bmad\/(bmm\/config\.yaml|custom\/|_config\/)/ },
  { class: 'server_resolved', apts: '', note: 'raíz de skill/proyecto BMAD; sin equivalente (APTS no instala skills en FS)',
    test: /^\{(project-root|skill-root|skill-name)\}$/ },
  { class: 'server_resolved', apts: '', note: 'pasos de activación / persistent_facts / hooks de finalize; el goteo APTS no los necesita',
    test: /^\{(workflow|agent)\.(activation_steps_(pre|ap)pend|persistent_facts|on_complete|external_\w+|doc_standards|finalize_reviewers)\}$/ },

  // --- persona_field: {agent.*} → campos de la entity ---
  { class: 'persona_field', apts: '{apts:entity.$1}', note: 'campo de persona; servido desde la tabla entities',
    test: /^\{agent\.(role|identity|communication_style|principles|icon|menu)\}$/, cap: 1 },

  // --- config: locale / usuario / fecha ---
  { class: 'config', apts: '{apts:config.$1}', note: 'valor de config de proyecto/sesión APTS',
    test: /^\{(communication_language|document_output_language|user_name|project_name|user_skill_level|date|project_knowledge)\}$/, cap: 1 },

  // --- template: {*_template} ---
  { class: 'template', apts: '{apts:template}', note: 'template del artefacto; servido desde workflow_steps.template_slice / IR.templates',
    test: /template(\}|_)|_template\}$/ },

  // --- artifact_content: {*_content} / contexto ---
  { class: 'artifact_content', apts: '{apts:artifact_content}', note: 'contenido de artefacto previo; recuperación semántica APTS por doc_type',
    test: /_content\}$|^\{(project_context|agent_roster|document_project_content)\}$/ },

  // --- artifact_location: rutas de salida/ubicación de artefactos ---
  { class: 'artifact_location', apts: '{apts:artifacts}', note: 'ubicación de artefactos de archivo BMAD; APTS usa su store de artefactos (sin FS)',
    test: /artifacts\}$|_output_path\}$|location\}$|output_folder\}$|doc_workspace\}$|_subdir\}$|run_folder_pattern\}$/ },

  // --- state: punteros / estado runtime (incluye file-model que pasa a DB) ---
  { class: 'state', apts: '{apts:state}', note: 'estado runtime / puntero / file-model BMAD; servidor-autoritativo en APTS (DB)',
    test: /sprint_status|status_file|story[_-]?(key|path|location)|current_|\{epic\}|\{num\}|case_file|epics_(pattern|location)|default_output_file|project_key|^\{(slug|concept_type|file|YYYY-MM-DD|story|title)\}$/ },

  // --- catch-all: cualquier {workflow.*}/{agent.*} restante = superficie de customización BMAD ---
  { class: 'server_resolved', apts: '', note: 'superficie de customización BMAD ({workflow.*}/{agent.*}); resuelta en servidor APTS',
    test: /^\{(workflow|agent)\.[\w-]+\}$/ },
  // tracking_system: BMAD delega el tracking a un sistema externo; en APTS el tracking ES el servidor.
  { class: 'server_resolved', apts: '', note: 'sistema de tracking externo de BMAD; APTS es el motor de método servidor-autoritativo',
    test: /^\{(tracking_system|path\.to\.token)\}$/ },
];

// Clasifica una ref → { class, apts, note } o null si ninguna regla la cubre.
const classifyRef = (ref) => {
  for (const r of REWIRE_RULES) {
    const m = ref.match(r.test);
    if (m) {
      let apts = r.apts;
      if (r.cap && apts.includes('$' + r.cap)) apts = apts.replace('$' + r.cap, m[r.cap]);
      return { class: r.class, apts, note: r.note };
    }
  }
  return null;
};

// Aplica el re-cableado a un texto (lo que hace el goteo F3 en serve-time).
// Reemplaza refs de una sola llave; deja {{vars}} de runtime intactas.
const applyRewire = (text) => {
  if (!text) return text;
  return text.replace(/(?<!\{)\{[a-zA-Z0-9_\-.\/]+\}(?!\})/g, (ref) => {
    const c = classifyRef(ref);
    if (!c) return ref; // sin regla → se deja como está (worklist residual)
    return c.apts; // '' elimina el andamiaje; {apts:...} marca el origen servido
  });
};

module.exports = { REWIRE_RULES, classifyRef, applyRewire };
