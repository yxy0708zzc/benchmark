"""
FastAPI 服务主程序
依据 02_API与工具定义.md 定义的 6 个 API 端点

包含：
- 6 个基础数据查询端点
- 出题器相关端点（update_ticket, auto_generate, question/list）
- 测试器端点（chat, complete）
- 测评器端点（eval/load, eval/requirements, eval/complete）
- 统计端点（stats/summary, stats/export）
- 静态文件服务（前端页面）
"""

import json
import os
import sqlite3
import random
import re
import logging
import asyncio
from datetime import datetime
from typing import Optional, List, Dict, Any
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query, Body, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from config import (
    API_CONFIG, QUESTION_CONFIG, ensure_directories,
    RAILWAY_DB_PATH, METADATA_PATH,
    get_question_db_path, TEMPLATES_DIR
)
from database import (
    get_railway_conn, get_all_train_nums,
    get_train_stops, get_routes_between, get_station_trains,
    get_train_tickets, get_train_tickets_filtered,
    create_question_db, reset_question_tables, update_ticket as db_update_ticket,
    delete_train_tickets, remove_train_from_metadata,
    load_metadata, update_question_metadata, get_question_metadata,
    save_metadata,
    validate_train_exists, validate_station_exists,
    resolve_station_name_or_id,
    load_same_train_map,
    TICKET_TABLES
)
from tools import (
    TOOLS, TOOL_HANDLERS, set_current_question, get_current_question
)
from prompts import SYSTEM_PROMPT

# 预览缓存：存储未确认的自动出题数据（key=question_id）
_preview_cache: Dict[str, Dict] = {}


def _create_in_memory_question_db() -> sqlite3.Connection:
    """创建内存中的题目数据库（用于预览验证，不做磁盘写入）"""
    conn = sqlite3.connect(':memory:')
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
    return conn
from verifier import verify_final_plan, normalize_final_plan


# ============================================================
# 日志配置
# ============================================================
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("server")


