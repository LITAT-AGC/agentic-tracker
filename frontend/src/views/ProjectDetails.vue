<template>
  <div class="space-y-8 animate-fade-in pb-8 relative">
    <div class="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
      <div class="flex items-start gap-3">
        <Button
          @click="router.push('/dashboard/projects')"
          icon="pi pi-arrow-left"
          label="Volver a proyectos"
          severity="secondary"
          outlined
          size="small"
          class="mt-1"
        />

        <div>
          <h2 class="text-2xl md:text-3xl font-extrabold tracking-tight">
            {{ selectedProject?.name || 'Detalle del Proyecto' }}
          </h2>
          <p class="mt-1 text-sm text-surface-500 break-all">{{ selectedProject?.url || 'Cargando información...' }}</p>
        </div>
      </div>

      <Tag
        v-if="selectedProject"
        :value="selectedProject.status"
        :severity="statusSeverity(selectedProject.status)"
        class="self-start"
      />
    </div>

    <div v-if="loadingProject" class="flex justify-center items-center py-20">
      <ProgressSpinner style="width: 2.5rem; height: 2.5rem" strokeWidth="4" />
    </div>

    <Message v-else-if="loadError" severity="error" :closable="false">{{ loadError }}</Message>

    <div v-else-if="selectedProject" class="space-y-8">
      <SelectButton
        v-model="activeTab"
        :options="tabOptions"
        optionLabel="label"
        optionValue="value"
        :allowEmpty="false"
      />

      <div v-if="activeTab === 'semantic'" class="space-y-8">
      <div class="grid grid-cols-1 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,1.35fr)] gap-6">
        <section class="rounded-2xl border border-cyan-500/20 bg-cyan-500/5 p-5 space-y-4">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div class="flex items-center gap-2">
                <div class="w-1 h-5 bg-cyan-400 rounded-full"></div>
                <h3 class="text-lg font-bold text-cyan-700">Indice Semantico</h3>
              </div>
              <p class="mt-1 text-sm text-cyan-700/70">Cobertura funcional del backlog disponible para el dashboard.</p>
            </div>
            <div class="flex items-center gap-2">
              <Button
                @click="refreshSemanticStatus"
                :disabled="semanticStatusLoading || isSemanticIndexing || !selectedProject?.url"
                :label="semanticStatusLoading ? 'Analizando...' : 'Recalcular analisis'"
                severity="info"
                outlined
                size="small"
              />
              <Button
                @click="runSemanticIndex"
                :disabled="isSemanticIndexing || semanticStatusLoading || !semanticStatus || !selectedProject?.url"
                :label="isSemanticIndexing ? 'Indexando...' : semanticStatus?.fully_indexed ? 'Reindexar backlog' : 'Indexar backlog'"
                severity="info"
                size="small"
              />
            </div>
          </div>

          <div v-if="semanticStatusLoading && !semanticStatus" class="rounded-xl border border-cyan-400/10 bg-surface-100 p-4 text-sm text-surface-500">
            Calculando cobertura e impacto estimado de tokens...
          </div>

          <div v-else-if="semanticStatus" class="space-y-4">
            <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div class="rounded-xl border border-surface-200/40 bg-surface-100 p-3">
                <p class="text-[11px] uppercase tracking-wider text-surface-500">Documentos</p>
                <p class="mt-2 text-xl font-bold">{{ semanticStatus.total_documents }}</p>
              </div>
              <div class="rounded-xl border border-surface-200/40 bg-surface-100 p-3">
                <p class="text-[11px] uppercase tracking-wider text-surface-500">Indexados</p>
                <p class="mt-2 text-xl font-bold text-emerald-600">{{ semanticStatus.indexed_documents }}</p>
              </div>
              <div class="rounded-xl border border-surface-200/40 bg-surface-100 p-3">
                <p class="text-[11px] uppercase tracking-wider text-surface-500">Pendientes</p>
                <p class="mt-2 text-xl font-bold text-amber-600">{{ semanticPendingDocuments }}</p>
              </div>
              <div class="rounded-xl border border-surface-200/40 bg-surface-100 p-3">
                <p class="text-[11px] uppercase tracking-wider text-surface-500">Tokens estimados</p>
                <p class="mt-2 text-xl font-bold text-cyan-700">{{ formatNumber(semanticStatus.estimated_input_tokens) }}</p>
              </div>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
              <div class="rounded-xl border border-surface-200/40 bg-surface-100 p-3">
                <p class="text-[11px] uppercase tracking-wider text-surface-500">Tokens reindexado total</p>
                <p class="mt-2 text-xl font-bold text-cyan-700">{{ formatNumber(semanticStatus.estimated_input_tokens) }}</p>
              </div>
              <div class="rounded-xl border border-surface-200/40 bg-surface-100 p-3">
                <p class="text-[11px] uppercase tracking-wider text-surface-500">Tokens incrementales</p>
                <p class="mt-2 text-xl font-bold text-amber-600">{{ formatNumber(semanticStatus.estimated_incremental_input_tokens) }}</p>
              </div>
              <div class="rounded-xl border border-surface-200/40 bg-surface-100 p-3">
                <p class="text-[11px] uppercase tracking-wider text-surface-500">Costo total estimado</p>
                <p class="mt-2 text-xl font-bold text-cyan-700">
                  {{ formatCurrency(semanticStatus.pricing?.estimated_full_input_cost) }}
                </p>
                <p class="mt-1 text-xs text-surface-500">
                  {{ semanticStatus.pricing?.prompt_price != null
                    ? `Precio input aprox: ${formatModelPrice(semanticStatus.pricing.prompt_price)}`
                    : 'OpenRouter no devolvio pricing para este modelo.' }}
                </p>
              </div>
              <div class="rounded-xl border border-surface-200/40 bg-surface-100 p-3">
                <p class="text-[11px] uppercase tracking-wider text-surface-500">Costo incremental</p>
                <p class="mt-2 text-xl font-bold text-amber-600">{{ formatCurrency(semanticStatus.pricing?.estimated_incremental_input_cost) }}</p>
                <p class="mt-1 text-xs text-surface-500">Solo documentos missing o stale.</p>
              </div>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div class="rounded-xl border border-surface-200/40 bg-surface-100 p-3">
                <p class="text-[11px] uppercase tracking-wider text-surface-500">Contexto maximo</p>
                <p class="mt-2 text-xl font-bold text-cyan-700">{{ formatNumber(semanticStatus.pricing?.context_length) }}</p>
              </div>
              <div class="rounded-xl border border-surface-200/40 bg-surface-100 p-3">
                <p class="text-[11px] uppercase tracking-wider text-surface-500">Estrategia recomendada</p>
                <p class="mt-2 text-sm font-medium text-surface-700">
                  {{ semanticStatus.estimated_incremental_input_tokens > 0
                    ? 'Usar indexacion incremental cuando solo haya backlog nuevo o cambiado.'
                    : 'No hay trabajo incremental pendiente; reindexar solo si cambias el modelo.' }}
                </p>
              </div>
            </div>

            <div class="rounded-xl border border-surface-200/40 bg-surface-100 p-4 space-y-2 text-sm text-surface-600">
              <div class="flex flex-wrap items-center gap-2">
                <Tag
                  :value="semanticStatus.fully_indexed ? 'Indice listo' : 'Indice pendiente'"
                  :severity="semanticStatus.fully_indexed ? 'success' : 'warn'"
                />
                <span class="text-xs text-surface-500">Modelo: {{ semanticStatus.embedding_model }}</span>
                <span v-if="semanticStatus.last_indexed_at" class="text-xs text-surface-500">Ultima indexacion: {{ formatDateTime(semanticStatus.last_indexed_at) }}</span>
              </div>
              <p>
                {{ semanticStatus.fully_indexed
                  ? 'La búsqueda semántica ya puede consultar todo el backlog indexado para este proyecto.'
                  : 'Antes de indexar se muestra el volumen estimado de tokens del backlog actual. La acción de indexación usa ese mismo corpus.' }}
              </p>
            </div>
          </div>

          <Message v-if="semanticStatusError" severity="error" :closable="false">{{ semanticStatusError }}</Message>
        </section>

        <section class="rounded-2xl border border-primary/20 bg-primary/5 p-5 space-y-4">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div class="flex items-center gap-2">
                <div class="w-1 h-5 bg-primary-400 rounded-full"></div>
                <h3 class="text-lg font-bold text-primary-700">Busqueda Semantica</h3>
              </div>
              <p class="mt-1 text-sm text-primary-700/70">Consulta cobertura funcional dentro del backlog del proyecto.</p>
            </div>
            <div class="text-right text-xs text-surface-500">
              <p>Top K: {{ semanticSearchTopK }}</p>
              <p>Threshold: {{ semanticSearchThreshold.toFixed(2) }}</p>
            </div>
          </div>

          <div class="space-y-3">
            <Textarea
              v-model="semanticSearchQuery"
              rows="3"
              autoResize
              placeholder="Ejemplo: matriculacion, roles, compatibilidad Moodle, dashboard docente..."
              class="w-full"
            />
            <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label class="block text-[11px] uppercase tracking-wider text-primary-700/70 mb-1">Tipos incluidos</label>
                <MultiSelect
                  v-model="semanticSearchFilters.item_types"
                  :options="backlogTypeOptions"
                  :maxSelectedLabels="2"
                  display="chip"
                  class="w-full"
                />
              </div>
              <div>
                <label class="block text-[11px] uppercase tracking-wider text-primary-700/70 mb-1">Estados incluidos</label>
                <MultiSelect
                  v-model="semanticSearchFilters.statuses"
                  :options="backlogStatusOptions"
                  :maxSelectedLabels="2"
                  display="chip"
                  class="w-full"
                />
              </div>
            </div>
            <div class="flex flex-wrap items-center gap-3">
              <Button
                @click="runSemanticSearch"
                :disabled="isSemanticSearching || !semanticSearchQuery.trim() || !semanticSearchReady"
                :label="isSemanticSearching ? 'Buscando...' : 'Buscar en backlog'"
                icon="pi pi-search"
                size="small"
              />
              <span v-if="!semanticSearchReady" class="text-xs text-amber-600">Indexa el backlog primero para habilitar resultados.</span>
              <span v-else-if="semanticSearchMeta" class="text-xs text-surface-500">{{ semanticSearchMeta.candidates_scanned }} documentos evaluados.</span>
            </div>
          </div>

          <Message v-if="semanticSearchError" severity="error" :closable="false">{{ semanticSearchError }}</Message>

          <div v-if="semanticSearchResults.length" class="space-y-3">
            <article
              v-for="result in semanticSearchResults"
              :key="result.scope_key"
              class="rounded-xl border border-surface-200/40 bg-surface-100 p-4 space-y-2"
            >
              <div class="flex flex-wrap items-center gap-2">
                <Tag :value="`score ${Math.round(result.similarity_score * 100)}%`" severity="info" />
                <Tag :value="result.metadata?.item_type || result.source_type" severity="contrast" />
                <Tag :value="result.metadata?.coverage_state || 'match'" severity="success" />
              </div>
              <h4 class="text-sm font-semibold">{{ result.title }}</h4>
              <p class="text-sm leading-relaxed text-surface-600">{{ result.content_excerpt }}</p>
            </article>
          </div>

          <div v-else-if="semanticSearchMeta && !isSemanticSearching" class="rounded-xl border border-surface-200/40 bg-surface-100 p-4 text-sm text-surface-500">
            No hubo coincidencias para esta consulta con el umbral actual.
          </div>
        </section>
      </div>
      </div>

      <div v-if="activeTab === 'execution'" class="space-y-8">
      <div>
        <div class="flex items-center gap-2 mb-4">
          <div class="w-1 h-5 bg-primary-500 rounded-full"></div>
          <h3 class="text-lg font-bold">Tareas Asociadas</h3>
        </div>

        <Card class="border border-surface-200" :pt="{ body: { class: 'p-0' }, content: { class: 'p-0' } }">
          <template #content>
            <DataTable
              :value="projectTasks"
              v-model:filters="taskFilters"
              filterDisplay="row"
              :paginator="true"
              :rows="200"
              :scrollable="true"
              scrollHeight="480px"
              class="w-full text-sm"
            >
              <template #empty>
                <div class="p-6 text-center text-surface-500 text-sm">No hay tareas asignadas a este proyecto aún.</div>
              </template>

              <Column field="title" header="Título de la Tarea">
                <template #body="{ data }">
                  <span class="font-medium text-surface-700">{{ data.title }}</span>
                </template>
              </Column>
              <Column field="agent_name" header="Agente">
                <template #body="{ data }">
                  <div class="flex items-center gap-2">
                    <Avatar :label="data.agent_name ? data.agent_name.charAt(0).toUpperCase() : '?'" shape="circle" size="normal"
                      :pt="{ root: { class: 'bg-primary text-primary-contrast text-[10px] font-bold' } }" />
                    <span class="text-xs text-surface-600">{{ data.agent_name || 'Sin asignar' }}</span>
                  </div>
                </template>
              </Column>
              <Column field="status" header="Estado" filter filterField="status" :showFilterMenu="false">
                <template #body="{ data }">
                  <Tag :value="data.status.replace('_', ' ')" :severity="taskStatusSeverity(data.status)" />
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
                  <span class="text-xs text-surface-500 flex items-center gap-1">
                    <i class="pi pi-clock"></i>
                    {{ data.last_heartbeat ? new Date(data.last_heartbeat).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : 'Nunca' }}
                  </span>
                </template>
              </Column>
            </DataTable>
          </template>
        </Card>
      </div>

      <div>
        <div class="flex items-center justify-between mb-4">
          <div class="flex items-center gap-2">
            <div class="w-1 h-5 bg-fuchsia-500 rounded-full"></div>
            <h3 class="text-lg font-bold">Backlog Gestionado</h3>
          </div>
          <div class="flex items-center gap-3">
            <Button
              @click="router.push('/dashboard/settings')"
              label="Configurar IA"
              icon="pi pi-cog"
              severity="info"
              outlined
              size="small"
            />
            <Button
              @click="analyzeProjectBacklog"
              :disabled="isAnalyzingBacklog || triageableBacklogCount === 0"
              :label="isAnalyzingBacklog ? 'Analizando backlog...' : `Analizar IA (${triageableBacklogCount})`"
              icon="pi pi-sparkles"
              severity="info"
              size="small"
            />
            <Button
              @click="openBacklogCreator"
              label="Agregar item"
              icon="pi pi-plus"
              severity="help"
              size="small"
            />
            <span class="text-xs font-medium text-surface-500">{{ projectBacklog.length }} item(s)</span>
          </div>
        </div>

        <Card class="border border-surface-200" :pt="{ body: { class: 'p-0' }, content: { class: 'p-0' } }">
          <template #content>
            <DataTable
              :value="projectBacklog"
              v-model:filters="backlogFilters"
              filterDisplay="row"
              :paginator="true"
              :rows="200"
              :scrollable="true"
              scrollHeight="480px"
              class="w-full text-sm"
            >
              <template #empty>
                <div class="p-6 text-center text-surface-500 text-sm">No hay backlog para este proyecto todavía.</div>
              </template>

              <Column field="priority" header="Prioridad" sortable>
                <template #body="{ data }">
                  <span class="text-xs font-semibold text-surface-700">{{ data.priority }}</span>
                </template>
              </Column>

              <Column field="sort_order" header="Orden" sortable>
                <template #body="{ data }">
                  <span class="text-xs text-surface-500">{{ data.sort_order }}</span>
                </template>
              </Column>

              <Column field="title" header="Título" sortable>
                <template #body="{ data }">
                  <div>
                    <p class="font-medium text-surface-700">{{ data.title }}</p>
                    <p v-if="data.description" class="text-xs text-surface-500 truncate max-w-[260px]" :title="data.description">
                      {{ data.description }}
                    </p>
                  </div>
                </template>
              </Column>

              <Column field="item_type" header="Tipo" sortable filter filterField="item_type" :showFilterMenu="false">
                <template #body="{ data }">
                  <span class="text-xs uppercase tracking-wider text-surface-500">{{ data.item_type }}</span>
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
                  <Tag :value="data.status.replace('_', ' ')" :severity="backlogStatusSeverity(data.status)" />
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
                        <Tag
                          :value="(data.llm_recommendation_status || data.status).replace('_', ' ')"
                          :severity="backlogStatusSeverity(data.llm_recommendation_status || data.status)"
                        />
                        <span class="text-[11px] text-surface-500">{{ formatConfidence(data.llm_confidence) }}</span>
                      </div>
                      <p class="text-xs leading-snug text-surface-600">{{ data.llm_analysis_summary }}</p>
                      <p v-if="data.llm_missing_details?.length" class="text-[11px] text-amber-600">
                        Faltan {{ data.llm_missing_details.length }} dato(s) clave.
                      </p>
                    </div>
                    <p v-else class="text-xs text-surface-500">Sin análisis todavía.</p>
                  </div>
                </template>
              </Column>

              <Column header="Task Activa">
                <template #body="{ data }">
                  <span v-if="data.active_task_id" class="text-xs text-primary-600">En ejecución</span>
                  <span v-else class="text-xs text-surface-500">-</span>
                </template>
              </Column>

              <Column header="Acciones">
                <template #body="{ data }">
                  <div class="flex flex-wrap items-center gap-2">
                    <Button
                      @click="analyzeBacklogItem(data)"
                      :disabled="analyzingBacklogId === data.id"
                      :label="analyzingBacklogId === data.id ? 'Analizando...' : 'Analizar IA'"
                      severity="info"
                      size="small"
                    />
                    <Button
                      @click="openBacklogEditor(data)"
                      label="Editar"
                      icon="pi pi-pencil"
                      severity="secondary"
                      size="small"
                    />
                    <Button
                      @click="hardDeleteBacklogItem(data)"
                      :disabled="deletingBacklogId === data.id"
                      :label="deletingBacklogId === data.id ? 'Eliminando...' : 'Hard-delete'"
                      severity="danger"
                      outlined
                      size="small"
                    />
                  </div>
                </template>
              </Column>
            </DataTable>

            <Message v-if="backlogError" severity="error" :closable="false" class="m-4">{{ backlogError }}</Message>
          </template>
        </Card>
      </div>

      <div>
        <div class="flex items-center gap-2 mb-4">
          <div class="w-1 h-5 bg-emerald-500 rounded-full"></div>
          <h3 class="text-lg font-bold">Logs de Ejecución</h3>
        </div>

        <Card class="border border-surface-200" :pt="{ body: { class: 'p-0' }, content: { class: 'p-0' } }">
          <template #content>
            <DataTable
              :value="projectLogs"
              v-model:filters="logFilters"
              filterDisplay="row"
              :paginator="true"
              :rows="200"
              :scrollable="true"
              scrollHeight="480px"
              class="w-full text-sm"
            >
              <template #empty>
                <div class="p-6 text-center text-surface-500 text-sm">No hay logs de ejecución registrados aún.</div>
              </template>

              <Column field="action_type" header="Acción" filter filterField="action_type" :showFilterMenu="false">
                <template #body="{ data }">
                  <span class="text-xs font-medium text-surface-500">{{ data.action_type || 'update' }}</span>
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
                  <span class="text-xs text-surface-500 truncate max-w-[150px] block" :title="data.task_title">{{ data.task_title || '-' }}</span>
                </template>
              </Column>
              <Column field="message" header="Mensaje">
                <template #body="{ data }">
                  <span class="text-sm text-surface-600 leading-snug">{{ data.message }}</span>
                </template>
              </Column>
              <Column field="created_at" header="Hora">
                <template #body="{ data }">
                  <span class="text-xs text-surface-500 whitespace-nowrap">
                    {{ new Date(data.created_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) }}
                  </span>
                </template>
              </Column>
            </DataTable>
          </template>
        </Card>
      </div>
      </div>
    </div>

    <Dialog
      v-model:visible="showEditBacklogDialog"
      modal
      :dismissableMask="true"
      :style="{ width: '98vw', maxWidth: '1800px' }"
      :contentStyle="{ maxHeight: 'calc(96vh - 8rem)', overflowY: 'auto' }"
      @hide="cancelBacklogEdit"
    >
      <template #header>
        <div class="flex items-center gap-2">
          <div class="w-1 h-5 bg-fuchsia-500 rounded-full"></div>
          <h4 class="text-sm md:text-base font-semibold text-fuchsia-700">{{ backlogDialogMode === 'create' ? 'Agregar backlog item' : 'Editar backlog item' }}</h4>
        </div>
      </template>

      <div v-if="editingBacklog" class="space-y-4 min-h-[calc(96vh-14rem)] flex flex-col">
        <div class="grid grid-cols-1 md:grid-cols-4 gap-3">
          <InputText v-model="editingBacklog.title" class="md:col-span-2" placeholder="Título" />
          <Select v-model="editingBacklog.item_type" :options="backlogTypeOptions" placeholder="Tipo" />
          <Select v-model="editingBacklog.status" :options="backlogStatusOptions" placeholder="Estado" />
        </div>

        <div class="grid grid-cols-1 xl:grid-cols-2 gap-4 flex-1">
          <div class="flex flex-col min-h-[34vh]">
            <label class="block text-[11px] uppercase tracking-wider text-fuchsia-700/70 mb-1">Descripcion</label>
            <Textarea v-model="editingBacklog.description" class="flex-1 min-h-[34vh]" />
          </div>
          <div class="flex flex-col min-h-[34vh]">
            <label class="block text-[11px] uppercase tracking-wider text-fuchsia-700/70 mb-1">Criterios de aceptacion</label>
            <Textarea v-model="editingBacklog.acceptance_criteria" class="flex-1 min-h-[34vh]" />
          </div>
        </div>

        <div v-if="editingBacklog.llm_last_analyzed_at" class="rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-4 space-y-3">
          <div class="flex flex-wrap items-center gap-3">
            <Tag
              :value="(editingBacklog.llm_recommendation_status || editingBacklog.status).replace('_', ' ')"
              :severity="backlogStatusSeverity(editingBacklog.llm_recommendation_status || editingBacklog.status)"
            />
            <span class="text-xs text-cyan-700">{{ formatConfidence(editingBacklog.llm_confidence) }}</span>
            <span class="text-xs text-surface-500">{{ editingBacklog.llm_analysis_model || 'modelo no informado' }}</span>
            <span class="text-xs text-surface-500">{{ formatDateTime(editingBacklog.llm_last_analyzed_at) }}</span>
          </div>
          <p class="text-sm text-surface-700 leading-relaxed">{{ editingBacklog.llm_analysis_summary }}</p>
          <div v-if="editingBacklog.llm_missing_details?.length" class="space-y-2">
            <p class="text-[11px] uppercase tracking-wider text-amber-600/80">Datos que faltan</p>
            <ul class="space-y-2 text-sm text-amber-600/90 list-disc pl-5">
              <li v-for="detail in editingBacklog.llm_missing_details" :key="detail">{{ detail }}</li>
            </ul>
          </div>
        </div>

        <div class="flex flex-wrap items-end gap-3 pt-2 border-t border-surface-200/40">
          <div>
            <label class="block text-[11px] uppercase tracking-wider text-fuchsia-700/70 mb-1">Prioridad</label>
            <InputNumber v-model="editingBacklog.priority" class="w-28" :useGrouping="false" />
          </div>
          <div>
            <label class="block text-[11px] uppercase tracking-wider text-fuchsia-700/70 mb-1">Orden</label>
            <InputNumber v-model="editingBacklog.sort_order" class="w-28" :useGrouping="false" />
          </div>
          <Button
            @click="saveBacklogItem"
            :disabled="isSavingBacklog || !editingBacklog.title?.trim()"
            :label="isSavingBacklog ? 'Guardando...' : backlogDialogMode === 'create' ? 'Crear item' : 'Guardar cambios'"
            severity="help"
            class="ml-auto"
          />
          <Button
            v-if="backlogDialogMode === 'edit' && editingBacklog.id"
            @click="hardDeleteBacklogItem(editingBacklog)"
            :disabled="deletingBacklogId === editingBacklog.id"
            :label="deletingBacklogId === editingBacklog.id ? 'Eliminando...' : 'Eliminar permanentemente'"
            severity="danger"
          />
        </div>
      </div>
    </Dialog>
  </div>
