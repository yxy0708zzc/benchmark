"""
数据汇总模块（基于核查 verdict 判定对错与评分）
读取 logs/result/ 的测评结果，汇总统计指标。

对错判定：verification.verdict
  - pass            → 正确
  - hallucination   → 错误（任一核查问题）
  - no_plan         → 未规划（无任何可核查购票段）
  - empty_plan      → 空方案（模型未输出 final_plan）
  - db_not_found    → 数据缺失（不计入模型错误）
评分（0~100）：
  - pass = 100
  - hallucination = 100 - 问题扣分（硬错误 -20 / 约束 -10 / 格式缺失 -5，下限 0）
  - no_plan / empty_plan / db_not_found = 0
"""

import os
import json
from typing import Dict, List, Any

from config import LOGS_RESULT_DIR, LOGS_TEST_DIR

# 硬错误（方案不可行 / 编造）：每项 -20
HARD_ISSUES = {
    "hallucination", "price_wrong",
    "route_mismatch", "route_mismatch_train", "route_mismatch_route",
    "route_mismatch_seat", "route_mismatch_ride",
    "route_invalid", "route_discontinuity", "transfer_time_conflict",
    "start_not_covered", "end_not_covered", "no_route",
    "no_transfer_violated", "no_short_buy_violated", "no_extra_violated",
}
# 约束（硬性约束不满足）：每项 -10
CONSTRAINT_ISSUES = {
    "ticket_shortage", "price_missing",
}
# 其余（格式/缺失）：每项 -5


def load_all_results() -> List[Dict]:
    """加载所有测评结果"""
    results = []
    if not os.path.exists(LOGS_RESULT_DIR):
        return results
    for f in sorted(os.listdir(LOGS_RESULT_DIR)):
        if f.endswith(".json"):
            filepath = os.path.join(LOGS_RESULT_DIR, f)
            try:
                with open(filepath, "r", encoding="utf-8") as fh:
                    data = json.load(fh)
                data["_filename"] = f
                results.append(data)
            except (json.JSONDecodeError, IOError) as e:
                print(f"[aggregator] 读取文件失败 {f}: {e}")
    return results


def load_test_record(filename: str) -> Dict:
    """加载单个测试记录"""
    filepath = os.path.join(LOGS_TEST_DIR, filename)
    if not os.path.exists(filepath):
        return {}
    with open(filepath, "r", encoding="utf-8") as f:
        return json.load(f)


def _verdict(r: Dict) -> str:
    """取测评结果的 verdict（缺省视为未知）"""
    return (r.get("verification") or {}).get("verdict", "unknown")


def _compute_score(r: Dict) -> float:
    """基于 verdict + issues 计算 0~100 分"""
    verdict = _verdict(r)
    if verdict == "pass":
        return 100.0
    if verdict in ("no_plan", "empty_plan", "db_not_found", "unknown"):
        # unknown = 旧数据/无 verdict，不按满分计
        return 0.0
    # hallucination：按问题严重度扣分
    v = r.get("verification") or {}
    score = 100.0
    for issue in v.get("issues", []):
        t = issue.get("type", "")
        if t in HARD_ISSUES:
            score -= 20
        elif t in CONSTRAINT_ISSUES:
            score -= 10
        else:
            score -= 5
    return max(0.0, round(score, 1))


def _issue_type_counts(group: List[Dict]) -> Dict[str, int]:
    """统计一组测评结果中各问题类型出现次数"""
    counts: Dict[str, int] = {}
    for r in group:
        for issue in (r.get("verification") or {}).get("issues", []):
            t = issue.get("type", "")
            counts[t] = counts.get(t, 0) + 1
    return counts


