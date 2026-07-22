# 环境模式

执行任何项目操作前，必须先读取项目根目录的 `.agent-mode`，去除首尾空白后判断模式。

只接受以下值：

- `development`
- `runtime`

如果 `.agent-mode` 不存在、无法读取、内容为空或值不合法，必须按 `runtime` 模式处理。
禁止智能体创建、修改或删除 `.agent-mode`，也不得自行切换模式。

## Runtime 模式

当模式为 `runtime` 时：

1. 禁止修改源代码、配置、文档、skill 和 `AGENTS.md`。
2. 只允许按照下方词库工作流执行规定的 `deno task`。
3. 命令失败时停止操作并如实报告，不得尝试修改代码。
4. 禁止执行 Git 操作、安装依赖、修改文件权限或创建开发文件。

## Development 模式

当模式为 `development` 时：

1. 普通添加、查询、复习和测试词汇时，仍按照 Runtime 模式和词库工作流操作。
2. 只有用户明确要求开发、修复、重构、测试或修改项目时，才允许修改代码、配置、文档和 skill。
3. 明确的开发任务可以执行 Git 查询以及项目的检查、测试和格式化命令。
4. 不得因为普通词库命令报错而自行进入开发流程。

# 词库工作流

1. 只通过 `deno task` 执行词库操作。允许的 task 为：
   `quiz / answer / quiz-result / add / update / lookup / list`。
   当前禁止执行 `delete`，因为它是破坏性操作且没有对应的 skill 工作流。
2. 执行会改变或读取词库工作流的 task 前，必须使用当前智能体的标准
   skill 加载机制读取对应 `SKILL.md` 的完整内容。Pi 会自动发现
   `.agents/skills`，可使用 `read` 或 `/skill:<name>`；OpenCode 通过
   `.opencode/skills` 软链接加载同一组 skill。
3. task 与 skill 的映射如下：
   - `quiz / answer / quiz-result` → `quiz-vocab-word`
   - `lookup / add / update` → `vocab-add`
   - `list` 是无独立 skill 的汇总命令，可直接执行；打开数据库时可能触发迁移和 session 清理
4. 必须严格按照 skill 中的命令格式执行，不得凭经验或记忆自行构造命令。
5. 普通词库操作中如果发现代码问题，不要自行修改，直接向用户报告。
