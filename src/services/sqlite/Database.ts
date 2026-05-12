/**
 * Legacy SQLite Database Manager — Backward Compatibility Layer
 *
 * This module now delegates to the database-agnostic Data Access Layer (DAL)
 * defined in `src/services/database/`. When `CLAUDE_MEM_DB_TYPE` is 'sqlite'
 * (the default), behavior is identical to before.
 *
 * For other databases (mysql, postgresql), the adapter handles all driver logic.
 *
 * @deprecated Prefer importing from `src/services/database/index.js` for new code.
 *             This file is kept for backward compatibility with 35+ consumers.
 */

import { Database } from 'bun:sqlite';
import { DATA_DIR, DB_PATH, ensureDir } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';

const SQLITE_MMAP_SIZE_BYTES = 256 * 1024 * 1024;
const SQLITE_CACHE_SIZE_PAGES = 10_000;

export interface Migration {
  version: number;
  up: (db: Database) => void;
  down?: (db: Database) => void;
}

/** Cached native Database reference for backward compat */
let dbInstance: Database | null = null;

// ─── ClaudeMemDatabase: Standalone DB class (used by some entry points) ──

export class ClaudeMemDatabase {
  public db: Database;

  constructor(dbPath: string = DB_PATH) {
    if (dbPath !== ':memory:') {
      ensureDir(DATA_DIR);
    }

    this.db = new Database(dbPath, { create: true, readwrite: true });

    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA synchronous = NORMAL');
    this.db.run('PRAGMA foreign_keys = ON');
    this.db.run('PRAGMA temp_store = memory');
    this.db.run(`PRAGMA mmap_size = ${SQLITE_MMAP_SIZE_BYTES}`);
    this.db.run(`PRAGMA cache_size = ${SQLITE_CACHE_SIZE_PAGES}`);

    // Run migrations via legacy runner or new DAL
    try {
      const { MigrationRunner } = await import('./migrations/runner.js');
      const migrationRunner = new MigrationRunner(this.db);
      migrationRunner.runAllMigrations();
    } catch {
      logger.warn('DB', 'Legacy migration runner unavailable; ensure schema is initialized via DAL.');
    }

    // Cache for getDatabase() backward compat
    dbInstance = this.db;
  }

  close(): void {
    this.db.close();
    if (dbInstance === this.db) dbInstance = null;
  }
}

// ─── DatabaseManager: Singleton manager (now delegates to DAL when possible) ──

let _dalInitialized = false;

export class DatabaseManager {
  private static instance: DatabaseManager;
  private db: Database | null = null;
  private migrations: Migration[] = [];

  static getInstance(): DatabaseManager {
    if (!DatabaseManager.instance) {
      DatabaseManager.instance = new DatabaseManager();
    }
    return DatabaseManager.instance;
  }

  registerMigration(migration: Migration): void {
    this.migrations.push(migration);
    this.migrations.sort((a, b) => a.version - b.version);
  }

  /**
   * Initialize the database.
   *
   * If CLAUDE_MEM_DB_TYPE != 'sqlite', this will initialize the DAL and
   * return a wrapped connection. Otherwise, behaves as before.
   */
  async initialize(): Promise<Database> {
    if (this.db) {
      return this.db;
    }

    const dbType = process.env.CLAUDE_MEM_DB_TYPE || 'sqlite';

    // ── Use new DAL for non-SQLite backends ────────────────────────
    if (dbType !== 'sqlite' && !_dalInitialized) {
      try {
        const { initDatabase } = await import('../database/index.js');
        await initDatabase();
        _dalInitialized = true;

        // Get native connection from adapter for backward compat
        const dalManager = (await import('../database/DatabaseManager.js')).DatabaseManager;
        const native = dalManager.getNativeConnection();
        if (native instanceof Database) {
          this.db = native;
          dbInstance = native;
          return native;
        }

        throw new Error(
          `Cannot return native Database object for ${dbType} backend. ` +
          `Migrate to DAL API: import { DatabaseManager } from '../services/database/index.js'`
        );
      } catch (e) {
        if ((e as Error).message.includes('migrate to')) throw e;
        logger.warn(
          'DB',
          `DAL initialization failed for ${dbType}, falling back to SQLite`,
          {},
          e instanceof Error ? e : undefined
        );
      }
    }

    // ── Legacy SQLite path (default behavior unchanged) ─────────────
    ensureDir(DATA_DIR);

    this.db = new Database(DB_PATH, { create: true, readwrite: true });

    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA synchronous = NORMAL');
    this.db.run('PRAGMA foreign_keys = ON');
    this.db.run('PRAGMA temp_store = memory');
    this.db.run(`PRAGMA mmap_size = ${SQLITE_MMAP_SIZE_BYTES}`);
    this.db.run(`PRAGMA cache_size = ${SQLITE_CACHE_SIZE_PAGES}`);

    this.initializeSchemaVersions();

    await this.runMigrations();

    dbInstance = this.db;
    return this.db;
  }

