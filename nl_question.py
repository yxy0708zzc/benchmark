"""
题目自然语言化工具（纯命令行）

读取 question/metadata.json 中所有含 question 字段的题目，
调用大模型将僵硬的"出发站到到达站"表述转化为自然、口语化的购票需求，
经人工确认后写回 metadata.json 的 nl_question 字段（原 question 保留）。

一致性：存在性题（0_/1_）按「基础题号 + 内容」（行程/人数/座位/评判标准/行为约束）分组，
一组生成一份自然语言并写回组内全部题目 —— 保证 0_/1_ 除干扰外完全一致；
不同题号（如 0_34 与 0_35）即使内容相同也不合并，各自独立生成。
选择性题额外携带评判标准（criterion：综合考虑/最快/最便宜/出发最晚/最早到达）
与行为约束（constraints：不允许换乘 / 不允许买短补长与额外购买），
仅作为题目对模型的优化/行为要求，经自然语言传达给模型。

用法：
    python nl_question.py                         # 交互式填写 API/模型/URL（默认跳过已保存的）
    python nl_question.py --api-key sk-xxx        # 直接传 API Key（也可交互改）
    python nl_question.py --model deepseek-chat --base-url https://api.deepseek.com
    python nl_question.py --force                 # 强制重新生成已保存 nl_question 的题目
    python nl_question.py --question a1 --question a2   # 只处理指定题目（可多次指定，即使已有也处理）

交互键位：
    [Enter]  接受并保存当前生成
    [x]      重新生成一条
    [n]      跳过此题（不保存）
    [Ctrl+C] 中止整个脚本（已保存的不受影响）

详见 docs/scripts.md（系统小脚本总览，含本脚本参数、流程、无用代码说明）。
"""

import json
import os
import sys
import argparse
import re

import requests

# ============================================================
# 提示词（可自行修改）
# ============================================================
NL_PROMPT_TEMPLATE = """你是一个想购买高铁票的真实用户。请根据下面的题目约束，生成一段自然、口语化的购票需求。

题目约束：
- 行程：{question}
- 人数：{people_count} 人
- 期望座位等级：{seat_label}{criterion_block}{constraint_block}

【生成要求】
1. 你可以以任何口气说，包括但不限于：尊敬、无奈、请求、无礼
2. 必须隐含"人数"和"座位等级"这两个约束，但不要用"买X张""买X等座""二等座"这种硬性指令式表达
3. 表达人数和座位等级要自然、口语化地带出
4. 座位等级：
  - class2:二等座,经济型,价格较低,不太舒适
  - class1:一等座,更舒适,价格中等
  - class0:特等座,可躺,十分舒适,价格更高
5. 必须保留出发站和到达站
6. 回答只能输出一个回答,不可输出多条
7. 不要自称"用户"或提及"题目/约束"，直接说出需求本身
8. 约束的语序要随机，可以任意布置约束的要求，口语词也可以有
9. 要求要适当隐讳
10. 不要涉及“座位挨着”。不必先从人数开始，座位等级等暗示也可以先提到。
11. 如果有评判标准（综合考虑/最快/最便宜/出发最晚/最早到达）,要用购票者口吻自然带出（如"综合考虑看看""越快越好""我要快点到""尽量晚点出发""尽量早点到"），不要用"约束:评判标准X"这种硬性指令；没有该标准就不要提。
12. 如果有行为约束（不允许换乘、不允许买短补长与额外购买）,要用购票者口吻自然带出（如"别整换乘那套"“我不会换乘”等），不要用"约束:不许X"这种硬性指令；没有该约束就不要提。

[实例]:
1. 我们五个从北京南到上海虹桥，想找个比普通座舒服些、价钱又别太吓人的座儿，不会换乘，实惠点就行，帮忙看看？
2. 爸妈一起从成都东去西安北，我们年纪大了路上想躺一躺，看看有没有能躺的座位
"""
# 座位等级中文标签
SEAT_LABELS = {
    "class2": "二等座",
    "class1": "一等座",
    "class0": "特等座",
}

# 评判标准中文标签（仅选择性题 metadata.criterion，单选）
CRITERION_LABELS = {
    "comprehensive": "综合考虑",
    "fastest": "最快",
    "cheapest": "最便宜",
    "depart_latest": "出发最晚",
    "arrive_earliest": "最早到达",
}

