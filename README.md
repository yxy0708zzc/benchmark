# 高铁购票大模型能力测试平台（Benchmark）

构建用于测试和评估大模型（DeepSeek、GPT-4、Claude 等）在**复杂规划、组合推理和工具调用**方面能力的 Benchmark 平台。核心场景：用户提出高铁购票需求，大模型需理解意图、调用工具查询数据、组合多种购票策略（直达、换乘、买短补长、额外购买等），最终给出可执行的购票方案。

---

## 功能概览

| 模块 | 说明 |
|------|------|
| **数据爬取** | 基于 12306 真实车次、经停站、票价数据 |
| **出题器** | 存在性自动（`0_` 无干扰必出 + 勾选伪干扰时另出 `1_`）/ 选择性自动（`2_` 真干扰，可配评判标准与行为约束）/ **批量出题**（上传 1.xlsx 分布表 + 2.xlsx 站对表，单进度条一键生成落盘 + 失败回执）/ **批量自然语言化**（导航栏独立页，与「批量出题」「批量测试」并列，为缺失 `nl_question` 的题目批量生成自然语言）/ **批量测试**（导航栏独立页：扫描可测试题目 → 勾选增删 → 逐题调用测试器保存记录，按模型去重） |
| **测试器** | 对话式测试，调用大模型并处理工具调用循环 |
| **测评器** | 核查 final_plan：购买/乘坐双区间；分类按 `type`——存在性对标标答、选择性校全程可达+行为约束（含 `no_transfer_violated`）；verdict 分 `pass`/`hallucination`/`no_plan`/`empty_plan`/`db_not_found` |
| **统计** | 完成率、幻觉率、平均分、Token 效率等指标与报告 |
| **辅助工具 `assist/`** | 三个命令行小 Excel 工具（与 `docs/` 同级）：① 每站停车数统计、② 站对检查（是否有直达车 / 是否能通过换乘实现，判定算法与自动出题一致）、③ 车次停站序列导出；详见 `docs/assist_scripts.md` |

---

## 目录结构

```
benchmark_travelplan/
├── collector.py            # 基础数据爬虫（车次/经停站，含完整性/跨天验证）
├── price_collector.py      # 票价爬虫（支持并发、断点续爬、补充）
├── cleanup_incomplete_trains.py  # 一键清理：同车多号去重 + 票价不全车次（无参数即执行）
├── cleanup_overnight_trains.py   # 清理跨天车次（当日完成约束）
├── server.py               # FastAPI 服务（API + 前端）
├── database.py             # SQLite 数据库操作
├── verifier.py             # 代码核查（验证模型方案）
├── prompts.py              # 系统提示词常量
├── config.py               # 全局配置
├── nl_question.py          # 题目自然语言化（命令行工具，见 docs/scripts.md）
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
├── statistics/             # 统计模块
└── docs/                   # 系统说明文档（generator/scripts/tester/verifier/stats）
```

---

## 模型 API 配置（.env）

所有大模型连接信息统一放在项目根目录的 **`.env`**（已被 `.gitignore` 忽略，不会上传），**不再保存在浏览器 localStorage**，前端也没有 API Key 设置弹窗。填一次即可，无需在页面里反复输入。

| 变量 | 输入点 | 说明 |
|------|--------|------|
| `TEST_API_KEY` | 测试器（server.py 兜底） | 测试器调模型用的 API Key |
| `NL_API_KEY` | nl_question.py | 题目自然语言化调模型用的 API Key |
| `DEFAULT_MODEL` | 两者共用 | 默认模型（缺省 `deepseek-v4-flash`） |
| `DEFAULT_BASE_URL` | 两者共用 | 默认 OpenAI 兼容接口地址（缺省 `https://api.deepseek.com`） |

- **优先级**：命令行显式参数 > `.env` > 内置默认值
- 测试器前端发请求时不带 key/model/url（空串），由服务端读 `.env` 兜底

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

> 若 12306 数据有更新，重新运行爬虫即可；`--resume` 支持断点续爬。

### 第二步：出题

打开页面顶部的**出题**相关标签页，有两种模式（题名前缀由系统自动添加，与输入无关）：

