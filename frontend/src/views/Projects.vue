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

        <!-- Backlog Section -->
        <div>
          <div class="flex items-center justify-between mb-4">
            <div class="flex items-center space-x-2">
              <div class="w-1 h-5 bg-fuchsia-500 rounded-full"></div>
              <h3 class="text-lg font-bold text-gray-200">Backlog Gestionado</h3>
            </div>
            <span class="text-xs font-medium text-gray-400">
              {{ projectBacklog.length }} item(s)
            </span>
          </div>

          <div class="bg-gray-800/40 rounded-xl border border-gray-700/50 overflow-hidden">
            <div class="p-4 border-b border-gray-700/40 bg-gray-900/30 space-y-3">
              <div class="flex items-center justify-between">
                <h4 class="text-sm font-semibold text-gray-200">Agregar item</h4>
                <span class="text-[11px] text-gray-500">Fuente de verdad del trabajo planificado</span>
              </div>

              <div class="grid grid-cols-1 md:grid-cols-4 gap-3">
                <input
                  v-model="newBacklog.title"
                  type="text"
                  placeholder="Título del backlog item"
                  class="md:col-span-2 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:ring-2 focus:ring-fuchsia-500/40"
                >
                <select
                  v-model="newBacklog.item_type"
                  class="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:ring-2 focus:ring-fuchsia-500/40"
                >
                  <option v-for="type in backlogTypeOptions" :key="type" :value="type">{{ type }}</option>
                </select>
                <select
                  v-model="newBacklog.status"
                  class="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:ring-2 focus:ring-fuchsia-500/40"
                >
                  <option v-for="status in backlogStatusOptions" :key="status" :value="status">{{ status }}</option>
                </select>
              </div>

              <div class="grid grid-cols-1 md:grid-cols-6 gap-3">
                <textarea
                  v-model="newBacklog.description"
                  rows="2"
                  placeholder="Descripción"
                  class="md:col-span-3 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:ring-2 focus:ring-fuchsia-500/40 resize-none"
                ></textarea>
                <textarea
                  v-model="newBacklog.acceptance_criteria"
                  rows="2"
                  placeholder="Criterios de aceptación"
                  class="md:col-span-3 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:ring-2 focus:ring-fuchsia-500/40 resize-none"
                ></textarea>
              </div>

              <div class="flex flex-wrap items-end gap-3">
                <div>
                  <label class="block text-[11px] uppercase tracking-wider text-gray-500 mb-1">Prioridad</label>
                  <input
                    v-model.number="newBacklog.priority"
                    type="number"
                    class="w-28 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:ring-2 focus:ring-fuchsia-500/40"
                  >
                </div>
                <div>
                  <label class="block text-[11px] uppercase tracking-wider text-gray-500 mb-1">Orden</label>
                  <input
                    v-model.number="newBacklog.sort_order"
                    type="number"
                    class="w-28 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:ring-2 focus:ring-fuchsia-500/40"
                  >
                </div>
                <button
                  @click="createBacklogItem"
                  :disabled="isSavingBacklog || !newBacklog.title.trim()"
                  class="ml-auto px-4 py-2 bg-fuchsia-600 hover:bg-fuchsia-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
                >
                  {{ isSavingBacklog ? 'Guardando...' : 'Agregar al Backlog' }}
                </button>
              </div>
            </div>

            <DataTable :value="projectBacklog" :paginator="true" :rows="6"
              class="w-full text-sm"
              :pt="{
                headerRow: { class: 'bg-gray-800/30' },
                row: { class: 'border-b border-gray-700/30 hover:bg-gray-800/50 transition-colors' },
                bodyCell: { class: 'py-3 px-4 border-none text-gray-300' },
                headerCell: { class: 'py-3 px-4 text-gray-400 text-xs font-semibold uppercase tracking-wider border-none bg-transparent' },
                paginator: { class: 'bg-transparent border-t border-gray-800/50' }
              }">

              <template #empty>
                <div class="p-6 text-center text-gray-500 text-sm">No hay backlog para este proyecto todavía.</div>
              </template>

              <Column field="priority" header="Prioridad" sortable>
                <template #body="{ data }">
                  <span class="text-xs font-semibold text-gray-200">{{ data.priority }}</span>
                </template>
              </Column>

              <Column field="sort_order" header="Orden" sortable>
                <template #body="{ data }">
                  <span class="text-xs text-gray-400">{{ data.sort_order }}</span>
                </template>
              </Column>

              <Column field="title" header="Título" sortable>
                <template #body="{ data }">
                  <div>
                    <p class="font-medium text-gray-200">{{ data.title }}</p>
                    <p v-if="data.description" class="text-xs text-gray-500 truncate max-w-[260px]" :title="data.description">
                      {{ data.description }}
                    </p>
                  </div>
                </template>
              </Column>

              <Column field="item_type" header="Tipo" sortable>
                <template #body="{ data }">
                  <span class="text-xs uppercase tracking-wider text-gray-400">{{ data.item_type }}</span>
                </template>
              </Column>

              <Column field="status" header="Estado" sortable>
                <template #body="{ data }">
                  <span :class="['px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider', getBacklogStatusClass(data.status)]">
                    {{ data.status.replace('_', ' ') }}
                  </span>
                </template>
              </Column>

              <Column header="Task Activa">
                <template #body="{ data }">
                  <span v-if="data.active_task_id" class="text-xs text-indigo-300">En ejecución</span>
                  <span v-else class="text-xs text-gray-500">-</span>
                </template>
              </Column>

              <Column header="Acciones">
                <template #body="{ data }">
                  <button
                    @click="openBacklogEditor(data)"
                    class="px-2.5 py-1 bg-gray-700/70 hover:bg-gray-700 text-gray-200 text-xs font-medium rounded transition-colors"
                  >
                    Editar
                  </button>
                </template>
              </Column>
            </DataTable>

            <div v-if="editingBacklog" class="m-4 p-4 rounded-xl border border-fuchsia-500/30 bg-fuchsia-500/5 space-y-3">
              <div class="flex items-center justify-between">
                <h4 class="text-sm font-semibold text-fuchsia-300">Editar backlog item</h4>
                <button
                  @click="cancelBacklogEdit"
                  class="text-xs text-gray-400 hover:text-white transition-colors"
                >
                  Cancelar
                </button>
              </div>

              <div class="grid grid-cols-1 md:grid-cols-4 gap-3">
                <input
                  v-model="editingBacklog.title"
                  type="text"
                  class="md:col-span-2 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:ring-2 focus:ring-fuchsia-500/40"
                >
                <select
                  v-model="editingBacklog.item_type"
                  class="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:ring-2 focus:ring-fuchsia-500/40"
                >
                  <option v-for="type in backlogTypeOptions" :key="`edit-${type}`" :value="type">{{ type }}</option>
                </select>
                <select
                  v-model="editingBacklog.status"
                  class="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:ring-2 focus:ring-fuchsia-500/40"
                >
                  <option v-for="status in backlogStatusOptions" :key="`edit-${status}`" :value="status">{{ status }}</option>
                </select>
              </div>

              <div class="grid grid-cols-1 md:grid-cols-6 gap-3">
                <textarea
                  v-model="editingBacklog.description"
                  rows="2"
                  class="md:col-span-3 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:ring-2 focus:ring-fuchsia-500/40 resize-none"
                ></textarea>
                <textarea
                  v-model="editingBacklog.acceptance_criteria"
                  rows="2"
                  class="md:col-span-3 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:ring-2 focus:ring-fuchsia-500/40 resize-none"
                ></textarea>
              </div>

              <div class="flex flex-wrap items-end gap-3">
                <div>
                  <label class="block text-[11px] uppercase tracking-wider text-fuchsia-200/70 mb-1">Prioridad</label>
                  <input
                    v-model.number="editingBacklog.priority"
                    type="number"
                    class="w-28 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:ring-2 focus:ring-fuchsia-500/40"
                  >
                </div>
                <div>
                  <label class="block text-[11px] uppercase tracking-wider text-fuchsia-200/70 mb-1">Orden</label>
                  <input
                    v-model.number="editingBacklog.sort_order"
                    type="number"
                    class="w-28 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:ring-2 focus:ring-fuchsia-500/40"
                  >
                </div>
                <button
                  @click="saveBacklogItem"
                  :disabled="isSavingBacklog || !editingBacklog.title?.trim()"
                  class="ml-auto px-4 py-2 bg-fuchsia-600 hover:bg-fuchsia-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
                >
                  {{ isSavingBacklog ? 'Guardando...' : 'Guardar cambios' }}
                </button>
              </div>
            </div>

            <div v-if="backlogError" class="mx-4 mb-4 p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-sm text-rose-300">
              {{ backlogError }}
            </div>
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
const projectBacklog = ref([]);
const projectLogs = ref([]);
const backlogError = ref(null);
const isSavingBacklog = ref(false);
const editingBacklog = ref(null);

