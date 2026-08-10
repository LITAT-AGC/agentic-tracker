#!/usr/bin/env node

// Adapter generator: spec/apts-surface.json -> runtime-adapters/{claude,opencode}/
//
// Single source of truth for the AGENT SURFACE is runtime-adapters/spec/apts-surface.json
// (apts_skills.json remains the source of truth for the CONTRACT). This script translates the
// neutral spec into each runtime's native layout, resolving the per-runtime divergences
// (MCP registry, agents, commands, permissions, instructions, hooks).
//
// Los dos runtimes soportados son Claude Code y opencode. VS Code salió en 2026-08-08: era el
// único que no registraba el MCP con variables de entorno ni tenía comandos, así que su
// adaptador era medio adaptador —agentes y una instrucción, sin registro ni permisos— y su
// entrega iba por otra vía (cuatro plantillas .agent.md descargables, copiadas a mano a
// .github/agents). Al retirarlo, esa segunda vía desaparece con él: los dos runtimes que
// quedan materializan todo desde este generador.
//
// The runtime directories are treated as MANAGED output: they are wiped and rewritten
// wholesale on every run, never hand-edited. Edit the spec and regenerate.
//
// Acceptance: running this twice does not change the tree (idempotent). No timestamps or other
// nondeterministic content is emitted.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const adaptersRoot = path.join(scriptDir, '..', 'runtime-adapters');

// apts_skills.json is the source of truth for the CONTRACT: read it directly.
function operationNames() {
  const contractPath = path.join(scriptDir, '..', 'apts_skills.json');
  const parsed = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  if (!Array.isArray(parsed.skills) || !parsed.skills.length) {
    throw new Error('apts_skills.json has no skills[]');
  }
  return parsed.skills.map((skill) => skill.name);
}
const SPEC_PATH = path.join(adaptersRoot, 'spec', 'apts-surface.json');

const BANNER = 'GENERADO — no editar; fuente: spec/apts-surface.json';
const BANNER_MD = `<!-- ${BANNER} -->`;

// Neutral capability -> concrete tool identifiers per runtime.
const CLAUDE_TOOLS = { read: ['Read'], search: ['Glob', 'Grep'], edit: ['Edit', 'Write'], execute: ['Bash'], agent: ['Task'] };
const OPENCODE_TOOLS = { read: ['read'], search: ['grep', 'glob', 'list'], edit: ['edit', 'write'], execute: ['bash'], agent: ['task'] };

function loadSpec() {
  let spec;
  try {
    spec = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'));
  } catch (error) {
    fail(`Unable to read or parse spec at ${SPEC_PATH}: ${error.message}`);
  }
  validateSpec(spec);
  return spec;
}

function validateSpec(spec) {
  if (!spec || typeof spec !== 'object') fail('Spec must be an object');
  for (const key of ['mcp', 'instructions', 'agents', 'commands', 'permissions', 'hooks']) {
    if (!(key in spec)) fail(`Spec is missing required key "${key}"`);
  }
  const agentIds = new Set(spec.agents.map((a) => a.id));
  for (const agent of spec.agents) {
    for (const sub of agent.subagents || []) {
      if (!agentIds.has(sub)) fail(`Agent "${agent.id}" references unknown subagent "${sub}"`);
    }
  }
  for (const command of spec.commands) {
    if (command.agent && !agentIds.has(command.agent)) {
      fail(`Command "${command.id}" references unknown agent "${command.agent}"`);
    }
  }
}

function fail(message) {
  process.stderr.write(`generate-adapters: ${message}\n`);
  process.exit(1);
}

function mapTools(neutralTools, table) {
  const out = [];
  for (const tool of neutralTools) {
    for (const mapped of table[tool] || []) {
      if (!out.includes(mapped)) out.push(mapped);
    }
  }
  return out;
}

function agentById(spec, id) {
  return spec.agents.find((a) => a.id === id);
}

// The MCP surface is remote: a URL plus the identity headers. Each runtime has
// its own way of interpolating an environment variable, so the caller passes the
// pattern (e.g. '${%s}' for Claude Code, '{env:%s}' for opencode).
function mcpHeaders(spec, envRef) {
  const headers = {};
  for (const h of spec.mcp.headers) {
    const value = envRef(h.env);
    headers[h.name] = h.scheme ? `${h.scheme} ${value}` : value;
  }
  return headers;
}

