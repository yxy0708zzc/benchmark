"""
chat_test.py — 被测模型测试单测脚本（cmd 直接用，进程内直连后端 api_test_chat 完整对话循环）

输入是一个【metadata 形态的数据表文件】（与 question/metadata.json 同构，可直接用
nl_test.py --out 产出的表）：
    {
      "1_B20260916_231606_0001": {
        "question": "北京南到上海虹桥",        // 必填（缺 nl_question 时的兜底题面）
        "nl_question": "我们三个人……",         // 可选：优先作为发给模型的题面
        "people_count": 3, "seat_type": "class2",
        "criterion": "...", "constraints": [...],
        "ground_truth": [...], "type": "存在性", // 可选：核查对标用（题已入库则自动从 metadata 读）
        "start_station_id": "...", "end_station_id": "..."
      },
      ...
    }

用法：
    C:/vscode_py/.conda/python.exe chat_test.py 表.json
    C:/vscode_py/.conda/python.exe chat_test.py 表.json --question 1_Bxxx --concurrency 3
    C:/vscode_py/.conda/python.exe chat_test.py 表.json --save --out 结果.json

行为（每题，与批量测试同一套后端函数）：
    reset 会话 → api_test_chat（nl_question 优先，退 question）→ 解析 final_plan
    → 代码核查 verify_final_plan → 终端打印 verdict / 问题清单 / 统计
- --save：额外调 api_test_complete 落盘正式测试记录（logs/test）并写题目 state
- 默认不落盘、不写任何 state（单测不污染正式数据）
- 题目需已出题（question/{qid}.db 存在），否则工具查余票无数据
"""

import sys
import os
import json
import argparse
import asyncio
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)
os.chdir(BASE)

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def load_table(path: str) -> dict:
    with open(path, "r", encoding="utf-8-sig") as f:
        data = json.load(f)
    if not isinstance(data, dict) or not data:
        raise SystemExit("❌ 输入应为 metadata 形态的表：{\"题号\": {\"question\": ..., \"nl_question\": ..., ...}}")
    if isinstance(data.get("question"), str):
        raise SystemExit("❌ 输入是单个题目对象，不是表。请包成 {\"题号\": {...}} 的 metadata 表形态")
    for qid, entry in data.items():
        if not isinstance(entry, dict):
            raise SystemExit(f"❌ 表中题号 {qid} 的值不是对象")
    return {str(q): e for q, e in data.items()}


def test_one(qid: str, entry: dict, args, seq: int, total: int) -> dict:
    """测试表中一题（worker 内执行），返回结果 detail。"""
    import server
    from config import ensure_env_fresh, get_question_db_path
    from database import load_metadata
    from server import ChatRequest, TestResetRequest
    ensure_env_fresh()

    result = {"ok": False, "verdict": "", "issue_count": 0, "plan_status": "",
              "end_reason": "", "total_tokens": 0, "duration": 0.0,
              "filename": "", "issues": [], "error": ""}

    if not os.path.exists(get_question_db_path(qid)):
        result["error"] = f"题目数据库不存在: {qid}（先出题）"
        print(f"[{seq}/{total}] ⚠ {qid}: {result['error']}")
        return result

    # 题面优先级：表中 nl_question > 表中 question > 正式 metadata 合并后的同名字段
    meta = load_metadata().get(qid) or {}
    message = str(entry.get("nl_question") or meta.get("nl_question")
                  or entry.get("question") or meta.get("question") or "").strip()
    if not message:
        result["error"] = "缺 nl_question / question（可先用 nl_test.py 生成）"
        print(f"[{seq}/{total}] ❌ {qid}: {result['error']}")
        return result

    session_id = f"cmdtest_{datetime.now().strftime('%H%M%S_%f')}_{qid[:12]}"
    print(f"[{seq}/{total}] ▶ {qid} 测试开始（题面 {len(message)} 字）")

    try:
        server.set_current_question(qid)
        server.api_test_reset(TestResetRequest(session_id=session_id))
        chat_r = asyncio.run(server.api_test_chat(ChatRequest(
            message=message,
            model_name=str(args.model or ""),
            api_key=str(args.api_key or ""),
            api_base_url=str(args.base_url or ""),
            question_id=qid,
            session_id=session_id,
            max_iterations=args.max_iterations,
        )))
        if chat_r.get("error"):
            raise RuntimeError(str(chat_r["error"]))

        reply = chat_r.get("reply", "")
        tu = chat_r.get("token_usage") or {}
        result["total_tokens"] = tu.get("total_tokens", 0)
        result["duration"] = round(chat_r.get("duration", 0), 1)
        result["end_reason"] = server.chat_session_meta.get(session_id, {}).get("end_reason", "completed")

        final_plan = server._parse_ai_final_plan(reply) or []
        if final_plan is None or len(final_plan) == 0:
            result["plan_status"] = "no_plan" if final_plan is None else "empty_plan"
        else:
            result["plan_status"] = "has_solution"

        if args.save:
            from server import TestCompleteRequest
            complete_r = server.api_test_complete(TestCompleteRequest(session_id=session_id))
            if complete_r.get("success"):
                result["filename"] = complete_r.get("filename", "")

        # 代码核查（verdict 从正式 metadata 合并视图读 ground_truth 等对标字段）
        import verifier
        if final_plan:
            v = verifier.verify_final_plan(final_plan, qid)
            result["verdict"] = v.get("verdict", "unknown")
            result["issue_count"] = v.get("issue_count", 0)
            result["issues"] = [{"type": i.get("type"), "detail": i.get("detail", "")}
                                for i in (v.get("issues") or [])]
        else:
            result["verdict"] = result["plan_status"]

        result["ok"] = True
        mark = "✅" if result["verdict"] == "pass" else "❌"
        print(f"[{seq}/{total}] {mark} {qid} → {result['verdict']}"
              f"（{result['plan_status']}，问题 {result['issue_count']}，token {result['total_tokens']}，"
              f"{result['duration']}s，结束 {result['end_reason']}）")
        for iss in result["issues"][:8]:
            print(f"      ✗ [{iss.get('type')}] {iss.get('detail', '')}")
        if result["filename"]:
            print(f"      已落盘: {result['filename']}")
        return result
    except Exception as e:
        result["error"] = str(e)
        print(f"[{seq}/{total}] ❌ {qid} 测试失败: {e}")
        return result
    finally:
        try:
            server.api_test_reset(TestResetRequest(session_id=session_id))
        except Exception:
            pass