# 行为约束中文标签（仅选择性题 metadata.constraints 可能含）
CONSTRAINT_LABELS = {
    "no_transfer": "不允许换乘",
    "no_short_buy_extra": "不允许买短补长与额外购买",
}

# 题型中文标签
TYPE_LABELS = {
    "transfer": "换乘",
    "short_buy": "买短补长",
    "extra_front": "额外购买（前）",
    "extra_rear": "额外购买（后）",
    "mixed": "混合",
    # direct 仅作 mixed 段内策略，非独立题型，无需标签
}


def load_metadata(metadata_path: str) -> dict:
    if not os.path.exists(metadata_path):
        print(f"❌ metadata 不存在: {metadata_path}")
        sys.exit(1)
    with open(metadata_path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_metadata(metadata_path: str, metadata: dict):
    with open(metadata_path, "w", encoding="utf-8") as f:
        json.dump(metadata, f, ensure_ascii=False, indent=2)


def build_criterion_text(entry: dict) -> str:
    """从题目元数据读取评判标准（仅选择性题存有 criterion，单选），拼成一行文本；无则空串。

    评判标准值：comprehensive 综合考虑 / fastest 最快 / cheapest 最便宜 /
    depart_latest 出发最晚 / arrive_earliest 最早到达。
    """
    lab = CRITERION_LABELS.get(entry.get("criterion"))
    return lab or ""


def build_constraint_text(entry: dict) -> str:
    """从题目元数据读取行为约束（仅选择性题存有 constraints），拼成一行约束文本；无则空串。"""
    labels = []
    for c in entry.get("constraints") or []:
        lab = CONSTRAINT_LABELS.get(c)
        if lab:
            labels.append(lab)
    return "、".join(labels)


def build_prompt(entry: dict) -> str:
    """组装发送给大模型的提示词。

    传参：行程 question、人数 people_count、座位等级 seat_label，以及（仅选择性题，
    存在这些字段才传）评判标准 criterion_block（综合考虑/最快/最便宜/出发最晚/最早到达）与
    行为约束 constraint_block（不允许换乘 / 不允许买短补长与额外购买）。
    不传题型、分段策略、标准路径或任何车票信息。
    """
    question = entry.get("question", "")
    people_count = entry.get("people_count", 2)
    seat_type = entry.get("seat_type", "class2")
    seat_label = SEAT_LABELS.get(seat_type, seat_type)
    cr = build_criterion_text(entry)
    criterion_block = f"\n- 评判标准：{cr}" if cr else ""
    cc = build_constraint_text(entry)
    constraint_block = f"\n- 行为约束：{cc}" if cc else ""
    return NL_PROMPT_TEMPLATE.format(
        question=question,
        people_count=people_count,
        seat_label=seat_label,
        criterion_block=criterion_block,
        constraint_block=constraint_block,
    )


def generate_nl(api_key: str, model: str, base_url: str, prompt: str) -> str:
    """调用大模型生成自然语言（温度读 config.NL_TEMPERATURE，在 config.py 中修改）"""
    from config import NL_TEMPERATURE
    url = f"{base_url.rstrip('/')}/chat/completions"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": NL_TEMPERATURE,  # 提高多样性（注意各平台范围限制，如 MiMo [0, 1.5]）
    }
    resp = requests.post(url, json=payload, headers=headers, timeout=60)
    if resp.status_code != 200:
        raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:200]}")
    data = resp.json()
    if "error" in data:
        raise RuntimeError(data["error"].get("message", "API 调用失败"))
    content = data["choices"][0]["message"]["content"].strip()
    if not content:
        raise RuntimeError("模型返回为空")
    return content


