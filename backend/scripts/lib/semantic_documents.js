const {
  createContentHash,
  cosineSimilarity,
  getEffectiveEmbeddingModel,
  normalizeTextField,
  parseEmbeddingVector,
  requestEmbedding,
  truncateText
} = require('./semantic_embeddings');

const DEFAULT_TOP_K = 5;
const DEFAULT_THRESHOLD = 0.6;
const DEFAULT_EMBEDDING_COST_UNIT = 1000;

const compactJson = (value) => JSON.stringify(value);

const inferCoverageState = (status) => {
  switch (status) {
    case 'done':
      return 'delivered';
    case 'review':
    case 'in_progress':
      return 'active';
    case 'blocked':
      return 'blocked';
    case 'archived':
      return 'archived';
    case 'needs_details':
      return 'underspecified';
    default:
      return 'planned';
  }
};

const buildBacklogCoverageDocument = (item) => {
  const title = normalizeTextField(item.title);
  const description = normalizeTextField(item.description);
  const acceptanceCriteria = normalizeTextField(item.acceptance_criteria);
  const sourceKind = normalizeTextField(item.source_kind);
  const sourceRef = normalizeTextField(item.source_ref);
  const activeTaskTitle = normalizeTextField(item.active_task_title);
  const activeTaskContext = normalizeTextField(item.active_task_context);
  const deferredScope = item.status === 'needs_details'
    ? 'Falta detalle funcional para confirmar cobertura completa.'
    : item.status === 'blocked'
      ? 'La necesidad aparece planificada pero bloqueada.'
      : '';

  const metadata = {
    backlog_item_id: item.id,
    item_type: item.item_type,
    operational_status: item.status,
    coverage_state: inferCoverageState(item.status),
    functional_intent: truncateText([title, description].filter(Boolean).join('. '), 2000) || null,
    actor_tags: [],
    module_tags: [],
    workflow_tags: [],
    evidence_refs: item.active_task_id
      ? [{ type: 'task', id: item.active_task_id }]
      : [],
    deferred_scope: deferredScope || null,
    source_kind: sourceKind || null,
    source_ref: sourceRef || null
  };

  const content = truncateText([
    'estrategia: backlog_functional_coverage',
    title ? `titulo: ${title}` : '',
    `tipo_item: ${item.item_type}`,
    `estado_operativo: ${item.status}`,
    `estado_cobertura_funcional: ${metadata.coverage_state}`,
    metadata.functional_intent ? `intencion_funcional: ${metadata.functional_intent}` : '',
    description ? `descripcion: ${description}` : '',
    acceptanceCriteria ? `criterios_aceptacion: ${acceptanceCriteria}` : '',
    sourceKind ? `origen: ${sourceKind}` : '',
    sourceRef ? `referencia: ${sourceRef}` : '',
    activeTaskTitle ? `tarea_activa: ${activeTaskTitle}` : '',
    activeTaskContext ? `contexto_tarea_activa: ${activeTaskContext}` : '',
    deferredScope ? `alcance_diferido: ${deferredScope}` : ''
  ].filter(Boolean).join('\n\n'));

  return {
    project_url: item.project_url,
    strategy_key: 'backlog_functional_coverage',
    scope_key: `backlog_item:${item.id}`,
    source_type: 'backlog_item',
    source_id: item.id,
    title,
    content,
    document_metadata: metadata,
    content_hash: createContentHash(compactJson({ title, content, metadata }))
  };
};

const ensureSemanticTables = async (connection) => {
  const hasDocumentsTable = await connection.schema.hasTable('semantic_documents');
  if (!hasDocumentsTable) {
    return false;
  }

  const hasEmbeddingsTable = await connection.schema.hasTable('semantic_document_embeddings');
  return hasEmbeddingsTable;
};

const loadBacklogItemSemanticSource = async (connection, backlogItemId) => connection('backlog_items as bi')
  .leftJoin('tasks as t', 't.id', 'bi.active_task_id')
  .select(
    'bi.id',
    'bi.project_url',
    'bi.title',
    'bi.description',
    'bi.acceptance_criteria',
    'bi.item_type',
    'bi.status',
    'bi.source_kind',
    'bi.source_ref',
    'bi.active_task_id',
    't.title as active_task_title',
    't.context as active_task_context'
  )
  .where('bi.id', backlogItemId)
  .whereNull('bi.deleted_at')
  .first();

