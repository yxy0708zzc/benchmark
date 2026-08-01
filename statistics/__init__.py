"""
统计模块
涵盖 06_评分与统计.md 所有功能：数据汇总、对比分析、报告生成
"""

from .aggregator import aggregate_results
from .comparer import compare_by_model, compare_by_question_type
from .reporter import generate_report, export_markdown

__all__ = ["aggregate_results", "compare_by_model", "compare_by_question_type",
           "generate_report", "export_markdown"]