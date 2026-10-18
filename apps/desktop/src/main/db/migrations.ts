/**
 * Ordered schema migrations. Append new entries; never edit one that has shipped.
 * Timestamps are ISO-8601 UTC strings; JSON columns are validated with zod when read.
 */
export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    id: 1,
    name: "initial",
    sql: `
CREATE TABLE preferences (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE llm_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL CHECK (provider IN ('openai', 'anthropic')),
  base_url TEXT,
  model TEXT NOT NULL,
  api_key_encrypted TEXT,
  api_key_hint TEXT,
  structured_mode TEXT NOT NULL DEFAULT 'auto' CHECK (structured_mode IN ('auto', 'json_schema', 'tool', 'prompt')),
  temperature REAL,
  price_in_per_mtok REAL,
  price_out_per_mtok REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  path TEXT CHECK (path IN ('fast', 'light', 'full')),
  stage TEXT NOT NULL DEFAULT 'triage',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  repo_path TEXT,
  triage_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE question_rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  round_no INTEGER NOT NULL,
  questions_json TEXT NOT NULL,
  answers_json TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'superseded')),
  created_at TEXT NOT NULL,
  answered_at TEXT,
  UNIQUE (project_id, stage, round_no)
);

CREATE TABLE decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  stage TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('user', 'recommended', 'ai')),
  rationale TEXT,
  alternatives_json TEXT NOT NULL DEFAULT '[]',
  depends_on_json TEXT NOT NULL DEFAULT '[]',
  needs_review INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, key)
);

CREATE TABLE documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('prd', 'tech_design', 'brief')),
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  sections_json TEXT NOT NULL DEFAULT '[]',
  origin TEXT NOT NULL CHECK (origin IN ('generated', 'edited', 'revised')),
  created_at TEXT NOT NULL,
  UNIQUE (project_id, kind, version)
);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  doc_version INTEGER,
  seq INTEGER NOT NULL,
  title TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  features_json TEXT,
  score INTEGER,
  tier TEXT CHECK (tier IN ('T1', 'T2', 'T3')),
  agent TEXT,
  model TEXT,
  depends_on_json TEXT NOT NULL DEFAULT '[]',
  override_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE handoffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_ids_json TEXT NOT NULL,
  agent TEXT NOT NULL,
  files_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  preference INTEGER NOT NULL DEFAULT 0,
  capabilities_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE model_catalog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  tier TEXT NOT NULL CHECK (tier IN ('T1', 'T2', 'T3')),
  model_id TEXT NOT NULL,
  price_in_per_mtok REAL,
  price_out_per_mtok REAL,
  UNIQUE (agent_id, tier)
);

CREATE TABLE llm_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  profile_id INTEGER REFERENCES llm_profiles(id) ON DELETE SET NULL,
  model TEXT NOT NULL,
  purpose TEXT NOT NULL,
  mode TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd REAL,
  latency_ms INTEGER NOT NULL,
  error_kind TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX llm_calls_project ON llm_calls (project_id);

CREATE TABLE search_services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('bocha', 'mcp_stdio', 'mcp_http')),
  config_json TEXT NOT NULL,
  secret_encrypted TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
  {
    id: 2,
    name: "discussion_state",
    sql: `
CREATE TABLE stage_states (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'ready', 'complete')),
  rounds_used INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, stage)
);

ALTER TABLE question_rounds ADD COLUMN review INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    id: 3,
    name: "document_versions",
    // No document was written before this migration, so the table is rebuilt rather than altered.
    sql: `
DROP TABLE documents;

CREATE TABLE documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('prd', 'tech_design', 'brief')),
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  sections_json TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('generated', 'edited', 'revised', 'restored')),
  note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, kind, version)
);
`,
  },
  {
    id: 4,
    name: "routing",
    // Agents start enabled in hand-off order; Claude Code comes with its model IDs, prices are left to the user.
    sql: `
CREATE TABLE routing_plans (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  based_on_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX tasks_project ON tasks (project_id, seq);

INSERT INTO agents (id, enabled, preference) VALUES
  ('claude_code', 1, 0),
  ('codex', 1, 1),
  ('cursor', 1, 2),
  ('pi', 1, 3),
  ('dsh', 1, 4),
  ('zcode', 1, 5),
  ('generic', 1, 6);

INSERT INTO model_catalog (agent_id, tier, model_id) VALUES
  ('claude_code', 'T1', 'claude-haiku-5-5'),
  ('claude_code', 'T2', 'claude-sonnet-5-5'),
  ('claude_code', 'T3', 'claude-opus-5-5');
`,
  },
];