def ask_config(args) -> dict:
    """确定模型配置：优先级 命令行参数 > .env（NL_API_KEY / NL_MODEL → DEFAULT_MODEL / NL_BASE_URL → DEFAULT_BASE_URL）。

    模型名与接口地址不内置任何平台默认（不一定调用 deepseek）：任一缺失时交互补全或报错退出。
    """
    from config import ENV
    model = (args.model or "").strip() or ENV.get("NL_MODEL", "") or ENV.get("DEFAULT_MODEL", "") or ""
    base_url = (args.base_url or "").strip() or ENV.get("NL_BASE_URL", "") or ENV.get("DEFAULT_BASE_URL", "") or ""
    api_key = (args.api_key or "").strip() or ENV.get("NL_API_KEY", "") or ""

    if not api_key or not model or not base_url:
        print("=" * 60)
        print("  题目自然语言化工具")
        print("=" * 60)
        print("模型配置不完整（也可在 .env 填 NL_API_KEY / NL_MODEL / DEFAULT_BASE_URL 免输入）：")
        if not model:
            model = input("  模型名称: ").strip()
        if not base_url:
            base_url = input("  API Base URL: ").strip()
        if not api_key:
            api_key = input("  API Key: ").strip()
        missing = [n for n, v in
                   [("模型名称", model), ("API Base URL", base_url), ("API Key", api_key)] if not v]
        if missing:
            print(f"❌ 缺少配置：{'、'.join(missing)}（系统不默认指向任何平台）")
            sys.exit(1)

    return {"api_key": api_key, "model": model, "base_url": base_url}


def _existence_base(qid: str) -> str:
    """取存在性题的基础题号（去掉 0_/1_ 前缀）：0_34 / 1_34 → 34。

    用于分组时只让同一道题的 0_/1_ 配对共享文案，不同题号即使内容相同也不合并。
    """
    return re.sub(r"^[0-9]_", "", str(qid))


def _group_existence(raw_targets):
    """把存在性题按「基础题号 + 内容」分组：提示词输入相同的题目（行程 / 人数 / 座位 / 评判标准 / 行为约束）
    共用同一份自然语言 —— 保证 0_ / 1_ 除干扰外完全一致；
    不同题号（如 0_34 与 0_35）即使内容相同也不合并，各自独立生成。
    非存在性题（选择性等）各自独立成组。

    返回 [{qids: [...], entries: [...]}, ...]（保持 metadata 首次出现顺序）。
    """
    groups = []
    by_key = {}
    for qid, entry in raw_targets:
        if entry.get("type") == "存在性":
            key = (
                _existence_base(qid),                    # 只让 0_/1_ 配对共享
                entry.get("question", ""),
                entry.get("people_count", 2),
                entry.get("seat_type", "class2"),
                build_criterion_text(entry),
                build_constraint_text(entry),
            )
            if key not in by_key:
                by_key[key] = {"qids": [], "entries": []}
                groups.append(by_key[key])
            by_key[key]["qids"].append(qid)
            by_key[key]["entries"].append(entry)
        else:
            groups.append({"qids": [qid], "entries": [entry]})
    return groups