**① 存在性自动出题（「存在性问题出题」标签）**
1. 选择题型（换乘/买短补长/额外前/额外后/混合）
2. 填写出发站和到达站（支持中文站名或电报码，可点 🎲 随机选站）
3. 混合题需设置换乘次数和各段策略（直达/买短补长/额外前/额外后）
4. 点击「生成并预览」→ 系统自动出**至少一份**（共用同一车次与合法解，仅干扰不同）：
   - `0_`：**无干扰**（只有答案路径有票，唯一解）
   - 勾选「加入伪干扰」时额外生成 `1_`：**伪干扰**（干扰票数严格 < 人数，唯一解）
5. 满意则点「✅ 确认生成」循环保存生成的每份；不满意点「🔄 重新出题」（保留输入、清除缓存重新生成）；换乘/混合题可点「🔄 换方案」（不变第一程车，换中间站/换乘车次，存在性 0_/1_ 同步换）

**② 选择性自动出题（「选择性问题出题」标签）—— 生成一份**
- 前缀 `2_`，答案**多个**，添加真干扰（票数 0.5~1.5×人数，可调干扰密度）
- **评判标准**（单选必选，默认综合考虑）：综合考虑 / 最快 / 最便宜 / 出发最晚 / 最早到达——作为题目对模型的优化目标，经 `nl_question` 自然化传达，不参与核查硬校验
- **行为约束**（可多选）：不允许换乘 / 不允许买短补长与额外购买——作为题目对模型的要求，**参与核查硬校验**（换乘 → `no_transfer_violated`；买短补长/额外购买 → `no_short_buy_violated` / `no_extra_violated`）
- 生成的题目模型需**筛选可行且满足约束的最优方案**（核查只校验全程可达 + 行为约束，不做标答对标）

**③ 批量出题（「批量出题」标签）**
1. 上传 **1.xlsx**（题目分布表，同一格式）→ 解析为可编辑表格（存在性区：单/双/三策略 × 有干扰/无干扰；选择性区：评判标准 × 行为约束 × 数量），单元格可直接修改；
2. 上传 **2.xlsx**（到发站对，可倒置）→ 展示站对表（可编辑），出题时**随机选取站对、方向随机可倒置、允许重复**；
3. 填写**座位等级比例**（特等/一等/二等，总和必须 100%，完全由前端输入、非随机），每题按比例加权随机抽取；**干扰密度**滑条（默认 2%）；**每题重试上限**（默认 40 次，固定参数重试直到成功）；可选勾选**批量后自动生成自然语言**（写回 `nl_question`，需 .env `NL_API_KEY`）；
4. 选择性题题型由行为约束自动推导（不允许换乘→买短补长；否则→换乘，保证有解），手动/批量一致，无需指定；
5. 页面布局与其他界面一致：**左侧输入**（上传/参数/开始按钮，说明文字在展示框出现之前显示）；**右侧展示**（顶部=进度条，其下=分布表与站对表**分块**上下排列、各自独立滚动，再下=结果）；找到「开始批量出题」按钮无需在长表中滚动；
6. 点击「开始批量出题」→ **一键生成并直接落盘**：**单进度条**（存在性 + 选择性合计）实时显示，每题显示实际尝试次数；
7. 完成后可下载**失败回执 xlsx**（布局与 1.xlsx 同构，每格=该格失败题数，顶部=总失败数）；题号沿用原名规则 `前缀+时间戳+序号`（如 `2_20260812_102638_0001`）；
8. 人数规则：**每道题独立随机 3~6**（手动页每次进入/重新出题同样自动随机 3~6，仍可手动修改）。

**④ 批量自然语言化（导航栏独立页，与「批量出题」「批量测试」并列；与批量出题异步、互不影响）**
- 扫描缺失自然语言（`nl_question`）的题目 → 勾选增删 → 「开始生成自然语言」→ 独立进度条 + 逐题结果；复用 nl_question 生成逻辑（含评判标准/行为约束自然化），需 .env `NL_API_KEY`；单题失败不影响其它题。

