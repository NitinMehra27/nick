import type { Migration } from './sqlite';

/** Schema for data/nick.db — user data owned by the MCP server. */
export const nickMigrations: Migration[] = [
  {
    version: 1,
    description: 'tasks, memories (+FTS), study plans, tool execution log',
    sql: `
      CREATE TABLE tasks (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        title        TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
        description  TEXT CHECK (description IS NULL OR length(description) <= 2000),
        status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed')),
        priority     TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
        category     TEXT CHECK (category IS NULL OR length(category) <= 50),
        due_date     TEXT CHECK (due_date IS NULL OR due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX idx_tasks_status   ON tasks (status);
      CREATE INDEX idx_tasks_due_date ON tasks (due_date);
      CREATE INDEX idx_tasks_priority ON tasks (priority);

      CREATE TABLE memories (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        content    TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 500),
        category   TEXT NOT NULL DEFAULT 'other' CHECK (category IN ('preference', 'goal', 'project', 'fact', 'other')),
        source     TEXT NOT NULL CHECK (source IN ('user', 'inferred')),
        metadata   TEXT CHECK (metadata IS NULL OR json_valid(metadata)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_memories_category ON memories (category);

      CREATE VIRTUAL TABLE memories_fts USING fts5 (content, category, content='memories', content_rowid='id');
      CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts (rowid, content, category) VALUES (new.id, new.content, new.category);
      END;
      CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts (memories_fts, rowid, content, category) VALUES ('delete', old.id, old.content, old.category);
      END;
      CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts (memories_fts, rowid, content, category) VALUES ('delete', old.id, old.content, old.category);
        INSERT INTO memories_fts (rowid, content, category) VALUES (new.id, new.content, new.category);
      END;

      CREATE TABLE study_plans (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        title           TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
        status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
        start_date      TEXT NOT NULL,
        target_date     TEXT NOT NULL,
        hours_per_day   REAL NOT NULL CHECK (hours_per_day > 0 AND hours_per_day <= 16),
        session_minutes INTEGER NOT NULL CHECK (session_minutes BETWEEN 15 AND 240),
        input_json      TEXT NOT NULL CHECK (json_valid(input_json)),
        warnings_json   TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(warnings_json)),
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        CHECK (start_date <= target_date)
      );

      CREATE TABLE study_plan_items (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id   INTEGER NOT NULL REFERENCES study_plans (id) ON DELETE CASCADE,
        sequence  INTEGER NOT NULL,
        date      TEXT NOT NULL,
        subject   TEXT NOT NULL,
        topic     TEXT,
        minutes   INTEGER NOT NULL CHECK (minutes > 0 AND minutes <= 960),
        completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
        task_id   INTEGER REFERENCES tasks (id) ON DELETE SET NULL,
        UNIQUE (plan_id, sequence)
      );
      CREATE INDEX idx_plan_items_plan ON study_plan_items (plan_id, date);

      CREATE TABLE tool_execution_logs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        tool_name   TEXT NOT NULL,
        status      TEXT NOT NULL CHECK (status IN ('success', 'error')),
        duration_ms INTEGER NOT NULL,
        summary     TEXT,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX idx_tool_logs_created ON tool_execution_logs (created_at);
    `,
  },
];
