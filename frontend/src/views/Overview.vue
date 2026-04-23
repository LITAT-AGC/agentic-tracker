<template>
  <div class="space-y-8 animate-fade-in pb-8 relative">
    <div class="flex items-center justify-between">
      <h2 class="text-3xl font-extrabold text-white tracking-tight">Resumen del Sistema</h2>
      <button 
        @click="refreshData" 
        :disabled="dashboard.isLoading"
        class="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-md text-sm font-medium transition-colors shadow-lg shadow-indigo-900/20 disabled:opacity-50 flex items-center space-x-2"
      >
        <svg v-if="dashboard.isLoading" class="animate-spin h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
        <svg v-else class="h-4 w-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
        <span>Actualizar</span>
      </button>
    </div>
    
    <!-- Error Alert -->
    <div v-if="dashboard.error" class="bg-red-900/30 border border-red-500/50 p-4 rounded-xl flex items-start space-x-3">
      <svg class="h-5 w-5 text-red-400 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <div>
        <h3 class="text-red-400 font-medium">Error al cargar los datos</h3>
        <p class="text-red-300 text-sm mt-1">{{ dashboard.error }}</p>
      </div>
    </div>

    <!-- KPI Cards -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
      <div class="group bg-gray-900/60 backdrop-blur-xl p-6 rounded-2xl border border-gray-800 shadow-xl hover:border-indigo-500/50 hover:shadow-indigo-500/10 transition-all duration-300 transform hover:-translate-y-1">
        <div class="flex items-center justify-between">
          <h3 class="text-gray-400 text-xs uppercase tracking-widest font-semibold group-hover:text-indigo-400 transition-colors">Proyectos Activos</h3>
          <div class="p-2 bg-indigo-500/10 rounded-lg text-indigo-400">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"></path></svg>
          </div>
        </div>
        <p class="text-4xl font-black text-white mt-4 tracking-tight">{{ dashboard.activeProjectsCount }}</p>
      </div>
      
      <div class="group bg-gray-900/60 backdrop-blur-xl p-6 rounded-2xl border border-gray-800 shadow-xl hover:border-rose-500/50 hover:shadow-rose-500/10 transition-all duration-300 transform hover:-translate-y-1">
        <div class="flex items-center justify-between">
          <h3 class="text-gray-400 text-xs uppercase tracking-widest font-semibold group-hover:text-rose-400 transition-colors">Proyectos Bloqueados</h3>
          <div class="p-2 bg-rose-500/10 rounded-lg text-rose-400">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>
          </div>
        </div>
        <p class="text-4xl font-black text-rose-500 mt-4 tracking-tight">{{ dashboard.blockedProjectsCount }}</p>
      </div>
      
      <div class="group bg-gray-900/60 backdrop-blur-xl p-6 rounded-2xl border border-gray-800 shadow-xl hover:border-amber-500/50 hover:shadow-amber-500/10 transition-all duration-300 transform hover:-translate-y-1">
        <div class="flex items-center justify-between">
          <h3 class="text-gray-400 text-xs uppercase tracking-widest font-semibold group-hover:text-amber-400 transition-colors">Agentes Estancados</h3>
          <div class="p-2 bg-amber-500/10 rounded-lg text-amber-400">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
          </div>
        </div>
        <p class="text-4xl font-black text-amber-400 mt-4 tracking-tight">{{ dashboard.stalledAgentsCount }}</p>
      </div>
    </div>
    
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
      <!-- Task Kanban -->
      <div class="lg:col-span-2 flex flex-col h-full">
        <h3 class="text-xl font-bold text-gray-100 mb-6 flex items-center">
          <svg class="w-5 h-5 mr-2 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"></path></svg>
          Tablero de Tareas Activas
        </h3>
        
        <div v-if="dashboard.isLoading && dashboard.tasks.length === 0" class="flex-1 min-h-[300px] flex items-center justify-center bg-gray-900/30 rounded-2xl border border-gray-800 border-dashed">
          <div class="flex flex-col items-center space-y-4">
            <div class="w-10 h-10 border-4 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin"></div>
            <p class="text-gray-500 font-medium">Cargando tareas...</p>
          </div>
        </div>
        
        <div v-else-if="dashboard.tasks.length === 0" class="flex-1 min-h-[300px] flex items-center justify-center bg-gray-900/30 rounded-2xl border border-gray-800 border-dashed">
          <p class="text-gray-500 font-medium">No se encontraron tareas. Los agentes están inactivos.</p>
        </div>
        
        <div v-else class="grid grid-cols-1 sm:grid-cols-2 gap-4 flex-1 items-start">
          <div v-for="task in dashboard.tasks" :key="task.id" 
               class="bg-gray-800/40 backdrop-blur-sm p-5 rounded-xl border border-gray-700/50 hover:bg-gray-800/80 hover:border-gray-600 transition-all duration-300 flex flex-col group relative">
            <div class="flex justify-between items-start mb-3">
              <span class="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider rounded-md"
                    :class="{
                      'bg-emerald-500/10 text-emerald-400': task.status === 'completed' || task.status === 'done',
                      'bg-indigo-500/10 text-indigo-400': task.status === 'in_progress',
                      'bg-amber-500/10 text-amber-400': task.status === 'stalled',
                      'bg-blue-500/10 text-blue-400': task.status === 'todo',
                      'bg-purple-500/10 text-purple-400': task.status === 'review'
                    }">
                {{ task.status.replace('_', ' ') }}
              </span>
              <span class="text-xs text-gray-500 font-medium">{{ new Date(task.created_at).toLocaleDateString() }}</span>
            </div>
            <h4 class="text-white font-semibold text-lg leading-tight mb-2 group-hover:text-indigo-300 transition-colors">{{ task.title }}</h4>
            <p class="text-xs text-gray-400 line-clamp-2 mb-4 flex-1">{{ task.project_url }}</p>
            <div class="flex flex-col mt-auto pt-4 border-t border-gray-700/50 space-y-3">
              <div class="flex items-center justify-between">
                <div class="flex items-center">
                  <div class="w-6 h-6 rounded-full bg-gradient-to-tr from-indigo-500 to-purple-500 flex items-center justify-center text-[10px] font-bold text-white shadow-lg">
                    {{ task.agent_name ? task.agent_name.charAt(0).toUpperCase() : '?' }}
                  </div>
                  <span class="ml-2 text-xs font-medium text-gray-300">{{ task.agent_name || 'Sin asignar' }}</span>
                </div>
                
                <button v-if="task.status === 'stalled' || isProjectBlocked(task.project_url)" 
                        @click="openResolveModal(task)"
                        class="px-3 py-1 bg-rose-600/20 hover:bg-rose-600/40 text-rose-400 text-xs font-bold rounded transition-colors border border-rose-500/30">
                  Resolver
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
      
      <!-- Live Feed -->
      <div class="flex flex-col h-full max-h-[800px]">
        <h3 class="text-xl font-bold text-gray-100 mb-6 flex items-center">
          <span class="relative flex h-3 w-3 mr-3">
            <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span class="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
          </span>
          Actividad en Vivo de Agentes
        </h3>
        
        <div class="bg-gray-900/60 backdrop-blur-xl rounded-2xl border border-gray-800 shadow-xl overflow-hidden flex flex-col flex-1 relative">
          <!-- Glass reflection -->
          <div class="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent"></div>
          
          <div v-if="dashboard.isLoading && dashboard.feed.length === 0" class="flex-1 p-8 flex items-center justify-center">
             <div class="w-8 h-8 border-4 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin"></div>
          </div>
          
          <div v-else-if="dashboard.feed.length === 0" class="flex-1 p-8 flex items-center justify-center text-gray-500 text-sm">
            Esperando actividad del agente...
          </div>
          
          <div v-else class="flex-1 overflow-y-auto p-2 scrollbar-thin scrollbar-thumb-gray-700 scrollbar-track-transparent">
            <div class="space-y-1 relative before:absolute before:inset-0 before:ml-5 before:-translate-x-px md:before:mx-auto md:before:translate-x-0 before:h-full before:w-0.5 before:bg-gradient-to-b before:from-transparent before:via-gray-800 before:to-transparent">
              
              <div v-for="(log, idx) in dashboard.feed" :key="log.id" 
                   class="relative flex items-center justify-between md:justify-normal md:odd:flex-row-reverse group is-active py-3 pl-8 pr-4 md:px-0">
                
                <!-- Timeline dot -->
                <div class="absolute inset-0 left-5 flex items-center justify-center w-5 h-5 -translate-x-1/2 md:left-1/2 rounded-full bg-gray-900 border-2 border-gray-700 group-hover:border-indigo-500 transition-colors z-10">
                  <div class="w-1.5 h-1.5 rounded-full bg-gray-600 group-hover:bg-indigo-400 transition-colors"></div>
                </div>

                <div class="w-full md:w-[calc(50%-1.5rem)] p-4 rounded-xl bg-gray-800/30 border border-gray-700/50 hover:bg-gray-800/60 transition-colors shadow-sm relative">
                  <div class="flex items-center justify-between mb-2">
                    <div class="flex items-center space-x-2">
                      <span class="text-xs font-bold text-indigo-400">{{ log.agent_name }}</span>
                      <span v-if="log.action_type === 'error'" class="px-1.5 py-0.5 bg-rose-500/20 text-rose-400 text-[9px] rounded uppercase font-bold tracking-wider">Error</span>
                    </div>
                    <time class="text-[10px] text-gray-500 font-medium">{{ new Date(log.created_at).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) }}</time>
                  </div>
                  <p class="text-sm text-gray-300 leading-relaxed">{{ log.message }}</p>
                  
                  <div class="flex items-center justify-between mt-3">
                    <p v-if="log.task_title" class="text-[10px] text-gray-500 truncate flex items-center max-w-[70%]">
                      <svg class="w-3 h-3 mr-1 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                      <span class="truncate">{{ log.task_title }}</span>
                    </p>
                    
                    <button v-if="hasTechDetails(log)" 
                            @click="openTechModal(log)"
                            class="text-[10px] font-bold text-indigo-400 hover:text-indigo-300 bg-indigo-500/10 hover:bg-indigo-500/20 px-2 py-1 rounded transition-colors flex items-center ml-auto">
                      <svg class="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"></path></svg>
                      Código
                    </button>
                  </div>
                </div>
              </div>
              
            </div>
          </div>
        </div>
      </div>
    </div>
    
    <!-- Modal: Resolve Blocker -->
    <div v-if="showResolveModal" class="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" @click="closeResolveModal"></div>
      <div class="relative bg-gray-800 border border-gray-700 rounded-2xl shadow-2xl w-full max-w-lg p-6 animate-fade-in">
        <h3 class="text-xl font-bold text-white mb-2">Resolver Bloqueo</h3>
        <p class="text-sm text-gray-400 mb-6">Proporciona instrucciones humanas para desbloquear al agente en la tarea: <strong class="text-gray-200">{{ resolvingTask?.title }}</strong></p>
        
        <textarea 
          v-model="resolveInstruction" 
          rows="4" 
          class="w-full bg-gray-900 border border-gray-700 rounded-lg p-3 text-white text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-colors resize-none mb-4"
          placeholder="Ingresa instrucciones detalladas para que el agente proceda..."
        ></textarea>
        
        <div class="flex justify-end space-x-3">
          <button @click="closeResolveModal" class="px-4 py-2 text-sm font-medium text-gray-300 hover:text-white transition-colors">Cancelar</button>
          <button 
            @click="submitResolve" 
            :disabled="isResolving || !resolveInstruction.trim()"
            class="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors shadow-lg shadow-indigo-900/20 flex items-center"
          >
            <svg v-if="isResolving" class="animate-spin -ml-1 mr-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
            Desbloquear Agente
          </button>
        </div>
      </div>
    </div>

    <!-- Drawer: Technical Details -->
    <div v-if="showTechModal" class="fixed inset-0 z-50 flex justify-end">
      <div class="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity" @click="closeTechModal"></div>
      <div class="relative w-full max-w-md h-full bg-gray-900 border-l border-gray-700 shadow-2xl p-6 overflow-y-auto transform transition-transform animate-slide-in-right">
        <div class="flex justify-between items-center mb-6">
          <h3 class="text-lg font-bold text-white flex items-center">
            <svg class="w-5 h-5 mr-2 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"></path></svg>
            Auditoría de Código
          </h3>
          <button @click="closeTechModal" class="text-gray-400 hover:text-white transition-colors">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
          </button>
        </div>
        
        <div v-if="activeTechDetails" class="space-y-6">
          <div v-if="activeTechDetails.outcome" class="flex items-center space-x-2">
            <span class="text-sm text-gray-400">Resultado de Ejecución:</span>
            <span class="px-2 py-0.5 text-xs font-bold uppercase tracking-wider rounded"
                  :class="activeTechDetails.outcome === 'success' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'">
              {{ activeTechDetails.outcome }}
            </span>
          </div>

          <div v-if="activeTechDetails.files_modified?.length">
            <h4 class="text-xs font-bold uppercase tracking-widest text-gray-500 mb-3">Archivos Modificados</h4>
            <ul class="space-y-2">
              <li v-for="file in activeTechDetails.files_modified" :key="file" class="flex items-center text-sm text-gray-300 bg-gray-800/50 p-2 rounded border border-gray-700/50">
                <svg class="w-4 h-4 mr-2 text-amber-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>
                <span class="truncate">{{ file }}</span>
              </li>
            </ul>
          </div>
          
          <div v-if="activeTechDetails.commands_run?.length">
            <h4 class="text-xs font-bold uppercase tracking-widest text-gray-500 mb-3">Comandos Ejecutados</h4>
            <div class="bg-black/50 rounded-lg p-3 border border-gray-700 font-mono text-xs text-green-400 overflow-x-auto">
              <div v-for="(cmd, i) in activeTechDetails.commands_run" :key="i" class="whitespace-nowrap">
                <span class="text-gray-500 mr-2">$</span>{{ cmd }}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useDashboardStore } from '../stores/dashboard'

