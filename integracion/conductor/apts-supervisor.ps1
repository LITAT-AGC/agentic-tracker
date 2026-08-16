#Requires -Version 5.1
<#
apts-supervisor — relanza el conductor de APTS cuando lo matan desde fuera, y NO lo relanza
cuando fue el conductor quien decidió parar.

ESTE ARCHIVO LLEVA BOM UTF-8 A PROPÓSITO, y hay que conservarlo al editarlo. Windows
PowerShell 5.1 —el que viene con el sistema, y el que va a ejecutar esto en una máquina
cualquiera— lee los `.ps1` sin BOM como ANSI, así que cada acento se parte y el proceso ni
siquiera llega a arrancar: falla al PARSEAR, con un «falta la llave de cierre» que no dice
nada de la causa. Es la única cosa de este repositorio que necesita BOM, y aquí es
obligatorio y no una preferencia. (Medido: sin BOM, `powershell.exe` no parsea este archivo;
`pwsh` 7 sí, porque asume UTF-8.)

  pwsh -File apts-supervisor.ps1 [-Diario ...] node apts-loop.js --agent-cmd "..." ...

El comando del conductor va al final y SIN `--` delante (PowerShell no admite ese separador:
lo lee como un nombre de parámetro vacío y aborta antes de entrar aquí).

POR QUÉ NO ES UN PROGRAMA DE NODE. Es la decisión que manda sobre todas las demás de este
archivo. El caso que esto viene a cerrar ocurrió el 2026-08-16: una sesión de agente de otra
ventana cerró un servidor Vite matando POR NOMBRE DE IMAGEN (`Stop-Process -Name node`) y se
llevó por delante los catorce procesos `node` de la máquina, incluido el conductor de una
corrida de 25 unidades. Un supervisor escrito en Node habría muerto en ese mismo barrido: es
inútil por construcción, exactamente igual que meter la defensa dentro de `apts-loop.js`,
que es el proceso al que matan. De ahí que esto sea un script de shell, y de ahí que haya
dos —éste y `apts-supervisor.sh`—: el precio de sobrevivir a la escoba es depender del
sistema operativo.

Por eso también lleva DENTRO lo mínimo. Todo lo que se pueda escribir una vez, en Node y
probado con el resto del repositorio, vive en el conductor: en particular el agente
huérfano, que es el problema difícil de aquí y se resuelve al arrancar (ver el README, «El
agente que sobrevive al conductor»). Este archivo sabe hacer tres cosas: lanzar, leer el
diario, y decidir si lo que pasó fue una decisión o una muerte.

LA REGLA, que es la única parte sin ambigüedad. El conductor escribe SIEMPRE un evento
`parada` en su diario cuando decide parar, con su motivo y su código. Así que:

  el diario de esta corrida dice…                   | qué fue        | qué se hace
  --------------------------------------------------|----------------|---------------------
  `arranque` y detrás `parada`                       | decidió él     | respeta el código
  `arranque` y NINGUNA `parada`                      | lo mataron     | relanza
  ni siquiera `arranque`                             | no llegó a conducir | respeta el código

No se mira el código de salida para decidirlo, y eso es deliberado: el 2026-08-16 el código
fue 255, que no es ninguno de los del conductor y no significa nada. Un código no distingue
«me mataron» de «terminé»; el diario sí, porque lo escribe quien decide.

Lo que NO hace: no relanza sobre una decisión (0, 10 a 16, 20 a 24 — todos son veredictos,
y relanzar encima es desobedecer al conductor), no supervisa `--daemon` (ver abajo), y no
mata nada: cortar al agente huérfano es del conductor, que sabe identificarlo.
#>
param(
  # El comando del conductor, tal cual se escribiría a mano, y va PRIMERO en el bloque a
  # propósito: es lo que hace que las banderas del conductor —`--journal`, `--agent-cmd`—
  # caigan aquí en vez de intentar bindearse contra los parámetros de este script.
  #
  # Y no lleva `--` delante, aunque sea lo que pide el dedo: PowerShell trata `--` como un
  # nombre de parámetro vacío y aborta con «the parameter name '' is ambiguous» antes de
  # que este archivo llegue a ejecutarse. Comprobado, no supuesto.
  [Parameter(Position = 0, ValueFromRemainingArguments = $true)]
  [string[]]$Comando,
  # El diario del conductor. Tiene que ser EL MISMO que el suyo: es el único canal por el
  # que un muerto puede decir si se murió a propósito.
  [string]$Diario = '.apts\apts-loop.jsonl',
  # Cuántas veces se relanza antes de rendirse. Si a un conductor lo matan cinco veces
  # seguidas no es un accidente, y seguir relanzando sólo quema crédito.
  [int]$MaxRelanzamientos = 5,
  # Una corrida que duró esto se considera sana, y el contador de relanzamientos vuelve a
  # cero: la muerte siguiente es un accidente nuevo y no la continuación de un bucle.
  [int]$CorridaSanaMin = 20,
  # De dónde salen el token y el chat de Telegram si no están en el entorno. Es el mismo
  # archivo que lee el conductor.
  [string]$Dotenv = '.env'
)

