# Vocab Agent

基于 Deno 和 SQLite 的本地英语词汇工具，通过 Agent Skills 完成添加词汇和分轮测试。

## 运行要求

- 在包含 `deno.jsonc` 的仓库根目录运行所有命令。
- 安装支持 `node:sqlite` 的 Deno 版本；当前开发和测试使用 Deno 2.9.3。
- 将 ECDICT 数据库手动复制到 `data/dict.db`。
- `data/vocab.db` 是本地个人数据，不提交到 Git；首次执行词库 task 时会自动创建。

## 环境模式

项目根目录的 `.agent-mode` 决定 Agent 的操作权限。该文件不提交到 Git，且只包含一个值：

```text
development
```

或者：

```text
runtime
```

- 开发电脑使用 `development`。普通词库操作仍受保护，只有明确的开发请求才允许修改项目。
- 运行电脑使用 `runtime`。`AGENTS.md` 会要求 Agent 只执行规定的词库 task，不修改代码或配置。
- 文件缺失、无法读取或内容不合法时，`AGENTS.md` 要求 Agent 默认使用 `runtime`。
- Agent 不允许创建、修改、删除 `.agent-mode` 或自行切换模式。

仓库提供 `.agent-mode.example`，其安全默认值为 `runtime`。部署到运行电脑时，在项目根目录创建内容为 `runtime` 的 `.agent-mode`；开发电脑使用 `development`。

`.agent-mode` 和 `AGENTS.md` 是清晰的 Agent 行为约定，不是操作系统安全沙箱。这个个人项目主要用它们避免日常词库操作意外进入开发流程。

## Skill 布局

`.agents/skills` 是 skill 的唯一真实来源：

```text
.agents/skills/
├── quiz-vocab-word/SKILL.md
└── vocab-add/SKILL.md
```

`.opencode/skills` 是指向 `../.agents/skills` 的相对软链接。Pi 原生发现
`.agents/skills`，OpenCode 继续通过 `.opencode/skills` 使用相同文件，避免维护两份内容。

## Pi

从仓库根目录启动 Pi。项目级 `.agents/skills` 只有在项目受信任后才会加载。

- 交互模式：按提示信任项目，或使用 `/trust` 保存决定，然后重启 Pi。
- 非交互模式：未持久信任时，每次调用都需要 `pi --approve ...`；也可以先在交互模式使用 `/trust`，重启后再运行非交互命令。
- 不要使用 `--no-skills` 或 `--no-context-files`，否则 skill 或 `AGENTS.md` 不会加载。

Pi 加载后应能看到：

```text
/skill:quiz-vocab-word
/skill:vocab-add
```

## OpenCode

OpenCode 通过 `.opencode/skills` 软链接发现同一组 skill。skill 结构变更后需要退出并重新启动 OpenCode。

## Task 与 Skill

| Task | Skill | 用途 |
|---|---|---|
| `quiz`, `answer`, `quiz-result` | `quiz-vocab-word` | 创建、继续和结算词汇测试 |
| `lookup`, `add`, `update` | `vocab-add` | 查询字典、添加和修改词汇 |
| `list` | 无 | 汇总词库，可能顺带执行数据库迁移和 session 清理 |

`delete` 当前不对 Agent 开放，因为它是破坏性操作且没有对应的 skill 工作流。
脚本只允许删除当前未被任何保留中 quiz session 引用的词条，以保护测试历史和进行中的 session。

## 开发检查

```bash
deno task check
deno task lint
deno task test
deno task fmt --check
```

测试使用临时 SQLite 数据库，不读取或修改 `data/vocab.db`。

## Session 清理

项目采用机会式定时清理，不需要常驻进程或系统 cron。除只访问 `dict.db` 的
`lookup` 外，其他打开 `vocab.db` 的词库命令都会检查清理时间，但最多每 24
小时实际扫描一次：

- 未完成 session 从创建时间起保留 7 天。
- 已完成 session 从最后答题时间起保留 30 天。
- 清理只删除 `quiz_sessions` 和对应的 `quiz_session_words`。
- 已经写入 `vocabulary_words` 的 score 不受影响。

上次清理时间保存在 `app_metadata` 表中。如果项目长期没有运行命令，清理会在下一次使用词库时执行。

## 数据文件

```text
data/dict.db   # 手动分发的只读 ECDICT 数据库
data/vocab.db  # 本地生成的个人词库和测试记录
```

部署到新机器时，需要在首次使用 `lookup` 或 `add` 前完成 `dict.db` 的手动复制。
`dict.db` 必须包含 `dictionary` 表，以及 `word`、`translation`、`pos` 三个字段。

更完整的目录、开发、部署和 Agent 工作原理说明见
[`docs/AGENT_PROJECT_GUIDE.md`](docs/AGENT_PROJECT_GUIDE.md)。
