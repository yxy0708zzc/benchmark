"""
对比分析模块
按模型、题目类型（存在性/选择性）、题型（question_type）等维度对比分析。
对错判定与评分复用 aggregator（基于核查 verdict）。
"""

import os
import json
from typing import Dict, List, Any

from .aggregator import load_all_results, aggregate_results, _compute_score, _verdict


def _load_metadata() -> Dict:
    """读取题目元数据（question/metadata.json），供按 type/题型分组"""
    try:
        from config import METADATA_PATH
        if os.path.exists(METADATA_PATH):
            with open(METADATA_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception:
        pass
    return {}


def _stats(group: List[Dict]) -> Dict:
    """计算一组结果的指标（基于 verdict）"""
    total = len(group)
    pass_c = sum(1 for r in group if _verdict(r) == "pass")
    err_c = sum(1 for r in group if _verdict(r) == "hallucination")
    no_plan_c = sum(1 for r in group if _verdict(r) == "no_plan")
    empty_c = sum(1 for r in group if _verdict(r) == "empty_plan")
    scores = [_compute_score(r) for r in group]
    return {
        "count": total,
        "pass_count": pass_c,
        "pass_rate": round(pass_c / total * 100, 1) if total else 0,
        "error_count": err_c,
        "error_rate": round(err_c / total * 100, 1) if total else 0,
        "no_plan_count": no_plan_c,
        "empty_count": empty_c,
        "avg_score": round(sum(scores) / len(scores), 1) if scores else 0,
    }


def compare_by_model() -> Dict:
    """按模型分组对比（复用 aggregate_results 的 models）"""
    return aggregate_results().get("models", {})


def compare_by_question_type() -> Dict:
    """
    按题目维度分组对比：
    - by_type：按题目 type（存在性 / 选择性）
    - by_question_type：按题型（transfer / short_buy / extra_front / extra_rear / mixed）
    """
    meta = _load_metadata()
    results = load_all_results()

    type_groups: Dict[str, List] = {}
    qtype_groups: Dict[str, List] = {}

    for r in results:
        qid = r.get("question_id", "")
        m = meta.get(qid, {})
        t = m.get("type") or "未知"
        qt = m.get("question_type") or "未知"
        type_groups.setdefault(t, []).append(r)
        qtype_groups.setdefault(qt, []).append(r)

    return {
        "by_type": {t: _stats(g) for t, g in type_groups.items()},
        "by_question_type": {qt: _stats(g) for qt, g in qtype_groups.items()},
    }


def compare_by_interference_density() -> Dict:
    """
    按干扰密度对比（预留接口：需题目生成时记录干扰密度到 metadata）
    当前返回空占位
    """
    return {}


def get_model_ranking() -> List[Dict]:
    """获取模型排名（按平均分降序）"""
    models = compare_by_model()
    ranking = []
    for name, data in models.items():
        ranking.append({
            "model": name,
            "avg_score": data.get("avg_score", 0),
            "completion_rate": data.get("completion_rate", 0),
            "pass_rate": data.get("pass_rate", 0),
            "error_rate": data.get("error_rate", 0),
        })
    ranking.sort(key=lambda x: x["avg_score"], reverse=True)
    return ranking
