# 自动出题器重构 —— 最终执行规格书

**版本**：v2.0-final  
**状态**：定稿，可交付编码  
**核心原则**：空行即 0 票（稀疏存储）；自动出题只写合法解 + 执行题型封锁；不生成任何随机干扰项。


## 一、改造范围

| 文件 | 改动程度 | 说明 |
|------|---------|------|
| `database.py` | 中 | `update_ticket` 支持 DELETE；`get_train_tickets_filtered` 空行返回 0；`init_question_station_pairs` 改为仅建空表 |
| `server.py` （`/api/auto_generate`） | 大 | 重写合法解写入、封锁逻辑、唯一性自检；删除所有干扰项生成代码 |
| `verifier.py` | 无改动 | 自动适配（空行被判定为 0 票） |


## 二、数据库层改造细则

### 2.1 `update_ticket(conn, train_num, from_id, to_id, seat_type, tickets)`

| 条件 | 执行 SQL |
|------|---------|
| `tickets > 0` | `INSERT OR REPLACE INTO {seat_type} (train_num, from_station_id, to_station_id, tickets) VALUES (?, ?, ?, ?)` |
| `tickets == 0` | `DELETE FROM {seat_type} WHERE train_num=? AND from_station_id=? AND to_station_id=?` |

### 2.2 `get_train_tickets_filtered(conn, train_num, from_id, to_id, seat_types)`

- 执行 `SELECT tickets FROM {table} WHERE ...`
- 若 `cursor.fetchone()` 返回 `None` → 该组合视为 **余票 = 0**（不返回该键或返回 0）
- **禁止**为返回 0 而插入任何行。

### 2.3 `init_question_station_pairs` → 改名为 `reset_question_tables`

新功能：
1. 如果表不存在则创建。
2. 如果表存在则执行 `DELETE FROM class0; DELETE FROM class1; DELETE FROM class2;`（清空所有行）。
3. 重建索引（可选）。

**删除**：所有遍历车次插入 0 的循环。


## 三、自动出题器主流程（`/api/auto_generate`）

### 3.1 参数处理

```python
# 请求参数（保持不变）
question_type: str   # direct | same_train | transfer | short_buy | mixed
from_station_id: str
to_station_id: str
solution_ticket_min: int = 1
solution_ticket_max: int = 5
mixed_strategies: List[str] = []   # 仅 mixed 类型使用
output_prefix: str = "q_"
seed: Optional[int] = None

# 注意：interference_density 保留在参数中（为兼容前端），但内部完全不使用
```

### 3.2 主流程伪代码

```python
def auto_generate(req):
    # Step 0: 固定随机种子
    if req.seed is not None:
        random.seed(req.seed)

    # Step 1: 获取基础数据连接，解析车站 ID
    rw_conn = get_railway_conn()
    from_id = resolve_station_name_or_id(rw_conn, req.from_station_id)
    to_id = resolve_station_name_or_id(rw_conn, req.to_station_id)

    # Step 2: 选择目标车次 T（从经过 A 和 B 的车次中随机选一个）
    routes = get_routes_between(rw_conn, from_id, to_id)
    if not routes:
        raise HTTPException(400, "没有经过 A 和 B 的车次")
    target = random.choice(routes)
    target_train_num = target["train_num"]
    stops = get_train_stops(rw_conn, target_train_num)  # 按 stop_no 升序
    stop_ids = [s["station_id"] for s in stops]
    from_idx = stop_ids.index(from_id)
    to_idx = stop_ids.index(to_id)
    if from_idx > to_idx:
        # 如果方向反了，交换（确保 from 在前）
        from_id, to_id = to_id, from_id
        from_idx, to_idx = to_idx, from_idx

    # Step 3: 创建空题目数据库（三张空表）
    question_id = f"{req.output_prefix}{timestamp}"
    db_path = create_question_db(question_id)   # 只建表，不插入任何行
    q_conn = sqlite3.connect(db_path)

    try:
        # Step 4: 根据题型写入合法解
        write_legal_solution(
            q_conn, rw_conn,
            question_type=req.question_type,
            train_num=target_train_num,
            stops=stops,
            from_id=from_id, to_id=to_id,
            from_idx=from_idx, to_idx=to_idx,
            ticket_min=req.solution_ticket_min,
            ticket_max=req.solution_ticket_max,
            mixed_strategies=req.mixed_strategies,
        )

        # Step 5: 执行题型专属封锁（直达题型跳过封锁）
        if req.question_type != "direct":
            apply_blocking_rules(
                q_conn, rw_conn,
                question_type=req.question_type,
                train_num=target_train_num,
                stops=stops,
                from_id=from_id, to_id=to_id,
                from_idx=from_idx, to_idx=to_idx,
                mixed_strategies=req.mixed_strategies,
            )

        # Step 6: 唯一性自检（非直达题型强制校验）
        if req.question_type != "direct":
            path_count = count_valid_paths(q_conn, rw_conn, target_train_num, from_id, to_id)
            if path_count != 1:
                # 回滚并报错，避免生成语义不纯的题目
                q_conn.rollback()
                raise HTTPException(500, f"唯一性校验失败：发现 {path_count} 条路径，期望 1 条")

        q_conn.commit()

        # Step 7: 更新元数据
        update_question_metadata(question_id, status="completed", train_count=total_trains)

        # Step 8: 构造返回
        return {
            "success": True,
            "question_id": question_id,
            "preview": build_preview(...),
        }
    finally:
        q_conn.close()
        rw_conn.close()
```


