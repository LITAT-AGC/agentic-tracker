<template>
  <div class="space-y-8 animate-fade-in pb-8 relative">
    <div class="flex items-center justify-between">
      <h2 class="text-3xl font-extrabold tracking-tight">Resumen del Sistema</h2>
      <Button
        @click="refreshData"
        :loading="dashboard.isLoading"
        icon="pi pi-refresh"
        label="Actualizar"
        size="small"
      />
    </div>

    <!-- Alerta de error -->
    <Message v-if="dashboard.error" severity="error" :closable="false">
      <span class="font-medium">Error al cargar los datos:</span> {{ dashboard.error }}
    </Message>

    <!-- KPIs -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
      <Card v-for="kpi in kpis" :key="kpi.label" class="border border-surface-200">
        <template #content>
          <div class="flex items-center justify-between">
            <h3 class="text-surface-500 text-xs uppercase tracking-widest font-semibold">{{ kpi.label }}</h3>
            <span class="p-2 rounded-lg" :class="kpi.iconWrap">
              <i :class="kpi.icon" class="text-lg"></i>
            </span>
          </div>
          <p class="text-4xl font-black mt-4 tracking-tight" :class="kpi.valueClass">{{ kpi.value }}</p>
        </template>
      </Card>
    </div>

    <!-- Consumo OpenRouter -->
    <Card class="border border-surface-200">
      <template #content>
        <div class="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h3 class="text-xl font-bold">Consumo OpenRouter</h3>
            <p class="text-sm text-surface-500 mt-1">Tokens usados por día (últimos {{ dashboard.openrouterUsage.days || 14 }} días)</p>
          </div>
          <div class="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-surface-500">
            <p>Prompt: <span class="text-surface-700 font-semibold">{{ formatTokens(dashboard.openrouterTotals.prompt_tokens) }}</span></p>
            <p>Completion: <span class="text-surface-700 font-semibold">{{ formatTokens(dashboard.openrouterTotals.completion_tokens) }}</span></p>
            <p>Total tokens: <span class="text-surface-900 font-bold">{{ formatTokens(dashboard.openrouterTotals.total_tokens) }}</span></p>
            <p>Costo: <span class="text-emerald-600 font-semibold">{{ formatCredits(dashboard.openrouterTotals.total_cost) }}</span></p>
          </div>
        </div>

        <div class="mt-5 space-y-3" v-if="dashboard.openrouterTokensByDay.length">
          <div
            v-for="row in dashboard.openrouterTokensByDay"
            :key="row.date"
            class="grid grid-cols-[74px_minmax(0,1fr)_96px] items-center gap-3"
          >
            <span class="text-xs text-surface-500 font-medium">{{ formatDayLabel(row.date) }}</span>
            <div class="h-2.5 rounded-full bg-surface-200 overflow-hidden">
              <div
                class="h-full rounded-full bg-gradient-to-r from-cyan-500 to-primary-500 transition-all"
                :style="{ width: `${Math.max(2, Math.round((row.total_tokens / maxDailyTokens) * 100))}%` }"
              ></div>
            </div>
            <span class="text-right text-xs text-surface-600 font-semibold">{{ formatTokens(row.total_tokens) }}</span>
          </div>
        </div>

        <p v-else class="mt-5 text-sm text-surface-500">Aún no hay consumo registrado de OpenRouter.</p>
      </template>
    </Card>

    <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
      <!-- Tablero de tareas -->
      <div class="lg:col-span-2 flex flex-col h-full">
        <h3 class="text-xl font-bold mb-6 flex items-center gap-2">
          <i class="pi pi-clipboard text-primary-600"></i>
          Tablero de Tareas Activas
        </h3>

        <div v-if="dashboard.isLoading && dashboard.tasks.length === 0" class="flex-1 min-h-[300px] flex items-center justify-center bg-surface-100 rounded-2xl border border-dashed border-surface-200">
          <div class="flex flex-col items-center gap-4">
            <ProgressSpinner style="width: 2.5rem; height: 2.5rem" strokeWidth="4" />
            <p class="text-surface-500 font-medium">Cargando tareas...</p>
          </div>
        </div>

        <div v-else-if="dashboard.tasks.length === 0" class="flex-1 min-h-[300px] flex items-center justify-center bg-surface-100 rounded-2xl border border-dashed border-surface-200">
          <p class="text-surface-500 font-medium">No se encontraron tareas. Los agentes están inactivos.</p>
        </div>

        <div v-else class="grid grid-cols-1 sm:grid-cols-2 gap-4 flex-1 items-start">
          <Card v-for="task in dashboard.tasks" :key="task.id" class="border border-surface-200 h-full">
            <template #content>
              <div class="flex flex-col h-full">
                <div class="flex justify-between items-start mb-3">
                  <Tag :value="task.status.replace('_', ' ')" :severity="taskSeverity(task.status)" />
                  <span class="text-xs text-surface-500 font-medium">{{ new Date(task.created_at).toLocaleDateString() }}</span>
                </div>
                <h4 class="font-semibold text-lg leading-tight mb-2">{{ task.title }}</h4>
                <p class="text-xs text-surface-500 line-clamp-2 mb-4 flex-1">{{ task.project_url }}</p>
                <div class="flex items-center justify-between mt-auto pt-4 border-t border-surface-200">
                  <div class="flex items-center gap-2">
                    <Avatar :label="task.agent_name ? task.agent_name.charAt(0).toUpperCase() : '?'" shape="circle" size="normal"
                      :pt="{ root: { class: 'bg-primary text-primary-contrast text-xs font-bold' } }" />
                    <span class="text-xs font-medium text-surface-600">{{ task.agent_name || 'Sin asignar' }}</span>
                  </div>

                  <Button
                    v-if="task.status === 'stalled' || isProjectBlocked(task.project_url)"
                    @click="openResolveModal(task)"
                    label="Resolver"
                    severity="danger"
                    size="small"
                    outlined
                  />
                </div>
              </div>
            </template>
          </Card>
        </div>
      </div>

      <!-- Actividad en vivo -->
      <div class="flex flex-col h-full max-h-[800px]">
        <h3 class="text-xl font-bold mb-6 flex items-center gap-3">
          <span class="relative flex h-3 w-3">
            <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span class="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
          </span>
          Actividad en Vivo de Agentes
        </h3>

        <Card class="border border-surface-200 flex flex-col flex-1 overflow-hidden" :pt="{ body: { class: 'flex flex-col flex-1 p-0' }, content: { class: 'flex flex-col flex-1 min-h-0' } }">
          <template #content>
            <div v-if="dashboard.isLoading && dashboard.feed.length === 0" class="flex-1 p-8 flex items-center justify-center">
              <ProgressSpinner style="width: 2rem; height: 2rem" strokeWidth="4" />
            </div>

            <div v-else-if="dashboard.feed.length === 0" class="flex-1 p-8 flex items-center justify-center text-surface-500 text-sm">
              Esperando actividad del agente...
            </div>

            <div v-else class="flex-1 overflow-y-auto p-3 scrollbar-thin">
              <div class="space-y-3">
                <div v-for="log in dashboard.feed" :key="log.id"
                     class="p-4 rounded-xl bg-surface-100 border border-surface-200/50 hover:bg-surface-100 transition-colors">
                  <div class="flex items-center justify-between mb-2">
                    <div class="flex items-center gap-2">
                      <span class="text-xs font-bold text-primary-600">{{ log.agent_name }}</span>
                      <Tag v-if="log.action_type === 'error'" value="Error" severity="danger" />
                    </div>
                    <time class="text-[10px] text-surface-500 font-medium">{{ new Date(log.created_at).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) }}</time>
                  </div>
                  <p class="text-sm text-surface-600 leading-relaxed">{{ log.message }}</p>

                  <div class="flex items-center justify-between mt-3">
                    <p v-if="log.task_title" class="text-[10px] text-surface-500 truncate flex items-center gap-1 max-w-[70%]">
                      <i class="pi pi-info-circle"></i>
                      <span class="truncate">{{ log.task_title }}</span>
                    </p>

                    <Button
                      v-if="hasTechDetails(log)"
                      @click="openTechModal(log)"
                      label="Código"
                      icon="pi pi-code"
                      severity="secondary"
                      text
                      size="small"
                      class="ml-auto"
                    />
                  </div>
                </div>
              </div>
            </div>
          </template>
        </Card>
      </div>
    </div>

    <!-- Modal: Resolver Bloqueo -->
    <Dialog v-model:visible="showResolveModal" modal header="Resolver Bloqueo" :style="{ width: '32rem' }" :dismissableMask="true">
      <p class="text-sm text-surface-500 mb-4">
        Proporciona instrucciones humanas para desbloquear al agente en la tarea:
        <strong class="text-surface-700">{{ resolvingTask?.title }}</strong>
      </p>
      <Textarea v-model="resolveInstruction" rows="4" class="w-full" autoResize
        placeholder="Ingresa instrucciones detalladas para que el agente proceda..." />
      <template #footer>
        <Button label="Cancelar" severity="secondary" text @click="closeResolveModal" />
        <Button
          label="Desbloquear Agente"
          icon="pi pi-unlock"
          :loading="isResolving"
          :disabled="!resolveInstruction.trim()"
          @click="submitResolve"
        />
      </template>
    </Dialog>

    <!-- Drawer: Detalles técnicos -->
    <Dialog v-model:visible="showTechModal" modal header="Auditoría de Código" position="right"
      :style="{ width: '28rem', height: '100vh', margin: '0' }" :dismissableMask="true"
      :pt="{ root: { class: 'rounded-none' } }">
      <div v-if="activeTechDetails" class="space-y-6">
        <div v-if="activeTechDetails.outcome" class="flex items-center gap-2">
          <span class="text-sm text-surface-500">Resultado de Ejecución:</span>
          <Tag :value="activeTechDetails.outcome" :severity="activeTechDetails.outcome === 'success' ? 'success' : 'danger'" />
        </div>

        <div v-if="activeTechDetails.files_modified?.length">
          <h4 class="text-xs font-bold uppercase tracking-widest text-surface-500 mb-3">Archivos Modificados</h4>
          <ul class="space-y-2">
            <li v-for="file in activeTechDetails.files_modified" :key="file" class="flex items-center gap-2 text-sm text-surface-600 bg-surface-100 p-2 rounded border border-surface-200/50">
              <i class="pi pi-file text-amber-600 shrink-0"></i>
              <span class="truncate">{{ file }}</span>
            </li>
          </ul>
        </div>

        <div v-if="activeTechDetails.commands_run?.length">
          <h4 class="text-xs font-bold uppercase tracking-widest text-surface-500 mb-3">Comandos Ejecutados</h4>
          <div class="bg-black/50 rounded-lg p-3 border border-surface-200 font-mono text-xs text-emerald-600 overflow-x-auto">
            <div v-for="(cmd, i) in activeTechDetails.commands_run" :key="i" class="whitespace-nowrap">
              <span class="text-surface-500 mr-2">$</span>{{ cmd }}
            </div>
          </div>
        </div>
      </div>
    </Dialog>
  </div>
