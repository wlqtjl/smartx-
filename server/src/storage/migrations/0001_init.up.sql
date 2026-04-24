-- 0001_init.up.sql
-- Idempotent schema v2. Hand-written to run on both SQLite and PostgreSQL.
-- Differences between dialects are expressed via a `${JSON}` placeholder that
-- the runner substitutes: JSONB on Postgres, TEXT on SQLite.
-- Version row is written by the runner after this file applies.

CREATE TABLE IF NOT EXISTS schema_meta (
    key          TEXT PRIMARY KEY,
    value        TEXT NOT NULL,
    applied_at   BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
    id             TEXT PRIMARY KEY,
    login          TEXT NOT NULL UNIQUE,
    password_hash  TEXT,
    oidc_subject   TEXT UNIQUE,
    roles          TEXT NOT NULL DEFAULT '[]',
    created_at     BIGINT NOT NULL,
    updated_at     BIGINT NOT NULL,
    disabled_at    BIGINT
);

CREATE TABLE IF NOT EXISTS sessions (
    sid           TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    created_at    BIGINT NOT NULL,
    updated_at    BIGINT NOT NULL,
    expires_at    BIGINT NOT NULL,
    refresh_hash  TEXT,
    revoked_at    BIGINT
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS tasks (
    id              TEXT PRIMARY KEY,
    owner_user_id   TEXT,
    vm_id           TEXT NOT NULL,
    state           TEXT NOT NULL,
    data_total_gb   REAL NOT NULL DEFAULT 0,
    created_at      BIGINT NOT NULL,
    updated_at      BIGINT NOT NULL,
    payload_json    ${JSON} NOT NULL
);

CREATE INDEX IF NOT EXISTS tasks_owner_idx ON tasks(owner_user_id);
CREATE INDEX IF NOT EXISTS tasks_state_idx ON tasks(state);

CREATE TABLE IF NOT EXISTS task_timeline (
    task_id   TEXT NOT NULL,
    seq       INTEGER NOT NULL,
    state     TEXT NOT NULL,
    at        BIGINT NOT NULL,
    note      TEXT,
    PRIMARY KEY (task_id, seq)
);

CREATE TABLE IF NOT EXISTS checkpoints (
    id           TEXT PRIMARY KEY,
    task_id      TEXT NOT NULL,
    seq          INTEGER NOT NULL,
    last_offset  INTEGER NOT NULL,
    at           BIGINT NOT NULL,
    payload_json ${JSON} NOT NULL
);

CREATE INDEX IF NOT EXISTS checkpoints_task_idx ON checkpoints(task_id);

CREATE TABLE IF NOT EXISTS audit_log (
    id           TEXT PRIMARY KEY,
    user_id      TEXT,
    action       TEXT NOT NULL,
    target       TEXT,
    at           BIGINT NOT NULL,
    details_json ${JSON}
);

CREATE INDEX IF NOT EXISTS audit_log_user_idx ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log(at);
