-- Relay Platform: Job Passports schema
-- Migration 001: Create passports, events, and exceptions tables

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- PASSPORTS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS passports (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_ref       TEXT NOT NULL UNIQUE,
  retailer      JSONB NOT NULL,
  customer      JSONB NOT NULL,
  scope         JSONB NOT NULL,
  stage         TEXT NOT NULL DEFAULT 'intake'
                CHECK (stage IN ('intake', 'measure', 'quote', 'install', 'invoice', 'complete')),
  stage_history JSONB NOT NULL DEFAULT '[]'::jsonb,
  assigned_to   JSONB NOT NULL DEFAULT '{}'::jsonb,
  quote         JSONB NOT NULL DEFAULT '{"versions": []}'::jsonb,
  proof         JSONB NOT NULL DEFAULT '{"photos": [], "complete": false}'::jsonb,
  invoice       JSONB NOT NULL DEFAULT '{"packetReady": false}'::jsonb,
  sla           JSONB NOT NULL,
  exceptions    JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes on passports
CREATE INDEX idx_passports_job_ref ON passports (job_ref);
CREATE INDEX idx_passports_stage ON passports (stage);
CREATE INDEX idx_passports_created_at ON passports (created_at);
CREATE INDEX idx_passports_sla_breached ON passports ((sla->>'breached'));
CREATE INDEX idx_passports_retailer_name ON passports ((retailer->>'name'));

-- Auto-update updated_at on row modification
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER passports_updated_at
  BEFORE UPDATE ON passports
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- EVENTS TABLE
-- All stage transitions and COWBOY actions
-- ============================================================
CREATE TABLE IF NOT EXISTS events (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_ref     TEXT NOT NULL REFERENCES passports(job_ref) ON DELETE CASCADE,
  stage       TEXT NOT NULL,
  actor       TEXT NOT NULL,
  notes       TEXT,
  automated   BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_events_job_ref ON events (job_ref);
CREATE INDEX idx_events_stage ON events (stage);
CREATE INDEX idx_events_created_at ON events (created_at);
CREATE INDEX idx_events_actor ON events (actor);

-- ============================================================
-- EXCEPTIONS TABLE
-- Separate table for efficient querying of open exceptions
-- ============================================================
CREATE TABLE IF NOT EXISTS exceptions (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_ref       TEXT NOT NULL REFERENCES passports(job_ref) ON DELETE CASCADE,
  type          TEXT NOT NULL
                CHECK (type IN ('sla_breach', 'proof_missing', 'no_response',
                                'change_order', 'stage_stall', 'unassigned')),
  severity      TEXT NOT NULL DEFAULT 'medium'
                CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  detected_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at   TIMESTAMPTZ,
  resolution    TEXT,
  escalated_to  TEXT,
  notified_at   TIMESTAMPTZ
);

CREATE INDEX idx_exceptions_job_ref ON exceptions (job_ref);
CREATE INDEX idx_exceptions_type ON exceptions (type);
CREATE INDEX idx_exceptions_severity ON exceptions (severity);
CREATE INDEX idx_exceptions_open ON exceptions (resolved_at) WHERE resolved_at IS NULL;
