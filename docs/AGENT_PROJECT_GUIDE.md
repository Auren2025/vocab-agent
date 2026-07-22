# 智能体项目开发与运行指南

这份文档用当前 Vocab Agent 项目说明一个智能体项目如何被开发工具修改，又如何被运行工具使用。目标不是建立复杂的平台框架，而是让每一层职责清楚、可验证、容易维护。

## 1. 核心心智模型

这个项目可以分成五层：

| 层 | 项目中的内容 | 职责 |
|---|---|---|
| 智能体宿主 | OpenCode、Pi | 理解用户意图，读取规则和 skill，调用工具 |
| 项目规则 | `AGENTS.md`、`.agent-mode` | 规定当前机器允许智能体做什么 |
| 工作流 | `.agents/skills/*/SKILL.md` | 规定某类用户请求应该按什么步骤完成 |
| 应用接口 | `deno.jsonc` 中的 task | 给智能体提供稳定、有限、可重复的命令入口 |
| 业务与数据 | `scripts/vocab.ts`、`data/*.db` | 实现词库、测试、评分和清理逻辑 |

智能体不应该绕过上层接口直接操作底层数据。正常运行链路是：

```text
用户请求
  -> OpenCode 或 Pi
  -> 读取 AGENTS.md 和 .agent-mode
  -> 匹配并加载 SKILL.md
  -> 执行 deno task
  -> scripts/vocab.ts
  -> SQLite 数据库
```

开发链路则不同：

```text
明确的开发请求
  -> OpenCode
  -> development 模式
  -> 阅读和修改代码、skill、文档
  -> check / lint / test / fmt
  -> 部署到运行电脑
```

## 2. 最终目录结构

```text
vocab-agent/
├── .agent-mode                 # 本机角色，不提交
├── .agent-mode.example         # 提交的安全默认示例：runtime
├── .agents/
│   └── skills/                 # skill 的唯一真实来源
│       ├── quiz-vocab-word/
│       │   └── SKILL.md
│       └── vocab-add/
│           └── SKILL.md
├── .opencode/
│   └── skills -> ../.agents/skills
├── data/
│   ├── dict.db                 # 手动部署，不提交
│   └── vocab.db                # 每台运行机器自己的数据，不提交
├── docs/
│   └── AGENT_PROJECT_GUIDE.md
├── scripts/
│   └── vocab.ts                # 业务实现和 CLI
├── tests/
│   └── vocab_test.ts           # 使用临时数据库的回归测试
├── AGENTS.md                   # OpenCode 和 Pi 共用的项目规则
├── README.md                   # 安装、运行和维护入口
└── deno.jsonc                  # task、权限和 TypeScript 配置
```

### 为什么 skill 放在 `.agents/skills`

`.agents/skills` 是 Pi 原生支持的项目级 Agent Skills 路径，也表达了这些 skill 属于项目本身，而不是某一个工具。

项目不在 `.agents/skills` 和 `.opencode/skills` 各维护一份文件。两份真实文件迟早会产生内容差异，智能体会因运行平台不同而执行不同流程。

### 为什么保留 `.opencode/skills` 软链接

开发环境使用 OpenCode。软链接把 OpenCode 的项目 skill 发现路径连接到共享来源：

```text
.opencode/skills -> ../.agents/skills
```

这样有三个结果：

1. 修改 `.agents/skills` 后，OpenCode 和 Pi 得到同一份内容。
2. `.opencode` 只承担开发工具适配，不保存业务规则副本。
3. Pi 不需要额外的 `.pi/settings.json` 来引用 OpenCode 目录。

软链接必须和 `.agents/skills` 一起提交。Git 中软链接的文件模式应为 `120000`。

## 3. `.agent-mode` 的作用

`.agent-mode` 表示当前机器扮演什么角色。

开发电脑：

```text
development
```

运行电脑：

```text
runtime
```

它不提交到 Git，因此同一份项目代码可以在两台电脑上采用不同模式。缺失或非法时，`AGENTS.md` 要求使用更安全的 `runtime`。

这个机制是行为约定，不是操作系统权限系统。它的目标是避免一般误操作：例如女儿要求测试单词时，Pi 不应该因为命令报错就开始修改 TypeScript；你明确要求修复项目时，OpenCode 又不能被永久锁在只读状态。

## 4. `AGENTS.md` 与 Skill 的区别

### `AGENTS.md`

`AGENTS.md` 是项目级总规则，回答以下问题：

- 当前是开发环境还是运行环境？
- 普通词库操作允许执行哪些 task？
- 什么情况下可以修改代码？
- 每个 task 应加载哪个 skill？
- 命令失败时应该修复还是报告？

它应该保持短小、稳定，不要塞入完整业务流程。

