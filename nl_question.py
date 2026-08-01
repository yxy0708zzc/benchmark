"""
题目自然语言化工具（纯命令行）

读取 question/metadata.json 中所有含 question 字段的题目，
调用大模型将僵硬的"出发站到到达站"表述转化为自然、口语化的购票需求，
经人工确认后写回 metadata.json 的 nl_question 字段（原 question 保留）。

用法：
    python nl_question.py                         # 交互式填写 API/模型/URL
    python nl_question.py --api-key sk-xxx        # 直接传 API Key（也可交互改）
    python nl_question.py --model deepseek-chat --base-url https://api.deepseek.com

交互键位：
    [Enter]  接受并保存当前生成
    [x]      重新生成一条
    [n]      跳过此题（不保存）
    [Ctrl+C] 中止整个脚本（已保存的不受影响）
"""

import json
import os
import sys
import argparse
import random

import requests

# ============================================================
# 提示词（可自行修改）
# ============================================================
NL_PROMPT_TEMPLATE = """你是一个想购买高铁票的用户。请根据下面的题目信息，生成一段自然、口语化的购票需求。

题目信息：
- 出发地到目的地：{question}

要求：
1. 用自然口语化中文，像真实用户向购票助手提问
2. 必须保留出发站和到达站
3. 换乘或者任何需求不要指定中间站
4. 避免添加与题目设计矛盾的硬性要求（如换乘题不能说"必须直达"）
5. 每次生成要多样化，不要千篇一律
6. 不泄露车票信息或策略

只输出购票需求本身，不要输出其他解释或前后缀。"""

# 题型中文标签
TYPE_LABELS = {
    "transfer": "换乘",
    "short_buy": "买短补长",
    "extra_front": "额外购买（前）",
    "extra_rear": "额外购买（后）",
    "mixed": "混合",
    "direct": "直达",
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


def build_prompt(entry: dict) -> str:
    """组装发送给大模型的提示词

    只传出发/到达（question），不传题型、分段策略、标准路径或任何车票信息。
    """
    question = entry.get("question", "")
    return NL_PROMPT_TEMPLATE.format(question=question)


def generate_nl(api_key: str, model: str, base_url: str, prompt: str) -> str:
    """调用大模型生成自然语言"""
    url = f"{base_url.rstrip('/')}/chat/completions"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 2,  # 提高多样性
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
    """启动时逐个填写 API/模型/URL"""
    print("=" * 60)
    print("  题目自然语言化工具")
    print("=" * 60)
    print("请填写模型配置（直接回车用默认值）：")

    model = input(f"  模型名称 [{args.model}]: ").strip() or args.model
    base_url = input(f"  API Base URL [{args.base_url}]: ").strip() or args.base_url
    default_key = args.api_key or "（未提供，请输入）"
    api_key = input(f"  API Key [{default_key}]: ").strip()
    if not api_key:
        api_key = args.api_key or ""
    if not api_key:
        print("❌ 未提供 API Key，无法继续")
        sys.exit(1)

    print()
    return {"api_key": api_key, "model": model, "base_url": base_url}


def main():
    parser = argparse.ArgumentParser(description="题目自然语言化工具")
    parser.add_argument("--api-key", type=str, default="", help="API Key")
    parser.add_argument("--model", type=str, default="deepseek-v4-flash", help="模型名称")
    parser.add_argument("--base-url", type=str, default="https://api.deepseek.com", help="API Base URL")
    args = parser.parse_args()

    base_dir = os.path.dirname(os.path.abspath(__file__))
    metadata_path = os.path.join(base_dir, "question", "metadata.json")

    cfg = ask_config(args)
    metadata = load_metadata(metadata_path)

    # 找出含 question 字段的题目
    targets = [(qid, entry) for qid, entry in metadata.items()
               if isinstance(entry, dict) and entry.get("question")]
    if not targets:
        print("❌ 没有找到含 question 字段的题目")
        sys.exit(1)

    print(f"开始逐个处理 {len(targets)} 道有 question 的题目...\n")

    accepted = {}  # qid -> nl_question
    aborted = False

    try:
        for idx, (qid, entry) in enumerate(targets, 1):
            print("-" * 60)
            print(f"[{idx}/{len(targets)}] 题目: {qid}")
            print(f"  题型:     {TYPE_LABELS.get(entry.get('type',''), entry.get('type','未知'))}")
            print(f"  原题面:   {entry.get('question','')}")
            if qid in entry and entry.get("nl_question"):
                print(f"  已有自然语言: {entry['nl_question']}")

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
                    choice = input("  [Enter] 跳过此题 | [r] 重试 | [Ctrl+C] 中止: ")
                    if choice.strip().lower() == "r":
                        continue
                    print("  ⏭ 已跳过此题")
                    break

                print(f"  ✅ {nl}")
                try:
                    choice = input("  [Enter] 保存  |  [x] 重新生成  |  [n] 跳过  |  [Ctrl+C] 中止\n  → ")
                except KeyboardInterrupt:
                    aborted = True
                    raise

                if choice.strip() == "":
                    accepted[qid] = nl
                    print("  ✔ 已保存")
                    break
                elif choice.strip().lower() == "x":
                    print("  重新生成...")
                    continue
                elif choice.strip().lower() == "n":
                    print("  ⏭ 已跳过此题")
                    break
                else:
                    print("  无效输入，请按 Enter / x / n / Ctrl+C")

    except KeyboardInterrupt:
        aborted = True
        print("\n\n⚠️ 检测到 Ctrl+C，中止处理。")

    # 写回 metadata
    if accepted:
        for qid, nl in accepted.items():
            if qid in metadata:
                metadata[qid]["nl_question"] = nl  # 原 question 保留
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
