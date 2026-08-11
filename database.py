"""
数据库初始化与管理模块
创建和管理所有数据表

包含：
- 基础数据库 data/railway.db（stations, trains, train_stops, station_trains）
- 题目数据库 question/qXXX.db（class0, class1, class2）
- 目录自动创建、元数据管理
"""

import sqlite3
import json
import os
from typing import List, Tuple, Optional, Dict
from datetime import datetime

from config import (
    RAILWAY_DB_PATH, PRICES_DB_PATH, METADATA_PATH, ensure_directories,
    get_question_db_path, QUESTION_CONFIG
)


# ============================================================
# 基础数据库（data/railway.db）操作
# ============================================================

def init_railway_db() -> sqlite3.Connection:
    """
    初始化基础数据库，创建四张核心表
    返回数据库连接对象
    """
    ensure_directories()
    conn = sqlite3.connect(RAILWAY_DB_PATH)
    conn.execute("PRAGMA foreign_keys = ON")
    cursor = conn.cursor()

    # --- stations 表：车站概览 ---
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS stations (
            station_id TEXT PRIMARY KEY,
            station_name TEXT NOT NULL
        )
    """)

    # --- trains 表：车次概览 ---
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS trains (
            train_num TEXT PRIMARY KEY,
            train_no TEXT UNIQUE NOT NULL
        )
    """)

    # --- train_stops 表：车次经停站详情 ---
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS train_stops (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            train_num TEXT NOT NULL,
            stop_no INTEGER NOT NULL,
            station_id TEXT NOT NULL,
            station_name TEXT NOT NULL,
            stop_time TEXT NOT NULL,
            FOREIGN KEY (train_num) REFERENCES trains(train_num) ON UPDATE CASCADE,
            FOREIGN KEY (station_id) REFERENCES stations(station_id) ON UPDATE CASCADE,
            UNIQUE(train_num, stop_no)
        )
    """)

    # --- train_stops 表索引 ---
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_train_stops_train_num
        ON train_stops(train_num)
    """)
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_train_stops_station_id
        ON train_stops(station_id)
    """)

    # --- station_trains 表：车站经停车次（物化视图） ---
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS station_trains (
            station_id TEXT PRIMARY KEY,
            station_name TEXT NOT NULL,
            data TEXT NOT NULL,
            FOREIGN KEY (station_id) REFERENCES stations(station_id) ON UPDATE CASCADE
        )
    """)

    conn.commit()
    return conn


def init_prices_table():
    """
    初始化 prices 表（在 data/prices.db 中创建）。
    """
    ensure_directories()
    conn = sqlite3.connect(PRICES_DB_PATH)
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS prices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            train_num TEXT NOT NULL,
            from_station_id TEXT NOT NULL,
            to_station_id TEXT NOT NULL,
            seat TEXT NOT NULL,
            price REAL NOT NULL,
            crawl_date TEXT NOT NULL,
            UNIQUE(train_num, from_station_id, to_station_id, seat)
        )
    """)
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_prices_train_num
        ON prices(train_num)
    """)
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_prices_station_pair
        ON prices(from_station_id, to_station_id)
    """)
    conn.commit()
    conn.close()


def save_price(conn: sqlite3.Connection, train_num: str,
               from_id: str, to_id: str, seat: str, price: float):
    """写入一条票价记录"""
    cursor = conn.cursor()
    today = datetime.now().strftime("%Y-%m-%d")
    cursor.execute("""
        INSERT OR REPLACE INTO prices
        (train_num, from_station_id, to_station_id, seat, price, crawl_date)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (train_num, from_id, to_id, seat, price, today))


def get_price(conn: sqlite3.Connection, train_num: str,
              from_id: str, to_id: str, seat: str) -> Optional[float]:
    """查询某一站对某一席别的票价"""
    cursor = conn.cursor()
    cursor.execute("""
        SELECT price FROM prices
        WHERE train_num = ? AND from_station_id = ? AND to_station_id = ?
          AND seat = ?
    """, (train_num, from_id, to_id, seat))
    row = cursor.fetchone()
    return row[0] if row else None