def _record_brief(r: Dict, meta_all: Dict, test_data: Dict = None) -> Dict[str, Any]:
    """单条测评结果摘要（模型管理逐题明细表 / 测评管理跳转用）"""
    v = r.get("verification") or {}
    ss = r.get("score_summary") or {}
    qid = r.get("question_id", "") or ""
    m = meta_all.get(qid) or {}
    # 调用计数：优先读测试记录显式字段，旧记录由 trace 推导
    model_calls = tool_calls = None
    if test_data:
        model_calls = test_data.get("model_calls")
        tool_calls = test_data.get("tool_calls")
        if model_calls is None:
            model_calls = _trace_model_calls(test_data)
        if tool_calls is None:
            tool_calls = _trace_tool_calls(test_data)
    return {
        "filename": r.get("_filename", ""),
        "question_id": qid,
        "type": m.get("type", ""),
        "question_type": m.get("question_type", ""),
        "verdict": v.get("verdict", "unknown"),
        "score": _compute_score(r),
        "issue_count": v.get("issue_count", 0),
        "hallucination_count": v.get("hallucination_count", 0),
        "total_tokens": ss.get("total_tokens", 0),
        "duration_seconds": ss.get("duration_seconds", 0),
        "model_calls": model_calls,
        "tool_calls": tool_calls,
        "timestamp": r.get("timestamp", ""),
    }


def _trace_model_calls(test_data: Dict) -> int:
    """从测试记录 trace 统计模型调用次数（每个 assistant 轮 = 一次 LLM API 请求）"""
    return sum(1 for e in (test_data.get("trace") or [])
               if isinstance(e, dict) and e.get("type") == "assistant")


def _trace_tool_calls(test_data: Dict) -> int:
    """从测试记录 trace 统计工具调用次数（工具嵌套在各轮 assistant.tools 下）"""
    n = 0
    for e in (test_data.get("trace") or []):
        if isinstance(e, dict) and e.get("type") == "assistant":
            n += len(e.get("tools") or [])
    return n


def _model_stats(group: List[Dict]) -> Dict[str, Any]:
    """计算一组测评结果的指标"""
    total = len(group)
    success_count = sum(1 for r in group if r.get("status") == "success")
    pass_count = sum(1 for r in group if _verdict(r) == "pass")
    error_count = sum(1 for r in group if _verdict(r) == "hallucination")
    no_plan_count = sum(1 for r in group if _verdict(r) == "no_plan")
    empty_count = sum(1 for r in group if _verdict(r) == "empty_plan")
    db_count = sum(1 for r in group if _verdict(r) == "db_not_found")
    unknown_count = total - pass_count - error_count - no_plan_count - empty_count - db_count

    scores = [_compute_score(r) for r in group]
    avg_score = sum(scores) / len(scores) if scores else 0

    # 从测试记录中获取 token 消耗 / 模型调用 / 工具调用（均由 trace 推导）
    total_tokens = 0
    total_duration = 0
    total_tool_calls = 0
    total_model_calls = 0
    token_count = 0
    for r in group:
        test_file = r.get("test_file", "")
        if test_file:
            test_data = load_test_record(os.path.basename(test_file))
            if test_data:
                tu = test_data.get("token_usage", {})
                total_tokens += tu.get("total_tokens", 0)
                total_duration += test_data.get("duration", 0)
                total_tool_calls += _trace_tool_calls(test_data)
                total_model_calls += _trace_model_calls(test_data)
                token_count += 1

    return {
        "total_tests": total,
        "success_count": success_count,
        "completion_rate": round(success_count / total * 100, 1) if total else 0,
        "pass_count": pass_count,
        "pass_rate": round(pass_count / total * 100, 1) if total else 0,
        "error_count": error_count,
        "error_rate": round(error_count / total * 100, 1) if total else 0,
        "no_plan_count": no_plan_count,
        "no_plan_rate": round(no_plan_count / total * 100, 1) if total else 0,
        "empty_count": empty_count,
        "empty_rate": round(empty_count / total * 100, 1) if total else 0,
        "db_count": db_count,
        "unknown_count": unknown_count,
        "avg_score": round(avg_score, 1),
        "avg_tokens": 0,
        "avg_duration": 0,
        "avg_tool_calls": round(total_tool_calls / token_count, 1) if token_count else 0,
        "avg_model_calls": round(total_model_calls / token_count, 1) if token_count else 0,
        "scores": scores,
    }


