"""
清理票价数据不全的车次
- 扫描所有车次，逐辆展示数据完整性详情
- 每辆车逐个确认：y 删除 / n 跳过

执行方式：python cleanup_incomplete_trains.py
"""

import sqlite3
import os
import json
import sys

# ============================================================
# 路径
# ============================================================
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
RAILWAY_DB = os.path.join(BASE_DIR, "data", "railway.db")
PRICES_DB = os.path.join(BASE_DIR, "data", "prices.db")
SAME_TRAINS_JSON = os.path.join(BASE_DIR, "data", "same_trains.json")


def inspect_train(train_num: str) -> dict:
    """
    检查一趟车的数据完整性，返回详细报告：
    {
        "train_num": "G1401",
        "in_trains": True/False,         # 在 trains 表中
        "stop_count": 21,                # 经停站数
        "stops_ok": True/False,          # 经停站 >= 2
        "expected_pairs": 210,           # 应有站对数
        "actual_pairs": 0,               # 实际站对数
        "pairs_ok": True/False,          # 票价数据完整
        "complete": True/False,          # 所有数据完整
        "seat_types": [...],             # 已有的座位类型
    }
    """
    result = {"train_num": train_num}

    # --- railway.db 检查 ---
    rw = sqlite3.connect(RAILWAY_DB)
    cursor = rw.cursor()

    cursor.execute("SELECT 1 FROM trains WHERE train_num = ?", (train_num,))
    result["in_trains"] = cursor.fetchone() is not None

    cursor.execute("SELECT COUNT(*) FROM train_stops WHERE train_num = ?", (train_num,))
    result["stop_count"] = cursor.fetchone()[0]
    result["stops_ok"] = result["stop_count"] >= 2

    rw.close()

    # --- prices.db 检查 ---
    pr = sqlite3.connect(PRICES_DB)
    cursor = pr.cursor()

    result["expected_pairs"] = result["stop_count"] * (result["stop_count"] - 1) // 2 if result["stops_ok"] else 0

    cursor.execute(
        "SELECT COUNT(DISTINCT from_station_id || '|' || to_station_id) "
        "FROM prices WHERE train_num = ?", (train_num,)
    )
    result["actual_pairs"] = cursor.fetchone()[0]
    result["pairs_ok"] = result["actual_pairs"] >= result["expected_pairs"]

    cursor.execute(
        "SELECT DISTINCT seat FROM prices WHERE train_num = ? ORDER BY seat", (train_num,)
    )
    result["seat_types"] = [row[0] for row in cursor.fetchall()]

    pr.close()

    result["complete"] = result["stops_ok"] and result["pairs_ok"]
    return result


def print_train_detail(info: dict):
    """打印一辆车的数据完整性详情"""
    tn = info["train_num"]
    print(f"\n{'─' * 50}")
    print(f"  车次: {tn}")
    print(f"{'─' * 50}")

    # trains 表
    print(f"  trains 表:        {'✅ 存在' if info['in_trains'] else '❌ 不存在'}")

    # 经停站
    stops_status = "✅" if info["stops_ok"] else "❌"
    print(f"  经停站数:         {stops_status} {info['stop_count']} 站", end="")
    if not info["stops_ok"]:
        print("（不足 2 站）", end="")
    print()

    # 票价
    if info["stops_ok"]:
        ratio = f"{info['actual_pairs']}/{info['expected_pairs']}"
        pairs_status = "✅" if info["pairs_ok"] else "❌"
        print(f"  票价站对数:       {pairs_status} {ratio}", end="")
        if not info["pairs_ok"]:
            print(f"（缺 {info['expected_pairs'] - info['actual_pairs']} 个）", end="")
        print()
        print(f"  已有座位类型:     {info['seat_types'] or '无'}")

    # 综合判定
    print(f"  ─────────────────────────────")
    print(f"  综合判定:         {'✅ 数据完整' if info['complete'] else '❌ 数据不全'}")