**⑤ 批量测试（导航栏独立页，与「批量出题」「批量自然语言化」并列，扫描/测试两按钮）**
- 扫描：填写**测试模型编号（名称）**后扫描**可测试题目**——条件：题目已落盘、**信息核查完备（含自然语言问题）**、且**该模型未测试过**（已测记录写入 `metadata.tested_models`，每个模型每题只测一次）；表格展示题目基本信息（题号/类型/题型/行程/是否有自然语言/已测模型/是否可测），勾选可增删；
- 测试：对勾选题目逐题调用测试器（以自然语言问题作为用户输入 → 工具循环 → 保存测试记录到 `logs/test/`），成功后将模型名写入 `tested_models`；独立进度条 + 逐题结果（记录文件/plan_status/耗时）；已测题目在后扫描时自动变为不可测（去重）。

> 生成的题目保存在 `question/*.db`，元数据在 `question/metadata.json`。

### 第三步：测试

打开**测试**标签页：
1. 在左侧题目列表中选择题目（支持按类型/题型筛选、关键词搜索）→ 点击「加载选中题目」
2. 模型连接使用根目录 `.env` 中的 `TEST_API_KEY`/`DEFAULT_MODEL`/`DEFAULT_BASE_URL`（前端不存 key，详见「模型 API 配置（.env）」）
3. 在对话输入框输入购票需求，例如：
   > 从北京南到上海虹桥，二等座，2 张，下午出发
4. 模型会调用工具查询车次/余票/票价，最终输出 `final_plan`（结构化乘车方案，见下方「final_plan 格式与核查规则」）
5. 可点击「🔄 重置对话」清空会话；「✅ 测试完成」保存测试记录到 `logs/test/`

### 第四步：测评

打开**测评**标签页：
1. 从测试记录列表加载一条记录
2. 点击「代码核查」→ 系统自动核查模型 `final_plan`（详见下方「final_plan 格式与核查规则」）
3. 查看体系化的核查结果：模式/verdict 徽章 + 动态统计卡 + 购买/乘坐明细表 + 三组问题清单，人工确认后「保存测评结果」
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
| `/api/auto_generate` | POST | 自动出题生成预览；`mode`=`existence` 出 `0_`（无干扰，`fake_interference=true` 时另出 `1_` 伪干扰），`selective` 出 `2_` 一份 |
| `/api/auto_generate/confirm` | POST | 确认生成题目（存在性需分别确认每份） |
| `/api/auto_generate/clear` | POST | 清除预览缓存 |
| `/api/auto_generate/swap` | POST | 换方案（换乘/混合；不变首车 T，存在性配对同步换） |
| `/api/auto_generate/previews` | GET | 查看预览缓存 |
| `/api/question/list` | GET | 题目列表（支持 `status`/`type`/`keyword` 筛选） |
| `/api/question/init` | POST | 初始化题目车次（含同车关联号） |
| `/api/question/{qid}/exists` | GET | 检查题目是否存在 |
| `/api/question/{qid}/trains` | GET | 获取题目已加载车次 |
| `/api/question/complete` | POST | 标记题目完成 |
| `/api/question/{qid}/train/{train_num}` | DELETE | 从题目删除车次 |
| `/api/question/{qid}` | DELETE | 删除题目 |
| `/api/update_ticket` | POST | 实时更新余票 |

