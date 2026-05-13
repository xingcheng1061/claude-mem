# Database Configuration Guide

Claude-Mem uses a **Database Abstraction Layer (DAL)** that supports SQLite, MySQL, and PostgreSQL. Switch between databases via environment variables — no code changes required.

## Quick Reference

| Database | Default | Dependency | Config Variable |
|----------|---------|------------|-----------------|
| **SQLite** | Yes | Built into Bun | (none) |
| **MySQL** | No | `mysql2` | `CLAUDE_MEM_DB_TYPE=mysql` |
| **PostgreSQL** | No | `pg` | `CLAUDE_MEM_DB_TYPE=postgresql` |

---

## 1. SQLite (Default)

SQLite is the default backend — zero configuration, bundled with Bun runtime.

### Configuration

```bash
# Optional: custom database file path
export CLAUDE_MEM_SQLITE_PATH="/path/to/custom.db"

# Optional: data directory (default: ~/.claude-mem/)
export CLAUDE_MEM_DATA_DIR="/custom/data/dir"
```

### Notes

- No additional npm packages needed
- Database file stored at `~/.claude-mem/claude-mem.db` by default
- Uses `bun:sqlite` for optimal performance on Bun runtime
- Supports FTS5 full-text search natively

---

## 2. MySQL

MySQL is suitable for production deployments or when you need remote/centralized storage.

### Prerequisites

```bash
npm install mysql2
```

> `mysql2` is listed in `optionalDependencies`. Run `npm install` (without `--ignore-scripts`) to install it, or use `npm install mysql2` explicitly.

### Connection Methods

#### Method A: Connection URL (Recommended)

```bash
export CLAUDE_MEM_DB_TYPE=mysql
export CLAUDE_MEM_MYSQL_URL="mysql://user:password@host:3306/claude_mem"
```

#### Method B: Individual Parameters

```bash
export CLAUDE_MEM_DB_TYPE=mysql
export CLAUDE_MEM_DB_HOST=127.0.0.1        # default: 127.0.0.1
export CLAUDE_MEM_DB_PORT=3306             # default: 3306
export CLAUDE_MEM_DB_USER=root             # default: root
export CLAUDE_MEM_DB_PASSWORD=your_password # default: (empty)
export CLAUDE_MEM_DB_NAME=claude_mem       # default: claude_mem
```

#### Method C: DATABASE_URL Fallback

If `CLAUDE_MEM_MYSQL_URL` is not set, the system falls back to `DATABASE_URL`:

```bash
export DATABASE_URL="mysql://user:password@host:3306/claude_mem"
```

### Additional Options

```bash
# Connection pool size (default: 10)
export CLAUDE_MEM_DB_POOL_SIZE=20

# Enable SQL debug logging
export CLAUDE_MEM_DB_DEBUG=true
```

### Setup Example (Complete)

```bash
# 1. Install dependency
npm install mysql2

# 2. Set environment variables
export CLAUDE_MEM_DB_TYPE=mysql
export CLAUDE_MEM_MYSQL_URL="mysql://root:password@localhost:3306/claude_mem"

# 3. Create database (if not exists)
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS claude_mem CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

# 4. Restart worker / Claude Code
npm run worker:restart
```

---

## 3. PostgreSQL

PostgreSQL is ideal for high-concurrency production environments.

### Prerequisites

```bash
npm install pg
```

> `pg` is already in `dependencies`. No extra installation needed if you've run `npm install`.

### Connection Methods

#### Method A: Connection String (Recommended)

```bash
export CLAUDE_MEM_DB_TYPE=postgresql
export CLAUDE_MEM_POSTGRES_URL="postgresql://user:password@host:5432/claude_mem"
```

#### Method B: Individual Parameters

```bash
export CLAUDE_MEM_DB_TYPE=postgresql
export CLAUDE_MEM_DB_HOST=127.0.0.1        # default: 127.0.0.1
export CLAUDE_MEM_DB_PORT=5432             # default: 5432
export CLAUDE_MEM_DB_USER=postgres         # default: postgres
export CLAUDE_MEM_DB_PASSWORD=your_password # default: (empty)
export CLAUDE_MEM_DB_NAME=claude_mem       # default: claude_mem
```

#### Method C: DATABASE_URL Fallback

```bash
export DATABASE_URL="postgresql://user:password@host:5432/claude_mem"
```

### Additional Options

Same as MySQL (`CLAUDE_MEM_DB_POOL_SIZE`, `CLAUDE_MEM_DB_DEBUG`).

### Setup Example (Complete)

```bash
# 1. Install dependency (already in dependencies, but ensure it's installed)
npm install pg

# 2. Set environment variables
export CLAUDE_MEM_DB_TYPE=postgresql
export CLAUDE_MEM_POSTGRES_URL="postgres://postgres:password@localhost:5432/claude_mem"

# 3. Create database (if not exists)
psql -U postgres -c "CREATE DATABASE claude_mem;"

# 4. Restart worker / Claude Code
npm run worker:restart
```

---

## Architecture Overview

### How It Works

