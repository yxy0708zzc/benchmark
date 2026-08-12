"""
清理票价数据不全的车次 + 同车多号去重

使用方式（已简化，默认即一键执行）：
    python cleanup_incomplete_trains.py            # 一键执行：去重 → 补算 → 删除仍不全 → 重建物化视图（无需 --apply）
    python cleanup_incomplete_trains.py --check    # 只读体检：待删清单 + 票价不全车次（不写库）

遗留高级选项（可选，向后兼容）：
    python cleanup_incomplete_trains.py --apply        # 一键执行（与无参数等价）
    python cleanup_incomplete_trains.py --fix          # 仅离线补算缺失的非相邻段票价（相邻段齐全的可算）
    python cleanup_incomplete_trains.py --dedup        # 仅报告同车多号去重待删清单
    python cleanup_incomplete_trains.py --interactive  # 逐个展示、逐个确认删除
"""

import sqlite3
import os
import json
import sys
from datetime import datetime

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


def compute_missing_pairs(train_num: str) -> int:
    """离线补算该车次缺失的非相邻段票价（相邻段齐全时累加计算）。
    相邻段不全 → 返回 0（该车需联网补爬或删除）。返回补算条数。"""
    rw = sqlite3.connect(RAILWAY_DB)
    try:
        stops = [{"station_id": r[0]} for r in rw.execute(
            "SELECT station_id FROM train_stops WHERE train_num = ? ORDER BY stop_no",
            (train_num,))]
    finally:
        rw.close()
    if len(stops) < 2:
        return 0

    pr = sqlite3.connect(PRICES_DB)
    try:
        rows = pr.execute(
            "SELECT from_station_id, to_station_id, seat, price FROM prices WHERE train_num = ?",
            (train_num,)).fetchall()
        adj = {(r[0], r[1], r[2]): r[3] for r in rows}
        seats = sorted({r[2] for r in rows})
        if not seats:
            return 0

        all_adj = {(stops[i]["station_id"], stops[i + 1]["station_id"]) for i in range(len(stops) - 1)}
        existing_adj = {(f, t) for (f, t, _s) in adj}
        if all_adj - existing_adj:
            return 0  # 相邻段不全，无法离线补算（需联网补爬）

        n = len(stops)
        computed = 0
        for i in range(n):
            for j in range(i + 2, n):
                f_id, t_id = stops[i]["station_id"], stops[j]["station_id"]
                for seat in seats:
                    total = 0.0
                    valid = True
                    for k in range(i, j):
                        key = (stops[k]["station_id"], stops[k + 1]["station_id"], seat)
                        if key not in adj:
                            valid = False
                            break
                        total += adj[key]
                    if valid:
                        pr.execute(
                            "INSERT OR REPLACE INTO prices (train_num, from_station_id, to_station_id, seat, price, crawl_date) "
                            "VALUES (?, ?, ?, ?, ?, ?)",
                            (train_num, f_id, t_id, seat, round(total, 2),
                             datetime.now().strftime("%Y-%m-%d")))
                        computed += 1
        pr.commit()
    finally:
        pr.close()
    return computed


def rebuild_station_trains():
    """重建 station_trains 物化视图"""
    from database import refresh_station_trains
    conn = sqlite3.connect(RAILWAY_DB)
    refresh_station_trains(conn)
    conn.close()


# ============================================================
# 同车多号去重（--dedup）
# 12306 会把同一列物理列车以多个车次号列出（collector 按「经停序列+时刻完全一致」
# 归组到 same_trains.json）。重复号只写进了 train_stops（查得到车、查不到票价），
# trains / prices 只保留其中一个号。去重 = 每组只保留一个主号，其余重复号全删。
# 该流程独立于票价完整性检查，find_duplicate_trains 为只读函数，可被其他脚本复用。
# ============================================================