const backlogTypeOptions = ['feature', 'bug', 'chore', 'research'];
const backlogStatusOptions = ['draft', 'ready', 'in_progress', 'review', 'blocked', 'done', 'archived'];

const getInitialBacklogForm = () => ({
  title: '',
  description: '',
  acceptance_criteria: '',
  item_type: 'feature',
  status: 'ready',
  priority: 100,
  sort_order: 0
});

const newBacklog = ref(getInitialBacklogForm());

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

const fetchProjectDetails = async (url) => {
  loadingDetails.value = true;
  backlogError.value = null;
  editingBacklog.value = null;

  try {
    const encodedUrl = encodeURIComponent(url);
    const response = await fetch(`/api/dashboard/projects/${encodedUrl}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to fetch project details');
    }

    if (data.project) {
      projectTasks.value = data.tasks || [];
      projectBacklog.value = data.backlog || [];
      projectLogs.value = data.logs || [];
    }
  } catch (error) {
    backlogError.value = error.message;
    console.error('Failed to fetch project details', error);
  } finally {
    loadingDetails.value = false;
  }
};

const onRowClick = async (event) => {
  const url = event.data.url;
  selectedProject.value = event.data;
  showDialog.value = true;
  await fetchProjectDetails(url);
};

const createBacklogItem = async () => {
  if (!selectedProject.value?.url || !newBacklog.value.title.trim()) {
    return;
  }

  isSavingBacklog.value = true;
  backlogError.value = null;

  try {
    const encodedUrl = encodeURIComponent(selectedProject.value.url);
    const response = await fetch(`/api/dashboard/projects/${encodedUrl}/backlog`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: newBacklog.value.title.trim(),
        description: newBacklog.value.description || null,
        acceptance_criteria: newBacklog.value.acceptance_criteria || null,
        item_type: newBacklog.value.item_type,
        status: newBacklog.value.status,
        priority: Number.parseInt(newBacklog.value.priority, 10),
        sort_order: Number.parseInt(newBacklog.value.sort_order, 10),
        source_kind: 'dashboard',
        source_ref: 'projects-view'
      })
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to create backlog item');
    }

    newBacklog.value = getInitialBacklogForm();
    await fetchProjectDetails(selectedProject.value.url);
  } catch (error) {
    backlogError.value = error.message;
    console.error('Failed to create backlog item', error);
  } finally {
    isSavingBacklog.value = false;
  }
};

const openBacklogEditor = (item) => {
  editingBacklog.value = {
    ...item,
    priority: Number.parseInt(item.priority, 10),
    sort_order: Number.parseInt(item.sort_order, 10)
  };
  backlogError.value = null;
};

const cancelBacklogEdit = () => {
  editingBacklog.value = null;
};

const saveBacklogItem = async () => {
  if (!editingBacklog.value || !editingBacklog.value.title?.trim()) {
    return;
  }

  isSavingBacklog.value = true;
  backlogError.value = null;

  try {
    const response = await fetch(`/api/dashboard/backlog/${editingBacklog.value.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: editingBacklog.value.title.trim(),
        description: editingBacklog.value.description || null,
        acceptance_criteria: editingBacklog.value.acceptance_criteria || null,
        item_type: editingBacklog.value.item_type,
        status: editingBacklog.value.status,
        priority: Number.parseInt(editingBacklog.value.priority, 10),
        sort_order: Number.parseInt(editingBacklog.value.sort_order, 10)
      })
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to update backlog item');
    }

    await fetchProjectDetails(selectedProject.value.url);
  } catch (error) {
    backlogError.value = error.message;
    console.error('Failed to update backlog item', error);
  } finally {
    isSavingBacklog.value = false;
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

const getBacklogStatusClass = (status) => {
  const map = {
    draft: 'bg-gray-500/10 text-gray-400',
    ready: 'bg-blue-500/10 text-blue-400',
    in_progress: 'bg-indigo-500/10 text-indigo-400',
    review: 'bg-purple-500/10 text-purple-400',
    blocked: 'bg-rose-500/10 text-rose-400',
    done: 'bg-emerald-500/10 text-emerald-400',
    archived: 'bg-slate-500/10 text-slate-400'
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
