# 测试器与 AI 对话实现说明（tester.md）

> 面向评审。说明系统如何与被测大模型进行**多轮工具调用式对话**，驱动模型查询数据并输出购票方案（final_plan）。

---

## 一、测试流程概述

```
加载题目 → 输入购票需求 → 发起对话 → 模型多轮调用工具查询 → 输出 final_plan → 测试完成保存
```

- 对话采用 **OpenAI Chat Completions 兼容 API**（OpenAI 工具调用格式），被测模型通过系统提示词 + 工具集在测试中自主查询车次/余票/票价
- 测试记录保存到 `logs/test/`，供后续测评器（verifier.md）核查

---

## 二、对话接口

| 接口 | 说明 |
|---|---|
| `POST /api/test/chat` | 非流式对话（一次性返回最终回复） |
| `POST /api/test/chat/stream` | 流式对话（SSE，逐字返回） |

**请求参数（ChatRequest）**：模型名称、API Key、API Base URL、消息内容、题目 ID、最大工具调用次数（`max_iterations`，默认 100）、会话 ID。

> **API 配置来源**：前端不存 key（无设置弹窗）。请求可显式带 `model_name`/`api_key`/`api_base_url`；为空时服务端回落读取根目录 `.env` 的 `TEST_API_KEY`/`TEST_MODEL`（未填回落 `DEFAULT_MODEL`）/`DEFAULT_BASE_URL`（再缺省用内置默认值），优先级：请求显式 > `.env` > 内置默认。

---

## 三、系统提示词（`prompts.py` 的 SYSTEM_PROMPT）

- 角色设定：**高铁票务助手**，帮助用户规划行程并购买车票
- 硬性要求：**所有余票/票价数据必须通过工具调用从本地数据获取**，不得凭记忆或经验作答
- 核心目标：尽可能帮用户买到票；只有确认完全无票才能告知放弃（必须已调用过相关工具）
- 输出格式约束：最后必须输出结构化 JSON：

```json
{"final_plan": [
  {"train_num": "G1", "from": "VNP", "to": "JGK", "ride_from": "VNP", "ride_to": "AOQ",
   "seat_type": "class2", "tickets": 2, "price": 139.0}
]}
```

- 若无法满足则输出 `{"final_plan": []}`

---

## 四、工具集（`server.py` 内置定义）

被测模型可调用以下 **7 个 OpenAI 工具**（工具定义已直接写在 `server.py` 中，无独立 tools 模块）：

| 工具 | 说明 |
|---|---|
| `query_trains_between_stations` | 查询两站之间的所有车次（含到发时间） |
| `query_trains_at_station` | 查询经过某站的所有车次 |
| `query_train_detail` | 查询某车次完整经停站详情（站名/电报码/时间） |
| `list_stations` | 搜索车站列表（关键词 / 分页） |
| `list_trains` | 搜索车次列表（关键词 / 分页） |
| `query_tickets` | 查询余票（当前题目库；车次、站对、座位类型） |
| `query_ticket_price` | 查询某区间各席别票价 |

---

## 五、工具调用循环（核心实现）

```
while 轮数 < max_iterations:
    调用模型 API（携带 messages + tools）
    if 无 tool_calls: 取最终 content，结束
    否则：
        记录 assistant 消息（含 tool_calls）
        逐个执行工具 execute_tool_handler(name, args)
        工具结果作为 role="tool" 消息回填 messages
        继续下一轮
```

- **工具执行**：`execute_tool_handler` 按工具名分发，`query_tickets`/`query_ticket_price` 读取**当前题目数据库**（余票只反映本题设计的数据）
- **防死循环**：最多 `max_iterations` 轮（默认 100）
- **会话历史**：存于服务端内存（`chat_sessions`），按会话 ID 维护；首条消息注入系统提示词
- **Token 统计**：按轮累计，prompt 按增量计算并**扣除缓存命中**（`prompt_tokens_details.cached_tokens`）
- **耗时**：整段对话总时长

---

## 六、流式对话（SSE）

前端通过 EventSource/fetch 读取事件流，事件类型：

| 事件 | 内容 |
|---|---|
| `reasoning` | 思考链（reasoning_content，可选） |
| `token` | 增量文本（流式渲染，纯文本，done 后再 Markdown 渲染） |
| `tool_call` | 模型请求调用某工具（名称 + 参数 JSON） |
| `tool_result` | 工具执行结果（回填到对应工具调用用于展示） |
| `done` | 对话结束 |
| `error` | 出错 |

---

## 七、final_plan 解析

- `_parse_ai_final_plan`：从模型最终回复中定位 `"final_plan"` 所在的最外层 JSON 并解析
- 用 `normalize_final_plan`（verifier）统一字段契约并校验
- 无有效条目视为未规划（`no_plan`），供测评阶段判定

---

## 八、测试完成保存（`POST /api/test/complete`）

- 汇总：Token 用量（输入/输出/总）、耗时、**顶层 `tool_calls`**（工具调用日志）、解析出的 `final_plan`、`plan_status`
- `tool_calls` 在对话循环中按会话累计（流式/非流式均落盘），供统计模块读取 `avg_tool_calls` 等指标
- `plan_status` 词汇与核查 verdict 统一：`has_solution` / `empty_plan`（模型明确无解）/ `no_plan`（未输出 final_plan）
- 写入 `logs/test/`（测试记录 JSON），供测评页加载核查

---

## 九、前端交互（测试页）

- **对话界面**：消息区（用户 / 助手 / 思考链 / 工具调用），智能滚动（仅接近底部时自动滚到底）
- **工具调用概览**：展示每轮工具调用名称、参数、结果（⏳ 执行中 → ✅ / ❌）
- **流式渲染**：工具执行期间工具列表实时更新，文本流式纯文本展示，完成后 Markdown 渲染
- **重置对话**：清空服务端会话历史与 token 统计
- **测试完成**：确认后保存记录并提示 Token / 耗时 / 最终方案

---

*文档版本：2026-08-28 · 对应实现：server.py（/api/test/chat、/api/test/chat/stream、/api/test/complete、execute_tool_handler、_parse_ai_final_plan、7 个 OpenAI 工具定义）、prompts.py（SYSTEM_PROMPT）、static/app.js（对话 UI）*