const dashboard = useDashboardStore()
const router = useRouter()
let intervalId = null

// Modal States
const showResolveModal = ref(false)
const resolvingTask = ref(null)
const resolveInstruction = ref('')
const isResolving = ref(false)

const showTechModal = ref(false)
const activeTechDetails = ref(null)

const refreshData = async () => {
  try {
    await dashboard.fetchOverview()
  } catch (err) {
    if (err.message === 'Unauthorized') {
      router.push('/login')
    }
  }
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

// Resolve Interaction
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

// Tech Modal Interaction
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
  // Auto refresh every 30 seconds
  intervalId = setInterval(refreshData, 30000)
})

onUnmounted(() => {
  if (intervalId) clearInterval(intervalId)
})
</script>

<style>
.scrollbar-thin::-webkit-scrollbar {
  width: 6px;
}
.scrollbar-thin::-webkit-scrollbar-track {
  background: transparent;
}
.scrollbar-thin::-webkit-scrollbar-thumb {
  background-color: #374151;
  border-radius: 20px;
}
.animate-fade-in {
  animation: fadeIn 0.4s ease-out;
}
.animate-slide-in-right {
  animation: slideInRight 0.3s ease-out;
}
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(5px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes slideInRight {
  from { opacity: 0; transform: translateX(100%); }
  to { opacity: 1; transform: translateX(0); }
}
</style>