</template>

<script setup>
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { useDashboardStore } from '../stores/dashboard'

const dashboard = useDashboardStore()
let intervalId = null

// Estados de modales
const showResolveModal = ref(false)
const resolvingTask = ref(null)
const resolveInstruction = ref('')
const isResolving = ref(false)

const showTechModal = ref(false)
const activeTechDetails = ref(null)

const kpis = computed(() => [
  {
    label: 'Proyectos Activos',
    value: dashboard.activeProjectsCount,
    icon: 'pi pi-folder-open',
    iconWrap: 'bg-primary/10 text-primary-600',
    valueClass: 'text-surface-900'
  },
  {
    label: 'Proyectos Bloqueados',
    value: dashboard.blockedProjectsCount,
    icon: 'pi pi-exclamation-triangle',
    iconWrap: 'bg-rose-500/10 text-rose-600',
    valueClass: 'text-rose-600'
  },
  {
    label: 'Agentes Estancados',
    value: dashboard.stalledAgentsCount,
    icon: 'pi pi-clock',
    iconWrap: 'bg-amber-500/10 text-amber-600',
    valueClass: 'text-amber-600'
  }
])

const refreshData = async () => {
  try {
    await dashboard.fetchOverview()
  } catch (_err) {
  }
}

const maxDailyTokens = computed(() => {
  const values = dashboard.openrouterTokensByDay.map((row) => Number(row.total_tokens) || 0)
  return Math.max(...values, 1)
})

