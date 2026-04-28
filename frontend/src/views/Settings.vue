<template>
  <div class="space-y-8 p-6 text-white">
    <section class="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
      <div>
        <p class="text-xs uppercase tracking-[0.35em] text-cyan-300/70">Configuración operativa</p>
        <h1 class="mt-2 text-3xl font-black tracking-tight text-white">Modelos LLM</h1>
        <p class="mt-2 max-w-3xl text-sm text-gray-400">
          Selecciona el modelo de OpenRouter que usará APTS para triage de backlog. La lista viene ordenada desde los más baratos a los más caros para facilitar pruebas de bajo costo.
        </p>
      </div>
      <div class="inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.18em]"
        :class="apiKeyConfigured ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-rose-500/30 bg-rose-500/10 text-rose-300'">
        <span class="h-2 w-2 rounded-full" :class="apiKeyConfigured ? 'bg-emerald-400' : 'bg-rose-400'"></span>
        {{ apiKeyConfigured ? 'OpenRouter listo' : 'Falta OPENROUTER_API_KEY' }}
      </div>
    </section>

    <div class="grid gap-6 xl:grid-cols-[minmax(0,1.7fr)_minmax(320px,0.9fr)]">
      <section class="rounded-3xl border border-gray-700/70 bg-[radial-gradient(circle_at_top_left,_rgba(34,211,238,0.12),_transparent_38%),linear-gradient(180deg,_rgba(17,24,39,0.96),_rgba(5,8,18,0.98))] p-6 shadow-2xl shadow-cyan-950/30">
        <div class="flex flex-col gap-2 border-b border-gray-800/80 pb-5">
          <h2 class="text-lg font-bold text-cyan-200">Modelo activo para análisis de backlog</h2>
          <p class="text-sm text-gray-400">El backend persiste esta selección en la tabla config y la usa para todos los análisis nuevos.</p>
        </div>

        <div v-if="loadError" class="mt-5 rounded-2xl border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-200">
          {{ loadError }}
        </div>

        <div v-else class="mt-5 space-y-5">
          <div class="grid gap-4 md:grid-cols-[minmax(0,1fr)_220px]">
            <label class="space-y-2 text-sm text-gray-300">
              <span class="block text-[11px] uppercase tracking-[0.28em] text-cyan-200/70">Modelo</span>
              <div class="relative">
                <input
                  v-model="modelQuery"
                  type="text"
                  :disabled="isLoading || !apiKeyConfigured || !modelOptions.length"
                  placeholder="Escribe para buscar modelos..."
                  class="w-full rounded-2xl border border-gray-700 bg-gray-950/80 px-4 py-3 text-sm text-white outline-none transition focus:border-cyan-400/50 focus:ring-2 focus:ring-cyan-500/30 disabled:cursor-not-allowed disabled:opacity-60"
                  @focus="isModelPickerOpen = true"
                  @input="handleModelQueryInput"
                  @keydown.esc="isModelPickerOpen = false"
                >

                <button
                  type="button"
                  :disabled="isLoading || !apiKeyConfigured || !modelOptions.length"
                  class="absolute inset-y-0 right-0 mr-2 my-2 rounded-xl border border-gray-700 bg-gray-900/80 px-3 text-xs font-semibold text-cyan-200 transition hover:border-cyan-500/40 hover:bg-cyan-500/10 disabled:cursor-not-allowed disabled:opacity-60"
                  @click="toggleModelPicker"
                >
                  {{ isModelPickerOpen ? 'Ocultar' : 'Ver' }}
                </button>

                <div
                  v-if="isModelPickerOpen && apiKeyConfigured && filteredModelOptions.length"
                  class="absolute z-20 mt-2 max-h-80 w-full overflow-y-auto rounded-2xl border border-gray-700/80 bg-gray-950/95 p-2 shadow-2xl shadow-black/40 backdrop-blur"
                >
                  <button
                    v-for="model in filteredModelOptions"
                    :key="model.id"
                    type="button"
                    class="flex w-full items-start justify-between gap-3 rounded-xl px-3 py-2 text-left transition hover:bg-cyan-500/10"
                    @mousedown.prevent="selectModel(model)"
                  >
                    <div>
                      <p class="text-sm font-semibold text-white">{{ model.name }}</p>
                      <p class="mt-0.5 text-xs text-gray-500 break-all">{{ model.id }}</p>
                    </div>
                    <span class="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.2em]"
                      :class="model.is_free ? 'bg-emerald-500/15 text-emerald-300' : 'bg-cyan-500/10 text-cyan-200'">
                      {{ model.is_free ? 'free' : formatPrice(model.prompt_price) }}
                    </span>
                  </button>
                </div>
              </div>

              <div class="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500">
                <span>{{ filteredModelCount }} coincidencia(s)</span>
                <span class="text-cyan-200/80">Seleccionado: {{ selectedModelId || 'ninguno' }}</span>
              </div>
            </label>

            <div class="rounded-2xl border border-gray-800 bg-black/20 px-4 py-3">
              <p class="text-[11px] uppercase tracking-[0.28em] text-gray-500">Modelo efectivo</p>
              <p class="mt-2 text-sm font-semibold text-white break-all">{{ effectiveModel || 'Sin definir' }}</p>
              <p class="mt-1 text-xs text-gray-500">Default backend: {{ defaultModel || 'n/a' }}</p>
            </div>
          </div>

          <div v-if="selectedModelMeta" class="rounded-2xl border border-cyan-500/20 bg-cyan-500/5 p-4">
            <div class="flex flex-wrap items-center gap-2">
              <h3 class="text-sm font-semibold text-cyan-100">{{ selectedModelMeta.name }}</h3>
              <span v-if="selectedModelMeta.is_free" class="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.2em] text-emerald-300">free</span>
            </div>
            <p class="mt-2 text-sm text-gray-300">{{ selectedModelMeta.description || 'Sin descripción publicada por OpenRouter.' }}</p>
            <div class="mt-3 grid gap-3 sm:grid-cols-3 text-xs text-gray-400">
              <div>
                <p class="uppercase tracking-[0.22em] text-gray-500">Costo prompt</p>
                <p class="mt-1 text-sm font-semibold text-white">{{ formatPrice(selectedModelMeta.prompt_price) }}</p>
              </div>
              <div>
                <p class="uppercase tracking-[0.22em] text-gray-500">Costo completion</p>
                <p class="mt-1 text-sm font-semibold text-white">{{ formatPrice(selectedModelMeta.completion_price) }}</p>
              </div>
              <div>
                <p class="uppercase tracking-[0.22em] text-gray-500">Contexto</p>
                <p class="mt-1 text-sm font-semibold text-white">{{ formatContextLength(selectedModelMeta.context_length) }}</p>
              </div>
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-3 pt-2">
            <button
              @click="saveSettings"
              :disabled="isSaving || !selectedModelId || !apiKeyConfigured"
              class="rounded-2xl bg-cyan-500 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {{ isSaving ? 'Guardando...' : 'Guardar modelo' }}
            </button>
            <button
              @click="loadPage"
              :disabled="isLoading"
              class="rounded-2xl border border-gray-700 bg-gray-900/70 px-4 py-2.5 text-sm font-semibold text-gray-200 transition hover:border-gray-500 hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Recargar lista
            </button>
            <span v-if="saveMessage" class="text-sm text-emerald-300">{{ saveMessage }}</span>
          </div>
        </div>
      </section>

      <aside class="rounded-3xl border border-gray-700/70 bg-gray-950/80 p-6 shadow-xl shadow-black/30">
        <h2 class="text-lg font-bold text-white">Referencias rápidas</h2>
        <div class="mt-5 space-y-4 text-sm text-gray-400">
          <div class="rounded-2xl border border-gray-800 bg-gray-900/60 p-4">
            <p class="text-[11px] uppercase tracking-[0.28em] text-cyan-200/70">Uso sugerido</p>
            <p class="mt-2">Para pruebas, prioriza los primeros modelos de la lista o los marcados como free. El backend ya devuelve la lista ordenada por costo estimado.</p>
          </div>
          <div class="rounded-2xl border border-gray-800 bg-gray-900/60 p-4">
            <p class="text-[11px] uppercase tracking-[0.28em] text-cyan-200/70">Alcance actual</p>
            <p class="mt-2">Esta configuración afecta el triage automático de backlog. No cambia todavía la asignación de tareas ni la generación de código.</p>
          </div>
          <div class="rounded-2xl border border-gray-800 bg-gray-900/60 p-4">
            <p class="text-[11px] uppercase tracking-[0.28em] text-cyan-200/70">Persistencia</p>
            <p class="mt-2">La selección se guarda en la tabla config, por lo que sigue vigente entre reinicios del backend y cambios de sesión del dashboard.</p>
          </div>
        </div>
      </aside>
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
const modelQuery = ref('');
const isModelPickerOpen = ref(false);
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

