/**
 * Orchestrator-side embedding helper for the review-learnings RAG path
 * (Phase 1.5.H).
 *
 * Loads a small open-source sentence-transformer (`Xenova/bge-small-en-v1.5`,
 * ~33 MB, 384-dim) via `@huggingface/transformers` and exposes a
 * `embedTexts(strings)` function that returns one normalised vector per
 * input. The model is loaded lazily on first call and cached for the
 * lifetime of the process; subsequent calls reuse the warm pipeline.
 *
 * Architecture notes:
 * - This module lives orchestrator-side ONLY. The daemon image stays lean.
 *   Embeddings (save-time on each new directive, query-time on each
 *   changed-file path during handleAccept) all happen in the orchestrator.
 * - The model + ONNX runtime add ~80 MB to the orchestrator image. They
 *   are imported only when `REVIEW_LEARNINGS_RAG_ENABLED=true` AND a
 *   call site invokes `embedTexts`; the import itself is dynamic so the
 *   default `false` deploy avoids paying the load cost.
 * - Failure mode: when the model fails to initialise (missing native
 *   runtime, OOM on first load), all subsequent calls return `null`.
 *   The caller treats `null` as "skip the embedding step" so RAG silently
 *   downgrades to the deterministic file-glob filter rather than failing
 *   the dispatch.
 */

import { config } from "../config";
import { logger } from "../logger";

/** Dimension of the chosen model. MUST stay in sync with migration 015's `vector(384)`. */
export const EMBEDDING_DIMENSION = 384;

/** Model identifier resolved through HuggingFace Hub. */
const EMBEDDING_MODEL_ID = "Xenova/bge-small-en-v1.5";

type FeatureExtractionPipeline = (
  texts: string | string[],
  options?: { pooling?: "mean" | "none" | "cls"; normalize?: boolean },
) => Promise<{ data: Float32Array | number[]; dims: number[] }>;

let cachedPipeline: FeatureExtractionPipeline | null = null;
let pipelineLoadFailed = false;

/**
 * Lazily load the feature-extraction pipeline. Returns `null` if loading
 * fails. Every subsequent call short-circuits so a broken model install
 * doesn't pay the load cost on every dispatch.
 */
async function getPipeline(): Promise<FeatureExtractionPipeline | null> {
  if (cachedPipeline !== null) return cachedPipeline;
  if (pipelineLoadFailed) return null;
  try {
    // Dynamic import keeps the ONNX runtime out of memory until RAG is
    // actually exercised. A startup with RAG disabled never pays the cost.
    const { pipeline } = await import("@huggingface/transformers");
    // ONNX backend, CPU-only. The default-quantised int8 weights are ~17 MB
    // and ~3x faster than fp32 with negligible accuracy loss on short
    // directive text, so we don't pass any options.
    const fePipeline = (await pipeline(
      "feature-extraction",
      EMBEDDING_MODEL_ID,
    )) as unknown as FeatureExtractionPipeline;
    // require-atomic-updates: even if another caller raced to set
    // cachedPipeline while we awaited, the result is the same pipeline
    // instance from HuggingFace's module-level cache; assigning ours is
    // safe (and the value-equivalent).
    cachedPipeline ??= fePipeline;
    logger.info(
      { model: EMBEDDING_MODEL_ID, dimension: EMBEDDING_DIMENSION },
      "Embedding pipeline loaded",
    );
    return cachedPipeline;
  } catch (err) {
    pipelineLoadFailed = true;
    logger.warn({ err, model: EMBEDDING_MODEL_ID }, "Embedding pipeline failed to load");
    return null;
  }
}

/**
 * Embed each input string. Returns `null` when RAG is disabled or the
 * pipeline failed to load. The caller falls back to the deterministic
 * file-glob path.
 *
 * Inputs are mean-pooled and L2-normalised so they're ready for cosine
 * distance against pgvector's `<=>` operator (which is `1 - cosine_sim`).
 */
export async function embedTexts(texts: readonly string[]): Promise<number[][] | null> {
  if (!config.reviewLearningsRagEnabled) return null;
  if (texts.length === 0) return [];

  const fe = await getPipeline();
  if (fe === null) return null;

  try {
    const result = await fe(Array.from(texts), { pooling: "mean", normalize: true });
    // Output tensor: shape [N, EMBEDDING_DIMENSION] flattened into `data`.
    const flat = Array.from(result.data as ArrayLike<number>);
    const n = texts.length;
    if (flat.length !== n * EMBEDDING_DIMENSION) {
      logger.warn(
        { expected: n * EMBEDDING_DIMENSION, got: flat.length },
        "Embedding tensor shape mismatch; skipping",
      );
      return null;
    }
    const out: number[][] = [];
    for (let i = 0; i < n; i++) {
      out.push(flat.slice(i * EMBEDDING_DIMENSION, (i + 1) * EMBEDDING_DIMENSION));
    }
    return out;
  } catch (err) {
    logger.warn({ err }, "Embedding inference failed; falling back to non-RAG path");
    return null;
  }
}

/**
 * Encode a vector as the textual literal pgvector expects in an INSERT/
 * UPDATE statement: `[0.1,0.2,0.3]`. Used by saveReviewLearnings.
 */
export function vectorLiteral(vec: readonly number[]): string {
  return `[${vec.join(",")}]`;
}

/** Test-only: forget the cached pipeline so a fresh load can be exercised. */
export function _resetPipelineForTests(): void {
  cachedPipeline = null;
  pipelineLoadFailed = false;
}