### 批量出题
| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/batch/parse-distribution` | POST | 上传 1.xlsx 解析题目分布表（multipart `file`）→ 可编辑分布结构 |
| `/api/batch/parse-stations` | POST | 上传 2.xlsx 解析到发站对（multipart `file`） |
| `/api/batch/generate` | POST | 启动批量出题（分布+站对+座位比例+密度+重试上限+选择性题型），线程内一键生成并直接落盘 |
| `/api/batch/status` | GET | 批量进度（`done_count/total` 单进度条 + 当前任务 + 结果，含自然语言化统计） |
| `/api/batch/report` | POST | 生成失败回执 xlsx（布局与 1.xlsx 同构，每格=失败数，顶部=总失败数） |
| `/api/batch_nl/scan` | GET | 扫描缺失自然语言（`nl_question`）的题目列表 |
| `/api/batch_nl/generate` | POST | 启动批量自然语言化（独立线程与进度，需 `.env` `NL_API_KEY`） |
| `/api/batch_nl/status` | GET | 批量自然语言化进度（单进度条）+ 逐题结果 |
| `/api/batch_test/scan` | POST | 扫描可测试题目：`{model}`，条件=落盘 + 信息完备（含 `nl_question`）+ 该模型未测过 |
| `/api/batch_test/start` | POST | 启动批量测试：`{model, question_ids, max_iterations}`，仅测该模型未测过的题，成功后写回 `tested_models` |
| `/api/batch_test/status` | GET | 批量测试进度（单进度条）+ 逐题结果（记录文件/plan_status/耗时） |

### 测试器 / 测评器 / 统计
| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/test/chat` | POST | 非流式对话 |
| `/api/test/chat/stream` | POST | 流式对话（SSE） |
| `/api/test/complete` | POST | 保存测试记录（含工具调用日志） |
| `/api/test/reset` | POST | 重置会话 |
| `/api/test/records` | GET | 测试记录列表 |
| `/api/eval/load` | POST | 加载测试记录 |
| `/api/eval/verify` | POST | 代码核查 |
| `/api/eval/results` | GET | 测评结果列表 |
| `/api/eval/complete` | POST | 保存测评结果 |
| `/api/stats/summary` | GET | 统计汇总 |
| `/api/stats/export/json` | GET | 导出 JSON 报告 |
| `/api/stats/export/markdown` | GET | 导出 Markdown 报告 |

---

## 出题模式

### 1. 存在性自动出题（前缀 `0_` / `1_`，答案唯一）
- 点击「生成并预览」至少出 `0_`（同一车次、同一合法解）；**勾选「加入伪干扰」时额外出 `1_`**（两份共用同一随机种子保证一致）：
  - **`0_` 无干扰**：完全不加干扰票，只有答案路径有票 → **唯一解**，核查用**对标标答**（完全一致）
  - **`1_` 伪干扰**：干扰票数**严格 < 人数**（制造"看起来像但票不够"的干扰项），仍保证唯一解，核查用对标标答
- 可设置**需求人数**（每次进入页面或点击「重新出题」时自动随机 3~6，仍可手动修改；答案票数 1~1.5×人数随机、保证 ≥ 人数）和**答案票等级**（class0/1/2）；干扰密度滑条 **0~5%**（默认 2%，步长 0.1%，仅对 `1_` 生效，`0_` 无干扰）

### 2. 选择性自动出题（前缀 `2_`，答案多个）
- 只生成**一份**，前缀 `2_`
- 添加**真干扰**（票数 0.5~1.5×人数、等级随机），密度滑条 **0~5%**（默认 2%，步长 0.1%）
- 可设置需求人数（进入页面/重新出题时自动随机 3~6，仍可手动修改）和答案票等级
- **题型由行为约束自动推导**（手动/批量一致，保证有解）：勾选「不允许换乘」→ 题型=买短补长；否则（无约束或仅「不允许买短补长与额外购买」）→ 题型=换乘；前端不再需要选择题型
- **评判标准**（单选必选，`criterion`）：`comprehensive` 综合考虑（默认）/ `fastest` 最快 / `cheapest` 最便宜 / `depart_latest` 出发最晚 / `arrive_earliest` 最早到达——仅作为题目对模型的优化目标，经 `nl_question` 自然化传达，不参与核查
- 可勾选**行为约束**（多选，`constraints`）：`no_transfer` 不允许换乘 / `no_short_buy_extra` 不允许买短补长与额外购买——作为题目对模型输出的要求，经 `nl_question` 自然化传达；核查端**仅在题目声明对应约束时**硬校验：`no_transfer` → 方案含跨车次换乘判定 `no_transfer_violated`；`no_short_buy_extra` → 检出买短补长（`no_short_buy_violated`）或额外购买（`no_extra_violated`，前/后都算）
- 核查只校验**全程可达 + 行为约束**，不与标答完全一致（答案多个）

