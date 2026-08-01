# 高铁购票大模型能力测试平台（Benchmark）

构建用于测试和评估大模型（DeepSeek、GPT-4、Claude 等）在**复杂规划、组合推理和工具调用**方面能力的 Benchmark 平台。核心场景：用户提出高铁购票需求，大模型需理解意图、调用工具查询数据、组合多种购票策略（直达、换乘、买短补长、额外购买等），最终给出可执行的购票方案。

---

## 功能概览

| 模块 | 说明 |
|------|------|
| **数据爬取** | 基于 12306 真实车次、经停站、票价数据 |
| **出题器** | 手动 / 存在性自动 / 选择性自动三种出题模式 |
| **测试器** | 对话式测试，调用大模型并处理工具调用循环 |
| **测评器** | 验证模型输出的 final_plan 与余票数据库一致性 |
| **统计** | 完成率、幻觉率、平均分、Token 效率等指标与报告 |

---

## 目录结构

```
benchmark_travelplan/
├── collector.py            # 基础数据爬虫（车次/经停站）
├── price_collector.py      # 票价爬虫（支持并发、断点续爬）
├── server.py               # FastAPI 服务（API + 前端）
├── database.py             # SQLite 数据库操作
├── verifier.py             # 代码核查（验证模型方案）
├── prompts.py              # 系统提示词常量
├── config.py               # 全局配置
├── requirements.txt
├── data/
│   ├── railway.db          # 基础数据库（stations/trains/train_stops/station_trains）
│   ├── prices.db           # 票价数据库
│   └── same_trains.json    # 同车多号映射
├── question/
│   ├── *.db                # 每道题的余票数据库
│   └── metadata.json       # 题目元数据
├── logs/
│   ├── test/               # 测试记录
│   ├── result/             # 测评结果
│   └── report/             # 统计报告
├── static/                 # 前端 JS/CSS
├── templates/index.html    # 前端页面（SPA）
├── tools/                  # OpenAI Tools 定义
└── statistics/             # 统计模块
```

---

## 安装与启动

```bash
# 1. 安装依赖
pip install -r requirements.txt

# 2. 爬取基础数据（车次/经停站）
python collector.py

# 3. 爬取票价数据
python price_collector.py                 # 全量
python price_collector.py --resume        # 断点续爬
python price_collector.py --workers 4     # 4 线程并发
python price_collector.py --train G1      # 仅爬指定车次

# 4. 启动服务
python server.py
```

启动后访问 `http://127.0.0.1:8000`。

> **注意**：`server.py` 改动后需重启服务生效；前端修改需递增 `templates/index.html` 中脚本的 `?v=N` 版本号（否则浏览器缓存旧脚本）。

---

## 使用方法

### 完整工作流

```
准备数据 → 出题 → 测试 → 测评 → 统计
```

### 第一步：准备数据（仅首次或数据更新时）

1. 运行 `python collector.py` 爬取基础数据（车站、车次、经停站）
2. 运行 `python price_collector.py` 爬取票价数据（供测评时核验票价）
3. 数据保存在 `data/` 目录，服务会自动读取
4. 题目表.xlsx 是不同题型分布的题目配置表

> 若 12306 数据有更新，重新运行爬虫即可；`--resume` 支持断点续爬。

### 第二步：出题

打开页面顶部的**出题**相关标签页，有三种模式：

**① 手动出题（「出题」标签）**
1. 输入题目编号 → 输入车次号 → 点击加载
2. 在弹出的半矩阵中逐格填写余票数量（0 表示无票）
3. 填写完成后「标记题目完成」

**② 存在性自动出题（「存在性问题出题」标签）**
1. 选择题型（换乘/买短补长/额外前/额外后/混合）
2. 填写出发站和到达站（支持中文站名或电报码，可点 🎲 随机选站）
3. 混合题需设置换乘次数和各段策略（直达/买短补长/额外前/额外后）
4. 点击「生成并预览」→ 查看预览结果
5. 满意则点「✅ 确认生成」落盘；不满意点「🔄 重新出题」（保留输入、清除缓存重新生成）

**③ 选择性自动出题（「选择性问题出题」标签）**
- 与存在性出题类似，但会添加随机干扰票（可调干扰密度）
- 生成的题目模型需要**筛选最优方案**

> 生成的题目保存在 `question/*.db`，元数据在 `question/metadata.json`。

### 第三步：测试

打开**测试**标签页：
1. 在左侧题目列表中选择题目（支持按来源/题型筛选、关键词搜索）→ 点击「加载选中题目」
2. 首次使用需点击右上角设置按钮填写 **API Key**（支持填写过的切换）
3. 在对话输入框输入购票需求，例如：
   > 从北京南到上海虹桥，二等座，2 张，下午出发
4. 模型会调用工具查询车次/余票/票价，最终输出 `final_plan`（结构化购票方案）
5. 可点击「🔄 重置对话」清空会话；「✅ 测试完成」保存测试记录到 `logs/test/`

### 第四步：测评