const loadProjectBacklogSemanticSources = async (connection, projectUrl) => connection('backlog_items as bi')
  .leftJoin('tasks as t', 't.id', 'bi.active_task_id')
  .select(
    'bi.id',
    'bi.project_url',
    'bi.title',
    'bi.description',
    'bi.acceptance_criteria',
    'bi.item_type',
    'bi.status',
    'bi.source_kind',
    'bi.source_ref',
    'bi.active_task_id',
    't.title as active_task_title',
    't.context as active_task_context'
  )
  .where('bi.project_url', projectUrl)
  .whereNull('bi.deleted_at')
  .orderBy('bi.updated_at', 'desc');

const buildProjectBacklogCoverageDocuments = async (connection, projectUrl) => {
  const rows = await loadProjectBacklogSemanticSources(connection, projectUrl);
  return rows.map(buildBacklogCoverageDocument);
};

const estimateTokenCount = (value) => {
  const normalized = normalizeTextField(value);
  if (!normalized) {
    return 0;
  }

  return Math.ceil(normalized.length / 4);
};

const estimateEmbeddingCost = (estimatedInputTokens, promptPrice) => {
  const normalizedTokens = Number(estimatedInputTokens);
  const normalizedPromptPrice = Number(promptPrice);

  if (!Number.isFinite(normalizedTokens) || normalizedTokens <= 0 || !Number.isFinite(normalizedPromptPrice) || normalizedPromptPrice < 0) {
    return null;
  }

  return normalizedTokens * normalizedPromptPrice * DEFAULT_EMBEDDING_COST_UNIT;
};

const upsertSemanticDocument = async (connection, document) => {
  const [savedDocument] = await connection('semantic_documents')
    .insert({
      ...document,
      created_at: connection.fn.now(),
      updated_at: connection.fn.now()
    })
    .onConflict(['project_url', 'strategy_key', 'scope_key'])
    .merge({
      source_type: document.source_type,
      source_id: document.source_id,
      title: document.title,
      content: document.content,
      document_metadata: document.document_metadata,
      content_hash: document.content_hash,
      updated_at: connection.fn.now()
    })
    .returning(['id', 'content_hash']);

  return savedDocument;
};

const persistSemanticDocumentEmbedding = async (connection, document, savedDocument) => {
  const existingEmbedding = await connection('semantic_document_embeddings')
    .where({ semantic_document_id: savedDocument.id, strategy_key: document.strategy_key })
    .orderBy('updated_at', 'desc')
    .first('id', 'embedding_model', 'generated_from_hash');

  if (existingEmbedding && existingEmbedding.generated_from_hash === document.content_hash) {
    return { status: 'unchanged', semantic_document_id: savedDocument.id };
  }

  const embeddingResult = await requestEmbedding(connection, document.strategy_key, document.content, {
    usageType: `semantic_document:${document.strategy_key}`,
    projectUrl: document.project_url,
    backlogItemId: document.source_type === 'backlog_item' ? document.source_id : null
  });

  await connection('semantic_document_embeddings')
    .insert({
      semantic_document_id: savedDocument.id,
      strategy_key: document.strategy_key,
      embedding_model: embeddingResult.model,
      embedding: JSON.stringify(embeddingResult.embedding),
      embedding_norm: embeddingResult.norm,
      generated_from_hash: document.content_hash,
      embedded_at: connection.fn.now(),
      created_at: connection.fn.now(),
      updated_at: connection.fn.now()
    })
    .onConflict(['semantic_document_id', 'embedding_model'])
    .merge({
      strategy_key: document.strategy_key,
      embedding: JSON.stringify(embeddingResult.embedding),
      embedding_norm: embeddingResult.norm,
      generated_from_hash: document.content_hash,
      embedded_at: connection.fn.now(),
      updated_at: connection.fn.now()
    });

  return {
    status: 'embedded',
    semantic_document_id: savedDocument.id,
    model: embeddingResult.model
  };
};

const syncBacklogCoverageDocument = async (connection, backlogItemId) => {
  if (!backlogItemId) {
    return { status: 'skipped', reason: 'missing_backlog_item_id' };
  }

  const hasSemanticTables = await ensureSemanticTables(connection);
  if (!hasSemanticTables) {
    return { status: 'skipped', reason: 'semantic_tables_missing' };
  }

  const source = await loadBacklogItemSemanticSource(connection, backlogItemId);
  if (!source) {
    await connection('semantic_documents')
      .where({ strategy_key: 'backlog_functional_coverage', source_type: 'backlog_item', source_id: backlogItemId })
      .del();

    return { status: 'deleted', backlog_item_id: backlogItemId };
  }

  const document = buildBacklogCoverageDocument(source);
  const savedDocument = await upsertSemanticDocument(connection, document);
  const embeddingResult = await persistSemanticDocumentEmbedding(connection, document, savedDocument);

  return {
    status: embeddingResult.status,
    backlog_item_id: backlogItemId,
    semantic_document_id: savedDocument.id,
    model: embeddingResult.model || null
  };
};

