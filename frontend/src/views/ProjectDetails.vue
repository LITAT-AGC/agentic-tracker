<template>
  <div class="space-y-8 animate-fade-in pb-8 relative p-6">
    <div class="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
      <div class="flex items-start gap-3">
        <button
          @click="router.push('/dashboard/projects')"
          class="mt-1 inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-700 bg-gray-900/60 text-gray-300 text-sm hover:bg-gray-800 transition-colors"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"></path></svg>
          Volver a proyectos
        </button>

        <div>
          <h2 class="text-2xl md:text-3xl font-extrabold text-white tracking-tight">
            {{ selectedProject?.name || 'Detalle del Proyecto' }}
          </h2>
          <p class="mt-1 text-sm text-gray-400 break-all">{{ selectedProject?.url || 'Cargando información...' }}</p>
        </div>
      </div>

      <span
        v-if="selectedProject"
        :class="['inline-flex self-start px-3 py-1 rounded-md text-[11px] font-bold uppercase tracking-wider', getStatusClass(selectedProject.status)]"
      >
        {{ selectedProject.status }}
      </span>
    </div>

    <div v-if="loadingProject" class="flex justify-center items-center py-20">
      <div class="w-10 h-10 border-4 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin"></div>
    </div>

    <div v-else-if="loadError" class="rounded-xl border border-rose-500/30 bg-rose-500/10 p-6 text-rose-200">
      <p class="text-sm">{{ loadError }}</p>
    </div>

    <div v-else-if="selectedProject" class="space-y-8">
      <div>
        <div class="flex items-center space-x-2 mb-4">
          <div class="w-1 h-5 bg-indigo-500 rounded-full"></div>
          <h3 class="text-lg font-bold text-gray-200">Tareas Asociadas</h3>
        </div>

        <div class="bg-gray-800/40 rounded-xl border border-gray-700/50 overflow-hidden">
          <DataTable :value="projectTasks" :paginator="true" :rows="6"
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

      <div>
        <div class="flex items-center justify-between mb-4">
          <div class="flex items-center space-x-2">
            <div class="w-1 h-5 bg-fuchsia-500 rounded-full"></div>
            <h3 class="text-lg font-bold text-gray-200">Backlog Gestionado</h3>
          </div>
          <span class="text-xs font-medium text-gray-400">{{ projectBacklog.length }} item(s)</span>
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

          <DataTable :value="projectBacklog" :paginator="true" :rows="100" :scrollable="true" scrollHeight="480px"
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

          <div v-if="backlogError" class="mx-4 mb-4 p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-sm text-rose-300">
            {{ backlogError }}
          </div>
        </div>
      </div>

      <div>
        <div class="flex items-center space-x-2 mb-4">
          <div class="w-1 h-5 bg-emerald-500 rounded-full"></div>
          <h3 class="text-lg font-bold text-gray-200">Logs de Ejecución</h3>
        </div>

        <div class="bg-gray-800/40 rounded-xl border border-gray-700/50 overflow-hidden">
          <DataTable :value="projectLogs" :paginator="true" :rows="8"
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

    <Dialog
      v-model:visible="showEditBacklogDialog"
      :pt="{
        root: { class: 'bg-gray-900 border border-gray-700 shadow-2xl rounded-2xl overflow-hidden' },
        header: { class: 'bg-gray-800/80 backdrop-blur-sm border-b border-gray-700/50 p-5 flex justify-between items-center' },
        title: { class: 'text-lg font-bold text-fuchsia-300' },
        content: { class: 'bg-gray-900/90 p-5' },
        closeButton: { class: 'text-gray-400 hover:text-white transition-colors bg-gray-800 hover:bg-gray-700 rounded-full w-8 h-8 flex items-center justify-center border-none outline-none' }
      }"
      :style="{ width: '98vw', maxWidth: '1800px' }"
      :contentStyle="{ maxHeight: 'calc(96vh - 8rem)', overflowY: 'auto' }"
      modal
      :dismissableMask="true"
      @hide="cancelBacklogEdit"
    >
      <template #header>
        <div class="flex items-center gap-2">
          <div class="w-1 h-5 bg-fuchsia-500 rounded-full"></div>
          <h4 class="text-sm md:text-base font-semibold text-fuchsia-300">Editar backlog item</h4>
        </div>
      </template>

      <div v-if="editingBacklog" class="space-y-4 min-h-[calc(96vh-14rem)] flex flex-col">
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

        <div class="grid grid-cols-1 xl:grid-cols-2 gap-4 flex-1">
          <div class="flex flex-col min-h-[34vh]">
            <label class="block text-[11px] uppercase tracking-wider text-fuchsia-200/70 mb-1">Descripcion</label>
            <textarea
              v-model="editingBacklog.description"
              rows="14"
              class="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:ring-2 focus:ring-fuchsia-500/40 resize-y min-h-[34vh]"
            ></textarea>
          </div>
          <div class="flex flex-col min-h-[34vh]">
            <label class="block text-[11px] uppercase tracking-wider text-fuchsia-200/70 mb-1">Criterios de aceptacion</label>
            <textarea
              v-model="editingBacklog.acceptance_criteria"
              rows="14"
              class="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:ring-2 focus:ring-fuchsia-500/40 resize-y min-h-[34vh]"
            ></textarea>
          </div>
        </div>

        <div class="flex flex-wrap items-end gap-3 pt-2 border-t border-gray-700/40">
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
    </Dialog>
  </div>