  getConnection(): Database {
    if (!this.db) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    return this.db;
  }

  withTransaction<T>(fn: (db: Database) => T): T {
    const db = this.getConnection();
    const transaction = db.transaction(fn);
    return transaction(db);
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      dbInstance = null;
    }
  }

  private initializeSchemaVersions(): void {
    if (!this.db) return;

    this.db.run(`
      CREATE TABLE IF NOT EXISTS schema_versions (
        id INTEGER PRIMARY KEY,
        version INTEGER UNIQUE NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
  }

  private async runMigrations(): Promise<void> {
    if (!this.db) return;

    const query = this.db.query('SELECT version FROM schema_versions ORDER BY version');
    const appliedVersions = query.all().map((row: any) => row.version);

    const maxApplied = appliedVersions.length > 0 ? Math.max(...appliedVersions) : 0;

    for (const migration of this.migrations) {
      if (migration.version > maxApplied) {
        logger.info('DB', `Applying migration ${migration.version}`);

        const transaction = this.db.transaction(() => {
          migration.up(this.db!);

          const insertQuery = this.db!.query('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)');
          insertQuery.run(migration.version, new Date().toISOString());
        });

        transaction();
        logger.info('DB', `Migration ${migration.version} applied successfully`);
      }
    }
  }

  getCurrentVersion(): number {
    if (!this.db) return 0;

    const query = this.db.query('SELECT MAX(version) as version FROM schema_versions');
    const result = query.get() as { version: number } | undefined;

    return result?.version || 0;
  }
}

export function getDatabase(): Database {
  if (!dbInstance) {
    throw new Error('Database not initialized. Call DatabaseManager.getInstance().initialize() first.');
  }
  return dbInstance;
}

export async function initializeDatabase(): Promise<Database> {
  const manager = DatabaseManager.getInstance();
  return await manager.initialize();
}

export { Database };

// ─── DAL Bridge: Expose SqlExecutor for migrated consumers ──────────

/**
 * Get the DB-agnostic SqlExecutor from the DAL.
 * Use this when migrating code away from native `Database` type.
 *
 * @example
 * ```ts
 * import { getSqlExecutor } from '../services/sqlite/Database.js';
 * const db = getSqlExecutor();
 * const rows = db.prepare('SELECT * FROM sessions').all();
 * ```
 */
export function getSqlExecutor(): import('../database/SqlExecutor.js').SqlExecutor {
  // Dynamic import — safe because DAL is always initialized at startup
  // before any consumer calls this function. The module cache returns immediately.
  const dalModule = require('../database/SqlExecutor.js') as {
    getSqlExecutor: () => import('../database/SqlExecutor.js').SqlExecutor;
    SqlExecutor: typeof import('../database/SqlExecutor.js').SqlExecutor;
  };
  return dalModule.getSqlExecutor();
}

// Re-export types for convenience
export type { SqlExecutor } from '../database/SqlExecutor.js';

export { MigrationRunner } from './migrations/runner.js';

export * from './Sessions.js';
export * from './Observations.js';
export * from './Summaries.js';
export * from './Prompts.js';
export * from './Timeline.js';
export * from './Import.js';
export * from './transactions.js';