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
          <DataTable
            :value="projectTasks"
            v-model:filters="taskFilters"
            filterDisplay="row"
            :paginator="true"
            :rows="200"
            :scrollable="true"
            scrollHeight="480px"
            class="w-full text-sm"
            :pt="{
              headerRow: { class: 'bg-gray-800/30' },
              row: { class: 'border-b border-gray-700/30 hover:bg-gray-800/50 transition-colors' },
              bodyCell: { class: 'py-3 px-4 border-none text-gray-300' },
              headerCell: { class: 'py-3 px-4 text-gray-400 text-xs font-semibold uppercase tracking-wider border-none bg-transparent' },
              paginator: { class: 'bg-transparent border-t border-gray-800/50' }
            }"
          >
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
            <Column field="status" header="Estado" filter filterField="status" :showFilterMenu="false">
              <template #body="{ data }">
                <span :class="['px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider', getTaskStatusClass(data.status)]">
                  {{ data.status.replace('_', ' ') }}
                </span>
              </template>
              <template #filter="{ filterModel, filterCallback }">
                <MultiSelect
                  v-model="filterModel.value"
                  :options="taskStatusOptions"
                  @change="filterCallback()"
                  :maxSelectedLabels="1"
                  class="w-full"
                />
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
          <div class="flex items-center gap-3">
            <button
              @click="router.push('/dashboard/settings')"
              class="px-3 py-1.5 border border-cyan-500/30 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-200 rounded-lg text-xs font-medium transition-colors"
            >
              Configurar IA
            </button>
            <button
              @click="analyzeProjectBacklog"
              :disabled="isAnalyzingBacklog || triageableBacklogCount === 0"
              class="px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-slate-950 rounded-lg text-xs font-semibold transition-colors"
            >
              {{ isAnalyzingBacklog ? 'Analizando backlog...' : `Analizar IA (${triageableBacklogCount})` }}
            </button>
            <button
              @click="openBacklogCreator"
              class="px-3 py-1.5 bg-fuchsia-600 hover:bg-fuchsia-700 text-white rounded-lg text-xs font-medium transition-colors"
            >
              Agregar item
            </button>
            <span class="text-xs font-medium text-gray-400">{{ projectBacklog.length }} item(s)</span>
          </div>
        </div>

        <div class="bg-gray-800/40 rounded-xl border border-gray-700/50 overflow-hidden">
          <DataTable
            :value="projectBacklog"
            v-model:filters="backlogFilters"
            filterDisplay="row"
            :paginator="true"
            :rows="200"
            :scrollable="true"
            scrollHeight="480px"
            class="w-full text-sm"
            :pt="{
              headerRow: { class: 'bg-gray-800/30' },
              row: { class: 'border-b border-gray-700/30 hover:bg-gray-800/50 transition-colors' },
              bodyCell: { class: 'py-3 px-4 border-none text-gray-300' },
              headerCell: { class: 'py-3 px-4 text-gray-400 text-xs font-semibold uppercase tracking-wider border-none bg-transparent' },
              paginator: { class: 'bg-transparent border-t border-gray-800/50' }
            }"
          >

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

            <Column field="item_type" header="Tipo" sortable filter filterField="item_type" :showFilterMenu="false">
              <template #body="{ data }">
                <span class="text-xs uppercase tracking-wider text-gray-400">{{ data.item_type }}</span>
              </template>
              <template #filter="{ filterModel, filterCallback }">
                <MultiSelect
                  v-model="filterModel.value"
                  :options="backlogTypeOptions"
                  @change="filterCallback()"
                  :maxSelectedLabels="1"
                  class="w-full"
                />
              </template>
            </Column>

            <Column field="status" header="Estado" sortable filter filterField="status" :showFilterMenu="false">
              <template #body="{ data }">
                <span :class="['px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider', getBacklogStatusClass(data.status)]">
                  {{ data.status.replace('_', ' ') }}
                </span>
              </template>
              <template #filter="{ filterModel, filterCallback }">
                <MultiSelect
                  v-model="filterModel.value"
                  :options="backlogStatusOptions"
                  @change="filterCallback()"
                  :maxSelectedLabels="1"
                  class="w-full"
                />
              </template>
            </Column>

            <Column header="Triage IA">
              <template #body="{ data }">
                <div class="max-w-[280px]">
                  <div v-if="data.llm_last_analyzed_at" class="space-y-1">
                    <div class="flex flex-wrap items-center gap-2">
                      <span :class="['px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider', getBacklogStatusClass(data.llm_recommendation_status || data.status)]">
                        {{ (data.llm_recommendation_status || data.status).replace('_', ' ') }}
                      </span>
                      <span class="text-[11px] text-gray-500">{{ formatConfidence(data.llm_confidence) }}</span>
                    </div>
                    <p class="text-xs leading-snug text-gray-300">{{ data.llm_analysis_summary }}</p>
                    <p v-if="data.llm_missing_details?.length" class="text-[11px] text-amber-300">
                      Faltan {{ data.llm_missing_details.length }} dato(s) clave.
                    </p>
                  </div>
                  <p v-else class="text-xs text-gray-500">Sin análisis todavía.</p>
                </div>
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
                <div class="flex flex-wrap items-center gap-2">
                  <button
                    @click="analyzeBacklogItem(data)"
                    :disabled="analyzingBacklogId === data.id"
                    class="px-2.5 py-1 bg-cyan-500/80 hover:bg-cyan-400 disabled:opacity-50 text-slate-950 text-xs font-semibold rounded transition-colors"
                  >
                    {{ analyzingBacklogId === data.id ? 'Analizando...' : 'Analizar IA' }}
                  </button>
                  <button
                    @click="openBacklogEditor(data)"
                    class="px-2.5 py-1 bg-gray-700/70 hover:bg-gray-700 text-gray-200 text-xs font-medium rounded transition-colors"
                  >
                    Editar
                  </button>
                  <button
                    @click="hardDeleteBacklogItem(data)"
                    :disabled="deletingBacklogId === data.id"
                    class="px-2.5 py-1 bg-rose-500/80 hover:bg-rose-400 disabled:opacity-50 text-rose-950 text-xs font-semibold rounded transition-colors"
                  >
                    {{ deletingBacklogId === data.id ? 'Eliminando...' : 'Hard-delete' }}
                  </button>
                </div>
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
          <DataTable
            :value="projectLogs"
            v-model:filters="logFilters"
            filterDisplay="row"
            :paginator="true"
            :rows="200"
            :scrollable="true"
            scrollHeight="480px"
            class="w-full text-sm"
            :pt="{
              headerRow: { class: 'bg-gray-800/30' },
              row: { class: 'border-b border-gray-700/30 hover:bg-gray-800/50 transition-colors' },
              bodyCell: { class: 'py-3 px-4 border-none text-gray-300' },
              headerCell: { class: 'py-3 px-4 text-gray-400 text-xs font-semibold uppercase tracking-wider border-none bg-transparent' },
              paginator: { class: 'bg-transparent border-t border-gray-800/50' }
            }"
          >

            <template #empty>
              <div class="p-6 text-center text-gray-500 text-sm">No hay logs de ejecución registrados aún.</div>
            </template>

            <Column field="action_type" header="Acción" filter filterField="action_type" :showFilterMenu="false">
              <template #body="{ data }">
                <span class="text-xs font-medium text-gray-400">{{ data.action_type || 'update' }}</span>
              </template>
              <template #filter="{ filterModel, filterCallback }">
                <MultiSelect
                  v-model="filterModel.value"
                  :options="logActionOptions"
                  @change="filterCallback()"
                  :maxSelectedLabels="1"
                  class="w-full"
                />
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
          <h4 class="text-sm md:text-base font-semibold text-fuchsia-300">{{ backlogDialogMode === 'create' ? 'Agregar backlog item' : 'Editar backlog item' }}</h4>
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

        <div v-if="editingBacklog.llm_last_analyzed_at" class="rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-4 space-y-3">
          <div class="flex flex-wrap items-center gap-3">
            <span :class="['px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider', getBacklogStatusClass(editingBacklog.llm_recommendation_status || editingBacklog.status)]">
              {{ (editingBacklog.llm_recommendation_status || editingBacklog.status).replace('_', ' ') }}
            </span>
            <span class="text-xs text-cyan-100">{{ formatConfidence(editingBacklog.llm_confidence) }}</span>
            <span class="text-xs text-gray-400">{{ editingBacklog.llm_analysis_model || 'modelo no informado' }}</span>
            <span class="text-xs text-gray-500">{{ formatDateTime(editingBacklog.llm_last_analyzed_at) }}</span>
          </div>
          <p class="text-sm text-gray-200 leading-relaxed">{{ editingBacklog.llm_analysis_summary }}</p>
          <div v-if="editingBacklog.llm_missing_details?.length" class="space-y-2">
            <p class="text-[11px] uppercase tracking-wider text-amber-200/80">Datos que faltan</p>
            <ul class="space-y-2 text-sm text-amber-100/90 list-disc pl-5">
              <li v-for="detail in editingBacklog.llm_missing_details" :key="detail">{{ detail }}</li>
            </ul>
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
            {{ isSavingBacklog ? 'Guardando...' : backlogDialogMode === 'create' ? 'Crear item' : 'Guardar cambios' }}
          </button>
          <button
            v-if="backlogDialogMode === 'edit' && editingBacklog.id"
            @click="hardDeleteBacklogItem(editingBacklog)"
            :disabled="deletingBacklogId === editingBacklog.id"
            class="px-4 py-2 bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
          >
            {{ deletingBacklogId === editingBacklog.id ? 'Eliminando...' : 'Eliminar permanentemente' }}
          </button>
        </div>
      </div>
    </Dialog>
  </div>