</template>

<script setup>
import { computed, ref, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { apiFetchJson, getApiErrorMessage } from '../config/api';

const route = useRoute();
const router = useRouter();

const activeTab = ref('execution');
const tabOptions = [
  { label: 'Ejecución', value: 'execution' },
  { label: 'Semántico', value: 'semantic' }
];
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
const semanticStatus = ref(null);
const semanticStatusLoading = ref(false);
const semanticStatusError = ref(null);
const isSemanticIndexing = ref(false);
const semanticSearchQuery = ref('');
const semanticSearchFilters = ref({
  item_types: [],
  statuses: []
});
const semanticSearchResults = ref([]);
const semanticSearchMeta = ref(null);
const semanticSearchError = ref(null);
const isSemanticSearching = ref(false);

const semanticSearchTopK = 5;
const semanticSearchThreshold = 0.6;

const backlogTypeOptions = ['feature', 'bug', 'chore', 'research'];
// `ready_for_dev` es el estado que el motor de metodo escribe en cada story; sin el en
// esta lista, el panel no podia filtrar por el ni ofrecerlo al editar.
const backlogStatusOptions = ['draft', 'needs_details', 'ready', 'ready_for_dev', 'in_progress', 'review', 'blocked', 'done', 'archived'];
const taskStatusOptions = ['todo', 'in_progress', 'review', 'done', 'stalled'];

const triageableBacklogCount = computed(() => {
  return projectBacklog.value.filter((item) => ['draft', 'needs_details', 'ready'].includes(item.status)).length;
});

const semanticPendingDocuments = computed(() => {
  if (!semanticStatus.value) {
    return 0;
  }

  return Number(semanticStatus.value.stale_documents || 0) + Number(semanticStatus.value.missing_documents || 0);
});

const semanticSearchReady = computed(() => {
  return Number(semanticStatus.value?.indexed_documents || 0) > 0;
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
  activeTab.value = 'execution';
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
  semanticStatus.value = null;
  semanticStatusLoading.value = false;
  semanticStatusError.value = null;
  isSemanticIndexing.value = false;
  semanticSearchQuery.value = '';
  semanticSearchFilters.value = {
    item_types: [],
    statuses: []
  };
  semanticSearchResults.value = [];
  semanticSearchMeta.value = null;
  semanticSearchError.value = null;
  isSemanticSearching.value = false;
};

const fetchSemanticStatus = async (url) => {
  semanticStatusLoading.value = true;
  semanticStatusError.value = null;

  try {
    const encodedUrl = encodeURIComponent(url);
    const { data } = await apiFetchJson(`/dashboard/projects/${encodedUrl}/semantic/backlog/status`, {
      credentials: 'include'
    }, 'No se pudo calcular el estado semántico del proyecto.');

    semanticStatus.value = data.semantic || null;
  } catch (error) {
    semanticStatusError.value = getApiErrorMessage(error, 'No se pudo calcular el estado semántico del proyecto.');
    console.error('Failed to load semantic status', error);
  } finally {
    semanticStatusLoading.value = false;
  }
};

const fetchProjectDetails = async (url) => {
  backlogError.value = null;

  try {
    const encodedUrl = encodeURIComponent(url);
    const { data } = await apiFetchJson(`/dashboard/projects/${encodedUrl}`, {
      credentials: 'include'
    }, 'No se pudo cargar el detalle del proyecto.');

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
    backlogError.value = getApiErrorMessage(error, 'No se pudo cargar el detalle del proyecto.');
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
    await fetchSemanticStatus(routeProjectId);
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
    const { data } = await apiFetchJson(`/dashboard/backlog/${item.id}/analyze`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json'
      }
    }, 'No se pudo analizar el backlog item.');

    await fetchProjectDetails(selectedProject.value.url);

    if (editingBacklog.value?.id === item.id) {
      editingBacklog.value = { ...data.backlog_item };
    }
  } catch (error) {
    backlogError.value = getApiErrorMessage(error, 'No se pudo analizar el backlog item.');
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
    await apiFetchJson(`/dashboard/projects/${encodedUrl}/backlog/analyze`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        statuses: ['draft', 'needs_details', 'ready']
      })
    }, 'No se pudo analizar el backlog del proyecto.');

    await fetchProjectDetails(selectedProject.value.url);
  } catch (error) {
    backlogError.value = getApiErrorMessage(error, 'No se pudo analizar el backlog del proyecto.');
    console.error('Failed to analyze project backlog', error);
  } finally {
    isAnalyzingBacklog.value = false;
  }
};