### 元数据字段（`question/metadata.json`）
生成确认后写入：
- `question_type`：题型（transfer/short_buy/extra_front/extra_rear/mixed）
- `question_mode`：`existence` / `selective`（出题时确定的题目模式）
- `type`：**分类依据**（存在性 / 选择性），由 `question_mode` 推导
- `interference_mode`：真实干扰类型（`fake`=伪干扰、`real`=真干扰；无干扰题不存）
- `ground_truth`：结构化标准答案（含购买+乘坐区间 id），供存在性对标
- `start_station_id` / `end_station_id`：真实 A/B 站，供可达性校验
- `criterion`：评判标准（仅选择性题，`comprehensive/fastest/cheapest/depart_latest/arrive_earliest`）
- `tested_models`：已测试模型编号列表（批量测试成功后退回写；每个模型每题只测一次，批量测试去重依据）
- `constraints`：行为约束（仅选择性题且非空时：`no_transfer` / `no_short_buy_extra`）

### 支持题型
`transfer`（换乘）/ `short_buy`（买短补长）/ `extra_front`（额外前）/ `extra_rear`（额外后）/ `mixed`（混合，每段可独立选策略）

> 买短补长与额外购买在模型输出中统一用「购买区间 + 乘坐区间（ride）」表达（无独立补票段）。

> 换乘出题保证：**当天换乘**、后一趟发车时间 ≥ 前一趟到达时间 + 20 分钟、时间顺序正确（时间约束配置已整体移除）。

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

**分类依据**：题目的 `type` 字段（存在性 / 选择性；无旧题，不做 `interference_mode` 兜底）。分层判定：

| 层 | 存在性（`0_`/`1_`，答案唯一） | 选择性（`2_`，答案多个） |
|----|------------------------|------------------------|
| 层0 归一化 | `normalize_final_plan` 统一字段契约：兼容 `from/to` 与 `from_station_id/to_station_id`；分购票段/补票段；购买段缺 `ride` → `missing_ride`（**一律按不全处理，不兜底**）；缺关键字段/非对象 → `invalid_plan_item` | 同左 |
| 层1 余票/票价 | 购买区间查 DB 余票 ≥ 声称张数（否则 `hallucination`）+ 票价核验（`price_wrong`/`price_missing`）+ 张数 ≥ 人数（否则 `ticket_shortage`） | 同左 |
| 层2 | 与 `ground_truth` **完全一致**（车次+购买+座位+乘坐区间），否则 `route_mismatch` | **全程可达**（`_check_reachability`）：地点连续 + 时间衔接 + 覆盖出发/到达站；另按 `constraints` 硬校验（`no_transfer`/`no_short_buy_extra`） |
| 判定 | 无任何 issue → `pass`；否则 `hallucination` | 同左 |

**verdict 取值**：`pass`（全部通过）/ `hallucination`（任一 issue 即判错）/ `no_plan`（无任何可核查购票段）/ `empty_plan`（final_plan 为空数组，server 层判定）/ `db_not_found`（题目库不存在）。

> 出题端保存 `ground_truth`（含购买+乘坐的 id）至 `metadata` 供存在性对标；`metadata` 同时存 `start_station_id`/`end_station_id` 供可达性校验。

### 问题分类（前端按三组展示）

| 分组 | 类型 |
|------|------|
| 🚫 硬错误（方案不可行/编造） | `hallucination`、`price_wrong`、`route_mismatch`、`route_invalid`、`route_discontinuity`、`transfer_time_conflict`、`start_not_covered`、`end_not_covered`、`no_route`、`no_transfer_violated`、`no_short_buy_violated`、`no_extra_violated` |
| ⚠️ 约束（硬性约束不满足） | `ticket_shortage`、`price_missing` |
| 📝 格式/缺失 | `invalid_seat`、`invalid_plan_item`、`missing_ride` |

### 前端核查展示

