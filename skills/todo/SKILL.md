---
name: todo
description: 管理待办事项和提醒
category: productivity
permissions: []
tags: [待办, 提醒, todo, reminder]
---

# 待办管理

帮助用户管理待办事项。

## 使用方法

- "提醒我..." → 创建提醒
- "我有什么待办" → 列出待办
- "完成xxx" → 标记完成

## 实现

使用 localStorage 存储待办列表。支持：
- 添加待办（带时间可设为提醒）
- 列出待办
- 标记完成
- 删除待办
