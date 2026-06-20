#!/usr/bin/env node

// APTS MCP server (stdio, zero-deps).
//
// Primary cross-runtime surface: exposes one MCP tool per contract operation,
// with inputSchema taken straight from apts_skills.json and execution handled by
// apts-client.js (so identity autofill from env -> .apts/execution-context.json ->
// Git is reused as-is). Implements the minimum JSON-RPC 2.0 / MCP stdio protocol
// by hand to avoid a runtime dependency: the package ships as downloadable files
// run with `node`, with no install step. (Decision WS2-T1, see TRACKING.)
//
// Transport: newline-delimited JSON-RPC over stdin/stdout. Logs go to stderr so
// stdout stays a clean message stream. Startup runs checkMcpContract() in strict
// mode, so a drift between the contract and the exposed tool list aborts with a
// non-zero exit code before any client connects.

import readline from 'node:readline';
import { contractOperations, checkMcpContract } from './contract-check.js';

const SERVER_NAME = 'apts-mcp';
const SERVER_VERSION = '1.0.0';
// Protocol version we implement; we echo the client's requested version when present.
const PROTOCOL_VERSION = '2025-06-18';

// Build one tool descriptor per contract operation. The MCP inputSchema is the
// object branch of the contract schema (tool-call arguments are always a single
// JSON object), normalized to a strict JSON Schema object.
function buildTools() {
  return contractOperations().map((op) => ({
    name: op.name,
    clientExport: op.clientExport,
    description: op.description,
    inputSchema: {
      type: 'object',
      properties: op.objectSchema.properties || {},
      ...(op.requiredFields.length ? { required: op.requiredFields } : {}),
    },
  }));
}

const TOOLS = buildTools();
const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

// Fail fast (exit 3) if the derived tool list drifts from the contract.
checkMcpContract(TOOLS.map((tool) => tool.name));

function log(message) {
  process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message, data) {
  send({
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  });
}

function buildToolErrorPayload(error) {
  return {
    ok: false,
    error: {
      name: error.name || 'Error',
      message: error.message,
      code: error.errorCode || error.code || 'APTS_MCP_ERROR',
      statusCode: error.statusCode ?? null,
      retriable: error.retriable === true,
      details: error.details ?? null,
    },
  };
}

async function handleInitialize(message, client) {
  // Touch the client so a broken import surfaces during initialize, not mid-call.
  void client;
  const requested = message.params?.protocolVersion;
  sendResult(message.id, {
    protocolVersion: typeof requested === 'string' && requested ? requested : PROTOCOL_VERSION,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
  });
}

function handleToolsList(message) {
  sendResult(message.id, {
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  });
}

async function handleToolsCall(message, client) {
  const toolName = message.params?.name;
  const tool = TOOL_BY_NAME.get(toolName);

  if (!tool) {
    sendError(message.id, -32602, `Unknown tool: ${toolName}`, {
      available_tools: TOOLS.map((entry) => entry.name),
    });
    return;
  }

  const args = message.params?.arguments;
  const payload = args === undefined || args === null ? {} : args;

  try {
    // The client autofills identity and validates against the contract internally.
    const data = await client[tool.clientExport](payload);
    sendResult(message.id, {
      content: [{ type: 'text', text: JSON.stringify(data) }],
      structuredContent: { ok: true, data },
    });
  } catch (error) {
    const errorPayload = buildToolErrorPayload(error);
    sendResult(message.id, {
      content: [{ type: 'text', text: JSON.stringify(errorPayload) }],
      structuredContent: errorPayload,
      isError: true,
    });
  }
}

async function dispatch(message, client) {
  const { method, id } = message;
  const isRequest = id !== undefined && id !== null;

  switch (method) {
    case 'initialize':
      await handleInitialize(message, client);
      return;
    case 'tools/list':
      handleToolsList(message);
      return;
    case 'tools/call':
      await handleToolsCall(message, client);
      return;
    case 'ping':
      if (isRequest) sendResult(id, {});
      return;
    default:
      // Notifications (no id), e.g. notifications/initialized: acknowledge silently.
      if (!isRequest) return;
      sendError(id, -32601, `Method not found: ${method}`);
  }
}

async function main() {
  const client = await import('./apts-client.js');
  log(`ready: ${TOOLS.length} tools (stdio, protocol ${PROTOCOL_VERSION})`);

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  // Serialize handling so responses are emitted in request order.
  let queue = Promise.resolve();

  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;

    let message;
    try {
      message = JSON.parse(text);
    } catch {
      sendError(null, -32700, 'Parse error: invalid JSON');
      return;
    }

    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      sendError(message?.id ?? null, -32600, 'Invalid Request');
      return;
    }

    queue = queue.then(() => dispatch(message, client)).catch((error) => {
      log(`unhandled dispatch error: ${error?.message || error}`);
      if (message.id !== undefined && message.id !== null) {
        sendError(message.id, -32603, 'Internal error', { message: error?.message || String(error) });
      }
    });
  });

  rl.on('close', () => {
    queue.finally(() => process.exit(0));
  });
}

main().catch((error) => {
  log(`fatal: ${error?.message || error}`);
  process.exit(error?.exitCode || 1);
});
