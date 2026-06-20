#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { contractOperations, checkCliContract } from './contract-check.js';

// Utility commands are not contract operations; they manage local identity and
// execution context. Contract operations are derived from apts_skills.json below.
const UTILITY_COMMANDS = {
  'resolve-git-identity': {
    description: 'Resolve project_url, agent_name, agent_email, and branch from local Git.',
    usage: 'apts-cli resolve-git-identity [--cwd <path>] [--pretty]',
    expectsPayload: false,
    supportsOptions: false,
    invoke: (client) => client.resolveGitIdentity(),
  },
  'show-execution-context': {
    description: 'Show resolved execution context (env, local context file, and Git fallback).',
    usage: 'apts-cli show-execution-context [--cwd <path>] [--pretty]',
    expectsPayload: false,
    supportsOptions: false,
    invoke: (client) => client.getExecutionContext(),
  },
  'set-execution-context': {
    description: 'Persist execution context fields to the local managed context file.',
    usage: 'apts-cli set-execution-context (--json <payload> | --stdin) [--cwd <path>] [--pretty]',
    expectsPayload: true,
    supportsOptions: false,
    requiredFields: [],
    invoke: (client, payload) => client.setExecutionContext(payload),
  },
  'clear-execution-context': {
    description: 'Clear the local managed execution context file.',
    usage: 'apts-cli clear-execution-context [--cwd <path>] [--pretty]',
    expectsPayload: false,
    supportsOptions: false,
    invoke: (client) => client.clearStoredExecutionContext(),
  },
};

// Derive one command per contract operation. Name, description, payload/options
// shape, and required fields all come from apts_skills.json (single source of truth).
function buildCommands() {
  const commands = { ...UTILITY_COMMANDS };

  for (const op of contractOperations()) {
    commands[op.cliCommand] = {
      description: op.description,
      usage: `apts-cli ${op.cliCommand} (--json <payload> | --stdin)${op.supportsBatch ? ' [--options <json>]' : ''} [--cwd <path>] [--pretty]`,
      expectsPayload: true,
      supportsOptions: op.supportsBatch,
      requiredFields: op.requiredFields,
      invoke: (client, payload, options) => client[op.clientExport](payload, options),
    };
  }

  return commands;
}

const COMMANDS = buildCommands();

// Fail fast if the derived command table drifts from the contract.
checkCliContract(Object.keys(COMMANDS));

function buildSamplePayload(requiredFields) {
  const samples = {
    title: 'Example title',
    status: 'review',
    message: 'Checkpoint reached',
    error_message: 'Blocked: missing fixture',
    query_text: 'Error 500 when saving backlog',
    backlog_item_id: '11111111-1111-1111-1111-111111111111',
    task_id: '22222222-2222-2222-2222-222222222222',
    project_url: 'https://github.com/org/repo',
    url: 'https://github.com/org/repo',
    agent_name: 'Agent',
    agent_email: 'agent@example.com',
  };
  const payload = {};
  for (const field of requiredFields) {
    payload[field] = samples[field] ?? 'value';
  }
  return payload;
}

function canonicalizeCommandName(value) {
  return String(value || '').trim().toLowerCase().replace(/_/g, '-');
}

function usageError(message) {
  const error = new Error(message);
  error.code = 'CLI_USAGE_ERROR';
  error.exitCode = 2;
  return error;
}