def get_crawled_price_trains(conn: sqlite3.Connection) -> set:
    """返回已爬取过票价的车次集合"""
    cursor = conn.cursor()
    cursor.execute("SELECT DISTINCT train_num FROM prices")
    return {row[0] for row in cursor.fetchall()}


def get_prices_conn() -> sqlite3.Connection:
    """获取票价数据库连接"""
    return sqlite3.connect(PRICES_DB_PATH)


def get_railway_conn() -> sqlite3.Connection:
    """获取基础数据库连接（只读）"""
    if not os.path.exists(RAILWAY_DB_PATH):
        raise FileNotFoundError(f"基础数据库不存在: {RAILWAY_DB_PATH}，请先运行 collector.py")
    conn = sqlite3.connect(RAILWAY_DB_PATH)
    conn.execute("PRAGMA foreign_keys = ON")
    conn.row_factory = sqlite3.Row
    return conn


def get_all_stations(conn: sqlite3.Connection) -> List[Dict]:
    """获取所有车站列表"""
    cursor = conn.cursor()
    cursor.execute("SELECT station_id, station_name FROM stations ORDER BY station_name")
    return [{"station_id": row[0], "station_name": row[1]} for row in cursor.fetchall()]


def get_all_train_nums(conn: sqlite3.Connection) -> List[str]:
    """获取所有 G 车次号列表"""
    cursor = conn.cursor()
    cursor.execute("SELECT train_num FROM trains ORDER BY train_num")
    return [row[0] for row in cursor.fetchall()]


def get_train_stops(conn: sqlite3.Connection, train_num: str) -> List[Dict]:
    """
    获取指定车次的经停站列表，按 stop_no 升序排列
    返回 [{station_id, station_name, stop_no, stop_time}, ...]
    """
    cursor = conn.cursor()
    cursor.execute("""
        SELECT stop_no, station_id, station_name, stop_time
        FROM train_stops
        WHERE train_num = ?
        ORDER BY stop_no
    """, (train_num,))
    return [
        {
            "stop_no": row[0],
            "station_id": row[1],
            "station_name": row[2],
            "stop_time": row[3],
        }
        for row in cursor.fetchall()
    ]


def get_routes_between(conn: sqlite3.Connection, from_id: str, to_id: str) -> List[Dict]:
    """
    查询同时经过出发站和到达站的所有车次
    返回 [{train_num, depart_time, arrive_time, duration}, ...]
    """
    cursor = conn.cursor()
    cursor.execute("""
        SELECT s1.train_num,
               s1.stop_time AS depart_time,
               s2.stop_time AS arrive_time
        FROM train_stops s1
        JOIN train_stops s2 ON s1.train_num = s2.train_num
        WHERE s1.station_id = ?
          AND s2.station_id = ?
          AND s1.stop_no < s2.stop_no
        ORDER BY s1.stop_time
    """, (from_id, to_id))
    results = []
    for row in cursor.fetchall():
        train_num, depart, arrive = row
        duration = calc_duration(depart, arrive)
        results.append({
            "train_num": train_num,
            "depart_time": depart,
            "arrive_time": arrive,
            "duration": duration,
        })
    return results


def calc_duration(depart: str, arrive: str) -> str:
    """计算两个 HH:MM 时间字符串的差值，返回 HH:MM 格式"""
    try:
        h1, m1 = map(int, depart.split(":"))
        h2, m2 = map(int, arrive.split(":"))
        total_minutes = (h2 * 60 + m2) - (h1 * 60 + m1)
        if total_minutes < 0:
            total_minutes += 1440  # 跨天处理
        return f"{total_minutes // 60:02d}:{total_minutes % 60:02d}"
    except (ValueError, AttributeError):
        return "--:--"


def get_station_trains(conn: sqlite3.Connection, station_id: str) -> Optional[Dict]:
    """获取车站经停车次列表"""
    cursor = conn.cursor()
    cursor.execute("SELECT station_id, station_name, data FROM station_trains WHERE station_id = ?", (station_id,))
    row = cursor.fetchone()
    if row is None:
        return None
    return {
        "station_id": row[0],
        "station_name": row[1],
        "data": json.loads(row[2]),
    }


# ============================================================
# 题目数据库（question/qXXX.db）操作
# ============================================================