### `SKILL.md`

Skill 是按需加载的工作流，回答以下问题：

- 什么用户意图会触发这个能力？
- 应该按什么顺序调用 task？
- 如何保存中间状态？
- 如何解释 JSON 结果？
- 最终如何回复用户？
- 哪些行为容易出错，必须禁止？

当前项目有两个工作流：

| Skill | 覆盖的 task | 用户意图 |
|---|---|---|
| `vocab-add` | `lookup`, `add`, `update` | 添加单词、短语或修改释义 |
| `quiz-vocab-word` | `quiz`, `answer`, `quiz-result` | 开始、继续和结算词汇测试 |

`list` 只有一个简单命令，目前不需要独立 skill。它打开数据库时可能触发迁移和 session 清理，所以不是严格的数据库只读操作，但不会修改词汇内容或 score。

## 5. Skill 的设计方法

一个清晰的 skill 至少包含以下内容：

1. `name`：稳定、简短，并与目录名一致。
2. `description`：同时说明做什么和什么时候触发。
3. 命令契约：只使用公开 task，不直接操作脚本或数据库。
4. 顺序约束：例如添加前先查字典，下一轮测试必须复用 session。
5. 状态说明：明确哪些返回字段需要记住。
6. 输出规则：明确哪些内容直接展示，哪些内容不能提前泄露。
7. 失败规则：命令失败时停止，不能编造成功结果。

Skill 不应该重新实现业务逻辑。例如 score 的更新公式虽然可以写在 skill 中帮助理解，但真正的更新必须由 `deno task answer` 完成。这样即使智能体理解有偏差，数据库仍由程序控制。

动态文本必须作为单个 shell 参数传递。短语、释义和用户原始答案都可能包含空格或引号；如果参数边界错误，脚本会收到错误数量的参数并拒绝执行。

## 6. OpenCode 与 Pi 的共性

OpenCode 和 Pi 在这个项目中采用相同的基本工作方式：

| 共性 | 说明 |
|---|---|
| 项目上下文 | 都可以读取 `AGENTS.md` 理解项目规则 |
| 渐进加载 | 都先看到 skill 的名称和描述，需要时再读取完整内容 |
| 工具调用 | 都由模型决定何时读取文件、运行命令和回复用户 |
| Agent Skills | 都使用带 frontmatter 的 `SKILL.md` 描述工作流 |
| 不确定性 | 规则是给模型的约定，清晰和重复验证比隐含假设可靠 |
| 稳定接口 | 都适合通过 `deno task` 使用项目，而不是直接修改 SQLite |

因此，共享的内容应放在工具中立的位置：

- `AGENTS.md`
- `.agents/skills`
- `deno.jsonc`
- `scripts` 和 `tests`

## 7. OpenCode 与 Pi 的区别

| 方面 | OpenCode 开发环境 | Pi 运行环境 |
|---|---|---|
| 主要任务 | 阅读、修改、测试和审阅项目 | 根据 skill 完成日常词库操作 |
| 本机模式 | `development` | `runtime` |
| Skill 接入 | `.opencode/skills` 软链接 | 原生发现 `.agents/skills` |
| 项目 trust | 遵循 OpenCode 自身权限配置 | 项目级 skill 需要 Pi trust |
| 配置目录 | `.opencode` | `.pi`，本项目目前不需要项目级 Pi 配置 |
| 修改代码 | 明确开发请求时允许 | 项目规则禁止 |
| 失败处理 | 明确开发任务中可以诊断和修复 | 报告错误，等待开发环境修复 |

Pi 的非交互 `--approve` 只对当前调用生效。若需要持久信任，应先在交互模式使用 `/trust`，然后重启 Pi。

OpenCode 或 Pi 在启动时加载 skill 和上下文。修改 `AGENTS.md` 或 skill 后，最好重启对应工具；Pi 也可以按其能力重新加载项目资源。

## 8. 开发环境工作流

开发电脑的推荐流程：

1. 确认 `.agent-mode` 内容为 `development`。
2. 从项目根目录启动 OpenCode。
3. 明确说明这是开发任务，例如“修复并发添加重复词的问题”。
4. 让 OpenCode 先阅读当前代码和测试，再修改文件。
5. 执行完整检查：

```bash
deno task check
deno task lint
deno task test
deno task fmt --check
git diff --check
```

6. 审阅 Git 状态，确保新文件和软链接都包含在提交中。
7. 提交并部署同一个 Git 快照，不要只复制某几个修改过的文件。

测试会把 `scripts/vocab.ts` 复制到临时项目，并使用临时 SQLite 数据库，不会操作真实的 `data/vocab.db`。

## 9. 运行环境工作流