// ---- serialization helpers -------------------------------------------------

// JSON with the banner as the first key (JSON has no comments).
function jsonText(payload) {
  return `${JSON.stringify({ _generated: BANNER, ...payload }, null, 2)}\n`;
}

function quoteYaml(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// Build a markdown file: optional YAML frontmatter, then the banner comment, then body.
function markdownText(frontmatterLines, bodyLines) {
  const parts = [];
  if (frontmatterLines && frontmatterLines.length) {
    parts.push('---', ...frontmatterLines, '---');
  }
  parts.push(BANNER_MD, '');
  parts.push(...bodyLines);
  return `${parts.join('\n').replace(/\n+$/, '')}\n`;
}

function writeFileTracked(written, absPath, content) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content);
  written.push(path.relative(adaptersRoot, absPath).split(path.sep).join('/'));
}

// ---- per-runtime emitters --------------------------------------------------

function emitClaude(spec, root, written) {
  // En Claude Code, `tools:` del frontmatter de un agente es lista blanca EXCLUSIVA, no un
  // añadido al conjunto por defecto: lo que no se nombra se filtra, y eso incluye las
  // herramientas MCP. Emitir la lista sin las `mcp__<server>__*` dejaba a los cuatro agentes
  // sin la única superficie que sus propias instrucciones les exigen usar —contradicción
  // dentro del mismo archivo generado, y ninguno podía ejecutar su misión.
  //
  // La lista `allow` de `.claude/settings.json` NO repone nada: es capa de permisos, otra
  // distinta, y ambas tienen que coincidir. Ver una herramienta en `allow` no significa que
  // el agente la tenga.
  //
  // Se enumeran en vez de omitir la clave: omitirla haría que cada agente heredase TODO el
  // tool set y perderíamos el límite por agente que el spec declara (p. ej. `apts-bugfix-intake`
  // es de solo lectura: sin `edit`). El prefijo sale de `spec.mcp.server`, el mismo nombre con
  // el que este generador escribe `.mcp.json`, así que no puede desincronizarse; los nombres de
  // operación salen del contrato. La superficie APTS entera va a los cuatro agentes, igual que
  // en `allow`: quién puede hacer qué lo fija el cuerpo del agente, no un recorte por archivo
  // que habría que mantener al día en cada cambio de contrato.
  const mcpTools = operationNames().map((op) => `mcp__${spec.mcp.server}__${op}`);

  // MCP registry
  writeFileTracked(written, path.join(root, '.mcp.json'), jsonText({
    mcpServers: {
      [spec.mcp.server]: {
        type: spec.mcp.type,
        url: `\${${spec.mcp.urlEnv}}`,
        headers: mcpHeaders(spec, (env) => `\${${env}}`),
      },
    },
  }));

  // Instructions: CLAUDE.md imports the canonical AGENTS.md and carries the managed section.
  writeFileTracked(written, path.join(root, 'CLAUDE.md'), markdownText(null, [
    `@${spec.instructions.canonicalFile}`,
    '',
    spec.instructions.markers.start,
    spec.instructions.body,
    spec.instructions.markers.end,
  ]));

  // Permissions -> .claude/settings.json
  const allow = [];
  for (const perm of spec.permissions) {
    if (perm.capability === 'execute') allow.push(`Bash(${perm.pattern})`);
    else if (perm.capability === 'mcp') {
      for (const tool of operationNames()) allow.push(`mcp__${perm.server}__${tool}`);
    }
  }
  writeFileTracked(written, path.join(root, '.claude', 'settings.json'), jsonText({
    permissions: { allow },
    hooks: hooksToClaude(spec.hooks),
  }));

  // Agents
  for (const agent of spec.agents) {
    const fm = [
      `name: ${quoteYaml(agent.name)}`,
      `description: ${quoteYaml(agent.description)}`,
      `tools: ${[...mapTools(agent.tools, CLAUDE_TOOLS), ...mcpTools].join(', ')}`,
    ];
    if (agent.userInvocable === false) fm.push('disable-model-invocation: false');
    writeFileTracked(written, path.join(root, '.claude', 'agents', `${agent.id}.md`),
      markdownText(fm, agentBody(agent)));
  }

  // Commands
  for (const command of spec.commands) {
    const fm = [`description: ${quoteYaml(command.description)}`];
    if (command.argumentHint) fm.push(`argument-hint: ${quoteYaml(command.argumentHint)}`);
    writeFileTracked(written, path.join(root, '.claude', 'commands', `${command.id}.md`),
      markdownText(fm, commandBody(spec, command)));
  }
}