</template>

<script setup>
import { computed, ref, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import Dialog from 'primevue/dialog';
import MultiSelect from 'primevue/multiselect';
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
const isAnalyzingBacklog = ref(false);
const analyzingBacklogId = ref(null);
const deletingBacklogId = ref(null);
const editingBacklog = ref(null);
const showEditBacklogDialog = ref(false);
const backlogDialogMode = ref('edit');

const backlogTypeOptions = ['feature', 'bug', 'chore', 'research'];
const backlogStatusOptions = ['draft', 'needs_details', 'ready', 'in_progress', 'review', 'blocked', 'done', 'archived'];
const taskStatusOptions = ['todo', 'in_progress', 'review', 'done', 'stalled'];

const triageableBacklogCount = computed(() => {
  return projectBacklog.value.filter((item) => ['draft', 'needs_details', 'ready'].includes(item.status)).length;
});

const taskFilters = ref({
  status: { value: [...taskStatusOptions], matchMode: 'in' }
});

const backlogFilters = ref({
  item_type: { value: [...backlogTypeOptions], matchMode: 'in' },
  status: { value: [...backlogStatusOptions], matchMode: 'in' }
});

const logFilters = ref({
  action_type: { value: [], matchMode: 'in' }
});

const logActionOptions = computed(() => {
  return [...new Set(projectLogs.value.map((log) => log.action_type || 'update'))].sort();
});

const getInitialBacklogForm = () => ({
  title: '',
  description: '',
  acceptance_criteria: '',
  item_type: 'feature',
  status: 'ready',
  priority: 100,
  sort_order: 0
});

const resetDetails = () => {
  projectTasks.value = [];
  projectBacklog.value = [];
  projectLogs.value = [];
  taskFilters.value = {
    status: { value: [...taskStatusOptions], matchMode: 'in' }
  };
  backlogFilters.value = {
    item_type: { value: [...backlogTypeOptions], matchMode: 'in' },
    status: { value: [...backlogStatusOptions], matchMode: 'in' }
  };
  logFilters.value = {
    action_type: { value: [], matchMode: 'in' }
  };
  backlogError.value = null;
  editingBacklog.value = null;
  backlogDialogMode.value = 'edit';
  showEditBacklogDialog.value = false;
  isAnalyzingBacklog.value = false;
  analyzingBacklogId.value = null;
  deletingBacklogId.value = null;
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
    projectLogs.value = (data.logs || []).map((log) => ({
      ...log,
      action_type: log.action_type || 'update'
    }));
    logFilters.value = {
      action_type: {
        value: [...new Set(projectLogs.value.map((log) => log.action_type || 'update'))].sort(),
        matchMode: 'in'
      }
    };
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

const openBacklogCreator = () => {
  editingBacklog.value = getInitialBacklogForm();
  backlogDialogMode.value = 'create';
  showEditBacklogDialog.value = true;
  backlogError.value = null;
};

const openBacklogEditor = (item) => {
  editingBacklog.value = {
    ...item,
    priority: Number.parseInt(item.priority, 10),
    sort_order: Number.parseInt(item.sort_order, 10)
  };
  backlogDialogMode.value = 'edit';
  showEditBacklogDialog.value = true;
  backlogError.value = null;
};

const cancelBacklogEdit = () => {
  showEditBacklogDialog.value = false;
  editingBacklog.value = null;
  backlogDialogMode.value = 'edit';
};

const analyzeBacklogItem = async (item) => {
  if (!item?.id) {
    return;
  }

  analyzingBacklogId.value = item.id;
  backlogError.value = null;

  try {
    const response = await apiFetch(`/dashboard/backlog/${item.id}/analyze`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json'
      }
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'No se pudo analizar el backlog item');
    }

    await fetchProjectDetails(selectedProject.value.url);

    if (editingBacklog.value?.id === item.id) {
      editingBacklog.value = { ...data.backlog_item };
    }
  } catch (error) {
    backlogError.value = error.message;
    console.error('Failed to analyze backlog item', error);
  } finally {
    analyzingBacklogId.value = null;
  }
};