## 四、合法解写入规则（`write_legal_solution`）

按 `question_type` 分别写入正数票，座位类型默认写入 `class2`（二等座），也可随机取一个座位类型。

| 题型 | 写入的票（正数，1~5 张） |
|------|------------------------|
| **direct** | `(T, A → B)` |
| **same_train** | `(T, A → M)` 和 `(T, M → B)`，M 从 `(from_idx, to_idx)` 区间随机选一个中间站 |
| **transfer** | `(T, A → M)` 和 `(U, M → B)`，M 从 `(from_idx, to_idx)` 区间随机选；U 是另一趟经过 M 且能去 B 的车次（需校验 T 到 M 时间早于 U 从 M 出发且间隔 ≥ 20 分钟） |
| **short_buy** | `(T, A → M)`，M 从 `(from_idx, to_idx)` 区间随机选一个中间站；`(T, M → B)` 不写 |
| **mixed** | 按 `mixed_strategies` 顺序串联，每段写入正数票。例如 `["same_train", "transfer"]` 表示：先执行 same_train 写入两段，再执行 transfer 写入后续两段（含另一车次）。每段衔接站需连续。 |


## 五、题型专属封锁规则（`apply_blocking_rules`）

**重要**：此函数只在目标车次 `T` 上执行 `DELETE` 操作，不涉及其他车次。封锁的目标是 **删除那些会导致“逃逸”的票**。

### 5.1 同车换乘（same_train）

需要在 T 上删除以下所有组合：

```
DELETE FROM class0/1/2 WHERE train_num = T AND from_station_id = A AND to_station_id = B
```

以及，对于 T 上任意中间站 `M_k`（`from_idx < k < to_idx`）：

```
DELETE FROM class0/1/2 WHERE train_num = T AND from_station_id = A AND to_station_id = M_k
DELETE FROM class0/1/2 WHERE train_num = T AND from_station_id = M_k AND to_station_id = B
```

> 目的：禁止买短补长逃逸（A→M_k + M_k→B 有票会形成替代路径）。

**保留**的唯一路径：`A → M_target` + `M_target → B`（已写入合法解）。

### 5.2 换乘（transfer）

需要在 T 上删除：

```
DELETE FROM class0/1/2 WHERE train_num = T AND from_station_id = A AND to_station_id = B
```

以及，对于 T 上任意中间站 `M_k`（`from_idx < k < to_idx`）：

```
DELETE FROM class0/1/2 WHERE train_num = T AND from_station_id = A AND to_station_id = M_k
DELETE FROM class0/1/2 WHERE train_num = T AND from_station_id = M_k AND to_station_id = B
```