$ErrorActionPreference = 'Stop'

$NOMBRE = 'apts-supervisor'
$script:DiarioAbs = ''
# Códigos propios en una banda que no se pisa con la del conductor, para que quien envuelva
# esto pueda distinguir «el conductor terminó así» de «el supervisor no pudo trabajar».
$SALIDA_CONFIG = 40
$SALIDA_CERROJO = 41
$SALIDA_TOPE = 42

function Escribir([string]$mensaje) {
  [Console]::Error.WriteLine("[$NOMBRE] $mensaje")
}

function Ahora() {
  return (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
}

# ---- diario ----
#
# Se escribe en el MISMO archivo que el conductor y no en uno propio, porque lo que hace
# falta cuando se diagnostica esto es una sola línea de tiempo: la muerte, la espera al
# huérfano y el arranque siguiente leídos en orden. Los eventos van con prefijo para que
# nadie los confunda con los del conductor, y ninguno se llama `parada`: eso rompería la
# regla de arriba desde dentro.
function Anotar([System.Collections.IDictionary]$evento) {
  if (-not $script:DiarioAbs) { return }
  try {
    # `ts` delante y `evento` justo detrás, como los del conductor: hay lectores que
    # prefiltran por texto antes de parsear, y un orden distinto los dejaría ciegos.
    $orden = [ordered]@{ ts = (Ahora) }
    foreach ($k in $evento.Keys) { $orden[$k] = $evento[$k] }
    $linea = (ConvertTo-Json -InputObject $orden -Compress -Depth 6)
    $dir = Split-Path -Parent $script:DiarioAbs
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    # `Add-Content -Encoding UTF8` de Windows PowerShell escribe BOM al crear el archivo, y
    # un BOM en la primera línea de un NDJSON deja de ser JSON para quien lo lea entero.
    [System.IO.File]::AppendAllText($script:DiarioAbs, $linea + "`n", (New-Object System.Text.UTF8Encoding($false)))
  } catch {
    Escribir "aviso: no se pudo escribir el diario ($($_.Exception.Message))"
  }
}

function Leer-Diario() {
  if (-not (Test-Path -LiteralPath $script:DiarioAbs)) { return @() }
  try { return @(Get-Content -LiteralPath $script:DiarioAbs -Encoding UTF8 -ErrorAction Stop) } catch { return @() }
}

# El veredicto de la corrida que acaba de terminar, leyendo SÓLO lo que se escribió
# mientras corría: el archivo acumula corridas de días y una `parada` de ayer no dice nada
# de la de hoy.
#
# Se busca el ÚLTIMO marcador y no «alguna parada», porque en modo espera un mismo proceso
# encadena corridas y cada una deja la suya. Y el filtro barato por texto va antes del
# `ConvertFrom-Json` a propósito, pero no decide: quien decide es el JSON ya parseado, o un
# `detalle` que citara la palabra bastaría para que el supervisor se callara.
function Veredicto($lineas, [int]$desde) {
  $arranque = $null
  $ultimo = $null
  for ($i = $desde; $i -lt $lineas.Count; $i++) {
    $l = $lineas[$i]
    if ($l -notmatch '"evento":"(parada|arranque)"') { continue }
    $e = $null
    try { $e = $l | ConvertFrom-Json } catch { continue }
    if ($e.evento -eq 'arranque') { $ultimo = 'arranque'; $arranque = $e }
    elseif ($e.evento -eq 'parada') { $ultimo = 'parada' }
  }
  return [pscustomobject]@{ Marcador = $ultimo; Arranque = $arranque }
}

# ---- avisos ----
#
# Un conductor muerto no puede avisar de su propia muerte: eso es de aquí. El conductor ya
# manda Telegram al PARAR, o sea justo en el caso en que este archivo se calla.
function Cargar-Dotenv([string]$ruta) {
  $valores = @{}
  if (-not $ruta -or -not (Test-Path -LiteralPath $ruta)) { return $valores }
  try {
    foreach ($linea in (Get-Content -LiteralPath $ruta -Encoding UTF8)) {
      # El BOM de un `.env` escrito con el Bloc de notas se cuela en el nombre de la
      # primera clave; el conductor tropezó con esto y aquí pasaría lo mismo.
      $t = $linea.TrimStart([char]0xFEFF).Trim()
      if (-not $t -or $t.StartsWith('#')) { continue }
      $i = $t.IndexOf('=')
      if ($i -lt 1) { continue }
      $clave = $t.Substring(0, $i).Trim()
      $valor = $t.Substring($i + 1).Trim().Trim('"').Trim("'")
      $valores[$clave] = $valor
    }
  } catch { }
  return $valores
}

function Avisar([string]$marca, [string]$motivo, [string]$detalle) {
  if (-not $script:TelegramToken -or -not $script:TelegramChat) { return }
  $lineas = @("$marca APTS · supervisor · $motivo", '', $detalle, '')
  if ($script:ProyectoUrl) { $lineas += "proyecto: $($script:ProyectoUrl)" }
  if ($script:AgenteNombre) { $lineas += "agente: $($script:AgenteNombre)" }
  $texto = ($lineas -join "`n")
  if ($texto.Length -gt 3500) { $texto = $texto.Substring(0, 3500) }
  try {
    # TLS 1.2 explícito: Windows PowerShell 5.1 negocia SSL3/TLS1 por defecto y la API de
    # Telegram los rechaza, así que sin esto el aviso falla en la mitad de las máquinas.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $cuerpo = ConvertTo-Json -InputObject @{ chat_id = $script:TelegramChat; text = $texto; disable_web_page_preview = $true } -Compress
    Invoke-RestMethod -Method Post -Uri "$($script:TelegramApi)/bot$($script:TelegramToken)/sendMessage" `
      -ContentType 'application/json; charset=utf-8' `
      -Body ([System.Text.Encoding]::UTF8.GetBytes($cuerpo)) -TimeoutSec 10 | Out-Null
    Escribir 'aviso enviado por Telegram'
  } catch {
    # Un aviso que falla no puede cambiar lo que hace el supervisor. Se dice y se sigue, y
    # el token nunca se imprime: viaja dentro de la URL.
    $m = $_.Exception.Message
    if ($script:TelegramToken) { $m = $m.Replace($script:TelegramToken, '<token>') }
    Escribir "aviso: no se pudo avisar por Telegram ($m)"
  }
}

# ---- cerrojo ----
#
# Dos conductores con el mismo `--agent-name` se pelean por el claim, así que dos
# supervisores sobre el mismo diario son la forma segura de provocar justo lo que esto
# evita. El cerrojo lleva el PID DENTRO y se comprueba contra el proceso vivo, porque tiene
# que sobrevivir a que maten al supervisor: un archivo que sólo existe o no existe dejaría
# el diario bloqueado para siempre después del primer barrido de procesos.
#
# Y no basta el PID: los números se reciclan. Se guarda además la hora de arranque del
# proceso, que es lo que distingue «mi dueño sigue vivo» de «alguien heredó su número».
function Tomar-Cerrojo([string]$ruta) {
  if (Test-Path -LiteralPath $ruta) {
    $duenio = $null
    try { $duenio = (Get-Content -LiteralPath $ruta -Raw -Encoding UTF8) | ConvertFrom-Json } catch { $duenio = $null }
    if ($duenio -and $duenio.pid) {
      $p = $null
      try { $p = Get-Process -Id ([int]$duenio.pid) -ErrorAction Stop } catch { $p = $null }
      if ($p) {
        $mismo = $true
        if ($duenio.inicio) {
          try { $mismo = ($p.StartTime.ToUniversalTime().ToString('o') -eq [string]$duenio.inicio) } catch { $mismo = $false }
        }
        if ($mismo) { return $false }
      }
    }
    # El dueño ya no existe: se pisa. Es exactamente el caso de un supervisor al que
    # mataron, y negarse aquí sería dejar el trabajo parado por un archivo huérfano.
    Escribir 'el cerrojo era de un supervisor que ya no existe; lo piso'
  }
  $inicio = ''
  try { $inicio = (Get-Process -Id $PID).StartTime.ToUniversalTime().ToString('o') } catch { $inicio = '' }
  $dir = Split-Path -Parent $ruta
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $json = ConvertTo-Json -InputObject ([ordered]@{ pid = $PID; inicio = $inicio; diario = $script:DiarioAbs; desde = (Ahora) }) -Compress
  [System.IO.File]::WriteAllText($ruta, $json, (New-Object System.Text.UTF8Encoding($false)))
  return $true
}

# ---- arranque ----

if (-not $Comando -or $Comando.Count -eq 0) {
  Escribir 'falta el comando del conductor. Uso: apts-supervisor.ps1 [-Diario ...] node apts-loop.js --agent-cmd "..."'
  exit $SALIDA_CONFIG
}
if ($Comando -contains '--daemon') {
  # El modo espera no se supervisa, y no es un olvido. Ahí un mismo proceso encadena
  # corridas y cada `parada` termina UNA sin terminar el proceso, así que la regla de este
  # archivo —«su última palabra fue una parada»— deja de significar lo mismo. Además su
  # resiliencia es otro problema: lo arranca y lo para el panel, no una corrida acotada.
  Escribir 'este supervisor no supervisa --daemon: en modo espera una parada termina una corrida y no el proceso, y la regla del diario deja de decidir. Supervisa una corrida acotada.'
  exit $SALIDA_CONFIG
}
if ($Comando -contains 'off') {
  # `--journal off` deja al supervisor sin el único canal por el que un muerto habla.
  $i = [array]::IndexOf($Comando, 'off')
  if ($i -gt 0 -and $Comando[$i - 1] -eq '--journal') {
    Escribir 'el conductor lleva --journal off: sin diario no hay forma de saber si paró él o lo mataron.'
    exit $SALIDA_CONFIG
  }
}

# `Join-Path` con una ruta ya absoluta las pega una detrás de otra en vez de quedarse con
# la segunda, así que se pregunta antes.
if ([System.IO.Path]::IsPathRooted($Diario)) {
  $script:DiarioAbs = [System.IO.Path]::GetFullPath($Diario)
} else {
  $script:DiarioAbs = [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $Diario))
}
# El cerrojo se nombra por el DIARIO y no por la carpeta: lo que no puede duplicarse es la
# corrida, y una corrida se identifica por su diario. Dos proyectos distintos tienen
# diarios distintos aunque a alguien se le ocurra ponerlos en la misma carpeta.
$cerrojoRuta = "$($script:DiarioAbs).lock"

