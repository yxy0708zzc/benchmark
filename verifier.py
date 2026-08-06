"""
代码核查模块（简化版）
验证测试结果中的最终乘车方案是否与余票数据库一致。
不再使用正则解析模型自然语言，直接对比结构化的 final_plan 与 DB 数据。
"""

import os
import sqlite3
from typing import Dict, List, Any
from config import get_question_db_path
from database import (
    TICKET_TABLES, get_price, get_prices_conn,
    get_question_metadata, get_railway_conn, get_train_stops,
)


def normalize_final_plan(raw_plan: List[Dict]) -> List[Dict]:
    """统一 final_plan 字段契约（唯一入口）。

    兼容两种字段命名：
      - prompt / 模型输出：train_num, from, to, seat_type, tickets[, price]
      - 内部存储 / 旧格式：train_num, from_station_id, to_station_id, seat_type, tickets[, price]
    统一输出 from_station_id / to_station_id，并做类型归一（tickets→int, price→float）。

    段类型（seg_type）：
      - "purchase"（默认）：购票段，必须含 seat_type、tickets，且必须标注实际乘坐区间 ride_from/ride_to
      - "onboard"：上车补票段（DB 无票），只需 train_num/from/to，不查票；乘坐区间即 from/to
    购买/乘坐双字段：
      - from_station_id/to_station_id：购买区间（买了哪段票）
      - ride_from_station_id/ride_to_station_id：实际乘坐区间（缺省=购买区间；购买段缺则带 __missing_ride__）
    缺关键字段或非对象条目：返回条目带 "__invalid__": True，
    调用方应将其作为 invalid_plan_item 处理（而不是误判为幻觉）。
    """
    out: List[Dict] = []
    for item in raw_plan or []:
        if not isinstance(item, dict):
            out.append({"__invalid__": True, "error": "条目非对象", "raw": item})
            continue
        train_num = item.get("train_num", "")
        from_id = item.get("from_station_id") or item.get("from", "")
        to_id = item.get("to_station_id") or item.get("to", "")
        seg_type = str(item.get("seg_type") or "").strip().lower()
        is_onboard = seg_type == "onboard" or item.get("onboard") is True
        if not (train_num and from_id and to_id):
            out.append({"__invalid__": True, "error": "缺关键字段(train_num/from/to)", "raw": item})
            continue
        ride_from = item.get("ride_from_station_id") or item.get("ride_from") or ""
        ride_to = item.get("ride_to_station_id") or item.get("ride_to") or ""
        if is_onboard:
            # 补票段无票，乘坐区间即 from/to（恒等，无歧义，兜底）
            entry: Dict[str, Any] = {
                "train_num": str(train_num),
                "from_station_id": str(from_id),
                "to_station_id": str(to_id),
                "ride_from_station_id": str(ride_from or from_id),
                "ride_to_station_id": str(ride_to or to_id),
                "seg_type": "onboard",
            }
        else:
            seat_type = item.get("seat_type", "")
            if not seat_type:
                out.append({"__invalid__": True, "error": "购票段缺 seat_type", "raw": item})
                continue
            entry = {
                "train_num": str(train_num),
                "from_station_id": str(from_id),
                "to_station_id": str(to_id),
                "ride_from_station_id": str(ride_from or from_id),
                "ride_to_station_id": str(ride_to or to_id),
                "seat_type": str(seat_type),
                "tickets": int(item.get("tickets", 0) or 0),
                "seg_type": "purchase",
            }
            if not (ride_from and ride_to):
                # 购买段必须标注实际乘坐区间，缺=答不全（仍用 from/to 兜底继续核查）
                entry["__missing_ride__"] = True
            price = item.get("price")
            if price is not None:
                try:
                    entry["price"] = float(price)
                except (ValueError, TypeError):
                    pass
        method = item.get("method") or item.get("strategy")
        if method:
            entry["method"] = str(method)
        out.append(entry)
    return out


