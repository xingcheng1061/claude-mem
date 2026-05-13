/**
 * Database-Agnostic Migration Definitions
 *
 * Each migration step is defined once but produces correct SQL for any
 * supported database (SQLite, MySQL, PostgreSQL) by using the adapter's
 * dialect helpers.
 *
 * These migrations mirror the existing `src/services/sqlite/migrations/runner.ts`
 * steps but are written to work across databases.
 *
 * Usage:
 * ```ts
 * import { registerAllMigrations } from './migrations/index.js';
 * registerAllMigrations(DatabaseManager);
 * ```
 */

import type { DatabaseAdapter, MigrationStep } from '../adapter.js';
import { logger } from '../../../utils/logger.js';

// ─── Dialect-aware SQL Builders ─────────────────────────────────────

/** Generate CREATE TABLE SQL adapted for the current adapter's dialect */
function createTableSQL(
  adapter: DatabaseAdapter,
  tableName: string,
  columns: ColumnDef[],
  constraints?: string[]
): string {
  const esc = (name: string) => adapter.escapeIdentifier(name);
  const colDefs = columns.map(col => {
    let def = `  ${esc(col.name)} ${col.type}`;
    if (col.constraints) {
      def += ` ${col.constraints.join(' ')}`;
    }
    return def;
  });

  let sql = `CREATE TABLE IF NOT EXISTS ${esc(tableName)} (\n${colDefs.join(',\n')}\n)`;
  if (constraints?.length) {
    sql += `\n${constraints.map(c => c.replace(/\bTABLE\b/gi, `${esc(tableName)}`)).join('\n')}`;
  }
  return sql;
}

interface ColumnDef {
  name: string;
  type: string;        // Will be mapped to dialect-specific type
  constraints?: string[];
}

// ─── Dialect Type Mappers ──────────────────────────────────────────

function pkType(adapter: DatabaseAdapter): string {
  switch (adapter.type) {
    case 'mysql': return 'INT AUTO_INCREMENT PRIMARY KEY';
    case 'postgresql': return 'SERIAL PRIMARY KEY';
    case 'sqlite': default: return 'INTEGER PRIMARY KEY AUTOINCREMENT';
  }
}

function intType(adapter: DatabaseAdapter): string {
  switch (adapter.type) {
    case 'postgresql': return 'INTEGER';
    default: return 'INTEGER';
  }
}

function textType(adapter: DatabaseAdapter): string {
  switch (adapter.type) {
    case 'mysql': return 'TEXT';
    case 'postgresql': return 'TEXT';
    case 'sqlite': default: return 'TEXT';
  }
}

function jsonType(adapter: DatabaseAdapter): string {
  // Most databases store JSON as TEXT and parse it in application layer.
  // MySQL has JSON type, PostgreSQL has json/jsonb.
  switch (adapter.type) {
    case 'mysql': return 'JSON';
    case 'postgresql': return 'JSONB';
    default: return 'TEXT'; // SQLite stores JSON as text
  }
}

function timestampType(adapter: DatabaseAdapter): string {
  switch (adapter.type) {
    case 'mysql': return 'DATETIME(3)';
    case 'postgresql': return 'TIMESTAMPTZ';
    default: return 'TEXT'; // SQLite stores timestamps as ISO strings
  }
}

// ─── Index Helpers ─────────────────────────────────────────────────

async function createIndex(
  adapter: DatabaseAdapter,
  indexName: string,
  tableName: string,
  columns: string[],
  options?: { unique?: boolean; partial?: string }
): Promise<void> {
  const esc = (name: string) => adapter.escapeIdentifier(name);
  const cols = columns.map(c => esc(c)).join(', ');
  const unique = options?.unique ? 'UNIQUE ' : '';
  const partial = options?.partial ? ` ${options.partial}` : '';

  await adapter.runRaw(
    `CREATE ${unique}INDEX IF NOT EXISTS ${esc(indexName)} ON ${esc(tableName)} (${cols})${partial}`
  );
}

// ─── All Migration Steps ───────────────────────────────────────────

/**
 * Register all migration steps with the given DatabaseManager instance.
 *
 * Call this at application startup before initialize().
 */