function parseCliArgs(argv) {
  const flags = {
    cwd: undefined,
    envFile: undefined,
    json: undefined,
    output: undefined,
    options: undefined,
    pretty: false,
    stdin: false,
    help: false,
  };
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === '--help' || token === '-h') {
      flags.help = true;
      continue;
    }

    if (token === '--pretty') {
      flags.pretty = true;
      continue;
    }

    if (token === '--stdin') {
      flags.stdin = true;
      continue;
    }

    if (token.startsWith('--env-file=')) {
      flags.envFile = token.slice('--env-file='.length);
      continue;
    }

    if (token.startsWith('--output=')) {
      flags.output = token.slice('--output='.length);
      continue;
    }

    if (token.startsWith('--format=')) {
      flags.output = token.slice('--format='.length);
      continue;
    }

    if (token.startsWith('--cwd=')) {
      flags.cwd = token.slice('--cwd='.length);
      continue;
    }

    if (token.startsWith('--json=')) {
      flags.json = token.slice('--json='.length);
      continue;
    }

    if (token.startsWith('--options=')) {
      flags.options = token.slice('--options='.length);
      continue;
    }

    if (token === '--env-file') {
      const nextToken = argv[index + 1];
      if (nextToken === undefined) {
        throw usageError('Missing value for --env-file');
      }

      flags.envFile = nextToken;
      index += 1;
      continue;
    }

    if (token === '--output' || token === '--format') {
      const nextToken = argv[index + 1];
      if (nextToken === undefined) {
        throw usageError(`Missing value for ${token}`);
      }

      flags.output = nextToken;
      index += 1;
      continue;
    }

    if (token === '--cwd' || token === '--json' || token === '--options') {
      const nextToken = argv[index + 1];
      if (nextToken === undefined) {
        throw usageError(`Missing value for ${token}`);
      }

      const key = token.slice(2);
      flags[key] = nextToken;
      index += 1;
      continue;
    }

    if (token.startsWith('--')) {
      throw usageError(`Unknown flag: ${token}`);
    }

    positionals.push(token);
  }

  return { flags, positionals };
}

function resolveCommand(commandName) {
  const normalized = canonicalizeCommandName(commandName);
  return normalized ? COMMANDS[normalized] : null;
}

function buildHelp(commandName) {
  const normalized = canonicalizeCommandName(commandName);
  const command = normalized ? COMMANDS[normalized] : null;

  if (normalized && !command) {
    throw usageError(`Unknown command: ${commandName}`);
  }

  if (command) {
    const requiredFields = command.requiredFields;
    const hasRequiredInfo = command.expectsPayload && Array.isArray(requiredFields);
    const example = hasRequiredInfo
      ? `node .ia/apts/apts-cli.js ${normalized} --json '${JSON.stringify(buildSamplePayload(requiredFields))}'`
      : null;

    return [
      'APTS CLI',
      '',
      `${normalized}: ${command.description}`,
      '',
      `Usage: ${command.usage}`,
      ...(hasRequiredInfo
        ? ['', `Minimum payload fields: ${requiredFields.length ? requiredFields.join(', ') : 'none (resolved automatically from env, local context, or Git)'}`]
        : []),
      '',
      'Flags:',
      '  --json <payload>     Inline JSON payload or @path/to/payload.json.',
      '  --stdin              Read the JSON payload from stdin.',
      '  --options <json>     Optional JSON options for batch strict mode.',
      '  --cwd <path>         Resolve .env and Git identity from a different working directory.',
      '  --env-file <path>    Load APTS variables from an explicit env file before running.',
      '  --output <mode>      raw|structured (structured wraps success in a stable envelope).',
      '  --pretty             Pretty-print JSON output.',
      '  --help               Show this help.',
      '  Note:                Official client/CLI auto-fills project_url, agent identity, branch, and task_id (from env, local context file, or Git fallback) when missing.',
      ...(example ? ['', 'Example:', `  ${example}`] : []),
    ].join('\n');
  }

  return [
    'APTS CLI',
    '',
    'CLI fallback for the APTS workflow (MCP is the primary surface).',
    'Commands accept kebab-case or skill_name form, for example register-task or register_task.',
    'The command table is derived from apts_skills.json (single source of truth).',
    '',
    'Usage:',
    '  apts-cli <command> [flags]',
    '  apts-cli help <command>',
    '',
    'Commands:',
    ...Object.entries(COMMANDS).map(([name, command]) => `  ${name.padEnd(28)} ${command.description.split('. ')[0]}`),
    '',
    'Global flags:',
    '  --cwd <path>         Resolve .env and Git identity from a different working directory.',
    '  --env-file <path>    Load APTS variables from a specific env file before running.',
    '  --output <mode>      raw|structured (structured wraps success in a stable envelope).',
    '  --pretty             Pretty-print JSON output.',
    '  --help               Show this help.',
    '',
    'Payload flags:',
    '  --json <payload>     Inline JSON payload or @path/to/payload.json.',
    '  --stdin              Read the JSON payload from stdin.',
    '  --options <json>     Optional JSON options for batch strict mode.',
    '  PowerShell tip:      Prefer --stdin or --json @payload.json for long payloads and multiline text.',
    '',
    'Run `apts-cli help <command>` to see minimum required fields and a copy-ready example for that operation.',
    '',
    'Examples:',
    '  node .ia/apts/apts-cli.js resolve-git-identity --cwd .',
    '  node .ia/apts/apts-cli.js show-execution-context --pretty',
    '  node .ia/apts/apts-cli.js register-task --json "{""title"":""Implement feature""}" --output structured',
    '  Get-Content register-task.json | node .ia/apts/apts-cli.js register-task --stdin',
  ].join('\n');
}