def verify_final_plan(final_plan: List[Dict], question_id: str) -> Dict[str, Any]:
    """
    验证最终乘车方案：查余票数据库 + 核验票价。

    字段契约已由 normalize_final_plan 统一：兼容模型输出的 from/to 与内部 from_station_id/to_station_id，
    外部工具（如 run_benchmark.py）可直接把模型原始 final_plan 传入本函数。

    Args:
        final_plan: 测试记录中的最终方案，每条含 train_num, seat_type,
                    from_station_id/to_station_id（或 from/to）, tickets[, price]
        question_id: 题目 ID，用于定位对应数据库

    Returns:
        {
            "total_items": int,
            "correct_items": int,
            "issue_count": int,
            "invalid_plan_count": int,
            "results": [{...}],   # 每条方案的验证明细
            "issues": [{...}],    # 有问题的条目
            "summary": str,
        }
    """
    # ---- 字段契约归一化：任何来源的 final_plan 先归一，缺字段的记为 invalid ----
    valid_items: List[Dict] = []
    invalid_items: List[Dict] = []
    for it in normalize_final_plan(final_plan):
        (valid_items if not it.get("__invalid__") else invalid_items).append(it)
    final_plan = valid_items
    invalid_issues = [{
        "type": "invalid_plan_item",
        "detail": f"计划条目无效: {inv.get('error', '未知')} | raw={inv.get('raw')}",
    } for inv in invalid_items]
    # 购买段缺"实际乘坐区间"（答不全）：记 missing_ride，但仍用 from/to 兜底继续核查
    missing_ride_issues = [{
        "type": "missing_ride",
        "train_num": it.get("train_num"),
        "from_station_id": it.get("from_station_id"),
        "to_station_id": it.get("to_station_id"),
        "detail": f"购票段 {it.get('train_num')} {it.get('from_station_id')}→{it.get('to_station_id')} 未标注实际乘坐区间 ride_from/ride_to（必须写出）",
    } for it in final_plan if it.get("__missing_ride__")]

    # ---- 拆分购票段（onboard 兼容旧输出，不查票）；读取标答(ground_truth)与需求 ----
    purchase_items = [i for i in final_plan if i.get("seg_type") != "onboard"]
    meta = get_question_metadata(question_id)
    gt = meta.get("ground_truth") or []
    people_count = meta.get("people_count", 1)
    # 选择性题（interference_mode=real）：层2 只做全程可达校验，不与标答完全一致对比
    selective = meta.get("interference_mode") == "real"
    start_id = meta.get("start_station_id") or (gt[0]["from_station_id"] if gt else None)
    end_id = meta.get("end_station_id") or (gt[-1]["to_station_id"] if gt else None)
    gt_purchase = [g for g in gt if g.get("seg_type") != "onboard"]

    db_path = get_question_db_path(question_id)
    if not os.path.exists(db_path):
        return {
            "total_items": 0,
            "correct_items": 0,
            "issue_count": 1 + len(invalid_issues),
            "hallucination_count": 0,
            "price_issue_count": 0,
            "invalid_plan_count": len(invalid_items),
            "verdict": "db_not_found",
            "results": [],
            "issues": [{
                "type": "db_not_found",
                "detail": f"题目 {question_id} 的数据库不存在",
            }] + invalid_issues,
            "summary": "❌ 题目数据库不存在",
        }

    # 加载站名映射（id→汉字），供验证明细展示
    rw = get_railway_conn()
    try:
        name_map = dict(rw.execute("SELECT station_id, station_name FROM stations").fetchall())
    finally:
        rw.close()

    conn = sqlite3.connect(db_path)
    p_conn = get_prices_conn()
    try:
        cursor = conn.cursor()

        results = []
        issues = list(invalid_issues) + list(missing_ride_issues)   # 无效条目 + 缺乘坐区间一并计入问题

        for item in purchase_items:   # 仅购票段查余票/票价；补票段不查 DB
            train_num = item.get("train_num", "")
            seat_type = item.get("seat_type", "")
            from_id = item.get("from_station_id", "")
            to_id = item.get("to_station_id", "")
            claimed = item.get("tickets", 0)
            claimed_price = item.get("price")

            # ---------- 余票核验 ----------
            if seat_type not in TICKET_TABLES:
                ride_from_id = item.get("ride_from_station_id", "")
                ride_to_id = item.get("ride_to_station_id", "")
                results.append({
                    "train_num": train_num,
                    "from_station_id": from_id,
                    "to_station_id": to_id,
                    "from_name": name_map.get(from_id, from_id),
                    "to_name": name_map.get(to_id, to_id),
                    "ride_from_station_id": ride_from_id,
                    "ride_to_station_id": ride_to_id,
                    "ride_from_name": name_map.get(ride_from_id, ride_from_id) if ride_from_id else "",
                    "ride_to_name": name_map.get(ride_to_id, ride_to_id) if ride_to_id else "",
                    "seat_type": seat_type,
                    "claimed": claimed,
                    "actual": None,
                    "match": False,
                    "error": f"无效座位类型: {seat_type}",
                })
                issues.append({
                    "type": "invalid_seat",
                    "train_num": train_num,
                    "from_station_id": from_id,
                    "to_station_id": to_id,
                    "seat_type": seat_type,
                    "claimed": claimed,
                    "actual": None,
                    "detail": f"{train_num} {seat_type} 无效座位类型",
                })
                continue

            cursor.execute(f"""
                SELECT tickets FROM {seat_type}
                WHERE train_num = ? AND from_station_id = ? AND to_station_id = ?
            """, (train_num, from_id, to_id))
            row = cursor.fetchone()
            db_tickets = row[0] if row else 0
            matched = db_tickets is not None and db_tickets >= claimed

            ride_from_id = item.get("ride_from_station_id", "")
            ride_to_id = item.get("ride_to_station_id", "")
            result_item = {
                "train_num": train_num,
                "from_station_id": from_id,
                "to_station_id": to_id,
                "from_name": name_map.get(from_id, from_id),
                "to_name": name_map.get(to_id, to_id),
                "ride_from_station_id": ride_from_id,
                "ride_to_station_id": ride_to_id,
                "ride_from_name": name_map.get(ride_from_id, ride_from_id) if ride_from_id else "",
                "ride_to_name": name_map.get(ride_to_id, ride_to_id) if ride_to_id else "",
                "seat_type": seat_type,
                "claimed": claimed,
                "actual": db_tickets if db_tickets is not None else 0,
                "match": matched,
            }

            if not matched:
                issues.append({
                    "type": "hallucination",
                    "train_num": train_num,
                    "from_station_id": from_id,
                    "to_station_id": to_id,
                    "seat_type": seat_type,
                    "claimed": claimed,
                    "actual": db_tickets if db_tickets is not None else 0,
                    "detail": f"{train_num} {seat_type} 声称有 {claimed} 张票，实际 DB 中为 {db_tickets if db_tickets is not None else 0}",
                })

            # ---------- 票价核验 ----------
            if claimed_price is not None:
                real_price = get_price(p_conn, train_num, from_id, to_id, seat_type)
                if real_price is None:
                    issues.append({
                        "type": "price_missing",
                        "train_num": train_num,
                        "from_station_id": from_id,
                        "to_station_id": to_id,
                        "seat_type": seat_type,
                        "claimed_price": claimed_price,
                        "detail": f"{train_num} {from_id}→{to_id} 声称票价 {claimed_price}元，但数据库中无此区间票价数据",
                    })
                    result_item["price_claimed"] = claimed_price
                    result_item["price_actual"] = None
                    result_item["price_match"] = None
                elif abs(float(claimed_price) - real_price) > 1.0:
                    issues.append({
                        "type": "price_wrong",
                        "train_num": train_num,
                        "from_station_id": from_id,
                        "to_station_id": to_id,
                        "seat_type": seat_type,
                        "claimed_price": claimed_price,
                        "actual_price": real_price,
                        "detail": f"{train_num} {from_id}→{to_id} 声称票价 {claimed_price}元，实际 {real_price}元，差价 {abs(float(claimed_price)-real_price):.1f}元",
                    })
                    result_item["price_claimed"] = claimed_price
                    result_item["price_actual"] = real_price
                    result_item["price_match"] = False
                else:
                    result_item["price_claimed"] = claimed_price
                    result_item["price_actual"] = real_price
                    result_item["price_match"] = True

            results.append(result_item)

        # ---------- 层2：存在性=与标答完全一致；选择性=全程可达 ----------
        def _seg_key(s: Dict) -> tuple:
            return (str(s.get("train_num", "")), str(s.get("from_station_id", "")),
                    str(s.get("to_station_id", "")), str(s.get("seat_type", "")),
                    str(s.get("ride_from_station_id") or s.get("from_station_id", "")),
                    str(s.get("ride_to_station_id") or s.get("to_station_id", "")))
        gt_purchase_keys = {_seg_key(g) for g in gt_purchase}
        for item in purchase_items:
            # 张数不足需求人数（两类题都要求）
            claimed = item.get("tickets", 0)
            if claimed < people_count:
                issues.append({
                    "type": "ticket_shortage",
                    "train_num": item.get("train_num"),
                    "from_station_id": item.get("from_station_id"),
                    "to_station_id": item.get("to_station_id"),
                    "claimed": claimed,
                    "people_count": people_count,
                    "detail": f"{item.get('train_num')} 购票 {claimed} 张，少于需求人数 {people_count}",
                })
            # 选择性题：不做完全一致对标（答案多个），交给下方可达性校验
            if selective:
                continue
            if gt_purchase_keys and _seg_key(item) not in gt_purchase_keys:
                issues.append({
                    "type": "route_mismatch",
                    "train_num": item.get("train_num"),
                    "from_station_id": item.get("from_station_id"),
                    "to_station_id": item.get("to_station_id"),
                    "seat_type": item.get("seat_type"),
                    "detail": f"购票段 {item.get('train_num')} {item.get('from_station_id')}→{item.get('to_station_id')} {item.get('seat_type')} 与标准答案不一致（答案唯一）",
                })
        # 选择性题层2：全程可达校验（拼接所有段乘坐区间：地点连续+时间顺序+连接出发/到达地）
        if selective and (start_id or end_id):
            issues.extend(_check_reachability(final_plan, start_id, end_id))
    finally:
        conn.close()
        p_conn.close()

    correct_count = len([r for r in results if r.get("match")])
    total = len(results)
    hallucination_count = len([i for i in issues if i.get("type") == "hallucination"])
    price_issue_count = len([i for i in issues if i.get("type") in ("price_wrong", "price_missing")])
    total_issue_count = len(issues)

    # 综合判定：简化，只分 pass / hallucination
    if not issues:
        verdict = "pass"
    else:
        verdict = "hallucination"

    return {
        "total_items": total,
        "correct_items": correct_count,
        "issue_count": total_issue_count,
        "hallucination_count": hallucination_count,
        "price_issue_count": price_issue_count,
        "invalid_plan_count": len(invalid_items),
        "route_mismatch_count": len([i for i in issues if i.get("type") == "route_mismatch"]),
        "ticket_shortage_count": len([i for i in issues if i.get("type") == "ticket_shortage"]),
        "missing_ride_count": len(missing_ride_issues),
        "verdict": verdict,
        "results": results,
        "issues": issues,
        "summary": _generate_summary(total, correct_count, total_issue_count, verdict),
    }


