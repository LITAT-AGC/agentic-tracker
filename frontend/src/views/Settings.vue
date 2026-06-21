<template>
  <div class="space-y-8 animate-fade-in">
    <section class="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
      <div>
        <p class="text-xs uppercase tracking-[0.35em] text-primary-600/70">Configuración operativa</p>
        <h1 class="mt-2 text-3xl font-black tracking-tight">Modelos LLM</h1>
        <p class="mt-2 max-w-3xl text-sm text-surface-500">
          Selecciona el modelo de OpenRouter que usará APTS para triage de backlog. La lista viene ordenada desde los más baratos a los más caros para facilitar pruebas de bajo costo.
        </p>
      </div>
      <Tag
        :value="apiKeyConfigured ? 'OpenRouter listo' : 'Falta OPENROUTER_API_KEY'"
        :severity="apiKeyConfigured ? 'success' : 'danger'"
        :icon="apiKeyConfigured ? 'pi pi-check-circle' : 'pi pi-exclamation-circle'"
      />
    </section>

    <div class="grid gap-6 xl:grid-cols-[minmax(0,1.7fr)_minmax(320px,0.9fr)]">
      <Card class="border border-surface-200">
        <template #title>
          <h2 class="text-lg font-bold text-primary-600">Modelo activo para análisis de backlog</h2>
        </template>
        <template #subtitle>
          <p class="text-sm text-surface-500">El backend persiste esta selección en la tabla config y la usa para todos los análisis nuevos.</p>
        </template>
        <template #content>
          <Message v-if="loadError" severity="error" :closable="false" class="mt-2">{{ loadError }}</Message>

          <div v-else class="mt-4 space-y-5">
            <div class="grid gap-4 md:grid-cols-[minmax(0,1fr)_220px]">
              <label class="space-y-2 text-sm text-surface-600">
                <span class="block text-[11px] uppercase tracking-[0.28em] text-primary-600/70">Modelo</span>
                <Select
                  v-model="selectedModelId"
                  :options="modelOptions"
                  optionLabel="name"
                  optionValue="id"
                  :disabled="isLoading || !apiKeyConfigured || !modelOptions.length"
                  filter
                  :filterFields="['name', 'id', 'description']"
                  placeholder="Escribe para buscar modelos..."
                  class="w-full"
                  @change="saveMessage = ''"
                >
                  <template #option="{ option }">
                    <div class="flex items-start justify-between gap-3 w-full">
                      <div class="min-w-0">
                        <p class="text-sm font-semibold">{{ option.name }}</p>
                        <p class="mt-0.5 text-xs text-surface-500 break-all">{{ option.id }}</p>
                      </div>
                      <Tag
                        :value="option.is_free ? 'free' : formatPrice(option.prompt_price)"
                        :severity="option.is_free ? 'success' : 'info'"
                        class="shrink-0"
                      />
                    </div>
                  </template>
                </Select>
                <div class="flex flex-wrap items-center justify-between gap-2 text-xs text-surface-500">
                  <span>{{ modelOptions.length }} modelo(s)</span>
                  <span class="text-primary-600/80">Seleccionado: {{ selectedModelId || 'ninguno' }}</span>
                </div>
              </label>

              <div class="rounded-2xl border border-surface-200 bg-surface-100 px-4 py-3">
                <p class="text-[11px] uppercase tracking-[0.28em] text-surface-500">Modelo efectivo</p>
                <p class="mt-2 text-sm font-semibold break-all">{{ effectiveModel || 'Sin definir' }}</p>
                <p class="mt-1 text-xs text-surface-500">Default backend: {{ defaultModel || 'n/a' }}</p>
              </div>
            </div>

            <div v-if="selectedModelMeta" class="rounded-2xl border border-primary/20 bg-primary/5 p-4">
              <div class="flex flex-wrap items-center gap-2">
                <h3 class="text-sm font-semibold text-primary-700">{{ selectedModelMeta.name }}</h3>
                <Tag v-if="selectedModelMeta.is_free" value="free" severity="success" />
              </div>
              <p class="mt-2 text-sm text-surface-600">{{ selectedModelMeta.description || 'Sin descripción publicada por OpenRouter.' }}</p>
              <div class="mt-3 grid gap-3 sm:grid-cols-3 text-xs text-surface-500">
                <div>
                  <p class="uppercase tracking-[0.22em] text-surface-500">Costo prompt</p>
                  <p class="mt-1 text-sm font-semibold text-surface-900">{{ formatPrice(selectedModelMeta.prompt_price) }}</p>
                </div>
                <div>
                  <p class="uppercase tracking-[0.22em] text-surface-500">Costo completion</p>
                  <p class="mt-1 text-sm font-semibold text-surface-900">{{ formatPrice(selectedModelMeta.completion_price) }}</p>
                </div>
                <div>
                  <p class="uppercase tracking-[0.22em] text-surface-500">Contexto</p>
                  <p class="mt-1 text-sm font-semibold text-surface-900">{{ formatContextLength(selectedModelMeta.context_length) }}</p>
                </div>
              </div>
            </div>

            <div class="flex flex-wrap items-center gap-3 pt-2">
              <Button
                @click="saveSettings"
                :loading="isSaving"
                :disabled="!selectedModelId || !apiKeyConfigured"
                :label="isSaving ? 'Guardando...' : 'Guardar modelo'"
                icon="pi pi-save"
              />
              <Button
                @click="loadPage"
                :disabled="isLoading"
                label="Recargar lista"
                icon="pi pi-refresh"
                severity="secondary"
                outlined
              />
              <span v-if="saveMessage" class="text-sm text-emerald-600">{{ saveMessage }}</span>
            </div>
          </div>
        </template>
      </Card>

      <Card class="border border-surface-200">
        <template #title>
          <h2 class="text-lg font-bold">Referencias rápidas</h2>
        </template>
        <template #content>
          <div class="mt-2 space-y-4 text-sm text-surface-500">
            <div class="rounded-2xl border border-surface-200 bg-surface-100 p-4">
              <p class="text-[11px] uppercase tracking-[0.28em] text-primary-600/70">Uso sugerido</p>
              <p class="mt-2">Para pruebas, prioriza los primeros modelos de la lista o los marcados como free. El backend ya devuelve la lista ordenada por costo estimado.</p>
            </div>
            <div class="rounded-2xl border border-surface-200 bg-surface-100 p-4">
              <p class="text-[11px] uppercase tracking-[0.28em] text-primary-600/70">Alcance actual</p>
              <p class="mt-2">Esta configuración afecta el triage automático de backlog. No cambia todavía la asignación de tareas ni la generación de código.</p>
            </div>
            <div class="rounded-2xl border border-surface-200 bg-surface-100 p-4">
              <p class="text-[11px] uppercase tracking-[0.28em] text-primary-600/70">Persistencia</p>
              <p class="mt-2">La selección se guarda en la tabla config, por lo que sigue vigente entre reinicios del backend y cambios de sesión del dashboard.</p>
            </div>
          </div>
        </template>
      </Card>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { apiFetch } from '../config/api';

