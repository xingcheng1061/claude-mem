
import type { SqlExecutor } from '../database/SqlExecutor.js';
import { getSqlExecutor, initDatabase } from '../database/index.js';
import { SessionStore } from '../sqlite/SessionStore.js';
import { SessionSearch } from '../sqlite/SessionSearch.js';
import { ChromaSync } from '../sync/ChromaSync.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH, DB_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import type { DBSession } from '../worker-types.js';

export class DatabaseManager {
  private sqlExec: SqlExecutor | null = null;
  private sessionStore: SessionStore | null = null;
  private sessionSearch: SessionSearch | null = null;
  private chromaSync: ChromaSync | null = null;

  async initialize(): Promise<void> {
    // Initialize DAL (creates adapter, runs migrations, binds SqlExecutor)
    await initDatabase();
    this.sqlExec = getSqlExecutor();

    // SessionStore and SessionSearch now receive SqlExecutor (DB-agnostic)
    this.sessionStore = new SessionStore(this.sqlExec);
    this.sessionSearch = new SessionSearch(this.sqlExec);

    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const chromaEnabled = settings.CLAUDE_MEM_CHROMA_ENABLED !== 'false';
    if (chromaEnabled) {
      this.chromaSync = new ChromaSync('claude-mem');
    } else {
      logger.info('DB', 'Chroma disabled via CLAUDE_MEM_CHROMA_ENABLED=false, using SQLite-only search');
    }

    logger.info('DB', 'Database initialized via Data Access Layer (shared connection)');
  }

  async close(): Promise<void> {
    if (this.chromaSync) {
      await this.chromaSync.close();
      this.chromaSync = null;
    }

    this.sessionStore = null;
    this.sessionSearch = null;
    this.sqlExec = null;

    // Close DAL adapter
    const { DatabaseManager: DalManager } = await import('../database/DatabaseManager.js');
    await DalManager.close();

    logger.info('DB', 'Database closed');
  }

  getSessionStore(): SessionStore {
    if (!this.sessionStore) {
      throw new Error('Database not initialized');
    }
    return this.sessionStore;
  }

  getSessionSearch(): SessionSearch {
    if (!this.sessionSearch) {
      throw new Error('Database not initialized');
    }
    return this.sessionSearch;
  }

  getChromaSync(): ChromaSync | null {
    return this.chromaSync;
  }

  /** Get the SqlExecutor (DB-agnostic query interface) */
  getConnection(): SqlExecutor {
    if (!this.sqlExec) {
      throw new Error('Database not initialized');
    }
    return this.sqlExec;
  }

  getSessionById(sessionDbId: number): {
    id: number;
    content_session_id: string;
    memory_session_id: string | null;
    project: string;
    platform_source: string;
    user_prompt: string;
    custom_title: string | null;
    status: string;
  } {
    const session = this.getSessionStore().getSessionById(sessionDbId);
    if (!session) {
      throw new Error(`Session ${sessionDbId} not found`);
    }
    return session;
  }

}