const analyzeProjectBacklog = async () => {
  if (!selectedProject.value?.url) {
    return;
  }

  isAnalyzingBacklog.value = true;
  backlogError.value = null;

  try {
    const encodedUrl = encodeURIComponent(selectedProject.value.url);
    const response = await apiFetch(`/dashboard/projects/${encodedUrl}/backlog/analyze`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        statuses: ['draft', 'needs_details', 'ready']
      })
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'No se pudo analizar el backlog del proyecto');
    }

    await fetchProjectDetails(selectedProject.value.url);
  } catch (error) {
    backlogError.value = error.message;
    console.error('Failed to analyze project backlog', error);
  } finally {
    isAnalyzingBacklog.value = false;
  }
};

const hardDeleteBacklogItem = async (item) => {
  if (!item?.id || !selectedProject.value?.url) {
    return;
  }

  const confirmed = window.confirm(`Se eliminará permanentemente "${item.title}". Esta acción no se puede deshacer. ¿Continuar?`);
  if (!confirmed) {
    return;
  }

  deletingBacklogId.value = item.id;
  backlogError.value = null;

  try {
    const response = await apiFetch(`/dashboard/backlog/${item.id}`, {
      method: 'DELETE',
      credentials: 'include'
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'No se pudo eliminar el backlog item');
    }

    if (editingBacklog.value?.id === item.id) {
      showEditBacklogDialog.value = false;
      editingBacklog.value = null;
      backlogDialogMode.value = 'edit';
    }

    await fetchProjectDetails(selectedProject.value.url);
  } catch (error) {
    backlogError.value = error.message;
    console.error('Failed to hard-delete backlog item', error);
  } finally {
    deletingBacklogId.value = null;
  }
};