TICKET_TABLES = ["class0", "class1", "class2"]


def create_question_db(question_id: str) -> str:
    """
    创建题目数据库，包含 class0 / class1 / class2 三张余票表
    返回数据库文件路径
    """
    ensure_directories()
    db_path = get_question_db_path(question_id)
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA foreign_keys = ON")

    for table in TICKET_TABLES:
        conn.execute(f"""
            CREATE TABLE IF NOT EXISTS {table} (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                train_num TEXT NOT NULL,
                from_station_id TEXT NOT NULL,
                to_station_id TEXT NOT NULL,
                tickets INTEGER NOT NULL CHECK (tickets >= 0 AND tickets <= {QUESTION_CONFIG["ticket_max_value"]}),
                UNIQUE(train_num, from_station_id, to_station_id)
            )
        """)
        conn.execute(f"""
            CREATE INDEX IF NOT EXISTS idx_{table}_train_num
            ON {table}(train_num)
        """)

    conn.commit()
    conn.close()
    return db_path


def reset_question_tables(conn: sqlite3.Connection):
    """
    清空题目数据库中所有余票数据（保留表结构）
    用于自动出题时重置数据库状态
    """
    cursor = conn.cursor()
    for table in TICKET_TABLES:
        cursor.execute(f"DELETE FROM {table}")
    conn.commit()


def update_ticket(conn: sqlite3.Connection, train_num: str,
                  from_station_id: str, to_station_id: str,
                  seat_type: str, tickets: int):
    """
    更新指定站对的余票数量（实时写入）
    - tickets > 0: INSERT OR REPLACE
    - tickets == 0: DELETE（稀疏存储，空行即 0 票）
    seat_type: class0 / class1 / class2
    tickets: 0~30 整数
    """
    if seat_type not in TICKET_TABLES:
        raise ValueError(f"无效的座位类型: {seat_type}")
    if not (0 <= tickets <= QUESTION_CONFIG["ticket_max_value"]):
        raise ValueError(f"余票数量超出范围: {tickets}")
    if tickets > 0:
        conn.execute(f"""
            INSERT OR REPLACE INTO {seat_type}
            (train_num, from_station_id, to_station_id, tickets)
            VALUES (?, ?, ?, ?)
        """, (train_num, from_station_id, to_station_id, tickets))
    else:
        conn.execute(f"""
            DELETE FROM {seat_type}
            WHERE train_num = ? AND from_station_id = ? AND to_station_id = ?
        """, (train_num, from_station_id, to_station_id))
    conn.commit()


def delete_train_tickets(conn: sqlite3.Connection, train_num: str):
    """
    删除指定车次在题目数据库中的所有余票数据（所有座位类型）
    """
    cursor = conn.cursor()
    for table in TICKET_TABLES:
        cursor.execute(f"DELETE FROM {table} WHERE train_num = ?", (train_num,))
    conn.commit()


def remove_train_from_metadata(question_id: str, train_num: str):
    """
    从题目元数据中移除指定车次
    """
    metadata = load_metadata()
    if question_id not in metadata:
        return
    entry = metadata[question_id]
    trains = entry.get("trains", [])
    if train_num in trains:
        trains.remove(train_num)
        entry["trains"] = trains
        entry["train_count"] = len(trains)
        save_metadata(metadata)


def get_train_tickets(conn: sqlite3.Connection, train_num: str,
                      seat_types: Optional[List[str]] = None) -> Dict:
    """
    获取指定车次的余票数据
    返回 {class2: {"from|to": count, ...}, class1: ..., class0: ...}
    """
    if seat_types is None:
        seat_types = TICKET_TABLES
    result = {}
    for table in seat_types:
        if table not in TICKET_TABLES:
            continue
        cursor = conn.cursor()
        cursor.execute(f"""
            SELECT from_station_id, to_station_id, tickets
            FROM {table}
            WHERE train_num = ?
        """, (train_num,))
        data = {}
        for row in cursor.fetchall():
            key = f"{row[0]}|{row[1]}"
            data[key] = row[2]
        result[table] = data
    return result


