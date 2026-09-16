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
        if r["error_rate"] > 10:
            warnings.append(f"{r['model']} 错误率 {r['error_rate']}%，超过 10% 阈值")

    # 自动洞察
    insights = []
    if ranking:
        best_model = ranking[0]["model"]
        insights.append(f"{best_model} 在所有模型中通过率最高（{ranking[0]['pass_rate']}%）")

        worst_model = ranking[-1]["model"]
        insights.append(f"{worst_model} 在所有模型中通过率最低（{ranking[-1]['pass_rate']}%）")

    # 题型洞察（按题型）
    qtype_data = question_type_data.get("by_question_type", {})
    if qtype_data:
        sorted_types = sorted(qtype_data.items(), key=lambda x: x[1]["pass_rate"], reverse=True)
        if sorted_types:
            insights.append(f"题型从易到难排序：{' > '.join([t[0] for t in sorted_types])}")
            easiest = sorted_types[0]
            hardest = sorted_types[-1]
            insights.append(f"所有模型在 {easiest[0]} 题型上表现最好（通过率 {easiest[1]['pass_rate']}%）")
            insights.append(f"所有模型在 {hardest[0]} 题型上最具挑战（通过率 {hardest[1]['pass_rate']}%）")

    # 题目类型洞察（存在性 / 选择性）
    type_data = question_type_data.get("by_type", {})
    if type_data:
        sorted_types = sorted(type_data.items(), key=lambda x: x[1]["pass_rate"], reverse=True)
        if sorted_types:
            insights.append(f"题目类型从易到难排序：{' > '.join([t[0] for t in sorted_types])}")

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

    # 只保留最近 50 份（export 每调用一次落一份，原实现目录无限增长）
    try:
        olds = sorted(f for f in os.listdir(LOGS_REPORT_DIR)
                      if f.startswith("summary_") and f.endswith(".json"))
        for name in olds[:-50]:
            os.remove(os.path.join(LOGS_REPORT_DIR, name))
    except OSError:
        pass

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
    lines.append("| 排名 | 模型 | 完成率 | 通过率 | 错误率 |")
    lines.append("|------|------|--------|--------|--------|")
    for i, r in enumerate(report["model_ranking"], 1):
        lines.append(f"| {i} | {r['model']} | {r['completion_rate']}% | {r['pass_rate']}% | {r['error_rate']}% |")

    # 题型分析
    qtype_data = report["by_question_type"].get("by_question_type", {})
    lines.append("\n## 题型难度分析\n")
    lines.append("| 题型 | 测试数 | 通过率 | 错误率 |")
    lines.append("|------|--------|--------|--------|")
    for qtype, data in sorted(qtype_data.items(), key=lambda x: x[1]["pass_rate"], reverse=True):
        lines.append(f"| {qtype} | {data['count']} | {data['pass_rate']}% | {data['error_rate']}% |")

    # 题目类型分析（存在性 / 选择性）
    type_data = report["by_question_type"].get("by_type", {})
    lines.append("\n## 题目类型分析\n")
    lines.append("| 类型 | 测试数 | 通过率 | 错误率 |")
    lines.append("|------|--------|--------|--------|")
    for t, data in sorted(type_data.items(), key=lambda x: x[1]["pass_rate"], reverse=True):
        lines.append(f"| {t} | {data['count']} | {data['pass_rate']}% | {data['error_rate']}% |")

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