const refreshSemanticStatus = async () => {
  if (!selectedProject.value?.url) {
    return;
  }

  await fetchSemanticStatus(selectedProject.value.url);
};

const runSemanticIndex = async () => {
  if (!selectedProject.value?.url) {
    return;
  }

  isSemanticIndexing.value = true;
  semanticStatusError.value = null;
  semanticSearchError.value = null;

  try {
    const encodedUrl = encodeURIComponent(selectedProject.value.url);
    const { data } = await apiFetchJson(`/dashboard/projects/${encodedUrl}/semantic/backlog/index`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({})
    }, 'No se pudo indexar semánticamente el backlog del proyecto.');

    semanticStatus.value = data.semantic || null;
  } catch (error) {
    semanticStatusError.value = getApiErrorMessage(error, 'No se pudo indexar semánticamente el backlog del proyecto.');
    console.error('Failed to index semantic backlog', error);
  } finally {
    isSemanticIndexing.value = false;
  }
};

const runSemanticSearch = async () => {
  if (!selectedProject.value?.url || !semanticSearchQuery.value.trim()) {
    return;
  }

  isSemanticSearching.value = true;
  semanticSearchError.value = null;
  semanticSearchResults.value = [];
  semanticSearchMeta.value = null;

  try {
    const encodedUrl = encodeURIComponent(selectedProject.value.url);
    const { data } = await apiFetchJson(`/dashboard/projects/${encodedUrl}/semantic/backlog/search`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        query_text: semanticSearchQuery.value.trim(),
        item_types: semanticSearchFilters.value.item_types,
        statuses: semanticSearchFilters.value.statuses,
        top_k: semanticSearchTopK,
        threshold: semanticSearchThreshold
      })
    }, 'No se pudo ejecutar la búsqueda semántica.');

    semanticStatus.value = data.semantic || semanticStatus.value;
    semanticSearchMeta.value = data.search || null;
    semanticSearchResults.value = data.search?.matches || [];
  } catch (error) {
    if (error?.data?.semantic) {
      semanticStatus.value = error.data.semantic;
    }
    semanticSearchError.value = getApiErrorMessage(error, 'No se pudo ejecutar la búsqueda semántica.');
    console.error('Failed to search semantic backlog', error);
  } finally {
    isSemanticSearching.value = false;
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
    await apiFetchJson(`/dashboard/backlog/${item.id}`, {
      method: 'DELETE',
      credentials: 'include'
    }, 'No se pudo eliminar el backlog item.');

    if (editingBacklog.value?.id === item.id) {
      showEditBacklogDialog.value = false;
      editingBacklog.value = null;
      backlogDialogMode.value = 'edit';
    }

    await fetchProjectDetails(selectedProject.value.url);
  } catch (error) {
    backlogError.value = getApiErrorMessage(error, 'No se pudo eliminar el backlog item.');
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
    await apiFetchJson(isCreate ? `/dashboard/projects/${encodedUrl}/backlog` : `/dashboard/backlog/${editingBacklog.value.id}`, {
      method: isCreate ? 'POST' : 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(isCreate ? {
        ...payload,
        source_kind: 'dashboard',
        source_ref: 'project-details-view'
      } : payload)
    }, isCreate ? 'No se pudo crear el backlog item.' : 'No se pudo actualizar el backlog item.');

    showEditBacklogDialog.value = false;
    editingBacklog.value = null;
    backlogDialogMode.value = 'edit';
    await fetchProjectDetails(selectedProject.value.url);
  } catch (error) {
    backlogError.value = getApiErrorMessage(error, backlogDialogMode.value === 'create'
      ? 'No se pudo crear el backlog item.'
      : 'No se pudo actualizar el backlog item.');
    console.error('Failed to save backlog item', error);
  } finally {
    isSavingBacklog.value = false;
  }
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

const taskStatusSeverity = (status) => {
  const map = {
    todo: 'secondary',
    in_progress: 'info',
    review: 'contrast',
    done: 'success',
    stalled: 'warn'
  };
  return map[status] || 'secondary';
};

const backlogStatusSeverity = (status) => {
  const map = {
    draft: 'secondary',
    needs_details: 'warn',
    ready: 'info',
    in_progress: 'info',
    review: 'contrast',
    blocked: 'danger',
    done: 'success',
    archived: 'secondary'
  };
  return map[status] || 'secondary';
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

const formatNumber = (value) => {
  if (value == null || value === '') {
    return 'n/d';
  }

  return Number(value || 0).toLocaleString();
};

const formatCurrency = (value) => {
  if (value == null || !Number.isFinite(Number(value))) {
    return 'n/d';
  }

  return Number(value).toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 4,
    maximumFractionDigits: 6
  });
};

const formatModelPrice = (value) => {
  if (value == null || !Number.isFinite(Number(value))) {
    return 'n/d';
  }

  return `${Number(value).toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 8,
    maximumFractionDigits: 8
  })} por token`;
};

watch(() => route.params.projectId, () => {
  loadProject();
});

onMounted(() => {
  loadProject();
});
</script>
