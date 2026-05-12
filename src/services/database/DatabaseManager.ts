/**
 * DatabaseManager — Singleton manager for database adapter lifecycle
 *
 * Replaces the legacy `DatabaseManager` (sqlite-specific) with a
 * database-agnostic version that delegates to a `DatabaseAdapter`.
 *
 * Usage:
 * ```ts
 * await DatabaseManager.initialize(config);
 * const db = DatabaseManager.getAdapter();
 * ```
 */

import type { DatabaseAdapter, DatabaseConfig, DatabaseType } from './adapter.js';
import { createDatabaseAdapter, MigrationRegistry } from './adapter.js';
import { logger } from '../../utils/logger.js';

class DatabaseManagerInstance {
  private adapter: DatabaseAdapter | null = null;
  private config: DatabaseConfig | null = null;
  private migrationRegistry = new MigrationRegistry();

  /**
   * Initialize the database connection and run pending migrations.
   * Should be called once at application startup.
   */
  async initialize(config?: DatabaseConfig): Promise<DatabaseAdapter> {
    if (this.adapter) {
      logger.info('DB', 'Database already initialized — returning existing adapter');
      return this.adapter;
    }

    // Build config from environment if not provided
    const resolvedConfig = config ?? this.buildConfigFromEnv();

    this.config = resolvedConfig;

    logger.info('DB', `Initializing ${resolvedConfig.type} database...`);

    // Create the appropriate adapter via factory
    this.adapter = createDatabaseAdapter(resolvedConfig);

    // Initialize connection + schema
    await this.adapter.initialize();

    logger.info('DB', `${resolvedConfig.type} database connected successfully`);

    // Run migrations
    await this.runMigrations();

    return this.adapter;
  }

  /** Get the active database adapter. Throws if not initialized. */
  getAdapter(): DatabaseAdapter {
    if (!this.adapter) {
      throw new Error(
        'Database not initialized. Call DatabaseManager.initialize() first.'
      );
    }
    return this.adapter;
  }

  /**
   * Get the underlying native database object for backward compatibility.
   * Only works with SQLiteAdapter; throws for other adapters.
   *
   * @deprecated Use getAdapter() and its query/execute API instead.
   */
  getNativeConnection(): unknown {
    if (!this.adapter) {
      throw new Error('Database not initialized.');
    }
    if ('getRawDatabase' in this.adapter) {
      return (this.adapter as any).getRawDatabase();
    }
    // For MySQL/PostgreSQL, expose the pool or client
    return null;
  }

  /** Check if database has been initialized */
  isInitialized(): boolean {
    return this.adapter !== null && this.adapter.isConnected();
  }

  /** Close all connections and release resources */
  async close(): Promise<void> {
    if (this.adapter) {
      await this.adapter.close();
      this.adapter = null;
      this.config = null;
      logger.info('DB', 'Database connection closed');
    }
  }

  // ─── Migration Management ────────────────────────────────────────

  /** Register migration steps (called during module initialization) */
  registerMigration(step: Parameters<MigrationRegistry['register']>[0]): void {
    this.migrationRegistry.register(step);
  }

  private async runMigrations(): Promise<void> {
    if (!this.adapter || !this.config) return;

    const steps = this.migrationRegistry.getAll();
    if (steps.length === 0) {
      logger.info('DB', 'No migrations registered');
      return;
    }

    // Ensure schema_versions table exists
    await this.ensureSchemaVersionsTable();

    // Get applied versions
    const appliedRows = await this.adapter.query(
      'SELECT version FROM schema_versions ORDER BY version'
    );
    const appliedVersions = appliedRows.map((r) => r.version as number);

    const pending = this.migrationRegistry.getPending(appliedVersions);

    if (pending.length === 0) {
      logger.info('DB', `Schema up to date (version ${this.migrationRegistry.getLatestVersion()})`);
      return;
    }

    logger.info(`DB`, `Running ${pending.length} pending migration(s)...`);

    for (const step of pending) {
      try {
        await this.adapter.withTransaction(async () => {
          await step.up(this.adapter!);

          // Record migration in schema_versions
          await this.adapter!.execute(
            'INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)',
            [step.version, new Date().toISOString()]
          );
        });

        logger.info(`DB`, `Migration ${step.version} applied: ${step.description}`);
      } catch (error) {
        logger.error('DB', `Migration ${step.version} FAILED: ${step.description}`, {}, error instanceof Error ? error : undefined);
        throw error; // Fail fast on migration errors
      }
    }

    logger.info(`DB`, `All migrations applied (version ${this.migrationRegistry.getLatestVersion()})`);
  }

  private async ensureSchemaVersionsTable(): Promise<void> {
    if (!this.adapter) return;

    const exists = await this.adapter.tableExists('schema_versions');
    if (!exists) {
      await this.adapter.runRaw(`
        CREATE TABLE IF NOT EXISTS schema_versions (
          id SERIAL PRIMARY KEY,
          version INTEGER UNIQUE NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);
    }
  }

  // ─── Config Resolution ──────────────────────────────────────────

  private buildConfigFromEnv(): DatabaseConfig {
    const dbType = (process.env.CLAUDE_MEM_DB_TYPE || 'sqlite') as DatabaseType;
    let connection: string | Record<string, unknown>;

    switch (dbType) {
      case 'mysql':
        connection =
          process.env.CLAUDE_MEM_MYSQL_URL ||
          process.env.DATABASE_URL ||
          {
            host: process.env.CLAUDE_MEM_DB_HOST || '127.0.0.1',
            port: parseInt(process.env.CLAUDE_MEM_DB_PORT || '3306', 10),
            user: process.env.CLAUDE_MEM_DB_USER || 'root',
            password: process.env.CLAUDE_MEM_DB_PASSWORD || '',
            database: process.env.CLAUDE_MEM_DB_NAME || 'claude_mem',
          };
        break;

      case 'postgresql':
        connection =
          process.env.CLAUDE_MEM_POSTGRES_URL ||
          process.env.DATABASE_URL ||
          {
            host: process.env.CLAUDE_MEM_DB_HOST || '127.0.0.1',
            port: parseInt(process.env.CLAUDE_MEM_DB_PORT || '5432', 10),
            user: process.env.CLAUDE_MEM_DB_USER || 'postgres',
            password: process.env.CLAUDE_MEM_DB_PASSWORD || '',
            database: process.env.CLAUDE_MEM_DB_NAME || 'claude_mem',
          };
        break;

      case 'sqlite':
      default:
        connection =
          process.env.CLAUDE_MEM_SQLITE_PATH ||
          process.env.DB_PATH ||
          ''; // Will resolve to DB_PATH default
        break;
    }

    return {
      type: dbType,
      connection,
      dataDir: process.env.CLAUDE_MEM_DATA_DIR,
      poolSize: parseInt(process.env.CLAUDE_MEM_DB_POOL_SIZE || '10', 10),
      debug: process.env.CLAUDE_MEM_DB_DEBUG === 'true',
    };
  }
}

/** Singleton instance */
export const DatabaseManager = new DatabaseManagerInstance();

/** Convenience export — re-export types */
export type { DatabaseAdapter, DatabaseConfig, DatabaseType, MigrationStep, DialectMigrationFn } from './adapter.js';