# ============================================================
# 应用生命周期
# ============================================================
@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用启动和关闭时的生命周期管理"""
    ensure_directories()
    logger.info(f"Benchmark 服务启动 - {API_CONFIG['host']}:{API_CONFIG['port']}")
    yield
    logger.info("Benchmark 服务关闭")


app = FastAPI(title="高铁购票大模型测试平台", version="1.0.0", lifespan=lifespan)

# CORS 配置
app.add_middleware(
    CORSMiddleware,
    allow_origins=API_CONFIG["cors_allow_origins"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================
# 第一部分：基础数据查询接口
# 依据 02_API与工具定义.md 第一部分
# ============================================================

# --- 1.2 GET /api/train 车次列表 ---
@app.get("/api/train")
def api_list_trains(
    keyword: str = "",
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=200)
):
    """返回所有 G 车次号列表，支持关键词搜索和分页"""
    conn = get_railway_conn()
    cursor = conn.cursor()
    try:
        offset = (page - 1) * limit
        if keyword:
            cursor.execute(
                "SELECT COUNT(*) FROM trains WHERE train_num LIKE ?",
                (f"%{keyword}%",)
            )
            total = cursor.fetchone()[0]
            cursor.execute(
                "SELECT train_num FROM trains WHERE train_num LIKE ? ORDER BY train_num LIMIT ? OFFSET ?",
                (f"%{keyword}%", limit, offset)
            )
        else:
            cursor.execute("SELECT COUNT(*) FROM trains")
            total = cursor.fetchone()[0]
            cursor.execute(
                "SELECT train_num FROM trains ORDER BY train_num LIMIT ? OFFSET ?",
                (limit, offset)
            )
        data = [{"train_num": row[0]} for row in cursor.fetchall()]
        total_pages = (total + limit - 1) // limit
        return {
            "total": total,
            "page": page,
            "limit": limit,
            "total_pages": total_pages,
            "data": data,
        }
    finally:
        conn.close()


# --- 1.3 GET /api/station 车站列表 ---
@app.get("/api/station")
def api_list_stations(
    keyword: str = "",
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=200)
):
    """返回所有车站列表，支持关键词搜索和分页"""
    conn = get_railway_conn()
    cursor = conn.cursor()
    try:
        offset = (page - 1) * limit
        if keyword:
            cursor.execute(
                "SELECT COUNT(*) FROM stations WHERE station_name LIKE ? OR station_id LIKE ?",
                (f"%{keyword}%", f"%{keyword}%")
            )
            total = cursor.fetchone()[0]
            cursor.execute(
                """SELECT station_id, station_name FROM stations
                   WHERE station_name LIKE ? OR station_id LIKE ?
                   ORDER BY station_name LIMIT ? OFFSET ?""",
                (f"%{keyword}%", f"%{keyword}%", limit, offset)
            )
        else:
            cursor.execute("SELECT COUNT(*) FROM stations")
            total = cursor.fetchone()[0]
            cursor.execute(
                "SELECT station_id, station_name FROM stations ORDER BY station_name LIMIT ? OFFSET ?",
                (limit, offset)
            )
        data = [{"station_id": row[0], "station_name": row[1]} for row in cursor.fetchall()]
        total_pages = (total + limit - 1) // limit
        return {
            "total": total,
            "page": page,
            "limit": limit,
            "total_pages": total_pages,
            "data": data,
        }
    finally:
        conn.close()


# --- GET /api/station/random 随机车站 ---
@app.get("/api/station/random")
def api_station_random():
    """返回一个随机车站"""
    conn = get_railway_conn()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT station_id, station_name FROM stations ORDER BY RANDOM() LIMIT 1")
        row = cursor.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="无车站数据")
        return {"station_id": row[0], "station_name": row[1]}
    finally:
        conn.close()


# --- 1.4 GET /api/train/{train_num} 车次详情 ---
@app.get("/api/train/{train_num}")
def api_train_detail(train_num: str):
    """返回指定车次的完整信息（含经停站列表）"""
    conn = get_railway_conn()
    cursor = conn.cursor()
    try:
        # 验证车次是否存在
        cursor.execute("SELECT train_no FROM trains WHERE train_num = ?", (train_num,))
        row = cursor.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail=f"车次 {train_num} 未找到")
        train_no = row[0]

        # 获取经停站列表
        stops = get_train_stops(conn, train_num)
        return {
            "train_num": train_num,
            "train_no": train_no,
            "stops": stops,
        }
    finally:
        conn.close()


# --- 1.5 GET /api/station/{station_id} 车站详情 ---
@app.get("/api/station/{station_id}")
def api_station_detail(station_id: str):
    """返回指定车站的经停车次列表"""
    conn = get_railway_conn()
    try:
        result = get_station_trains(conn, station_id)
        if result is None:
            raise HTTPException(status_code=404, detail=f"车站 {station_id} 未找到")
        return {
            "station_id": result["station_id"],
            "station_name": result["station_name"],
            "train_count": len(result["data"]),
            "trains": result["data"],
        }
    finally:
        conn.close()


# --- 1.6 GET /api/train/{train_num}/ticket 余票查询 ---
@app.get("/api/train/{train_num}/ticket")
def api_train_ticket(
    train_num: str,
    from_station_id: Optional[str] = Query(None),
    to_station_id: Optional[str] = Query(None),
    seat_types: Optional[str] = Query(None),
    question_id: Optional[str] = Query(None)
):
    """返回指定车次在指定题目下的余票数据"""
    qid = question_id
    if not qid:
        try:
            qid = get_current_question()
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

    db_path = get_question_db_path(qid)
    if not os.path.exists(db_path):
        raise HTTPException(status_code=404, detail=f"题目 {qid} 不存在")

    seat_type_list = None
    if seat_types:
        seat_type_list = [s.strip() for s in seat_types.split(",") if s.strip() in TICKET_TABLES]

    conn = sqlite3.connect(db_path)
    try:
        tickets = get_train_tickets_filtered(
            conn, train_num, from_station_id, to_station_id, seat_type_list
        )
        return {
            "train_num": train_num,
            "question_id": qid,
            "tickets": tickets,
        }
    finally:
        conn.close()


# --- 1.7 GET /api/routes 两站之间车次 ---
@app.get("/api/routes")
def api_routes(
    from_station_id: str = Query(None),
    to_station_id: str = Query(None)
):
    """查询同时经过出发站和到达站的所有车次"""
    if not from_station_id or not to_station_id:
        raise HTTPException(status_code=400, detail="缺少 from_station_id 或 to_station_id")

    conn = get_railway_conn()
    try:
        data = get_routes_between(conn, from_station_id, to_station_id)
        if not data:
            raise HTTPException(
                status_code=404,
                detail=f"未找到从 {from_station_id} 到 {to_station_id} 的车次"
            )
        return {
            "from_station_id": from_station_id,
            "to_station_id": to_station_id,
            "count": len(data),
            "data": data,
        }
    finally:
        conn.close()


# ============================================================
# 第二部分：出题器相关接口
# ============================================================

# --- 请求模型 ---
class UpdateTicketRequest(BaseModel):
    question_id: str
    train_num: str
    from_station_id: str
    to_station_id: str
    seat_type: str
    tickets: int


class AutoGenerateRequest(BaseModel):
    question_type: str  # direct/transfer/short_buy/extra_front/extra_rear/mixed
    from_station_id: str  # 可接受站名（如"北京南"）或站ID（如"VNP"），服务端自动解析
    to_station_id: str  # 同上
    random_tickets: bool = False  # 是否添加干扰票
    fake_interference: bool = False  # 伪干扰模式：干扰票数 ≤ people_count；False=真干扰(随机1~10)
    interference_density: float = 0.08
    transfers: int = 0  # 换乘次数（仅 mixed 题型）
    segment_plans: List[str] = []  # 每段策略，长度 = transfers + 1
    custom_qid: str = ""  # 自定义题名，为空则自动生成
    seed: Optional[int] = None
    people_count: int = 2  # 需求人数：答案票数 ≥ 此值
    seat_type: str = "class2"  # 答案票等级（class0/class1/class2）


# --- POST /api/update_ticket 实时更新余票 ---
@app.post("/api/update_ticket")
def api_update_ticket(req: UpdateTicketRequest):
    """实时更新余票数据（手动出题/改题调用）"""
    # 校验座位类型
    if req.seat_type not in TICKET_TABLES:
        raise HTTPException(status_code=400, detail=f"无效的座位类型: {req.seat_type}")
    # 校验余票范围
    if not (0 <= req.tickets <= QUESTION_CONFIG["ticket_max_value"]):
        raise HTTPException(status_code=400, detail=f"余票超出范围: {req.tickets}")

    # 校验车站与车次是否存在
    rw_conn = get_railway_conn()
    try:
        if not validate_train_exists(rw_conn, req.train_num):
            raise HTTPException(status_code=400, detail=f"车次 {req.train_num} 不存在")
        for sid in [req.from_station_id, req.to_station_id]:
            if not validate_station_exists(rw_conn, sid):
                raise HTTPException(status_code=400, detail=f"车站 {sid} 不存在")
    finally:
        rw_conn.close()

    # 更新余票
    db_path = get_question_db_path(req.question_id)
    if not os.path.exists(db_path):
        # 如果题目数据库不存在，自动创建（稀疏存储，不预填充）
        create_question_db(req.question_id)

    q_conn = sqlite3.connect(db_path)
    try:
        db_update_ticket(
            q_conn, req.train_num,
            req.from_station_id, req.to_station_id,
            req.seat_type, req.tickets
        )
        # 更新元数据修改时间
        update_question_metadata(req.question_id, status="draft")
        return {"success": True, "message": "余票已更新"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        q_conn.close()


# ============================================================
# 自动出题器辅助函数
# ============================================================

def _calc_time_diff_minutes(time1: str, time2: str) -> int:
    """计算 time2 - time1 的分钟数（仅当日，不做跨天换算）

    要求同一天内 time2 在 time1 之后：返回正值表示当日间隔；
    若 time2 时钟时间早于 time1（即跨天到次日），返回负值。
    """
    try:
        h1, m1 = map(int, time1.split(":"))
        h2, m2 = map(int, time2.split(":"))
        return (h2 * 60 + m2) - (h1 * 60 + m1)
    except (ValueError, AttributeError):
        return 0


def _get_trains_passing_station(rw_conn: sqlite3.Connection, station_id: str) -> List[str]:
    """获取经过指定车站的所有车次号"""
    cursor = rw_conn.cursor()
    cursor.execute("SELECT DISTINCT train_num FROM train_stops WHERE station_id = ?", (station_id,))
    return [row[0] for row in cursor.fetchall()]


def _train_passes_station(rw_conn: sqlite3.Connection, train_num: str, station_id: str) -> bool:
    """检查车次是否经过指定车站"""
    cursor = rw_conn.cursor()
    cursor.execute("SELECT 1 FROM train_stops WHERE train_num = ? AND station_id = ?", (train_num, station_id))
    return cursor.fetchone() is not None


def _get_routes_for_transfer(rw_conn: sqlite3.Connection,
                              from_id: str, to_id: str) -> List[Dict]:
    """
    获取换乘题型的候选车次 T，要求：
    - T 经过出发站 A
    - T 不经过目标站 B（防止买短补长）
    - T 在 A 之后至少还有一站（有中间站 M 可选）
    """
    all_trains = _get_trains_passing_station(rw_conn, from_id)
    routes = []
    for tn in all_trains:
        if _train_passes_station(rw_conn, tn, to_id):
            continue  # 排除经过 B 的车次
        stops = get_train_stops(rw_conn, tn)
        stop_ids = [s["station_id"] for s in stops]
        if from_id in stop_ids:
            from_idx = stop_ids.index(from_id)
            if from_idx < len(stops) - 1:  # A 不是最后一站
                routes.append({
                    "train_num": tn,
                    "depart_time": stops[from_idx]["stop_time"],
                    "arrive_time": stops[-1]["stop_time"],
                })
    return routes


def _get_city_key(station_name: str) -> str:
    """从站名提取城市标识（用于判断同城车站）"""
    for suf in ['东', '南', '西', '北', '站']:
        if station_name.endswith(suf) and len(station_name) > len(suf) + 1:
            return station_name[:-len(suf)]
    return station_name


def _find_transfer_trains(rw_conn: sqlite3.Connection,
                          target_train_num: str,
                          mid_station_id: str,
                          to_station_id: str,
                          mid_stop_time: str) -> List[Dict]:
    """
    查找从中间站 M 到 B 的其他车次 U，要求：
    - U 经过 M 且之后经过 B
    - T 到达 M 的时间 + 20min <= U 从 M 出发的时间
    """
    cursor = rw_conn.cursor()
    cursor.execute("""
        SELECT ts1.train_num, ts1.stop_time AS mid_depart,
               ts2.stop_time AS arrive_time
        FROM train_stops ts1
        JOIN train_stops ts2 ON ts1.train_num = ts2.train_num
        WHERE ts1.station_id = ?
          AND ts2.station_id = ?
          AND ts1.stop_no < ts2.stop_no
          AND ts1.train_num != ?
        ORDER BY ts1.stop_time
    """, (mid_station_id, to_station_id, target_train_num))

    candidates = []
    for row in cursor.fetchall():
        train_num, mid_depart, arrive_time = row
        if mid_stop_time and mid_depart:
            gap = _calc_time_diff_minutes(mid_stop_time, mid_depart)
            if gap >= 20:
                candidates.append({
                    "train_num": train_num,
                    "mid_depart": mid_depart,
                    "arrive_time": arrive_time,
                })
    return candidates


def _random_solution_tickets(people_count: int) -> int:
    """生成答案票数：保证 ≥ 需求人数，上限 max(people_count, 5)"""
    return random.randint(people_count, max(people_count, 5))


def _write_legal_solution(q_conn: sqlite3.Connection,
                          rw_conn: sqlite3.Connection,
                          question_type: str,
                          train_num: str,
                          stops: List[Dict],
                          from_id: str, to_id: str,
                          from_idx: int, to_idx: int,
                          segment_plans: List[str] = None,
                          transfer_dest: str = None,
                          seat_type: str = "class2",
                          people_count: int = 1) -> Dict:
    """
    写入合法解（正数票）。
    返回包含 segments 和 target_mid_idx 的字典。
    """
    segments = []
    target_mid_idx = None  # 记录 short_buy 的目标中间站索引

    # 获取站名映射
    station_names = {s["station_id"]: s["station_name"] for s in stops}

    if question_type == "transfer":
        middle_indices = [i for i in range(from_idx + 1, to_idx)]

        # 过滤掉与目标站同城的中转站
        if transfer_dest:
            cur = rw_conn.cursor()
            cur.execute("SELECT station_name FROM stations WHERE station_id = ?", (transfer_dest,))
            row = cur.fetchone()
            dest_station_name = row[0] if row else transfer_dest
            dest_city = _get_city_key(dest_station_name)
            middle_indices = [
                i for i in middle_indices
                if _get_city_key(station_names.get(stops[i]["station_id"], "")) != dest_city
            ]

        if not middle_indices:
            raise HTTPException(status_code=400, detail="目标车次无合适的中间站")

        # 实际目标站：用户输入的真正目的地，而非 T 的末站
        actual_dest = transfer_dest if transfer_dest else to_id

        # 查找换乘车次 U：每次重新随机选中间站，最多重试 3 次
        u_train = None
        mid_id = None
        mid_stop_time = None
        for _attempt in range(3):
            mid_idx = random.choice(middle_indices)
            target_mid_idx = mid_idx
            mid_id = stops[mid_idx]["station_id"]
            mid_stop_time = stops[mid_idx]["stop_time"]
            transfer_candidates = _find_transfer_trains(rw_conn, train_num, mid_id, actual_dest, mid_stop_time)
            if transfer_candidates:
                u_train = random.choice(transfer_candidates)
                break

        if u_train is None:
            raise HTTPException(
                status_code=400,
                detail=f"未找到合适的换乘车次从 {mid_id} 到 {actual_dest}（已重试 3 次）"
            )

        tickets1 = _random_solution_tickets(people_count)
        tickets2 = _random_solution_tickets(people_count)

        # 写入 T 的第一段
        db_update_ticket(q_conn, train_num, from_id, mid_id, seat_type, tickets1)
        # 写入 U 的第二段（到实际目标站）
        db_update_ticket(q_conn, u_train["train_num"], mid_id, actual_dest, seat_type, tickets2)

        # 获取 U 的站名
        u_stops = get_train_stops(rw_conn, u_train["train_num"])
        u_station_names = {s["station_id"]: s["station_name"] for s in u_stops}

        segments.append({
            "train_num": train_num,
            "from": station_names.get(from_id, from_id),
            "to": station_names.get(mid_id, mid_id),
            "from_station_id": from_id,
            "to_station_id": mid_id,
            "tickets": tickets1,
            "seat_type": seat_type,
        })
        segments.append({
            "train_num": u_train["train_num"],
            "from": u_station_names.get(mid_id, mid_id),
            "to": u_station_names.get(actual_dest, actual_dest),
            "from_station_id": mid_id,
            "to_station_id": actual_dest,
            "tickets": tickets2,
            "seat_type": seat_type,
        })

    elif question_type == "short_buy":
        middle_indices = [i for i in range(from_idx + 1, to_idx)]
        if not middle_indices:
            raise HTTPException(status_code=400, detail="目标车次无合适的中间站")
        target_mid_idx = random.choice(middle_indices)
        mid_id = stops[target_mid_idx]["station_id"]
        tickets = _random_solution_tickets(people_count)
        db_update_ticket(q_conn, train_num, from_id, mid_id, seat_type, tickets)
        # M→B 不写票（买短补长，补票段无票）
        segments.append({
            "train_num": train_num,
            "from": station_names.get(from_id, from_id),
            "to": station_names.get(mid_id, mid_id),
            "from_station_id": from_id,
            "to_station_id": mid_id,
            "tickets": tickets,
            "seat_type": seat_type,
        })

    elif question_type == "extra_front":
        # 前额外：B→C 没票，往前找 k 站 (1~3) 买 Aₖ→C
        max_extra = min(from_idx, 3)
        if max_extra < 1:
            raise HTTPException(status_code=400, detail="出发站前无足够车站做前额外")
        k = random.randint(1, max_extra)
        extra_from_idx = from_idx - k
        extra_from_id = stops[extra_from_idx]["station_id"]
        tickets = _random_solution_tickets(people_count)
        db_update_ticket(q_conn, train_num, extra_from_id, to_id, seat_type, tickets)
        segments.append({
            "train_num": train_num,
            "from": station_names.get(extra_from_id, extra_from_id),
            "to": station_names.get(to_id, to_id),
            "from_station_id": extra_from_id,
            "to_station_id": to_id,
            "tickets": tickets,
            "seat_type": seat_type,
        })

    elif question_type == "extra_rear":
        # 后额外：B→C 没票，往后找 k 站 (1~3) 买 B→Dₖ
        max_extra = min(len(stops) - 1 - to_idx, 3)
        if max_extra < 1:
            raise HTTPException(status_code=400, detail="到达站后无足够车站做后额外")
        k = random.randint(1, max_extra)
        extra_to_idx = to_idx + k
        extra_to_id = stops[extra_to_idx]["station_id"]
        tickets = _random_solution_tickets(people_count)
        db_update_ticket(q_conn, train_num, from_id, extra_to_id, seat_type, tickets)
        segments.append({
            "train_num": train_num,
            "from": station_names.get(from_id, from_id),
            "to": station_names.get(extra_to_id, extra_to_id),
            "from_station_id": from_id,
            "to_station_id": extra_to_id,
            "tickets": tickets,
            "seat_type": seat_type,
        })

    elif question_type == "mixed" and segment_plans:
        # 混合：设换乘数 N = len(segment_plans) - 1
        # 路径：A → M1 → M2 → ... → MN → B
        # 段 0 用 T (A→M1)，段 i>0 在 Mi 换乘后到下一站
        transfers = len(segment_plans) - 1

        # 选取 N 个中间站
        middle_indices = [i for i in range(from_idx + 1, to_idx)]
        if len(middle_indices) < transfers:
            raise HTTPException(
                status_code=400,
                detail=f"混合题型需要至少 {transfers} 个中间站，当前只有 {len(middle_indices)}"
            )
        selected = sorted(random.sample(middle_indices, transfers)) if transfers > 0 else []
        mid_ids = [stops[i]["station_id"] for i in selected]
        path_nodes = [from_id] + mid_ids + [to_id]  # 长度 = transfers + 2

        current_train = train_num
        current_stops = stops
        # 乘客到达当前段起点站的时间（换乘衔接基准，跨段跟踪实际到达时间）
        arrival_at_seg_start = None
        stop_ids_for_t = [s["station_id"] for s in stops]

        for seg_idx, strategy in enumerate(segment_plans):
            seg_from = path_nodes[seg_idx]
            seg_to = path_nodes[seg_idx + 1]

            # 段 > 0：需要找换乘车次，衔接基准 = 上一段车次到达本段起点的时间
            if seg_idx > 0:
                candidates = _find_transfer_trains(rw_conn, train_num, seg_from, seg_to, arrival_at_seg_start)
                # 非最后一段的买短补长：排除经过最终站 B 的车次，避免模型跳过后续换乘直达终点
                if strategy == "short_buy" and seg_idx < transfers:
                    candidates = [
                        c for c in candidates
                        if not _train_passes_station(rw_conn, c["train_num"], to_id)
                    ]
                    if not candidates:
                        raise HTTPException(
                            status_code=400,
                            detail=f"段 {seg_idx} 买短补长无可用的换乘车次（候选均经过终点站）"
                        )
                if not candidates:
                    raise HTTPException(status_code=400, detail=f"未找到从 {seg_from} 到 {seg_to} 的换乘车次")
                if seg_idx < transfers:
                    # 后续还有换乘：必须确保选中车次在该段终点（下一换乘点）有有效到达时间
                    valid_candidates = [
                        c for c in candidates
                        if re.match(r'^\d{2}:\d{2}$', c.get("arrive_time") or "")
                    ]
                    if not valid_candidates:
                        raise HTTPException(status_code=400, detail=f"未找到有有效到达时间的换乘车次从 {seg_from} 到 {seg_to}")
                    chosen = random.choice(valid_candidates)
                else:
                    chosen = random.choice(candidates)
                current_train = chosen["train_num"]
                current_stops = get_train_stops(rw_conn, current_train)
                # 更新基准时间：本段车次到达本段终点的时间（下一换乘点）
                arrival_at_seg_start = chosen["arrive_time"]
            else:
                # 段 0 用目标车次 T：记录 T 到达第一换乘点的时间作为衔接基准
                seg_to_idx = stop_ids_for_t.index(seg_to)
                arrival_at_seg_start = stops[seg_to_idx]["stop_time"]

            # 在当前车次上应用段策略
            current_ids = [s["station_id"] for s in current_stops]
            current_names = {s["station_id"]: s["station_name"] for s in current_stops}
            try:
                cur_from_idx = current_ids.index(seg_from)
                cur_to_idx = current_ids.index(seg_to)
            except ValueError:
                raise HTTPException(status_code=400, detail=f"车次 {current_train} 不经过 {seg_from} 或 {seg_to}")

            if strategy == "direct":
                tickets = _random_solution_tickets(people_count)
                db_update_ticket(q_conn, current_train, seg_from, seg_to, seat_type, tickets)
                segments.append({
                    "train_num": current_train,
                    "from": current_names.get(seg_from, seg_from),
                    "to": current_names.get(seg_to, seg_to),
                    "from_station_id": seg_from,
                    "to_station_id": seg_to,
                    "tickets": tickets,
                    "seat_type": seat_type,
                    "strategy": strategy,
                    "actual_from": current_names.get(seg_from, seg_from),
                    "actual_to": current_names.get(seg_to, seg_to),
                })
            elif strategy == "short_buy":
                mid_indices = [i for i in range(cur_from_idx + 1, cur_to_idx)]
                if not mid_indices:
                    raise HTTPException(status_code=400, detail=f"段 {seg_idx} 买短补长无中间站")
                mid_idx = random.choice(mid_indices)
                mid_id = current_stops[mid_idx]["station_id"]
                tickets = _random_solution_tickets(people_count)
                db_update_ticket(q_conn, current_train, seg_from, mid_id, seat_type, tickets)
                segments.append({
                    "train_num": current_train,
                    "from": current_names.get(seg_from, seg_from),
                    "to": current_names.get(mid_id, mid_id),
                    "from_station_id": seg_from,
                    "to_station_id": mid_id,
                    "tickets": tickets,
                    "seat_type": seat_type,
                    "strategy": strategy,
                    "actual_from": current_names.get(seg_from, seg_from),
                    "actual_to": current_names.get(seg_to, seg_to),
                })
            elif strategy == "extra_front":
                max_extra = min(cur_from_idx, 3)
                if max_extra < 1:
                    raise HTTPException(status_code=400, detail=f"段 {seg_idx} 前额外无足够车站")
                k = random.randint(1, max_extra)
                extra_from_id = current_stops[cur_from_idx - k]["station_id"]
                tickets = _random_solution_tickets(people_count)
                db_update_ticket(q_conn, current_train, extra_from_id, seg_to, seat_type, tickets)
                segments.append({
                    "train_num": current_train,
                    "from": current_names.get(extra_from_id, extra_from_id),
                    "to": current_names.get(seg_to, seg_to),
                    "from_station_id": extra_from_id,
                    "to_station_id": seg_to,
                    "tickets": tickets,
                    "seat_type": seat_type,
                    "strategy": strategy,
                    "actual_from": current_names.get(seg_from, seg_from),
                    "actual_to": current_names.get(seg_to, seg_to),
                })
            elif strategy == "extra_rear":
                max_extra = min(len(current_stops) - 1 - cur_to_idx, 3)
                if max_extra < 1:
                    raise HTTPException(status_code=400, detail=f"段 {seg_idx} 后额外无足够车站")
                k = random.randint(1, max_extra)
                extra_to_id = current_stops[cur_to_idx + k]["station_id"]
                tickets = _random_solution_tickets(people_count)
                db_update_ticket(q_conn, current_train, seg_from, extra_to_id, seat_type, tickets)
                segments.append({
                    "train_num": current_train,
                    "from": current_names.get(seg_from, seg_from),
                    "to": current_names.get(extra_to_id, extra_to_id),
                    "from_station_id": seg_from,
                    "to_station_id": extra_to_id,
                    "tickets": tickets,
                    "seat_type": seat_type,
                    "strategy": strategy,
                    "actual_from": current_names.get(seg_from, seg_from),
                    "actual_to": current_names.get(seg_to, seg_to),
                })

    return {
        "segments": segments,
        "target_mid_idx": target_mid_idx,
    }


def _clear_direct_route(q_conn: sqlite3.Connection, train_num: str,
                         from_id: str, to_id: str):
    """删除用户声称区间 (B→C) 的所有余票，确保模型无法直达"""
    for table in TICKET_TABLES:
        q_conn.execute(f"""
            DELETE FROM {table}
            WHERE train_num = ? AND from_station_id = ? AND to_station_id = ?
        """, (train_num, from_id, to_id))
    q_conn.commit()


def _add_random_tickets(q_conn: sqlite3.Connection, stops: List[Dict],
                         train_num: str, solution_pairs: set,
                         density: float = 0.15,
                         block_pairs: set = None,
                         people_count: int = None):
    """
    在指定车次的所有站对上随机放置干扰票（跳过合法解占用的站对）。
    solution_pairs: {(from_id, to_id)} 合法解的站对
    block_pairs: 额外禁止生成的站对（如全局直达 A→B），所有车次一律跳过
    people_count: 非空=伪干扰模式（干扰票数 ≤ people_count）；空=真干扰（票数随机 1~10）
    """
    if block_pairs is None:
        block_pairs = set()
    n = len(stops)
    candidates = []
    for i in range(n):
        for j in range(i + 1, n):
            pair = (stops[i]["station_id"], stops[j]["station_id"])
            if pair not in solution_pairs and pair not in block_pairs:
                candidates.append(pair)

    random.shuffle(candidates)
    n = int(len(candidates) * density)
    selected = candidates[:n] if n > 0 else []

    for from_id, to_id in selected:
        seat = random.choice(TICKET_TABLES)
        if people_count is not None:
            tickets = random.randint(1, max(1, people_count))  # 伪干扰：票数 ≤ 人数
        else:
            tickets = random.randint(1, 10)  # 真干扰：票数随机 1~10
        q_conn.execute(f"""
            INSERT OR REPLACE INTO {seat}
            (train_num, from_station_id, to_station_id, tickets)
            VALUES (?, ?, ?, ?)
        """, (train_num, from_id, to_id, tickets))
    q_conn.commit()


def _add_interference_all_trains(q_conn: sqlite3.Connection, rw_conn: sqlite3.Connection,
                                  target_train_num: str, target_solution_pairs: set,
                                  density: float = 0.15,
                                  block_pairs: set = None,
                                  people_count: int = None):
    """
    在所有车次上添加随机干扰票。
    - target_train_num 的经停站对上跳过合法解占用的站对
    - 其他车次在所有经停站对随机添加
    - block_pairs 在所有车次上一律跳过（防止生成直达 A→B 逃逸）
    - people_count 非空=伪干扰模式（票数 ≤ 人数），空=真干扰（随机 1~10）
    """
    all_trains = get_all_train_nums(rw_conn)
    for train_num in all_trains:
        stops = get_train_stops(rw_conn, train_num)
        if len(stops) < 2:
            continue
        # 目标车次跳过合法解站对，其他车次不跳过
        local_pairs = target_solution_pairs if train_num == target_train_num else set()
        _add_random_tickets(q_conn, stops, train_num, local_pairs, density, block_pairs, people_count)


# --- POST /api/auto_generate auto出题器生成题目 ---
@app.post("/api/auto_generate")
def api_auto_generate(req: AutoGenerateRequest):
    """自动生成题目"""
    valid_types = ["transfer", "short_buy", "extra_front", "extra_rear", "mixed"]
    if req.question_type not in valid_types:
        raise HTTPException(status_code=400, detail=f"无效的题型: {req.question_type}")

    # 校验需求人数与答案票等级
    if not (1 <= req.people_count <= QUESTION_CONFIG["ticket_max_value"]):
        raise HTTPException(status_code=400, detail=f"人数超出范围: {req.people_count}")
    if req.seat_type not in TICKET_TABLES:
        raise HTTPException(status_code=400, detail=f"无效的座位类型: {req.seat_type}")

    if req.question_type == "mixed":
        if req.transfers < 1:
            raise HTTPException(status_code=400, detail="混合题型换乘数至少为 1")
        if len(req.segment_plans) != req.transfers + 1:
            raise HTTPException(status_code=400, detail=f"段策略数需等于换乘数+1（{req.transfers + 1}）")

    # 生成新题前，清除所有未确认的旧预览缓存（未保存的题自动作废）
    _preview_cache.clear()

    rw_conn = get_railway_conn()
    try:
        # Step 0: 固定随机种子
        if req.seed is not None:
            random.seed(req.seed)

        # Step 1: 解析车站
        from_id = resolve_station_name_or_id(rw_conn, req.from_station_id)
        to_id = resolve_station_name_or_id(rw_conn, req.to_station_id)

        if not validate_station_exists(rw_conn, from_id):
            raise HTTPException(status_code=400, detail=f"出发站 {from_id} 不存在")
        if not validate_station_exists(rw_conn, to_id):
            raise HTTPException(status_code=400, detail=f"到达站 {to_id} 不存在")

        # Step 2: 获取所有途经车次，随机打乱以便重试
        # 换乘/混合题型：T 不能经过目标站 B（防止 T 直达 B 逃逸）
        if req.question_type in ("transfer", "mixed"):
            routes = _get_routes_for_transfer(rw_conn, from_id, to_id)
        else:
            routes = get_routes_between(rw_conn, from_id, to_id)
        if not routes:
            raise HTTPException(status_code=400, detail=f"未找到从 {from_id} 到 {to_id} 的车次")

        random.shuffle(routes)
        max_attempts = min(len(routes), 15)

        last_error = None
        for attempt in range(max_attempts):
            target_train_num = routes[attempt]["train_num"]

            stops = get_train_stops(rw_conn, target_train_num)
            stop_ids_list = [s["station_id"] for s in stops]
            from_idx = stop_ids_list.index(from_id)
            if req.question_type == "transfer":
                # 换乘：T 不经过 B，用最后一站作为 to_idx
                to_idx = len(stops) - 1
                cur_from_id, cur_to_id = from_id, stops[-1]["station_id"]
                cur_from_idx, cur_to_idx = from_idx, to_idx
            elif req.question_type == "mixed":
                # 混合：T 不经过 B（防止 T 直达 B 逃逸），用最后一站作为 to_idx；
                # 实际终点仍是用户输入的 B，由最后一段换乘车次到达
                to_idx = len(stops) - 1
                cur_from_id, cur_to_id = from_id, to_id
                cur_from_idx, cur_to_idx = from_idx, to_idx
            else:
                to_idx = stop_ids_list.index(to_id)
                if from_idx > to_idx:
                    cur_from_id, cur_to_id = to_id, from_id
                    cur_from_idx, cur_to_idx = to_idx, from_idx
                else:
                    cur_from_id, cur_to_id = from_id, to_id
                    cur_from_idx, cur_to_idx = from_idx, to_idx

            # 预检中间站数量
            middle_count = cur_to_idx - cur_from_idx - 1
            if req.question_type not in ("extra_front", "extra_rear") and middle_count < 1:
                continue
            if req.question_type == "mixed":
                required_mid = req.transfers  # 需要的中间站数 = 换乘数
                if middle_count < required_mid:
                    last_error = f"中间站不足：需要 {required_mid} 个，最多 {middle_count} 个"
                    continue

            # extra 题型要求前后有足够站
            if req.question_type == "extra_front" and cur_from_idx < 1:
                last_error = "出发站前无足够车站做前额外"
                continue
            if req.question_type == "extra_rear" and cur_to_idx >= len(stops) - 1:
                last_error = "到达站后无足够车站做后额外"
                continue

            # Step 3: 确定题名（仅用于预览标识，不创建磁盘文件）
            if req.custom_qid:
                question_id = req.custom_qid
                # 检查重复（包括已存在的数据库和缓存中的同名题）
                existing_path = get_question_db_path(question_id)
                if os.path.exists(existing_path) or question_id in _preview_cache:
                    last_error = f"题名 {question_id} 已存在"
                    continue
            else:
                timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                question_id = f"{timestamp}_{attempt}"

            # 使用内存数据库做验证，不写入磁盘
            q_conn = _create_in_memory_question_db()

            try:
                # Step 4: 写入合法解（写入内存 DB，仅做验证）
                transfer_dest = None
                if req.question_type == "transfer":
                    transfer_dest = to_id  # 用户输入的真正目的地
                solution_result = _write_legal_solution(
                    q_conn, rw_conn,
                    question_type=req.question_type,
                    train_num=target_train_num,
                    stops=stops,
                    from_id=cur_from_id, to_id=cur_to_id,
                    from_idx=cur_from_idx, to_idx=cur_to_idx,
                    segment_plans=req.segment_plans,
                    transfer_dest=transfer_dest,
                    seat_type=req.seat_type,
                    people_count=req.people_count,
                )
                solution_segments = solution_result["segments"]

                # 收集合法解占用的站对（使用站 ID）
                solution_pairs = set()
                for seg in solution_segments:
                    solution_pairs.add((seg["from_station_id"], seg["to_station_id"]))

                # 验证干扰票写入（仍在内存 DB 中）：先加所有车次干扰，再清直达
                if req.random_tickets:
                    _add_interference_all_trains(
                        q_conn, rw_conn, target_train_num,
                        solution_pairs, req.interference_density,
                        block_pairs={(cur_from_id, cur_to_id)},
                        people_count=req.people_count if req.fake_interference else None,
                    )
                    _clear_direct_route(q_conn, target_train_num, cur_from_id, cur_to_id)

                q_conn.commit()

                # 构造预览
                station_names = {s["station_id"]: s["station_name"] for s in stops}
                from_name = station_names.get(from_id, from_id)
                cursor = rw_conn.cursor()
                cursor.execute("SELECT station_name FROM stations WHERE station_id = ?", (to_id,))
                row = cursor.fetchone()
                dest_name = row[0] if row else to_id
                first_stop = stops[0]["station_name"] if stops else ""
                last_stop = stops[-1]["station_name"] if stops else ""
                # 题目描述：用户填写的初始站到终点站
                question_str = f"{from_name}到{dest_name}"

                if req.question_type == "transfer":
                    parts = [f"乘坐 {target_train_num} 从 {from_name} 到 {solution_segments[0]['to']}（有票）"]
                    parts.append(f"换乘 {solution_segments[1]['train_num']} 从 {solution_segments[1]['from']} 到 {dest_name}（有票）")
                    path_desc = "，".join(parts)
                elif req.question_type == "short_buy":
                    path_desc = f"乘坐 {target_train_num} 从 {from_name} 到 {solution_segments[0]['to']}（有票），补票段 {solution_segments[0]['to']}→{dest_name} 无余票需上车补票"
                elif req.question_type == "extra_front":
                    path_desc = f"乘坐 {target_train_num} 从 {solution_segments[0]['from']} 到 {dest_name} 有票（前额外），可在 {from_name} 站上车，实际乘坐 {from_name}→{dest_name}"
                elif req.question_type == "extra_rear":
                    path_desc = f"乘坐 {target_train_num} 从 {from_name} 到 {solution_segments[0]['to']} 有票（后额外），在 {dest_name} 站提前下车，实际乘坐 {from_name}→{dest_name}"
                elif req.question_type == "mixed":
                    # 各分段叙述叠加
                    parts = []
                    for seg in solution_segments:
                        tn = seg["train_num"]
                        frm = seg.get("from", "")
                        to = seg.get("to", "")
                        strat = seg.get("strategy", "direct")
                        act_from = seg.get("actual_from", frm)
                        act_to = seg.get("actual_to", to)
                        if strat == "short_buy":
                            parts.append(f"乘坐 {tn} 从 {frm} 到 {to}（有票），补票段 {to}→{act_to} 无余票需上车补票")
                        elif strat == "extra_front":
                            parts.append(f"乘坐 {tn} 从 {frm} 到 {to} 有票（前额外），可在 {act_from} 站上车，实际乘坐 {act_from}→{act_to}")
                        elif strat == "extra_rear":
                            parts.append(f"乘坐 {tn} 从 {frm} 到 {to} 有票（后额外），在 {act_to} 站提前下车，实际乘坐 {act_from}→{act_to}")
                        else:
                            parts.append(f"乘坐 {tn} 从 {frm} 到 {to}（有票）")
                    path_desc = "，然后 ".join(parts)
                else:
                    path_desc = ""

                # 缓存生成的完整数据（含站 ID，供确认时写入磁盘）
                _preview_cache[question_id] = {
                    "question_type": req.question_type,
                    "segments": solution_segments,
                    "target_train_num": target_train_num,
                    "cur_from_id": cur_from_id,
                    "cur_to_id": cur_to_id,
                    "stops": stops,
                    "random_tickets": req.random_tickets,
                    "fake_interference": req.fake_interference,
                    "interference_density": req.interference_density,
                    "segment_plans": req.segment_plans,
                    "interference": req.random_tickets,
                    "people_count": req.people_count,
                    "seat_type": req.seat_type,
                    "question": question_str,
                }

                q_conn.close()

                return {
                    "success": True,
                    "question_id": question_id,
                    "message": f"题目 {question_id} 生成成功（预览，尚未保存）",
                    "preview": {
                        "question": question_str,
                        "question_type": req.question_type,
                        "target_train_num": target_train_num,
                        "target_train_route": f"{first_stop}→{last_stop}",
                        "target_section": f"{from_name}→{dest_name}",
                        "path_description": path_desc,
                        "solution_segments": solution_segments,
                    }
                }

            except HTTPException as e:
                q_conn.close()
                detail = e.detail if hasattr(e, 'detail') else str(e)
                if any(keyword in str(detail) for keyword in [
                    "目标车次无合适的中间站",
                    "未找到合适的换乘车次",
                    "混合策略换乘",
                    "出发站前无足够车站",
                    "到达站后无足够车站",
                ]):
                    last_error = str(detail)
                    continue  # 重试下一个车次
                raise  # 非重试性错误，直接抛出

            except Exception as e:
                q_conn.close()
                last_error = f"出题过程异常: {str(e)}"
                continue

        # 所有重试都失败
        raise HTTPException(
            status_code=400,
            detail=f"所有车次重试后仍无法生成题目: {last_error or '未知错误'}"
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        rw_conn.close()


# --- GET /api/auto_generate/previews 查看预览缓存（调试用） ---
@app.get("/api/auto_generate/previews")
def api_auto_generate_previews():
    """查看当前内存中的预览缓存"""
    return {
        "count": len(_preview_cache),
        "previews": [
            {
                "question_id": qid,
                "question_type": data.get("question_type"),
                "question": data.get("question"),
                "target_train_num": data.get("target_train_num"),
                "segments_count": len(data.get("segments", [])),
                "segment_plans": data.get("segment_plans"),
            }
            for qid, data in _preview_cache.items()
        ]
    }


class ConfirmAutoGenerateRequest(BaseModel):
    question_id: str
    question_type: str = ""
    answer: str = ""
    interference: bool = False
    interference_density: float = 0.0


class ClearPreviewRequest(BaseModel):
    question_id: str


# --- POST /api/auto_generate/clear 清除预览缓存 ---
@app.post("/api/auto_generate/clear")
def api_auto_generate_clear(req: ClearPreviewRequest):
    """
    清除指定题目的预览缓存（重新出题时调用）。
    不删除磁盘上的题目文件，只清理内存中的未确认预览。
    """
    cleared = False
    if req.question_id in _preview_cache:
        del _preview_cache[req.question_id]
        cleared = True
    return {"success": True, "cleared": cleared}


# --- POST /api/auto_generate/confirm 确认生成 ---
@app.post("/api/auto_generate/confirm")
def api_auto_generate_confirm(req: ConfirmAutoGenerateRequest):
    """
    确认生成自动出题的题目。
    将预览缓存中的数据写入磁盘，更新 metadata。
    """
    if req.question_id not in _preview_cache:
        raise HTTPException(status_code=400, detail=f"题目 {req.question_id} 尚未生成预览，请先生成")

    cached = _preview_cache[req.question_id]

    # 检查磁盘是否已存在同名 DB（防止并发冲突）
    db_path = get_question_db_path(req.question_id)
    if os.path.exists(db_path):
        del _preview_cache[req.question_id]
        raise HTTPException(status_code=400, detail=f"题目 {req.question_id} 的数据库文件已存在")

    # 创建真实数据库文件
    create_question_db(req.question_id)
    q_conn = sqlite3.connect(db_path)
    try:
        for seg in cached["segments"]:
            db_update_ticket(
                q_conn, seg["train_num"],
                seg["from_station_id"],
                seg["to_station_id"],
                seg.get("seat_type", "class2"),
                seg["tickets"]
            )

        # 干扰票处理：先加所有车次干扰，再清直达
        if cached.get("random_tickets"):
            stops = cached["stops"]
            solution_pairs = set()
            for seg in cached["segments"]:
                solution_pairs.add((seg["from_station_id"], seg["to_station_id"]))
            # 需要 rw_conn 读取所有车次信息
            rw_conn = get_railway_conn()
            try:
                _add_interference_all_trains(
                    q_conn, rw_conn, cached["target_train_num"],
                    solution_pairs, cached["interference_density"],
                    block_pairs={(cached["cur_from_id"], cached["cur_to_id"])},
                    people_count=cached.get("people_count") if cached.get("fake_interference") else None,
                )
            finally:
                rw_conn.close()
            _clear_direct_route(q_conn, cached["target_train_num"],
                                 cached["cur_from_id"], cached["cur_to_id"])

        q_conn.commit()
    except Exception as e:
        q_conn.close()
        # 写入失败则清理
        if os.path.exists(db_path):
            os.remove(db_path)
        del _preview_cache[req.question_id]
        raise HTTPException(status_code=500, detail=f"写入数据库失败: {str(e)}")
    q_conn.close()

    # 收集 trains 列表
    trains_set = set()
    for seg in cached["segments"]:
        trains_set.add(seg["train_num"])
    trains_list = sorted(trains_set)

    meta_kwargs = {
        "question_id": req.question_id,
        "status": "completed",
        "train_count": len(trains_list),
        "trains": trains_list,
        "source": "auto",
        "question_type": req.question_type or cached["question_type"],
        "answer": req.answer or None,
        "question": cached.get("question"),
        "segment_plans": cached.get("segment_plans"),
        "interference": cached.get("interference"),
        "interference_mode": (
            "fake" if cached.get("fake_interference")
            else ("real" if cached.get("interference") else None)
        ),
        "people_count": cached.get("people_count"),
        "seat_type": cached.get("seat_type"),
        "ground_truth": cached.get("segments"),   # BUG6: 结构化标答存进 metadata
    }
    # 仅选择性题（有干扰票）才记录干扰密度，存在性题不写入该字段
    if cached.get("interference"):
        meta_kwargs["interference_density"] = cached.get("interference_density")
    update_question_metadata(**meta_kwargs)

    # 清除缓存
    del _preview_cache[req.question_id]

    return {
        "success": True,
        "message": f"题目 {req.question_id} 已确认生成，可在测试器中加载使用"
    }


# --- GET /api/question/list 列出所有题目 ---
@app.get("/api/question/list")
def api_question_list(
    status_filter: Optional[str] = Query(None),
    source_filter: Optional[str] = Query(None, alias="source"),
    type_filter: Optional[str] = Query(None, alias="type"),
    keyword: Optional[str] = Query(None),
):
    """列出所有题目，支持筛选"""
    metadata = load_metadata()

    from config import QUESTION_DIR
    db_files = {}
    if os.path.exists(QUESTION_DIR):
        for f in os.listdir(QUESTION_DIR):
            if f.endswith(".db"):
                qid = f[:-3]
                db_files[qid] = True

    result = []

    # 收集有 metadata 的题目
    seen = set()
    for qid, meta in metadata.items():
        seen.add(qid)
        if status_filter and meta.get("status") != status_filter:
            continue
        if source_filter and meta.get("source") != source_filter:
            continue
        if type_filter and meta.get("type") != type_filter:
            continue
        if keyword and keyword.lower() not in qid.lower():
            continue
        result.append({
            "question_id": qid,
            "status": meta.get("status", "unknown"),
            "source": meta.get("source", ""),
            "type": meta.get("type", ""),
            "train_count": meta.get("train_count", 0),
            "answer": meta.get("answer", ""),
            "question": meta.get("question", ""),
            "nl_question": meta.get("nl_question", ""),
            "db_exists": qid in db_files,
        })

    # 也列出孤立 .db 文件（有 db 无 metadata），供清理
    for qid in db_files:
        if qid not in seen:
            if keyword and keyword.lower() not in qid.lower():
                continue
            result.append({
                "question_id": qid,
                "status": "orphan",
                "source": "",
                "type": "",
                "train_count": 0,
                "answer": "",
                "db_exists": True,
            })

    def _sort_key(x):
        qid = x["question_id"]
        try:
            return (0, int(qid))
        except ValueError:
            return (1, qid)
    result.sort(key=_sort_key)
    return {"questions": result, "total": len(result)}


class InitQuestionRequest(BaseModel):
    question_id: str
    train_num: str


# --- POST /api/question/init 初始化题目余票数据库 ---
@app.post("/api/question/init")
def api_question_init(req: InitQuestionRequest):
    """
    初始化题目中指定车次的余票数据库。
    - 如果题目数据库不存在，自动创建
    - 每次调用都将车次加入 metadata 的 trains 列表（不重置已有数据）
    """
    db_path = get_question_db_path(req.question_id)
    if not os.path.exists(db_path):
        create_question_db(req.question_id)

    rw_conn = get_railway_conn()
    q_conn = sqlite3.connect(db_path)
    try:
        # 校验请求的车次存在
        if not validate_train_exists(rw_conn, req.train_num):
            raise HTTPException(status_code=400, detail=f"车次 {req.train_num} 不存在")

        # 收集要加载的所有车次（主车次 + 同一物理列车的关联车次）
        all_trains = [req.train_num]
        same_map = load_same_train_map()
        associated = same_map.get(req.train_num, [])
        # 只添加存在的关联车次
        for tn in associated:
            if validate_train_exists(rw_conn, tn) and tn not in all_trains:
                all_trains.append(tn)

        # 记录已加载车次到元数据（合并到已有列表，不重置）
        update_question_metadata(
            req.question_id, status="draft",
            trains=all_trains
        )
        msg = f"车次 {req.train_num} 已加入题目 {req.question_id}"
        if associated:
            msg += f"，同时添加了同车关联号 {', '.join(associated)}"
        return {"success": True, "message": msg}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        rw_conn.close()
        q_conn.close()


# --- GET /api/question/{question_id}/exists 检查题目是否存在 ---
@app.get("/api/question/{question_id}/exists")
def api_question_exists(question_id: str):
    """检查题目数据库文件是否已存在"""
    db_path = get_question_db_path(question_id)
    exists = os.path.exists(db_path)
    return {"question_id": question_id, "exists": exists}


# --- GET /api/question/{question_id}/trains 获取题目中已初始化的车次列表 ---
@app.get("/api/question/{question_id}/trains")
def api_question_trains(question_id: str):
    """返回指定题目已加载的车次列表（从元数据读取）"""
    meta = get_question_metadata(question_id)
    trains_list = meta.get("trains", [])
    trains = [{"train_num": tn} for tn in trains_list]
    return {"question_id": question_id, "trains": trains, "count": len(trains)}


# ============================================================
# 第三部分：测试器接口
# ============================================================

# 对话状态（内存中维护）
# 每个用户会话的对话历史和题目状态
chat_sessions: Dict[str, List[Dict]] = {}
# 会话元数据：cumulative token_usage 和 duration
chat_session_meta: Dict[str, Dict] = {}
# 会话使用的模型名称
chat_session_model: Dict[str, str] = {}
api_keys: Dict[str, str] = {}


class CompleteQuestionRequest(BaseModel):
    question_id: str


# --- DELETE /api/question/{question_id}/train/{train_num} 删除车次 ---
@app.delete("/api/question/{question_id}/train/{train_num}")
def api_question_delete_train(question_id: str, train_num: str):
    """从题目中删除指定车次（metadata + 数据库余票数据）"""
    db_path = get_question_db_path(question_id)
    if not os.path.exists(db_path):
        raise HTTPException(status_code=404, detail=f"题目 {question_id} 不存在")

    q_conn = sqlite3.connect(db_path)
    try:
        # 删除数据库中的余票数据
        delete_train_tickets(q_conn, train_num)
        # 从 metadata 中移除车次
        remove_train_from_metadata(question_id, train_num)
        return {"success": True, "message": f"车次 {train_num} 已从题目 {question_id} 中删除"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        q_conn.close()


# --- POST /api/question/complete 标记题目完成 ---
@app.post("/api/question/complete")
def api_question_complete(req: CompleteQuestionRequest):
    """标记题目为 completed 状态，供测试器加载"""
    db_path = get_question_db_path(req.question_id)
    if not os.path.exists(db_path):
        raise HTTPException(status_code=404, detail=f"题目 {req.question_id} 不存在，请先加载车次")

    # 从 metadata 读取实际车次数，确保 train_count 正确
    meta = get_question_metadata(req.question_id)
    actual_train_count = len(meta.get("trains", []))
    update_question_metadata(
        req.question_id, status="completed",
        train_count=actual_train_count
    )
    return {"success": True, "message": f"题目 {req.question_id} 已完成"}


# --- DELETE /api/question/{question_id} 删除题目 ---
@app.delete("/api/question/{question_id}")
def api_question_delete(question_id: str):
    """删除指定题目（metadata + .db文件 + 缓存中的预览）"""
    # 先清除预览缓存（如果有）
    _preview_cache.pop(question_id, None)

    # 先删除 .db 文件（防止文件被占用导致 metadata 已删但 db 残留）
    db_path = get_question_db_path(question_id)
    db_deleted = False
    if os.path.exists(db_path):
        try:
            os.remove(db_path)
            db_deleted = True
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"删除数据库文件失败: {str(e)}")

    # 再更新 metadata
    metadata = load_metadata()
    if question_id in metadata:
        del metadata[question_id]
        save_metadata(metadata)
        return {"success": True, "message": f"题目 {question_id} 已删除"}

    if db_deleted:
        return {"success": True, "message": f"已清理孤立数据库文件 {question_id}"}

    # 既无 metadata 也无 .db 文件
    raise HTTPException(status_code=404, detail=f"题目 {question_id} 不存在")


class ChatRequest(BaseModel):
    message: str
    model_name: str = "deepseek-chat"
    api_key: str = ""
    api_base_url: str = "https://api.deepseek.com"
    question_id: str = ""
    session_id: str = "default"
    max_iterations: int = 100


class TestCompleteRequest(BaseModel):
    session_id: str = "default"


@app.post("/api/test/chat")
async def api_test_chat(req: ChatRequest):
    """发送对话消息，调用大模型并处理工具调用循环"""
    # 设置当前题目
    if req.question_id:
        set_current_question(req.question_id)

    # 初始化或获取会话历史
    if req.session_id not in chat_sessions:
        chat_sessions[req.session_id] = []

    # 每次发消息都更新模型名称（历史记录中可能被 resetChat 删除）
    chat_session_model[req.session_id] = req.model_name

    messages = chat_sessions[req.session_id]

    # 如果这是第一条消息，添加系统提示词（注入最大工具调用次数）
    if not messages:
        prompt = SYSTEM_PROMPT.replace('{max_iterations}', str(req.max_iterations))
        messages.append({"role": "system", "content": prompt})

    # 添加用户消息
    messages.append({"role": "user", "content": req.message})

    # 工具调用循环
    tool_calls_log = []
    token_usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
    last_prompt_tokens = 0  # 上轮 prompt_tokens，用于计算增量
    start_time = datetime.now()

    try:
        import httpx

        # 构造请求体
        request_body = {
            "model": req.model_name,
            "messages": messages,
            "tools": TOOLS,
            "tool_choice": "auto",
            "stream": False,
        }

        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {req.api_key}",
        }

        max_iterations = req.max_iterations  # 防止无限循环
        iteration = 0
        final_content = ""
        final_reasoning = ""

        async with httpx.AsyncClient(timeout=60) as client:
            while iteration < max_iterations:
                iteration += 1

                # 调用大模型 API
                api_url = f"{req.api_base_url.rstrip('/')}/chat/completions"
                response = await client.post(api_url, json=request_body, headers=headers)
                response_data = response.json()

                if "error" in response_data:
                    return {"error": response_data["error"].get("message", "API 调用失败")}

                choice = response_data["choices"][0]
                message = choice["message"]

                # 记录 token 用量（仅计新增 prompt tokens，扣除缓存命中）
                if "usage" in response_data:
                    usage = response_data["usage"]
                    current_prompt = usage.get("prompt_tokens", 0)
                    # 减去缓存命中的 tokens
                    prompt_details = usage.get("prompt_tokens_details")
                    if isinstance(prompt_details, dict):
                        cached = prompt_details.get("cached_tokens", 0)
                        current_prompt = max(0, current_prompt - cached)
                    delta = max(0, current_prompt - last_prompt_tokens)
                    token_usage["prompt_tokens"] += delta
                    last_prompt_tokens = current_prompt
                    token_usage["completion_tokens"] += usage.get("completion_tokens", 0)
                    token_usage["total_tokens"] = token_usage["prompt_tokens"] + token_usage["completion_tokens"]

                # 提取 reasoning_content（思考链）
                reasoning = message.get("reasoning_content") or choice.get("delta", {}).get("reasoning_content") or ""

                # 检查是否有工具调用
                tool_calls = message.get("tool_calls")
                if not tool_calls:
                    # 模型给出最终回答
                    final_content = message.get("content", "")
                    messages.append({
                        "role": "assistant",
                        "content": final_content,
                    })
                    break

                # 处理工具调用
                assistant_msg = {"role": "assistant", "content": message.get("content", "")}
                assistant_msg["tool_calls"] = []
                messages.append(assistant_msg)

                for tc in tool_calls:
                    func_name = tc["function"]["name"]
                    func_args_str = tc["function"]["arguments"]
                    try:
                        func_args = json.loads(func_args_str) if isinstance(func_args_str, str) else func_args_str
                    except json.JSONDecodeError:
                        func_args = {}

                    # 执行工具
                    tool_result = await execute_tool_handler(func_name, func_args)

                    tool_calls_log.append({
                        "tool_name": func_name,
                        "arguments": func_args,
                        "result": tool_result,
                    })

                    messages.append({
                        "role": "tool",
                        "tool_call_id": tc["id"],
                        "content": json.dumps(tool_result, ensure_ascii=False),
                    })

                    assistant_msg["tool_calls"].append({
                        "id": tc["id"],
                        "type": "function",
                        "function": {"name": func_name, "arguments": func_args_str},
                    })

                # 更新请求体中的消息
                request_body["messages"] = messages

        duration = (datetime.now() - start_time).total_seconds()

        # 累计保存到会话元数据
        sid = req.session_id
        if sid not in chat_session_meta:
            chat_session_meta[sid] = {"token_usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}, "duration": 0}
        meta = chat_session_meta[sid]
        meta["token_usage"]["prompt_tokens"] += token_usage.get("prompt_tokens", 0)
        meta["token_usage"]["completion_tokens"] += token_usage.get("completion_tokens", 0)
        meta["token_usage"]["total_tokens"] += token_usage.get("total_tokens", 0)
        meta["duration"] += duration

        return {
            "reply": final_content,
            "reasoning": final_reasoning,
            "tool_calls": tool_calls_log,
            "token_usage": token_usage,
            "duration": duration,
            "iteration_count": iteration,
        }

    except Exception as e:
        logger.error(f"测试对话出错: {e}")
        return {"error": str(e)}


@app.post("/api/test/chat/stream")
async def api_test_chat_stream(req: ChatRequest, request: Request):
    """SSE 流式对话"""
    # 设置当前题目
    if req.question_id:
        set_current_question(req.question_id)

    # 初始化或获取会话历史
    if req.session_id not in chat_sessions:
        chat_sessions[req.session_id] = []

    # 每次发消息都更新模型名称（历史记录中可能被 resetChat 删除）
    chat_session_model[req.session_id] = req.model_name

    messages = chat_sessions[req.session_id]

    # 如果这是第一条消息，添加系统提示词（注入最大工具调用次数）
    if not messages:
        prompt = SYSTEM_PROMPT.replace('{max_iterations}', str(req.max_iterations))
        messages.append({"role": "system", "content": prompt})

    # 添加用户消息
    messages.append({"role": "user", "content": req.message})

    # 累计 token 用量（仅计新增，每轮减去上轮已计的历史）
    token_usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
    last_prompt_tokens = 0  # 上轮返回的 prompt_tokens，用于计算增量
    start_time = datetime.now()

    async def event_generator():
        nonlocal token_usage, last_prompt_tokens
        import httpx

        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {req.api_key}",
        }

        api_url = f"{req.api_base_url.rstrip('/')}/chat/completions"

        # 全量累加器（跨迭代持久化，用于 done 事件输出完整文本）
        full_content_accumulated = ""
        full_reasoning_accumulated = ""

        try:
            async with httpx.AsyncClient(timeout=120) as client:
                request_body = {
                    "model": req.model_name,
                    "messages": messages,
                    "tools": TOOLS,
                    "tool_choice": "auto",
                    "stream": True,
                }

                max_iterations = req.max_iterations
                iteration = 0

                while iteration < max_iterations:
                    iteration += 1

                    # —— 安全检测：客户端断连 ——
                    if await request.is_disconnected():
                        logger.info(f"客户端断开连接，停止循环 (session={req.session_id})")
                        return

                    accumulated_content = ""
                    accumulated_reasoning = ""
                    tool_calls_buffer = {}

                    try:
                        # 流式调用 LLM
                        async with client.stream("POST", api_url, json=request_body, headers=headers) as resp:
                            if resp.status_code != 200:
                                error_text = await resp.aread()
                                yield f"data: {json.dumps({'type': 'error', 'content': f'API 调用失败 ({resp.status_code}): {str(error_text)[:200]}'})}\n\n"
                                return

                            async for line in resp.aiter_lines():
                                if not line.startswith("data: "):
                                    continue
                                data_str = line[6:]
                                if data_str.strip() == "[DONE]":
                                    break
                                try:
                                    chunk = json.loads(data_str)
                                    # 捕获 token 用量（仅累加每轮新增的 prompt tokens，扣除缓存命中）
                                    if "usage" in chunk and chunk["usage"] is not None:
                                        current_prompt = chunk["usage"].get("prompt_tokens", 0)
                                        # 减去缓存命中的 tokens
                                        prompt_details = chunk["usage"].get("prompt_tokens_details")
                                        if isinstance(prompt_details, dict):
                                            cached = prompt_details.get("cached_tokens", 0)
                                            current_prompt = max(0, current_prompt - cached)
                                        delta = max(0, current_prompt - last_prompt_tokens)
                                        token_usage["prompt_tokens"] += delta
                                        last_prompt_tokens = current_prompt
                                        token_usage["completion_tokens"] += chunk["usage"].get("completion_tokens", 0)
                                        token_usage["total_tokens"] = token_usage["prompt_tokens"] + token_usage["completion_tokens"]
                                    if "choices" not in chunk or not chunk["choices"]:
                                        continue
                                    delta = chunk["choices"][0].get("delta", {})

                                    # 思考过程（同时累加到轮次变量和全量变量）
                                    if delta.get("reasoning_content"):
                                        rc = delta["reasoning_content"]
                                        accumulated_reasoning += rc
                                        full_reasoning_accumulated += rc
                                        yield f"data: {json.dumps({'type': 'reasoning', 'content': rc})}\n\n"

                                    # 内容 token（同时累加到轮次变量和全量变量）
                                    if delta.get("content"):
                                        c = delta["content"]
                                        accumulated_content += c
                                        full_content_accumulated += c
                                        yield f"data: {json.dumps({'type': 'token', 'content': c})}\n\n"

                                    # 工具调用
                                    if delta.get("tool_calls"):
                                        for tc in delta["tool_calls"]:
                                            idx = tc["index"]
                                            if idx not in tool_calls_buffer:
                                                tool_calls_buffer[idx] = {"id": "", "function": {"name": "", "arguments": ""}}
                                            if tc.get("id"):
                                                tool_calls_buffer[idx]["id"] = tc["id"]
                                            if tc.get("function"):
                                                fn = tc["function"]
                                                if fn.get("name"):
                                                    tool_calls_buffer[idx]["function"]["name"] = fn["name"]
                                                if fn.get("arguments"):
                                                    tool_calls_buffer[idx]["function"]["arguments"] += fn["arguments"]

                                except json.JSONDecodeError:
                                    pass
                    except Exception as stream_err:
                        logger.error(f"流式请求出错: {stream_err}")
                        yield f"data: {json.dumps({'type': 'error', 'content': str(stream_err)})}\n\n"
                        return

                    # 如果本轮有工具调用
                    if tool_calls_buffer:
                        tool_calls_list = [v for k, v in sorted(tool_calls_buffer.items())]

                        # 发送工具调用事件（前台渲染折叠卡片）
                        yield f"data: {json.dumps({'type': 'tool_call', 'tool_calls': [(tc['function']['name'], tc['function'].get('arguments', '{}')) for tc in tool_calls_list]})}\n\n"

                        # 保存 assistant 消息（reasoning 不写入 messages，避免回流给模型）
                        assistant_msg = {
                            "role": "assistant",
                            "content": accumulated_content,
                            "tool_calls": [],
                        }
                        messages.append(assistant_msg)

                        for tc in tool_calls_list:
                            try:
                                func_args = json.loads(tc["function"]["arguments"])
                            except (json.JSONDecodeError, TypeError):
                                func_args = {}

                            # 执行工具
                            tool_result = await execute_tool_handler(tc["function"]["name"], func_args)

                            # 发送 tool_result 事件，让前端展示工具返回结果
                            yield f"data: {json.dumps({
                                'type': 'tool_result',
                                'tool_name': tc['function']['name'],
                                'arguments': tc['function'].get('arguments', '{}'),
                                'result': tool_result,
                            })}\n\n"

                            messages.append({
                                "role": "tool",
                                "tool_call_id": tc["id"],
                                "content": json.dumps(tool_result, ensure_ascii=False),
                            })

                            assistant_msg["tool_calls"].append({
                                "id": tc["id"],
                                "type": "function",
                                "function": {"name": tc["function"]["name"], "arguments": tc["function"]["arguments"]},
                            })

                        # 更新请求体，继续下一轮
                        request_body["messages"] = messages
                        accumulated_content = ""
                        accumulated_reasoning = ""
                        tool_calls_buffer = {}
                        continue  # 下一轮迭代

                    else:
                        # 没有工具调用 → 最终回复
                        duration = (datetime.now() - start_time).total_seconds()

                        # 若 API 未返回 usage（部分模型流式不支持），按字符数估算 token
                        if token_usage["total_tokens"] == 0:
                            # 估算：中文字符≈2 tokens，英文≈0.3 tokens
                            total_chars = len(full_content_accumulated) + len(full_reasoning_accumulated)
                            total_chars += sum(len(m.get("content","")) for m in messages[-3:] if m.get("role")=="user")
                            estimated = int(total_chars * 0.5) + 10  # 加 buffer
                            token_usage["prompt_tokens"] = max(token_usage["prompt_tokens"], estimated // 2)
                            token_usage["completion_tokens"] = max(token_usage["completion_tokens"], estimated // 2)
                            token_usage["total_tokens"] = max(token_usage["total_tokens"], estimated)

                        # 更新会话元数据
                        sid = req.session_id
                        if sid not in chat_session_meta:
                            chat_session_meta[sid] = {
                                "token_usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
                                "duration": 0,
                            }
                        meta = chat_session_meta[sid]
                        meta["token_usage"]["prompt_tokens"] += token_usage.get("prompt_tokens", 0)
                        meta["token_usage"]["completion_tokens"] += token_usage.get("completion_tokens", 0)
                        meta["token_usage"]["total_tokens"] += token_usage.get("total_tokens", 0)
                        meta["duration"] += duration

                        # 保存到对话历史（reasoning 不写入 messages）
                        messages.append({
                            "role": "assistant",
                            "content": accumulated_content,
                        })

                        # 发送完成事件（使用全量累加器，包含所有轮次内容）
                        yield f"data: {json.dumps({
                            'type': 'done',
                            'content': full_content_accumulated,
                            'token_usage': token_usage,
                            'duration': duration,
                        })}\n\n"
                        return

                # 超限
                yield f"data: {json.dumps({'type': 'error', 'content': '工具调用循环超过最大次数'})}\n\n"

        except Exception as e:
            logger.error(f"测试流式对话出错: {e}")
            yield f"data: {json.dumps({'type': 'error', 'content': str(e)})}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")


def _parse_ai_final_plan(assistant_content: str) -> Optional[List[Dict]]:
    """
    从模型回复末尾解析 JSON 格式的 final_plan。
    格式: {"final_plan": [{"train_num":"G1","from":"VNP","to":"JGK","seat_type":"class2","tickets":2}]}
    尝试匹配 ```json ... ```、``` ... ``` 或裸 JSON（正确处理嵌套花括号）。
    """
    if not assistant_content:
        return None
    import re
    json_str = None

    # 1. 尝试 ```json ... ``` 或 ``` ... ```
    match = re.search(r'```(?:json)?\s*(\{.*?\})\s*```', assistant_content, re.DOTALL)
    if match:
        json_str = match.group(1)
    else:
        # 2. 定位 "final_plan" 所在的最外层花括号
        idx = assistant_content.find('"final_plan"')
        if idx >= 0:
            # 向左找第一个 {
            start = assistant_content.rfind('{', 0, idx)
            if start >= 0:
                # 向右逐字符匹配花括号，找到对应闭合 }
                depth = 0
                for i in range(start, len(assistant_content)):
                    if assistant_content[i] == '{':
                        depth += 1
                    elif assistant_content[i] == '}':
                        depth -= 1
                        if depth == 0:
                            json_str = assistant_content[start:i + 1]
                            break
    if not json_str:
        return None  # 没有找到 final_plan JSON
    try:
        data = json.loads(json_str)
        plan = data.get("final_plan", [])
        if not isinstance(plan, list):
            return None
        if len(plan) == 0:
            return []  # 模型明确输出无解
        # 用 verifier 的统一字段契约归一化（兼容 from/to 与 from_station_id/to_station_id）
        validated = [e for e in normalize_final_plan(plan) if not e.get("__invalid__")]
        if validated:
            return validated
        # 有 final_plan JSON 但无有效条目
        return []
    except (json.JSONDecodeError, ValueError, TypeError):
        pass
    return None


@app.post("/api/test/complete")
def api_test_complete(req: TestCompleteRequest):
    """标记测试完成，保存记录"""
    session = chat_sessions.get(req.session_id)
    if not session:
        raise HTTPException(status_code=400, detail="会话不存在")

    # 提取对话信息
    user_input = ""
    final_answer = ""
    for msg in reversed(session):
        if msg["role"] == "user":
            user_input = msg["content"]
            break

    for msg in reversed(session):
        if msg["role"] == "assistant" and msg.get("content"):
            final_answer = msg["content"]
            break

    try:
        question_id = get_current_question()
    except ValueError:
        question_id = "unknown"

    # 获取会话累计的 token_usage 和 duration
    meta = chat_session_meta.get(req.session_id, {})
    token_usage = meta.get("token_usage", {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0})
    duration = meta.get("duration", 0)

    # 获取模型名称
    model_name = chat_session_model.get(req.session_id, "unknown")

    # 生成保存路径
    from config import LOGS_TEST_DIR
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"{timestamp}_{model_name}_{question_id}.json"
    filepath = os.path.join(LOGS_TEST_DIR, filename)

    # 从模型回复中解析 AI 输出的结构化 final_plan
    final_plan = _parse_ai_final_plan(final_answer)
    if final_plan is None:
        final_plan = []  # 无 JSON 输出视为未规划
        plan_status = "no_plan"  # 模型未输出 final_plan
    elif len(final_plan) == 0:
        plan_status = "no_solution"  # 模型明确无解
    else:
        plan_status = "has_solution"  # 有方案

    record = {
        "timestamp": datetime.now().isoformat(),
        "question_id": question_id,
        "model_name": model_name,
        "user_input": user_input,
        "conversation": session,
        "final_answer": final_answer,
        "final_plan": final_plan,
        "plan_status": plan_status,
        "token_usage": token_usage,
        "duration": duration,
    }

    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(record, f, ensure_ascii=False, indent=2)

    return {
        "success": True,
        "filepath": filepath,
        "filename": filename,
        "message": f"测试记录已保存至 {filename}",
        "token_usage": token_usage,
        "duration": duration,
        "model_name": model_name,
        "final_plan": final_plan,
        "plan_status": plan_status,
    }


class TestResetRequest(BaseModel):
    session_id: str = "default"


@app.post("/api/test/reset")
def api_test_reset(req: TestResetRequest):
    """重置对话"""
    session_id = req.session_id
    chat_sessions[session_id] = []
    if session_id in chat_session_meta:
        del chat_session_meta[session_id]
    if session_id in chat_session_model:
        del chat_session_model[session_id]
    return {"success": True, "message": "对话已重置"}


async def execute_tool_handler(func_name: str, func_args: Dict) -> Any:
    """执行工具函数"""
    rw_conn = get_railway_conn()
    try:
        if func_name == "query_trains_between_stations":
            data = get_routes_between(
                rw_conn,
                func_args.get("from_station_id", ""),
                func_args.get("to_station_id", "")
            )
            return data

        elif func_name == "query_trains_at_station":
            result = get_station_trains(rw_conn, func_args.get("station_id", ""))
            if result is None:
                return {"error": f"车站 {func_args.get('station_id', '')} 未找到"}
            return result["trains"]

        elif func_name == "query_train_detail":
            stops = get_train_stops(rw_conn, func_args.get("train_num", ""))
            if not stops:
                return {"error": f"车次 {func_args.get('train_num', '')} 未找到或无经停数据"}
            return {"stops": stops}

        elif func_name == "list_stations":
            keyword = func_args.get("keyword", "")
            limit = func_args.get("limit", 50)
            page = func_args.get("page", 1)
            cursor = rw_conn.cursor()
            offset = (page - 1) * limit
            if keyword:
                cursor.execute(
                    "SELECT station_id, station_name FROM stations WHERE station_name LIKE ? OR station_id LIKE ? ORDER BY station_name LIMIT ? OFFSET ?",
                    (f"%{keyword}%", f"%{keyword}%", limit, offset)
                )
            else:
                cursor.execute(
                    "SELECT station_id, station_name FROM stations ORDER BY station_name LIMIT ? OFFSET ?",
                    (limit, offset)
                )
            data = [{"station_id": row[0], "station_name": row[1]} for row in cursor.fetchall()]
            return data

        elif func_name == "list_trains":
            keyword = func_args.get("keyword", "")
            limit = func_args.get("limit", 50)
            page = func_args.get("page", 1)
            cursor = rw_conn.cursor()
            offset = (page - 1) * limit
            if keyword:
                cursor.execute(
                    "SELECT train_num FROM trains WHERE train_num LIKE ? ORDER BY train_num LIMIT ? OFFSET ?",
                    (f"%{keyword}%", limit, offset)
                )
            else:
                cursor.execute(
                    "SELECT train_num FROM trains ORDER BY train_num LIMIT ? OFFSET ?",
                    (limit, offset)
                )
            data = [{"train_num": row[0]} for row in cursor.fetchall()]
            return data

        elif func_name == "query_tickets":
            try:
                question_id = get_current_question()
            except ValueError as e:
                return {"error": str(e)}

            db_path = get_question_db_path(question_id)
            if not os.path.exists(db_path):
                return {"error": f"题目 {question_id} 不存在"}

            q_conn = sqlite3.connect(db_path)
            try:
                seat_types = func_args.get("seat_types", None)
                from_station = func_args.get("from_station_id", None)
                to_station = func_args.get("to_station_id", None)
                tickets = get_train_tickets_filtered(
                    q_conn,
                    func_args.get("train_num", ""),
                    from_station,
                    to_station,
                    seat_types,
                )
                # 当指定了站对但数据库为空时，返回 0 张而非空对象
                if from_station and to_station:
                    types_to_check = seat_types if seat_types else TICKET_TABLES
                    key = f"{from_station}|{to_station}"
                    for t in types_to_check:
                        if t not in tickets:
                            tickets[t] = {}
                        if key not in tickets[t]:
                            tickets[t][key] = 0
                return tickets
            finally:
                q_conn.close()

        elif func_name == "query_ticket_price":
            from database import get_price, get_prices_conn
            p_conn = get_prices_conn()
            try:
                prices = {}
                for seat in ["class2", "class1", "class0"]:
                    p = get_price(
                        p_conn,
                        func_args.get("train_num", ""),
                        func_args.get("from_station_id", ""),
                        func_args.get("to_station_id", ""),
                        seat
                    )
                    if p is not None:
                        prices[seat] = p
            finally:
                p_conn.close()
            return prices if prices else None

        else:
            return {"error": f"未知工具: {func_name}"}

    except Exception as e:
        return {"error": str(e)}
    finally:
        rw_conn.close()


# ============================================================
# 第四部分：测评器接口
# ============================================================

class EvalCompleteRequest(BaseModel):
    question_id: str
    model_name: str
    user_input: str
    test_file: str
    score_summary: Dict
    verification: Dict
    human_confirmed: bool = False
    human_notes: str = ""


@app.post("/api/eval/complete")
def api_eval_complete(req: EvalCompleteRequest):
    """标记测评完成，保存结果"""
    from config import LOGS_RESULT_DIR

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"{timestamp}_{req.model_name}_{req.question_id}.json"
    filepath = os.path.join(LOGS_RESULT_DIR, filename)

    record = {
        "timestamp": datetime.now().isoformat(),
        "test_file": req.test_file,
        "question_id": req.question_id,
        "model_name": req.model_name,
        "user_input": req.user_input,
        "score_summary": req.score_summary,
        "verification": req.verification,
        "human_confirmed": req.human_confirmed,
        "human_notes": req.human_notes,
        "status": "success",
    }

    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(record, f, ensure_ascii=False, indent=2)

    return {"success": True, "filepath": filepath, "message": f"测评结果已保存至 {filename}"}


@app.get("/api/test/records")
def api_test_records():
    """列出所有测试记录"""
    from config import LOGS_TEST_DIR
    records = []
    if os.path.exists(LOGS_TEST_DIR):
        for f in sorted(os.listdir(LOGS_TEST_DIR), reverse=True):
            if f.endswith(".json"):
                filepath = os.path.join(LOGS_TEST_DIR, f)
                try:
                    with open(filepath, "r", encoding="utf-8") as fh:
                        data = json.load(fh)
                    records.append({
                        "filename": f,
                        "timestamp": data.get("timestamp", ""),
                        "question_id": data.get("question_id", ""),
                        "model_name": data.get("model_name", ""),
                        "user_input": data.get("user_input", ""),
                    })
                except Exception:
                    records.append({"filename": f, "error": "读取失败"})
    return {"records": records, "total": len(records)}


class EvalVerifyRequest(BaseModel):
    question_id: str
    final_plan: List[Dict]


@app.post("/api/eval/verify")
def api_eval_verify(req: EvalVerifyRequest):
    """
    代码核查：对比最终乘车方案与余票数据库。
    - 从测试记录的 final_plan 中提取声称要购买的车次、座位、区间
    - 查对应题目的余票数据库，验证是否真的有票
    """
    if not req.question_id:
        raise HTTPException(status_code=400, detail="question_id 不能为空")
    if not req.final_plan:
        return {
            "total_items": 0,
            "correct_items": 0,
            "issue_count": 0,
            "hallucination_count": 0,
            "price_issue_count": 0,
            "verdict": "empty_plan",
            "results": [],
            "issues": [],
            "summary": "⚠️ 最终乘车方案为空（模型未输出 final_plan 或输出无解）",
        }

    try:
        result = verify_final_plan(req.final_plan, req.question_id)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"核查失败: {str(e)}")


@app.post("/api/eval/load")
def api_eval_load(filename: str = Body(..., embed=True)):
    """加载测试记录"""
    from config import LOGS_TEST_DIR
    filepath = os.path.join(LOGS_TEST_DIR, filename)
    if not os.path.exists(filepath):
        raise HTTPException(status_code=404, detail=f"测试记录 {filename} 不存在")
    with open(filepath, "r", encoding="utf-8") as f:
        data = json.load(f)
    return data


@app.get("/api/eval/results")
def api_eval_results():
    """列出所有测评结果"""
    from config import LOGS_RESULT_DIR
    results = []
    if os.path.exists(LOGS_RESULT_DIR):
        for f in sorted(os.listdir(LOGS_RESULT_DIR), reverse=True):
            if f.endswith(".json"):
                filepath = os.path.join(LOGS_RESULT_DIR, f)
                try:
                    with open(filepath, "r", encoding="utf-8") as fh:
                        data = json.load(fh)
                    results.append({
                        "filename": f,
                        "timestamp": data.get("timestamp", ""),
                        "question_id": data.get("question_id", ""),
                        "model_name": data.get("model_name", ""),
                        "score_summary": data.get("score_summary", {}),
                    })
                except Exception:
                    results.append({"filename": f, "error": "读取失败"})
    return {"results": results, "total": len(results)}


# ============================================================
# 第五部分：统计接口
# ============================================================

@app.get("/api/stats/summary")
def api_stats_summary():
    """获取统计汇总数据"""
    from statistics.aggregator import aggregate_results
    try:
        data = aggregate_results()
        return data
    except Exception as e:
        return {"error": str(e)}


@app.get("/api/stats/export/json")
def api_stats_export_json():
    """导出 JSON 格式报告"""
    from statistics.reporter import generate_report
    try:
        report = generate_report()
        return JSONResponse(content=report)
    except Exception as e:
        return {"error": str(e)}


@app.get("/api/stats/export/markdown")
def api_stats_export_markdown():
    """导出 Markdown 格式报告"""
    from statistics.reporter import export_markdown
    try:
        md = export_markdown()
        return HTMLResponse(content=md, media_type="text/markdown")
    except Exception as e:
        return {"error": str(e)}


# ============================================================
# 第六部分：静态文件服务
# ============================================================

# 挂载静态文件目录
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
if os.path.exists(STATIC_DIR):
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


# 前端页面路由（SPA：所有页面路由返回 index.html，JS 负责显示对应页面）


@app.get("/", response_class=HTMLResponse)
def index():
    return get_html("index.html")


@app.get("/manual_question", response_class=HTMLResponse)
def manual_question():
    return get_html("index.html")


@app.get("/auto_question", response_class=HTMLResponse)
def auto_question():
    return get_html("index.html")


@app.get("/selective_question", response_class=HTMLResponse)
def selective_question():
    return get_html("index.html")


@app.get("/question_manager", response_class=HTMLResponse)
def question_manager():
    return get_html("index.html")


@app.get("/edit_question", response_class=HTMLResponse)
def edit_question():
    return get_html("index.html")


@app.get("/stats", response_class=HTMLResponse)
def stats():
    return get_html("index.html")


@app.get("/eval", response_class=HTMLResponse)
def eval_page():
    return get_html("index.html")


def get_html(filename: str) -> str:
    """读取 HTML 文件"""
    filepath = os.path.join(TEMPLATES_DIR, filename)
    if os.path.exists(filepath):
        with open(filepath, "r", encoding="utf-8") as f:
            return f.read()
    return f"<html><body><h1>404</h1><p>{filename} 未找到</p></body></html>"


# ============================================================
# 启动入口
# ============================================================
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=API_CONFIG["host"], port=API_CONFIG["port"])