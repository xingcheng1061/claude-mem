/**
 * SqlExecutor — Database-agnostic query compatibility layer
 *
 * Provides the exact same API surface as bun:sqlite's `Database`:
 *   - `prepare(sql)` → returns a `PreparedStatement` with `.get()`, `.all()`, `.run()`
 *   - `run(sql)` → execute raw SQL (no params, for DDL/PRAGMA)
 *   - `transaction(fn)` → synchronous-style transaction wrapper
 *
 * This allows existing leaf modules (sessions/, observations/, summaries/,
 * prompts/, timeline/, etc.) to work with ANY database backend without
 * changing their query logic — only the type import changes.
 *
 * Internally delegates to the active `DatabaseAdapter`, handling:
 *   - Parameter style conversion (? → $1/$2 for PostgreSQL)
 *   - Result normalization (rows as flat objects)
 *   - Transaction bridging (sync-style → async adapter.withTransaction)
 */

import type { DatabaseAdapter, QueryParam } from './adapter.js';
import { DatabaseManager } from './DatabaseManager.js';

// ─── Synchronous Bridge for Async Adapters ──────────────────────────
//
// For non-SQLite backends (MySQL, PostgreSQL), the underlying drivers
// only provide async APIs. This bridge converts async results to sync
// returns by blocking the current thread until the async operation completes.
//
// Why this is acceptable:
// - SQLite's db.prepare().get() already blocks the main thread (~0.01ms)
// - Network DB calls block for ~1-5ms — imperceptible difference for a CLI tool
// - Avoids rewriting 30+ files to use async/await throughout
// - Keeps the existing sync API contract unchanged
//
// Implementation: Uses `deasync` to synchronously wait for Promise resolution.
// deasync hooks into the libuv/node event loop at the C++ level, allowing
// pending async callbacks to execute while the current thread is blocked.
// This is the same technique used by many sync-wrapper libraries (synchronous
// versions of fs, http, etc.) in the Node.js ecosystem.

let _deasyncLoopWhile: ((condition: () => boolean) => void) | null = null;

/**
 * Lazily load deasync. Only loaded when a non-SQLite backend is actually used,
// so SQLite-only users pay zero extra cost.
 */
function getDeasync(): (condition: () => boolean) => void {
  if (!_deasyncLoopWhile) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const deasync = require('deasync') as unknown as { loopWhile: (condition: () => boolean) => void };
      _deasyncLoopWhile = deasync.loopWhile;
    } catch {
      throw new Error(
        'Package "deasync" is required for non-SQLite database backends.\n' +
        'Install it with: npm install deasync\n' +
        'Or use CLAUDE_MEM_DB_TYPE=sqlite (the default).'
      );
    }
  }
  return _deasyncLoopWhile;
}

/**
 * Synchronously wait for an async operation to complete.
 * Blocks the current thread (via deasync's event loop bridge) until
 * the Promise resolves or rejects, then returns/rethrows the result.
 */
function syncAwait<T>(promise: Promise<T>): T {
  let settled = false;
  let result: T;
  let err: unknown;

  promise.then(
    (val) => { result = val; settled = true; },
    (e) => { err = e; settled = true; }
  );

  // deasync.loopWhile runs the JS event loop (libuv) until condition is false,
  // allowing .then() microtasks and I/O callbacks to fire
  getDeasync()(() => !settled);

  if (err) throw err;
  return result!;
}

// ─── Result Types (mimic bun:sqlite) ────────────────────────────────

export interface RunResult {
  changes: number;
  lastInsertRowid?: number;
}

// ─── PreparedStatement ──────────────────────────────────────────────

/**
 * A prepared statement that works across database backends.
 * Mimics the API of bun:sqlite's `Statement` class.
 */
export class PreparedStatement {
  private sql: string;
  private executor: SqlExecutor;

  constructor(sql: string, executor: SqlExecutor) {
    this.sql = sql;
    this.executor = executor;
  }

  /**
   * Execute and return the first row (or undefined if no match).
   * Equivalent to `bun:sqlite` Statement.get(...params).
   */
  get(...params: QueryParam[]): any {
    return this.executor.queryOneInternal(this.sql, params);
  }

