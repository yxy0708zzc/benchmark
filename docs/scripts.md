# 系统小脚本说明（scripts.md）

> 面向评审。集中说明项目中各**独立小脚本**（数据爬取 / 数据清理 / 题目自然语言化）的用途、用法与产物。
> 主服务 `server.py` 与各模块（`database` / `config` / `verifier` / `prompts` / `tools` / `statistics`）见 README 与 `generator.md` / `tester.md` / `verifier.md` / `stats.md`。

---

## 一、脚本总览

| 脚本 | 作用 | 产物 |
|---|---|---|
| `collector.py` | 基础数据爬虫（车站 / 车次 / 经停站） | `data/railway.db` + `data/same_trains.json` |
| `price_collector.py` | 票价爬虫（相邻站对票价，含并发 / 断点） | `data/prices.db` |
| `cleanup_incomplete_trains.py` | 一键清理：同车多号去重 + 票价不全车次（补算 / 删除） | 删除后重建 `station_trains` |
| `cleanup_overnight_trains.py` | 清理跨天车次（当日完成约束） | 删除后重建 `station_trains` |
| `nl_question.py` | 题目自然语言化（命令行，人工确认） | `question/metadata.json` 的 `nl_question` 字段 |

**推荐数据准备流水线**（顺序）：

```bash
python collector.py                          # 1. 基础数据（车站/车次/经停站）
python price_collector.py --workers 4        # 2. 票价（并发 3~5）
python cleanup_overnight_trains.py --apply   # 3. 清理跨天车次
python cleanup_incomplete_trains.py           # 4. 一键清理：同车多号去重 → 补算缺失票价 → 删除仍不全车次
python nl_question.py                        # 5.（可选）题目自然语言化
python server.py                             # 6. 启动服务
```

---

## 二、collector.py —— 基础数据爬虫

**作用**：抓取 12306 车站、G 车次、经停站数据，构建基础数据库。

**用法**：无命令行参数，直接 `python collector.py`。

**执行流程（7 阶段）**：
1. 初始化数据库（建 `stations / trains / train_stops / station_trains` 四表）；
2. 采集车站列表（`station_name.js`）→ `stations` 表；
3. 初始化 HTTP Session（取 Cookie）；
4. 通过 search API 枚举 G 车次 `train_no` → `trains` 表（12306 已废弃旧的车站大屏接口，改用 `search.12306.cn/search/v1/train/search`）；
5. 遍历车次采集经停站 → `train_stops` 表；
6. 物化 `station_trains` 表 + 构建同车多号映射（`data/same_trains.json`）；
7. 数据完整性验证并输出报告（缺经停时间 / 跨天等）。

**产物**：`data/railway.db`（`stations`、`trains`、`train_stops`、`station_trains`）、`data/same_trains.json`。

**注意**：内置反爬限速（`config.CRAWLER_CONFIG`：请求间隔、重试、批量休眠）。数据更新时重跑即可。

---

## 三、price_collector.py —— 票价爬虫

**作用**：通过 12306 `queryAllPublicPrice` 接口爬取每趟车**相邻站对**各席别票价 → `prices` 表（`data/prices.db`）。

**用法**：

| 命令 | 说明 |
|---|---|
| `python price_collector.py` | 全量爬取，跑完自动计算非相邻段票价 |
| `python price_collector.py --resume` | 断点续爬（跳过已完成的） |
| `python price_collector.py --supplement` | 补充模式：仅爬缺失站对，不删已有数据 |
| `python price_collector.py --train G1` | 仅爬指定车次 |
| `python price_collector.py --workers 4` | 并发线程数（默认 1，建议 3~5） |

**其他**：支持优雅退出——`Ctrl+C` 第一次保存进度退出，再按一次强制退出；同车多号（`same_trains.json`）会复用已爬票价。

**产物**：`data/prices.db`（`prices` 表：`train_num / from / to / seat / price / crawl_date`，唯一键 `(train,from,to,seat)`）。