def main():
    p = argparse.ArgumentParser(description="被测模型测试单测（输入 metadata 表，直连后端对话循环）")
    p.add_argument("input", help="输入 JSON 表文件路径（metadata 形态：{题号: {字段...}}）")
    p.add_argument("--question", action="append", default=[], help="只测指定题号（可多次）")
    p.add_argument("--max-iterations", type=int, default=30, help="每题最大对话轮数（默认 30）")
    p.add_argument("--concurrency", type=int, default=1, help="并发数 1~8（默认 1）")
    p.add_argument("--save", action="store_true", help="落盘正式测试记录到 logs/test（并写题目 state）")
    p.add_argument("--out", default="", help="结果保存路径（JSON：{题号: 结果明细}）")
    p.add_argument("--api-key", default="", help="API Key（缺省读 .env TEST_API_KEY）")
    p.add_argument("--model", default="", help="模型名（缺省读 .env TEST_MODEL → DEFAULT_MODEL）")
    p.add_argument("--base-url", default="", help="API Base URL（缺省读 .env）")
    args = p.parse_args()
    args.concurrency = max(1, min(args.concurrency, 8))
    args.max_iterations = max(1, min(args.max_iterations, 100))

    if not os.path.isfile(args.input):
        raise SystemExit(f"❌ 输入文件不存在: {args.input}")
    table = load_table(args.input)
    if args.question:
        missing = [q for q in args.question if q not in table]
        if missing:
            raise SystemExit(f"❌ --question 指定的题号不在表中: {missing}")
        table = {q: table[q] for q in args.question}

    from config import ensure_env_fresh
    ensure_env_fresh()
    from config import ENV
    test_model = (args.model or ENV.get("TEST_MODEL") or ENV.get("DEFAULT_MODEL") or "").strip()
    print(f"模型: {test_model}    最大轮数: {args.max_iterations}    并发: {args.concurrency}"
          f"    落盘: {'是' if args.save else '否'}    题数: {len(table)}")
    print("=" * 62)

    t0 = datetime.now()
    results: dict = {}
    if args.concurrency == 1:
        for i, (qid, entry) in enumerate(table.items(), 1):
            results[qid] = test_one(qid, entry, args, i, len(table))
    else:
        with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
            futs = {pool.submit(test_one, qid, entry, args, i, len(table)): qid
                    for i, (qid, entry) in enumerate(table.items(), 1)}
            for fut in as_completed(futs):
                results[futs[fut]] = fut.result()

    # ===== 汇总 =====
    ok_list = [r for r in results.values() if r.get("ok")]
    pass_n = sum(1 for r in ok_list if r.get("verdict") == "pass")
    err_n = len(results) - len(ok_list)
    print("\n" + "=" * 62)
    print(f"  汇总：共 {len(results)} 题 ｜ 通过 {pass_n} ｜ 未通过 {len(ok_list) - pass_n} ｜ 测试失败 {err_n}"
          f" ｜ 耗时 {(datetime.now() - t0).total_seconds():.0f}s")
    issue_counts: dict = {}
    for r in ok_list:
        for iss in r.get("issues") or []:
            issue_counts[iss.get("type", "?")] = issue_counts.get(iss.get("type", "?"), 0) + 1
    if issue_counts:
        print("  问题类型: " + "  ".join(f"{k}×{v}" for k, v in
                                         sorted(issue_counts.items(), key=lambda x: -x[1])))
    for qid, r in results.items():
        if not r.get("ok"):
            print(f"  ✗ {qid}: {r.get('error')}")

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False, indent=2)
        print(f"  结果已保存: {args.out}")


if __name__ == "__main__":
    main()