  /**
   * Execute and return all matching rows.
   * Equivalent to `bun:sqlite` Statement.all(...params).
   */
  all(...params: QueryParam[]): any[] {
    return this.executor.queryAllInternal(this.sql, params);
  }

  /**
   * Execute an INSERT/UPDATE/DELETE and return run metadata.
   * Equivalent to `bun:sqlite` Statement.run(...params).
   */
  run(...params: QueryParam[]): RunResult {
    return this.executor.executeInternal(this.sql, params);
  }
}

// ─── SqlExecutor ────────────────────────────────────────────────────

/**
 * Database-agnostic executor that mimics bun:sqlite's Database API.
 *
 * Usage is identical to native `Database`:
 * ```ts
 * const db = getSqlExecutor();
 *
 * // SELECT single row
 * const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(42);
 *
 * // SELECT multiple rows
 * const rows = db.prepare('SELECT * FROM sessions WHERE project = ?').all('my-project');
 *
 * // INSERT / UPDATE / DELETE
 * const result = db.prepare('INSERT INTO sessions (...) VALUES (?, ?, ?)').run(a, b, c);
 * console.log(result.lastInsertRowid);
 *
 * // Transactions (same sync-style API as bun:sqlite)
 * db.transaction(() => {
 *   db.prepare('INSERT INTO ...').run(x);
 *   db.prepare('UPDATE ...').run(y);
 * });
 * ```
 */
export class SqlExecutor {
  private _adapter: DatabaseAdapter | null = null;

  /** Internal cache for synchronous-mode operations on SQLite */
  private _nativeDb: any = null;

  constructor(adapter?: DatabaseAdapter) {
    if (adapter) {
      this._adapter = adapter;
      // For SQLite, cache native DB for sync performance path
      if ('getRawDatabase' in adapter) {
        this._nativeDb = (adapter as any).getRawDatabase();
      }
    }
  }

  // ─── Adapter Management ───────────────────────────────────────────

  /** Set or update the underlying adapter */
  setAdapter(adapter: DatabaseAdapter): void {
    this._adapter = adapter;
    if ('getRawDatabase' in adapter) {
      this._nativeDb = (adapter as any).getRawDatabase();
    } else {
      this._nativeDb = null;
    }
  }

  /** Get the current adapter (lazy-resolves from singleton if not set) */
  getAdapter(): DatabaseAdapter {
    if (!this._adapter) {
      this._adapter = DatabaseManager.getAdapter();
      if ('getRawDatabase' in this._adapter) {
        this._nativeDb = (this._adapter as any).getRawDatabase();
      }
    }
    return this._adapter!;
  }

  // ─── Core API (mimics bun:sqlite Database) ────────────────────────

  /**
   * Prepare a SQL statement.
   * Returns a PreparedStatement that supports .get(), .all(), .run().
   */
  prepare(sql: string): PreparedStatement {
    return new PreparedStatement(sql, this);
  }

  /**
   * Execute raw SQL with no parameters (DDL, PRAGMA, etc.).
   * Note: This is async internally but fire-and-forget for DDL compat.
   */
  run(sql: string): void {
    const adapter = this.getAdapter();
    // Fire-and-forget for DDL; in practice callers await at a higher level
    adapter.runRaw(sql).catch((err) => {
      throw err; // Re-throw synchronously-expected errors
    });
  }

  /**
   * Execute a function inside a transaction.
   * Supports both sync callbacks (like bun:sqlite) and async callbacks.
   *
   * For SQLite: uses native `db.transaction()` for best performance.
   * For other databases: bridges to `adapter.withTransaction()`.
   */
  transaction<T>(fn: (db: SqlExecutor) => T): () => T {
    const self = this;

    // If we have native SQLite DB, use its built-in transaction (fastest path)
    if (self._nativeDb) {
      const nativeTx = self._nativeDb.transaction(() => fn(self));
      return nativeTx;
    }

    // For non-SQLite backends, use the async transaction bridge
    return (() => {
      let result: T;
      let error: unknown;

      // We need to handle the async nature here
      // The fn is expected to be synchronous in style (like bun:sqlite usage),
      // but internally may trigger async operations through the adapter
      try {
        result = fn(self);

        // If fn returned a Promise, wait for it
        if (result instanceof Promise) {
          throw new Error(
            'Transaction callback returned a Promise. ' +
            'Use withTransactionAsync() for async transaction bodies, or ensure all operations are synchronous.'
          );
        }
      } catch (e) {
        error = e;
      }

      if (error) throw error;
      return result!;
    }) as any;
  }