```
┌──────────────┐     ┌─────────────────────┐     ┌────────────┐
│   Hook /     │────▶│   Worker Service    │────▶│  Database  │
│   CLI Code   │ HTTP│  (Express + Bun)    │ DAL │  Adapter   │
└──────────────┘     └─────────────────────┘     └────────────┘
                            │
                     ┌──────┴──────┐
                     │ SqlExecutor  │ ← sync/async bridge
                     │ (deasync)   │
                     └─────────────┘
```

**Key Components:**

1. **`DatabaseAdapter` interface** (`src/services/database/adapter.ts`) — Defines the contract all databases must implement: `query()`, `execute()`, `withTransaction()`, etc.

2. **Concrete Adapters:**
   - `sqlite-adapter.ts` — Wraps `bun:sqlite`
   - `mysql-adapter.ts` — Wraps `mysql2/promise` with connection pooling
   - `postgresql-adapter.ts` — Wraps `pg` with connection pooling

3. **`DatabaseManager`** (`src/services/database/DatabaseManager.ts`) — Singleton that reads env vars, selects adapter, runs migrations, manages lifecycle.

4. **Migration System** (`src/services/database/migrations/index.ts`) — Versioned, dialect-aware migrations that auto-generate correct SQL for each database type.

5. **`SqlExecutor`** (`src/services/database/SqlExecutor.ts`) — Synchronous bridge using `deasync` to allow legacy sync code to call async DB adapters transparently.

### Migration System

Migrations are defined once and automatically adapted per-database:

- **Primary keys**: SQLite uses `INTEGER PRIMARY KEY AUTOINCREMENT`, MySQL uses `INT AUTO_INCREMENT`, PostgreSQL uses `SERIAL`
- **Parameter styles**: SQLite/MySQL use `?`, PostgreSQL uses `$1, $2, ...`
- **FTS support**: SQLite has native FTS5; MySQL/PostgreSQL use alternative search strategies

Migrations run automatically on first startup. The system tracks applied versions in the `schema_versions` table and only runs pending migrations.

---

## Environment Variable Summary

| Variable | Description | Default |
|----------|-------------|---------|
| `CLAUDE_MEM_DB_TYPE` | Database type: `sqlite`, `mysql`, `postgresql` | `sqlite` |
| `CLAUDE_MEM_SQLITE_PATH` | Custom SQLite database file path | auto-generated |
| `CLAUDE_MEM_MYSQL_URL` | MySQL connection URL (takes priority over individual params) | — |
| `CLAUDE_MEM_POSTGRES_URL` | PostgreSQL connection string (takes priority) | — |
| `DATABASE_URL` | Generic fallback connection URL | — |
| `CLAUDE_MEM_DB_HOST` | Server host (MySQL/PostgreSQL) | `127.0.0.1` |
| `CLAUDE_MEM_DB_PORT` | Server port (MySQL/PostgreSQL) | `3306` (MySQL) / `5432` (PG) |
| `CLAUDE_MEM_DB_USER` | Database user | `root` (MySQL) / `postgres` (PG) |
| `CLAUDE_MEM_DB_PASSWORD` | Database password | (empty) |
| `CLAUDE_MEM_DB_NAME` | Database name | `claude_mem` |
| `CLAUDE_MEM_DATA_DIR` | Data directory root | `~/.claude-mem/` |
| `CLAUDE_MEM_DB_POOL_SIZE` | Connection pool size | `10` |
| `CLAUDE_MEM_DB_DEBUG` | Enable SQL debug logging | `false` |

---

## Multi-Account Support

All paths and connections derive from `CLAUDE_MEM_DATA_DIR`. To run multiple independent instances:

```bash
# Instance 1
export CLAUDE_MEM_DATA_DIR=~/.claude-mem-instance1
export CLAUDE_MEM_DB_TYPE=mysql
export CLAUDE_MEM_MYSQL_URL="mysql://user:pass@host:3306/instance1_db"

# Instance 2
export CLAUDE_MEM_DATA_DIR=~/.claude-mem-instance2
export CLAUDE_MEM_DB_TYPE=postgresql
export CLAUDE_MEM_POSTGRES_URL="postgres://user:pass@host:5432/instance2_db"
```

Each instance gets its own data directory, database, settings, and worker process.

---

## Troubleshooting

### "Cannot find module 'mysql2'"

Run `npm install mysql2` or `npm install` (the package is in `optionalDependencies`).

### "Cannot find module 'pg'"

Run `npm install pg` or `npm install` (already in `dependencies`, should be present).

### "Cannot find module 'deasync'"

Run `npm install deasync`. If postinstall fails due to `tree-sitter-cli` timeout, use:
```bash
npm install deasync --ignore-scripts
```
The precompiled binary for your platform is typically included in the package.

### Migration fails on MySQL/PostgreSQL

Ensure the target database exists before starting:
```bash
# MySQL
mysql -e "CREATE DATABASE IF NOT EXISTS claude_mem;"

# PostgreSQL
psql -c "CREATE DATABASE claude_mem;"
```

### Connection refused

Verify the database server is running and the host/port are correct:
```bash
# Check MySQL
mysql -h 127.0.0.1 -P 3306 -u root -p -e "SELECT 1"

# Check PostgreSQL
psql -h 127.0.0.1 -P 5432 -U postgres -c "SELECT 1"
```
