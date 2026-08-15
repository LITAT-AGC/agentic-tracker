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
//
// Y hace una segunda cosa con el mismo gancho, porque es el mismo momento: si el conductor
// del bucle se anuncia en el entorno, aplana los permisos que quedarian en `ask`. Comparten
// gancho y no motivo; el porque esta escrito junto al codigo.

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
const UNATTENDED_ENV = "APTS_UNATTENDED";

// ---- permisos de una corrida desatendida ----
//
// `ask` no tiene a quien preguntar cuando no hay nadie mirando, y en opencode eso no se
// queda en una espera del proceso principal: cuelga la corrida ENTERA. Comprobado contra
// opencode 1.18.18 leyendo su binario, son dos defectos que se componen.
//
// Uno: una sesion de subagente NO hereda los permisos del padre. Al crearla, opencode se
// queda solo con los del padre que sean `external_directory` o `action: "deny"`, asi que el
// permiso concedido por `--auto` no le llega y el hijo cae a lo que diga esta configuracion.
//
// Dos: `--auto` no es una postura de permisos sino un contestador de eventos, y su manejador
// filtra por sesion —`if (part.sessionID !== mainSession) continue`—. Una peticion de una
// sesion HIJA no se aprueba ni se rechaza: queda abierta para siempre, la herramienta `task`
// del padre no vuelve nunca y el proceso se planta sin gastar CPU ni escribir una linea.
// `--yolo` y `--dangerously-skip-permissions` son alias de `--auto`: mismo codigo, misma
// trampa. Costo dos corridas de un cliente real el 2026-08-15, las dos en la revision
// adversaria, que es justo el paso que usa subagentes.
//
// Por eso el arreglo va en la CONFIGURACION, que es lo unico que el hijo si mira, y solo
// cuando el conductor se anuncia en el entorno. El archivo comiteado conserva su `ask` para
// la sesion interactiva de una persona, que es para quien se escribio.
//
// Se lee del entorno del PROCESO y nunca del `.env`: el `.env` esta en el repositorio y lo
// comparten las dos formas de trabajar, asi que una linea ahi aplanaria tambien las sesiones
// con persona delante. Quien lo pone es quien sabe que no hay nadie mirando.
function unattended() {
  const raw = String(process.env[UNATTENDED_ENV] || process.env.APTS_LOOP_UNATTENDED || '').trim().toLowerCase();
  return raw !== '' && raw !== '0' && raw !== 'false' && raw !== 'no';
}

// Solo `ask` -> `allow`. Un `deny` se queda como esta: es la unica clase de regla que el
// subagente SI hereda, y aplanarla convertiria esto en «desactivar los permisos», que es otra
// cosa y no la que hace falta. La forma del arbol se respeta —opencode admite una cadena o un
// objeto de patrones por capacidad—, asi que se recorre en vez de reescribirlo.
function allowAsks(node) {
  if (node === 'ask') return 'allow';
  if (!node || typeof node !== 'object') return node;
  const out = Array.isArray(node) ? [...node] : { ...node };
  for (const key of Object.keys(out)) out[key] = allowAsks(out[key]);
  return out;
}

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
      if (!config) return;

      // Antes que nada y con su propia salida: esto no depende del registro MCP, y colgarlo
      // debajo de la guarda de abajo lo dejaria sin aplicar en cuanto alguien tocara el
      // servidor. Son dos arreglos independientes que comparten gancho.
      if (config.permission && unattended()) config.permission = allowAsks(config.permission);

      const server = config.mcp && config.mcp[SERVER];
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
