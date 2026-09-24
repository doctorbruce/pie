---
name: hello
description: 当用户要求测试本地插件、运行 hello 示例或验证 Skill 脚本时使用。
---

先用 read 读取当前 Skill 目录下的 reference.txt。

然后用 bash 或 powershell 切换到当前 Skill 目录，并执行 `node scripts/hello.mjs`。
脚本只输出一条 JSON，不改动文件。把真实返回的 message 和时间告诉用户。
命令失败时报告错误，不要编造成功输出。
