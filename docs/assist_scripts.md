# 辅助小工具（assist/）使用说明

`assist/` 目录与 `docs/` 同级，存放三个命令行小 Excel 工具，全部在终端中运行，
输出 Excel 默认放在**本脚本所在目录（assist/）**，也可用 `-o` 指定任意路径。

> 依赖：`openpyxl` + 项目基础数据库 `data/railway.db`（需先运行 `collector.py` 采集过数据）。
> 推荐使用 conda 解释器运行：`C:\vscode_py\.conda\python.exe`（已装 openpyxl）。

---

## 一、assist/station_stop_counts.py —— 统计每个站的停车数

统计每个车站被多少车次停靠（不同车次数）+ 停靠总次数，导出 Excel。

```
python assist/station_stop_counts.py [-o 输出.xlsx] [--db 基础数据库路径]
```

参数：

| 参数 | 说明 |
|---|---|
| `-o, --output` | 输出 Excel 路径（默认 `assist/station_stop_counts.xlsx`） |
| `--db` | 基础数据库路径（默认 `data/railway.db`） |

输出 Excel 列：

1. 站名
2. 站ID（电报码）
3. 停车数（停靠该站的不同车次数，`DISTINCT train_num`）
4. 停靠总次数（含车次重复出现的经停记录数）

默认按停车数降序排列。

示例：

```
python assist/station_stop_counts.py
# → 生成 assist/station_stop_counts.xlsx（郑州东 698 次居首）
```

---

## 二、assist/station_pair_check.py —— 站对检查（直达 / 换乘）

输入一个 Excel（站对表，格式同 2.xlsx：每行 [出发站, 到达站]），输出一个 Excel，
在**第三、四列**展示：是否有直达车、是否能通过换乘实现。

```
python assist/station_pair_check.py 输入站对表.xlsx [-o 输出.xlsx] [--db 基础数据库路径] [--min-gap 20] [--max-attempts 15]
```

参数：

| 参数 | 说明 |
|---|---|
| `input` | 输入站对表 Excel（每行两列：出发站、到达站；站名或电报码均可；空行与同站对自动跳过） |
| `-o, --output` | 输出 Excel 路径（默认 `assist/station_pair_check_out.xlsx`） |
| `--db` | 基础数据库路径（默认 `data/railway.db`） |
| `--min-gap` | 换乘衔接最短分钟（默认 20，与自动出题固定一致） |
| `--max-attempts` | 候选首程车 T 的最大重试数（默认 15，与自动出题一致） |

输出 Excel 列：

1. 出发站（原文）
2. 到达站（原文）
3. **是否有直达车**（是/否）
4. **是否能通过换乘实现**（是/否）
5. 直达车次列表（有直达时顿号分隔；否则留空）
6. 示例换乘方案（能换乘时为「T 车次 A→M 换 U 车次 M→B」；否则留空）
7. 备注（站不存在等说明）

**换乘判定与自动出题完全一致**（算法同 `server.py`）：

- 候选首程车 T：经过出发站 A、**不经过**到达站 B（防直达逃逸）、A 之后至少还有中间站
- 中间站与到达站 B 同城者被排除（与自动出题一致）
- 对每个 T 枚举全部中间站 M，找二程车 U：U 经过 M 且在 M 之后经过 B、U ≠ T、
  且 T 到达 M 的时刻 + `--min-gap` ≤ U 从 M 出发的时刻
- **重试次数与自动出题相同**：外层对候选 T 至多重试 `min(len(T候选), --max-attempts)` 辆
  （默认 15），任一成功即判「能换乘」

示例：

```
python assist/station_pair_check.py 我的站对表.xlsx
# → 生成 assist/station_pair_check_out.xlsx
#   第 3 列=是否有直达车，第 4 列=是否能通过换乘实现
```

---

## 三、assist/train_stops_export.py —— 导出车次停站序列

输入一个 Excel（第一列为一竖列车号），输出一个 Excel：第一列保留车号，
后面跟着该车次的停站序列（站名按途经顺序逐列展开）。

```
python assist/train_stops_export.py 输入车号表.xlsx [-o 输出.xlsx] [--db 基础数据库路径]
```

参数：

| 参数 | 说明 |
|---|---|
| `input` | 输入车号表 Excel（第一列每一行一个车次号，如 G1、G2…；多余列忽略） |
| `-o, --output` | 输出 Excel 路径（默认 `assist/train_stops_export_out.xlsx`） |
| `--db` | 基础数据库路径（默认 `data/railway.db`） |

输出 Excel 列：

1. 车次号（原文）
2. 经停站数
3. 停站1（第 1 站站名）
4. 停站2（第 2 站站名）
5. … 依序到最后一站
6. 备注（车次不存在时标注「车次不存在」）

示例：

```
python assist/train_stops_export.py 我的车号表.xlsx
# → 生成 assist/train_stops_export_out.xlsx
#   G1 → 北京南、沧州、德州东、曲阜东、南京南、苏州北、上海虹桥
```

---

## 常见问题

- **基础数据库不存在**：先运行 `collector.py` 采集数据生成 `data/railway.db`。
- **站对解析失败（备注列）**：站名或电报码在库中不存在，检查输入拼写。
- **车次不存在（脚本三备注列）**：输入的车次号不在 `trains` 表中。