def _generate_summary(total: int, correct: int, issue_count: int,
                       verdict: str = "pass") -> str:
    """生成验证总结"""
    if total == 0:
        return "⚠️ 未检测到乘车方案（模型可能未输出 final_plan）"

    label = "✅ 全部通过" if verdict == "pass" else "❌ 存在错误（余票编造或票价不符）"

    if not issue_count:
        return f"{label}：共 {total} 条方案，均与数据库一致"

    return f"{label}：共 {total} 条方案，{correct} 条正确，{issue_count} 条有问题"


def _covers(item: Dict, station_id: str, rw_conn: sqlite3.Connection) -> bool:
    """station_id 是否在 item 实际乘坐区间 [ride_from, ride_to] 内（含端点，兼容买长坐短）"""
    tn = str(item.get("train_num", ""))
    f = str(item.get("ride_from_station_id") or item.get("from_station_id", ""))
    t = str(item.get("ride_to_station_id") or item.get("to_station_id", ""))
    if not (tn and f and t):
        return False
    stops = get_train_stops(rw_conn, tn)
    ids = [s["station_id"] for s in stops]
    if f not in ids or t not in ids or station_id not in ids:
        return False
    return ids.index(f) <= ids.index(station_id) <= ids.index(t)


def _check_reachability(plan_items: List[Dict], start_id: str, end_id: str) -> List[Dict]:
    """选择性问题层2：全程可达校验。

    拼接所有段的实际乘坐区间（ride_from/ride_to，兜底=购买区间），检查：
      1. 地点连续：后段乘坐起点 == 前段乘坐终点
      2. 时间顺序：跨车次换乘时，前段到达时间 ≤ 后段发车时间
      3. 连接出发/到达地：出发站 start_id 在首段乘坐区间内、到达站 end_id 在末段乘坐区间内
    返回问题列表（空=可达）。
    """
    issues: List[Dict] = []
    if not plan_items:
        return [{"type": "no_route", "detail": "方案为空，无法拼接出 A→B 全程"}]
    rw_conn = get_railway_conn()
    try:
        prev_to = None
        prev_train = None
        prev_arr = None
        for i, item in enumerate(plan_items):
            tn = str(item.get("train_num", ""))
            f = str(item.get("ride_from_station_id") or item.get("from_station_id", ""))
            t = str(item.get("ride_to_station_id") or item.get("to_station_id", ""))
            if not (tn and f and t):
                issues.append({"type": "route_invalid", "detail": f"第{i + 1}段缺少车次/区间信息"})
                continue
            stops = get_train_stops(rw_conn, tn)
            ids = [s["station_id"] for s in stops]
            times = {s["station_id"]: s.get("stop_time") for s in stops}
            if f not in ids or t not in ids:
                issues.append({"type": "route_invalid", "train_num": tn, "from_station_id": f,
                               "to_station_id": t, "detail": f"车次 {tn} 不经过 {f} 或 {t}"})
                continue
            idx_f, idx_t = ids.index(f), ids.index(t)
            if idx_f >= idx_t:
                issues.append({"type": "route_invalid", "train_num": tn, "from_station_id": f,
                               "to_station_id": t, "detail": f"车次 {tn} 上 {f}→{t} 方向/顺序错误"})
                continue
            # 1. 地点连续
            if prev_to is not None and f != prev_to:
                issues.append({"type": "route_discontinuity",
                               "detail": f"第{i}段终点 {prev_to} 与第{i + 1}段起点 {f} 不连续"})
            # 2. 时间顺序（跨车次换乘衔接）
            if prev_train is not None and prev_train != tn and prev_arr and times.get(f):
                if str(times[f]) < str(prev_arr):
                    issues.append({"type": "transfer_time_conflict",
                                   "detail": f"{prev_train} 到达 {prev_to} {prev_arr}，晚于 {tn} 从 {f} 发车 {times[f]}"})
            prev_to = t
            prev_train = tn
            prev_arr = times.get(t)
        # 3. 连接出发/到达地（覆盖语义，兼容前/后额外）
        if start_id:
            if not _covers(plan_items[0], start_id, rw_conn):
                issues.append({"type": "start_not_covered", "detail": f"方案未连接出发站 {start_id}"})
        if end_id:
            if not _covers(plan_items[-1], end_id, rw_conn):
                issues.append({"type": "end_not_covered", "detail": f"方案未连接到达站 {end_id}"})
    finally:
        rw_conn.close()
    return issues