def delete_train_completely(train_num: str) -> dict:
    """
    从所有数据库删除一趟车的全部数据。
    返回 {success: bool, details: [str]}
    """
    details = []

    # 1. prices.db
    try:
        pr = sqlite3.connect(PRICES_DB)
        pr.execute("DELETE FROM prices WHERE train_num = ?", (train_num,))
        pr.commit()
        pr.close()
        details.append("✓ prices.db")
    except Exception as e:
        details.append(f"✗ prices.db: {e}")

    # 2. railway.db (train_stops + trains)
    try:
        rw = sqlite3.connect(RAILWAY_DB)
        rw.execute("PRAGMA foreign_keys = ON")
        rw.execute("DELETE FROM train_stops WHERE train_num = ?", (train_num,))
        rw.execute("DELETE FROM trains WHERE train_num = ?", (train_num,))
        rw.commit()
        rw.close()
        details.append("✓ railway.db (trains + train_stops)")
    except Exception as e:
        details.append(f"✗ railway.db: {e}")

    # 3. same_trains.json
    if os.path.exists(SAME_TRAINS_JSON):
        try:
            with open(SAME_TRAINS_JSON, "r", encoding="utf-8") as f:
                groups = json.load(f)

            new_groups = []
            for group in groups:
                if train_num in group["trains"]:
                    remaining = [t for t in group["trains"] if t != train_num]
                    if len(remaining) >= 2:
                        group["trains"] = sorted(remaining)
                        group["count"] = len(remaining)
                        new_groups.append(group)
                else:
                    new_groups.append(group)

            with open(SAME_TRAINS_JSON, "w", encoding="utf-8") as f:
                json.dump(new_groups, f, ensure_ascii=False, indent=2)
            details.append("✓ same_trains.json")
        except Exception as e:
            details.append(f"✗ same_trains.json: {e}")

    return {"success": all("✗" not in d for d in details), "details": details}


def rebuild_station_trains():
    """重建 station_trains 物化视图"""
    from database import refresh_station_trains
    conn = sqlite3.connect(RAILWAY_DB)
    refresh_station_trains(conn)
    conn.close()


def main():
    print("=" * 60)
    print("  清理票价数据不全的车次")
    print("  逐个展示，逐个确认（y=删除 / n=跳过）")
    print("=" * 60)

    # 获取所有车次
    rw = sqlite3.connect(RAILWAY_DB)
    cursor = rw.cursor()
    cursor.execute("SELECT train_num FROM trains ORDER BY train_num")
    all_trains = [row[0] for row in cursor.fetchall()]
    rw.close()

    # 逐个检查
    incomplete_trains = []
    for tn in all_trains:
        info = inspect_train(tn)
        if not info["complete"]:
            incomplete_trains.append(info)

    if not incomplete_trains:
        print("\n✅ 所有车次数据完整，无需清理。")
        return

    print(f"\n发现 {len(incomplete_trains)} 个数据不全的车次。")

    # 逐个展示 + 确认
    deleted = []
    skipped = []
    need_rebuild = False

    for info in incomplete_trains:
        print_train_detail(info)

        while True:
            try:
                raw = input(f"\n  删除 {info['train_num']} 的全部数据？(Y/n): ").strip().lower()
            except (EOFError, KeyboardInterrupt):
                print("\n  检测到 Ctrl+C，停止处理，下次可继续。")
                # 跳过当前车次，直接跳到报告
                for remaining in incomplete_trains[incomplete_trains.index(info):]:
                    skipped.append(remaining["train_num"])
                _rebuild_and_report(deleted, skipped, need_rebuild)
                return
            choice = "y" if raw in ("", "y") else "n"
            break

        if choice == "y":
            result = delete_train_completely(info["train_num"])
            status = "✅ 已删除" if result["success"] else "⚠️ 部分失败"
            for d in result["details"]:
                print(f"    {d}")
            deleted.append(info["train_num"])
            if result["success"]:
                need_rebuild = True
            print(f"  {status}")
        else:
            skipped.append(info["train_num"])
            print(f"  ⏭ 已跳过")

    _rebuild_and_report(deleted, skipped, need_rebuild)


def _rebuild_and_report(deleted: list, skipped: list, need_rebuild: bool = True):
    """重建物化视图 + 打印报告"""
    if need_rebuild:
        print(f"\n{'─' * 50}")
        print(f"  重建 station_trains 物化视图...")
        try:
            rebuild_station_trains()
            print(f"  ✅ 重建完成")
        except Exception as e:
            print(f"  ❌ 重建失败: {e}")

    print(f"\n{'=' * 60}")
    print(f"  清理报告")
    print(f"{'=' * 60}")
    if deleted:
        print(f"  已删除 ({len(deleted)}): {', '.join(deleted)}")
    if skipped:
        print(f"  已跳过 ({len(skipped)}): {', '.join(skipped)}")
    print(f"{'=' * 60}")


if __name__ == "__main__":
    main()