def aggregate_results() -> Dict:
    """
    读取所有测评结果，返回汇总统计数据。
    返回：
    - total_tests / models（按模型分组指标）/ summary（全局汇总）/ all_scores
    """
    results = load_all_results()

    if not results:
        return {
            "total_tests": 0,
            "models": {},
            "summary": {
                "avg_score": 0, "completion_rate": 0, "pass_rate": 0,
                "error_rate": 0, "no_plan_rate": 0, "empty_rate": 0,
                "total_tests": 0,
            },
            "all_scores": [],
        }

    # 按模型分组
    model_groups: Dict[str, List[Dict]] = {}
    for r in results:
        model = r.get("model_name", "unknown")
        model_groups.setdefault(model, []).append(r)

    # 题目类型映射（逐题明细展示用；读不到不影响统计）
    try:
        from database import load_metadata
        meta_all = load_metadata() or {}
    except Exception:
        meta_all = {}

    # 各模型指标（含 token/耗时/模型调用/工具调用）
    models_data = {}
    for model_name, group in model_groups.items():
        stats = _model_stats(group)
        # 补 token / 耗时 / 双计数（均由 trace 推导；同时缓存 test_data 供逐题明细复用）
        total_tokens = 0
        total_duration = 0
        total_tool_calls = 0
        total_model_calls = 0
        token_count = 0
        td_map: Dict[str, Dict] = {}
        for r in group:
            test_file = r.get("test_file", "")
            if test_file:
                base = os.path.basename(test_file)
                test_data = td_map.get(base)
                if test_data is None:
                    test_data = load_test_record(base)
                    td_map[base] = test_data or {}
                if test_data:
                    tu = test_data.get("token_usage", {})
                    total_tokens += tu.get("total_tokens", 0)
                    total_duration += test_data.get("duration", 0)
                    total_tool_calls += _trace_tool_calls(test_data)
                    total_model_calls += _trace_model_calls(test_data)
                    token_count += 1
        stats["avg_tokens"] = round(total_tokens / token_count, 1) if token_count else 0
        stats["avg_duration"] = round(total_duration / token_count, 2) if token_count else 0
        stats["avg_tool_calls"] = round(total_tool_calls / token_count, 1) if token_count else 0
        stats["avg_model_calls"] = round(total_model_calls / token_count, 1) if token_count else 0
        stats["issue_type_counts"] = _issue_type_counts(group)
        # 逐题明细（新记录在前）：题号/verdict/得分/问题数/token/耗时/模型调用/工具调用/时间
        stats["records"] = [
            _record_brief(r, meta_all, td_map.get(os.path.basename(r.get("test_file", "") or "")))
            for r in reversed(group)
        ]
        models_data[model_name] = stats

    # 全局汇总
    total = len(results)
    pass_c = sum(1 for r in results if _verdict(r) == "pass")
    err_c = sum(1 for r in results if _verdict(r) == "hallucination")
    noplan_c = sum(1 for r in results if _verdict(r) == "no_plan")
    empty_c = sum(1 for r in results if _verdict(r) == "empty_plan")
    success_c = sum(1 for r in results if r.get("status") == "success")
    all_scores = [_compute_score(r) for r in results]

    return {
        "total_tests": total,
        "models": models_data,
        "summary": {
            "avg_score": round(sum(all_scores) / len(all_scores), 1) if all_scores else 0,
            "completion_rate": round(success_c / total * 100, 1) if total else 0,
            "pass_rate": round(pass_c / total * 100, 1) if total else 0,
            "error_rate": round(err_c / total * 100, 1) if total else 0,
            "no_plan_rate": round(noplan_c / total * 100, 1) if total else 0,
            "empty_rate": round(empty_c / total * 100, 1) if total else 0,
            "total_tests": total,
            "issue_type_counts": _issue_type_counts(results),
        },
        "all_scores": all_scores,
    }
