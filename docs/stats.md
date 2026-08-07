# 测评统计与对比分析说明（stats.md）

> 面向评审。说明系统如何基于**核查结果**（verifier.md 的 verdict 与 issues）汇总统计指标、评分与多维对比。

---

## 一、统计概述

- **数据来源**：`logs/result/` 中的测评结果文件（每条含 `verification` 字段，即核查输出）
- **核心原则**：统计的对错判定与评分**直接采用核查的 verdict 与 issues**，保证统计结论与核查结论一致（修复了旧版用 `hallucination_count` 判错导致的错位）
- **模块**：`statistics/aggregator.py`（汇总）、`statistics/comparer.py`（对比）、`statistics/reporter.py`（报告）

---

## 二、对错判定（核心）

| verdict | 含义 | 统计归类 |
|---|---|---|
| `pass` | 核查通过（无任何问题） | **正确** |
| `hallucination` | 存在任一核查问题 | **错误** |
| `no_plan` | 有方案但无任何可核查购票段 | 未规划 |
| `empty_plan` | 模型未输出 final_plan（空方案） | 空方案 |
| `db_not_found` | 题目数据库缺失 | 数据缺失（不计入模型错误） |

> 旧版问题：用 `verification.hallucination_count > 0` 判错，但该计数只统计"余票不符"，导致「乘坐不连续/换乘冲突/缺乘坐区间」等错误方案被统计为正确。新版已改为按 **verdict** 判定。

---

## 三、评分（0~100）

| 情况 | 得分 |
|---|---|
| `pass` | **100** |
| `hallucination` | **100 − 问题扣分**（下限 0） |
| `no_plan` / `empty_plan` / `db_not_found` | **0** |

**问题扣分**（按问题类型严重度）：

| 分组 | 类型 | 每项扣分 |
|---|---|---|
| 🚫 硬错误 | 余票不符、票价不符、路线不符标答（含 4 细分）、区间无效、乘坐不连续、换乘时间冲突、未连接出发站/到达站、无法构成全程 | **−20** |
| ⚠️ 约束 | 出发/到达时间不符、换乘时间不足/过长、票数不足、票价缺失 | **−10** |
| 📝 格式/缺失 | 缺乘坐区间、无效座位、无效条目 等 | **−5** |

> 评分由统计端基于 `verification` 实时计算，不依赖前端写入的 `score_summary.normalized`（旧版该字段恒为 0 导致平均分失真）。

---

## 四、汇总指标（aggregator）

对每个模型（及全局）计算：

| 指标 | 含义 |
|---|---|
| `total_tests` | 测评总数 |
| `completion_rate` | 完成率（测试状态 success 占比） |
| `pass_rate` | 通过率（verdict = pass 占比） |
| `error_rate` | 错误率（verdict = hallucination 占比） |
| `no_plan_rate` / `empty_rate` | 未规划 / 空方案占比 |
| `avg_score` | 平均分（按第三节评分） |
| `issue_type_counts` | 各问题类型出现次数分布 |
| `avg_tokens` / `avg_duration` / `avg_tool_calls` | 从对应测试记录（`logs/test/`）读取 |

---

## 五、对比分析（comparer）

| 维度 | 说明 |
|---|---|
| 按模型（`compare_by_model`） | 各模型指标对比与排名 |
| 按题目类型（`by_type`） | 存在性 / 选择性的通过率、错误率、平均分 |
| 按题型（`by_question_type`） | transfer / short_buy / extra_front / extra_rear / mixed |
| 按干扰密度 | 预留接口（需 metadata 记录干扰密度） |

> 旧版按 question_id 前缀推断题型，新前缀 `0_`/`1_`/`2_` 全部归 unknown；新版改为**从 metadata.json 读取** `type`（存在性/选择性）与 `question_type`（题型）分组。

---

## 六、报告（reporter）

- `generate_report()`：生成 JSON 报告（模型排名、题型/题目类型分析、错误率警告、自动洞察）
- `export_markdown()` / `export_markdown_to_file()`：导出 Markdown 报告
- 保存到 `logs/report/`
- 洞察示例：模型排名、题型从易到难排序、题目类型（存在性/选择性）对比、各模型最高/最低分

---

## 七、前端统计页

- **统计卡片**：总测试数 / 平均分 / 通过率 / 错误率 / 完成率
- **模型对比表**：通过率、错误率、未规划/空数量、平均分、Token、耗时
- **问题分布**：全局各问题类型出现次数（top10）
- 模型排名、导出 JSON / Markdown

---

*文档版本：2026-08-07 · 对应实现：statistics/aggregator.py、statistics/comparer.py、statistics/reporter.py、static/app.js（统计页）、templates/index.html（统计页容器）*
