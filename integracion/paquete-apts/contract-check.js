// Contract self-check: apts_skills.json is the single source of truth.
//
// This module loads the contract and verifies that the HTTP client, the CLI
// command table, and the MCP tool list expose exactly the contract operations.
// The CLI and the MCP server call the strict checks at startup so a drift
// between client <-> contract <-> CLI <-> MCP aborts with a non-zero exit code.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_PATH = path.join(moduleDir, 'apts_skills.json');

// Client exports that are deliberately not contract operations (identity and
// managed-context utilities, plus the error class).
const CLIENT_UTILITY_EXPORTS = new Set([
  'AptsClientError',
  'clearStoredExecutionContext',
  'getExecutionContext',
  'getLoadedEnvFiles',
  'resolveExecutionIdentity',
  'resolveGitIdentity',
  'setExecutionContext',
]);

// CLI commands that are deliberately not contract operations (local context
// management and identity inspection).
export const CLI_UTILITY_COMMANDS = [
  'resolve-git-identity',
  'show-execution-context',
  'set-execution-context',
  'clear-execution-context',
];

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

export function snakeToKebab(name) {
  return String(name).replace(/_/g, '-');
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
      cliCommand: snakeToKebab(skill.name),
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

// Verifies the client exports exactly one function per contract operation.
// `clientModule` is the imported apts-client.js namespace.
export function checkClientContract(clientModule) {
  const expected = contractOperations().map((op) => op.clientExport);
  const actual = Object.keys(clientModule).filter(
    (key) => typeof clientModule[key] === 'function' && !CLIENT_UTILITY_EXPORTS.has(key)
  );

  const { missing, extra } = diffSets(expected, actual);
  if (missing.length || extra.length) {
    throw new ContractMismatchError(
      'apts-client.js exports are out of sync with apts_skills.json',
      {
        surface: 'client',
        missing_exports: missing,
        unexpected_exports: extra,
        hint: 'Add/remove the matching named export in apts-client.js or update apts_skills.json.',
      }
    );
  }
}

// Verifies the CLI registers exactly one command per contract operation
// (plus the allowed utility commands).
export function checkCliContract(registeredCommandNames) {
  const expected = contractOperations().map((op) => op.cliCommand);
  const actualOps = registeredCommandNames.filter((name) => !CLI_UTILITY_COMMANDS.includes(name));

  const { missing, extra } = diffSets(expected, actualOps);
  if (missing.length || extra.length) {
    throw new ContractMismatchError(
      'apts-cli.js command table is out of sync with apts_skills.json',
      { surface: 'cli', missing_commands: missing, unexpected_commands: extra }
    );
  }
}

// Verifies the MCP server exposes exactly one tool per contract operation.
export function checkMcpContract(toolNames) {
  const expected = operationNames();
  const { missing, extra } = diffSets(expected, toolNames);
  if (missing.length || extra.length) {
    throw new ContractMismatchError(
      'apts-mcp.js tool list is out of sync with apts_skills.json',
      { surface: 'mcp', missing_tools: missing, unexpected_tools: extra }
    );
  }
}

// Full alignment check across every surface available to this process.
export function runContractCheck({ clientModule, commandNames, toolNames } = {}) {
  if (clientModule) checkClientContract(clientModule);
  if (Array.isArray(commandNames)) checkCliContract(commandNames);
  if (Array.isArray(toolNames)) checkMcpContract(toolNames);
}

// When run directly, validate every surface that does not require a live
// runtime (client today; CLI/MCP self-check at their own startup).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const clientModule = await import('./apts-client.js');
    checkClientContract(clientModule);
    const ops = operationNames();
    process.stdout.write(`contract-check OK: ${ops.length} operations aligned with apts-client.js\n`);
    process.stdout.write(`operations: ${ops.join(', ')}\n`);
  } catch (error) {
    process.stderr.write(`${error.name}: ${error.message}\n`);
    if (error.details) process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
    process.exit(error.exitCode || 1);
  }
}
