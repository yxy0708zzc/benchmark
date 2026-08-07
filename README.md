# 高铁购票大模型能力测试平台（Benchmark）

构建用于测试和评估大模型（DeepSeek、GPT-4、Claude 等）在**复杂规划、组合推理和工具调用**方面能力的 Benchmark 平台。核心场景：用户提出高铁购票需求，大模型需理解意图、调用工具查询数据、组合多种购票策略（直达、换乘、买短补长、额外购买等），最终给出可执行的购票方案。

---

## 功能概览

| 模块 | 说明 |
|------|------|
| **数据爬取** | 基于 12306 真实车次、经停站、票价数据 |
| **出题器** | 手动 / 存在性自动 / 选择性自动三种出题模式 |
| **测试器** | 对话式测试，调用大模型并处理工具调用循环 |
| **测评器** | 核查 final_plan：购买/乘坐双区间；存在性对标标答、选择性校全程可达 |
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
4. 模型会调用工具查询车次/余票/票价，最终输出 `final_plan`（结构化乘车方案，见下方「final_plan 格式与核查规则」）
5. 可点击「🔄 重置对话」清空会话；「✅ 测试完成」保存测试记录到 `logs/test/`

### 第四步：测评

打开**测评**标签页：
1. 从测试记录列表加载一条记录
2. 点击「代码核查」→ 系统自动核查模型 `final_plan`（详见下方「final_plan 格式与核查规则」）
3. 查看体系化的核查结果：8 维统计 + 购买/乘坐明细表 + 问题清单，人工确认后「保存测评结果」
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
- 答案**唯一**，模型只需找到**一条**可行路径
- 可设置**需求人数**（答案票数 ≥ 人数）和**答案票等级**（class0/1/2）
- 默认加入**伪干扰**（干扰票数**严格 < 人数**，制造"看起来像但票不够"的干扰项，保证只有唯一合法解），密度滑条 **0~1%**（默认 0.1%，步长 0.01%）
- 模型需通过"票数是否够 + 等级是否匹配"筛选出**唯一**正确答案

### 3. 选择性自动出题
- 答案**多个**，模型需**筛选最优**方案
- 可设置需求人数（答案票数 ≥ 人数）和答案票等级
- 在合法解基础上添加**真干扰**（票数随机 1~10、等级随机），密度滑条 **0~5%**（默认 2%，步长 0.01%）

> 生成后 metadata 中 `interference_mode` 字段区分干扰类型：`fake`=存在性伪干扰、`real`=选择性真干扰。

### 支持题型
`transfer`（换乘）/ `short_buy`（买短补长）/ `extra_front`（额外前）/ `extra_rear`（额外后）/ `mixed`（混合，每段可独立选策略）

> 买短补长与额外购买在模型输出中统一用「购买区间 + 乘坐区间（ride）」表达（无独立补票段）。

> 换乘出题保证：**当天换乘**、后一趟发车时间 ≥ 前一趟到达时间 + 20 分钟、时间顺序正确。

---

## final_plan 格式与核查规则

### 输出格式（prompt 强制要求）

模型最终回复末尾输出 JSON，**每个片段同时包含购买区间和实际乘坐区间**：

```json
{"final_plan": [
  {"train_num": "G1", "from": "VNP", "to": "JGK", "ride_from": "VNP", "ride_to": "AOQ", "seat_type": "class2", "tickets": 2, "price": 139.0}
]}
```

- `from / to`：**购买区间**（买了哪段票，核查层1 查余票/票价）
- `ride_from / ride_to`：**实际乘坐区间**（每个片段都必须写，缺任一项 → 判「缺乘坐区间」）
- 三种关系：
  - **相等** = 正常直达/换乘
  - **买短补长**：`ride` 比 `from/to` 长——买 `A→M`，坐 `A→B`，`M→B` 无票上车补票
  - **买长坐短（前/后额外）**：`from/to` 比 `ride` 长——买 `A'→B` 或 `A→B'`，实际坐 `A→B`
- 不使用 `seg_type`/`onboard` 段（买短补长与额外购买已整合，用 `ride` 直接表达）

### 核查规则（verifier.py）

按题目的 `interference_mode` 区分存在性（fake）/选择性（real），三层判定：

| 层 | 存在性（fake，答案唯一） | 选择性（real，答案多个） |
|----|------------------------|------------------------|
| 层1 余票/票价 | 购买区间查 DB 有票 + 票价 + 张数 ≥ 人数 | 同左 |
| 层2 | 与 `ground_truth` **完全一致**（车次+购买+座位+乘坐） | **全程可达**：拼接各段乘坐区间（地点连续 + 时间衔接 + 覆盖出发/到达站） |
| 缺字段 | 购买段缺 `ride` → `missing_ride`（答不全即错） | 同左 |

> 出题端保存 `ground_truth`（含购买+乘坐的 id 与汉字）至 `metadata` 供存在性对标；`metadata` 同时存 `start_station_id`/`end_station_id` 供可达性校验。

### 前端核查展示

