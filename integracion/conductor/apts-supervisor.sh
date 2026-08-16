#!/bin/sh
# apts-supervisor — relanza el conductor de APTS cuando lo matan desde fuera, y NO lo
# relanza cuando fue el conductor quien decidió parar.
#
#   sh apts-supervisor.sh [opciones] -- node apts-loop.js --agent-cmd '...' ...
#
# Es el gemelo POSIX de `apts-supervisor.ps1`. Los dos existen por la misma razón, que está
# contada entera allí y se resume aquí: al conductor lo matan desde fuera —el caso que esto
# cierra fue un `Stop-Process -Name node` de otra ventana que se llevó los catorce procesos
# `node` de la máquina—, así que un supervisor escrito en Node moriría en el mismo barrido.
# Tiene que ser un proceso que no sea el que barren, y el precio de eso es depender del
# sistema operativo y tener que escribirlo dos veces.
#
# Por eso lleva dentro lo mínimo. El problema difícil —el agente que sobrevive al conductor
# y sigue escribiendo en el repositorio— NO se resuelve aquí: lo resuelve el conductor al
# arrancar, en Node, una sola vez y probado (ver el README, «El agente que sobrevive al
# conductor»). Esto sabe lanzar, leer el diario y decidir.
#
# LA REGLA. El conductor escribe SIEMPRE un evento `parada` en su diario cuando decide
# parar. Mirando sólo lo que se escribió mientras esta corrida estaba viva:
#
#   `arranque` y detrás `parada`   -> decidió él            -> se respeta su código
#   `arranque` y ninguna `parada`  -> lo mataron            -> se relanza
#   ni siquiera `arranque`         -> no llegó a conducir   -> se respeta su código
#
# El código de salida no decide, y eso es deliberado: el día del caso fue 255, que no es
# ninguno de los del conductor y no significa nada.

NOMBRE='apts-supervisor'
SALIDA_CONFIG=40
SALIDA_CERROJO=41
SALIDA_TOPE=42

DIARIO='.apts/apts-loop.jsonl'
MAX_RELANZAMIENTOS=5
CORRIDA_SANA_MIN=20
DOTENV='.env'

escribir() { printf '[%s] %s\n' "$NOMBRE" "$*" >&2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --diario) DIARIO="$2"; shift 2 ;;
    --max-relanzamientos) MAX_RELANZAMIENTOS="$2"; shift 2 ;;
    --corrida-sana) CORRIDA_SANA_MIN="$2"; shift 2 ;;
    --dotenv) DOTENV="$2"; shift 2 ;;
    --) shift; break ;;
    *) escribir "opción desconocida: $1"; exit "$SALIDA_CONFIG" ;;
  esac
done

if [ $# -eq 0 ]; then
  escribir "falta el comando del conductor. Uso: sh apts-supervisor.sh [opciones] -- node apts-loop.js --agent-cmd '...'"
  exit "$SALIDA_CONFIG"
fi

# El modo espera no se supervisa, y no es un olvido: allí un mismo proceso encadena
# corridas y cada `parada` termina UNA sin terminar el proceso, así que «su última palabra
# fue una parada» deja de significar lo mismo. Además lo arranca y lo para el panel.
for a in "$@"; do
  if [ "$a" = '--daemon' ]; then
    escribir 'este supervisor no supervisa --daemon: en modo espera una parada termina una corrida y no el proceso, y la regla del diario deja de decidir.'
    exit "$SALIDA_CONFIG"
  fi
done

case " $* " in
  *' --journal off '*)
    escribir 'el conductor lleva --journal off: sin diario no hay forma de saber si paró él o lo mataron.'
    exit "$SALIDA_CONFIG" ;;
esac

case "$DIARIO" in
  /*) DIARIO_ABS="$DIARIO" ;;
  *) DIARIO_ABS="$(pwd)/$DIARIO" ;;
esac
DIR_DIARIO="$(dirname "$DIARIO_ABS")"
# El cerrojo se nombra por el DIARIO y no por la carpeta: lo que no puede duplicarse es la
# corrida, y una corrida se identifica por su diario.
CERROJO="$DIARIO_ABS.lock"

ahora() { date -u +%Y-%m-%dT%H:%M:%S.000Z; }

# Escapa lo justo para meter un valor dentro de una cadena JSON. No hay `jq` garantizado en
# ninguna máquina y no se va a exigir uno para escribir siete líneas al día.
json_txt() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/\\t/g' | tr -d '\n\r'; }

anotar() {
  mkdir -p "$DIR_DIARIO" 2>/dev/null
  printf '{"ts":"%s","evento":"%s"%s}\n' "$(ahora)" "$1" "$2" >>"$DIARIO_ABS" 2>/dev/null
}

# ---- avisos ----
#
# Un conductor muerto no avisa de su propia muerte: eso es de aquí. `curl` es la única
# dependencia externa y su ausencia no puede parar nada — se calla y sigue.
TELEGRAM_TOKEN="${APTS_LOOP_TELEGRAM_TOKEN:-}"
TELEGRAM_CHAT="${APTS_LOOP_TELEGRAM_CHAT_ID:-}"
TELEGRAM_API="${APTS_LOOP_TELEGRAM_API:-https://api.telegram.org}"
if [ -f "$DOTENV" ]; then
  # Sólo las dos claves que hacen falta, y sólo si el entorno no las trae ya: cargar un
  # `.env` entero en el entorno de este proceso sería pisarle cosas al conductor.
  [ -n "$TELEGRAM_TOKEN" ] || TELEGRAM_TOKEN="$(sed -n 's/^[[:space:]]*APTS_LOOP_TELEGRAM_TOKEN[[:space:]]*=[[:space:]]*//p' "$DOTENV" | tail -1 | tr -d '"'\''\r')"
  [ -n "$TELEGRAM_CHAT" ] || TELEGRAM_CHAT="$(sed -n 's/^[[:space:]]*APTS_LOOP_TELEGRAM_CHAT_ID[[:space:]]*=[[:space:]]*//p' "$DOTENV" | tail -1 | tr -d '"'\''\r')"
