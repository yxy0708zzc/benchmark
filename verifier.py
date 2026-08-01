"""
代码核查模块（简化版）
验证测试结果中的最终乘车方案是否与余票数据库一致。
不再使用正则解析模型自然语言，直接对比结构化的 final_plan 与 DB 数据。
"""

import os
import sqlite3
from typing import Dict, List, Any
from config import get_question_db_path
from database import TICKET_TABLES, get_price, get_prices_conn


def verify_final_plan(final_plan: List[Dict], question_id: str) -> Dict[str, Any]:
    """
    验证最终乘车方案：查余票数据库 + 核验票价。
    
    Args:
        final_plan: 测试记录中的最终方案，每条含 train_num, seat_type, 
                    from_station_id, to_station_id, tickets[, price]
        question_id: 题目 ID，用于定位对应数据库
    
    Returns:
        {
            "total_items": int,
            "correct_items": int,
            "issue_count": int,
            "results": [{...}],   # 每条方案的验证明细
            "issues": [{...}],    # 有问题的条目
            "summary": str,
        }
    """
    db_path = get_question_db_path(question_id)
    if not os.path.exists(db_path):
        return {
            "total_items": 0,
            "correct_items": 0,
            "issue_count": 1,
            "hallucination_count": 0,
            "price_issue_count": 0,
            "verdict": "db_not_found",
            "results": [],
            "issues": [{
                "type": "db_not_found",
                "detail": f"题目 {question_id} 的数据库不存在",
            }],
            "summary": "❌ 题目数据库不存在",
        }

    conn = sqlite3.connect(db_path)
    p_conn = get_prices_conn()
    try:
        cursor = conn.cursor()

        results = []
        issues = []

        for item in final_plan:
            train_num = item.get("train_num", "")
            seat_type = item.get("seat_type", "")
            from_id = item.get("from_station_id", "")
            to_id = item.get("to_station_id", "")
            claimed = item.get("tickets", 0)
            claimed_price = item.get("price")

            # ---------- 余票核验 ----------
            if seat_type not in TICKET_TABLES:
                results.append({
                    "train_num": train_num,
                    "from_station_id": from_id,
                    "to_station_id": to_id,
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

            result_item = {
                "train_num": train_num,
                "from_station_id": from_id,
                "to_station_id": to_id,
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