function emitOpencode(spec, root, written) {
  // MCP registry + permissions in opencode.json
  const bash = {};
  for (const perm of spec.permissions) {
    if (perm.capability === 'execute') bash[perm.pattern] = perm.action;
  }
  bash['*'] = 'ask';
  writeFileTracked(written, path.join(root, 'opencode.json'), jsonText({
    $schema: 'https://opencode.ai/config.json',
    mcp: {
      [spec.mcp.server]: {
        type: 'remote',
        url: `{env:${spec.mcp.urlEnv}}`,
        enabled: true,
        headers: mcpHeaders(spec, (env) => `{env:${env}}`),
      },
    },
    permission: { edit: 'allow', bash },
  }));

  // Instructions: opencode reads AGENTS.md directly.
  writeFileTracked(written, path.join(root, 'AGENTS.md'), markdownText(null, [
    spec.instructions.markers.start,
    spec.instructions.body,
    spec.instructions.markers.end,
  ]));

  // Agents
  //
  // Aqui no hace falta el equivalente de las `mcp__*` de Claude: en opencode el mapa `tools:`
  // es aditivo —lo que no se nombra queda en su valor por defecto, que para las herramientas
  // MCP es habilitado—, asi que enumerar unas pocas no apaga el resto. La misma lista neutral
  // del spec significa «habilita estas» en un runtime y «solo estas» en el otro.
  for (const agent of spec.agents) {
    const fm = [
      `description: ${quoteYaml(agent.description)}`,
      `mode: ${agent.role === 'primary' ? 'primary' : 'subagent'}`,
      'tools:',
      ...mapTools(agent.tools, OPENCODE_TOOLS).map((tool) => `  ${tool}: true`),
    ];
    writeFileTracked(written, path.join(root, '.opencode', 'agent', `${agent.id}.md`),
      markdownText(fm, agentBody(agent)));
  }

  // Commands
  for (const command of spec.commands) {
    const fm = [`description: ${quoteYaml(command.description)}`];
    if (command.agent) fm.push(`agent: ${command.agent}`);
    writeFileTracked(written, path.join(root, '.opencode', 'command', `${command.id}.md`),
      markdownText(fm, commandBody(spec, command)));
  }
}

// ---- shared body builders --------------------------------------------------

function agentBody(agent) {
  return [agent.body];
}

function commandBody(spec, command) {
  const lines = [command.body];
  if (command.agent) {
    lines.push('', `_Runs via agent: ${agentById(spec, command.agent).name}._`);
  }
  return lines;
}

// opencode hooks live in .opencode/plugin/*.ts (WS opcional tardío); Claude hooks live in
// settings.json. Both are empty for now; kept as explicit no-ops so the shape is stable.
function hooksToClaude(hooks) {
  void hooks;
  return {};
}

// ---- main ------------------------------------------------------------------

function resetDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function main() {
  const spec = loadSpec();
  const targets = {
    claude: path.join(adaptersRoot, 'claude'),
    opencode: path.join(adaptersRoot, 'opencode'),
  };

  // Wipe managed output dirs (never spec/) so removals are idempotent.
  for (const dir of Object.values(targets)) resetDir(dir);

  const written = [];
  emitClaude(spec, targets.claude, written);
  emitOpencode(spec, targets.opencode, written);

  written.sort();
  process.stdout.write(`generate-adapters OK: ${written.length} files from ${spec.agents.length} agents, ${spec.commands.length} commands.\n`);
  for (const file of written) process.stdout.write(`  ${file}\n`);
}

main();
