# CODEBUDDY_zh.md 本文件为 CodeBuddy 在本仓库中工作时提供指导（中文版）。

## 项目概述

Claude-mem 是一个 **Claude Code 插件**，提供跨会话的持久化记忆能力。它捕获工具调用，通过 Claude Agent SDK 使用 AI 摘要压缩观察数据，并在后续会话中注入相关上下文。项目使用 TypeScript 编写，**Bun** 作为运行时和测试运行器，**Node.js** 用于 npm 操作。

## 常用命令

### 构建与开发
```bash
npm run build              # 同步插件清单 + 构建 hooks（无编译步骤；源码是 TS 但 hooks 通过 bun/eval 执行）
npm run build-and-sync     # 完整流水线：构建 → 同步 marketplace → 重启 worker（主要开发命令）
```

### 测试
```bash
bun test                   # 运行所有测试
bun test <文件路径>         # 运行单个测试文件，例如 bun tests/hook-lifecycle.test.ts
bun test tests/sqlite/     # 运行子目录下的测试（sqlite, agents, search, context, infra, server）
```

### 类型检查
```bash
tsc --noEmit               # 根项目类型检查
tsc --noEmit -p src/ui/viewer/tsconfig.json  # Viewer UI 类型检查
npm run typecheck          # 同时执行以上两项
```

### Worker 进程管理（本地开发）
```bash
bun plugin/scripts/worker-service.cjs start|stop|restart|status
npm run worker:logs        # 查看最近的 worker 日志
```

### 其他实用命令
```bash
npm run queue              # 查看待处理的任务队列
npm run queue:process      # 处理队列中的任务
npm run bug-report         # 生成结构化的 bug 报告
```

## 架构

### 数据流：Hook → Worker → 数据库 → 上下文注入

系统遵循 **生命周期钩子 → 异步 Worker 处理 → 存储 → 上下文检索** 的模式：

1. **6 个生命周期钩子** (`plugin/hooks/hooks.json`) 在 Claude Code 各生命周期节点触发（Setup、SessionStart、UserPromptSubmit、PreToolUse、PostToolUse、Stop）。每个钩子通过 `bun-runner.js` 分发到统一的 **Worker Service**，调用子命令：`context`、`session-init`、`observation`、`file-context`、`summarize`。Setup 阶段的 `version-check.js` 是唯一独立的钩子脚本。

2. **Worker Service** (`src/services/worker-service.ts`) — Express HTTP API 服务器，运行在每用户独立端口上（默认 `37700 + uid % 100`，可通过 `CLAUDE_MEM_WORKER_PORT` 配置）。由 Bun 管理为长驻进程，异步处理所有 AI 处理（通过 Claude Agent SDK 进行摘要）。构建输出为 `plugin/scripts/worker-service.cjs`。

3. **数据访问层（DAL）** (`src/services/database/`) — **数据库无关的抽象层**，支持 SQLite（默认）、MySQL、PostgreSQL。通过 `DatabaseAdapter` 接口统一所有数据库操作。
   - `src/services/database/adapter.ts` — 核心接口定义：`DatabaseAdapter`、`DatabaseConfig`、`MigrationStep`、工厂函数
   - `src/services/database/adapters/sqlite-adapter.ts` — SQLite 适配器（包装 `bun:sqlite`）
   - `src/services/database/adapters/mysql-adapter.ts` — MySQL 适配器（基于 `mysql2/promise`）
   - `src/services/database/adapters/postgresql-adapter.ts` — PostgreSQL 适配器（基于 `pg`）
   - `src/services/database/DatabaseManager.ts` — 单例管理器，替代原有 `DatabaseManager`
   - `src/services/database/migrations/index.ts` — 跨数据库迁移系统（方言感知 SQL 生成）
   - **切换方式**：设置环境变量 `CLAUDE_MEM_DB_TYPE=mysql|postgresql`（默认 `sqlite`），配合连接参数即可

4. **旧 SQLite 层** (`src/services/sqlite/`) — 已保留为向后兼容层，内部委托给 DAL。新代码应优先使用 `src/services/database/`。

5. **向量搜索** (`src/services/sync/ChromaSync.ts`) — Chroma 向量嵌入用于语义搜索，支持关键词+语义混合查询。

5. **MCP Server** (`src/servers/mcp-server.ts`) — 暴露三层搜索 API（search → timeline → get_observations），遵循 token 高效的渐进式披露模式。

6. **上下文生成** (`src/services/context/`) — 编译观察记录用于会话注入。`ObservationCompiler` 选择相关记忆，`ContextBuilder` 构建注入载荷，`TokenCalculator` 管理 token 预算限制。

