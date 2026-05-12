/**
 * MySQL Adapter — MySQL / MariaDB backend via mysql2/promise
 *
 * Implements DatabaseAdapter for MySQL-compatible databases.
 * Uses connection pooling for production use.
 *
 * SQL dialect differences handled:
 *  - AUTO_INCREMENT instead of AUTOINCREMENT
 *  - FULLTEXT indexes instead of FTS5
 *  - JSON_EXTRACT() instead of json_extract()
 *  - INSERT ... ON DUPLICATE KEY UPDATE instead of UPSERT
 *  - No partial indexes (use generated columns or triggers)
 *  - LIMIT/OFFSET syntax same as SQLite
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

const MYSQL_SEARCH_CAPS: SearchCapabilities = {
  hasFullTextSearch: true,       // FULLTEXT index with MATCH ... AGAINST
  hasJsonFunctions: true,        // JSON_EXTRACT(), JSON_UNQUOTE()
  hasJsonTableFunction: false,   // No json_each() equivalent; use JSON_TABLE (MySQL 8.0+)
  hasPartialIndex: false,        // Not natively supported; filter in app layer
  hasWindowFunctions: true,      // ROW_NUMBER() OVER (...) supported since 8.0
  supportsReturning: false,      // RETURNING added in MySQL 8.0.19+ but limited
  supportsUpsert: true,          // INSERT ... ON DUPLICATE KEY UPDATE
};

interface MySqlConnectionConfig {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  charset?: string;
  timezone?: string;
  connectTimeout?: number;
}

export class MySQLAdapter implements DatabaseAdapter {
  readonly type = 'mysql' as const;
  readonly name = 'MySQL';
  readonly searchCapabilities = MYSQL_SEARCH_CAPS;

  private pool: any = null;     // mysql2 Pool instance
  private config: DatabaseConfig;
  private connConfig: MySqlConnectionConfig;
  private _isConnected = false;

  constructor(config: DatabaseConfig) {
    this.config = config;
    this.connConfig = typeof config.connection === 'object'
      ? config.connection as unknown as MySqlConnectionConfig
      : this.parseConnectionString(config.connection as string);
  }

  async initialize(): Promise<void> {
    const mysql = await import('mysql2/promise');

    const poolConfig: any = {
      host: this.connConfig.host || '127.0.0.1',
      port: this.connConfig.port || 3306,
      user: this.connConfig.user || 'root',
      password: this.connConfig.password || '',
      database: this.connConfig.database || 'claude_mem',
      charset: this.connConfig.charset || 'utf8mb4',
      timezone: this.connConfig.timezone || '+00:00',
      connectTimeout: this.connConfig.connectTimeout || 10000,
      waitForConnections: true,
      connectionLimit: this.config.poolSize || 10,
      maxIdle: 5,
      idleTimeout: 60000,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
    };

    this.pool = await mysql.createPool(poolConfig);

    // Verify connectivity
    const conn = await this.pool.getConnection();
    try {
      await conn.ping();
    } finally {
      conn.release();
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

  async query(sql: string, params?: QueryParam[]): Promise<RowList> {
    const conn = await this.getConnection();
    try {
      const [rows] = await conn.query({ sql, values: params || [] });
      return JSON.parse(JSON.stringify(rows)) as Row[];
    } finally {
      if ('release' in conn) conn.release();
    }
  }

  async queryOne(sql: string, params?: QueryParam[]): Promise<Row | null> {
    const rows = await this.query(sql, params);
    return rows.length > 0 ? rows[0] : null;
  }

  async execute(sql: string, params?: QueryParam[]): Promise<MutationResult> {
    const conn = await this.getConnection();
    try {
      const [result]: any[] = await conn.query({ sql, values: params || [] });
      return {
        changes: result.affectedRows ?? 0,
        lastInsertRowid: result.insertId ? Number(result.insertId) : undefined,
      };
    } finally {
      if ('release' in conn) conn.release();
    }
  }

  async runRaw(sql: string): Promise<void> {
    const conn = await this.getConnection();
    try {
      await conn.query(sql);
    } finally {
      if ('release' in conn) conn.release();
    }
  }

  async batchRun(statements: string[]): Promise<void> {
    const conn = await this.getConnection();
    try {
      for (const sql of statements) {
        await conn.query(sql);
      }
    } finally {
      if ('release' in conn) conn.release();
    }
  }

  // ─── Transactions ────────────────────────────────────────────────

  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await this.getConnection(true); // Get a dedicated connection for transaction
    try {
      await conn.beginTransaction();
      const result = await fn();
      await conn.commit();
      return result;
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      if ('release' in conn) conn.release();
    }
  }

  // ─── Schema Introspection ────────────────────────────────────────

  async tableExists(tableName: string): Promise<boolean> {
    const row = await this.queryOne(
      `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [tableName]
    );
    return !!row;
  }

  async getColumns(tableName: string): Promise<string[]> {
    const rows = await this.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
      [tableName]
    );
    return rows.map((r: Row) => r.COLUMN_NAME as string);
  }

  // ─── Dialect Helpers ─────────────────────────────────────────────

  convertParams(sql: string, params: QueryParam[]): { sql: string; params: QueryParam[] } {
    // MySQL uses positional ? like SQLite — no conversion needed
    return { sql, params };
  }

  limitOffset(limit?: number, offset?: number): string {
    const parts: string[] = [];
    if (limit !== undefined && limit !== null) parts.push(`LIMIT ${limit}`);
    if (offset !== undefined && offset !== null) parts.push(`OFFSET ${offset}`);
    return parts.join(' ');
  }

  escapeIdentifier(name: string): string {
    return `\`${name.replace(/`/g, '``')}\``;
  }

  placeholders(count: number): string {
    return Array(count).fill('?').join(', ');
  }

  // ─── Private Helpers ─────────────────────────────────────────────

  private async getConnection(forTransaction = false): Promise<any> {
    if (!this.pool) throw new Error('MySQL adapter not initialized');
    if (forTransaction) {
      return this.pool.getConnection();
    }
    return this.pool.getConnection();
  }

  private parseConnectionString(connStr: string): MySqlConnectionConfig {
    // Basic URI parsing: mysql://user:pass@host:port/dbname
    try {
      const url = new URL(connStr);
      return {
        host: url.hostname || undefined,
        port: url.port ? parseInt(url.port, 10) : undefined,
        user: url.username || undefined,
        password: url.password || undefined,
        database: url.pathname?.replace(/^\//, '') || undefined,
      };
    } catch {
      // If not a valid URL, treat as a simple identifier
      return { database: connStr };
    }
  }
}
