-- Migration 015: pgvector extension + embedding column on review_learnings.
--
-- Stage 1 of the RAG rollout (Phase 1.5.H). Adds the schema; the embedding
-- model and read/write paths are gated behind REVIEW_LEARNINGS_RAG_ENABLED
-- (default false), so existing deployments can land this migration without
-- runtime impact and validate pgvector availability before flipping the flag.
--
-- Dimension 384 matches Xenova/bge-small-en-v1.5 (the chosen orchestrator-
-- side embedding model). Re-indexing on a model change is a follow-up.
--
-- pgvector is supplied in dev via the `pgvector/pgvector:pg17` image
-- (docker-compose.dev.yml). Production deployments must use a Postgres
-- image that includes pgvector; this migration fails fast on a stock
-- postgres:17 image, which is the right signal: the operator must add the
-- extension to the image before the orchestrator can boot.

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE review_learnings
  ADD COLUMN embedding vector(384) NULL;

-- HNSW index for cosine-distance nearest-neighbour queries. Cosine because
-- the embedding model produces normalised vectors and cosine is the
-- recommended metric for bge-small-en-v1.5. `m` + `ef_construction` use
-- pgvector's recommended defaults; tuning is a follow-up.
CREATE INDEX idx_review_learnings_embedding_hnsw
  ON review_learnings
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