const filteredModelCount = computed(() => {
  const query = modelQuery.value.trim().toLowerCase();

  if (!query) {
    return modelOptions.value.length;
  }

  return modelOptions.value.filter((model) => {
    const haystack = [model.id, model.name, model.description]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return haystack.includes(query);
  }).length;
});

const filteredModelOptions = computed(() => {
  const query = modelQuery.value.trim().toLowerCase();
  const matches = !query
    ? modelOptions.value
    : modelOptions.value.filter((model) => {
      const haystack = [model.id, model.name, model.description]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      return haystack.includes(query);
    });

  return matches.slice(0, 12);
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

const formatModelOption = (model) => {
  const price = model.is_free ? 'free' : formatPrice(model.prompt_price);
  return `${model.name} · ${price}`;
};

const handleModelQueryInput = () => {
  isModelPickerOpen.value = true;
  saveMessage.value = '';
};

const toggleModelPicker = () => {
  isModelPickerOpen.value = !isModelPickerOpen.value;
};

const selectModel = (model) => {
  selectedModelId.value = model.id;
  modelQuery.value = model.id;
  isModelPickerOpen.value = false;
  saveMessage.value = '';
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
  modelQuery.value = selectedModelId.value;
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
    isModelPickerOpen.value = false;
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
    modelQuery.value = persistedModel;
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