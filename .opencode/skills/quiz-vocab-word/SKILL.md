---
name: quiz-vocab-word
description: >
  当用户想要复习、测试、背单词、抽查词汇、继续练习词汇时使用此技能,
  从本地词库出题——即使用户只是说"测试一下"、"背几个单词"、"继续测"、
  "quiz me"这类模糊说法,只要意图是复习词汇,也应触发。每道中文释义后
  必须附加首字母提示 (a••••) 和短语标记 [短语]，不得省略。展示中文释义,
  让用户写出对应英文单词,每轮测试 5 个,并根据答题结果更新 score。
---

# Quiz Vocabulary Word

## When to Use

用户要求复习、练习、测试或继续测试词汇时使用。

## 执行命令

在项目根目录运行:

```bash
deno task quiz --limit 5 --total <用户要求的总数>
deno task quiz --limit 5 --session <sessionId>
deno task answer <id> correct --session <sessionId> --input "<用户答案>"
deno task answer <id> wrong --session <sessionId> --input "<用户答案>"
deno task quiz-result --session <sessionId>
```

quiz 返回 JSON 包含 `displayBlock`（出题文案）和 `answers`（评分对照表）。

**只使用 `deno.jsonc` 中定义的 task 操作词库**。不要直接调用 `scripts/vocab.ts`,
也不要用 Python/SQLite 处理正常的测试/列表/查询/评分流程。

score 只能通过 `answer` 更新:

| 结果 | score 变化 |
|---|---|
| correct | `score + 1` |
| wrong | `max(score - 2, 0)` |

## 流程

1. 判断用户要求的总数 `N`。如果用户没有指定,默认 `N = 5`。
2. 第一轮运行 `deno task quiz --limit 5 --total N`,并记住返回的
   `sessionId` 和实际的 `totalCount`。如果词库不足 N 个,以 `totalCount` 为准并告知用户。
3. 后续轮次必须运行 `deno task quiz --limit 5 --session <sessionId>`。
   不得重新运行不带 session 的 quiz,也不得重新生成测试集。
4. 测试 session 开始时已经固定全部词条。后续轮次只按固定顺序取下一批,
   即使 score 改变,也不能让已测试或答错的词再次出现。
5. 有数据时展示 5 题;最后一轮不足 5 个就展示实际返回的全部。
6. **直接输出 `displayBlock` 字段的内容**，一字不改。这是出题的唯一来源，不要自己构建格式。
7. 记住最近一轮 `answers` 中的 `id -> word` 映射,等待用户回答这一轮全部题目。
8. 收到答案后,按最近展示的题目逐题执行带 `--session` 和 `--input` 的 `deno task answer`。
   `--input` 必须保存用户的原始答案,每道题必须执行且不能重复执行。
9. 非最后一轮只回复本轮答对数、答错数和测试进度,例如：
   `本轮答对 4 个，答错 1 个。进度：10 / 20。`
   不要显示错题、正确答案或 score 变化。
10. 如果本轮返回 `allShown: false`,评分完成后立即使用同一个 session 开始下一轮,
    不要等待用户再次说“继续”。
11. 最后一轮评分完成后运行 `deno task quiz-result --session <sessionId>`。
12. 只在最后一次性展示完整结论：总数、答对数、答错数、正确率，以及所有错题的
    用户答案和正确写法。准确率必须使用 `quiz-result` 返回的值,不要自行计算。

## 出题格式

一次性给出 5 题。直接输出 `displayBlock` 的内容（已包含序号、释义、首字母提示和短语标记）：

```txt
请写出对应的英文单词：

1. n. 苹果；苹果树 (a••••)
2. n. 书；本子；v. 预订 (b•••)
3. n. 光；灯；adj. 轻的；浅色的 (l••••)
4. v. 改变；更换；n. 变化；零钱 (c•••••)
5. v. 跑；运行；n. 跑步 (r••)
```

用户作答前不要显示完整英文单词。

## 判分标准

只有用户写出目标英文单词时才判 `correct`。

可接受:
- 大小写差异:`Apple` = `apple`
- 无害的空格或标点差异
- 常见词形变化,但必须明显是同一词根,且意思仍匹配本题

以下判 `wrong`:中文答案、无关英文单词、空白、"不知道/忘了/不会"、跳过的题目。

## 每轮回复格式（非最后一轮）

```txt
本轮答对 4 个，答错 1 个。
进度：10 / 20。
```

不要在中途显示错题和正确写法。

## 最终回复格式

```txt
测试完成：

共 20 个，答对 16 个，答错 4 个，正确率 80%。

错题：
1. 你的答案：back；正确写法：book
2. 你的答案：aple；正确写法：apple
```

## 禁止事项

- 不要问"apple 是什么意思？"——方向是中文 → 英文,不是反过来。
- 每轮不要测试超过 5 个单词。
- 用户作答前不要透露英文单词。
- 不要用过期的缓存数据评分。
- 不要直接读写 SQLite。
- 不要直接调用项目脚本;只能通过 `deno task ...`。
- 不要用 Python 读取/解析/评分/更新词库数据。
- 不要跳过 `deno task answer`。
- 不要在非最后一轮展示错题详情或正确答案。
- 不要在下一轮重新选择词条。
- 命令执行失败时不要编造结果。
- 必须原样输出 `displayBlock`，不得自行构建格式、不得省略提示。
- 唯一允许的出题输出来源是 `displayBlock` 字段。
- 返回每轮结果前必须检查：本轮题目数量 === 调用了 answer 的次数。不匹配则说明有遗漏，补全后再返回。
