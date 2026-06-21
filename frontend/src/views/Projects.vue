<template>
  <div class="space-y-8 animate-fade-in pb-8 relative">
    <div class="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
      <div>
        <h2 class="text-3xl font-extrabold tracking-tight flex items-center gap-3">
          <i class="pi pi-folder text-primary-600"></i>
          Registro Global de Proyectos
        </h2>
        <p class="mt-2 text-sm text-surface-500">Selecciona un proyecto para abrir su vista detallada en pantalla completa.</p>
      </div>

      <div class="flex flex-col items-stretch gap-3 md:items-end">
        <SelectButton
          v-model="needsDetailsFilter"
          :options="detailFilterOptions"
          optionLabel="label"
          optionValue="value"
          :allowEmpty="false"
        />

        <Button
          @click="fetchProjects"
          :loading="loading"
          icon="pi pi-refresh"
          label="Actualizar"
          size="small"
        />
      </div>
    </div>

    <Card class="border border-surface-200" :pt="{ body: { class: 'p-0' }, content: { class: 'p-0' } }">
      <template #content>
        <DataTable
          :value="filteredProjects"
          v-model:filters="projectFilters"
          filterDisplay="row"
          :paginator="true"
          :rows="10"
          dataKey="url"
          :loading="loading"
          @row-click="onRowClick"
          class="w-full text-sm"
          :rowClass="() => 'cursor-pointer'"
          responsiveLayout="scroll"
        >
          <template #empty>
            <div class="p-8 text-center text-surface-500 font-medium">No se encontraron proyectos.</div>
          </template>

          <Column field="name" header="Nombre del Proyecto" sortable>
            <template #body="{ data }">
              <span class="font-bold text-surface-900">{{ data.name }}</span>
            </template>
          </Column>
          <Column field="url" header="URL" sortable>
            <template #body="{ data }">
              <span class="text-surface-500 text-xs truncate max-w-xs block" :title="data.url">{{ data.url }}</span>
            </template>
          </Column>
          <Column field="status" header="Estado" sortable filter filterField="status" :showFilterMenu="false">
            <template #body="{ data }">
              <Tag :value="data.status" :severity="statusSeverity(data.status)" />
            </template>
            <template #filter="{ filterModel, filterCallback }">
              <MultiSelect
                v-model="filterModel.value"
                :options="projectStatusOptions"
                @change="filterCallback()"
                :maxSelectedLabels="1"
                class="w-full"
              />
            </template>
          </Column>
          <Column field="needs_details_count" header="Solicitudes incompletas" sortable>
            <template #body="{ data }">
              <div class="flex items-center gap-2">
                <Tag
                  :value="String(data.needs_details_count || 0)"
                  :severity="data.needs_details_count > 0 ? 'warn' : 'secondary'"
                  rounded
                />
                <span class="text-xs" :class="data.needs_details_count > 0 ? 'text-amber-600' : 'text-surface-500'">
                  {{ data.needs_details_count > 0 ? 'Requiere seguimiento' : 'Sin pendientes' }}
                </span>
              </div>
            </template>
          </Column>
          <Column field="webhook_url" header="Webhook">
            <template #body="{ data }">
              <div class="flex items-center gap-1.5" v-if="data.webhook_url">
                <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                <span class="text-emerald-600 text-xs font-medium">Activo</span>
              </div>
              <div class="flex items-center gap-1.5" v-else>
                <span class="w-2 h-2 rounded-full bg-surface-300"></span>
                <span class="text-surface-500 text-xs font-medium">Ninguno</span>
              </div>
            </template>
          </Column>
          <Column field="updated_at" header="Última Actualización" sortable>
            <template #body="{ data }">
              <span class="text-surface-500 text-xs">
                {{ new Date(data.updated_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) }}
              </span>
            </template>
          </Column>
        </DataTable>
      </template>
    </Card>
  </div>
</template>

<script setup>
import { computed, ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { apiFetch } from '../config/api';

const router = useRouter();

const projects = ref([]);
const loading = ref(true);
const needsDetailsFilter = ref('all');
const projectStatusOptions = ['pending', 'active', 'blocked', 'stalled', 'completed'];
const projectFilters = ref({
  status: { value: [...projectStatusOptions], matchMode: 'in' }
});

const projectsWithNeedsDetailsCount = computed(() => {
  return projects.value.filter((project) => Number.parseInt(project.needs_details_count, 10) > 0).length;
});

const detailFilterOptions = computed(() => [
  { label: 'Todos', value: 'all' },
  { label: `Requieren más datos (${projectsWithNeedsDetailsCount.value})`, value: 'needs_details' }
]);

const filteredProjects = computed(() => {
  if (needsDetailsFilter.value !== 'needs_details') {
    return projects.value;
  }

  return projects.value.filter((project) => Number.parseInt(project.needs_details_count, 10) > 0);
});

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

const statusSeverity = (status) => {
  const map = {
    pending: 'secondary',
    active: 'success',
    blocked: 'danger',
    stalled: 'warn',
    completed: 'success'
  };
  return map[status] || 'secondary';
};

onMounted(() => {
  fetchProjects();
});
</script>