function unwrapMatchingQuotes(value) {
  if (typeof value !== 'string') return value;

  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;

  const startsWithDouble = trimmed.startsWith('"') && trimmed.endsWith('"');
  const startsWithSingle = trimmed.startsWith('\'') && trimmed.endsWith('\'');

  if (!startsWithDouble && !startsWithSingle) return trimmed;
  return trimmed.slice(1, -1).trim();
}

function parseJsonText(rawText, label) {
  const parsedCandidates = [];

  const rawInput = typeof rawText === 'string' ? rawText.trim() : '';
  if (!rawInput) {
    throw usageError(`Expected JSON text in ${label}, but it was empty`);
  }

  const inputText = rawInput.startsWith('@')
    ? (() => {
      const filePath = rawInput.slice(1).trim();
      if (!filePath) {
        throw usageError(`Invalid ${label}: expected @<path-to-json-file>`);
      }

      const resolvedPath = path.resolve(filePath);
      if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
        throw usageError(`Invalid ${label}: JSON file not found at ${filePath}`);
      }

      const fileContents = fs.readFileSync(resolvedPath, 'utf8').trim();
      if (!fileContents) {
        throw usageError(`Invalid ${label}: JSON file at ${filePath} is empty`);
      }

      return fileContents;
    })()
    : rawInput;

  parsedCandidates.push(inputText);

  const unwrapped = unwrapMatchingQuotes(inputText);
  if (unwrapped && unwrapped !== inputText) {
    parsedCandidates.push(unwrapped);
  }

  const withCollapsedDoubleQuotes = unwrapped.replace(/""/g, '"');
  if (withCollapsedDoubleQuotes && !parsedCandidates.includes(withCollapsedDoubleQuotes)) {
    parsedCandidates.push(withCollapsedDoubleQuotes);
  }

  for (const candidate of parsedCandidates) {
    try {
      return JSON.parse(candidate);
    } catch (_error) {
      // Keep trying normalized forms before returning a usage error.
    }
  }

  throw usageError(`Invalid JSON in ${label}. If using PowerShell, prefer --stdin or --json @payload.json.`);
}

function readPayload(flags, command) {
  if (!command.expectsPayload) {
    if (flags.json !== undefined || flags.stdin) {
      throw usageError('This command does not accept a JSON payload');
    }
    return undefined;
  }

  if (flags.json !== undefined && flags.stdin) {
    throw usageError('Use either --json or --stdin, not both');
  }

  if (flags.stdin) {
    const stdinText = fs.readFileSync(0, 'utf8').trim();
    if (!stdinText) {
      throw usageError('Expected JSON payload on stdin, but stdin was empty');
    }
    return parseJsonText(stdinText, 'stdin');
  }

  if (flags.json === undefined) {
    throw usageError('This command requires --json <payload> or --stdin');
  }

  return parseJsonText(flags.json, '--json');
}

