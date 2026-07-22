---
name: vocab-add
description: >
  用于向英语词汇数据库添加新单词,或修改已有单词的释义。当用户说"加入 apple"、
  "添加 book, light"、"记一下这几个单词"、"这个单词加到词库"等任何要求把
  英文单词存入个人词汇表的请求时,都应使用此技能。如果用户表示想修改某个已有
  单词的释义（例如"改一下 run 的意思"、"更新一下 build"）,也应触发此技能。
  即使用户没有明确说"添加"或"vocab",只要意图是把单词存进数据库就触发。
  仅使用 deno.jsonc 中定义的 task 操作词库,不直接调用脚本或数据库。
compatibility: Requires Deno and data/dict.db; run from the vocab-agent repository root.
---

# 添加词汇

## 使用场景

用户要求把英文单词加入词汇数据库时使用,例如"加入 apple"、"添加 book, light"、
"记一下 run 这个词"。

## 执行命令

在包含 `deno.jsonc` 的项目根目录运行。不要从 skill 目录运行命令:

```bash
deno task lookup 'apple'
deno task add 'run' 'v. 跑；运行；经营
n. 跑步；一段连续时间'
```

- `deno task lookup <word>` — 从 ECDICT 本地词库查询释义，返回 JSON
- `deno task add <word> "<meaning>"` — 将单词存入个人词库
- `deno task update <word> "<meaning>"` — 修改已有单词的释义

word 和 meaning 必须各自作为一个完整的 shell 参数传入。所有动态文本优先使用
POSIX 单引号；文本本身含单引号时，先结束单引号、写入转义后的单引号，再重新开始。
例如 `don't` 应传为 `'don'\''t'`。不要把用户文本不加引号地拼进命令。
多行内容可以直接放在同一对引号内，shell 会保留换行符。

脚本会返回 JSON:

| 字段 | 含义 |
|---|---|
| `action: "created"` | 添加成功(新词) |
| `action: "exists"` | 已存在于数据库中,未做修改 |
| `action: "updated"` | 修改成功(已有词) |
| `ok: false` | 失败,如实报告错误,不要谎称成功 |

**只使用 `deno.jsonc` 中定义的 task 操作词库**。不要直接调用 `scripts/vocab.ts`,
也不要用 Python/SQLite 处理正常的增/查/改流程。

## meaning 生成规则

**优先查字典：** 调用 `deno task lookup <word>` 查询 ECDICT 词典。如果返回 `ok: true`，用字典的 `translation` 和 `pos` 字段作为释义来源。

`data/dict.db` 由项目维护者手动复制部署。如果文件缺失或字典表不可用,停止操作并如实报告,不要创建替代字典或调用外部 API。

**回退规则：** 如果查不到（返回 `ok: false`），再由 AI 自行生成释义。

**格式化规则（无论来源）：**

- 使用简洁中文,面向中国英语学习者。
- 标注常见词性:`n.` `v.` `adj.` `adv.` `prep.` `conj.` `pron.` `phr.` `abbr.`
- 每个常见词性占一行。
- 每行给出 2–4 个常见释义。
- 不包含例句、音标、近义词、反义词、词源。
- 只保留常见义项,避免生僻用法。

示例(run):
v. 跑；运行；经营
n. 跑步；一段连续时间

## 处理流程

1. 从用户消息中提取英文单词(可能是多个)。
2. 保留用户书写的大小写。专有名词和缩写（如 iPhone, SDK）保持大写。
3. 如果用户给的是短语,例如 `look up`,把它作为一个词条,不要拆成多个单词。
4. 对每个单词运行 `deno task lookup '<word>'` 查 ECDICT 词典。
   - 查到：使用词典释义，按格式化规则整理
   - 查不到：由 AI 按格式化规则生成
5. **判断是新增还是修改：**
   - 如果用户意图是**新增**单词，调用 `deno task add '<word>' '<meaning>'`
   - 如果用户意图是**修改**已有单词的释义，调用 `deno task update '<word>' '<meaning>'`
   - 所有 word 都按一个参数传递。短语必须完整引用，例如：
     `deno task lookup 'look up'`、
     `deno task add 'look up' 'v. 查找；查阅'`、
     `deno task update 'look up' 'v. 查找；查阅'`。
6. 用简短中文总结结果(新增/已存在/已修改/失败)。

## 回复格式

**单词新增成功:**
已加入 run：
v. 跑；运行；经营
n. 跑步；一段连续时间
score: 0

**单词已存在:**
run 已经在词库里了：
<已有释义>
当前 score: <score>

**单词修改成功:**
已更新 run 的释义：
<新释义>

**多个单词:**
逐条列出结果,每条按上面三种格式之一给出,最后加一句总结
(例如"共 3 个：2 个新增，1 个已修改")。

## 禁止事项

- 不要直接读写 SQLite。
- 不要直接调用项目脚本;只能通过 `deno task ...`。
- 不要用 Python 读取/解析/更新词库数据。
- 不要调用外部 API。
- 不要手动修改 score。
- 命令执行失败时,直接报告错误,不要继续说添加成功。
- 除非单词本身有歧义或生僻到无法判断词义,否则不要向用户询问中文释义。
- 添加单词前必须执行 `deno task lookup` 查字典，不得跳过该步骤直接 AI 生成。
