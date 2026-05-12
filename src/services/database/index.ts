/**
 * Data Access Layer — Public API
 *
 * This is the main entry point for the database-agnostic layer.
 * All code should import from here instead of directly from `bun:sqlite`.
 *
 * @example
 * ```ts
 * import { DatabaseManager, SQLiteAdapter } from '../services/database/index.js';
 *
 * // Initialize (auto-detects DB type from env)
 * await DatabaseManager.initialize();
 *
 * // Or specify explicitly
 * await DatabaseManager.initialize({ type: 'postgresql', connection: 'postgres://...' });
 *
 * // Query
 * const rows = await DatabaseManager.getAdapter().query('SELECT * FROM sdk_sessions LIMIT 10');
 * ```
 */

// ─── Core Abstraction ──────────────────────────────────────────────
export { DatabaseAdapter, DatabaseConfig, DatabaseType, MutationResult, Row, RowList, QueryParam, SearchCapabilities, MigrationStep, MigrationRegistry, DialectMigrationFn, createDatabaseAdapter, ParamStyle } from './adapter.js';

// ─── Manager (Singleton) ───────────────────────────────────────────
import { DatabaseManager as _DatabaseManager } from './DatabaseManager.js';
export { DatabaseManager } from './DatabaseManager.js';

// ─── Adapters ─────────────────────────────────────────────────────
export { SQLiteAdapter } from './adapters/sqlite-adapter.js';
export { MySQLAdapter } from './adapters/mysql-adapter.js';
export { PostgreSQLAdapter } from './adapters/postgresql-adapter.js';

// ─── SqlExecutor (DB-agnostic query compatibility layer) ───────────
export { SqlExecutor, getSqlExecutor, initSqlExecutor } from './SqlExecutor.js';
export type { PreparedStatement, RunResult } from './SqlExecutor.js';

// ─── Migrations ───────────────────────────────────────────────────
export { registerAllMigrations } from './migrations/index.js';

// ─── Convenience: Initialize everything in one call ─────────────────

/**
 * One-call initialization: creates adapter, connects, runs migrations,
 * and binds the global SqlExecutor for leaf-module compatibility.
 * Call this at application startup.
 */
export async function initDatabase(config?: import('./adapter.js').DatabaseConfig): Promise<import('./adapter.js').DatabaseAdapter> {
  // Register all migrations before initializing
  const { registerAllMigrations: _register } = await import('./migrations/index.js');
  _register(_DatabaseManager);

  const adapter = await _DatabaseManager.initialize(config);

  // Bind SqlExecutor to the active adapter (enables leaf-module compat)
  const { initSqlExecutor: _initExec } = await import('./SqlExecutor.js');
  _initExec(adapter);

  return adapter;
}
