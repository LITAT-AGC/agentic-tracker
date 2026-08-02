// Contract self-check: apts_skills.json is the single source of truth.
//
// This module loads the contract and verifies that the MCP tool list exposes
// exactly the contract operations. Both surfaces that build a tool list from it
// run the check at startup, so a drift between contract and tools aborts with a
// non-zero exit code.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
// apts_skills.json sigue siendo la fuente del contrato y vive en el paquete
// público, que es lo que se descarga. Este módulo es código del backend.
const CONTRACT_PATH = path.join(moduleDir, '..', '..', '..', 'integracion', 'paquete-apts', 'apts_skills.json');

export class ContractMismatchError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'ContractMismatchError';
    this.code = 'CONTRACT_MISMATCH';
    this.exitCode = 3;
    this.details = details;
  }
}

export function snakeToCamel(name) {
  return String(name).replace(/_([a-z0-9])/g, (_, char) => char.toUpperCase());
}

export function loadContract() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
  } catch (error) {
    throw new ContractMismatchError(`Unable to read or parse contract at ${CONTRACT_PATH}: ${error.message}`);
  }

  if (!parsed || !Array.isArray(parsed.skills) || !parsed.skills.length) {
    throw new ContractMismatchError(`Contract at ${CONTRACT_PATH} has no "skills" array`);
  }

  for (const skill of parsed.skills) {
    if (!skill || typeof skill.name !== 'string' || !skill.name) {
      throw new ContractMismatchError('Every contract skill must have a non-empty "name"');
    }
  }

  return parsed;
}

// Returns one descriptor per contract operation, with derived runtime metadata.
export function contractOperations() {
  return loadContract().skills.map((skill) => {
    const parameters = skill.parameters || { type: 'object', properties: {}, required: [] };
    const supportsBatch = Array.isArray(parameters.oneOf)
      && parameters.oneOf.some((branch) => branch && branch.type === 'array');

    // For oneOf (object|array) schemas, treat the object branch as the canonical
    // single-item schema; otherwise the schema itself is the object schema.
    const objectSchema = Array.isArray(parameters.oneOf)
      ? parameters.oneOf.find((branch) => branch && branch.type === 'object') || {}
      : parameters;

    return {
      name: skill.name,
      description: skill.description || '',
      parameters,
      objectSchema,
      requiredFields: Array.isArray(objectSchema.required) ? objectSchema.required : [],
      clientExport: snakeToCamel(skill.name),
      supportsBatch,
    };
  });
}

export function operationNames() {
  return loadContract().skills.map((skill) => skill.name);
}

function diffSets(expected, actual) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = [...expectedSet].filter((value) => !actualSet.has(value));
  const extra = [...actualSet].filter((value) => !expectedSet.has(value));
  return { missing, extra };
}

// Verifies the MCP tool list exposes exactly one tool per contract operation.
export function checkMcpContract(toolNames) {
  const expected = operationNames();
  const { missing, extra } = diffSets(expected, toolNames);
  if (missing.length || extra.length) {
    throw new ContractMismatchError(
      'MCP tool list is out of sync with apts_skills.json',
      { surface: 'mcp', missing_tools: missing, unexpected_tools: extra }
    );
  }
}

// Ejecutado directamente, comprueba lo único que se puede comprobar sin un
// runtime vivo: que el contrato carga y de cuántas operaciones se deriva. Antes
// importaba `apts-client.js` para contrastar sus exportaciones; ese cliente se
// retiró con la superficie por entrada/salida estándar, así que esta rama llevaba
// tiempo fallando con `Cannot find module`. Las dos comprobaciones que sí valen
// —el ejecutor en proceso y la tabla de identidad— exigen el proceso del servidor
// y corren en su arranque.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const ops = operationNames();
    process.stdout.write(`contract-check OK: ${ops.length} operaciones en apts_skills.json\n`);
    process.stdout.write(`operations: ${ops.join(', ')}\n`);
  } catch (error) {
    process.stderr.write(`${error.name}: ${error.message}\n`);
    if (error.details) process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
    process.exit(error.exitCode || 1);
  }
}