const formatTokens = (value) => {
  return new Intl.NumberFormat('es-ES').format(Number(value) || 0)
}

const formatCredits = (value) => {
  const amount = Number(value) || 0
  return `${amount.toFixed(6)} créditos`
}

const formatDayLabel = (isoDate) => {
  if (!isoDate) return '--/--'
  const parsed = new Date(`${isoDate}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) return isoDate
  return parsed.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' })
}

const taskSeverity = (status) => {
  const map = {
    completed: 'success',
    done: 'success',
    in_progress: 'info',
    stalled: 'warn',
    todo: 'secondary',
    review: 'contrast'
  }
  return map[status] || 'secondary'
}

// Helpers
const isProjectBlocked = (url) => {
  const project = dashboard.projects.find(p => p.url === url)
  return project && project.status === 'blocked'
}

const parseTechDetails = (details) => {
  if (!details) return null
  if (typeof details === 'object') return details
  try {
    return JSON.parse(details)
  } catch (e) {
    return null
  }
}

const hasTechDetails = (log) => {
  const details = parseTechDetails(log.technical_details)
  return details && (details.files_modified?.length || details.commands_run?.length)
}

// Interacción Resolver
const openResolveModal = (task) => {
  resolvingTask.value = task
  resolveInstruction.value = ''
  showResolveModal.value = true
}

const closeResolveModal = () => {
  showResolveModal.value = false
  resolvingTask.value = null
  resolveInstruction.value = ''
}

const submitResolve = async () => {
  if (!resolvingTask.value || !resolveInstruction.value.trim()) return

  isResolving.value = true
  try {
    await dashboard.resolveBlocker(resolvingTask.value.id, resolveInstruction.value)
    closeResolveModal()
  } catch (e) {
    alert('Error al resolver el bloqueo: ' + e.message)
  } finally {
    isResolving.value = false
  }
}

// Interacción modal técnico
const openTechModal = (log) => {
  activeTechDetails.value = parseTechDetails(log.technical_details)
  showTechModal.value = true
}

const closeTechModal = () => {
  showTechModal.value = false
  activeTechDetails.value = null
}

onMounted(async () => {
  await refreshData()
  // Auto refresh cada 30 segundos
  intervalId = setInterval(refreshData, 30000)
})

onUnmounted(() => {
  if (intervalId) clearInterval(intervalId)
})
</script>