const saveBacklogItem = async () => {
  if (!editingBacklog.value || !editingBacklog.value.title?.trim()) {
    return;
  }

  isSavingBacklog.value = true;
  backlogError.value = null;

  try {
    const payload = {
      title: editingBacklog.value.title.trim(),
      description: editingBacklog.value.description || null,
      acceptance_criteria: editingBacklog.value.acceptance_criteria || null,
      item_type: editingBacklog.value.item_type,
      status: editingBacklog.value.status,
      priority: Number.parseInt(editingBacklog.value.priority, 10),
      sort_order: Number.parseInt(editingBacklog.value.sort_order, 10)
    };
    const isCreate = backlogDialogMode.value === 'create';
    const encodedUrl = encodeURIComponent(selectedProject.value.url);
    const response = await apiFetch(isCreate ? `/dashboard/projects/${encodedUrl}/backlog` : `/dashboard/backlog/${editingBacklog.value.id}`, {
      method: isCreate ? 'POST' : 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(isCreate ? {
        ...payload,
        source_kind: 'dashboard',
        source_ref: 'project-details-view'
      } : payload)
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || (isCreate ? 'Failed to create backlog item' : 'Failed to update backlog item'));
    }

    showEditBacklogDialog.value = false;
    editingBacklog.value = null;
    backlogDialogMode.value = 'edit';
    await fetchProjectDetails(selectedProject.value.url);
  } catch (error) {
    backlogError.value = error.message;
    console.error('Failed to save backlog item', error);
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
    needs_details: 'bg-amber-500/10 text-amber-300',
    ready: 'bg-blue-500/10 text-blue-400',
    in_progress: 'bg-indigo-500/10 text-indigo-400',
    review: 'bg-purple-500/10 text-purple-400',
    blocked: 'bg-rose-500/10 text-rose-400',
    done: 'bg-emerald-500/10 text-emerald-400',
    archived: 'bg-slate-500/10 text-slate-400'
  };
  return map[status] || 'bg-gray-500/10 text-gray-400';
};

const formatConfidence = (value) => {
  if (value == null) {
    return 'Confianza n/d';
  }

  return `Confianza ${Math.round(value * 100)}%`;
};

const formatDateTime = (value) => {
  if (!value) {
    return 'Sin fecha';
  }

  return new Date(value).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
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