def find_duplicate_trains() -> dict:
    """找出「同车多号」的重复车次号 + 纯孤儿车次（只读，不删任何数据）。

    规则：
    - 同车多号（same_trains.json）：每组保留一个「主号」——优先保留在 trains 表中、
      票价记录最多的（并列取字典序最小）；其余成员视为重复号。
    - 纯孤儿：在 train_stops 但不在 trains，且不属于任何同车组 —— 无主号的脏数据。

    返回：{"canonical": {主号: [同组其他号]}, "duplicates": [...],
          "pure_orphans": [...], "group_count": N}
    其中待删全集 = duplicates + pure_orphans。
    """
    rw = sqlite3.connect(RAILWAY_DB)
    pr = sqlite3.connect(PRICES_DB)
    try:
        trains_set = set(r[0] for r in rw.execute("SELECT train_num FROM trains").fetchall())
        stops_set = set(r[0] for r in rw.execute("SELECT DISTINCT train_num FROM train_stops").fetchall())

        def price_count(tn: str) -> int:
            return pr.execute("SELECT COUNT(*) FROM prices WHERE train_num=?", (tn,)).fetchone()[0]

        groups = []
        if os.path.exists(SAME_TRAINS_JSON):
            with open(SAME_TRAINS_JSON, "r", encoding="utf-8") as f:
                groups = json.load(f)

        canonical = {}
        duplicates = []
        group_members = set()
        for g in groups:
            members = g.get("trains", [])
            group_members.update(members)
            in_trains = [t for t in members if t in trains_set]
            if not in_trains:
                # 整组都不在 trains（异常数据）：全部视为重复号
                duplicates.extend(members)
                continue
            keep = min(in_trains, key=lambda t: (-price_count(t), t))
            canonical[keep] = [t for t in members if t != keep]
            duplicates.extend(canonical[keep])

        pure_orphans = sorted(stops_set - trains_set - group_members)
        return {
            "canonical": canonical,
            "duplicates": sorted(duplicates),
            "pure_orphans": pure_orphans,
            "group_count": len(groups),
        }
    finally:
        rw.close()
        pr.close()


def run_dedup(apply: bool = False):
    """同车多号去重：每组保留一个主号，删除其余重复号 + 纯孤儿车次。

    apply=False（默认）：只报告将删除的车次，不删任何数据；
    apply=True：真正删除（train_stops + trains + prices + same_trains.json），
               并重建 station_trains 物化视图。
    该流程独立于票价完整性检查（find_duplicate_trains 返回只读清单，可复用）。
    """
    plan = find_duplicate_trains()
    dup = plan["duplicates"]
    orphan = plan["pure_orphans"]
    remove = sorted(set(dup) | set(orphan))

    print("=" * 60)
    print("  同车多号去重")
    print(f"  模式：{'自动删除（--apply）' if apply else '仅报告（加 --apply 才删除）'}")
    print("=" * 60)
    if not remove:
        print("\n✅ 无重复车次（同车多号已清理干净），无需去重。")
        return

    print(f"\n同车多号组：{plan['group_count']} 组；保留主号 {len(plan['canonical'])} 个")
    print(f"重复车次号：{len(dup)} 个 -> {', '.join(dup)}")
    print(f"纯孤儿车次：{len(orphan)} 个 -> {', '.join(orphan)}")
    print(f"合计待删：{len(remove)} 个")

    if not apply:
        print("\n（未删除任何数据。确认后执行：python cleanup_incomplete_trains.py --dedup --apply）")
        return

    print(f"\n开始删除 {len(remove)} 个车次...")
    deleted = []
    need_rebuild = False
    for tn in sorted(remove):
        result = delete_train_completely(tn)
        deleted.append(tn)
        if result["success"]:
            need_rebuild = True
    _rebuild_and_report(deleted, [], need_rebuild)


def _collect_incomplete():
    """扫描 trains 表中票价不全的车次（只读）"""
    rw = sqlite3.connect(RAILWAY_DB)
    try:
        cursor = rw.cursor()
        cursor.execute("SELECT train_num FROM trains ORDER BY train_num")
        all_trains = [row[0] for row in cursor.fetchall()]
    finally:
        rw.close()
    inc = []
    for tn in all_trains:
        info = inspect_train(tn)
        if not info["complete"]:
            inc.append(info)
    return inc


def _run_report():
    """只读体检：同车多号待删清单 + 票价不全车次，不写任何数据"""
    plan = find_duplicate_trains()
    dup = plan["duplicates"]
    orphan = plan["pure_orphans"]
    remove = sorted(set(dup) | set(orphan))
    incomplete = _collect_incomplete()

    print("=" * 60)
    print("  cleanup 体检报告（只读，不写库）")
    print("=" * 60)
    if remove:
        print(f"\n① 同车多号去重：{plan['group_count']} 组，保留主号 {len(plan['canonical'])} 个")
        print(f"   重复号 {len(dup)} + 纯孤儿 {len(orphan)} = 待删 {len(remove)} 个")
    else:
        print("\n① 同车多号去重：无重复车次 ✅")
    if incomplete:
        print(f"\n② 票价不全车次：{len(incomplete)} 个 -> {', '.join(i['train_num'] for i in incomplete)}")
    else:
        print("\n② 票价完整性：所有车次完整 ✅")
    print(f"\n共发现待处理项：同车去重 {len(remove)} + 票价不全 {len(incomplete)}")
    print("\n一键执行完整清理（去重 → 补算 → 删除仍不全 → 重建物化视图）：")
    print("  python cleanup_incomplete_trains.py")