def get_train_tickets_filtered(conn: sqlite3.Connection, train_num: str,
                                from_station_id: Optional[str] = None,
                                to_station_id: Optional[str] = None,
                                seat_types: Optional[List[str]] = None) -> Dict:
    """
    按条件筛选余票数据
    """
    if seat_types is None:
        seat_types = TICKET_TABLES
    result = {}
    for table in seat_types:
        if table not in TICKET_TABLES:
            continue
        cursor = conn.cursor()
        if from_station_id and to_station_id:
            cursor.execute(f"""
                SELECT from_station_id, to_station_id, tickets
                FROM {table}
                WHERE train_num = ? AND from_station_id = ? AND to_station_id = ?
            """, (train_num, from_station_id, to_station_id))
        elif from_station_id:
            cursor.execute(f"""
                SELECT from_station_id, to_station_id, tickets
                FROM {table}
                WHERE train_num = ? AND from_station_id = ?
            """, (train_num, from_station_id))
        elif to_station_id:
            cursor.execute(f"""
                SELECT from_station_id, to_station_id, tickets
                FROM {table}
                WHERE train_num = ? AND to_station_id = ?
            """, (train_num, to_station_id))
        else:
            cursor.execute(f"""
                SELECT from_station_id, to_station_id, tickets
                FROM {table}
                WHERE train_num = ?
            """, (train_num,))
        data = {}
        for row in cursor.fetchall():
            key = f"{row[0]}|{row[1]}"
            data[key] = row[2]
        result[table] = data
    return result


# ============================================================
# 元数据管理（metadata.json）
# ============================================================