7. **上下文注入** — SessionStart 时将相关压缩上下文注入 Claude Code 会话，使 AI 获得先前工作的连续性。

### 源码结构

- `src/services/worker-service.ts` — **主入口点**（约 45KB）。Express 服务器，包含所有 HTTP 路由、Worker 生命周期管理和 AI 编排。
- **数据访问层（DAL）— 新增**：
  - `src/services/database/adapter.ts` — 核心接口与类型
  - `src/services/database/adapters/` — SQLite / MySQL / PostgreSQL 适配器实现
  - `src/services/database/DatabaseManager.ts` — 单例数据库管理器
  - `src/services/database/migrations/index.ts` — 方言感知的迁移定义
- `src/services/context/` — 上下文编译管线（选择、构建、token 计算）。
- `src/services/smart-file-read/` — 基于 Tree-sitter 的代码解析器，用于观察捕获期间的智能文件读取。
- `src/services/sqlite/` — **旧版** SQLite 层（已委托给 DAL，保留向后兼容）。
- `src/services/queue/` — 后台任务处理（使用 BullMQ 的 SessionQueueProcessor）。
- `src/services/domain/` — 模式/语言管理（ModeManager 处理如 `code--zh` 等工作流模式）。
- `src/services/integrations/` — Cursor、Windsurf、Gemini CLI、OpenCode、OpenClaw、Codex 的安装器。
- `src/services/infrastructure/` — 进程管理、健康监控、优雅关闭、清理迁移。
- `src/server/` — 按领域分组的 HTTP 路由处理器（auth, mcp, routes, jobs, middleware, queue, services）。
- `src/servers/mcp-server.ts` — 独立的 MCP Server 实现。
- `src/shared/` — 跨层公共工具：EnvManager、SettingsDefaultsManager、路径解析、worker 工具、转录解析。
- `src/core/schemas/` — Zod 数据校验 schema（agent-event、auth、memory-item、session、project）。
- `src/cli/` — 钩子命令、stdin 读取、claude-md 命令的 CLI 入口。
- `src/npx-cli/` — NPX 安装/卸载 CLI（即 `npx claude-mem install` 的入口）。
- `src/adapters/` — 平台适配器（claude-code、generic-rest）。
- `src/ui/viewer-template.html` — Worker 提供的 React Web 查看器 UI，访问地址 `http://127.0.0.1:<端口>`。
- `plugin/` — **构建输出目录**：hooks 配置、脚本（.cjs）、技能（SKILL.md 文件）、模式定义、UI、MCP 清单。
- `plugin/skills/` — Claude Code 技能：mem-search、make-plan、do、timeline-report、troubleshoot 等。
- `plugin/modes/` — 工作流模式定义（特定语言行为）。

### 关键架构模式

- **数据库抽象层（DAL）**：通过 `DatabaseAdapter` 接口支持多数据库后端。环境变量 `CLAUDE_MEM_DB_TYPE` 控制类型，`CLAUDE_MEM_DB_HOST/PORT/USER/PASSWORD/NAME` 控制连接。MySQL 可通过 `CLAUDE_MEM_MYSQL_URL` 传 URI；PostgreSQL 通过 `CLAUDE_MEM_POSTGRES_URL`。迁移系统自动生成各数据库方言的正确 SQL。
- **隐私标签**：`<private>...</private>` 内容在钩子边缘被剥离，不会到达 worker/数据库（`src/utils/tag-stripping.ts`）。退出码约定：0=成功/优雅关闭，1=非阻塞错误，2=阻塞错误（交给 Claude 处理）。
- **多账号支持**：所有路径均派生自 `CLAUDE_MEM_DATA_DIR` 环境变量，无需额外 CLI 子命令——只需在 shell 中设置该变量即可切换配置。
- **设置文件**：自动创建于 `~/.claude-mem/settings.json`，默认值见 `src/shared/SettingsDefaultsManager.ts`。
- **Pro 功能**：清晰的分离设计——核心端点完全开源；Pro 功能作为外部无头扩展连接同一套本地 API。

## 环境依赖

- **Bun**（运行时、测试运行器、进程管理器）— 缺失时自动安装
- **uv**（Chroma 所需的 Python 包管理器）— 缺失时自动安装
- **Node.js >= 20**
- **可选数据库依赖**：
  - SQLite（默认）：无需额外依赖（Bun 内置）
  - MySQL：需安装 `mysql2`（`npm install mysql2`）
  - PostgreSQL：需安装 `pg`（`npm install pg`）
