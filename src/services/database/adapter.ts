/**
 * Data Access Layer — Core Types & Interfaces
 *
 * This module defines the database-agnostic abstraction layer.
 * All concrete adapters (SQLite, MySQL, PostgreSQL) implement `DatabaseAdapter`.
 *
 * Design decisions:
 * - Raw SQL is kept; only the driver/connection is abstracted
 * - FTS/search is abstracted via `SearchCapabilities`
 * - Transactions are abstracted via `withTransaction()`
 * - Migrations are versioned and dialect-aware
 */

// ─── Database Type Enumeration ───────────────────────────────────────

export type DatabaseType = 'sqlite' | 'mysql' | 'postgresql';

// ─── Configuration ──────────────────────────────────────────────────

export interface DatabaseConfig {
  /** Which database backend to use */
  type: DatabaseType;

  /** Connection details — interpreted per-database:
   *  sqlite : file path (or ':memory:')
   *  mysql  : connection URI or { host, port, user, password, database }
   * postgresql: connection string or pg.ClientConfig */
  connection: string | Record<string, unknown>;

  /** Optional data directory (used by sqlite for path resolution) */
  dataDir?: string;

  /** Maximum connections in pool (for client-server DBs) */
  poolSize?: number;

  /** Enable debug SQL logging */
  debug?: boolean;
}

// ─── Generic Row / Result Types ──────────────────────────────────────

/** A single database row as a flat key-value object */
export type Row = Record<string, unknown>;

/** Array of rows returned from a query */
export type RowList = Row[];

/** Result of an INSERT/UPDATE/DELETE operation */
export interface MutationResult {
  /** Number of affected rows */
  changes: number;
  /** Last inserted row ID (if applicable) */
  lastInsertRowid?: number;
  /** Returning columns (if supported) */
  returning?: Row;
}

// ─── Query Parameter Types ───────────────────────────────────────────

export type QueryParam = string | number | boolean | null | undefined | Date | Buffer;

/** Supported parameter binding styles per database */
export enum ParamStyle {
  Positional = '?',       // SQLite, MySQL
  Dollar = '$N',          // PostgreSQL
  Named = ':name',        // (future)
}

// ─── Core Adapter Interface ─────────────────────────────────────────

/**
 * The primary contract every database driver must fulfill.
 *
 * Implementations MUST handle:
 *  - Connection lifecycle (open/close/pooling)
 *  - Parameterized queries (SQL injection safe)
 *  - Transactions with commit/rollback
 *  - Schema migrations via runSql()
 *  - Dialect-specific features (FTS, JSON operators, etc.)
 */
export interface DatabaseAdapter {
  // ─── Identity ────────────────────────────────────────────────────

  /** The database type this adapter serves */
  readonly type: DatabaseType;

  /** Human-readable identifier for logging/diagnostics */
  readonly name: string;

  // ─── Lifecycle ───────────────────────────────────────────────────

  /** Establish connection(s), create schema if needed, run pending migrations */
  initialize(): Promise<void>;

  /** Graceful shutdown: close all connections, flush WAL, release pool */
  close(): Promise<void>;

  /** Check if the adapter is connected and operational */
  isConnected(): boolean;

  // ─── Core Query API ──────────────────────────────────────────────

  /**
   * Execute a parameterized SELECT query.
   * Returns array of matching rows.
   */
  query(sql: string, params?: QueryParam[]): Promise<RowList>;

  /**
   * Execute a parameterized query expecting at most one row.
   * Returns the first row or null.
   */
  queryOne(sql: string, params?: QueryParam[]): Promise<Row | null>;

  /**
   * Execute a parameterized INSERT/UPDATE/DELETE.
   * Returns mutation metadata.
   */
  execute(sql: string, params?: QueryParam[]): Promise<MutationResult>;

  /**
   * Execute raw SQL with no parameters (DDL, PRAGMA, utility).
   * Used primarily for migrations and setup.
   */
  runRaw(sql: string): Promise<void>;

  /**
   * Run multiple statements in order within a single round-trip where possible.
   * Falls back to sequential execution.
   */
  batchRun(statements: string[]): Promise<void>;

  // ─── Transactions ────────────────────────────────────────────────

