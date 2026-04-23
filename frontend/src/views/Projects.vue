<template>
  <div class="space-y-8 animate-fade-in pb-8 relative p-6">
    <div class="flex items-center justify-between mb-8">
      <h2 class="text-3xl font-extrabold text-white tracking-tight flex items-center">
        <svg class="w-6 h-6 mr-3 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"></path></svg>
        Registro Global de Proyectos
      </h2>
      <button 
        @click="fetchProjects" 
        :disabled="loading"
        class="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-md text-sm font-medium transition-colors shadow-lg shadow-indigo-900/20 disabled:opacity-50 flex items-center space-x-2"
      >
        <svg v-if="loading" class="animate-spin h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
        <svg v-else class="h-4 w-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
        <span>Actualizar</span>
      </button>
    </div>

    <div class="bg-gray-900/60 backdrop-blur-xl rounded-2xl border border-gray-800 shadow-xl overflow-hidden relative">
      <div class="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-indigo-500/30 to-transparent"></div>
      
      <DataTable :value="projects" :paginator="true" :rows="10" 
        dataKey="url" :loading="loading"
        @row-click="onRowClick"
        class="w-full text-sm" 
        :pt="{
          headerRow: { class: 'bg-gray-800/50' },
          row: { class: 'hover:bg-gray-800/80 cursor-pointer transition-colors border-b border-gray-800/50' },
          bodyCell: { class: 'py-4 px-4 border-none text-gray-300' },
          headerCell: { class: 'py-4 px-4 text-gray-400 font-semibold tracking-wider uppercase text-xs border-none bg-transparent' },
          paginator: { class: 'bg-transparent border-t border-gray-800/50' }
        }"
        responsiveLayout="scroll">
        
        <template #empty>
          <div class="p-8 text-center text-gray-500 font-medium">No se encontraron proyectos.</div>
        </template>
        
        <Column field="name" header="Nombre del Proyecto" sortable>
          <template #body="{ data }">
            <span class="font-bold text-gray-200">{{ data.name }}</span>
          </template>
        </Column>
        <Column field="url" header="URL" sortable>
          <template #body="{ data }">
            <span class="text-gray-400 text-xs truncate max-w-xs block" :title="data.url">{{ data.url }}</span>
          </template>
        </Column>
        <Column field="status" header="Estado" sortable>
          <template #body="{ data }">
            <span :class="['px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider', getStatusClass(data.status)]">
              {{ data.status }}
            </span>
          </template>
        </Column>
        <Column field="webhook_url" header="Webhook">
          <template #body="{ data }">
            <div class="flex items-center space-x-1.5" v-if="data.webhook_url">
              <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
              <span class="text-emerald-400 text-xs font-medium">Activo</span>
            </div>
            <div class="flex items-center space-x-1.5" v-else>
              <span class="w-2 h-2 rounded-full bg-gray-600"></span>
              <span class="text-gray-500 text-xs font-medium">Ninguno</span>
            </div>
          </template>
        </Column>
        <Column field="updated_at" header="Última Actualización" sortable>
          <template #body="{ data }">
            <span class="text-gray-400 text-xs">
              {{ new Date(data.updated_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) }}
            </span>
          </template>
        </Column>
      </DataTable>
    </div>

    <!-- Enhanced Dialog using Pass Through (pt) to match Tailwind theme nicely -->
    <Dialog v-model:visible="showDialog" 
      :pt="{
        root: { class: 'bg-gray-900 border border-gray-700 shadow-2xl rounded-2xl overflow-hidden' },
        header: { class: 'bg-gray-800/80 backdrop-blur-sm border-b border-gray-700/50 p-6 flex justify-between items-center' },
        title: { class: 'text-xl font-bold text-white flex items-center' },
        content: { class: 'bg-gray-900/90 p-6 max-h-[70vh] overflow-y-auto custom-scrollbar' },
        closeButton: { class: 'text-gray-400 hover:text-white transition-colors bg-gray-800 hover:bg-gray-700 rounded-full w-8 h-8 flex items-center justify-center border-none outline-none' }
      }"
      :style="{ width: '85vw', maxWidth: '1200px' }" 
      maximizable modal :dismissableMask="true">
      
      <template #header>
        <div class="flex items-center space-x-3">
          <div class="p-2 bg-indigo-500/20 rounded-lg">
            <svg class="w-6 h-6 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"></path></svg>
          </div>
          <div>
            <h2 class="text-xl font-bold text-white">{{ selectedProject?.name || 'Detalles del Proyecto' }}</h2>
            <p class="text-xs text-gray-400">{{ selectedProject?.url }}</p>
          </div>
        </div>
      </template>

      <div v-if="loadingDetails" class="flex justify-center items-center py-20">
        <div class="w-10 h-10 border-4 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin"></div>
      </div>
      
      <div v-else-if="selectedProject" class="space-y-8 animate-fade-in">
        
        <!-- Tasks Section -->
        <div>
          <div class="flex items-center space-x-2 mb-4">
            <div class="w-1 h-5 bg-indigo-500 rounded-full"></div>
            <h3 class="text-lg font-bold text-gray-200">Tareas Asociadas</h3>
          </div>
          
          <div class="bg-gray-800/40 rounded-xl border border-gray-700/50 overflow-hidden">
            <DataTable :value="projectTasks" :paginator="true" :rows="5" 
              class="w-full text-sm"
              :pt="{
                headerRow: { class: 'bg-gray-800/30' },
                row: { class: 'border-b border-gray-700/30 hover:bg-gray-800/50 transition-colors' },
                bodyCell: { class: 'py-3 px-4 border-none text-gray-300' },
                headerCell: { class: 'py-3 px-4 text-gray-400 text-xs font-semibold uppercase tracking-wider border-none bg-transparent' },
                paginator: { class: 'bg-transparent border-t border-gray-800/50' }
              }">
              
              <template #empty>
                <div class="p-6 text-center text-gray-500 text-sm">No hay tareas asignadas a este proyecto aún.</div>
              </template>

              <Column field="title" header="Título de la Tarea">
                <template #body="{ data }">
                  <span class="font-medium text-gray-300">{{ data.title }}</span>
                </template>
              </Column>
              <Column field="agent_name" header="Agente">
                <template #body="{ data }">
                  <div class="flex items-center space-x-2">
                    <div class="w-5 h-5 rounded-full bg-gradient-to-tr from-indigo-500 to-purple-500 flex items-center justify-center text-[9px] font-bold text-white">
                      {{ data.agent_name ? data.agent_name.charAt(0).toUpperCase() : '?' }}
                    </div>
                    <span class="text-xs text-gray-300">{{ data.agent_name || 'Sin asignar' }}</span>
                  </div>
                </template>
              </Column>
              <Column field="status" header="Estado">
                <template #body="{ data }">
                  <span :class="['px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider', getTaskStatusClass(data.status)]">
                    {{ data.status.replace('_', ' ') }}
                  </span>
                </template>
              </Column>
              <Column field="last_heartbeat" header="Última Señal">
                <template #body="{ data }">
                  <span class="text-xs text-gray-500 flex items-center">
                    <svg class="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                    {{ data.last_heartbeat ? new Date(data.last_heartbeat).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : 'Nunca' }}
                  </span>
                </template>
              </Column>
            </DataTable>
          </div>
        </div>

        <!-- Logs Section -->
        <div>
          <div class="flex items-center space-x-2 mb-4">
            <div class="w-1 h-5 bg-emerald-500 rounded-full"></div>
            <h3 class="text-lg font-bold text-gray-200">Logs de Ejecución</h3>
          </div>
          
          <div class="bg-gray-800/40 rounded-xl border border-gray-700/50 overflow-hidden">
            <DataTable :value="projectLogs" :paginator="true" :rows="5" 
              class="w-full text-sm"
              :pt="{
                headerRow: { class: 'bg-gray-800/30' },
                row: { class: 'border-b border-gray-700/30 hover:bg-gray-800/50 transition-colors' },
                bodyCell: { class: 'py-3 px-4 border-none text-gray-300' },
                headerCell: { class: 'py-3 px-4 text-gray-400 text-xs font-semibold uppercase tracking-wider border-none bg-transparent' },
                paginator: { class: 'bg-transparent border-t border-gray-800/50' }
              }">
              
              <template #empty>
                <div class="p-6 text-center text-gray-500 text-sm">No hay logs de ejecución registrados aún.</div>
              </template>

              <Column field="action_type" header="Acción">
                <template #body="{ data }">
                  <span class="text-xs font-medium text-gray-400">{{ data.action_type || 'update' }}</span>
                </template>
              </Column>
              <Column field="task_title" header="Contexto (Tarea)">
                <template #body="{ data }">
                  <span class="text-xs text-gray-500 truncate max-w-[150px] block" :title="data.task_title">{{ data.task_title || '-' }}</span>
                </template>
              </Column>
              <Column field="message" header="Mensaje">
                <template #body="{ data }">
                  <span class="text-sm text-gray-300 leading-snug">{{ data.message }}</span>
                </template>
              </Column>
              <Column field="created_at" header="Hora">
                <template #body="{ data }">
                  <span class="text-xs text-gray-500 whitespace-nowrap">
                    {{ new Date(data.created_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) }}
                  </span>
                </template>
              </Column>
            </DataTable>
          </div>
        </div>

      </div>
    </Dialog>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import Dialog from 'primevue/dialog';