测评页「代码核查」结果体系化展示：
- **8 维统计卡**：方案总数 / 正确 / 余票不符 / 票价问题 / 无效条目 / 路线不符 / 票数不足 / 缺乘坐区间
- **明细表**：每段显示 车次 / 购买区间 / 乘坐区间（汉字）/ 座位 / 票数(声称/实际) / 票价(声称/实际) / 核对；购买≠乘坐时标注「买≠坐」
- **问题清单**：按类型中文标签 + 颜色分类（红=硬错、橙=格式或不足）

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

## 脚本与命令行工具

### ① 基础数据爬虫 `collector.py`（车次 / 经停站 / 车站 / 同车映射）

```bash
python collector.py
```

- **无参数**，一键执行全流程（7 个阶段）：
  采集车站列表 → 初始化 HTTP 会话 → 枚举 G 车次 → 采集经停站 → 物化 station_trains 表 → 构建同车多号映射 → 数据完整性验证
- 需联网访问 12306，数据写入 `data/railway.db`（stations / trains / train_stops / station_trains）和 `data/same_trains.json`
- 若 12306 数据有更新，重新运行即可

### ② 票价爬虫 `price_collector.py`

```bash
python price_collector.py                 # 全量爬取
python price_collector.py --resume        # 断点续爬（跳过已完整爬取的车次）
python price_collector.py --supplement    # 补充模式：仅补爬缺失站对，保留已有数据
python price_collector.py --train G1      # 只爬指定车次
python price_collector.py --workers 4     # 4 线程并发（默认 1，建议 3~5）
```

| 参数 | 说明 |
|------|------|
| `--resume` | 断点续爬；会校验每个车次的站对完整性，不完整的自动重爬 |
| `--supplement` | 只补爬缺失的站对，不删除已有票价数据 |
| `--train` | 仅爬取指定车次（如 `G1`） |
| `--workers` | 并发线程数，默认 1，建议 3~5 |

> 票价数据写入 `data/prices.db`。查询日期来自 `config.py` 的 `CRAWLER_CONFIG["query_date_days_list"]`（默认未来 3/9/13 天）。

### ③ 题目自然语言化工具 `nl_question.py`（重点）

把 metadata 中僵硬的 `question`（如 `"北京南到上海虹桥"`）转化为自然、口语化的**购票者口吻**需求，写回 `nl_question` 字段（原 `question` 保留）。测试器加载题目时会自动用 `nl_question` 填充对话输入框。

```bash
# 交互式填写 API Key / 模型 / URL（默认跳过已有 nl_question 的题目）
python nl_question.py

# 直接传 API Key
python nl_question.py --api-key sk-xxx

# 指定模型与 API 地址
python nl_question.py --model deepseek-chat --base-url https://api.deepseek.com

# 强制重新生成已有 nl_question 的题目
python nl_question.py --force

# 只处理指定题目（可多次指定；指定题即使已有 nl_question 也会重新生成）
python nl_question.py --question a1 --question a2
```

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--api-key` | 空（交互填写） | 大模型 API Key |
| `--model` | `deepseek-v4-flash` | 模型名称 |
| `--base-url` | `https://api.deepseek.com` | OpenAI 兼容 API 地址 |
| `--force` | 关 | 强制重新生成已保存 `nl_question` 的题目（默认跳过） |
| `--question` | 无 | 只处理指定题目 ID，可多次指定（`--question a1 --question a2`）；指定题即使已有 `nl_question` 也会重新生成 |

**交互键位**（逐题生成，人工确认后保存）：

| 按键 | 行为 |
|------|------|
| `Enter` | 接受并保存当前生成 |
| `x` | 重新生成一条 |
| `n` | 跳过此题（不保存） |
| `Ctrl+C` | 中止整个脚本（已保存的不受影响） |

**约束传递（重要）**：`build_prompt` 会把题目的**需求人数 `people_count` 和答案票等级 `seat_type`** 一并传给模型（旧题缺字段自动回落默认 2 人 / 二等座）。提示词要求：
- 以**真实购票者身份**、自然口语化提问
- **自然隐含**人数与等级（如"我们五个同事…""带爸妈想躺一躺…"），**禁止**"买 X 张 / 买 X 等座"式硬性表达
- 内置 4 个 few-shot 示例；保留出发/到达站、不指定中间站、不泄露车票信息/策略

> 提示词模板 `NL_PROMPT_TEMPLATE` 为 `nl_question.py` 顶部独立常量，可自行修改。生成器只"知道"题目结构、题型与人数/等级约束，**不泄露车票存在信息**（不含 `answer` 标准路径）。

### ④ 清理数据不全车次 `cleanup_incomplete_trains.py`

```bash
python cleanup_incomplete_trains.py
```

- 逐个检查车次的票价数据完整性，发现数据不全的车次**逐个确认**：`y`=删除 / `n`=跳过（`Enter` 默认删除）
- 删除的车次会同步从 `trains` 表移除，避免出题/测评引用到"幽灵车次"

---

## 技术栈

- **后端**：FastAPI + uvicorn + SQLite
- **前端**：原生 HTML/JS/CSS（SPA）
- **爬虫**：requests
- **大模型接入**：OpenAI 兼容 API，通过工具调用交互

---
## 备注
- 题目中a*为自动出体，纯数字为手动
