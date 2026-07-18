# 约束规则

1. 不要修改 scripts/vocab.ts、deno.jsonc 或其他任何源代码文件。
2. 只通过 deno task 执行操作（quiz / add / update / answer / list / lookup）。
   执行任何 deno task 之前，必须先调用 skill 工具加载对应的技能文件
   （quiz → quiz-vocab-word，add → vocab-add），严格按照技能文件中的
   命令格式执行，不得凭经验或记忆自行构造命令。
3. 如果发现代码有问题（例如缺少函数、运行报错），不要自行修改，
   直接向用户报告问题，让开发者来修。
