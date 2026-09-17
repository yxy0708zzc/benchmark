"""
auto.py — 一行命令全流程自动处理（出题 → 自然语言 → 测试 → 测评）

独立进程运行，不需要启动 server.py（进程内 import server 复用全部批量逻辑）；
运行前请关闭正在运行的 server.py（跨进程无法共享批量互斥锁）。

用法（全部参数必填，模型名自动读取 .env 的 TEST_MODEL，无需填写）：
    python auto.py -d 1.xlsx -s 2.xlsx --seat-class0 20 --seat-class1 30 --seat-class2 50 ^
        --interference-density 0.02 --random-tickets-density 0.02 --max-retries 40 ^
        --nl-concurrency 5 --max-iterations 30 --test-concurrency 3

前提：
    1) data/railway.db 与 data/prices.db 已采集（collector.py / price_collector.py）
    2) .env 已配置 NL_API_KEY / NL_MODEL / DEFAULT_BASE_URL / TEST_MODEL / TEST_API_KEY
"""

import argparse
import json
import os
import sys
import threading
import time
from datetime import datetime

# 控制台中文/符号输出（Windows cmd 默认 GBK，emoji 等字符降级替换防崩溃）
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE_DIR)

import server  # noqa: E402  （进程内复用全部批量逻辑；不会启动 Web 服务）
from config import ENV, ensure_env_fresh  # noqa: E402

POLL_INTERVAL = 2.0  # 进度轮询间隔（秒）


