#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const COMMANDS = {
  'resolve-git-identity': {
    description: 'Resolve project_url, agent_name, agent_email, and branch from local Git.',
    usage: 'apts-cli resolve-git-identity [--cwd <path>] [--pretty]',
    expectsPayload: false,
    supportsOptions: false,
    invoke: (client) => client.resolveGitIdentity(),
  },
  'register-task': {
    description: 'Create one task or a batch of tasks.',
    usage: 'apts-cli register-task (--json <payload> | --stdin) [--options <json>] [--cwd <path>] [--pretty]',
    expectsPayload: true,
    supportsOptions: true,
    invoke: (client, payload, options) => client.registerTask(payload, options),
  },
  'read-project-context': {
    description: 'Read backlog, tasks, and recent history for one project.',
    usage: 'apts-cli read-project-context (--json <payload> | --stdin) [--cwd <path>] [--pretty]',
    expectsPayload: true,
    supportsOptions: false,
    invoke: (client, payload) => client.readProjectContext(payload),
  },
  'list-backlog-items': {
    description: 'List backlog items ordered by priority and sort order.',
    usage: 'apts-cli list-backlog-items (--json <payload> | --stdin) [--cwd <path>] [--pretty]',
    expectsPayload: true,
    supportsOptions: false,
    invoke: (client, payload) => client.listBacklogItems(payload),
  },
  'create-backlog-item': {
    description: 'Create one backlog item or a batch of backlog items.',
    usage: 'apts-cli create-backlog-item (--json <payload> | --stdin) [--options <json>] [--cwd <path>] [--pretty]',
    expectsPayload: true,
    supportsOptions: true,
    invoke: (client, payload, options) => client.createBacklogItem(payload, options),
  },
  'update-backlog-item': {
    description: 'Update one backlog item or a batch of backlog items.',
    usage: 'apts-cli update-backlog-item (--json <payload> | --stdin) [--options <json>] [--cwd <path>] [--pretty]',
    expectsPayload: true,
    supportsOptions: true,
    invoke: (client, payload, options) => client.updateBacklogItem(payload, options),
  },
  'delete-backlog-item': {
    description: 'Soft-delete one backlog item or a batch of backlog items.',
    usage: 'apts-cli delete-backlog-item (--json <payload> | --stdin) [--options <json>] [--cwd <path>] [--pretty]',
    expectsPayload: true,
    supportsOptions: true,
    invoke: (client, payload, options) => client.deleteBacklogItem(payload, options),
  },
  'update-task-status': {
    description: 'Update one task status or a batch of task statuses.',
    usage: 'apts-cli update-task-status (--json <payload> | --stdin) [--options <json>] [--cwd <path>] [--pretty]',
    expectsPayload: true,
    supportsOptions: true,
    invoke: (client, payload, options) => client.updateTaskStatus(payload, options),
  },
  'log-agent-progress': {
    description: 'Log technical progress for one task or a batch of tasks.',
    usage: 'apts-cli log-agent-progress (--json <payload> | --stdin) [--options <json>] [--cwd <path>] [--pretty]',
    expectsPayload: true,
    supportsOptions: true,
    invoke: (client, payload, options) => client.logAgentProgress(payload, options),
  },
  'report-blocker': {
    description: 'Report one blocker or a batch of blockers.',
    usage: 'apts-cli report-blocker (--json <payload> | --stdin) [--options <json>] [--cwd <path>] [--pretty]',
    expectsPayload: true,
    supportsOptions: true,
    invoke: (client, payload, options) => client.reportBlocker(payload, options),
  },
  heartbeat: {
    description: 'Send one heartbeat or a batch of heartbeats.',
    usage: 'apts-cli heartbeat (--json <payload> | --stdin) [--options <json>] [--cwd <path>] [--pretty]',
    expectsPayload: true,
    supportsOptions: true,
    invoke: (client, payload, options) => client.heartbeat(payload, options),
  },
};

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
    json: undefined,
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
    return [
      `APTS CLI`,
      '',
      `${normalized}: ${command.description}`,
      '',
      `Usage: ${command.usage}`,
      '',
      'Flags:',
      '  --json <payload>     Inline JSON payload matching the contract-first shape.',
      '  --stdin              Read the JSON payload from stdin.',
      '  --options <json>     Optional JSON options for batch strict mode.',
      '  --cwd <path>         Resolve .env and Git identity from a different working directory.',
      '  --pretty             Pretty-print JSON output.',
      '  --help               Show this help.',
    ].join('\n');
  }

  return [
    'APTS CLI',
    '',
    'Thin official CLI over the exported APTS JavaScript client.',
    'Commands accept kebab-case or skill_name form, for example register-task or register_task.',
    '',
    'Usage:',
    '  apts-cli <command> [flags]',
    '  apts-cli help <command>',
    '',
    'Commands:',
    ...Object.entries(COMMANDS).map(([name, command]) => `  ${name.padEnd(20)} ${command.description}`),
    '',
    'Global flags:',
    '  --cwd <path>         Resolve .env and Git identity from a different working directory.',
    '  --pretty             Pretty-print JSON output.',
    '  --help               Show this help.',
    '',
    'Payload flags:',
    '  --json <payload>     Inline JSON payload matching the contract-first shape.',
    '  --stdin              Read the JSON payload from stdin.',
    '  --options <json>     Optional JSON options for batch strict mode.',
    '',
    'Examples:',
    '  node .ia/apts/apts-cli.js resolve-git-identity --cwd .',
    '  Get-Content register-task.json | node .ia/apts/apts-cli.js register-task --stdin',
    "  Get-Content payload.json | node .ia/apts/apts-cli.js update-task-status --stdin --options '{\"strict\":true}'",
  ].join('\n');
}

function parseJsonText(rawText, label) {
  try {
    return JSON.parse(rawText);
  } catch (error) {
    throw usageError(`Invalid JSON in ${label}: ${error.message}`);
  }
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

function writeJson(stream, value, pretty) {
  const spacing = pretty ? 2 : 0;
  stream.write(`${JSON.stringify(value, null, spacing)}\n`);
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

  const client = require('./apts-client.js');
  const payload = readPayload(flags, command);
  const options = readOptions(flags, command);
  const pretty = flags.pretty || process.stdout.isTTY;
  const result = await command.invoke(client, payload, options);
  writeJson(process.stdout, result, pretty);
}

main().catch((error) => {
  const commandName = canonicalizeCommandName(process.argv[2]);
  const pretty = process.stderr.isTTY;
  writeJson(process.stderr, buildErrorPayload(error, commandName), pretty);
  process.exit(error.exitCode || 1);
});