def load_metadata() -> Dict:
    """加载题目元数据，若文件不存在则返回空字典"""
    if not os.path.exists(METADATA_PATH):
        return {}
    with open(METADATA_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def save_metadata(metadata: Dict):
    """保存题目元数据"""
    ensure_directories()
    with open(METADATA_PATH, "w", encoding="utf-8") as f:
        json.dump(metadata, f, ensure_ascii=False, indent=2)


def update_question_metadata(question_id: str, status: str,
                             train_count: int = None,
                             trains: list = None,
                             source: str = None,
                             question_type: str = None,
                             answer: str = None,
                             question: str = None,
                             interference: bool = None,
                             interference_density: float = None,
                             segment_plans: list = None,
                             people_count: int = None,
                             seat_type: str = None,
                             interference_mode: str = None,
                             question_mode: str = None,
                             ground_truth: list = None,
                             start_station_id: str = None,
                             end_station_id: str = None,
                             depart_earliest: str = None,
                             depart_latest: str = None,
                             arrive_earliest: str = None,
                             arrive_latest: str = None,
                             min_transfer_minutes: int = None,
                             max_transfer_minutes: int = None):
    """更新单条题目的元数据"""
    metadata = load_metadata()
    if question_id in metadata:
        entry = metadata[question_id]
        entry["status"] = status
        if train_count is not None:
            entry["train_count"] = train_count
        if source is not None:
            entry["source"] = source
        if question_type is not None:
            entry["question_type"] = question_type
        if question_mode is not None:
            entry["type"] = "存在性" if question_mode == "existence" else "选择性"
            entry["question_mode"] = question_mode
        elif interference_mode is not None:
            entry["type"] = "存在性" if interference_mode == "fake" else "选择性"
        if answer is not None:
            entry["answer"] = answer
        if question is not None:
            entry["question"] = question
        if interference is not None:
            entry["interference"] = interference
        if interference_density is not None:
            entry["interference_density"] = interference_density
        if segment_plans is not None:
            entry["segment_plans"] = segment_plans
        if people_count is not None:
            entry["people_count"] = people_count
        if seat_type is not None:
            entry["seat_type"] = seat_type
        if interference_mode is not None:
            entry["interference_mode"] = interference_mode
        if ground_truth is not None:
            entry["ground_truth"] = ground_truth
        if start_station_id is not None:
            entry["start_station_id"] = start_station_id
        if end_station_id is not None:
            entry["end_station_id"] = end_station_id
        if depart_earliest is not None:
            entry["depart_earliest"] = depart_earliest
        if depart_latest is not None:
            entry["depart_latest"] = depart_latest
        if arrive_earliest is not None:
            entry["arrive_earliest"] = arrive_earliest
        if arrive_latest is not None:
            entry["arrive_latest"] = arrive_latest
        if min_transfer_minutes is not None:
            entry["min_transfer_minutes"] = min_transfer_minutes
        if max_transfer_minutes is not None:
            entry["max_transfer_minutes"] = max_transfer_minutes
        if trains is not None:
            existing = set(entry.get("trains", []))
            existing.update(trains)
            entry["trains"] = sorted(existing)
            entry["train_count"] = len(entry["trains"])
    else:
        entry = {
            "status": status,
            "train_count": train_count if train_count is not None else (len(trains) if trains else 0),
        }
        if source is not None:
            entry["source"] = source
        if question_type is not None:
            entry["question_type"] = question_type
        if question_mode is not None:
            entry["type"] = "存在性" if question_mode == "existence" else "选择性"
            entry["question_mode"] = question_mode
        elif interference_mode is not None:
            entry["type"] = "存在性" if interference_mode == "fake" else "选择性"
        if answer is not None:
            entry["answer"] = answer
        if question is not None:
            entry["question"] = question
        if interference is not None:
            entry["interference"] = interference
        if interference_density is not None:
            entry["interference_density"] = interference_density
        if segment_plans is not None:
            entry["segment_plans"] = segment_plans
        if people_count is not None:
            entry["people_count"] = people_count
        if seat_type is not None:
            entry["seat_type"] = seat_type
        if interference_mode is not None:
            entry["interference_mode"] = interference_mode
        if ground_truth is not None:
            entry["ground_truth"] = ground_truth
        if start_station_id is not None:
            entry["start_station_id"] = start_station_id
        if end_station_id is not None:
            entry["end_station_id"] = end_station_id
        if depart_earliest is not None:
            entry["depart_earliest"] = depart_earliest
        if depart_latest is not None:
            entry["depart_latest"] = depart_latest
        if arrive_earliest is not None:
            entry["arrive_earliest"] = arrive_earliest
        if arrive_latest is not None:
            entry["arrive_latest"] = arrive_latest
        if min_transfer_minutes is not None:
            entry["min_transfer_minutes"] = min_transfer_minutes
        if max_transfer_minutes is not None:
            entry["max_transfer_minutes"] = max_transfer_minutes
        if trains is not None:
            entry["trains"] = sorted(set(trains))
        metadata[question_id] = entry
    save_metadata(metadata)


def get_question_metadata(question_id: str) -> Dict:
    """获取单条题目的元数据，不存在返回空字典"""
    metadata = load_metadata()
    return metadata.get(question_id, {})


def get_metadata_by_status(status: str = "completed") -> Dict:
    """按状态筛选题目元数据"""
    metadata = load_metadata()
    return {k: v for k, v in metadata.items() if v.get("status") == status}


# ============================================================
# 代码层校验工具
# ============================================================

def validate_station_exists(conn: sqlite3.Connection, station_id: str) -> bool:
    """校验车站是否存在"""
    cursor = conn.cursor()
    cursor.execute("SELECT 1 FROM stations WHERE station_id = ?", (station_id,))
    return cursor.fetchone() is not None


def validate_train_exists(conn: sqlite3.Connection, train_num: str) -> bool:
    """校验车次是否存在"""
    cursor = conn.cursor()
    cursor.execute("SELECT 1 FROM trains WHERE train_num = ?", (train_num,))
    return cursor.fetchone() is not None


def resolve_station_name_or_id(conn: sqlite3.Connection, input_str: str) -> str:
    """
    将车站中文名或电报码解析为标准 station_id（电报码）
    - 如果输入是已存在的 station_id，直接返回
    - 如果输入是中文名，查找匹配的车站，返回其 station_id
    - 找不到则返回原字符串
    """
    input_str = input_str.strip()
    # 先尝试直接作为 station_id
    if validate_station_exists(conn, input_str):
        return input_str

    # 再尝试作为 station_name 查找
    # 先精确匹配，再模糊匹配
    cursor = conn.cursor()
    # 精确匹配
    cursor.execute("SELECT station_id FROM stations WHERE station_name = ?", (input_str,))
    row = cursor.fetchone()
    if row:
        return row[0]

    # 去掉"站"字再精确匹配（北京南站 → 北京南）
    clean = input_str.replace("站", "")
    cursor.execute("SELECT station_id FROM stations WHERE station_name = ?", (clean,))
    row = cursor.fetchone()
    if row:
        return row[0]

    # 模糊匹配（取第一个结果）
    cursor.execute("SELECT station_id, station_name FROM stations WHERE station_name LIKE ? LIMIT 1", (f"%{input_str}%",))
    row = cursor.fetchone()
    if row:
        return row[0]

    # 去掉"站"后模糊匹配
    cursor.execute("SELECT station_id, station_name FROM stations WHERE station_name LIKE ? LIMIT 1", (f"%{clean}%",))
    row = cursor.fetchone()
    if row:
        return row[0]

    return input_str  # 找不到返回原值，让调用方报错


def validate_ticket_record(conn: sqlite3.Connection,
                           train_num: str,
                           from_station_id: str,
                           to_station_id: str) -> Tuple[bool, str]:
    """
    跨库外键校验（代码层）
    检查 train_num / from_station_id / to_station_id 是否在基础数据库中
    返回 (是否通过, 错误信息)
    """
    if not validate_train_exists(conn, train_num):
        return False, f"车次 {train_num} 不存在"
    if not validate_station_exists(conn, from_station_id):
        return False, f"出发站 {from_station_id} 不存在"
    if not validate_station_exists(conn, to_station_id):
        return False, f"到达站 {to_station_id} 不存在"
    return True, ""


def validate_station_ids(conn: sqlite3.Connection, station_ids: List[str]) -> Tuple[bool, str]:
    """批量校验车站ID"""
    for sid in station_ids:
        if not validate_station_exists(conn, sid):
            return False, f"车站 {sid} 不存在"
    return True, ""


# ============================================================
# 物化 station_trains 表
# ============================================================

def refresh_station_trains(rw_conn: sqlite3.Connection):
    """
    从 train_stops 表聚合数据，刷新 station_trains 表
    每行：station_id, station_name, JSON 数组
    使用 LEFT JOIN 确保不在 stations 表中的 station_id 也不会丢失数据
    """
    cursor = rw_conn.cursor()

    # 按 station_id 分组，收集所有经过该站的车次及停站时间
    # 直接用 ts.station_name 而非 s.station_name，避免 JOIN 丢失无对应 stations 的记录
    cursor.execute("""
        SELECT ts.station_id, ts.station_name, ts.train_num, ts.stop_time
        FROM train_stops ts
        ORDER BY ts.train_num
    """)
    rows = cursor.fetchall()

    # 按 station_id 分组
    station_data: Dict[str, Dict] = {}
    for station_id, station_name, train_num, stop_time in rows:
        if station_id not in station_data:
            station_data[station_id] = {
                "station_name": station_name,
                "trains": []
            }
        station_data[station_id]["trains"].append({
            "train_num": train_num,
            "stop_time": stop_time,
        })

    # 写入 station_trains 表
    cursor.execute("DELETE FROM station_trains")
    for station_id, data in station_data.items():
        cursor.execute("""
            INSERT OR REPLACE INTO station_trains (station_id, station_name, data)
            VALUES (?, ?, ?)
        """, (station_id, data["station_name"], json.dumps(data["trains"], ensure_ascii=False)))

    rw_conn.commit()
    print(f"[database] 已刷新 station_trains 表，共 {len(station_data)} 个车站")


# ============================================================
# 同车多号映射（same_trains.json）
# ============================================================

def load_same_train_map() -> Dict[str, List[str]]:
    """
    加载 same_trains.json，返回 {train_num → [同组其他 train_num]} 的映射
    用于出题时自动补齐同一物理列车的多个车次号
    """
    from config import DATA_DIR
    path = os.path.join(DATA_DIR, "same_trains.json")
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as f:
        groups = json.load(f)
    result: Dict[str, List[str]] = {}
    for group in groups:
        for tn in group["trains"]:
            result[tn] = [t for t in group["trains"] if t != tn]
    return result