function readOptions(flags, command) {
  if (flags.options === undefined) {
    return undefined;
  }

  if (!command.supportsOptions) {
    throw usageError('This command does not accept --options');
  }

  const options = parseJsonText(flags.options, '--options');
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw usageError('--options must decode to a JSON object');
  }

  return options;
}

function resolveWorkingDirectory(rawPath) {
  const resolvedPath = path.resolve(rawPath);
  if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isDirectory()) {
    throw usageError(`--cwd must point to an existing directory: ${rawPath}`);
  }
  return resolvedPath;
}

function resolveEnvFilePath(rawPath) {
  const resolvedPath = path.resolve(rawPath);
  if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
    throw usageError(`--env-file must point to an existing file: ${rawPath}`);
  }
  return resolvedPath;
}

function resolveOutputFormat(rawValue) {
  if (rawValue === undefined) {
    return 'raw';
  }

  const normalized = String(rawValue).trim().toLowerCase();
  if (normalized === 'raw' || normalized === 'json') {
    return 'raw';
  }

  if (normalized === 'structured') {
    return 'structured';
  }

  throw usageError('--output must be one of: raw, json, structured');
}

function writeJson(stream, value, pretty) {
  const spacing = pretty ? 2 : 0;
  stream.write(`${JSON.stringify(value, null, spacing)}\n`);
}

function buildSuccessPayload(result, commandName) {
  return {
    ok: true,
    command: commandName || null,
    data: result,
  };
}

function buildErrorPayload(error, commandName) {
  return {
    ok: false,
    command: commandName || null,
    error: {
      name: error.name || 'Error',
      message: error.message,
      code: error.errorCode || error.code || 'CLI_ERROR',
      statusCode: error.statusCode ?? null,
      retriable: error.retriable === true,
      details: error.details ?? null,
    },
  };
}

async function main() {
  const { flags, positionals } = parseCliArgs(process.argv.slice(2));

  if (!positionals.length || positionals[0] === 'help') {
    const helpTarget = positionals[0] === 'help' ? positionals[1] : undefined;
    process.stdout.write(`${buildHelp(helpTarget)}\n`);
    return;
  }

  const commandName = canonicalizeCommandName(positionals[0]);
  const command = resolveCommand(commandName);

  if (flags.help) {
    process.stdout.write(`${buildHelp(commandName)}\n`);
    return;
  }

  if (!command) {
    throw usageError(`Unknown command: ${positionals[0]}`);
  }

  if (positionals.length > 1) {
    throw usageError(`Unexpected extra positional arguments: ${positionals.slice(1).join(' ')}`);
  }

  if (flags.cwd !== undefined) {
    process.chdir(resolveWorkingDirectory(flags.cwd));
  }

  if (flags.envFile !== undefined) {
    process.env.APTS_ENV_FILE = resolveEnvFilePath(flags.envFile);
  }

  const client = await import('./apts-client.js');
  const payload = readPayload(flags, command);
  const options = readOptions(flags, command);
  const pretty = flags.pretty || process.stdout.isTTY;
  const outputFormat = resolveOutputFormat(flags.output);
  const result = await command.invoke(client, payload, options);
  writeJson(process.stdout, outputFormat === 'structured' ? buildSuccessPayload(result, commandName) : result, pretty);
}

main().catch((error) => {
  const commandName = canonicalizeCommandName(process.argv[2]);
  const pretty = process.stderr.isTTY;
  writeJson(process.stderr, buildErrorPayload(error, commandName), pretty);
  process.exit(error.exitCode || 1);
});
