# CODEBUDDY.md This file provides guidance to CodeBuddy when working with code in this repository.

## Project Overview

Claude-mem is a **Claude Code plugin** providing persistent memory across sessions. It captures tool usage, compresses observations using the Claude Agent SDK via AI summarization, and injects relevant context into future sessions. Written in TypeScript, uses **Bun** as runtime/test-runner, and **Node.js** for npm operations.

## Common Commands

### Build & Dev
```bash
npm run build              # Sync plugin manifests + build hooks (no compile step; source is TS but hooks use bun/eval)
npm run build-and-sync     # Full pipeline: build → sync marketplace → restart worker (primary dev command)
```

### Testing
```bash
bun test                   # Run all tests
bun test <file-path>       # Run a single test file, e.g., bun tests/hook-lifecycle.test.ts
bun test tests/sqlite/     # Run tests in a subdirectory (sqlite, agents, search, context, infra, server)
```

### Type Checking
```bash
tsc --noEmit               # Root project typecheck
tsc --noEmit -p src/ui/viewer/tsconfig.json  # Viewer UI typecheck
npm run typecheck          # Both combined
```

### Worker Management (local dev)
```bash
bun plugin/scripts/worker-service.cjs start|stop|restart|status
npm run worker:logs        # Tail recent worker logs
```

### Other Useful Commands
```bash
npm run queue              # Check pending processing queue
npm run queue:process      # Process queued items
npm run bug-report         # Generate structured bug report
```

## Architecture

### Data Flow: Hook → Worker → Database → Context Injection

The system follows a **lifecycle hook → async worker processing → storage → context retrieval** pattern:

1. **6 Lifecycle Hooks** (`plugin/hooks/hooks.json`) fire at Claude Code lifecycle points (Setup, SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop). Each hook dispatches to the unified **Worker Service** through `bun-runner.js`, invoking subcommands: `context`, `session-init`, `observation`, `file-context`, `summarize`. The Setup-phase `version-check.js` is the only standalone hook.

2. **Worker Service** (`src/services/worker-service.ts`) — An Express HTTP API server running on a per-user port (default `37700 + uid % 100`, configurable via `CLAUDE_MEM_WORKER_PORT`). Managed by Bun as a long-running process. Handles all AI processing asynchronously (summarization via Claude Agent SDK). Built to `plugin/scripts/worker-service.cjs`.

3. **Data Access Layer (DAL)** (`src/services/database/`) — **Database-agnostic abstraction** supporting SQLite (default), MySQL, and PostgreSQL via the `DatabaseAdapter` interface.
   - `src/services/database/adapter.ts` — Core interfaces: `DatabaseAdapter`, `DatabaseConfig`, `MigrationStep`, factory function
   - `src/services/database/adapters/sqlite-adapter.ts` — SQLite adapter (wraps `bun:sqlite`)
   - `src/services/database/adapters/mysql-adapter.ts` — MySQL adapter (based on `mysql2/promise`)
   - `src/services/database/adapters/postgresql-adapter.ts` — PostgreSQL adapter (based on `pg`)
   - `src/services/database/DatabaseManager.ts` — Singleton manager replacing legacy `DatabaseManager`
   - `src/services/database/migrations/index.ts` — Cross-database migration system (dialect-aware SQL generation)
   - **Switch**: Set env var `CLAUDE_MEM_DB_TYPE=mysql|postgresql` (default `sqlite`) with connection params

4. **Legacy SQLite Layer** (`src/services/sqlite/`) — Preserved as backward-compat layer, delegates to DAL internally. New code should prefer `src/services/database/`.

5. **Vector Search** (`src/services/sync/ChromaSync.ts`) — Chroma vector embeddings for semantic search, enabling hybrid keyword+semantic queries.

5. **MCP Server** (`src/servers/mcp-server.ts`) — Exposes 3-layer search API (search → timeline → get_observations) following token-efficient progressive disclosure pattern.

6. **Context Generation** (`src/services/context/`) — Compiles observations for session injection. `ObservationCompiler` selects relevant memories, `ContextBuilder` builds the injection payload, `TokenCalculator` manages budget limits.

