-- Adds the `search_filter_enabled` column to `agents`. Per-agent toggle
-- gating the in-tool LLM relevance filter on vespaSearch. Defaults to
-- `true` so existing agents keep today's "filter always runs" behaviour
-- (matches the FORCE_FILTER_FOR_TESTING constant we're now replacing).
--
-- Idempotent: uses `IF NOT EXISTS` so re-runs are safe.
--
-- Run with:
--   psql "$DATABASE_URL" -f server/scripts/add-search-filter-enabled.sql

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS search_filter_enabled BOOLEAN NOT NULL DEFAULT true;