const isLoading = ref(false);
const isSaving = ref(false);
const loadError = ref(null);
const saveMessage = ref('');
const apiKeyConfigured = ref(false);
const selectedModelId = ref('');
const effectiveModel = ref('');
const defaultModel = ref('');
const models = ref([]);

const modelOptions = computed(() => {
  const list = [...models.value];

  if (selectedModelId.value && !list.some((model) => model.id === selectedModelId.value)) {
    list.unshift({
      id: selectedModelId.value,
      name: selectedModelId.value,
      description: 'Modelo configurado manualmente y no presente en la lista actual.',
      prompt_price: null,
      completion_price: null,
      context_length: null,
      is_free: false
    });
  }

  return list;
});

const selectedModelMeta = computed(() => {
  return modelOptions.value.find((model) => model.id === selectedModelId.value) || null;
});

const formatPrice = (value) => {
  if (value == null) return 'n/d';
  if (value === 0) return 'gratis';
  return `$${value.toFixed(6)}/1K tok`;
};

const formatContextLength = (value) => {
  if (!value) return 'n/d';
  return new Intl.NumberFormat('es-AR').format(value);
};

const loadConfig = async () => {
  const response = await apiFetch('/dashboard/config/openrouter', {
    credentials: 'include'
  });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'No se pudo cargar la configuración de OpenRouter');
  }

  apiKeyConfigured.value = Boolean(data.openrouter?.api_key_configured);
  effectiveModel.value = data.openrouter?.effective_model || '';
  defaultModel.value = data.openrouter?.default_model || '';
  selectedModelId.value = data.openrouter?.selected_model || data.openrouter?.effective_model || '';
};

const loadModels = async () => {
  if (!apiKeyConfigured.value) {
    models.value = [];
    return;
  }

  const response = await apiFetch('/dashboard/config/openrouter/models', {
    credentials: 'include'
  });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'No se pudo cargar la lista de modelos de OpenRouter');
  }

  models.value = data.models || [];
};

const loadPage = async () => {
  isLoading.value = true;
  loadError.value = null;
  saveMessage.value = '';

  try {
    await loadConfig();
    await loadModels();
  } catch (error) {
    loadError.value = error.message;
  } finally {
    isLoading.value = false;
  }
};

const saveSettings = async () => {
  if (!selectedModelId.value) {
    return;
  }

  isSaving.value = true;
  loadError.value = null;
  saveMessage.value = '';

  try {
    const response = await apiFetch('/dashboard/config/openrouter', {
      method: 'PATCH',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model: selectedModelId.value })
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'No se pudo guardar el modelo seleccionado');
    }

    const persistedModel = data.openrouter?.selected_model || selectedModelId.value;
    selectedModelId.value = persistedModel;
    effectiveModel.value = data.openrouter?.effective_model || persistedModel;
    saveMessage.value = 'Configuración guardada.';
  } catch (error) {
    loadError.value = error.message;
  } finally {
    isSaving.value = false;
  }
};

onMounted(() => {
  loadPage();
});
</script>
