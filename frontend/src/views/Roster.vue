<template>
  <div class="space-y-8 animate-fade-in pb-8">
    <div>
      <h2 class="text-2xl md:text-3xl font-extrabold tracking-tight">Agentes del método</h2>
      <p class="mt-1 text-sm text-surface-500">
        La biblioteca BMAD es de solo lectura: la siembra el corpus y se reescribe al re-sembrar.
        Lo que se edita aquí se guarda aparte y sobrevive a esa siembra. Un campo vacío hereda
        el valor de la biblioteca, que se muestra en gris.
      </p>
    </div>

    <Message v-if="loadError" severity="error" :closable="false">{{ loadError }}</Message>

    <div v-if="isLoading" class="flex justify-center items-center py-20">
      <ProgressSpinner style="width: 2.5rem; height: 2.5rem" strokeWidth="4" />
    </div>

    <div v-else class="grid grid-cols-1 xl:grid-cols-[minmax(0,320px)_minmax(0,1fr)] gap-6">
      <Card class="border border-surface-200" :pt="{ body: { class: 'p-0' }, content: { class: 'p-0' } }">
        <template #content>
          <ul class="divide-y divide-surface-200/60">
            <li v-for="agent in agents" :key="agent.key">
              <button
                type="button"
                class="w-full text-left px-4 py-3 hover:bg-surface-100 transition"
                :class="selectedKey === agent.key ? 'bg-primary-50' : ''"
                @click="selectAgent(agent.key)"
              >
                <div class="flex items-center justify-between gap-2">
                  <span class="text-sm font-medium text-surface-700">{{ effectiveName(agent) }}</span>
                  <Tag v-if="agent.global_override" value="editado" severity="info" />
                </div>
                <p class="text-[11px] text-surface-500 mt-1">{{ agent.key }}</p>
              </button>
            </li>
          </ul>
        </template>
      </Card>

      <Card v-if="selectedAgent" class="border border-surface-200">
        <template #content>
          <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div>
              <h3 class="text-lg font-bold">{{ effectiveName(selectedAgent) }}</h3>
              <p class="text-[11px] text-surface-500">{{ selectedAgent.key }} · {{ selectedAgent.source_ref }}</p>
            </div>
            <Tag v-if="selectedAgent.global_override" value="con edición global" severity="info" />
          </div>

          <Message v-if="saveError" severity="error" :closable="false" class="mb-4">{{ saveError }}</Message>

          <div class="space-y-4">
            <label v-for="field in fields" :key="field.name" class="block space-y-2">
              <span class="block text-[11px] uppercase tracking-wider text-primary-700/70">{{ field.label }}</span>
              <InputText
                v-if="field.name === 'name'"
                v-model="form[field.name]"
                class="w-full"
                :placeholder="selectedAgent.library[field.name] || 'sin valor en la biblioteca'"
              />
              <Textarea
                v-else
                v-model="form[field.name]"
                class="w-full"
                rows="3"
                autoResize
                :placeholder="selectedAgent.library[field.name] || 'sin valor en la biblioteca'"
              />
            </label>
          </div>

          <div class="flex flex-wrap items-center gap-3 mt-5">
            <Button
              @click="saveAgent"
              :loading="isSaving"
              label="Guardar edición global"
              severity="info"
              size="small"
            />
            <Button
              @click="loadRoster"
              :disabled="isSaving"
              label="Descartar"
              severity="secondary"
              outlined
              size="small"
            />
            <span v-if="saveMessage" class="text-xs text-emerald-600">{{ saveMessage }}</span>
          </div>

          <p class="mt-5 text-xs text-surface-500">
            Esto lo ven todos los proyectos. Para pisarlo en uno solo, entra al proyecto y usa
            la pestaña Configuración.
          </p>
        </template>
      </Card>
    </div>

    <div v-if="!isLoading && workflows.length">
      <div class="flex items-center gap-2 mb-4">
        <div class="w-1 h-5 bg-primary-500 rounded-full"></div>
        <h3 class="text-lg font-bold">Workflows sembrados</h3>
      </div>
      <Card class="border border-surface-200" :pt="{ body: { class: 'p-0' }, content: { class: 'p-0' } }">
        <template #content>
          <DataTable :value="workflows" :paginator="true" :rows="50" class="w-full text-sm">
            <Column field="key" header="Workflow" />
            <Column field="phase" header="Fase" />
            <Column field="status" header="Estado" />
            <Column field="source_ref" header="Origen" />
          </DataTable>
        </template>
      </Card>
      <p class="mt-3 text-xs text-surface-500">
        Los pasos de cada workflow no se editan desde aquí: son el procedimiento del método.
      </p>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, onMounted } from 'vue';
import { apiFetchJson, getApiErrorMessage } from '../config/api';

const fields = [
  { name: 'name', label: 'Nombre' },
  { name: 'persona', label: 'Persona' },
  { name: 'principles', label: 'Principios' },
  { name: 'communication_style', label: 'Estilo de comunicación' },
  { name: 'instruction', label: 'Instrucción' }
];

const agents = ref([]);
const workflows = ref([]);
const selectedKey = ref(null);
const form = ref({});
const isLoading = ref(true);
const isSaving = ref(false);
const loadError = ref(null);
const saveError = ref(null);
const saveMessage = ref(null);

const selectedAgent = computed(() => agents.value.find((agent) => agent.key === selectedKey.value) || null);

const effectiveName = (agent) => agent.effective?.name || agent.library?.name || agent.key;

const fillForm = (agent) => {
  form.value = Object.fromEntries(fields.map(({ name }) => [name, agent?.global_override?.[name] ?? '']));
};

const selectAgent = (key) => {
  selectedKey.value = key;
  saveError.value = null;
  saveMessage.value = null;
  fillForm(agents.value.find((agent) => agent.key === key));
};

const loadRoster = async () => {
  isLoading.value = true;
  loadError.value = null;
  saveMessage.value = null;

  try {
    const { data } = await apiFetchJson('/dashboard/roster', {
      credentials: 'include'
    }, 'No se pudo cargar el roster del método.');

    agents.value = data.agents || [];
    workflows.value = data.workflows || [];
    if (!agents.value.some((agent) => agent.key === selectedKey.value)) {
      selectedKey.value = agents.value[0]?.key || null;
    }
    fillForm(selectedAgent.value);
  } catch (error) {
    loadError.value = getApiErrorMessage(error, 'No se pudo cargar el roster del método.');
    console.error('Failed to load roster', error);
  } finally {
    isLoading.value = false;
  }
};

const saveAgent = async () => {
  if (!selectedKey.value) return;

  isSaving.value = true;
  saveError.value = null;
  saveMessage.value = null;

  try {
    // Vacio significa heredar de la biblioteca: se manda `null`, que es como el backend
    // borra el override de ese campo.
    const payload = Object.fromEntries(fields.map(({ name }) => {
      const value = String(form.value[name] ?? '').trim();
      return [name, value === '' ? null : value];
    }));

    await apiFetchJson(`/dashboard/roster/entities/${encodeURIComponent(selectedKey.value)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(payload)
    }, 'No se pudo guardar la edición del agente.');

    await loadRoster();
    saveMessage.value = 'Agente guardado.';
  } catch (error) {
    saveError.value = getApiErrorMessage(error, 'No se pudo guardar la edición del agente.');
    console.error('Failed to save entity override', error);
  } finally {
    isSaving.value = false;
  }
};

onMounted(loadRoster);
</script>
