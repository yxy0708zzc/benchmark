"""
报告生成模块
生成 JSON 和 Markdown 格式的统计报告
"""

import json
import os
from typing import Dict, List, Any
from datetime import datetime

from config import LOGS_REPORT_DIR, ensure_directories
from .aggregator import aggregate_results, load_all_results
from .comparer import get_model_ranking, compare_by_question_type


def generate_report() -> Dict:
    """
    生成完整的统计报告
    包含：模型排名、题型分析、洞察、警告
    """
    ensure_directories()
    results = load_all_results()
    aggregate_data = aggregate_results()

    if not results:
        report = {
            "generated_at": datetime.now().isoformat(),
            "total_tests": 0,
            "models_compared": [],
            "model_ranking": [],
            "by_question_type": {},
            "hallucination_warning": [],
            "insights": ["尚无测评数据，请先完成测试和测评"],
        }
        return report

    # 模型排名
    ranking = get_model_ranking()
    models_compared = [r["model"] for r in ranking]

    # 题型分析
    question_type_data = compare_by_question_type()

    # 错误率警告
    warnings = []
    for r in ranking:
        if r["hallucination_rate"] > 10:
            warnings.append(f"{r['model']} 错误率 {r['hallucination_rate']}%，超过 10% 阈值")

    # 自动洞察
    insights = []
    if ranking:
        best_model = ranking[0]["model"]
        best_score = ranking[0]["avg_score"]
        insights.append(f"{best_model} 在所有模型中表现最好，平均分 {best_score}")

        worst_model = ranking[-1]["model"]
        worst_score = ranking[-1]["avg_score"]
        insights.append(f"{worst_model} 在所有模型中表现最弱，平均分 {worst_score}")

    # 题型洞察
    if question_type_data:
        sorted_types = sorted(question_type_data.items(), key=lambda x: x[1]["avg_score"], reverse=True)
        if sorted_types:
            insights.append(f"题型从易到难排序：{' > '.join([t[0] for t in sorted_types])}")
            easiest = sorted_types[0]
            hardest = sorted_types[-1]
            insights.append(f"所有模型在 {easiest[0]} 题型上表现最好（平均分 {easiest[1]['avg_score']}）")
            insights.append(f"所有模型在 {hardest[0]} 题型上最具挑战（平均分 {hardest[1]['avg_score']}）")

    # 各模型优缺点
    for r in ranking:
        model_data = aggregate_data.get("models", {}).get(r["model"], {})
        if model_data:
            scores = model_data.get("scores", [])
            if scores:
                insights.append(f"{r['model']} 最高分 {max(scores)}，最低分 {min(scores)}")

    report = {
        "generated_at": datetime.now().isoformat(),
        "total_tests": aggregate_data.get("total_tests", 0),
        "models_compared": models_compared,
        "model_ranking": ranking,
        "by_question_type": question_type_data,
        "hallucination_warning": warnings,
        "insights": insights,
    }

    # 保存报告
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    json_path = os.path.join(LOGS_REPORT_DIR, f"summary_{timestamp}.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    return report


def export_markdown() -> str:
    """将报告导出为 Markdown 格式"""
    report = generate_report()

    lines = []
    lines.append("# Benchmark 统计报告\n")
    lines.append(f"**生成时间**: {report['generated_at']}\n")
    lines.append(f"**总测试数**: {report['total_tests']}\n")
    lines.append(f"**参与模型**: {', '.join(report['models_compared'])}\n")

    # 模型排名
    lines.append("## 模型综合排名\n")
    lines.append("| 排名 | 模型 | 平均分 | 完成率 | 错误率 |")
    lines.append("|------|------|--------|--------|--------|")
    for i, r in enumerate(report["model_ranking"], 1):
        lines.append(f"| {i} | {r['model']} | {r['avg_score']} | {r['completion_rate']}% | {r['hallucination_rate']}% |")

    # 题型分析
    lines.append("\n## 题型难度分析\n")
    lines.append("| 题型 | 测试数 | 平均分 | 完成率 |")
    lines.append("|------|--------|--------|--------|")
    for qtype, data in sorted(report["by_question_type"].items(), key=lambda x: x[1]["avg_score"], reverse=True):
        lines.append(f"| {qtype} | {data['count']} | {data['avg_score']} | {data['completion_rate']}% |")

    # 警告
    if report["hallucination_warning"]:
        lines.append("\n## 🚨 警告\n")
        for w in report["hallucination_warning"]:
            lines.append(f"- **{w}**")

    # 洞察
    lines.append("\n## 📊 洞察与结论\n")
    for insight in report["insights"]:
        lines.append(f"- {insight}")

    return "\n".join(lines) + "\n"


# 保存 markdown 报告
def export_markdown_to_file() -> str:
    """导出 Markdown 并保存到文件"""
    ensure_directories()
    md = export_markdown()
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    md_path = os.path.join(LOGS_REPORT_DIR, f"summary_{timestamp}.md")
    with open(md_path, "w", encoding="utf-8") as f:
        f.write(md)
    return md_path