---

## 四、cleanup_incomplete_trains.py —— 清理票价不全车次

**作用**：检查每趟车的票价数据完整性（应有站对 = `C(经停站数, 2)`，实际站对是否齐全），对不全车次处理。

**用法（已简化，无参数即一键执行）**：

| 命令 | 说明 |
|---|---|
| `python cleanup_incomplete_trains.py` | **一键执行**：① 同车多号去重 → ② 离线补算缺失票价 → ③ 删除仍不全车次 → ④ 重建 `station_trains` |
| `python cleanup_incomplete_trains.py --check` | **只读体检**：同车多号待删清单 + 票价不全车次（不写库） |
| `python cleanup_incomplete_trains.py --apply` | 兼容：与无参数等价的一键执行 |
| `python cleanup_incomplete_trains.py --fix` | 遗留：仅离线补算缺失的**非相邻段**票价，再报告 |
| `python cleanup_incomplete_trains.py --dedup` | 遗留：仅报告同车多号去重待删清单 |
| `python cleanup_incomplete_trains.py --interactive` | 遗留：逐个展示完整性详情，`y` 删除 / `n` 跳过 |

**一键清理（默认 / `--apply`）包含**：
1. **同车多号去重**——12306 会把同一列物理列车以多个车次号列出（`collector` 按「经停序列+时刻完全一致」归组到 `data/same_trains.json`）。重复号只写进了 `train_stops`（查得到车、查不到票价），`trains / prices` 只保留其中一个号。每组保留**票价记录最多**的主号（并列取字典序最小），其余重复号 + 不在任何同车组的纯孤儿全部删除，使系统里每辆物理列车**只保存一个车次号**。
2. **离线补算**缺失的非相邻段票价（相邻段齐全可算）。
3. **自动删除**仍不全的车次（删除会连同 `trains / train_stops / prices` 一起清、同步 `same_trains.json`）。
4. **重建 `station_trains`** 物化视图。

**注意**：缺失**相邻段**票价的无法离线补算，需联网补爬（`price_collector.py --supplement`）。去重清单只读函数 `find_duplicate_trains()` 可被其他脚本复用。

---

## 五、cleanup_overnight_trains.py —— 清理跨天车次

**作用**：清理**跨天车次**（保证"当日完成"约束）。判定依据：相邻经停站 `stop_time` 时间倒退（如 `23:20 → 00:07`）。

**用法**：

| 命令 | 说明 |
|---|---|
| `python cleanup_overnight_trains.py` | 仅显示跨天车次（不删除） |
| `python cleanup_overnight_trains.py --apply` | 执行删除并重建 `station_trains`，随后复查 |

---

## 六、nl_question.py —— 题目自然语言化（命令行）

### 6.1 作用

把 `question/metadata.json` 中僵硬的行程表述 `question`（如 `"北京南到上海虹桥"`）转化为**真实购票者口吻**的自然语言需求，写回 `nl_question` 字段（原 `question` 保留）。测试器加载题目时前端用它自动填充对话输入框。

### 6.2 用法

| 命令 | 说明 |
|---|---|
| `python nl_question.py` | 默认读 `.env`（`NL_API_KEY`/`NL_MODEL`→`DEFAULT_MODEL`/`NL_BASE_URL`→`DEFAULT_BASE_URL`），无 key 才交互填写；跳过已有 `nl_question` 的题 |
| `python nl_question.py --api-key sk-xxx` | 直接传 API Key |
| `python nl_question.py --model ... --base-url ...` | 指定模型与接口地址 |
| `python nl_question.py --force` | 强制重新生成已有 `nl_question` 的题 |
| `python nl_question.py --question a1 --question a2` | 只处理指定题（可多次指定，即使已有也处理） |

交互键位：`Enter` 保存 / `x` 重新生成 / `n` 跳过 / `Ctrl+C` 中止（已保存的不受影响）。

