/**
 * PostgreSQL Adapter — PostgreSQL backend via `pg` (node-postgres)
 *
 * Implements DatabaseAdapter for PostgreSQL databases.
 *
 * SQL dialect differences handled:
 *  - SERIAL / BIGSERIAL instead of INTEGER PRIMARY KEY AUTOINCREMENT
 *  - tsvector / tsquery for full-text search instead of FTS5
 *  - ->> and jsonb_path_query instead of json_extract() / json_each()
 *  - INSERT ... ON CONFLICT DO NOTHING (same as SQLite!)
 *  - Partial indexes supported natively (WHERE clause in CREATE INDEX)
 *  - $1, $2 parameter style (dollar-quoted)
 *  - RETURNING clause fully supported on all DML
 */

import type {
  DatabaseAdapter,
  DatabaseConfig,
  MutationResult,
  QueryParam,
  Row,
  RowList,
  SearchCapabilities,
} from '../adapter.js';

const PG_SEARCH_CAPS: SearchCapabilities = {
  hasFullTextSearch: true,       // GIN indexes on tsvector columns
  hasJsonFunctions: true,        // ->, ->>, jsonb_array_elements_text(), etc.
  hasJsonTableFunction: true,    // jsonb_array_elements_text(), etc.
  hasPartialIndex: true,         // Native support with CREATE INDEX ... WHERE
  hasWindowFunctions: true,      // Full window function support
  supportsReturning: true,       // RETURNING * fully supported
  supportsUpsert: true,          // INSERT ... ON CONFLICT DO NOTHING/UPDATE
};

interface PgConnectionConfig {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
}

export class PostgreSQLAdapter implements DatabaseAdapter {
  readonly type = 'postgresql' as const;
  readonly name = 'PostgreSQL';
  readonly searchCapabilities = PG_SEARCH_CAPS;

  private pool: any = null;      // pg.Pool instance
  private config: DatabaseConfig;
  private connConfig: PgConnectionConfig;
  private _isConnected = false;

  constructor(config: DatabaseConfig) {
    this.config = config;
    this.connConfig = typeof config.connection === 'object'
      ? config.connection as unknown as PgConnectionConfig
      : this.parseConnectionString(config.connection as string);
  }

  async initialize(): Promise<void> {
    const { default: pg } = await import('pg');

    this.pool = new pg.Pool({
      host: this.connConfig.host || '127.0.0.1',
      port: this.connConfig.port || 5432,
      user: this.connConfig.user || 'postgres',
      password: this.connConfig.password || '',
      database: this.connConfig.database || 'claude_mem',
      max: this.config.poolSize || 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });

    // Verify connectivity
    const client = await this.pool.connect();
    try {
      await client.query('SELECT NOW()');
    } finally {
      client.release();
    }

    this._isConnected = true;
  }

  close(): Promise<void> {
    if (this.pool) {
      return this.pool.end().then(() => {
        this.pool = null;
        this._isConnected = false;
      });
    }
    return Promise.resolve();
  }

  isConnected(): boolean {
    return this._isConnected && this.pool !== null;
  }

  // ─── Core Query API ──────────────────────────────────────────────

  /**
   * Convert ? placeholders to $1, $2, ... style for PostgreSQL.
   * This is the key difference between SQLite/MySQL and Postgres.
   */
  private convertPlaceholders(sql: string): string {
    let idx = 0;
    return sql.replace(/\?/g, () => `$${++idx}`);
  }

  async query(sql: string, params?: QueryParam[]): Promise<RowList> {
    const client = await this.getClient();
    try {
      const pgSql = this.convertPlaceholders(sql);
      const result = await client.query(pgSql, params || []);
      return JSON.parse(JSON.stringify(result.rows)) as Row[];
    } finally {
      if ('release' in client) client.release();
    }
  }

  async queryOne(sql: string, params?: QueryParam[]): Promise<Row | null> {
    const rows = await this.query(sql, params);
    return rows.length > 0 ? rows[0] : null;
  }

  async execute(sql: string, params?: QueryParam[]): Promise<MutationResult> {
    const client = await this.getClient();
    try {
      const pgSql = this.convertPlaceholders(sql);
      const result = await client.query(pgSql, params || []);
      return {
        changes: result.rowCount ?? 0,
        lastInsertRowid: result.rows?.[0]?.['id']
          ? Number(result.rows[0]['id'])
          : undefined,
        returning: result.rows?.[0] as Row | undefined,
      };
    } finally {
      if ('release' in client) client.release();
    }
  }

  async runRaw(sql: string): Promise<void> {
    const client = await this.getClient();
    try {
      await client.query(sql);
    } finally {
      if ('release' in client) client.release();
    }
  }

  async batchRun(statements: string[]): Promise<void> {
    const client = await this.getClient();
    try {
      for (const stmt of statements) {
        await client.query(stmt);
      }
    } finally {
      if ('release' in client) client.release();
    }
  }

  // ─── Transactions ────────────────────────────────────────────────

  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    const client = await this.getClient(true);
    try {
      await client.query('BEGIN');
      const result = await fn();
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      if ('release' in client) client.release();
    }
  }

  // ─── Schema Introspection ────────────────────────────────────────

  async tableExists(tableName: string): Promise<boolean> {
    const row = await this.queryOne(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = $1`,
      [tableName]
    );
    return !!row;
  }

  async getColumns(tableName: string): Promise<string[]> {
    const rows = await this.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
      [tableName]
    );
    return rows.map((r: Row) => r.column_name as string);
  }

  // ─── Dialect Helpers ─────────────────────────────────────────────

  convertParams(sql: string, params: QueryParam[]): { sql: string; params: QueryParam[] } {
    // Convert ? to $N style for PostgreSQL
    const converted = this.convertPlaceholders(sql);
    return { sql: converted, params };
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
    // Return PostgreSQL-style placeholders: $1, $2, ...
    return Array.from({ length: count }, (_, i) => `$${i + 1}`).join(', ');
  }

  // ─── Private Helpers ─────────────────────────────────────────────

  private async getClient(forTransaction = false): Promise<any> {
    if (!this.pool) throw new Error('PostgreSQL adapter not initialized');
    if (forTransaction) {
      return this.pool.connect();
    }
    return this.pool.connect();
  }

  private parseConnectionString(connStr: string): PgConnectionConfig {
    // Handle standard postgresql:// or postgres:// URIs
    try {
      // Strip protocol prefix if present
      let clean = connStr.replace(/^postgres(ql)?:\/\//, '');
      const url = new URL('http://' + clean);

      return {
        host: decodeURIComponent(url.hostname) || undefined,
        port: url.port ? parseInt(url.port, 10) : undefined,
        user: decodeURIComponent(url.username) || undefined,
        password: decodeURIComponent(url.password) || undefined,
        database: decodeURIComponent(url.pathname?.replace(/^\//, '') || '') || undefined,
      };
    } catch {
      return { database: connStr };
    }
  }
}
