<template>
  <div class="space-y-8 animate-fade-in pb-8 relative p-6">
    <div class="flex flex-col gap-4 md:flex-row md:items-center md:justify-between mb-8">
      <div>
        <h2 class="text-3xl font-extrabold text-white tracking-tight flex items-center">
          <svg class="w-6 h-6 mr-3 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"></path></svg>
          Registro Global de Proyectos
        </h2>
        <p class="mt-2 text-sm text-gray-400">Selecciona un proyecto para abrir su vista detallada en pantalla completa.</p>
      </div>

      <button
        @click="fetchProjects"
        :disabled="loading"
        class="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-md text-sm font-medium transition-colors shadow-lg shadow-indigo-900/20 disabled:opacity-50 flex items-center justify-center space-x-2"
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

      <DataTable
        :value="projects"
        :paginator="true"
        :rows="10"
        dataKey="url"
        :loading="loading"
        @row-click="onRowClick"
        class="w-full text-sm"
        :pt="{
          headerRow: { class: 'bg-gray-800/50' },
          row: { class: 'hover:bg-gray-800/80 cursor-pointer transition-colors border-b border-gray-800/50' },
          bodyCell: { class: 'py-4 px-4 border-none text-gray-300' },
          headerCell: { class: 'py-4 px-4 text-gray-400 font-semibold tracking-wider uppercase text-xs border-none bg-transparent' },
          paginator: { class: 'bg-transparent border-t border-gray-800/50' }
        }"
        responsiveLayout="scroll"
      >
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
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import { apiFetch } from '../config/api';

const router = useRouter();

const projects = ref([]);
const loading = ref(true);

const fetchProjects = async () => {
  loading.value = true;
  try {
    const response = await apiFetch('/dashboard/projects', {
      credentials: 'include'
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to fetch projects');
    }

    projects.value = data.projects || [];
  } catch (error) {
    console.error('Failed to fetch projects', error);
  } finally {
    loading.value = false;
  }
};

const onRowClick = (event) => {
  const projectUrl = event?.data?.url;
  if (!projectUrl) {
    return;
  }

  router.push({ name: 'ProjectDetails', params: { projectId: projectUrl } });
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
</style>