const syncBacklogCoverageDocuments = async (connection, backlogItemIds) => {
  const normalizedIds = [...new Set((backlogItemIds || []).filter(Boolean))];
  const results = [];

  for (const backlogItemId of normalizedIds) {
    results.push(await syncBacklogCoverageDocument(connection, backlogItemId));
  }

  return results;
};

const syncProjectBacklogCoverageDocuments = async (connection, projectUrl) => {
  const rows = await connection('backlog_items')
    .where({ project_url: projectUrl })
    .whereNull('deleted_at')
    .orderBy('updated_at', 'desc')
    .select('id');

  return syncBacklogCoverageDocuments(connection, rows.map((row) => row.id));
};

const getProjectBacklogCoverageStatus = async (connection, projectUrl) => {
  const documents = await buildProjectBacklogCoverageDocuments(connection, projectUrl);
  const estimatedInputTokens = documents.reduce((sum, document) => sum + estimateTokenCount(document.content), 0);
  const embeddingModel = await getEffectiveEmbeddingModel(connection, 'backlog_functional_coverage');
  const hasSemanticTables = await ensureSemanticTables(connection);

  if (!hasSemanticTables) {
    return {
      strategy_key: 'backlog_functional_coverage',
      embedding_model: embeddingModel,
      total_documents: documents.length,
      indexed_documents: 0,
      stale_documents: 0,
      missing_documents: documents.length,
      estimated_input_tokens: estimatedInputTokens,
      estimated_incremental_input_tokens: estimatedInputTokens,
      fully_indexed: false,
      last_indexed_at: null,
      sample_documents: documents.slice(0, 5).map((document) => ({
        scope_key: document.scope_key,
        title: document.title,
        estimated_tokens: estimateTokenCount(document.content)
      }))
    };
  }

  const storedDocuments = await connection('semantic_documents')
    .where({ project_url: projectUrl, strategy_key: 'backlog_functional_coverage' })
    .select('id', 'scope_key', 'content_hash', 'updated_at');

  const storedEmbeddings = storedDocuments.length
    ? await connection('semantic_document_embeddings')
      .whereIn('semantic_document_id', storedDocuments.map((document) => document.id))
      .andWhere({ strategy_key: 'backlog_functional_coverage', embedding_model: embeddingModel })
      .select('semantic_document_id', 'generated_from_hash', 'embedded_at')
    : [];

  const storedDocumentByScope = new Map(storedDocuments.map((document) => [document.scope_key, document]));
  const storedEmbeddingByDocumentId = new Map(storedEmbeddings.map((embedding) => [embedding.semantic_document_id, embedding]));

  let indexedDocuments = 0;
  let staleDocuments = 0;
  let missingDocuments = 0;
  let estimatedIncrementalInputTokens = 0;
  let lastIndexedAt = null;

  for (const document of documents) {
    const documentTokens = estimateTokenCount(document.content);
    const storedDocument = storedDocumentByScope.get(document.scope_key);
    if (!storedDocument) {
      missingDocuments += 1;
      estimatedIncrementalInputTokens += documentTokens;
      continue;
    }

    const storedEmbedding = storedEmbeddingByDocumentId.get(storedDocument.id);
    if (!storedEmbedding) {
      staleDocuments += 1;
      estimatedIncrementalInputTokens += documentTokens;
      continue;
    }

    if (storedEmbedding.generated_from_hash !== document.content_hash) {
      staleDocuments += 1;
      estimatedIncrementalInputTokens += documentTokens;
      continue;
    }

    indexedDocuments += 1;
    if (!lastIndexedAt || new Date(storedEmbedding.embedded_at) > new Date(lastIndexedAt)) {
      lastIndexedAt = storedEmbedding.embedded_at;
    }
  }

  return {
    strategy_key: 'backlog_functional_coverage',
    embedding_model: embeddingModel,
    total_documents: documents.length,
    indexed_documents: indexedDocuments,
    stale_documents: staleDocuments,
    missing_documents: missingDocuments,
    estimated_input_tokens: estimatedInputTokens,
    estimated_incremental_input_tokens: estimatedIncrementalInputTokens,
    fully_indexed: documents.length > 0 && indexedDocuments === documents.length,
    last_indexed_at: lastIndexedAt,
    sample_documents: documents.slice(0, 5).map((document) => ({
      scope_key: document.scope_key,
      title: document.title,
      estimated_tokens: estimateTokenCount(document.content)
    }))
  };
};