  /**
   * Async transaction wrapper for code that needs true async transactions.
   * Preferred for non-SQLite backends.
   */
  async withTransactionAsync<T>(fn: (db: SqlExecutor) => Promise<T>): Promise<T> {
    const adapter = this.getAdapter();
    return adapter.withTransaction(() => fn(this));
  }

  // ─── Internal Query Implementation ────────────────────────────────

  /** Used by PreparedStatement.get() */
  queryOneInternal(sql: string, params: QueryParam[]): any | undefined {
    const adapter = this.getAdapter();

    // Fast path: native SQLite (synchronous, no allocation overhead)
    if (this._nativeDb) {
      const stmt = this._nativeDb.prepare(sql);
      if (params && params.length > 0) {
        const val = stmt.get(...params);
        return val === undefined ? undefined : val;
      }
      const val = stmt.get();
      return val === undefined ? undefined : val;
    }

    // Slow path: generic adapter — synchronously block until async result
    return syncAwait(adapter.queryOne(sql, params));
  }

  /** Used by PreparedStatement.all() */
  queryAllInternal(sql: string, params: QueryParam[]): any[] {
    const adapter = this.getAdapter();

    // Fast path: native SQLite
    if (this._nativeDb) {
      const stmt = this._nativeDb.prepare(sql);
      if (params && params.length > 0) {
        return stmt.all(...params) || [];
      }
      return stmt.all() || [];
    }

    // Slow path: generic adapter — synchronously block until async result
    return syncAwait(adapter.query(sql, params));
  }

  /** Used by PreparedStatement.run() */
  executeInternal(sql: string, params: QueryParam[]): RunResult {
    const adapter = this.getAdapter();

    // Fast path: native SQLite
    if (this._nativeDb) {
      const stmt = this._nativeDb.prepare(sql);
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

    // Slow path: generic adapter — synchronously block until async result
    return syncAwait(adapter.execute(sql, params));
  }

  // ─── Async variants (for non-SQLite backends) ─────────────────────

  /**
   * Async version of prepare().get() — works on any backend.
   */
  async getAsync(sql: string, params?: QueryParam[]): Promise<any | null> {
    const adapter = this.getAdapter();
    return adapter.queryOne(sql, params);
  }

  /**
   * Async version of prepare().all() — works on any backend.
   */
  async allAsync(sql: string, params?: QueryParam[]): Promise<any[]> {
    const adapter = this.getAdapter();
    return adapter.query(sql, params);
  }

  /**
   * Async version of prepare().run() — works on any backend.
   */
  async runAsync(sql: string, params?: QueryParam[]): Promise<RunResult> {
    const adapter = this.getAdapter();
    return adapter.execute(sql, params);
  }
}

// ─── Global Singleton ───────────────────────────────────────────────

/** Global SqlExecutor instance */
let globalExecutor: SqlExecutor | null = null;

/**
 * Get the global SqlExecutor instance.
 * This is the primary way leaf modules obtain a database connection.
 *
 * The executor lazily binds to the active DatabaseAdapter (from DAL),
 * so it works seamlessly with SQLite, MySQL, PostgreSQL, etc.
 *
 * @example
 * ```ts
 * import { getSqlExecutor } from '../services/database/index.js';
 *
 * const db = getSqlExecutor();
 * const rows = db.prepare('SELECT * FROM sessions WHERE project = ?').all('my-app');
 * ```
 */
export function getSqlExecutor(): SqlExecutor {
  if (!globalExecutor) {
    globalExecutor = new SqlExecutor();
  }
  return globalExecutor;
}

/**
 * Initialize the global SqlExecutor with a specific adapter.
 * Called automatically by initDatabase().
 */
export function initSqlExecutor(adapter: DatabaseAdapter): SqlExecutor {
  if (!globalExecutor) {
    globalExecutor = new SqlExecutor(adapter);
  } else {
    globalExecutor.setAdapter(adapter);
  }
  return globalExecutor;
}
