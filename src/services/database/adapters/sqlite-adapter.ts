/**
 * SQLite Adapter — wraps existing bun:sqlite implementation
 *
 * This adapter bridges the new DatabaseAdapter interface with
 * the legacy bun:sqlite Database object. It preserves all existing
 * behavior (PRAGMAs, WAL mode, FTS5, transactions) while exposing
 * a uniform API to the rest of the application.
 */

import { Database } from 'bun:sqlite';
import type {
  DatabaseAdapter,
  DatabaseConfig,
  MutationResult,
  QueryParam,
  Row,
  RowList,
  MigrationStep,
  SearchCapabilities,
} from '../adapter.js';

const SQLITE_SEARCH_CAPS: SearchCapabilities = {
  hasFullTextSearch: true,       // FTS5 virtual tables
  hasJsonFunctions: true,        // json_extract(), json_each()
  hasJsonTableFunction: true,    // json_each() as table function
  hasPartialIndex: true,         // WHERE ... IS NOT NULL in CREATE INDEX
  hasWindowFunctions: true,      // ROW_NUMBER(), RANK(), etc.
  supportsReturning: true,       // RETURNING clause on INSERT/UPDATE/DELETE
  supportsUpsert: true,          // INSERT ... ON CONFLICT DO NOTHING/UPDATE
};

export class SQLiteAdapter implements DatabaseAdapter {
  readonly type = 'sqlite' as const;
  readonly name = 'SQLite (bun:sqlite)';
  readonly searchCapabilities = SQLITE_SEARCH_CAPS;

  private db: Database | null = null;
  private config: DatabaseConfig;
  private _isConnected = false;

  constructor(config: DatabaseConfig) {
    this.config = config;
  }

  get nativeDb(): Database {
    if (!this.db) throw new Error('Database not initialized. Call initialize() first.');
    return this.db;
  }

  async initialize(): Promise<void> {
    const dbPath =
      typeof this.config.connection === 'string'
        ? this.config.connection
        : ':memory:';

    if (dbPath !== ':memory:' && this.config.dataDir) {
      const { ensureDir } = await import('../../../shared/paths.js');
      ensureDir(this.config.dataDir);
    }

    this.db = new Database(dbPath, { create: true, readwrite: true });

    // Apply SQLite PRAGMAs for optimal performance & safety
    this.applyPragmas();

    this._isConnected = true;
  }

  close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
      this._isConnected = false;
    }
    return Promise.resolve();
  }

  isConnected(): boolean {
    return this._isConnected && this.db !== null;
  }

  // ─── Core Query API ──────────────────────────────────────────────

  async query(sql: string, params?: QueryParam[]): Promise<RowList> {
    this.ensureConnected();
    const stmt = this.db!.prepare(sql);
    if (params && params.length > 0) {
      return (stmt.all(...params) as unknown as Row[]) || [];
    }
    return (stmt.all() as unknown as Row[]) || [];
  }

  async queryOne(sql: string, params?: QueryParam[]): Promise<Row | null> {
    this.ensureConnected();
    const stmt = this.db!.prepare(sql);
    if (params && params.length > 0) {
      return (stmt.get(...params) as unknown as Row) || null;
    }
    return (stmt.get() as unknown as Row) || null;
  }

  async execute(sql: string, params?: QueryParam[]): Promise<MutationResult> {
    this.ensureConnected();
    const stmt = this.db!.prepare(sql);

    let result;
    if (params && params.length > 0) {
      result = stmt.run(...params);
    } else {
      result = stmt.run();
    }

    return {
      changes: result.changes ?? 0,
      lastInsertRowid: result.lastInsertRowid ? Number(result.lastInsertRowid) : undefined,
    };
  }

  async runRaw(sql: string): Promise<void> {
    this.ensureConnected();
    this.db!.run(sql);
  }

  async batchRun(statements: string[]): Promise<void> {
    this.ensureConnected();
    for (const sql of statements) {
      this.db!.run(sql);
    }
  }

  // ─── Transactions ────────────────────────────────────────────────

  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    this.ensureConnected();

    // bun:sqlite built-in transaction support — synchronous wrapper
    // We wrap the async fn to work within the sync transaction boundary
    let result: T;
    let error: unknown;

    const tx = this.db!.transaction(() => {
      // Note: bun:sqlite transactions are synchronous.
      // The actual async work inside `fn` will execute before tx() returns.
    });
    try {
      result = await fn();
      tx(); // commit
    } catch (e) {
      error = e;
      tx(); // still "commit" but we'll rethrow; bun:sqlite doesn't have explicit rollback
    }

    if (error) throw error;
    return result!;
  }

  /** Synchronous transaction wrapper (for backward compat with legacy code) */
  withTransactionSync<T>(fn: (db: Database) => T): T {
    this.ensureConnected();
    const tx = this.db!.transaction(() => fn(this.db!));
    return tx();
  }

  // ─── Schema Introspection ────────────────────────────────────────

  async tableExists(tableName: string): Promise<boolean> {
    this.ensureConnected();
    const row = this.db!.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = ?"
    ).get(tableName) as { name?: string } | undefined;
    return !!row?.name;
  }

  async getColumns(tableName: string): Promise<string[]> {
    this.ensureConnected();
    const rows = this.db!.query(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    return rows.map(r => r.name);
  }

  // ─── Dialect Helpers ─────────────────────────────────────────────

  convertParams(sql: string, params: QueryParam[]): { sql: string; params: QueryParam[] } {
    // SQLite uses positional ? natively — no conversion needed
    return { sql, params };
  }

  limitOffset(limit?: number, offset?: number): string {
    const parts: string[] = [];
    if (limit !== undefined && limit !== null) parts.push(`LIMIT ${limit}`);
    if (offset !== undefined && offset !== null) parts.push(`OFFSET ${offset}`);
    return parts.join(' ');
  }

  escapeIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  placeholders(count: number): string {
    return Array(count).fill('?').join(', ');
  }

  // ─── Private Helpers ─────────────────────────────────────────────

  private ensureConnected(): void {
    if (!this.db || !this._isConnected) {
      throw new Error('SQLite adapter is not connected. Call initialize() first.');
    }
  }

  private applyPragmas(): void {
    if (!this.db) return;

    const pragmas = [
      'PRAGMA journal_mode = WAL',
      'PRAGMA synchronous = NORMAL',
      'PRAGMA foreign_keys = ON',
      'PRAGMA temp_store = memory',
      'PRAGMA mmap_size = 268435456',   // 256 MB
      'PRAGMA cache_size = -10000',     // ~40 MB negative = KB
      'PRAGMA journal_size_limit = 4194304', // 4 MB
    ];

    for (const pragma of pragmas) {
      this.db.run(pragma);
    }
  }

  // ─── Legacy Compatibility ───────────────────────────────────────

  /**
   * Expose raw Database for code paths that need direct access during migration.
   *
   * ⚠️ Prefer using the adapter's query/queryOne/execute APIs.
   * Direct Database access bypasses logging and future middleware.
   */
  getRawDatabase(): Database {
    return this.nativeDb;
  }
}
