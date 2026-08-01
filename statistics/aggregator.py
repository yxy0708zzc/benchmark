"""
数据汇总模块
读取 logs/result/ 和 logs/test/ 中的所有 JSON 文件，汇总计算各项指标
"""

import os
import json
from typing import Dict, List, Any
from datetime import datetime

from config import LOGS_RESULT_DIR, LOGS_TEST_DIR


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


def aggregate_results() -> Dict:
    """
    读取所有测评结果，返回汇总统计数据
    返回包含以下字段：
    - total_tests: 总测试数
    - models: 按模型分组的统计
    - total_scores: 总分统计
    """
    results = load_all_results()

    if not results:
        return {
            "total_tests": 0,
            "models": {},
            "summary": {
                "avg_score": 0,
                "completion_rate": 0,
                "hallucination_rate": 0,
                "total_tests": 0,
            }
        }

    # === 按模型分组 ===
    model_groups: Dict[str, List[Dict]] = {}
    for r in results:
        model = r.get("model_name", "unknown")
        if model not in model_groups:
            model_groups[model] = []
        model_groups[model].append(r)

    # === 各模型指标计算 ===
    models_data = {}
    for model_name, group in model_groups.items():
        total = len(group)
        success_count = sum(1 for r in group if r.get("status") == "success")
        # 所有错误（包括票价错误）都算作 hallucination
        fraud_count = sum(1 for r in group if r.get("verification", {}).get("hallucination_count", 0) > 0)
        # 兼容旧数据（is_fraud 字段）
        if fraud_count == 0:
            fraud_count = sum(1 for r in group if r.get("verification", {}).get("is_fraud", False))
        completion_rate = (success_count / total * 100) if total > 0 else 0
        error_rate = (fraud_count / success_count * 100) if success_count > 0 else 0

        # 计算限制实现率
        scores = []
        for r in group:
            ss = r.get("score_summary", {})
            normalized = ss.get("normalized", 0)
            scores.append(normalized)
        avg_score = sum(scores) / len(scores) if scores else 0

        # 从测试记录中获取 token 消耗和工具调用次数
        total_tokens = 0
        total_duration = 0
        total_tool_calls = 0
        token_count = 0
        for r in group:
            test_file = r.get("test_file", "")
            if test_file:
                test_data = load_test_record(os.path.basename(test_file))
                if test_data:
                    tu = test_data.get("token_usage", {})
                    total_tokens += tu.get("total_tokens", 0)
                    total_duration += test_data.get("duration", 0)
                    total_tool_calls += len(test_data.get("tool_calls", []))
                    token_count += 1

        avg_tokens = total_tokens / token_count if token_count > 0 else 0
        avg_duration = total_duration / token_count if token_count > 0 else 0
        avg_tool_calls = total_tool_calls / token_count if token_count > 0 else 0

        models_data[model_name] = {
            "total_tests": total,
            "success_count": success_count,
            "completion_rate": round(completion_rate, 1),
            "error_rate": round(error_rate, 1),
            "hallucination_rate": round(error_rate, 1),  # 兼容旧前端
            "avg_score": round(avg_score, 1),
            "avg_tokens": round(avg_tokens, 1),
            "avg_duration": round(avg_duration, 2),
            "avg_tool_calls": round(avg_tool_calls, 1),
            "fraud_count": fraud_count,
            "scores": scores,
        }

    # === 全局汇总 ===
    all_scores = []
    all_success = 0
    all_fraud = 0
    for r in results:
        ss = r.get("score_summary", {})
        all_scores.append(ss.get("normalized", 0))
        if r.get("status") == "success":
            all_success += 1
        if r.get("verification", {}).get("hallucination_count", 0) > 0:
            all_fraud += 1
    # 兼容旧数据
    if all_fraud == 0:
        all_fraud = sum(1 for r in results if r.get("verification", {}).get("is_fraud", False))

    total_tests = len(results)
    avg_all_score = sum(all_scores) / len(all_scores) if all_scores else 0
    completion_rate_all = (all_success / total_tests * 100) if total_tests > 0 else 0
    error_rate_all = (all_fraud / all_success * 100) if all_success > 0 else 0

    return {
        "total_tests": total_tests,
        "models": models_data,
        "summary": {
            "avg_score": round(avg_all_score, 1),
            "completion_rate": round(completion_rate_all, 1),
            "hallucination_rate": round(error_rate_all, 1),
            "total_tests": total_tests,
        },
        "all_scores": all_scores,
    }