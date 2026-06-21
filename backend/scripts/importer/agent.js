// F2-T1 — Extracción de entidad (persona) de un agente = BALDE 1, lógica pura.
//
// Hallazgo de recon: la persona del agente (role/identity/communication_style/
// principles/icon/menu) NO está en SKILL.md sino en `customize.toml` bajo [agent].
// El SKILL.md aporta name/title (frontmatter + h1) y el `## Overview` (persona_md).

const toml = require('./toml_min');

// Extrae el cuerpo de una sección `## <heading>` del markdown (case-insensitive).
const sectionBody = (body, heading) => {
  const re = new RegExp(`^##\\s+${heading}\\s*$`, 'im');
  const m = body.match(re);
  if (!m) return null;
  const start = m.index + m[0].length;
  const rest = body.slice(start);
  const next = rest.search(/^##\s+/m);
  return (next === -1 ? rest : rest.slice(0, next)).trim() || null;
};

// h1 del cuerpo (p. ej. "# John — Product Manager").
const h1Title = (body) => {
  const m = body.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : null;
};

// Construye la entidad desde frontmatter + body + customize.toml parseado.
const buildEntity = (frontmatter, body, customizeText) => {
  let agent = {};
  if (customizeText) {
    try {
      const t = toml.parse(customizeText);
      agent = t.agent || {};
    } catch (e) {
      throw new Error(`agent: customize.toml ilegible: ${e.message}`);
    }
  }
  const menu = Array.isArray(agent.menu)
    ? agent.menu.map((m) => ({
        code: m.code || null,
        description: m.description || null,
        skill: m.skill || null,
        prompt: m.prompt || null,
      }))
    : [];

  return {
    name: agent.name || frontmatter.name || null,
    title: agent.title || h1Title(body),
    icon: agent.icon || null,
    role: agent.role || null,
    identity: agent.identity || null,
    communication_style: agent.communication_style || null,
    principles: Array.isArray(agent.principles) ? agent.principles : [],
    persona_md: sectionBody(body, 'Overview'),
    menu,
  };
};

module.exports = { buildEntity, sectionBody, h1Title };