  /**
   * Execute `fn` inside a transaction.
   * If `fn` throws, automatically rolls back.
   * Returns the value returned by `fn`.
   */
  withTransaction<T>(fn: () => Promise<T>): Promise<T>;

  // ─── Schema introspection (optional, best-effort) ───────────────

  /** Check if a table exists */
  tableExists(tableName: string): Promise<boolean>;

  /** Get column names for a table */
  getColumns(tableName: string): Promise<string[]>;

  // ─── Dialect Helpers ─────────────────────────────────────────────

  /** Convert generic SQL placeholders to this adapter's param style */
  convertParams(sql: string, params: QueryParam[]): {
    sql: string;
    params: QueryParam[];
  };

  /** Get this adapter's preferred LIMIT/OFFSET clause syntax */
  limitOffset(limit?: number, offset?: number): string;

  /** Escape a value for use in dynamic SQL (table names, identifiers) */
  escapeIdentifier(name: string): string;

  /** Generate a placeholder string for N parameters */
  placeholders(count: number): string;

  // ─── Search Capabilities (dialect-specific) ──────────────────────

  /** Full-text search support info */
  readonly searchCapabilities: SearchCapabilities;
}

// ─── Search Capability Flags ─────────────────────────────────────────

export interface SearchCapabilities {
  /** Does this database have native full-text search? */
  hasFullTextSearch: boolean;

  /** Can do JSON field extraction natively? (json_extract, ->, etc.) */
  hasJsonFunctions: boolean;

  /** Can use EXISTS with table-valued functions? (e.g., json_each()) */
  hasJsonTableFunction: boolean;

  /** Supports partial unique indexes? */
  hasPartialIndex: boolean;

  /** Supports window functions? */
  hasWindowFunctions: boolean;

  /** Supports RETURNING clause on INSERT/UPDATE/DELETE? */
  supportsReturning: boolean;

  /** Supports UPSERT (INSERT ... ON CONFLICT DO ...)? */
  supportsUpsert: boolean;
}

// ─── Migration Types ────────────────────────────────────────────────

export interface MigrationStep {
  /** Sequential version number */
  version: number;

  /** Short description of what this migration does */
  description: string;

  /** Dialect-specific up-migration SQL or function.
   * Receives the adapter so it can use dialect helpers.
   */
  up: DialectMigrationFn;

  /** Optional down-migration (for development/rollback) */
  down?: DialectMigrationFn;
}

export type DialectMigrationFn = (
  adapter: DatabaseAdapter,
) => Promise<void> | void;

/** Registry of all migration steps in version order */
export class MigrationRegistry {
  private steps: MigrationStep[] = [];

  register(step: MigrationStep): void {
    if (this.steps.some(s => s.version === step.version)) {
      throw new Error(`Migration version ${step.version} already registered`);
    }
    this.steps.push(step);
    this.steps.sort((a, b) => a.version - b.version);
  }

  getAll(): ReadonlyArray<MigrationStep> {
    return [...this.steps];
  }

  getLatestVersion(): number {
    return this.steps.length > 0
      ? this.steps[this.steps.length - 1].version
      : 0;
  }

  getPending(appliedVersions: number[]): MigrationStep[] {
    const maxApplied = appliedVersions.length > 0 ? Math.max(...appliedVersions) : 0;
    return this.steps.filter(s => s.version > maxApplied);
  }
}

// ─── Factory ─────────────────────────────────────────────────────────

/**
 * Create the correct DatabaseAdapter instance based on config.
 *
 * @example
 * ```ts
 * const adapter = createDatabaseAdapter({ type: 'postgresql', connection: 'postgres://localhost/claude_mem' });
 * await adapter.initialize();
 * ```
 */
export function createDatabaseAdapter(config: DatabaseConfig): DatabaseAdapter {
  switch (config.type) {
    case 'sqlite':
      // Lazy import to avoid loading bun:sqlite when not needed
      return new (require('./adapters/sqlite-adapter.js').SQLiteAdapter)(config);
    case 'mysql':
      return new (require('./adapters/mysql-adapter.js').MySQLAdapter)(config);
    case 'postgresql':
      return new (require('./adapters/postgresql-adapter.js').PostgreSQLAdapter)(config);
    default:
      throw new Error(`Unsupported database type: ${(config as any).type}`);
  }
}