</template>

<script setup>
import { ref, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import Dialog from 'primevue/dialog';
import { apiFetch } from '../config/api';

const route = useRoute();
const router = useRouter();

const selectedProject = ref(null);
const loadingProject = ref(true);
const loadError = ref(null);

const projectTasks = ref([]);
const projectBacklog = ref([]);
const projectLogs = ref([]);
const backlogError = ref(null);
const isSavingBacklog = ref(false);
const editingBacklog = ref(null);
const showEditBacklogDialog = ref(false);

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

const resetDetails = () => {
  projectTasks.value = [];
  projectBacklog.value = [];
  projectLogs.value = [];
  backlogError.value = null;
  editingBacklog.value = null;
  showEditBacklogDialog.value = false;
  newBacklog.value = getInitialBacklogForm();
};

const fetchProjectDetails = async (url) => {
  backlogError.value = null;

  try {
    const encodedUrl = encodeURIComponent(url);
    const response = await apiFetch(`/dashboard/projects/${encodedUrl}`, {
      credentials: 'include'
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to fetch project details');
    }

    selectedProject.value = data.project || { url };
    projectTasks.value = data.tasks || [];
    projectBacklog.value = data.backlog || [];
    projectLogs.value = data.logs || [];
  } catch (error) {
    backlogError.value = error.message;
    throw error;
  }
};

const loadProject = async () => {
  const routeProjectId = String(route.params.projectId || '').trim();
  loadingProject.value = true;
  loadError.value = null;
  selectedProject.value = null;
  resetDetails();

  try {
    if (!routeProjectId) {
      throw new Error('No se recibió un identificador de proyecto en la URL.');
    }

    await fetchProjectDetails(routeProjectId);
  } catch (error) {
    loadError.value = error.message;
    console.error('Failed to load project', error);
  } finally {
    loadingProject.value = false;
  }
};

const createBacklogItem = async () => {
  if (!selectedProject.value?.url || !newBacklog.value.title.trim()) {
    return;
  }

  isSavingBacklog.value = true;
  backlogError.value = null;

  try {
    const encodedUrl = encodeURIComponent(selectedProject.value.url);
    const response = await apiFetch(`/dashboard/projects/${encodedUrl}/backlog`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        title: newBacklog.value.title.trim(),
        description: newBacklog.value.description || null,
        acceptance_criteria: newBacklog.value.acceptance_criteria || null,
        item_type: newBacklog.value.item_type,
        status: newBacklog.value.status,
        priority: Number.parseInt(newBacklog.value.priority, 10),
        sort_order: Number.parseInt(newBacklog.value.sort_order, 10),
        source_kind: 'dashboard',
        source_ref: 'project-details-view'
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
  showEditBacklogDialog.value = true;
  backlogError.value = null;
};

const cancelBacklogEdit = () => {
  showEditBacklogDialog.value = false;
  editingBacklog.value = null;
};

const saveBacklogItem = async () => {
  if (!editingBacklog.value || !editingBacklog.value.title?.trim()) {
    return;
  }

  isSavingBacklog.value = true;
  backlogError.value = null;

  try {
    const response = await apiFetch(`/dashboard/backlog/${editingBacklog.value.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
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

    showEditBacklogDialog.value = false;
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

watch(() => route.params.projectId, () => {
  loadProject();
});

onMounted(() => {
  loadProject();
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
</style>