# ============================================================
# 参数
# ============================================================
def parse_args():
    p = argparse.ArgumentParser(
        description="高铁购票 Benchmark 全流程自动处理：批量出题 → 自然语言 → 测试 → 测评"
                    "（模型名自动读取 .env TEST_MODEL，无需填写；运行前请关闭 server.py）",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("-d", "--distribution", required=True, help="1.xlsx 题目分布表路径")
    p.add_argument("-s", "--stations", required=True, help="2.xlsx 到发站对表路径")
    p.add_argument("--seat-class0", required=True, type=float, help="特等座比例 %%（三项之和必须=100）")
    p.add_argument("--seat-class1", required=True, type=float, help="一等座比例 %%")
    p.add_argument("--seat-class2", required=True, type=float, help="二等座比例 %%")
    p.add_argument("--interference-density", required=True, type=float,
                   help="干扰密度（存在性 1_，票数严格<人数），如 0.02 = 2%%")
    p.add_argument("--random-tickets-density", required=True, type=float,
                   help="随机票密度（选择性 2_，0.5~1.5×人数），如 0.02 = 2%%")
    p.add_argument("--max-retries", required=True, type=int, help="每题出题重试上限")
    p.add_argument("--nl-concurrency", required=True, type=int, help="自然语言化并发数（1~20）")
    p.add_argument("--max-iterations", required=True, type=int, help="测试最大对话轮数（1~100，每轮=一次模型调用）")
    p.add_argument("--test-concurrency", required=True, type=int, help="测试并发数（1~8）")
    return p.parse_args()


def validate_args(a) -> list:
    """校验参数合法性，返回错误清单（空=通过）。"""
    errs = []
    seat_total = a.seat_class0 + a.seat_class1 + a.seat_class2
    if abs(seat_total - 100) > 0.001:
        errs.append(f"座位比例之和必须为 100，当前 {seat_total:g}（特 {a.seat_class0:g} / 一 {a.seat_class1:g} / 二 {a.seat_class2:g}）")
    if min(a.seat_class0, a.seat_class1, a.seat_class2) < 0:
        errs.append("座位比例不能为负数")
    for name, d in [("interference-density", a.interference_density),
                    ("random-tickets-density", a.random_tickets_density)]:
        if not (0 < d <= 0.05):
            errs.append(f"--{name} 须在 (0, 0.05] 区间，当前 {d}")
    if a.max_retries < 1:
        errs.append("--max-retries 至少为 1")
    if not (1 <= a.nl_concurrency <= 20):
        errs.append("--nl-concurrency 须在 1~20")
    if not (1 <= a.max_iterations <= 100):
        errs.append("--max-iterations 须在 1~100")
    if not (1 <= a.test_concurrency <= 8):
        errs.append("--test-concurrency 须在 1~8")
    for label, path in [("--distribution", a.distribution), ("--stations", a.stations)]:
        if not os.path.isfile(path):
            errs.append(f"{label} 文件不存在: {path}")
    return errs


# ============================================================
# 环境预检
# ============================================================
def check_server_not_running() -> tuple:
    """探测 127.0.0.1:8000 是否为本平台 server.py 在运行（HTTP 探测 /api/env/model）。

    返回 (是否在运行, 描述)。占用 8000 的其他程序不会误判；
    本平台 server 在跑则拒绝（跨进程无法共享批量互斥锁，避免同时批量写坏 metadata）。
    """
    import urllib.request
    try:
        with urllib.request.urlopen("http://127.0.0.1:8000/api/env/model", timeout=1.5) as resp:
            body = resp.read(200).decode("utf-8", "replace")
        if resp.status == 200 and "test_model" in body:
            return True, "127.0.0.1:8000 正在运行本平台 server.py"
        return False, ""
    except Exception:
        return False, ""


def preflight(a) -> tuple:
    """环境预检，返回 (错误清单, 警告清单, 测试模型名)。"""
    errs, warns = [], []
    from config import RAILWAY_DB_PATH, PRICES_DB_PATH
    if not os.path.exists(RAILWAY_DB_PATH):
        errs.append(f"基础数据库不存在: {RAILWAY_DB_PATH}（请先运行 collector.py）")
    if not os.path.exists(PRICES_DB_PATH):
        errs.append(f"票价数据库不存在: {PRICES_DB_PATH}（请先运行 price_collector.py）")
    if check_server_not_running()[0]:
        errs.append("检测到 127.0.0.1:8000 正在运行本平台 server.py。请先关闭它再运行 auto.py"
                    "（两边是独立进程，无法共享批量互斥锁）")
    ensure_env_fresh()
    test_model = (ENV.get("TEST_MODEL") or ENV.get("DEFAULT_MODEL") or "").strip()
    if not test_model:
        errs.append(".env 未配置 TEST_MODEL / DEFAULT_MODEL（测试模型名）")
    if not (ENV.get("TEST_API_KEY") or "").strip():
        errs.append(".env 未配置 TEST_API_KEY")
    if not (ENV.get("NL_API_KEY") or "").strip():
        warns.append(".env 未配置 NL_API_KEY —— 自然语言化节点将整批跳过，后续测试将因缺 nl_question 全部不可测")
    return errs, warns, test_model


# ============================================================
# 进度轮询（worker 在后台线程，主线程每 2s 打印一行）
# ============================================================
NODE_TIMEOUT_SECONDS = 7200  # 单节点轮询总超时（秒）：防 worker 异常死亡后 done 永不置位导致死循环


def wait_worker(get_state, label: str, timeout_s: float = NODE_TIMEOUT_SECONDS):
    """轮询批量 state 直到 done=True；返回 result。超过 timeout_s 抛 RuntimeError。"""
    last_len = 0
    start = time.time()
    while True:
        s = get_state() or {}
        total = s.get("total") or 0
        done = s.get("done_count") or 0
        pct = f"{done / total * 100:.0f}%" if total else "-"
        cur = (s.get("current") or "").replace("\n", " ")[:46]
        line = f"    [{label}] {done}/{total} ({pct}) {cur}"
        sys.stdout.write("\r" + line.ljust(max(last_len, len(line))))
        sys.stdout.flush()
        last_len = len(line)
        if s.get("done"):
            print(f"    [{label}] 完成，耗时 {time.time() - start:.0f}s")
            return s.get("result")
        if time.time() - start > timeout_s:
            raise RuntimeError(f"{label} 节点轮询超时（{int(timeout_s)}s 未见 done），"
                               f"可能 worker 异常终止，请查看 logs/batch_tools.log")
        time.sleep(POLL_INTERVAL)


def start_worker(target, args):
    t = threading.Thread(target=target, args=args, daemon=True)
    t.start()
    return t


# ============================================================
# 四个节点
# ============================================================
def run_generate(a, distribution, selective, stations) -> list:
    """节点1：批量出题。返回成功题号列表（空则调用方终止）。"""
    payload = {
        "distribution": distribution,
        "selective": selective,
        "stations": stations,
        "seat_weights": {"class0": a.seat_class0, "class1": a.seat_class1, "class2": a.seat_class2},
        "interference_density": a.interference_density,
        "random_tickets_density": a.random_tickets_density,
        "max_retries": a.max_retries,
        "nl_enabled": False,  # 自然语言由节点2统一并发执行
    }
    print("\n▶ 节点 1/4 批量出题")
    if not server._pipeline_acquire("batch_generate"):
        raise RuntimeError("批量互斥获取失败（有其他批量任务在跑？）")
    server._batch_log_clear("batch_generate")
    server._batch_state.update({"running": True, "done": False, "current": "准备中...",
                                "total": 0, "done_count": 0, "result": None})
    start_worker(server._run_batch, (payload,))
    result = wait_worker(lambda: server._batch_state, "出题")
    details = (result or {}).get("details") or []
    ok = [d for d in details if d.get("ok")]
    failed = [d for d in details if not d.get("ok")]
    print(f"  ✔ 出题成功 {len(ok)} / 失败 {len(failed)}")
    for d in failed[:10]:
        print(f"    ✗ {d.get('question_id')} {d.get('row', '')}：{d.get('error', '')}")
    if len(failed) > 10:
        print(f"    ... 其余 {len(failed) - 10} 条失败见 logs/batch_tools.log")
    return [d["question_id"] for d in ok]


def run_nl(a, qids: list) -> dict:
    """节点2：批量自然语言化。"""
    print(f"\n▶ 节点 2/4 批量自然语言化（{len(qids)} 题，并发 {a.nl_concurrency}）")
    if not qids:
        print("  ⚠ 无成功题目，跳过")
        return {}
    if not server._pipeline_acquire("batch_nl"):
        raise RuntimeError("批量互斥获取失败")
    server._batch_log_clear("batch_nl")
    server._nl_state.update({"running": True, "done": False, "current": "准备中...",
                             "total": len(qids), "done_count": 0, "result": None, "stop": False})
    # 经 _safe_batch_worker 兜底：worker 未捕获异常也保证 done 落位（否则这里死循环）
    start_worker(server._safe_batch_worker,
                 ("batch_nl", server._run_batch_nl, list(qids), max(1, min(a.nl_concurrency, 20))))
    result = wait_worker(lambda: server._nl_state, "自然语言") or {}
    s = result.get("summary") or {}
    print(f"  ✔ NL 成功 {s.get('generated', 0)} / 失败 {s.get('failed', 0)} / 跳过 {s.get('skipped', 0)}")
    if result.get("error"):
        print(f"  ⚠ {result['error']}")
    return s


def run_test(a, test_model: str, qids: list) -> list:
    """节点3：批量测试。返回成功测试记录文件名列表。"""
    print(f"\n▶ 节点 3/4 批量测试（模型 {test_model}，最多 {len(qids)} 题，"
          f"对话轮数 {a.max_iterations}，并发 {a.test_concurrency}）")
    if not qids:
        print("  ⚠ 无题目可测，跳过")
        return []
    if not server._pipeline_acquire("batch_test"):
        raise RuntimeError("批量互斥获取失败")
    server._batch_log_clear("batch_test")
    server._test_state.update({"running": True, "done": False, "current": "准备中...",
                               "total": len(qids), "done_count": 0, "result": None})
    max_iter = max(1, min(int(a.max_iterations), 100))
    conc = max(1, min(int(a.test_concurrency), 8))
    start_worker(server._safe_batch_worker,
                 ("batch_test", server._run_batch_test, test_model, list(qids), max_iter, conc))
    result = wait_worker(lambda: server._test_state, "测试") or {}
    details = result.get("details") or []
    ok = [d for d in details if d.get("ok")]
    skipped = [d for d in details if not d.get("ok")]
    print(f"  ✔ 测试成功 {len(ok)} / 失败或跳过 {len(skipped)}")
    for d in skipped[:10]:
        print(f"    ✗ {d.get('question_id')}：{d.get('error', '')}")
    return [d["filename"] for d in ok if d.get("filename")]


def run_eval(filenames: list) -> dict:
    """节点4：批量测评。返回 summary（含 verdict 分布）。"""
    print(f"\n▶ 节点 4/4 批量测评（{len(filenames)} 条测试记录）")
    if not filenames:
        print("  ⚠ 无测试记录可测评，跳过")
        return {}
    if not server._pipeline_acquire("batch_eval"):
        raise RuntimeError("批量互斥获取失败")
    server._batch_log_clear("batch_eval")
    server._eval_state.update({"running": True, "done": False, "current": "准备中...",
                               "total": len(filenames), "done_count": 0, "result": None})
    start_worker(server._safe_batch_worker, ("batch_eval", server._run_batch_eval, list(filenames)))
    result = wait_worker(lambda: server._eval_state, "测评") or {}
    s = dict(result.get("summary") or {})
    print(f"  ✔ 测评完成 {s.get('success', 0)} / 失败 {s.get('failed', 0)}，verdict 分布 {s.get('verdicts', {})}")
    # 节点4 单表：0_/1_/2_ 三列 × 问题码行（终端打印 + 附到 summary 供 write_report 落盘）
    eval_table = build_eval_table(result.get("details") or [])
    print("\n  ── 节点4 测评结果（占比 = 次数 ÷ 该组题数）──")
    for line in format_eval_table(eval_table).splitlines():
        print("  " + line)
    if eval_table["other_total"]:
        print(f"  ⚠ 另有非 0_/1_/2_ 前缀记录 {eval_table['other_total']} 条"
              f"（其中测评失败 {eval_table['other_error']} 条），未计入上表")
    s["eval_table"] = eval_table
    return s


# ============================================================
# 节点4 结果单表（0_/1_/2_ 三列 × 问题码行，终端与 auto_report 同一张表）
# ============================================================
EVAL_GROUPS = [
    ("0_", "0_（存在性·无干扰）"),
    ("1_", "1_（存在性·干扰）"),
    ("2_", "2_（选择性·随机票）"),
]

# 问题码 → 中文名（行顺序即表行顺序，固定全行输出；verifier 新增码会动态追加在末尾）
EVAL_ISSUE_ROWS = [
    ("hallucination", "余票不符（幻觉）"),
    ("invalid_plan_item", "方案条目无效"),
    ("invalid_seat", "无效座位类型"),
    ("missing_ride", "缺实际乘坐区间"),
    ("ticket_shortage", "购票数不足人数"),
    ("price_wrong", "票价不符"),
    ("route_mismatch_train", "车次与标答不符"),
    ("route_mismatch_route", "购买区间与标答不符"),
    ("route_mismatch_seat", "座位与标答不符"),
    ("route_mismatch_ride", "乘坐区间与标答不符"),
    ("route_mismatch", "整体方案与标答不符"),
    ("route_discontinuity", "乘坐区段断裂"),
    ("transfer_time_conflict", "换乘时间冲突"),
    ("start_not_covered", "未连接出发站"),
    ("end_not_covered", "未连接到达站"),
    ("route_invalid", "区段无效"),
    ("no_route", "无法拼接完整全程"),
    ("no_transfer_violated", "违反「不允许换乘」"),
    ("no_short_buy_violated", "违反「不允许买短补长」"),
    ("no_extra_violated", "违反「不允许额外购买」"),
]


def _disp_len(s: str) -> int:
    """显示宽度（全角字符按 2 计），用于终端对齐"""
    import unicodedata
    return sum(2 if unicodedata.east_asian_width(ch) in ("F", "W") else 1 for ch in s)


def build_eval_table(details: list) -> dict:
    """从批量测评 details 聚合单表：三列（0_/1_/2_）× 行（题数/通过/verdict/各问题码）。"""
    groups = [g for g, _ in EVAL_GROUPS]
    cols = {g: {"total": 0, "pass": 0, "no_plan": 0, "empty_plan": 0,
                "db_not_found": 0, "error": 0, "issues": {}} for g in groups}
    other_total = 0
    other_error = 0
    for d in (details or []):
        g = d.get("group") if d.get("group") in cols else None
        if g is None:
            other_total += 1
            if not d.get("ok"):
                other_error += 1
            continue
        col = cols[g]
        col["total"] += 1
        if not d.get("ok"):
            col["error"] += 1
            continue
        v = d.get("verdict", "unknown")
        if v == "pass":
            col["pass"] += 1
        elif v in ("no_plan", "empty_plan", "db_not_found"):
            col[v] += 1
        for code, n in (d.get("issue_types") or {}).items():
            col["issues"][code] = col["issues"].get(code, 0) + int(n or 0)
    return {"cols": cols, "groups": groups,
            "other_total": other_total, "other_error": other_error}


def format_eval_table(eval_table: dict, md: bool = False) -> str:
    """渲染单表。md=True 输出 markdown 表格；False 输出终端对齐文本。
    占比口径：每格 = 次数（次数 ÷ 该列题数），同题多错可超 100%；「通过」行即通过率。"""
    cols = eval_table["cols"]
    groups = eval_table["groups"]
    headers = [label for _, label in EVAL_GROUPS]

    def cell(col: dict, n: int) -> str:
        if col["total"]:
            sep = "（" if md else "("
            return f"{n}{sep}{n / col['total'] * 100:.1f}%）" if md else f"{n}({n / col['total'] * 100:.1f}%)"
        return str(n)

    rows = []  # (行名, {group: 文本})
    rows.append(("题数", {g: str(cols[g]["total"]) for g in groups}))
    rows.append(("✅ 通过", {g: cell(cols[g], cols[g]["pass"]) for g in groups}))
    for v, cn in (("no_plan", "未规划 no_plan"), ("empty_plan", "空方案 empty_plan"),
                  ("db_not_found", "数据缺失 db_not_found")):
        rows.append((cn, {g: cell(cols[g], cols[g][v]) for g in groups}))
    for code, cn in EVAL_ISSUE_ROWS:
        rows.append((f"{cn} {code}", {g: cell(cols[g], cols[g]["issues"].get(code, 0)) for g in groups}))
    # verifier 新增码防漏统计
    known = {c for c, _ in EVAL_ISSUE_ROWS}
    extra = set()
    for g in groups:
        extra.update(cols[g]["issues"].keys())
    for code in sorted(extra - known):
        rows.append((f"其他问题 {code}", {g: cell(cols[g], cols[g]["issues"].get(code, 0)) for g in groups}))
    rows.append(("合计问题", {g: str(sum(cols[g]["issues"].values())) for g in groups}))
    rows.append(("测评失败", {g: str(cols[g]["error"]) for g in groups}))

    if md:
        out = ["| 问题类型 | " + " | ".join(headers) + " |",
               "|---|" + "---|" * len(groups)]
        for label, cells in rows:
            out.append("| " + label + " | " + " | ".join(cells[g] for g in groups) + " |")
        return "\n".join(out)

    # 终端对齐（全角按 2 宽）
    lw = max(_disp_len(label) for label, _ in rows) + 2
    lines = []
    for label, cells in rows:
        parts = [f"{g}:{cells[g]}" for g in groups]
        lines.append(label + " " * max(1, lw - _disp_len(label)) + "  ".join(parts))
    return "\n".join(lines)


# ============================================================
# 二次核查表 & 汇总
# ============================================================
def print_plan(a, distribution, selective, stations, test_model, env_errs, env_warns):
    exists_total = sum((r.get("has_interference") or 0) + (r.get("no_interference") or 0) for r in distribution)
    sel_total = sum(r.get("count") or 0 for r in selective)
    print("\n" + "=" * 62)
    print("  auto.py 全流程计划（二次核查）")
    print("=" * 62)
    print(f"  分布表   : {a.distribution}")
    print(f"  站对表   : {a.stations}（{len(stations)} 对，方向随机可倒置）")
    if distribution:
        print(f"  存在性   : {exists_total} 题"
              f"（干扰 {sum(r.get('has_interference') or 0 for r in distribution)}"
              f" + 无干扰 {sum(r.get('no_interference') or 0 for r in distribution)}）")
        for r in distribution:
            print(f"             · [{r.get('category', '')}] {r.get('name', '')}"
                  f"：干扰 {r.get('has_interference', 0)} + 无干扰 {r.get('no_interference', 0)}")
    if selective:
        print(f"  选择性   : {sel_total} 题")
        for r in selective:
            crit = server._CRITERION_CN.get(r.get("criterion", ""), r.get("criterion", ""))
            beh = server._BEHAVIOR_CN.get(r.get("behavior", ""), r.get("behavior", ""))
            print(f"             · {crit} × {beh}：{r.get('count', 0)} 题")
    print(f"  座位比例 : 特 {a.seat_class0:g}% / 一 {a.seat_class1:g}% / 二 {a.seat_class2:g}%")
    print(f"  密度     : 干扰 {a.interference_density:.1%} / 随机票 {a.random_tickets_density:.1%}   重试上限 {a.max_retries}")
    print(f"  NL       : 并发 {a.nl_concurrency}")
    print(f"  测试     : 模型(.env) {test_model}   对话轮数 {a.max_iterations}   并发 {a.test_concurrency}")
    print(f"  流程     : 出题 {exists_total + sel_total} 题 → NL → 测试 → 测评")
    for w in env_warns:
        print(f"  ⚠ {w}")
    for e in env_errs:
        print(f"  ✗ {e}")
    print("=" * 62)


def collect_state_stats() -> dict:
    """遍历 metadata 统计各阶段题目数。"""
    metadata = server.load_metadata()
    stats = {"total": 0, "has_nl": 0, "tested": 0, "evaluated": 0}
    for m in metadata.values():
        if not isinstance(m, dict):
            continue
        stats["total"] += 1
        if m.get("nl_question"):
            stats["has_nl"] += 1
        states = [s for s in (m.get("state") or []) if isinstance(s, str) and ":" in s]
        if states:
            stats["tested"] += 1
        if any(s.endswith(":evaluated") for s in states):
            stats["evaluated"] += 1
    return stats


def write_report(path, a, args_line, gen_s, nl_s, test_s, eval_s, test_model):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(f"# auto.py 全流程报告\n\n- 时间：{datetime.now().isoformat()}\n- 命令：`{args_line}`\n\n")
        f.write(f"## 节点1 批量出题\n成功 {gen_s.get('success', 0)} / 失败 {gen_s.get('failed', 0)}（共 {gen_s.get('total', 0)}）\n\n")
        f.write(f"## 节点2 自然语言化\n成功 {nl_s.get('generated', 0)} / 失败 {nl_s.get('failed', 0)} / 跳过 {nl_s.get('skipped', 0)}\n\n")
        f.write(f"## 节点3 批量测试（模型 {test_model}）\n成功 {test_s.get('success', 0)} / 失败或跳过 {test_s.get('failed', 0)}\n\n")
        eval_table = (eval_s or {}).get("eval_table")
        f.write("## 节点4 批量测评\n")
        f.write(f"成功 {eval_s.get('success', 0)} / 失败 {eval_s.get('failed', 0)}（共 {eval_s.get('total', 0)}）\n\n")
        if eval_table:
            f.write("占比口径：每格 = 次数（次数 ÷ 该组题数），同题多错可超 100%；「通过」行即通过率\n\n")
            f.write(format_eval_table(eval_table, md=True))
            f.write("\n")
            if eval_table.get("other_total"):
                f.write(f"\n> ⚠ 另有非 0_/1_/2_ 前缀记录 {eval_table['other_total']} 条（其中测评失败 {eval_table['other_error']} 条），未计入上表\n")
        else:
            f.write(f"verdict 分布：`{json.dumps((eval_s or {}).get('verdicts', {}), ensure_ascii=False)}`\n")
    return path


# ============================================================
# 主流程
# ============================================================
def main():
    a = parse_args()
    errs = validate_args(a)
    if errs:
        print("参数错误：")
        for e in errs:
            print(f"  ✗ {e}")
        sys.exit(1)

    # 解析 xlsx（与网页批量出题同一解析器）
    with open(a.distribution, "rb") as f:
        parsed = server._parse_distribution_xlsx(f.read())
    distribution, selective = parsed.get("exists") or [], parsed.get("selective") or []
    with open(a.stations, "rb") as f:
        stations = server._parse_stations_xlsx(f.read())
    if not stations:
        print("✗ 站对表为空（2.xlsx 每行两列：出发站, 到达站）")
        sys.exit(1)

    env_errs, env_warns, test_model = preflight(a)

    # 预检硬失败（数据库缺失 / server 在跑 / 测试模型缺失）
    hard = [e for e in env_errs]
    if hard:
        print("环境预检未通过：")
        for e in hard:
            print(f"  ✗ {e}")
        sys.exit(1)

    print_plan(a, distribution, selective, stations, test_model, env_errs, env_warns)
    try:
        ans = input("确认执行全流程？(y/n): ").strip().lower()
    except (EOFError, KeyboardInterrupt):
        ans = "n"
    if ans != "y":
        print("已取消。")
        sys.exit(0)

    gen_result, nl_result, test_result, eval_result = {}, {}, {}, {}
    test_model_used = test_model
    interrupted = False
    try:
        qids = run_generate(a, distribution, selective, stations)
        gen_result = server._batch_state.get("result", {}).get("summary", {}) if qids else {}
        if not qids:
            print("\n✗ 出题零成功，流程终止。")
            sys.exit(2)

        nl_result = run_nl(a, qids) or {}

        filenames = run_test(a, test_model_used, qids)
        test_result = server._test_state.get("result", {}).get("summary", {}) or {}

        eval_result = run_eval(filenames) or {}
    except KeyboardInterrupt:
        interrupted = True
        print("\n\n⚠ 检测到 Ctrl+C，中止流程。已启动的节点可能仍在后台收尾（daemon 线程随进程退出）。")
    except RuntimeError as e:
        print(f"\n✗ {e}")
        sys.exit(3)
    finally:
        for job in ("batch_generate", "batch_nl", "batch_test", "batch_eval"):
            server._pipeline_release(job)

    if interrupted:
        # 后台 worker 可能仍在写 metadata，此时不再读它做汇总（避免读到写一半的状态），
        # 直接退出让 daemon 线程随进程结束；metadata 本身已原子落盘，不会损坏。
        sys.exit(130)

    # ---- 汇总 ----
    stats = collect_state_stats()
    print("\n" + "=" * 62)
    print("  全流程汇总")
    print("=" * 62)
    print(f"  出题     : 成功 {gen_result.get('success', 0)} / 失败 {gen_result.get('failed', 0)}")
    print(f"  自然语言 : 成功 {nl_result.get('generated', 0)} / 失败 {nl_result.get('failed', 0)} / 跳过 {nl_result.get('skipped', 0)}")
    print(f"  测试     : 成功 {test_result.get('success', 0)} / 失败或跳过 {test_result.get('failed', 0)}"
          f"（模型 {test_result.get('model', test_model_used)}）")
    print(f"  测评     : verdict 分布 {eval_result.get('verdicts', {})}")
    print(f"  题目总览 : 共 {stats['total']} 题（有 NL {stats['has_nl']} / 已测 {stats['tested']} / 已测评 {stats['evaluated']}）")
    print(f"  产物     : question/*.db、logs/test/、logs/result/、logs/auto/")
    print(f"  详细日志 : logs/batch_tools.log")
    print("=" * 62)

    args_line = " ".join(sys.argv)
    report_path = os.path.join(BASE_DIR, "logs", "auto", f"auto_report_{datetime.now().strftime('%Y%m%d_%H%M%S')}.md")
    try:
        write_report(report_path, a, args_line, gen_result, nl_result, test_result, eval_result, test_model_used)
        print(f"  报告     : {report_path}")
    except OSError as e:
        print(f"  （报告写入失败: {e}）")


if __name__ == "__main__":
    main()

# python auto.py ^
# -d 1 - 副本.xlsx ^
# -s 2.xlsx ^
# --seat-class0 20 ^
# --seat-class1 30 ^
# --seat-class2 50 ^
# --interference-density 0.02 ^
# --random-tickets-density 0.02 ^
# --max-retries 40 ^
# --nl-concurrency 2 ^
# --max-iterations 30 ^
# --test-concurrency 3