### 6.3 给模型传的参数

**提示词内（`build_prompt`，来自 metadata）**：

| 参数 | 取值 | 用处 |
|---|---|---|
| `question` | 如 `北京南到上海虹桥` | 要求模型保留出发/到达站 |
| `people_count` | 缺省随机 3~6 | 要求自然隐含人数 |
| `seat_label` | `seat_type` 经 `SEAT_LABELS` 映射（二等/一等/特等座） | 要求自然隐含座位偏好 |
| `criterion_block` | **仅选择性题**（`criterion` 存在才传）：经 `CRITERION_LABELS` 映射（综合考虑/最快/最便宜/出发最晚/最早到达）拼成一行 | 要求自然隐含评判标准（提示词规则 11：用"综合考虑看看""越快越好""实惠点就行""尽量晚点出发""尽量早点到"等口语带出，不报硬性指令） |
| `constraint_block` | **仅选择性题**（`constraints` 非空才传）：经 `CONSTRAINT_LABELS` 映射（不允许换乘 / 不允许买短补长与额外购买）拼成一行 | 要求自然隐含行为约束（提示词规则 12：用"别整换乘那套""不要买短补长的票""不要买长坐短"等口语带出，不报硬性指令） |

**API 请求体（`generate_nl`）**：`model`（默认 `deepseek-v4-flash`）、`messages`（单轮 user）、`temperature=1.9`（提高多样性）、`timeout=60s`。

**刻意不传（防泄露）**：题型、分段策略、标准路径、`answer`、任何车票/余票信息——生成器只"知道"行程、人数、座位等级（以及选择性的评判标准/行为约束），保证生成的购票需求不含题目答案线索。

### 6.4 落盘

```json
{ "question": "北京南到上海虹桥", "nl_question": "……", ... }
```

### 6.5 无用 / 已清理代码（2026-08-10）

| 位置 | 问题 | 处置 |
|---|---|---|
| `import random` | 全脚本未使用 | 已删除 |
| `TYPE_LABELS` 的用法 | 原传 `entry.get("type")`（存在性/选择性），查不到键 → 恒走兜底 | 已改为按 `entry.get("question_type")`（题型）显示 |
| `if qid in entry and ...` | `qid in entry` 恒为 False → 「已有自然语言」永不显示 | 已改为 `if entry.get("nl_question")` |

### 6.6 存在性配对一致性（0_ / 1_ 共用一份自然语言）

为保证 `0_` / `1_` **除干扰外完全一致**，生成时按「基础题号 + 内容」分组：

- 存在性题（metadata `type=存在性`）以 `(基础题号, question, people_count, seat_type, 评判标准, 行为约束)` 为 key 分组；**基础题号** = 去掉 `0_`/`1_` 前缀（`0_34` 与 `1_34` 同为基础 34）—— 只让同一道题的 `0_`/`1_` 配对共享，**不同题号即使内容相同也不合并**；
- 同组只调一次 LLM、人工确认一次，把同一段 `nl_question` **写回组内全部题目**（如 `0_xxx` 与 `1_xxx` 同文案）；
- 目标筛选按“组”进行：`--question` 指定任一变体 → 整组处理；默认 → 组内任一无 `nl_question` 则整组重新生成（保证成对一致）；
- 选择性 `2_` 无配对，每题独立生成。

---

## 七、脚本间关系

```
collector.py ──► data/railway.db + same_trains.json
price_collector.py ──► data/prices.db
cleanup_*.py ──► 清洗 railway.db / prices.db（保证完整性 + 当日完成）
nl_question.py ──► question/metadata.json 的 nl_question 字段（供测试器前端填充）
server.py ──► 读取以上全部数据，提供出题/测试/测评/统计
```

---

*文档版本：2026-08-12 · 对应实现：collector.py / price_collector.py / cleanup_incomplete_trains.py / cleanup_overnight_trains.py / nl_question.py*
