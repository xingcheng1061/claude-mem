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
  // v34 — Final cleanup: remove stale statuses from pending_messages
  // ════════════════════════════════════════════════════════════════
  dbManager.registerMigration({
    version: 34,
    description: 'Clean up pending_messages stale statuses',
    up: async (adapter) => {
      // Reset stuck processing entries back to pending
      await adapter.execute(
        `UPDATE pending_messages SET status = 'pending' WHERE status = 'processing'`
      );

      // Drop legacy columns if they exist (idempotent)
      try {
        if (adapter.type === 'sqlite') {
          // SQLite doesn't support DROP COLUMN easily in older versions
          // But modern SQLite (>= 3.35.0) does support it
          await adapter.runRaw(`ALTER TABLE pending_messages DROP COLUMN IF EXISTS retry_count`);
          await adapter.runRaw(`ALTER TABLE pending_messages DROP COLUMN IF EXISTS failed_at_epoch`);
          await adapter.runRaw(`ALTER TABLE pending_messages DROP COLUMN IF EXISTS completed_at_epoch`);
          await adapter.runRaw(`ALTER TABLE pending_messages DROP COLUMN IF EXISTS worker_pid`);
        } else {
          // MySQL/PostgreSQL support ALTER TABLE ... DROP COLUMN natively
          await adapter.runRaw(`ALTER TABLE pending_messages DROP COLUMN IF EXISTS retry_count`);
          await adapter.runRaw(`ALTER TABLE pending_messages DROP COLUMN IF EXISTS failed_at_epoch`);
          await adapter.runRaw(`ALTER TABLE pending_messages DROP COLUMN IF EXISTS completed_at_epoch`);
          await adapter.runRaw(`ALTER TABLE pending_messages DROP COLUMN IF EXISTS worker_pid`);
        }
      } catch {
        // Columns may not exist — ignore errors
      }
    },
  });
}