def _run_full_cleanup():
    """一键全流程：①同车多号去重 ②离线补算非相邻段 ③删除仍不全 ④重建 station_trains"""
    run_dedup(apply=True)

    incomplete = _collect_incomplete()
    if not incomplete:
        print("\n✅ 所有车次数据完整，无需清理。")
        return
    print(f"\n发现 {len(incomplete)} 个票价不全车次，开始离线补算缺失的非相邻段票价...")
    fixed = 0
    for info in incomplete:
        added = compute_missing_pairs(info["train_num"])
        if added:
            fixed += 1
            print(f"  ✓ {info['train_num']}: 补算 {added} 条")
    if fixed:
        print(f"\n共补算 {fixed} 趟车，重新检查...")
        incomplete = _collect_incomplete()
        if not incomplete:
            print("✅ 补算后所有车次完整，无需清理。")
            return
    else:
        print("\n无可离线补算的车次（缺失的均为相邻段，需联网补爬 price_collector --supplement）。")

    print(f"\n自动删除 {len(incomplete)} 个仍不全的车次...")
    deleted = []
    need_rebuild = False
    for info in incomplete:
        result = delete_train_completely(info["train_num"])
        deleted.append(info["train_num"])
        if result["success"]:
            need_rebuild = True
    _rebuild_and_report(deleted, [], need_rebuild)


def _run_interactive():
    """遗留高级模式：逐个展示 + 确认删除（--interactive）"""
    print("=" * 60)
    print("  清理票价数据不全的车次 - 逐个确认（--interactive）")
    print("=" * 60)
    incomplete_trains = _collect_incomplete()
    if not incomplete_trains:
        print("\n✅ 所有车次数据完整，无需清理。")
        return
    print(f"\n发现 {len(incomplete_trains)} 个数据不全的车次。")
    deleted, skipped, need_rebuild = [], [], False
    for info in incomplete_trains:
        print_train_detail(info)
        while True:
            try:
                raw = input(f"\n  删除 {info['train_num']} 的全部数据？(Y/n): ").strip().lower()
            except (EOFError, KeyboardInterrupt):
                print("\n  检测到 Ctrl+C，停止处理，下次可继续。")
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


def main():
    """使用方式：
        python cleanup_incomplete_trains.py            # 一键执行：去重 → 补算 → 删除仍不全 → 重建（无需 --apply）
        python cleanup_incomplete_trains.py --check    # 只读体检（不写库）
    遗留高级选项：--apply（等价默认）/ --fix 仅补算 / --dedup 仅去重报告 / --interactive 逐个确认
    """
    if "--check" in sys.argv:
        _run_report()
        return
    if "--fix" in sys.argv:
        print("=" * 60)
        print("  清理票价数据不全的车次 - 离线补算缺失的非相邻段票价（--fix）")
        print("=" * 60)
        incomplete = _collect_incomplete()
        if not incomplete:
            print("\n✅ 所有车次数据完整，无需清理。")
            return
        fixed = 0
        for info in incomplete:
            added = compute_missing_pairs(info["train_num"])
            if added:
                fixed += 1
                print(f"  ✓ {info['train_num']}: 补算 {added} 条")
        remaining = _collect_incomplete()
        if remaining:
            print(f"\n补算后仍不全 ({len(remaining)}): {', '.join(i['train_num'] for i in remaining)}")
            print("（缺失的均为相邻段，需联网补爬 price_collector --supplement，或加 --apply 自动删除）")
        print(f"\n共补算 {fixed} 趟车。")
        return
    if "--dedup" in sys.argv:
        run_dedup(apply=False)
        return
    if "--interactive" in sys.argv:
        _run_interactive()
        return
    # 默认（无参数）与 --apply 均执行一键全流程
    _run_full_cleanup()


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
