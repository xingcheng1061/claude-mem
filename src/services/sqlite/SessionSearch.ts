import type { SqlExecutor } from '../database/SqlExecutor.js';
import { TableNameRow } from '../../types/database.js';
import { DATA_DIR, DB_PATH, ensureDir } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import type { DatabaseAdapter } from '../database/adapter.js';
import { AppError } from '../server/ErrorHandler.js';
import {
  ObservationSearchResult,
  SessionSummarySearchResult,
  UserPromptSearchResult,
  SearchOptions,
  SearchFilters,
  DateRange,
  ObservationRow,
  UserPromptRow
} from './types.js';

/** Supported database types for dialect-aware search */
type DbType = 'sqlite' | 'mysql' | 'postgresql';

export class SessionSearch {
  private db: SqlExecutor;

  private static readonly MISSING_SEARCH_INPUT_MESSAGE = 'Either query or filters required for search';

  /** Detected database backend type */
  private dbType: DbType = 'sqlite';

  /** Whether FTS is available for this backend */
  private _ftsAvailable: boolean = false;

  /**
   * @param sqlExec A SqlExecutor instance (obtained via getSqlExecutor()).
   *   Schema and FTS tables are managed by the DAL adapter.
   */
  constructor(sqlExec: SqlExecutor) {
    this.db = sqlExec;

    // Detect database type from the underlying adapter
    try {
      const adapter: DatabaseAdapter = (sqlExec as any).getAdapter?.();
      if (adapter) {
        this.dbType = adapter.type as DbType;
      }
    } catch {
      // Adapter not yet initialized; assume SQLite (default)
      this.dbType = 'sqlite';
    }

    this._ftsAvailable = this.checkFtsAvailability();

    this.ensureFTS();
  }

  // ══════════════════════════════════════════════════════════════════
  // FTS Setup — dialect-aware
  // ══════════════════════════════════════════════════════════════════

  private ensureFTS(): void {
    switch (this.dbType) {
      case 'sqlite':
        this.ensureFts5Tables();
        break;
      case 'mysql':
        // FULLTEXT indexes created by migration v35; just verify
        this._ftsAvailable = this.verifyMysqlFulltext();
        break;
      case 'postgresql':
        // GIN/tsvector created by migration v35; just verify
        this._ftsAvailable = this.verifyPostgresTsvector();
        break;
    }

    if (!this._ftsAvailable) {
      logger.warn(`DB`, `FTS not available on ${this.dbType} — search uses ChromaDB and LIKE queries`);
    }
  }

  private checkFtsAvailability(): boolean {
    switch (this.dbType) {
      case 'sqlite':
        return this.isFts5Available();
      case 'mysql':
        return true; // will be verified after migration check
      case 'postgresql':
        return true; // will be verified after migration check
      default:
        return false;
    }
  }

  // ── SQLite FTS5 ───────────────────────────────────────────────────

  private _fts5Available: boolean = false;

  private isFts5Available(): boolean {
    if (this.dbType !== 'sqlite') return false;
    try {
      this.db.run('CREATE VIRTUAL TABLE _fts5_probe USING fts5(test_column)');
      this.db.run('DROP TABLE _fts5_probe');
      return true;
    } catch {
      return false;
    }
  }

  private ensureFts5Tables(): void {
    const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts'").all() as TableNameRow[];
    const hasFTS = tables.some(t => t.name === 'observations_fts' || t.name === 'session_summaries_fts');

    if (hasFTS) {
      this._fts5Available = true;
      return;
    }

    if (!this.isFts5Available()) {
      logger.warn('DB', 'FTS5 not available on this platform — skipping FTS table creation (search uses ChromaDB)');
      return;
    }

    logger.info('DB', 'Creating FTS5 tables');

    try {
      this.createFts5TablesAndTriggers();
      this._fts5Available = true;
      logger.info('DB', 'FTS5 tables created successfully');
    } catch (error) {
      this._fts5Available = false;
      logger.warn('DB', 'FTS5 table creation failed — search will use ChromaDB and LIKE queries', {}, error instanceof Error ? error : undefined);
    }
  }