7. **Context Injection** — At SessionStart, relevant compressed context is injected into the Claude Code session so the AI has continuity of prior work.

### Source Structure

- `src/services/worker-service.ts` — **Main entry point** (~45KB). Express server with all HTTP routes, worker lifecycle management, and AI orchestration.
- **Data Access Layer (DAL) — NEW**:
  - `src/services/database/adapter.ts` — Core interfaces & types
  - `src/services/database/adapters/` — SQLite / MySQL / PostgreSQL adapter implementations
  - `src/services/database/DatabaseManager.ts` — Singleton database manager
  - `src/services/database/migrations/index.ts` — Dialect-aware migration definitions
- `src/services/context/` — Context compilation pipeline (selection, building, token calculation).
- `src/services/smart-file-read/` — Tree-sitter based code parser for intelligent file reading during observation capture.
- `src/services/sqlite/` — **Legacy** SQLite layer (delegates to DAL, kept for backward compat).
- `src/services/queue/` — Background job processing (SessionQueueProcessor using BullMQ).
- `src/services/domain/` — Mode/language management (ModeManager handles workflow modes like `code--zh`).
- `src/services/integrations/` — Installers for Cursor, Windsurf, Gemini CLI, OpenCode, OpenClaw, Codex.
- `src/services/infrastructure/` — Process management, health monitoring, graceful shutdown, cleanup migrations.
- `src/server/` — HTTP route handlers organized by domain (auth, mcp, routes, jobs, middleware, queue, services).
- `src/servers/mcp-server.ts` — Standalone MCP server implementation.
- `src/shared/` — Cross-cutting utilities: EnvManager, SettingsDefaultsManager, path resolution, worker utils, transcript parsing.
- `src/core/schemas/` — Zod schemas for data validation (agent-event, auth, memory-item, session, project).
- `src/cli/` — CLI entrypoints for hook commands, stdin reading, claude-md commands.
- `src/npx-cli/` — NPX installer/uninstaller CLI (the `npx claude-mem install` entry point).
- `src/adapters/` — Platform adapters (claude-code, generic-rest).
- `src/ui/viewer-template.html` — React-based web viewer UI served by worker at `http://127.0.0.1:<port>`.
- `plugin/` — **Built output directory**: hooks config, scripts (.cjs), skills (SKILL.md files), modes, UI, MCP manifest.
- `plugin/skills/` — Claude Code skills: mem-search, make-plan, do, timeline-report, troubleshoot, etc.
- `plugin/modes/` — Workflow mode definitions (language-specific behavior).

### Key Architectural Patterns

- **Database Abstraction Layer (DAL)**: Multi-database backend support via `DatabaseAdapter` interface. Env var `CLAUDE_MEM_DB_TYPE` selects type; `CLAUDE_MEM_DB_HOST/PORT/USER/PASSWORD/NAME` for connection. MySQL accepts URI via `CLAUDE_MEM_MYSQL_URL`; PostgreSQL via `CLAUDE_MEM_POSTGRES_URL`. Migration system auto-generates dialect-correct SQL.
- **Privacy tags**: `<private>...</private>` content is stripped at the hook edge before reaching worker/database (`src/utils/tag-stripping.ts`). Exit codes matter: 0=success/graceful, 1=non-blocking error, 2=blocking error fed to Claude.
- **Multi-account support**: All paths derive from `CLAUDE_MEM_DATA_DIR` env var. No CLI subcommand needed — just set the env var in your shell.
- **Settings**: Auto-created at `~/.claude-mem/settings.json`. See `src/shared/SettingsDefaultsManager.ts` for canonical defaults.
- **Pro features**: Clean separation — core endpoints remain fully open-source; Pro features are external/headless extensions that connect to same local APIs.

## Requirements

- **Bun** (runtime, test runner, process manager) — auto-installed if missing
- **uv** (Python package manager for Chroma) — auto-installed if missing
- **Node.js >= 20**
- **Optional database dependencies**:
  - SQLite (default): No extra deps (built into Bun)
  - MySQL: Requires `mysql2` (`npm install mysql2`)
  - PostgreSQL: Requires `pg` (`npm install pg`)