测评页「代码核查」结果体系化展示：
- **模式徽章**：按 `type` 显示「存在性问题·答案唯一（对标标答）」/「选择性问题·答案多个（全程可达+行为约束）」
- **verdict 徽章**：✅全部通过 / ❌存在错误 / ⚠️最终方案为空 / ⚠️无可核查方案 / ❌数据库不存在
- **动态统计卡**：方案总数 + 余票通过（段级）+ 各问题类型动态聚合
- **明细表**：每段显示 车次 / 购买区间 / 乘坐区间（汉字）/ 座位 / 票数(声称/实际) / 票价(声称/实际) / 核对；购买≠乘坐时标注「买≠坐」
- **问题清单**：按 🚫硬错误 / ⚠️约束 / 📝格式 三组分组展示

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
- **完整性验证**（`verify_data`）：检查缺经停时间 `missing_stop_time`、缺电报码 `missing_station_id`、**跨天车次** `overnight_train_count`（相邻站 `stop_time` 时间倒退，违反当日完成约束；跨天车次用 `cleanup_overnight_trains.py` 清理）

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

> **配对一致性**：存在性题（`0_`/`1_`）按「基础题号 + 内容」分组（`0_34` 与 `1_34` 同组），**一份自然语言写回组内全部题目**，保证两者除干扰外完全一致；不同题号（如 34 与 35）即使内容相同也不合并；`--question` 指定任一变体时整组一起处理。

```bash
# 默认读取 .env 的 NL_API_KEY / DEFAULT_MODEL / DEFAULT_BASE_URL（无 key 时才交互填写；跳过已有 nl_question 的题目）
python nl_question.py

# 直接传 API Key（覆盖 .env）
python nl_question.py --api-key sk-xxx

# 指定模型与 API 地址（覆盖 .env）
python nl_question.py --model deepseek-chat --base-url https://api.deepseek.com

# 强制重新生成已有 nl_question 的题目
python nl_question.py --force

# 只处理指定题目（可多次指定；指定题即使已有 nl_question 也会重新生成）
python nl_question.py --question a1 --question a2
```

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--api-key` | 空（读 `.env` `NL_API_KEY`，无则交互填写） | 大模型 API Key |
| `--model` | 空（读 `.env` `DEFAULT_MODEL`，缺省 `deepseek-v4-flash`） | 模型名称 |
| `--base-url` | 空（读 `.env` `DEFAULT_BASE_URL`，缺省 `https://api.deepseek.com`） | OpenAI 兼容 API 地址 |
| `--force` | 关 | 强制重新生成已保存 `nl_question` 的题目（默认跳过） |
| `--question` | 无 | 只处理指定题目 ID，可多次指定（`--question a1 --question a2`）；指定题即使已有 `nl_question` 也会重新生成 |

**交互键位**（逐题生成，人工确认后保存）：

| 按键 | 行为 |
|------|------|
| `Enter` | 接受并保存当前生成 |
| `x` | 重新生成一条 |
| `n` | 跳过此题（不保存） |
| `Ctrl+C` | 中止整个脚本（已保存的不受影响） |

**约束传递（重要）**：`build_prompt` 会把题目的**需求人数 `people_count` 和答案票等级 `seat_type`** 一并传给模型（题目缺字段时自动回落默认 2 人 / 二等座）。提示词要求：
- 以**真实购票者身份**、自然口语化提问
- **自然隐含**人数与等级（如"我们五个同事…""带爸妈想躺一躺…"），**禁止**"买 X 张 / 买 X 等座"式硬性表达
- 内置 4 个 few-shot 示例；保留出发/到达站、不指定中间站、不泄露车票信息/策略

> 提示词模板 `NL_PROMPT_TEMPLATE` 为 `nl_question.py` 顶部独立常量，可自行修改。生成器只"知道"题目结构、题型与人数/等级约束，**不泄露车票存在信息**（不含 `answer` 标准路径）。

### ④ 清理数据不全车次 `cleanup_incomplete_trains.py`

```bash
python cleanup_incomplete_trains.py              # 一键执行：去重 → 补算 → 删除仍不全 → 重建 station_trains
python cleanup_incomplete_trains.py --check      # 只读体检（不写库）
python cleanup_incomplete_trains.py --fix        # 遗留：仅离线补算缺失的非相邻段票价
python cleanup_incomplete_trains.py --dedup      # 遗留：仅报告同车多号去重清单
python cleanup_incomplete_trains.py --interactive # 遗留：逐个确认删除
```