运行电脑的推荐部署顺序：

1. 获取已经通过测试的完整 Git 快照。
2. 在项目根目录创建 `.agent-mode`，内容为 `runtime`。
3. 手动复制 `data/dict.db`。
4. 保留或恢复该电脑自己的 `data/vocab.db`，不要用开发电脑的数据覆盖。
5. 从项目根目录启动 Pi。
6. 在交互模式确认项目 trust，并重启 Pi。
7. 确认 `/skill:vocab-add` 和 `/skill:quiz-vocab-word` 可用。
8. 使用一个普通单词做添加或查询验收，再开始日常使用。

`dict.db` 是共享的只读字典，`vocab.db` 是个人状态。代码可以覆盖部署，个人数据库不能跟着代码部署覆盖。

## 10. 数据库与 Session 生命周期

`vocabulary_words` 保存长期数据和 score。Quiz session 保存一次测试的固定题目、进度和用户答案。

Session 不需要永久保留：

- 未完成 session 保留 7 天。
- 已完成 session 从最后答题时间起保留 30 天。
- 除只访问 `dict.db` 的 `lookup` 外，其他打开 `vocab.db` 的词库命令会检查清理时间。
- 实际扫描最多每 24 小时一次。
- 清理 session 不影响已经写入词汇表的 score。

数据库 schema 使用 `PRAGMA user_version` 管理。旧版本由程序迁移；如果数据库版本高于当前程序支持版本，程序拒绝运行，避免旧代码写入新结构。

## 11. 如何判断逻辑应该放在哪里

使用下面的判断顺序：

| 问题 | 应放置的位置 |
|---|---|
| “运行环境禁止修改代码” | `AGENTS.md` 和 `.agent-mode` |
| “添加单词前必须查字典” | `vocab-add/SKILL.md` |
| “答对后 score 加 1” | `scripts/vocab.ts`，skill 只做说明 |
| “命令叫什么、需要什么权限” | `deno.jsonc` |
| “这个 bug 以后不能再出现” | `tests/vocab_test.ts` |
| “为什么这样组织目录” | `docs/AGENT_PROJECT_GUIDE.md` |

经验原则：规则放在最接近它真正能够被强制执行的层。重要数据约束应由代码和数据库保证，不能只写在 prompt 或 skill 中。

## 12. 常见误区

### 把 skill 当成程序

Skill 是给智能体的操作说明，不是业务实现。关键数据规则仍需代码和测试保证。

### 为每个平台复制一套 skill

复制会产生漂移。应维护一个共享来源，再使用平台发现路径或配置接入。

### 把 `AGENTS.md` 当成安全沙箱

它是行为规则，不是系统权限。这个项目用它防止一般误操作已经足够，但不应把它理解为对恶意输入的绝对隔离。

### 让 Agent 直接访问 SQLite

直接访问会绕过迁移、事务、score 规则和 session 完整性检查。正常词库操作只使用 `deno task`。

### 开发和运行使用不同代码快照

如果运行电脑只复制部分文件，skill、脚本和文档可能不匹配。应部署完整、已测试的 Git 快照，同时单独保留运行数据。

## 13. 修改项目时的检查清单

修改业务代码时：

- 是否需要增加数据库迁移版本？
- 是否会影响已有 `vocab.db`？
- 是否需要增加回归测试？
- task 参数是否仍与 skill 一致？

修改 skill 时：

- `name` 是否与目录一致？
- `description` 是否包含明确触发条件？
- OpenCode 和 Pi 是否读取同一真实文件？
- 命令是否只使用 `deno task`？
- 动态参数是否保持为单个 shell 参数？

部署前：

- 所有检查是否通过？
- `.agents/skills` 是否已经提交？
- `.opencode/skills` 是否仍是正确的相对软链接？
- 运行电脑的 `.agent-mode` 是否为 `runtime`？
- `dict.db` 是否存在且包含 `dictionary(word, translation, pos)`？
- 是否保留了运行电脑原有的 `vocab.db`？

## 14. 当前项目的设计边界

这是一个家庭内部使用的个人项目，因此采用以下取舍：

- 使用行为规则避免一般误操作，不建设复杂沙箱。
- 使用 SQLite 和本地文件，不引入服务端。
- 使用机会式 session 清理，不运行后台守护进程。
- 保持两个聚焦的 skill，不为简单命令过度拆分。
- 把数据一致性放在事务、唯一索引、迁移和测试中保证。

这套结构的重点不是“支持所有智能体平台”，而是明确区分共享项目能力、OpenCode 开发适配和 Pi 运行适配。理解这三层之后，未来增加新的智能体工具时，只需要增加一层很薄的发现或配置适配，不需要复制业务代码和 skill。
