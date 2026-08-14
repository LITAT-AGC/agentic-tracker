// GENERADO — no editar; fuente: spec/apts-surface.json
//
// opencode no lee `.env`. Su interpolacion `{env:VAR}` sustituye texto en la configuracion
// contra el entorno del PROCESO, antes de que exista ningun plugin, y una variable ausente se
// convierte en cadena vacia: cabecera vacia (401 de APTS) o, si le toca a la url, servidor
// marcado `failed` con «Invalid MCP URL».
//
// Este plugin lee el `.env` del proyecto y reescribe la url y las cabeceras del servidor MCP
// ya en memoria. opencode inicializa los plugins antes que nada mas justamente porque pueden
// mutar la configuracion, asi que esto ocurre antes de que el registro MCP se conecte.
//
// Precedencia: el entorno del proceso gana al `.env`, como cualquier dotenv.

import fs from 'node:fs';
import path from 'node:path';

const SERVER = "apts";
const URL_ENV = "APTS_MCP_URL";
const HEADERS = [
  {
    "name": "Authorization",
    "env": "APTS_API_KEY",
    "scheme": "Bearer"
  },
  {
    "name": "X-APTS-Project-Url",
    "env": "APTS_PROJECT_URL",
    "scheme": null
  },
  {
    "name": "X-APTS-Agent-Name",
    "env": "APTS_AGENT_NAME",
    "scheme": null
  },
  {
    "name": "X-APTS-Agent-Email",
    "env": "APTS_AGENT_EMAIL",
    "scheme": null
  }
];

// `.env` minimalista: un `CLAVE=valor` por linea, `export ` opcional, comillas opcionales y
// `#` de comentario. No expande variables dentro del valor: una clave no deberia depender de
// eso, y expandir a medias confunde mas que no expandir.
function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith('export ')) key = key.slice(7).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if (value.length > 1 && (quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      const comment = value.indexOf(' #');
      if (comment !== -1) value = value.slice(0, comment).trim();
    }
    out[key] = value;
  }
  return out;
}

function readEnvFiles(dirs) {
  const merged = {};
  for (const dir of dirs) {
    if (!dir) continue;
    let text;
    try { text = fs.readFileSync(path.join(dir, '.env'), 'utf8'); } catch { continue; }
    Object.assign(merged, parseEnv(text));
  }
  return merged;
}

// Unica exportacion, y funcion: opencode recorre TODAS las exportaciones del modulo y falla
// entero si alguna no lo es.
export const AptsEnv = async ({ directory, worktree }) => {
  // El `.env` suele estar en la raiz del repositorio (`worktree`), pero se admite tambien el
  // directorio de trabajo (`directory`) y ese, por ser el mas cercano, gana.
  const fromFile = readEnvFiles([...new Set([worktree, directory])]);
  const read = (name) => process.env[name] || fromFile[name] || '';

  return {
    config: async (config) => {
      const server = config && config.mcp && config.mcp[SERVER];
      if (!server || server.type !== 'remote') return;

      // Solo si viene definida: la url literal del archivo generado ya es valida, y esto es
      // el escape para apuntar a otro despliegue.
      const url = read(URL_ENV);
      if (url) server.url = url;

      const headers = { ...(server.headers || {}) };
      for (const header of HEADERS) {
        const value = read(header.env);
        // Sin valor se BORRA la cabecera en vez de mandarla vacia: asi APTS contesta nombrando
        // el campo que falta en vez de tomar la cadena vacia por identidad.
        if (!value) { delete headers[header.name]; continue; }
        headers[header.name] = header.scheme ? header.scheme + ' ' + value : value;
      }
      server.headers = headers;
    },
  };
};