fi

PROYECTO_URL=''
AGENTE_NOMBRE=''

avisar() {
  [ -n "$TELEGRAM_TOKEN" ] && [ -n "$TELEGRAM_CHAT" ] || return 0
  command -v curl >/dev/null 2>&1 || return 0
  texto="$1 APTS · supervisor · $2

$3
"
  [ -n "$PROYECTO_URL" ] && texto="$texto
proyecto: $PROYECTO_URL"
  [ -n "$AGENTE_NOMBRE" ] && texto="$texto
agente: $AGENTE_NOMBRE"
  cuerpo="{\"chat_id\":\"$(json_txt "$TELEGRAM_CHAT")\",\"text\":\"$(printf '%s' "$texto" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | sed -e ':a' -e 'N' -e '$!ba' -e 's/\n/\\n/g')\",\"disable_web_page_preview\":true}"
  if curl -sS -m 10 -X POST -H 'Content-Type: application/json' \
      -d "$cuerpo" "$TELEGRAM_API/bot$TELEGRAM_TOKEN/sendMessage" >/dev/null 2>&1; then
    escribir 'aviso enviado por Telegram'
  else
    escribir 'aviso: no se pudo avisar por Telegram'
  fi
}

# ---- cerrojo ----
#
# Dos supervisores sobre el mismo diario son la forma segura de acabar con dos conductores
# peleándose por el claim. El PID va DENTRO y se comprueba contra el proceso vivo, porque
# el cerrojo tiene que sobrevivir a que maten al supervisor: un archivo que sólo existe o no
# existe dejaría el diario bloqueado para siempre después del primer barrido.
#
# Y no basta el número, que el sistema recicla: se comprueba además que el proceso sea un
# shell, que es lo que este supervisor es. Un PID heredado por otro programa no cuenta.
tomar_cerrojo() {
  if [ -f "$CERROJO" ]; then
    duenio="$(sed -n 's/.*"pid":\([0-9]*\).*/\1/p' "$CERROJO" | head -1)"
    if [ -n "$duenio" ] && kill -0 "$duenio" 2>/dev/null; then
      imagen="$(ps -p "$duenio" -o comm= 2>/dev/null | sed 's#.*/##')"
      case "$imagen" in
        sh|dash|bash|ksh|zsh) return 1 ;;
      esac
    fi
    escribir 'el cerrojo era de un supervisor que ya no existe; lo piso'
  fi
  mkdir -p "$DIR_DIARIO" 2>/dev/null
  printf '{"pid":%s,"diario":"%s","desde":"%s"}\n' "$$" "$(json_txt "$DIARIO_ABS")" "$(ahora)" >"$CERROJO"
  return 0
}

if ! tomar_cerrojo; then
  escribir "ya hay un supervisor vivo sobre este diario ($CERROJO). No arranco un segundo."
  exit "$SALIDA_CERROJO"
fi
trap 'rm -f "$CERROJO"' EXIT INT TERM

# La espera entre relanzamientos crece: si el que mata sigue ahí, insistir cada treinta
# segundos sólo multiplica los cadáveres. El atajo por entorno no es bandera, por lo mismo
# que los del conductor: nadie lo toca en una corrida normal, pero una prueba no puede
# tardar media hora en comprobar que se rinde.
espera_de() {
  case "$1" in
    1) echo 30 ;; 2) echo 120 ;; 3) echo 300 ;; *) echo 900 ;;
  esac
}

anotar 'supervisor_arranque' ",\"pid\":$$,\"diario\":\"$(json_txt "$DIARIO_ABS")\",\"comando\":\"$(json_txt "$*")\",\"max_relanzamientos\":$MAX_RELANZAMIENTOS"
escribir "supervisando: $*"

relanzamientos=0
codigo_final=0