const searchProjectBacklogCoverage = async (connection, {
  projectUrl,
  queryText,
  itemTypes = [],
  statuses = [],
  topK = DEFAULT_TOP_K,
  threshold = DEFAULT_THRESHOLD
}) => {
  const embeddingModel = await getEffectiveEmbeddingModel(connection, 'backlog_functional_coverage');
  const queryEmbeddingResult = await requestEmbedding(connection, 'backlog_functional_coverage', queryText, {
    usageType: 'semantic_search:backlog_functional_coverage',
    projectUrl
  });

  const candidates = await connection('semantic_document_embeddings as sde')
    .join('semantic_documents as sd', 'sd.id', 'sde.semantic_document_id')
    .select(
      'sd.project_url',
      'sd.scope_key',
      'sd.source_type',
      'sd.source_id',
      'sd.title',
      'sd.content',
      'sd.document_metadata',
      'sde.embedding',
      'sde.embedding_norm'
    )
    .where('sd.project_url', projectUrl)
    .where('sd.strategy_key', 'backlog_functional_coverage')
    .where('sde.strategy_key', 'backlog_functional_coverage')
    .where('sde.embedding_model', embeddingModel);

  const normalizedItemTypes = Array.isArray(itemTypes)
    ? [...new Set(itemTypes.map((value) => normalizeTextField(value)).filter(Boolean))]
    : [];
  const normalizedStatuses = Array.isArray(statuses)
    ? [...new Set(statuses.map((value) => normalizeTextField(value)).filter(Boolean))]
    : [];

  const matches = candidates
    .map((candidate) => {
      const candidateEmbedding = parseEmbeddingVector(candidate.embedding);
      const similarityScore = cosineSimilarity(
        queryEmbeddingResult.embedding,
        candidateEmbedding,
        queryEmbeddingResult.norm,
        Number(candidate.embedding_norm)
      );

      if (!Number.isFinite(similarityScore)) {
        return null;
      }

      return {
        similarity_score: Math.max(0, Math.min(1, similarityScore)),
        project_url: candidate.project_url,
        scope_key: candidate.scope_key,
        source_type: candidate.source_type,
        source_id: candidate.source_id,
        title: candidate.title,
        content_excerpt: candidate.content.slice(0, 240),
        metadata: candidate.document_metadata
      };
    })
    .filter(Boolean)
    .filter((match) => {
      if (!normalizedItemTypes.length) {
        return true;
      }

      return normalizedItemTypes.includes(normalizeTextField(match.metadata?.item_type));
    })
    .filter((match) => {
      if (!normalizedStatuses.length) {
        return true;
      }

      return normalizedStatuses.includes(normalizeTextField(match.metadata?.operational_status));
    })
    .filter((match) => match.similarity_score >= threshold)
    .sort((left, right) => right.similarity_score - left.similarity_score)
    .slice(0, topK);

  return {
    strategy_key: 'backlog_functional_coverage',
    embedding_model: embeddingModel,
    query_text: queryText,
    item_types: normalizedItemTypes,
    statuses: normalizedStatuses,
    top_k: topK,
    threshold,
    candidates_scanned: candidates.length,
    matches
  };
};

const deleteSemanticDocumentsForBacklogItem = async (connection, backlogItemId) => {
  if (!backlogItemId) {
    return 0;
  }

  const hasDocumentsTable = await connection.schema.hasTable('semantic_documents');
  if (!hasDocumentsTable) {
    return 0;
  }

  return connection('semantic_documents')
    .where({ source_type: 'backlog_item', source_id: backlogItemId })
    .del();
};

module.exports = {
  buildBacklogCoverageDocument,
  buildProjectBacklogCoverageDocuments,
  deleteSemanticDocumentsForBacklogItem,
  estimateEmbeddingCost,
  estimateTokenCount,
  inferCoverageState,
  getProjectBacklogCoverageStatus,
  loadBacklogItemSemanticSource,
  loadProjectBacklogSemanticSources,
  searchProjectBacklogCoverage,
  syncBacklogCoverageDocument,
  syncBacklogCoverageDocuments,
  syncProjectBacklogCoverageDocuments
};