const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const knexFactory = require('knex');
const knexConfig = require('../knexfile');
const {
  cosineSimilarity,
  getEffectiveEmbeddingModel,
  parseEmbeddingVector,
  requestEmbedding
} = require('./lib/semantic_embeddings');

const DEFAULT_TARGET_ENV = process.env.APTS_SEMANTIC_TARGET_ENV || 'test';
const DEFAULT_TOP_K = 5;
const DEFAULT_THRESHOLD = 0.6;

const parseArgs = (argv) => {
  const options = {
    targetEnv: DEFAULT_TARGET_ENV,
    strategy: 'backlog_functional_coverage',
    projects: [],
    queryText: '',
    topK: DEFAULT_TOP_K,
    threshold: DEFAULT_THRESHOLD
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--strategy') {
      options.strategy = argv[index + 1] || options.strategy;
      index += 1;
      continue;
    }

    if (arg.startsWith('--strategy=')) {
      options.strategy = arg.slice('--strategy='.length) || options.strategy;
      continue;
    }

    if (arg === '--project') {
      options.projects.push(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg.startsWith('--project=')) {
      options.projects.push(arg.slice('--project='.length));
      continue;
    }

    if (arg === '--query') {
      options.queryText = argv[index + 1] || options.queryText;
      index += 1;
      continue;
    }

    if (arg.startsWith('--query=')) {
      options.queryText = arg.slice('--query='.length) || options.queryText;
      continue;
    }

    if (arg === '--top-k') {
      options.topK = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg.startsWith('--top-k=')) {
      options.topK = Number(arg.slice('--top-k='.length));
      continue;
    }

    if (arg === '--threshold') {
      options.threshold = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg.startsWith('--threshold=')) {
      options.threshold = Number(arg.slice('--threshold='.length));
      continue;
    }

    if (arg === '--target-env') {
      options.targetEnv = argv[index + 1] || options.targetEnv;
      index += 1;
      continue;
    }

    if (arg.startsWith('--target-env=')) {
      options.targetEnv = arg.slice('--target-env='.length) || options.targetEnv;
      continue;
    }
  }

  options.projects = options.projects.filter(Boolean);
  options.topK = Number.isInteger(options.topK) && options.topK > 0 ? options.topK : DEFAULT_TOP_K;
  options.threshold = Number.isFinite(options.threshold) ? options.threshold : DEFAULT_THRESHOLD;
  return options;
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  if (!options.queryText.trim()) {
    throw new Error('Missing query text. Pass --query "...".');
  }

  const targetConfig = knexConfig[options.targetEnv];
  if (!targetConfig) {
    throw new Error(`Unknown target env '${options.targetEnv}'. Expected one of: ${Object.keys(knexConfig).join(', ')}`);
  }

  const db = knexFactory(targetConfig);

  try {
    const embeddingModel = await getEffectiveEmbeddingModel(db, options.strategy);
    const queryEmbeddingResult = await requestEmbedding(db, options.strategy, options.queryText, {
      usageType: `semantic_search:${options.strategy}`,
      projectUrl: options.projects[0] || null
    });

    const candidateQuery = db('semantic_document_embeddings as sde')
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
        'sde.embedding_norm',
        'sde.embedding_model'
      )
      .where('sd.strategy_key', options.strategy)
      .where('sde.strategy_key', options.strategy)
      .where('sde.embedding_model', embeddingModel);

    if (options.projects.length) {
      candidateQuery.whereIn('sd.project_url', options.projects);
    }

    const candidates = await candidateQuery;
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
      .filter((match) => match.similarity_score >= options.threshold)
      .sort((left, right) => right.similarity_score - left.similarity_score)
      .slice(0, options.topK);

    console.log(JSON.stringify({
      target_env: options.targetEnv,
      strategy: options.strategy,
      embedding_model: embeddingModel,
      query_text: options.queryText,
      threshold: options.threshold,
      top_k: options.topK,
      candidates_scanned: candidates.length,
      matches
    }, null, 2));
  } finally {
    await db.destroy();
  }
};

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});