def main():
    parser = argparse.ArgumentParser(description="题目自然语言化工具")
    parser.add_argument("--api-key", type=str, default="", help="API Key（未填时读 .env 的 NL_API_KEY）")
    parser.add_argument("--model", type=str, default="", help="模型名称（未填时读 .env 的 NL_MODEL，再回落 DEFAULT_MODEL）")
    parser.add_argument("--base-url", type=str, default="", help="API Base URL（未填时读 .env 的 DEFAULT_BASE_URL）")
    parser.add_argument("--force", action="store_true", help="强制重新生成已保存 nl_question 的题目")
    parser.add_argument("--question", action="append", default=[],
                        help="仅处理指定题目ID（可多次指定；指定题即使已有 nl_question 也会处理；存在性配对组会整组处理）")
    args = parser.parse_args()

    base_dir = os.path.dirname(os.path.abspath(__file__))
    metadata_path = os.path.join(base_dir, "question", "metadata.json")

    cfg = ask_config(args)
    metadata = load_metadata(metadata_path)

    # 找出含 question 字段的题目
    raw_targets = [(qid, entry) for qid, entry in metadata.items()
                   if isinstance(entry, dict) and entry.get("question")]
    if not raw_targets:
        print("❌ 没有找到含 question 字段的题目")
        sys.exit(1)

    # 存在性按内容分组（0_/1_ 共用一份自然语言），其余每题一组
    groups = _group_existence(raw_targets)

    # 目标筛选（按组）：指定题 → 整组处理；--force → 全部；默认 → 组内任一无 nl_question 则整组处理
    if args.question:
        qset = set(args.question)
        missing = [q for q in qset if q not in metadata]
        if missing:
            print(f"❌ 指定题目不存在于 metadata: {', '.join(missing)}")
            sys.exit(1)
        target_groups = [g for g in groups if qset & set(g["qids"])]
        skipped_count = 0
    elif args.force:
        target_groups = groups
        skipped_count = 0
    else:
        target_groups = [g for g in groups if any(not e.get("nl_question") for e in g["entries"])]
        skipped_count = len(groups) - len(target_groups)

    if skipped_count:
        print(f"⏭ 跳过 {skipped_count} 组已有自然语言（用 --force 可强制重新生成）")
    if not target_groups:
        print("✅ 所有题目都已有自然语言，无需生成")
        sys.exit(0)

    total_q = sum(len(g["qids"]) for g in target_groups)
    print(f"开始逐个处理 {len(target_groups)} 组 / {total_q} 道题...\n")

    accepted = {}  # qid -> nl_question（组内所有 qid 写同一份）
    aborted = False

    try:
        for idx, group in enumerate(target_groups, 1):
            qids = group["qids"]
            entry = group["entries"][0]  # 组内提示词输入相同，取第一个构造

            print("-" * 60)
            print(f"[{idx}/{len(target_groups)}] 组: {', '.join(qids)}")
            print(f"  题型:   {TYPE_LABELS.get(entry.get('question_type',''), entry.get('question_type','未知'))}")
            _seat = entry.get('seat_type', 'class2')
            _cr = build_criterion_text(entry)
            _cc = build_constraint_text(entry)
            _line = f"  {entry.get('question','')} ｜ {entry.get('people_count', 2)} 人 ｜ {SEAT_LABELS.get(_seat, _seat)}"
            if _cr:
                _line += f" ｜ 评判标准：{_cr}"
            if _cc:
                _line += f" ｜ 约束：{_cc}"
            print(_line)
            if len(qids) > 1:
                print(f"  ⚠ 存在性配对：生成一份写回 {len(qids)} 题")
            _existing = next((e.get("nl_question") for e in group["entries"] if e.get("nl_question")), None)
            if _existing:
                print(f"  已有自然语言: {_existing}")

            prompt = build_prompt(entry)

            # 生成 + 交互循环
            while True:
                print("  生成中...")
                try:
                    nl = generate_nl(cfg["api_key"], cfg["model"], cfg["base_url"], prompt)
                except KeyboardInterrupt:
                    aborted = True
                    raise
                except Exception as e:
                    print(f"  ❌ 生成失败: {e}")
                    choice = input("  [Enter] 跳过此组 | [r] 重试 | [Ctrl+C] 中止: ")
                    if choice.strip().lower() == "r":
                        continue
                    print("  ⏭ 已跳过此组")
                    break

                print(f"  ✅ {nl}")
                try:
                    choice = input("  [Enter] 保存  |  [x] 重新生成  |  [n] 跳过  |  [Ctrl+C] 中止\n  → ")
                except KeyboardInterrupt:
                    aborted = True
                    raise

                if choice.strip() == "":
                    for qid in qids:
                        accepted[qid] = nl
                    print(f"  ✔ 已保存到 {len(qids)} 题")
                    break
                elif choice.strip().lower() == "x":
                    print("  重新生成...")
                    continue
                elif choice.strip().lower() == "n":
                    print("  ⏭ 已跳过此组")
                    break
                else:
                    print("  无效输入，请按 Enter / x / n / Ctrl+C")

    except KeyboardInterrupt:
        aborted = True
        print("\n\n⚠️ 检测到 Ctrl+C，中止处理。")

    # 写回 metadata（原 question 保留）
    if accepted:
        for qid, nl in accepted.items():
            if qid in metadata:
                metadata[qid]["nl_question"] = nl
        save_metadata(metadata_path, metadata)
        print(f"\n✅ 已保存 {len(accepted)} 条自然语言到 question/metadata.json")
    else:
        print("\nℹ️ 没有保存任何条目（metadata 未改动）")

    # 汇总
    print("=" * 60)
    print("  结果汇总")
    print("=" * 60)
    if accepted:
        print(f"  已保存: {len(accepted)} 题  →  {', '.join(sorted(accepted))}")
    if aborted:
        print(f"  已中止（Ctrl+C）：未保存的题目不受影响")
    print("=" * 60)


if __name__ == "__main__":
    main()