> 目的：同时禁止直达、买短补长、同车换乘。逼模型只能去换乘另一趟车 U。

**保留**的唯一路径：`T(A → M_target)` 有票，换乘 U 后 `U(M_target → B)` 有票。

### 5.3 买短补长（short_buy）

需要在 T 上删除：

```
DELETE FROM class0/1/2 WHERE train_num = T AND from_station_id = A AND to_station_id = B
```

以及，对于 T 上任意中间站 `M_k`（`from_idx < k < to_idx`），**如果 `M_k != M_target`**（即不是我们设计补票的那个中间站）：

```
DELETE FROM class0/1/2 WHERE train_num = T AND from_station_id = A AND to_station_id = M_k
DELETE FROM class0/1/2 WHERE train_num = T AND from_station_id = M_k AND to_station_id = B
```

> 目的：只保留唯一合法的“买短”路径：A→M_target 有票（已写入），M_target→B 空行（补票段）。其他中间站的组合全部删除，防止模型用其他中间站做同车换乘或买短补长。

### 5.4 混合（mixed）

根据 `mixed_strategies` 的串联顺序，逐段识别“哪些中间站是合法路径上的节点”，然后删除 T 上所有 **不在合法路径节点上的** `(A → M_k)` 和 `(M_k → B)` 组合。

同时删除 `(A → B)`。

> 目的：确保模型必须严格按照串联顺序走，无法跳过任何一段。


## 六、唯一性自检（`count_valid_paths`）

在提交数据前，模拟模型可能调用的工具，计算从 A 到 B 的可行路径数量。

**检测范围**：
- 仅检测目标车次 T 上的路径（不检测其他车次，因为换乘题的第二程在其他车次上，其唯一性由时间约束保证）。
- 路径定义：从 A 出发，经过 T 的若干中间站 M1, M2, ... 最终到达 B，且每段 `(X → Y)` 在数据库中有正数票。

**实现**（简化版）：
```python
def count_valid_paths(q_conn, train_num, from_id, to_id):
    # 从数据库中查出 T 的所有有票区间
    cursor.execute("""
        SELECT from_station_id, to_station_id, tickets
        FROM class2 WHERE train_num = ? AND tickets > 0
        UNION ... (class1, class0)
    """, (train_num,))
    edges = cursor.fetchall()  # [(from, to, tickets), ...]

    # 在 T 的有向无环图（按 stop_no 天然有序）上做 DP
    # 统计从 from_id 到 to_id 的路径数量
    # 路径数 >= 1 即为合法
    return path_count
```

**判定**：
- `direct` 题型：`path_count >= 1` 即通过（不强制唯一）。
- 其他题型：`path_count == 1` 必须成立，否则抛错重试。


## 七、预览输出（`preview`）

返回结构必须包含人类可读的路径描述，方便人工核验：

```json
"preview": {
    "question_type": "same_train",
    "target_train_num": "G123",
    "path_description": "乘坐 G123 从 北京南 到 济南西（有票），同车继续从 济南西 到 上海虹桥（有票）",
    "solution_segments": [
        {"train_num": "G123", "from": "北京南", "to": "济南西", "tickets": 3, "seat": "二等座"},
        {"train_num": "G123", "from": "济南西", "to": "上海虹桥", "tickets": 2, "seat": "二等座"}
    ],
    "blocked_escapes": [
        "已删除 G123 上 北京南→上海虹桥 的直达票",
        "已删除 G123 上 北京南→南京南 和 南京南→上海虹桥 的组合票"
    ]
}
```


## 八、前端界面联动（供参考）

| 界面 | 影响 |
|------|------|
| 自动出题 | 移除“干扰密度”滑块（或置灰），移除“预加载”按钮，增加“严格模式”开关（控制是否执行封锁，直达除外） |
| 手动出题 / 改题 | 保留“逐条增删改票”功能，保留“添加干扰项”的精细控制，保留“严格封锁”的独立开关 |

---

**文档完毕，可交付编码。**