while : ; do
  if [ -f "$DIARIO_ABS" ]; then antes="$(wc -l <"$DIARIO_ABS" | tr -d ' ')"; else antes=0; fi
  inicio="$(date +%s)"

  "$@"
  codigo=$?

  duracion_s=$(( $(date +%s) - inicio ))
  duracion_min=$(( duracion_s / 60 ))

  # La ventana de esta corrida y nada más: el archivo acumula corridas de días, y una
  # `parada` de ayer no dice nada de la de hoy.
  ventana="$(tail -n +$((antes + 1)) "$DIARIO_ABS" 2>/dev/null)"

  # El grep literal es seguro y no es una casualidad: `JSON.stringify` escapa las comillas
  # de cualquier valor anidado, así que un `detalle` que citara una línea del diario
  # aparecería como \"evento\":\"parada\" y no como "evento":"parada". La única forma de que
  # este texto aparezca sin escapar es que sea de verdad la clave.
  marcador=''
  printf '%s\n' "$ventana" | grep -E '"evento":"(parada|arranque)"' >/dev/null 2>&1 && {
    marcador="$(printf '%s\n' "$ventana" \
      | grep -E '"evento":"(parada|arranque)"' \
      | tail -1 \
      | sed -n 's/.*"evento":"\(parada\|arranque\)".*/\1/p')"
  }
  linea_arranque="$(printf '%s\n' "$ventana" | grep -F '"evento":"arranque"' | tail -1)"
  if [ -n "$linea_arranque" ]; then
    PROYECTO_URL="$(printf '%s' "$linea_arranque" | sed -n 's/.*"project_url":"\([^"]*\)".*/\1/p')"
    AGENTE_NOMBRE="$(printf '%s' "$linea_arranque" | sed -n 's/.*"agent_name":"\([^"]*\)".*/\1/p')"
  fi

  if [ "$marcador" = 'parada' ]; then
    escribir "el conductor paró por su cuenta (código $codigo); respeto su decisión"
    anotar 'supervisor_parada' ",\"motivo\":\"decision_del_conductor\",\"exit_code\":$codigo,\"duracion_min\":$duracion_min"
    codigo_final=$codigo
    break
  fi
  if [ -z "$marcador" ]; then
    # Ni siquiera llegó a escribir su arranque: murió antes de conducir nada, que es lo que
    # hace un error de configuración. Relanzarlo repetiría el mismo error cinco veces.
    escribir "el conductor no llegó a conducir (código $codigo); no lo relanzo"
    anotar 'supervisor_parada' ",\"motivo\":\"no_llego_a_conducir\",\"exit_code\":$codigo"
    codigo_final=$codigo
    break
  fi

  if [ "$duracion_min" -ge "$CORRIDA_SANA_MIN" ] && [ "$relanzamientos" -gt 0 ]; then
    escribir "la corrida anterior duró $duracion_min min: cuento esta muerte como nueva"
    relanzamientos=0
  fi
  relanzamientos=$((relanzamientos + 1))
  detalle="el conductor murió sin escribir ninguna parada (código $codigo) tras $duracion_min min. No fue una decisión suya: lo mataron desde fuera."
  escribir "$detalle"

  if [ "$relanzamientos" -gt "$MAX_RELANZAMIENTOS" ]; then
    hechos=$((relanzamientos - 1))
    escribir "van $hechos relanzamientos y sigue muriendo; me rindo"
    anotar 'supervisor_rendicion' ",\"relanzamientos\":$hechos,\"exit_code\":$codigo"
    avisar '🛑' 'me rindo' "$detalle Van $hechos relanzamientos seguidos: esto no es un accidente. Mira qué está matando al conductor."
    codigo_final=$SALIDA_TOPE
    break
  fi

  espera_ms=$(( $(espera_de "$relanzamientos") * 1000 ))
  [ -n "${APTS_SUPERVISOR_BACKOFF_MS:-}" ] && espera_ms="$APTS_SUPERVISOR_BACKOFF_MS"
  anotar 'supervisor_muerte' ",\"exit_code\":$codigo,\"duracion_min\":$duracion_min,\"relanzamiento\":$relanzamientos,\"espera_ms\":$espera_ms"
  avisar '💀' 'muerte no decidida' "$detalle Relanzo (intento $relanzamientos de $MAX_RELANZAMIENTOS) en $((espera_ms / 1000)) s."
  escribir "relanzando en $((espera_ms / 1000)) s (intento $relanzamientos de $MAX_RELANZAMIENTOS)"
  # `sleep` de POSIX sólo garantiza segundos enteros; la fracción es para las pruebas y
  # donde no se admita se redondea hacia arriba, que es el lado seguro.
  if [ "$espera_ms" -lt 1000 ]; then
    sleep 0.2 2>/dev/null || sleep 1
  else
    sleep $((espera_ms / 1000))
  fi
  anotar 'supervisor_relanza' ",\"relanzamiento\":$relanzamientos"
  # El agente que dejó vivo el muerto lo resuelve el conductor al arrancar: lo espera y, si
  # no termina, le corta el grupo de procesos. Aquí no se mata nada — identificarlo exige
  # saber qué proceso lanzó cada quién, y eso lo sabe el conductor y no este script.
done

exit "$codigo_final"
