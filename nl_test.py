"""
nl_test.py — 自然语言化单测脚本（cmd 直接用，进程内直连后端同一套函数）

输入是一个【metadata 形态的数据表文件】（与 question/metadata.json 同构）：
    {
      "1_B20260916_231606_0001": {
        "question": "北京南到上海虹桥",
        "people_count": 3,
        "seat_type": "class2",
        "criterion": "fastest",           // 可选：comprehensive/fastest/cheapest/depart_latest/arrive_earliest
        "constraints": ["no_transfer"]    // 可选：no_transfer / no_short_buy_extra
      },
      "2_B20260916_231606_0003": { ... }
    }

用法：
    C:/vscode_py/.conda/python.exe nl_test.py 表.json
    C:/vscode_py/.conda/python.exe nl_test.py 表.json --out 带nl的表.json
    C:/vscode_py/.conda/python.exe nl_test.py 表.json --force
    C:/vscode_py/.conda/python.exe nl_test.py 表.json --question 1_Bxxx --question 2_Bxxx

行为：
- 对表中每题生成自然语言并打印；条目已有 nl_question 时跳过（--force 强制重生成）
- --out 把结果回写为同构表（原条目 + nl_question 字段），可直接再喂给 chat_test.py
- 不写 metadata.json / metadata_nl.json（单测不污染正式数据）
- 题号已存在于正式 metadata 时自动补全缺失字段（type/question_type 等，与后端同逻辑）
- API 配置回落 .env：NL_API_KEY / NL_MODEL / NL_BASE_URL（→ DEFAULT_*）
"""

import sys
import os
import json
import argparse

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)
os.chdir(BASE)

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def load_table(path: str) -> dict:
    """读入 metadata 形态的表：{qid: entry_dict}。其他形态明确报错。"""
    with open(path, "r", encoding="utf-8-sig") as f:
        data = json.load(f)
    if not isinstance(data, dict) or not data:
        raise SystemExit("❌ 输入应为 metadata 形态的表：{\"题号\": {\"question\": ..., \"people_count\": ..., ...}}")
    if isinstance(data.get("question"), str):
        raise SystemExit("❌ 输入是单个题目对象，不是表。请包成 {\"题号\": {...}} 的 metadata 表形态")
    table = {}
    for qid, entry in data.items():
        if not isinstance(entry, dict):
            raise SystemExit(f"❌ 表中题号 {qid} 的值不是对象")
        table[str(qid)] = entry
    return table


def main():
    p = argparse.ArgumentParser(description="自然语言化单测（输入 metadata 表，直连后端）")
    p.add_argument("input", help="输入 JSON 表文件路径（metadata 形态：{题号: {字段...}}）")
    p.add_argument("--out", default="", help="结果表保存路径（可选；同构表，条目附加 nl_question）")
    p.add_argument("--question", action="append", default=[], help="只处理指定题号（可多次）")
    p.add_argument("--api-key", default="", help="API Key（缺省读 .env NL_API_KEY）")
    p.add_argument("--model", default="", help="模型名（缺省读 .env NL_MODEL → DEFAULT_MODEL）")
    p.add_argument("--base-url", default="", help="API Base URL（缺省读 .env）")
    p.add_argument("--force", action="store_true", help="条目已有 nl_question 时也重新生成")
    args = p.parse_args()

    if not os.path.isfile(args.input):
        raise SystemExit(f"❌ 输入文件不存在: {args.input}")

    from config import ensure_env_fresh
    ensure_env_fresh()
    from nl_question import ask_config, build_prompt, generate_nl
    from database import load_metadata

    cfg = ask_config(args)  # 缺配置时交互补全（与 nl_question.py 同一逻辑）

    table = load_table(args.input)
    if args.question:
        missing = [q for q in args.question if q not in table]
        if missing:
            raise SystemExit(f"❌ --question 指定的题号不在表中: {missing}")
        table = {q: table[q] for q in args.question}

    # 题号已存在于正式 metadata：补全缺失字段（type/question_type/criterion 等，与后端批量同逻辑）
    metadata = load_metadata()
    for qid, entry in table.items():
        meta = metadata.get(qid)
        if isinstance(meta, dict):
            for k, v in meta.items():
                entry.setdefault(k, v)

    out_table: dict = {}
    ok = skip = fail = 0
    for i, (qid, entry) in enumerate(table.items(), 1):
        out_table[qid] = dict(entry)
        if entry.get("nl_question") and not args.force:
            skip += 1
            print(f"\n[{i}/{len(table)}] {qid} 已有 nl_question，跳过（--force 可强制）\n    {entry['nl_question']}")
            continue
        if not entry.get("question"):
            fail += 1
            print(f"\n[{i}/{len(table)}] {qid} 缺 question 字段，跳过")
            continue
        prompt = build_prompt(entry)
        print(f"\n[{i}/{len(table)}] {qid} 生成中（模型 {cfg['model']}）...")
        print(f"  输入: {entry.get('question', '')} ｜ {entry.get('people_count', 2)} 人"
              f" ｜ {entry.get('seat_type', 'class2')}"
              f" ｜ {entry.get('criterion') or '-'} ｜ {','.join(entry.get('constraints') or []) or '-'}")
        try:
            nl = generate_nl(cfg["api_key"], cfg["model"], cfg["base_url"], prompt)
        except Exception as e:
            fail += 1
            print(f"  ❌ 生成失败: {e}")
            continue
        ok += 1
        out_table[qid]["nl_question"] = nl
        print(f"  ✅ 生成结果:\n  ─────────────\n  {nl}\n  ─────────────")

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(out_table, f, ensure_ascii=False, indent=2)
        print(f"\n结果表已保存: {args.out}（可直接作为 chat_test.py 的输入）")
    print(f"\n完成：成功 {ok} / 跳过 {skip} / 失败 {fail}（共 {len(table)} 题；不写 metadata，仅"
          f"{'保存到 --out' if args.out else '展示'}）")


if __name__ == "__main__":
    main()
