// Núcleo MCP del backend: una herramienta por operación del contrato, con el
// `inputSchema` tomado tal cual de `apts_skills.json`.
//
// No es un transporte. `dispatch()` **devuelve** el objeto de respuesta JSON-RPC
// (o `null` para las notificaciones) y no escribe en ningún sitio; quien llama
// decide qué hacer con él. Hoy sólo hay un llamante: el endpoint MCP remoto de
// `backend/index.js`, que además le pasa el ejecutor en proceso —`dispatch` no
// resuelve por sí mismo dónde ejecutar—.
//
// El archivo se llamó `apts-mcp.js` y fue el servidor por entrada/salida
// estándar. De aquello quedaba un `main()` con su bucle de `readline` que
// importaba `apts-client.js`: se ejecutaba sólo al invocar el archivo
// directamente, y como ese cliente se retiró con la superficie, llevaba tiempo
// fallando con `Cannot find module`. Se ha ido. El nombre del archivo conserva
// `stdio` por el protocolo que habla, no por un transporte que ya no existe.
//
// Al importarlo se comprueba el contrato: si la lista de herramientas derivada se
// separa de `apts_skills.json`, aborta antes de que nadie se conecte.

import { contractOperations, checkMcpContract } from './contract_check.mjs';

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

function buildResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function buildError(id, code, message, data) {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
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
  return buildResult(message.id, {
    protocolVersion: typeof requested === 'string' && requested ? requested : PROTOCOL_VERSION,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
  });
}

function listTools() {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

function handleToolsList(message) {
  return buildResult(message.id, { tools: listTools() });
}

async function handleToolsCall(message, client) {
  const toolName = message.params?.name;
  const tool = TOOL_BY_NAME.get(toolName);

  if (!tool) {
    return buildError(message.id, -32602, `Unknown tool: ${toolName}`, {
      available_tools: TOOLS.map((entry) => entry.name),
    });
  }

  const args = message.params?.arguments;
  const payload = args === undefined || args === null ? {} : args;

  try {
    // `client` es el ejecutor que pasa quien llama, no un cliente que salga a la
    // red: hoy es el ejecutor en proceso de `backend/index.js`, que valida el
    // payload con el mismo esquema que la ruta HTTP equivalente.
    const data = await client[tool.clientExport](payload);
    return buildResult(message.id, {
      content: [{ type: 'text', text: JSON.stringify(data) }],
      structuredContent: { ok: true, data },
    });
  } catch (error) {
    const errorPayload = buildToolErrorPayload(error);
    return buildResult(message.id, {
      content: [{ type: 'text', text: JSON.stringify(errorPayload) }],
      structuredContent: errorPayload,
      isError: true,
    });
  }
}

// Returns the JSON-RPC response object, or null when there is nothing to answer
// (notifications). Never writes to any transport.
async function dispatch(message, client) {
  const { method, id } = message;
  const isRequest = id !== undefined && id !== null;

  switch (method) {
    case 'initialize':
      return handleInitialize(message, client);
    case 'tools/list':
      return handleToolsList(message);
    case 'tools/call':
      return handleToolsCall(message, client);
    case 'ping':
      return isRequest ? buildResult(id, {}) : null;
    default:
      // Notifications (no id), e.g. notifications/initialized: acknowledge silently.
      if (!isRequest) return null;
      return buildError(id, -32601, `Method not found: ${method}`);
  }
}

export {
  PROTOCOL_VERSION,
  SERVER_NAME,
  SERVER_VERSION,
  buildError,
  buildResult,
  buildToolErrorPayload,
  dispatch,
  listTools,
};