export function registerAllMigrations(dbManager: {
  registerMigration(step: MigrationStep): void;
}): void {

  // ════════════════════════════════════════════════════════════════
  // v4 — Base schema: sdk_sessions + observations + session_summaries
  // ════════════════════════════════════════════════════════════════
  dbManager.registerMigration({
    version: 4,
    description: 'Create base tables: sdk_sessions, observations, session_summaries',
    up: async (adapter) => {
      // sdk_sessions
      await adapter.runRaw(createTableSQL(adapter, 'sdk_sessions', [
        { name: 'id', type: pkType(adapter) },
        { name: 'content_session_id', type: textType(adapter), constraints: ['UNIQUE NOT NULL'] },
        { name: 'memory_session_id', type: textType(adapter), constraints: ['UNIQUE'] },
        { name: 'project', type: textType(adapter), constraints: ['NOT NULL'] },
        { name: 'platform_source', type: textType(adapter), constraints: ["NOT NULL DEFAULT 'claude'"] },
        { name: 'user_prompt', type: textType(adapter) },
        { name: 'started_at', type: textType(adapter), constraints: ['NOT NULL'] },
        { name: 'started_at_epoch', type: intType(adapter), constraints: ['NOT NULL'] },
        { name: 'completed_at', type: textType(adapter) },
        { name: 'completed_at_epoch', type: intType(adapter) },
        { name: 'status', type: textType(adapter), constraints: ["NOT NULL DEFAULT 'active'", "CHECK(status IN ('active', 'completed', 'failed'))"] },
        { name: 'worker_port', type: intType(adapter) },
        { name: 'prompt_counter', type: intType(adapter), constraints: ['DEFAULT 0'] },
        { name: 'custom_title', type: textType(adapter) },
      ]));

      // observations
      await adapter.runRaw(createTableSQL(adapter, 'observations', [
        { name: 'id', type: pkType(adapter) },
        { name: 'memory_session_id', type: textType(adapter), constraints: ['NOT NULL'] },
        { name: 'project', type: textType(adapter), constraints: ['NOT NULL'] },
        { name: 'text', type: textType(adapter) },
        { name: 'type', type: textType(adapter), constraints: ['NOT NULL'] },
        { name: 'title', type: textType(adapter) },
        { name: 'subtitle', type: textType(adapter) },
        { name: 'facts', type: textType(adapter) },
        { name: 'narrative', type: textType(adapter) },
        { name: 'concepts', type: textType(adapter) },
        { name: 'files_read', type: textType(adapter) },
        { name: 'files_modified', type: textType(adapter) },
        { name: 'prompt_number', type: intType(adapter) },
        { name: 'discovery_tokens', type: intType(adapter), constraints: ['DEFAULT 0'] },
        { name: 'content_hash', type: textType(adapter) },
        { name: 'agent_type', type: textType(adapter) },
        { name: 'agent_id', type: textType(adapter) },
        { name: 'merged_into_project', type: textType(adapter) },
        { name: 'generated_by_model', type: textType(adapter) },
        { name: 'metadata', type: textType(adapter) },
        { name: 'created_at', type: textType(adapter), constraints: ['NOT NULL'] },
        { name: 'created_at_epoch', type: intType(adapter), constraints: ['NOT NULL'] },
      ], [
        `FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE`,
        `UNIQUE(memory_session_id, content_hash)`,
      ]));

      // session_summaries
      await adapter.runRaw(createTableSQL(adapter, 'session_summaries', [
        { name: 'id', type: pkType(adapter) },
        { name: 'memory_session_id', type: textType(adapter), constraints: ['NOT NULL'] },
        { name: 'project', type: textType(adapter), constraints: ['NOT NULL'] },
        { name: 'request', type: textType(adapter) },
        { name: 'investigated', type: textType(adapter) },
        { name: 'learned', type: textType(adapter) },
        { name: 'completed', type: textType(adapter) },
        { name: 'next_steps', type: textType(adapter) },
        { name: 'files_read', type: textType(adapter) },
        { name: 'files_edited', type: textType(adapter) },
        { name: 'notes', type: textType(adapter) },
        { name: 'prompt_number', type: intType(adapter) },
        { name: 'discovery_tokens', type: intType(adapter), constraints: ['DEFAULT 0'] },
        { name: 'merged_into_project', type: textType(adapter) },
        { name: 'created_at', type: textType(adapter), constraints: ['NOT NULL'] },
        { name: 'created_at_epoch', type: intType(adapter), constraints: ['NOT NULL'] },
      ], [
        `FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE`,
      ]));

      // Indexes for sdk_sessions
      await createIndex(adapter, 'idx_sdk_sessions_claude_id', 'sdk_sessions', ['content_session_id']);
      await createIndex(adapter, 'idx_sdk_sessions_sdk_id', 'sdk_sessions', ['memory_session_id']);
      await createIndex(adapter, 'idx_sdk_sessions_project', 'sdk_sessions', ['project']);
      await createIndex(adapter, 'idx_sdk_sessions_status', 'sdk_sessions', ['status']);
      await createIndex(adapter, 'idx_sdk_sessions_started', 'sdk_sessions', ['started_at_epoch']);
      await createIndex(adapter, 'idx_sdk_sessions_platform_source', 'sdk_sessions', ['platform_source']);

      // Indexes for observations
      await createIndex(adapter, 'idx_observations_sdk_session', 'observations', ['memory_session_id']);
      await createIndex(adapter, 'idx_observations_project', 'observations', ['project']);
      await createIndex(adapter, 'idx_observations_type', 'observations', ['type']);
      await createIndex(adapter, 'idx_observations_created', 'observations', ['created_at_epoch']);
      await createIndex(adapter, 'idx_observations_content_hash', 'observations', ['content_hash', 'created_at_epoch']);
      await createIndex(adapter, 'idx_observations_agent_type', 'observations', ['agent_type']);
      await createIndex(adapter, 'idx_observations_agent_id', 'observations', ['agent_id']);
      await createIndex(adapter, 'idx_observations_merged_into', 'observations', ['merged_into_project']);

      // Indexes for session_summaries
      await createIndex(adapter, 'idx_session_summaries_sdk_session', 'session_summaries', ['memory_session_id']);
      await createIndex(adapter, 'idx_session_summaries_project', 'session_summaries', ['project']);
      await createIndex(adapter, 'idx_session_summaries_created', 'session_summaries', ['created_at_epoch']);
      await createIndex(adapter, 'idx_summaries_merged_into', 'session_summaries', ['merged_into_project']);
    },
  });

  // ════════════════════════════════════════════════════════════════
  // v10 — user_prompts table
  // ════════════════════════════════════════════════════════════════
  dbManager.registerMigration({
    version: 10,
    description: 'Create user_prompts table',
    up: async (adapter) => {
      await adapter.runRaw(createTableSQL(adapter, 'user_prompts', [
        { name: 'id', type: pkType(adapter) },
        { name: 'content_session_id', type: textType(adapter), constraints: ['NOT NULL'] },
        { name: 'prompt_number', type: intType(adapter), constraints: ['NOT NULL'] },
        { name: 'prompt_text', type: textType(adapter), constraints: ['NOT NULL'] },
        { name: 'created_at', type: textType(adapter), constraints: ['NOT NULL'] },
        { name: 'created_at_epoch', type: intType(adapter), constraints: ['NOT NULL'] },
      ], [
        `FOREIGN KEY(content_session_id) REFERENCES sdk_sessions(content_session_id) ON DELETE CASCADE`,
      ]));

      await createIndex(adapter, 'idx_user_prompts_claude_session', 'user_prompts', ['content_session_id']);
      await createIndex(adapter, 'idx_user_prompts_created', 'user_prompts', ['created_at_epoch']);
      await createIndex(adapter, 'idx_user_prompts_prompt_number', 'user_prompts', ['prompt_number']);
      await createIndex(adapter, 'idx_user_prompts_lookup', 'user_prompts', ['content_session_id', 'prompt_number'], { unique: true });
    },
  });

  // ════════════════════════════════════════════════════════════════
  // v16 — pending_messages table (work queue)
  // ════════════════════════════════════════════════════════════════
  dbManager.registerMigration({
    version: 16,
    description: 'Create pending_messages table (persistent work queue)',
    up: async (adapter) => {
      await adapter.runRaw(createTableSQL(adapter, 'pending_messages', [
        { name: 'id', type: pkType(adapter) },
        { name: 'session_db_id', type: intType(adapter), constraints: ['NOT NULL'] },
        { name: 'content_session_id', type: textType(adapter), constraints: ['NOT NULL'] },
        { name: 'tool_use_id', type: textType(adapter) },
        { name: 'message_type', type: textType(adapter), constraints: ["NOT NULL", "CHECK(message_type IN ('observation','summarize'))"] },
        { name: 'tool_name', type: textType(adapter) },
        { name: 'tool_input', type: jsonType(adapter) },
        { name: 'tool_response', type: jsonType(adapter) },
        { name: 'cwd', type: textType(adapter) },
        { name: 'last_user_message', type: textType(adapter) },
        { name: 'last_assistant_message', type: textType(adapter) },
        { name: 'prompt_number', type: intType(adapter) },
        { name: 'status', type: textType(adapter), constraints: ["NOT NULL DEFAULT 'pending'", "CHECK(status IN ('pending','processing'))"] },
        { name: 'created_at_epoch', type: intType(adapter), constraints: ['NOT NULL'] },
        { name: 'agent_type', type: textType(adapter) },
        { name: 'agent_id', type: textType(adapter) },
      ], [
        `FOREIGN KEY(session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE`,
      ]));

      await createIndex(adapter, 'idx_pending_messages_session', 'pending_messages', ['session_db_id']);
      await createIndex(adapter, 'idx_pending_messages_status', 'pending_messages', ['status']);
      await createIndex(adapter, 'idx_pending_messages_claude_session', 'pending_messages', ['content_session_id']);

      // Partial unique index on (content_session_id, tool_use_id) WHERE tool_use_id IS NOT NULL
      if (adapter.searchCapabilities.hasPartialIndex) {
        await adapter.runRaw(`
          CREATE UNIQUE INDEX IF NOT EXISTS ux_pending_session_tool
          ON ${adapter.escapeIdentifier('pending_messages')}(${adapter.escapeIdentifier('content_session_id')}, ${adapter.escapeIdentifier('tool_use_id')})
          WHERE ${adapter.escapeIdentifier('tool_use_id')} IS NOT NULL
        `);
      } else {
        // For MySQL (no partial index): create regular unique index, handle nulls in app logic
        logger.warn('DB', 'Partial index not supported — creating standard unique index for pending_messages');
        await createIndex(adapter, 'ux_pending_session_tool', 'pending_messages', ['content_session_id', 'tool_use_id'], { unique: true });
      }
    },
  });

  // ════════════════════════════════════════════════════════════════
  // v24 — observation_feedback table
  // ════════════════════════════════════════════════════════════════
  dbManager.registerMigration({
    version: 24,
    description: 'Create observation_feedback table',
    up: async (adapter) => {
      await adapter.runRaw(createTableSQL(adapter, 'observation_feedback', [
        { name: 'id', type: pkType(adapter) },
        { name: 'observation_id', type: intType(adapter), constraints: ['NOT NULL'] },
        { name: 'signal_type', type: textType(adapter), constraints: ['NOT NULL'] },
        { name: 'session_db_id', type: intType(adapter) },
        { name: 'created_at_epoch', type: intType(adapter), constraints: ['NOT NULL'] },
        { name: 'metadata', type: jsonType(adapter) },
      ], [
        `FOREIGN KEY(observation_id) REFERENCES observations(id) ON DELETE CASCADE`,
      ]));

      await createIndex(adapter, 'idx_feedback_observation', 'observation_feedback', ['observation_id']);
      await createIndex(adapter, 'idx_feedback_signal', 'observation_feedback', ['signal_type']);
    },
  });

  // ════════════════════════════════════════════════════════════════
  // v35 — Full-text search indexes for MySQL & PostgreSQL
  //
  // SQLite uses FTS5 virtual tables managed by SessionSearch.ensureFTSTables().
  // This migration adds native FTS support for MySQL (FULLTEXT) and PG (GIN/tsvector).
  // ════════════════════════════════════════════════════════════════
  dbManager.registerMigration({
    version: 35,
    description: 'Create full-text search indexes (MySQL FULLTEXT / PostgreSQL GIN)',
    up: async (adapter) => {
      if (adapter.type === 'mysql') {
        // ── MySQL: FULLTEXT indexes ────────────────────────────────
        // Natural language mode; covers the same columns as SQLite FTS5.
        try {
          await adapter.runRaw(`
            CREATE FULLTEXT INDEX IF NOT EXISTS fts_observations
            ON ${adapter.escapeIdentifier('observations')}(
              title, subtitle, narrative, text, facts, concepts
            )
          `);
        } catch {
          // InnoDB requires some text; may fail if table is empty — still create index
          logger.warn('DB', 'Could not create FULLTEXT index on observations (may need data first)', {});
        }

        try {
          await adapter.runRaw(`
            CREATE FULLTEXT INDEX IF NOT EXISTS fts_session_summaries
            ON ${adapter.escapeIdentifier('session_summaries')}(
              request, investigated, learned, completed, next_steps, notes
            )
          `);
        } catch {
          logger.warn('DB', 'Could not create FULLTEXT index on session_summaries', {});
        }
      }

      if (adapter.type === 'postgresql') {
        // ── PostgreSQL: tsvector columns + GIN indexes + triggers ──
        const obsTable = adapter.escapeIdentifier('observations');
        const sumTable = adapter.escapeIdentifier('session_summaries');

        // Add tsvector column to observations if missing
        try {
          await adapter.runRaw(`ALTER TABLE ${obsTable} ADD COLUMN IF NOT EXISTS search_vector tsvector`);
        } catch { /* column may already exist */ }

        // Populate existing rows
        await adapter.runRaw(`
          UPDATE ${obsTable} SET search_vector = to_tsvector('english',
            COALESCE(title,'') || ' ' || COALESCE(subtitle,'') || ' ' ||
            COALESCE(narrative,'') || ' ' || COALESCE(text,'') || ' ' ||
            COALESCE(facts,'') || ' ' || COALESCE(concepts,'')
          ) WHERE search_vector IS NULL
        `);

        // GIN index for fast lookups
        await adapter.runRaw(`
          CREATE INDEX IF NOT EXISTS idx_observations_search
          ON ${obsTable} USING GIN(search_vector)
        `);

        // Auto-update trigger
        await adapter.runRaw(`
          CREATE OR REPLACE FUNCTION observations_search_vector_update() RETURNS trigger AS $$
          BEGIN
            NEW.search_vector := to_tsvector('english',
              COALESCE(NEW.title,'') || ' ' || COALESCE(NEW.subtitle,'') || ' ' ||
              COALESCE(NEW.narrative,'') || ' ' || COALESCE(NEW.text,'') || ' ' ||
              COALESCE(NEW.facts,'') || ' ' || COALESCE(NEW.concepts,'')
            );
            RETURN NEW;
          END;
          $$ LANGUAGE plpgsql
        `);
        await adapter.runRaw(`
          DROP TRIGGER IF EXISTS observations_tsvector_update ON ${obsTable}
        `);
        await adapter.runRaw(`
          CREATE TRIGGER observations_tsvector_update
          BEFORE INSERT OR UPDATE ON ${obsTable}
          FOR EACH ROW EXECUTE FUNCTION observations_search_vector_update()
        `);

        // Same for session_summaries
        try {
          await adapter.runRaw(`ALTER TABLE ${sumTable} ADD COLUMN IF NOT EXISTS search_vector tsvector`);
        } catch { /* ignore */ }

        await adapter.runRaw(`
          UPDATE ${sumTable} SET search_vector = to_tsvector('english',
            COALESCE(request,'') || ' ' || COALESCE(investigated,'') || ' ' ||
            COALESCE(learned,'') || ' ' || COALESCE(completed,'') || ' ' ||
            COALESCE(next_steps,'') || ' ' || COALESCE(notes,'')
          ) WHERE search_vector IS NULL
        `);

        await adapter.runRaw(`
          CREATE INDEX IF NOT EXISTS idx_session_summaries_search
          ON ${sumTable} USING GIN(search_vector)
        `);

        await adapter.runRaw(`
          CREATE OR REPLACE FUNCTION session_summaries_search_vector_update() RETURNS trigger AS $$
          BEGIN
            NEW.search_vector := to_tsvector('english',
              COALESCE(NEW.request,'') || ' ' || COALESCE(NEW.investigated,'') || ' ' ||
              COALESCE(NEW.learned,'') || ' ' || COALESCE(NEW.completed,'') || ' ' ||
              COALESCE(NEW.next_steps,'') || ' ' || COALESCE(NEW.notes,'')
            );
            RETURN NEW;
          END;
          $$ LANGUAGE plpgsql
        `);
        await adapter.runRaw(`
          DROP TRIGGER IF EXISTS session_summaries_tsvector_update ON ${sumTable}
        `);
        await adapter.runRaw(`
          CREATE TRIGGER session_summaries_tsvector_update
          BEFORE INSERT OR UPDATE ON ${sumTable}
          FOR EACH ROW EXECUTE FUNCTION session_summaries_search_vector_update()
        `);
      }

      // SQLite: no-op here — FTS5 is managed by SessionSearch.ensureFTSTables()
    },
  });
}
