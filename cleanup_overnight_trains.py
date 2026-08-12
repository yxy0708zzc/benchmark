"""
清理跨天车次（当日完成约束：跨天车次不可用）
- 判定：车次内存在相邻经停站 stop_time 时间倒退（如 23:20 → 00:07），说明跨到次日
- 默认只显示；加 --apply 才真正删除（先显示后删除）

执行方式：
    python cleanup_overnight_trains.py            # 只显示跨天车次
    python cleanup_overnight_trains.py --apply    # 显示 + 删除
"""

import sqlite3
import os
import json
import sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
RAILWAY_DB = os.path.join(BASE_DIR, "data", "railway.db")
PRICES_DB = os.path.join(BASE_DIR, "data", "prices.db")
SAME_TRAINS_JSON = os.path.join(BASE_DIR, "data", "same_trains.json")


def find_overnight_trains() -> dict:
    """
    扫描所有车次，返回跨天车次：
    { train_num: [(stop_no, from_time, to_time), ...] }  # 跨天发生的位置
    """
    conn = sqlite3.connect(RAILWAY_DB)
    try:
        rows = conn.execute("""
            SELECT a.train_num, a.stop_no, a.stop_time, b.stop_time
            FROM train_stops a
            JOIN train_stops b
              ON a.train_num = b.train_num AND a.stop_no = b.stop_no - 1
            ORDER BY a.train_num, a.stop_no
        """).fetchall()
    finally:
        conn.close()

    result = {}
    for train_num, stop_no, t_from, t_to in rows:
        # 只有「时间倒退」才是跨天（如 23:20 → 00:07）；正常车次后站时间晚于前站
        if t_from > t_to:
            result.setdefault(train_num, []).append((stop_no, t_from, t_to))
    return result


def delete_train_completely(train_num: str) -> dict:
    """从所有数据库删除一趟车的全部数据（复用 cleanup_incomplete_trains 模式）"""
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
                if train_num in group.get("trains", []):
                    remaining = [t for t in group["trains"] if t != train_num]
                    if len(remaining) >= 2:
                        group["trains"] = sorted(remaining)
                        group["count"] = len(remaining)
                        new_groups.append(group)
                    # 剩余 < 2 则整组删除
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
    try:
        from database import refresh_station_trains
        conn = sqlite3.connect(RAILWAY_DB)
        refresh_station_trains(conn)
        conn.close()
        return True
    except Exception as e:
        # station_trains 是按 station_id 聚合的物化视图，无 train_num 列；
        # 重建失败时如实报错，避免用错误的 SQL 破坏数据
        print(f"⚠️ station_trains 重建失败: {e}")
        return False


def main():
    apply = "--apply" in sys.argv
    print("=" * 64)
    print("  清理跨天车次（当日完成约束）")
    print("  判定：相邻经停站 stop_time 时间倒退（如 23:20 → 00:07）")
    print(f"  模式：{'【执行删除】' if apply else '【仅显示】'}（加 --apply 执行删除）")
    print("=" * 64)

    overnight = find_overnight_trains()
    if not overnight:
        print("\n✅ 没有跨天车次。")
        return

    print(f"\n发现 {len(overnight)} 个跨天车次：\n")
    for tn in sorted(overnight):
        spots = overnight[tn]
        detail = "；".join(f"第{s}站 {a}→{b}" for s, a, b in spots)
        print(f"  {tn}: {detail}")
    print()

    if not apply:
        print("（以上仅显示。确认后执行：python cleanup_overnight_trains.py --apply）")
        return

    # 执行删除
    print("正在删除 ...\n")
    failed = []
    for tn in sorted(overnight):
        result = delete_train_completely(tn)
        status = "✅" if result["success"] else "❌"
        print(f"  {status} {tn}: {'; '.join(result['details'])}")
        if not result["success"]:
            failed.append(tn)

    rebuild_station_trains()
    print("\nstation_trains 已重建。")

    # 复查
    remaining = find_overnight_trains()
    print(f"\n删除后剩余跨天车次: {len(remaining)}")
    if failed:
        print(f"⚠️ 删除失败的车次: {failed}")
    if remaining:
        print(f"⚠️ 仍有跨天车次: {sorted(remaining)}")
    else:
        print("✅ 跨天车次已全部清理。")


if __name__ == "__main__":
    main()