$entorno = Cargar-Dotenv $Dotenv
function Del-Entorno([string]$clave) {
  $v = [Environment]::GetEnvironmentVariable($clave)
  if ($v) { return $v }
  if ($entorno.ContainsKey($clave)) { return $entorno[$clave] }
  return ''
}
$script:TelegramToken = Del-Entorno 'APTS_LOOP_TELEGRAM_TOKEN'
$script:TelegramChat = Del-Entorno 'APTS_LOOP_TELEGRAM_CHAT_ID'
$script:TelegramApi = Del-Entorno 'APTS_LOOP_TELEGRAM_API'
if (-not $script:TelegramApi) { $script:TelegramApi = 'https://api.telegram.org' }
$script:ProyectoUrl = ''
$script:AgenteNombre = ''

# La espera entre relanzamientos crece: si el que mata sigue ahí, insistir cada treinta
# segundos sólo multiplica los cadáveres. El atajo por entorno no es bandera y existe por lo
# mismo que los del conductor: nadie lo toca en una corrida normal, pero una prueba no puede
# tardar media hora en comprobar que se rinde.
$ESPERAS_S = @(30, 120, 300, 900, 900)
$esperaFija = -1
if ($env:APTS_SUPERVISOR_BACKOFF_MS) {
  $tmp = 0
  if ([int]::TryParse($env:APTS_SUPERVISOR_BACKOFF_MS, [ref]$tmp)) { $esperaFija = $tmp }
}

