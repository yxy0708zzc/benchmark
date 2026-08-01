"""
对比分析模块
按模型、题型、干扰密度等维度进行对比分析
"""

from typing import Dict, List, Any
from .aggregator import load_all_results, aggregate_results


def compare_by_model() -> Dict:
    """
    按模型分组对比
    返回 {model_name: {completion_rate, hallucination_rate, avg_score, avg_tokens, ...}}
    """
    data = aggregate_results()
    data = aggregate_results()
    return data.get("models", {})


def compare_by_question_type() -> Dict:
    """
    按题型分组对比
    从题目元数据推断题型（根据 question_id 前缀）
    返回 {question_type: {avg_score, completion_rate, hallucination_rate, count}}
    """
    results = load_all_results()
    type_groups: Dict[str, List] = {
        "direct": [],
        "transfer": [],
        "short_buy": [],
        "same_train": [],
        "mixed": [],
        "unknown": [],
    }

    for r in results:
        qid = r.get("question_id", "")
        # 通过题目 ID 推测题型（auto出题器会在题目信息中包含题型）
        # 也可以从测试记录中读取题型，这里简化处理
        if qid.startswith("q_auto_"):
            # 从 metadata 中获取题型
            from config import METADATA_PATH
            if os.path.exists(METADATA_PATH):
                import json
                with open(METADATA_PATH, "r") as f:
                    meta = json.load(f)
                qmeta = meta.get(qid, {})
                # 暂无法从 meta 直接获取题型，后续可以扩展
                type_groups["unknown"].append(r)
            else:
                type_groups["unknown"].append(r)
        else:
            type_groups["unknown"].append(r)

    # 计算各题型指标
    result = {}
    for qtype, group in type_groups.items():
        if not group:
            continue
        total = len(group)
        success_count = sum(1 for r in group if r.get("status") == "success")
        scores = []
        for r in group:
            ss = r.get("score_summary", {})
            scores.append(ss.get("normalized", 0))

        avg_score = sum(scores) / len(scores) if scores else 0
        completion_rate = (success_count / total * 100) if total > 0 else 0

        result[qtype] = {
            "count": total,
            "avg_score": round(avg_score, 1),
            "completion_rate": round(completion_rate, 1),
            "success_count": success_count,
        }

    return result


def compare_by_interference_density() -> Dict:
    """
    按干扰密度对比（TODO：需要题目生成时记录干扰密度）
    当前返回空占位
    """
    # 需要题目生成时在 metadata 中记录 interference_density
    # 当前测评结果中暂无该字段，预留接口
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
            "hallucination_rate": data.get("hallucination_rate", 0),
        })
    ranking.sort(key=lambda x: x["avg_score"], reverse=True)
    return ranking