  private createFts5TablesAndTriggers(): void {
    this.db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
        title, subtitle, narrative, text, facts, concepts,
        content='observations', content_rowid='id'
      );
    `);

    this.db.run(`
      INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
      SELECT id, title, subtitle, narrative, text, facts, concepts FROM observations;
    `);

    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
        INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
        VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
      END;
      CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
        VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
      END;
      CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
        VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
        INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
        VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
      END;
    `);

    this.db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS session_summaries_fts USING fts5(
        request, investigated, learned, completed, next_steps, notes,
        content='session_summaries', content_rowid='id'
      );
    `);

    this.db.run(`
      INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
      SELECT id, request, investigated, learned, completed, next_steps, notes FROM session_summaries;
    `);

    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS session_summaries_ai AFTER INSERT ON session_summaries BEGIN
        INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
        VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
      END;
      CREATE TRIGGER IF NOT EXISTS session_summaries_ad AFTER DELETE ON session_summaries BEGIN
        INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
        VALUES('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
      END;
      CREATE TRIGGER IF NOT EXISTS session_summaries_au AFTER UPDATE ON session_summaries BEGIN
        INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
        VALUES('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
        INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
        VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
      END;
    `);
  }

  // ── MySQL FULLTEXT verification ────────────────────────────────────

  private verifyMysqlFulltext(): boolean {
    try {
      const rows = this.db.prepare(
        "SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'observations' AND INDEX_TYPE = 'FULLTEXT'"
      ).all() as Array<{ INDEX_NAME?: string }>;
      return rows.length > 0;
    } catch {
      return false;
    }
  }

  // ── PostgreSQL tsvector verification ───────────────────────────────

  private verifyPostgresTsvector(): boolean {
    try {
      const row = this.db.prepare(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'observations' AND column_name = 'search_vector'"
      ).get() as { column_name?: string } | undefined;
      return !!row?.column_name;
    } catch {
      return false;
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // Filter / Order builders (dialect-aware for JSON functions)
  // ══════════════════════════════════════════════════════════════════

  /**
   * Build a JSON array containment condition that works across databases.
   *
   * - sqlite:   json_each(col) WHERE value = ?
   * - mysql:    JSON_CONTAINS(col, JSON_QUOTE(?))
   * - postgresql: col::jsonb @> '[value]'::jsonb
   */
  private jsonContainsCondition(column: string, valueParam: string): string {
    switch (this.dbType) {
      case 'sqlite':
        return `EXISTS (SELECT 1 FROM json_each(${column}) WHERE value = ${valueParam})`;
      case 'mysql':
        return `JSON_CONTAINS(${column}, JSON_QUOTE(${valueParam}))`;
      case 'postgresql':
        // Use @> operator: checks if JSON array contains the element as a string
        return `${column}::jsonb @> CONCAT('[', ${valueParam}, ']')::jsonb`;
      default:
        return `EXISTS (SELECT 1 FROM json_each(${column}) WHERE value = ${valueParam})`;
    }
  }

  /**
   * Build a JSON array LIKE condition for file path matching.
   *
   * - sqlite:   json_each(col) WHERE value LIKE ?
   * - mysql:    JSON_SEARCH(col, 'one', ?) IS NOT NULL
   * - postgresql: EXISTS (SELECT 1 FROM jsonb_array_elements_text(col::jsonb) x WHERE x LIKE ?)
   */
  private jsonLikeCondition(column: string, likeValueParam: string): string {
    switch (this.dbType) {
      case 'sqlite':
        return `EXISTS (SELECT 1 FROM json_each(${column}) WHERE value LIKE ${likeValueParam})`;
      case 'mysql':
        return `JSON_SEARCH(${column}, 'one', ${likeValueParam}) IS NOT NULL`;
      case 'postgresql':
        return `EXISTS (SELECT 1 FROM jsonb_array_elements_text(${column}::jsonb) x WHERE x LIKE ${likeValueParam})`;
      default:
        return `EXISTS (SELECT 1 FROM json_each(${column}) WHERE value LIKE ${likeValueParam})`;
    }
  }

  private buildFilterClause(
    filters: SearchFilters,
    params: any[],
    tableAlias: string = 'o'
  ): string {
    const conditions: string[] = [];

    if (filters.project) {
      conditions.push(`${tableAlias}.project = ?`);
      params.push(filters.project);
    }

    if (filters.type) {
      if (Array.isArray(filters.type)) {
        const placeholders = filters.type.map(() => '?').join(',');
        conditions.push(`${tableAlias}.type IN (${placeholders})`);
        params.push(...filters.type);
      } else {
        conditions.push(`${tableAlias}.type = ?`);
        params.push(filters.type);
      }
    }

    if (filters.dateRange) {
      const { start, end } = filters.dateRange;
      if (start) {
        const startEpoch = typeof start === 'number' ? start : new Date(start).getTime();
        conditions.push(`${tableAlias}.created_at_epoch >= ?`);
        params.push(startEpoch);
      }
      if (end) {
        const endEpoch = typeof end === 'number' ? end : new Date(end).getTime();
        conditions.push(`${tableAlias}.created_at_epoch <= ?`);
        params.push(endEpoch);
      }
    }

    if (filters.concepts) {
      const concepts = Array.isArray(filters.concepts) ? filters.concepts : [filters.concepts];
      const conceptConditions = concepts.map(() => {
        return this.jsonContainsCondition(`${tableAlias}.concepts`, '?');
      });
      if (conceptConditions.length > 0) {
        conditions.push(`(${conceptConditions.join(' OR ')})`);
        params.push(...concepts);
      }
    }

    if (filters.files) {
      const files = Array.isArray(filters.files) ? filters.files : [filters.files];
      const fileConditions = files.map(() => {
        return `(
          ${this.jsonLikeCondition(`${tableAlias}.files_read`, '?')}
          OR ${this.jsonLikeCondition(`${tableAlias}.files_modified`, '?')}
        )`;
      });
      if (fileConditions.length > 0) {
        conditions.push(`(${fileConditions.join(' OR ')})`);
        files.forEach(file => {
          params.push(`%${file}%`, `%${file}%`);
        });
      }
    }

    return conditions.length > 0 ? conditions.join(' AND ') : '';
  }

  /** Build ORDER BY clause with dialect-appropriate relevance ranking */
  private buildOrderClause(orderBy: SearchOptions['orderBy'] = 'relevance'): string {
    switch (orderBy) {
      case 'relevance': {
        switch (this.dbType) {
          case 'sqlite':
            return 'ORDER BY observations_fts.rank ASC';
          case 'mysql':
            // MATCH...AGAINST returns higher score for better matches
            return 'ORDER BY relevance_score DESC';
          case 'postgresql':
            // ts_rank returns higher score for better matches
            return 'ORDER BY ts_rank(search_vector, query_tsquery) DESC';
          default:
            return 'ORDER BY o.created_at_epoch DESC';
        }
      }
      case 'date_desc':
        return 'ORDER BY o.created_at_epoch DESC';
      case 'date_asc':
        return 'ORDER BY o.created_at_epoch ASC';
      default:
        return 'ORDER BY o.created_at_epoch DESC';
    }
  }

  /** Summary-table variant of order clause */
  private buildSummaryOrderClause(orderBy: SearchOptions['orderBy'] = 'relevance'): string {
    switch (orderBy) {
      case 'relevance': {
        switch (this.dbType) {
          case 'sqlite':
            return 'ORDER BY session_summaries_fts.rank ASC';
          case 'mysql':
            return 'ORDER BY relevance_score DESC';
          case 'postgresql':
            return 'ORDER BY ts_rank(search_vector, query_tsquery) DESC';
          default:
            return 'ORDER BY s.created_at_epoch DESC';
        }
      }
      case 'date_asc':
        return 'ORDER BY s.created_at_epoch ASC';
      case 'date_desc':
      default:
        return 'ORDER BY s.created_at_epoch DESC';
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // Full-text search SQL generation (dialect-aware)
  // ══════════════════════════════════════════════════════════════════

  /**
   * Escape query string for FTS usage.
   * - FTS5: double internal quotes
   * - MySQL/PG: escape special characters for natural language mode
   */
  private escapedQuery(query: string): string {
    switch (this.dbType) {
      case 'sqlite':
        return '"' + query.replace(/"/g, '""') + '"';
      case 'mysql':
        // Escape special chars for AGAINST IN NATURAL LANGUAGE MODE
        return query.replace(/[\\'"]/g, '\\$&');
      case 'postgresql':
        // plainto_tsquery handles escaping internally; just trim
        return query.trim();
      default:
        return '"' + query.replace(/"/g, '""') + '"';
    }
  }

  /**
   * Build the observation full-text search SQL for the current dialect.
   * Returns { sql, selectExtras, joinClause, whereClause, preParams, postParams }
   * so the caller can combine them with filters.
   */
  private buildObsFtsSql(query: string): {
    selectExtra: string;
    joinOrFrom: string;
    whereCondition: string;
    orderByScore: string;
    ftsParam: any;
  } {
    const q = this.escapedQuery(query);

    switch (this.dbType) {
      case 'sqlite': {
        return {
          selectExtra: '',
          joinOrFrom: 'JOIN observations_fts ON observations_fts.rowid = o.id',
          whereCondition: 'observations_fts MATCH ?',
          orderByScore: '',
          ftsParam: q,
        };
      }

      case 'mysql': {
        // MATCH ... AGAINST in SELECT provides relevance_score for ordering
        return {
          selectExtra: ', MATCH(o.title, o.subtitle, o.narrative, o.text, o.facts, o.concepts) AGAINST(? IN NATURAL LANGUAGE MODE) AS relevance_score',
          joinOrFrom: '',  // no JOIN needed — index is on the base table
          whereCondition: 'MATCH(o.title, o.subtitle, o.narrative, o.text, o.facts, o.concepts) AGAINST(? IN NATURAL LANGUAGE MODE)',
          orderByScore: '',
          ftsParam: q,
        };
      }

      case 'postgresql': {
        return {
          selectExtra: ", ts_rank(search_vector, plainto_tsquery('english', ?)) AS rank",
          joinOrFrom: '', // no JOIN — search_vector is a column on the table
          whereCondition: "search_vector @@ plainto_tsquery('english', ?)",
          orderByScore: ", plainto_tsquery('english', ?) AS query_tsquery",
          ftsParam: q,
        };
      }

      default:
        throw new Error(`Unsupported database type for FTS: ${this.dbType}`);
    }
  }

  private buildSummaryFtsSql(query: string): {
    selectExtra: string;
    joinOrFrom: string;
    whereCondition: string;
    orderByScore: string;
    ftsParam: any;
  } {
    const q = this.escapedQuery(query);

    switch (this.dbType) {
      case 'sqlite': {
        return {
          selectExtra: '',
          joinOrFrom: 'JOIN session_summaries_fts ON session_summaries_fts.rowid = s.id',
          whereCondition: 'session_summaries_fts MATCH ?',
          orderByScore: '',
          ftsParam: q,
        };
      }

      case 'mysql': {
        return {
          selectExtra: ', MATCH(s.request, s.investigated, s.learned, s.completed, s.next_steps, s.notes) AGAINST(? IN NATURAL LANGUAGE MODE) AS relevance_score',
          joinOrFrom: '',
          whereCondition: 'MATCH(s.request, s.investigated, s.learned, s.completed, s.next_steps, s.notes) AGAINST(? IN NATURAL LANGUAGE MODE)',
          orderByScore: '',
          ftsParam: q,
        };
      }

      case 'postgresql': {
        return {
          selectExtra: ", ts_rank(search_vector, plainto_tsquery('english', ?)) AS rank",
          joinOrFrom: '',
          whereCondition: "search_vector @@ plainto_tsquery('english', ?)",
          orderByScore: ", plainto_tsquery('english', ?) AS query_tsquery",
          ftsParam: q,
        };
      }

      default:
        throw new Error(`Unsupported database type for FTS: ${this.dbType}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // Public API
  // ══════════════════════════════════════════════════════════════════

  get ftsAvailable(): boolean {
    return this._ftsAvailable;
  }

  searchObservations(query: string | undefined, options: SearchOptions = {}): ObservationSearchResult[] {
    const params: any[] = [];
    const { limit = 50, offset = 0, orderBy = 'relevance', ...filters } = options;

    if (!query) {
      const filterClause = this.buildFilterClause(filters, params, 'o');
      if (!filterClause) {
        throw new AppError(SessionSearch.MISSING_SEARCH_INPUT_MESSAGE, 400, 'INVALID_SEARCH_REQUEST');
      }

      const orderClause = orderBy === 'date_asc'
        ? 'ORDER BY o.created_at_epoch ASC'
        : 'ORDER BY o.created_at_epoch DESC';

      const sql = `
        SELECT o.*
        FROM observations o
        WHERE ${filterClause}
        ${orderClause}
        LIMIT ? OFFSET ?
      `;

      params.push(limit, offset);
      return this.db.prepare(sql).all(...params) as ObservationSearchResult[];
    }

    // Text search with FTS
    if (!this._ftsAvailable) {
      logger.warn('DB', `Text search unavailable on ${this.dbType}: FTS not ready and ChromaDB disabled`);
      return [];
    }

    const filterClause = this.buildFilterClause(filters, params, 'o');
    const fts = this.buildObsFtsSql(query);
    const orderClause = this.buildOrderClause(orderBy);

    // Build parameter list: FTS query param(s) first, then filters, then pagination
    const ftsParams: any[] = [fts.ftsParam];

    // MySQL needs the query twice (once for SELECT score, once for WHERE)
    if (this.dbType === 'mysql') {
      ftsParams.unshift(fts.ftsParam);
    }

    // PostgreSQL needs extra params for ts_rank/ts_query CTE references
    if (this.dbType === 'postgresql') {
      ftsParams.push(fts.ftsParam); // for ts_rank
      if (fts.orderByScore) {
        ftsParams.push(fts.ftsParam); // for query_tsquery alias
      }
    }

    const allParams = [...ftsParams, ...params, limit, offset];

    const sql = `
      SELECT o.*${fts.selectExtra}
      FROM observations o
      ${fts.joinOrFrom}
      WHERE ${fts.whereCondition}
      ${filterClause ? 'AND ' + filterClause : ''}
      ${orderClause}
      LIMIT ? OFFSET ?
    `;

    try {
      return this.db.prepare(sql).all(...allParams) as ObservationSearchResult[];
    } catch (error) {
      logger.warn('DB', `${this.dbType.toUpperCase()} observation search failed`, {}, error instanceof Error ? error : undefined);
      throw error;
    }
  }

  searchSessions(query: string | undefined, options: SearchOptions = {}): SessionSummarySearchResult[] {
    const params: any[] = [];
    const { limit = 50, offset = 0, orderBy = 'relevance', ...filters } = options;

    if (!query) {
      const filterOptions = { ...filters };
      delete filterOptions.type;
      const filterClause = this.buildFilterClause(filterOptions, params, 's');
      if (!filterClause) {
        throw new AppError(SessionSearch.MISSING_SEARCH_INPUT_MESSAGE, 400, 'INVALID_SEARCH_REQUEST');
      }

      const orderClause = orderBy === 'date_asc'
        ? 'ORDER BY s.created_at_epoch ASC'
        : 'ORDER BY s.created_at_epoch DESC';

      const sql = `
        SELECT s.*
        FROM session_summaries s
        WHERE ${filterClause}
        ${orderClause}
        LIMIT ? OFFSET ?
      `;

      params.push(limit, offset);
      return this.db.prepare(sql).all(...params) as SessionSummarySearchResult[];
    }

    if (!this._ftsAvailable) {
      logger.warn('DB', `Text search unavailable on ${this.dbType}: FTS not ready and ChromaDB disabled`);
      return [];
    }

    const filterOptions = { ...filters };
    delete filterOptions.type;
    const filterClause = this.buildFilterClause(filterOptions, params, 's');

    const fts = this.buildSummaryFtsSql(query);
    const orderClause = this.buildSummaryOrderClause(orderBy);

    // Build parameter list
    const ftsParams: any[] = [fts.ftsParam];
    if (this.dbType === 'mysql') {
      ftsParams.unshift(fts.ftsParam); // for SELECT relevance_score
    }
    if (this.dbType === 'postgresql') {
      ftsParams.push(fts.ftsParam); // for ts_rank
      if (fts.orderByScore) {
        ftsParams.push(fts.ftsParam); // for query_tsquery alias
      }
    }

    const allParams = [...ftsParams, ...params, limit, offset];

    const sql = `
      SELECT s.*${fts.selectExtra}
      FROM session_summaries s
      ${fts.joinOrFrom}
      WHERE ${fts.whereCondition}
      ${filterClause ? 'AND ' + filterClause : ''}
      ${orderClause}
      LIMIT ? OFFSET ?
    `;

    try {
      return this.db.prepare(sql).all(...allParams) as SessionSummarySearchResult[];
    } catch (error) {
      logger.warn('DB', `${this.dbType.toUpperCase()} session search failed`, {}, error instanceof Error ? error : undefined);
      throw error;
    }
  }

  findByConcept(concept: string, options: SearchOptions = {}): ObservationSearchResult[] {
    const params: any[] = [];
    const { limit = 50, offset = 0, orderBy = 'date_desc', ...filters } = options;

    const conceptFilters = { ...filters, concepts: concept };
    const filterClause = this.buildFilterClause(conceptFilters, params, 'o');

    const orderClause = orderBy === 'date_asc'
      ? 'ORDER BY o.created_at_epoch ASC'
      : 'ORDER BY o.created_at_epoch DESC';

    const sql = `
      SELECT o.*
      FROM observations o
      WHERE ${filterClause}
      ${orderClause}
      LIMIT ? OFFSET ?
    `;

    params.push(limit, offset);

    return this.db.prepare(sql).all(...params) as ObservationSearchResult[];
  }

  private hasDirectChildFile(obs: ObservationSearchResult, folderPath: string): boolean {
    const checkFiles = (filesJson: string | null): boolean => {
      if (!filesJson) return false;
      try {
        const files = JSON.parse(filesJson);
        if (Array.isArray(files)) {
          return files.some(f => isDirectChild(f, folderPath));
        }
      } catch (error) {
        logger.debug('DB', `Failed to parse files JSON for observation ${obs.id}`, undefined, error instanceof Error ? error : undefined);
      }
      return false;
    };

    return checkFiles(obs.files_read) || checkFiles(obs.files_modified);
  }

  private hasDirectChildFileSession(session: SessionSummarySearchResult, folderPath: string): boolean {
    const checkFiles = (filesJson: string | null): boolean => {
      if (!filesJson) return false;
      try {
        const files = JSON.parse(filesJson);
        if (Array.isArray(files)) {
          return files.some(f => isDirectChild(f, folderPath));
        }
      } catch (error) {
        logger.debug('DB', `Failed to parse files JSON for session summary ${session.id}`, undefined, error instanceof Error ? error : undefined);
      }
      return false;
    };

    return checkFiles(session.files_read) || checkFiles(session.files_edited);
  }

  findByFile(filePath: string, options: SearchOptions = {}): {
    observations: ObservationSearchResult[];
    sessions: SessionSummarySearchResult[];
  } {
    const params: any[] = [];
    const { limit = 50, offset = 0, orderBy = 'date_desc', isFolder = false, ...filters } = options;

    const queryLimit = isFolder ? limit * 3 : limit;

    const fileFilters = { ...filters, files: filePath };
    const filterClause = this.buildFilterClause(fileFilters, params, 'o');

    const orderClause = orderBy === 'date_asc'
      ? 'ORDER BY o.created_at_epoch ASC'
      : `ORDER BY o.created_at_epoch DESC`;

    const observationsSql = `
      SELECT o.*
      FROM observations o
      WHERE ${filterClause}
      ${orderClause}
      LIMIT ? OFFSET ?
    `;

    params.push(queryLimit, offset);

    let observations = this.db.prepare(observationsSql).all(...params) as ObservationSearchResult[];

    if (isFolder) {
      observations = observations.filter(obs => this.hasDirectChildFile(obs, filePath)).slice(0, limit);
    }

    // ── Sessions sub-query (uses its own params) ──────────────────────
    const sessionParams: any[] = [];
    const sessionFilters = { ...filters };
    delete sessionFilters.type;

    const baseConditions: string[] = [];

    if (sessionFilters.project) {
      baseConditions.push('s.project = ?');
      sessionParams.push(sessionFilters.project);
    }

    if (sessionFilters.dateRange) {
      const { start, end } = sessionFilters.dateRange;
      if (start) {
        const startEpoch = typeof start === 'number' ? start : new Date(start).getTime();
        baseConditions.push('s.created_at_epoch >= ?');
        sessionParams.push(startEpoch);
      }
      if (end) {
        const endEpoch = typeof end === 'number' ? end : new Date(end).getTime();
        baseConditions.push('s.created_at_epoch <= ?');
        sessionParams.push(endEpoch);
      }
    }

    baseConditions.push(`(
      ${this.jsonLikeCondition('s.files_read', '?')}
      OR ${this.jsonLikeCondition('s.files_edited', '?')}
    )`);
    sessionParams.push(`%${filePath}%`, `%${filePath}%`);

    const sessionsSql = `
      SELECT s.*
      FROM session_summaries s
      WHERE ${baseConditions.join(' AND ')}
      ORDER BY s.created_at_epoch DESC
      LIMIT ? OFFSET ?
    `;

    sessionParams.push(queryLimit, offset);

    let sessions = this.db.prepare(sessionsSql).all(...sessionParams) as SessionSummarySearchResult[];

    if (isFolder) {
      sessions = sessions.filter(s => this.hasDirectChildFileSession(s, filePath)).slice(0, limit);
    }

    return { observations, sessions };
  }

  findByType(
    type: ObservationRow['type'] | ObservationRow['type'][],
    options: SearchOptions = {}
  ): ObservationSearchResult[] {
    const params: any[] = [];
    const { limit = 50, offset = 0, orderBy = 'date_desc', ...filters } = options;

    const typeFilters = { ...filters, type };
    const filterClause = this.buildFilterClause(typeFilters, params, 'o');

    const orderClause = orderBy === 'date_asc'
      ? 'ORDER BY o.created_at_epoch ASC'
      : `ORDER BY o.created_at_epoch DESC`;

    const sql = `
      SELECT o.*
      FROM observations o
      WHERE ${filterClause}
      ${orderClause}
      LIMIT ? OFFSET ?
    `;

    params.push(limit, offset);

    return this.db.prepare(sql).all(...params) as ObservationSearchResult[];
  }

  searchUserPrompts(query: string | undefined, options: SearchOptions = {}): UserPromptSearchResult[] {
    const params: any[] = [];
    const { limit = 20, offset = 0, orderBy = 'relevance', ...filters } = options;

    const baseConditions: string[] = [];
    if (filters.project) {
      baseConditions.push('s.project = ?');
      params.push(filters.project);
    }

    if (filters.dateRange) {
      const { start, end } = filters.dateRange;
      if (start) {
        const startEpoch = typeof start === 'number' ? start : new Date(start).getTime();
        baseConditions.push('up.created_at_epoch >= ?');
        params.push(startEpoch);
      }
      if (end) {
        const endEpoch = typeof end === 'number' ? end : new Date(end).getTime();
        baseConditions.push('up.created_at_epoch <= ?');
        params.push(endEpoch);
      }
    }

    if (!query) {
      if (baseConditions.length === 0) {
        throw new AppError(SessionSearch.MISSING_SEARCH_INPUT_MESSAGE, 400, 'INVALID_SEARCH_REQUEST');
      }

      const whereClause = `WHERE ${baseConditions.join(' AND ')}`;
      const orderClause = orderBy === 'date_asc'
        ? 'ORDER BY up.created_at_epoch ASC'
        : 'ORDER BY up.created_at_epoch DESC';

      const sql = `
        SELECT up.*
        FROM user_prompts up
        JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
        ${whereClause}
        ${orderClause}
        LIMIT ? OFFSET ?
      `;

      params.push(limit, offset);
      return this.db.prepare(sql).all(...params) as UserPromptSearchResult[];
    }

    // Prompt search uses LIKE across all backends (no dedicated FTS index on prompt_text)
    const escapedQuery = query.replace(/[\\%_]/g, '\\$&');
    baseConditions.push("up.prompt_text LIKE ? ESCAPE '\\'");
    params.push(`%${escapedQuery}%`);

    const whereClause = `WHERE ${baseConditions.join(' AND ')}`;
    const orderClause = orderBy === 'date_asc'
      ? 'ORDER BY up.created_at_epoch ASC'
      : 'ORDER BY up.created_at_epoch DESC';

    const sql = `
      SELECT up.*
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      ${whereClause}
      ${orderClause}
      LIMIT ? OFFSET ?
    `;

    params.push(limit, offset);
    return this.db.prepare(sql).all(...params) as UserPromptSearchResult[];
  }

  getUserPromptsBySession(contentSessionId: string): UserPromptRow[] {
    const stmt = this.db.prepare(`
      SELECT
        id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch
      FROM user_prompts
      WHERE content_session_id = ?
      ORDER BY prompt_number ASC
    `);

    return stmt.all(contentSessionId) as UserPromptRow[];
  }

  close(): void {
    this.db.close();
  }
}

// Re-export isDirectChild from path-utils for use in this module
function isDirectChild(filePath: string, folderPath: string): boolean {
  // Import dynamically to avoid circular deps at top level
  const { isDirectChild: check } = require('../../shared/path-utils.js');
  return check(filePath, folderPath);
}