if (-not (Tomar-Cerrojo $cerrojoRuta)) {
  Escribir "ya hay un supervisor vivo sobre este diario ($cerrojoRuta). No arranco un segundo."
  exit $SALIDA_CERROJO
}

$codigoFinal = 0
$relanzamientos = 0
try {
  Anotar ([ordered]@{ evento = 'supervisor_arranque'; pid = $PID; diario = $script:DiarioAbs; comando = ($Comando -join ' '); max_relanzamientos = $MaxRelanzamientos })
  Escribir "supervisando: $($Comando -join ' ')"

  while ($true) {
    $antes = (Leer-Diario).Count
    $inicio = Get-Date
    $codigo = 0
    try {
      # Splatting con una VARIABLE (`@resto`), no con `@(...)`: eso último es un
      # subexpresión de array y le pasaría la lista entera como un solo argumento.
      if ($Comando.Count -gt 1) {
        $resto = $Comando[1..($Comando.Count - 1)]
        & $Comando[0] @resto
      } else {
        & $Comando[0]
      }
      $codigo = $LASTEXITCODE
      if ($null -eq $codigo) { $codigo = 0 }
    } catch {
      Escribir "no se pudo ejecutar el conductor: $($_.Exception.Message)"
      Anotar ([ordered]@{ evento = 'supervisor_parada'; motivo = 'comando_invalido'; detalle = $_.Exception.Message })
      $codigoFinal = $SALIDA_CONFIG
      break
    }
    $duracionMin = ((Get-Date) - $inicio).TotalMinutes

    $v = Veredicto (Leer-Diario) $antes
    if ($v.Arranque) {
      if ($v.Arranque.PSObject.Properties.Name -contains 'project_url') { $script:ProyectoUrl = [string]$v.Arranque.project_url }
      if ($v.Arranque.PSObject.Properties.Name -contains 'agent_name') { $script:AgenteNombre = [string]$v.Arranque.agent_name }
    }

    if ($v.Marcador -eq 'parada') {
      Escribir "el conductor paró por su cuenta (código $codigo); respeto su decisión"
      Anotar ([ordered]@{ evento = 'supervisor_parada'; motivo = 'decision_del_conductor'; exit_code = $codigo; duracion_min = [math]::Round($duracionMin, 1) })
      $codigoFinal = $codigo
      break
    }
    if (-not $v.Marcador) {
      # Ni siquiera llegó a escribir su arranque: murió antes de conducir nada, que es lo
      # que hace un error de configuración. Relanzarlo repetiría el mismo error cinco veces.
      Escribir "el conductor no llegó a conducir (código $codigo); no lo relanzo"
      Anotar ([ordered]@{ evento = 'supervisor_parada'; motivo = 'no_llego_a_conducir'; exit_code = $codigo })
      $codigoFinal = $codigo
      break
    }

    # Arrancó y nunca dijo que paraba: lo mataron.
    if ($duracionMin -ge $CorridaSanaMin -and $relanzamientos -gt 0) {
      Escribir "la corrida anterior duró $([math]::Round($duracionMin, 1)) min: cuento esta muerte como nueva"
      $relanzamientos = 0
    }
    $relanzamientos++
    $detalle = "el conductor murió sin escribir ninguna parada (código $codigo) tras $([math]::Round($duracionMin, 1)) min." `
      + ' No fue una decisión suya: lo mataron desde fuera.'
    Escribir $detalle

    if ($relanzamientos -gt $MaxRelanzamientos) {
      Escribir "van $($relanzamientos - 1) relanzamientos y sigue muriendo; me rindo"
      Anotar ([ordered]@{ evento = 'supervisor_rendicion'; relanzamientos = ($relanzamientos - 1); exit_code = $codigo })
      Avisar '🛑' 'me rindo' ($detalle + " Van $($relanzamientos - 1) relanzamientos seguidos: esto no es un accidente. Mira qué está matando al conductor.")
      $codigoFinal = $SALIDA_TOPE
      break
    }

    $espera = $ESPERAS_S[[math]::Min($relanzamientos - 1, $ESPERAS_S.Count - 1)]
    $esperaMs = $espera * 1000
    if ($esperaFija -ge 0) { $esperaMs = $esperaFija }
    Anotar ([ordered]@{ evento = 'supervisor_muerte'; exit_code = $codigo; duracion_min = [math]::Round($duracionMin, 1); relanzamiento = $relanzamientos; espera_ms = $esperaMs })
    Avisar '💀' 'muerte no decidida' ($detalle + " Relanzo (intento $relanzamientos de $MaxRelanzamientos) en $([math]::Round($esperaMs / 1000)) s.")
    Escribir "relanzando en $([math]::Round($esperaMs / 1000)) s (intento $relanzamientos de $MaxRelanzamientos)"
    Start-Sleep -Milliseconds $esperaMs
    Anotar ([ordered]@{ evento = 'supervisor_relanza'; relanzamiento = $relanzamientos })
    # El agente que dejó vivo el muerto lo resuelve el conductor al arrancar: espera a que
    # termine y, si no termina, le corta el árbol. Aquí no se mata nada — identificarlo
    # exige saber qué proceso lanzó cada quién, y eso lo sabe el conductor y no este script.
  }
} finally {
  try { if (Test-Path -LiteralPath $cerrojoRuta) { Remove-Item -LiteralPath $cerrojoRuta -Force } } catch { }
}

exit $codigoFinal