const projects = ref([]);
const loading = ref(true);

const showDialog = ref(false);
const selectedProject = ref(null);
const loadingDetails = ref(false);
const projectTasks = ref([]);
const projectLogs = ref([]);

const fetchProjects = async () => {
  loading.value = true;
  try {
    const response = await fetch('/api/dashboard/projects');
    const data = await response.json();
    if (data.projects) {
      projects.value = data.projects;
    }
  } catch (error) {
    console.error('Failed to fetch projects', error);
  } finally {
    loading.value = false;
  }
};

const onRowClick = async (event) => {
  const url = event.data.url;
  selectedProject.value = event.data;
  showDialog.value = true;
  loadingDetails.value = true;
  
  try {
    const encodedUrl = encodeURIComponent(url);
    const response = await fetch(`/api/dashboard/projects/${encodedUrl}`);
    const data = await response.json();
    
    if (data.project) {
      projectTasks.value = data.tasks || [];
      projectLogs.value = data.logs || [];
    }
  } catch (error) {
    console.error('Failed to fetch project details', error);
  } finally {
    loadingDetails.value = false;
  }
};

const getStatusClass = (status) => {
  const map = {
    pending: 'bg-gray-500/10 text-gray-400',
    active: 'bg-emerald-500/10 text-emerald-400',
    blocked: 'bg-rose-500/10 text-rose-400',
    stalled: 'bg-amber-500/10 text-amber-400',
    completed: 'bg-emerald-500/10 text-emerald-400'
  };
  return map[status] || 'bg-gray-500/10 text-gray-400';
};

const getTaskStatusClass = (status) => {
  const map = {
    todo: 'bg-blue-500/10 text-blue-400',
    in_progress: 'bg-indigo-500/10 text-indigo-400',
    review: 'bg-purple-500/10 text-purple-400',
    done: 'bg-emerald-500/10 text-emerald-400',
    stalled: 'bg-amber-500/10 text-amber-400'
  };
  return map[status] || 'bg-gray-500/10 text-gray-400';
};

onMounted(() => {
  fetchProjects();
});
</script>

<style scoped>
.animate-fade-in {
  animation: fadeIn 0.4s ease-out;
}
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(5px); }
  to { opacity: 1; transform: translateY(0); }
}

.custom-scrollbar::-webkit-scrollbar {
  width: 6px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background-color: #374151;
  border-radius: 20px;
}
</style>