- **无参数即一键执行**：① 同车多号去重（12306 同物理列车多车次号，每组只保留一个主号，其余重复号 + 纯孤儿删除）→ ② 离线补算缺失的非相邻段票价（相邻段齐全可算）→ ③ 自动删除仍不全的车次（同步从 `trains`/`train_stops`/`prices`/`same_trains.json` 移除）→ ④ 重建 `station_trains` 物化视图
- `--check`：只读体检，仅列出待删清单与票价不全车次，不写库
- **数据完整性要求**：保证 `prices.db` 覆盖所有车次的所有区间票价——主核查代码（verifier）**不做数据防御**，`price_missing` 不应出现（出现即出题人数据没准备好，先跑本脚本清理）

### ⑤ 清理跨天车次 `cleanup_overnight_trains.py`

```bash
python cleanup_overnight_trains.py           # 只显示跨天车次
python cleanup_overnight_trains.py --apply   # 显示 + 删除
```

- 判定：车次内相邻经停站 `stop_time` 时间倒退（如 `23:20 → 00:07`）即跨到次日，违反**当日完成约束**
- `collector.py` 的 `verify_data` 会报告 `overnight_train_count`（跨天车次数），发现问题后用本脚本清理（删除跨天车次会同步从 prices.db / railway.db / same_trains.json 移除）

---

## 技术栈

- **后端**：FastAPI + uvicorn + SQLite
- **前端**：原生 HTML/JS/CSS（SPA）
- **爬虫**：requests
- **大模型接入**：OpenAI 兼容 API，通过工具调用交互

---

## 时间模型说明

**停车 = 发车（单一 `stop_time`）**：12306 每个经停站同时返回 `arrive_time` 与 `depart_time`（差为停站时长，通常 1~3 分钟、枢纽大站 ≤10 分钟）。本项目在采集层（`collector.py`）就合并为单一 `stop_time` 入库（优先级 到达 > 发车 > 始发 > 兜底；`arrive/depart/stop_duration` 不落库）→ 全系统无任何代码区分到达与发车。

**停站时长的影响：已完全排除（通过"合并"而非"建模"），且方向偏保守**：
- 换乘衔接 `gap = U.stop_time(M) − T.stop_time(M)`（两者都取到达）→ `真实衔接 = gap + 停站时长`，即 20 分钟最短换乘下限实际更严格，**永远不会把不可行方案判成可行**；
- 核查的换乘冲突 / 换乘时长同样按到达口径 → 偏严格；
- `/api/routes` 展示时长略偏大；首段出发站为中间站时，时间窗"出发"实为"到达"，偏差 ≤ 停站时长；
- 因 20 分钟下限远大于现实停站时长，这些 ± 误差不会翻转任何判定。

**跨天已单独排除**：`stop_time` 只存 `HH:MM` 无日期，所有时间差按当日解释；跨天车次由 `cleanup_overnight_trains.py` 全量清理 → "当日完成"成立。

> 若需精确建模：`train_stops` 加 `arrive_time`/`depart_time` 两列（爬虫已解析、只是没落库），当前无必要。

---
## 文档（docs/）

系统各环节的详细实现说明（面向评审）：

| 文档 | 说明 |
|------|------|
| [`docs/generator.md`](docs/generator.md) | 出题逻辑：核心出题流程、012 题型变体、metadata 存储 |
| [`docs/scripts.md`](docs/scripts.md) | 系统小脚本：collector / price_collector / cleanup_* / nl_question 的用途、用法与产物 |
| [`docs/tester.md`](docs/tester.md) | 测试器与 AI 对话：工具调用循环、SSE 流式、final_plan 解析 |
| [`docs/verifier.md`](docs/verifier.md) | 测评核查：存在性对标 / 选择性全程可达、问题分类与判定 |
| [`docs/stats.md`](docs/stats.md) | 统计与对比：verdict 判定、评分、多维对比与报告 |

---

## 备注
- 题目前缀：`0_`=存在性无干扰（唯一解）、`1_`=存在性伪干扰（唯一解）、`2_`=选择性真干扰（多解）；前缀由系统自动添加，与输入无关
- 题目分类按 metadata `type`（存在性/选择性），核查方式由此确定（存在性对标标答 / 选择性全程可达）