打开**测评**标签页：
1. 从测试记录列表加载一条记录
2. 点击「代码核查」→ 系统自动对比模型输出的 `final_plan` 与余票数据库、票价数据库
3. 查看核查结果（余票是否编造、票价是否一致），人工确认后「保存测评结果」
4. 结果保存到 `logs/result/`

### 第五步：统计

打开**统计**标签页：
- 查看汇总指标：完成率、幻觉率、平均分、Token 消耗、工具调用次数
- 支持导出 JSON / Markdown 格式报告（`logs/report/`）

---

## 主要 API

### 基础数据查询（GET）
| 接口 | 说明 |
|------|------|
| `/api/train` | 车次列表（`keyword`/`page`/`limit`） |
| `/api/station` | 车站列表 |
| `/api/station/random` | 随机车站 |
| `/api/train/{train_num}` | 车次详情（经停站） |
| `/api/station/{station_id}` | 车站详情（经停车次） |
| `/api/train/{train_num}/ticket` | 余票查询 |
| `/api/routes` | 两站之间车次 |

### 出题器
| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/auto_generate` | POST | 自动出题（生成预览） |
| `/api/auto_generate/confirm` | POST | 确认生成题目 |
| `/api/auto_generate/clear` | POST | 清除预览缓存 |
| `/api/auto_generate/previews` | GET | 查看预览缓存 |
| `/api/question/list` | GET | 题目列表（支持 `source`/`type`/`keyword` 筛选） |
| `/api/question/init` | POST | 初始化题目车次 |
| `/api/update_ticket` | POST | 实时更新余票 |

### 测试器 / 测评器 / 统计
| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/test/chat` | POST | 非流式对话 |
| `/api/test/chat/stream` | POST | 流式对话（SSE） |
| `/api/test/complete` | POST | 保存测试记录 |
| `/api/test/records` | GET | 测试记录列表 |
| `/api/eval/verify` | POST | 代码核查 |
| `/api/eval/complete` | POST | 保存测评结果 |
| `/api/stats/summary` | GET | 统计汇总 |

---

## 出题模式

### 1. 手动出题
人工逐格设置余票数量，适合精细控制。

### 2. 存在性自动出题
- 只写合法解（稀疏存储），无干扰票
- 模型只需找到**一条**可行路径

### 3. 选择性自动出题
- 在合法解基础上添加随机干扰票（`interference: true`）
- 模型需**筛选最优**方案

### 支持题型
`transfer`（换乘）/ `short_buy`（买短补长）/ `extra_front`（额外前）/ `extra_rear`（额外后）/ `mixed`（混合，每段可独立选策略）

> 换乘出题保证：**当天换乘**、后一趟发车时间 ≥ 前一趟到达时间 + 20 分钟、时间顺序正确。

---

## 测试与测评流程

1. **测试**：测试页加载题目 → 输入购票需求 → 模型调用工具 → 输出 `final_plan` → 点击"测试完成"保存记录
2. **测评**：测评页加载测试记录 → 代码核查（验证余票/票价）→ 人工确认 → 保存结果
3. **统计**：统计页查看完成率、幻觉率、平均分等指标，可导出 JSON/Markdown 报告

---

## 配置说明（`config.py`）

| 配置 | 默认值 | 说明 |
|------|--------|------|
| `API_CONFIG.host/port` | `127.0.0.1:8000` | 服务地址 |
| `CRAWLER_CONFIG` | - | 爬虫限速、超时、重试、基准日期等 |
| `QUESTION_CONFIG` | - | 出题参数（干扰密度、票数范围等） |

---

## 常用工具脚本

| 脚本 | 用途 |
|------|------|
| `cleanup_incomplete_trains.py` | 清理票价不全的车次（逐个确认） |
| `nl_question.py` | 调用大模型将题目 `question` 转化为自然购票需求（见下文） |

---

### 题目自然语言化工具（`nl_question.py`）

把 metadata 中僵硬的 `question`（如 `"北京南到上海虹桥"`）转化为自然、口语化的购票需求，写回 `nl_question` 字段（原 `question` 保留）。

```bash
python nl_question.py                        # 交互式填写 API/模型/URL
python nl_question.py --api-key sk-xxx       # 直接传 API Key
```

**交互键位**：
| 按键 | 行为 |
|------|------|
| `Enter` | 接受并保存当前生成 |
| `x` | 重新生成一条 |
| `n` | 跳过此题（不保存） |
| `Ctrl+C` | 中止整个脚本 |

**设计原则**：生成器只"知道"题目结构与题型（`question`/`type`/混合的 `segment_plans`），**不泄露车票存在信息**（不含 `answer` 标准路径）。提示词模板 `NL_PROMPT_TEMPLATE` 为独立常量，可自行修改。
---

## 技术栈

- **后端**：FastAPI + uvicorn + SQLite
- **前端**：原生 HTML/JS/CSS（SPA）
- **爬虫**：requests
- **大模型接入**：OpenAI 兼容 API，通过工具调用交互

---
## 备注
- 题目中a*为自动出体，纯数字为手动
