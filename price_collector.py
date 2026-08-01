"""
票价爬虫 —— 通过 12306 queryAllPublicPrice 接口爬取所有车次相邻站对票价

策略（依据用户建议）：
- 对每趟车，获取其经停站顺序
- 对每个相邻站对，调用 price API 获取各席别票价
- 存储到 prices 表
- 支持断点续爬（跳过已爬取的车次）

调用示例：
    python price_collector.py              # 全量爬取，全程完后自动计算非相邻段
    python price_collector.py --resume      # 断点续爬（跳过已完成的）
    python price_collector.py --supplement  # 补充缺失站对，补完后自动计算非相邻段
    python price_collector.py --train G1    # 仅爬指定车次
    # 任意模式按 Ctrl+C 优雅中止，再按一次强制退出
"""

import re
import os
import json
import time
import signal
import random
import logging
import sys
import argparse
import threading
from datetime import datetime, timedelta
from typing import Optional, Dict, List, Tuple
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

# 全局终止标志
_shutdown_requested = False

def _handle_sigint(sig, frame):
    global _shutdown_requested
    if _shutdown_requested:
        print("\n⚠️  强制退出")
        sys.exit(1)
    _shutdown_requested = True
    print("\n⏳ 正在优雅退出（再按一次 Ctrl+C 强制退出）...")

signal.signal(signal.SIGINT, _handle_sigint)

from config import (
    CRAWLER_CONFIG, get_query_date,
    ensure_directories, RAILWAY_DB_PATH, LOGS_DIR
)
from database import (
    init_prices_table, save_price, get_crawled_price_trains,
    get_prices_conn, get_railway_conn, load_same_train_map,
)


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("price_collector")


# ============================================================
# 反爬检测
# ============================================================
ANTICRAWL_KEYWORDS = [
    "验证码", "captcha", "CAPTCHA", "访问太频繁", "请求太频繁",
    "访问被拒绝", "Access Denied", "Too Many Requests",
    "触发风控", "trigger", "您的请求过于频繁",
]

# G/D 车票价字段 → 系统内席别
SEAT_MAP_G = {
    "ze_price": "class2",   # 二等座
    "zy_price": "class1",   # 一等座
    "swz_price": "class0",  # 商务座/特等座
}
# 普速车票价字段 → 系统内席别
SEAT_MAP_PUSU = {
    "yz_price": "class2",   # 硬座 → 二等座档次
    "yw_price": "class1",   # 硬卧 → 一等座档次
    "rw_price": "class0",   # 软卧 → 特等座档次
}


class PriceCollector:
    """票价采集客户端"""

    _USER_AGENTS = [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    ]

    def __init__(self, resume: bool = False, target_train: str = None, max_workers: int = 1):
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": CRAWLER_CONFIG["user_agent"],
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "Accept-Encoding": "gzip, deflate, br",
            "Connection": "keep-alive",
        })
        self.query_date = get_query_date()
        # 候选日期：未来第 3/9/13 天，逐天重试
        from datetime import timedelta
        base = datetime.now()
        self.query_dates = [
            (base + timedelta(days=d)).strftime("%Y-%m-%d")
            for d in CRAWLER_CONFIG["query_date_days_list"]
        ]
        self.max_retries = CRAWLER_CONFIG["max_retries"]
        self.request_timeout = CRAWLER_CONFIG["request_timeout"]
        self.resume = resume
        self.target_train = target_train
        self.max_workers = max_workers
        self._req_count = 0
        self.same_train_map = load_same_train_map()
        # 并发控制
        self._shutdown_event = threading.Event()
        self._stats_lock = threading.Lock()
        self._failed_log_lock = threading.Lock()
        # 失败日志
        ensure_directories()
        self._failed_log = os.path.join(LOGS_DIR, "failed_pairs.log")
        # 追加模式，写入时间分隔行
        with open(self._failed_log, "a", encoding="utf-8") as f:
            f.write(f"\n--- {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} ---\n")

        # 统计
        self.total_pairs = 0
        self.success_count = 0
        self.fail_count = 0

    # ----------------------------------------------------------
    # 请求与反爬
    # ----------------------------------------------------------
    @staticmethod
    def _is_anticrawl(resp: Optional[requests.Response]) -> bool:
        if resp is None:
            return False
        if resp.status_code in (403, 429):
            return True
        if resp.status_code == 200 and len(resp.text) < 1000:
            body = resp.text.lower()
            for kw in ANTICRAWL_KEYWORDS:
                if kw.lower() in body:
                    return True
        return False

    def _request(self, url: str, params: dict = None,
                 headers: dict = None,
                 session: requests.Session = None) -> Optional[requests.Response]:
        """带重试的 GET 请求。session 参数支持并发时传入独立 Session。"""
        used_session = session or self.session
        for attempt in range(1, self.max_retries + 1):
            try:
                self._req_count += 1
                req_headers = used_session.headers.copy()
                if headers:
                    req_headers.update(headers)

                resp = used_session.get(url, params=params, headers=req_headers,
                                        timeout=self.request_timeout)

                if self._is_anticrawl(resp):
                    logger.warning(f"⚠️ 反爬 [尝试 {attempt}/{self.max_retries}] "
                                   f"HTTP {resp.status_code}")
                    if attempt < self.max_retries:
                        continue

                if resp.status_code != 200:
                    logger.warning(f"[重试 {attempt}/{self.max_retries}] "
                                   f"HTTP {resp.status_code}")
                    continue

                return resp

            except requests.RequestException as e:
                logger.warning(f"[重试 {attempt}/{self.max_retries}] {e}")
                continue

        return None

    # ----------------------------------------------------------
    # Session 初始化（获取 Cookie）
    # ----------------------------------------------------------
    def init_session(self) -> bool:
        """访问 12306 首页获取 Cookie"""
        url = "https://kyfw.12306.cn/otn/leftTicket/init"
        logger.info("[Session] 初始化会话...")
        resp = self._request(url)
        if resp is None:
            logger.error("[Session] 会话初始化失败")
            return False
        logger.info("[Session] 会话初始化成功")
        return True

    def _rotate_user_agent(self):
        """轮换 User-Agent"""
        ua = random.choice(self._USER_AGENTS)
        self.session.headers.update({"User-Agent": ua})
        logger.info(f"[反爬] 切换 User-Agent: {ua[:60]}...")

    def _reinit_session(self):
        """重新初始化 Session（长暂停后调用）"""
        logger.info("[反爬] 重新初始化 Session...")
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": random.choice(self._USER_AGENTS),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "Accept-Encoding": "gzip, deflate, br",
            "Connection": "keep-alive",
        })
        self.init_session()

    # ----------------------------------------------------------
    # 票价查询
    # ----------------------------------------------------------
    def query_price(self, from_id: str, to_id: str, target_train: str = None,
                    session: requests.Session = None,
                    query_date: str = None) -> Optional[Dict]:
        """
        查询某一站对某天的各席别票价。
        返回 {seat_type: price_yuan} 或 None。
        session: 可选，用于并发爬取时传入独立 Session
        query_date: 可选，指定查询日期（YYYY-MM-DD），默认使用 self.query_date
        """
        params = {
            "leftTicketDTO.train_date": query_date or self.query_date,
            "leftTicketDTO.from_station": from_id,
            "leftTicketDTO.to_station": to_id,
            "purpose_codes": "ADULT",
        }
        headers = {
            "Referer": "https://kyfw.12306.cn/otn/view/queryPublicIndex.html",
            "X-Requested-With": "XMLHttpRequest",
        }
        url = "https://kyfw.12306.cn/otn/leftTicketPrice/queryAllPublicPrice"
        resp = self._request(url, params=params, headers=headers, session=session)
        if resp is None:
            return None

        try:
            data = resp.json()
        except Exception:
            return None

        if data.get("status") != True:
            return None

        results = data.get("data", [])
        if not isinstance(results, list):
            return None

        for item in results:
            dto = item.get("queryLeftNewDTO", {})
            # 匹配目标车次
            if target_train and dto.get("station_train_code", "") != target_train:
                continue

            # 判断车型，选择对应的字段映射
            train_class = dto.get("train_class_name", "")
            if train_class in ("高速", "动车"):
                seat_map = SEAT_MAP_G
            else:
                seat_map = SEAT_MAP_PUSU

            prices = {}
            for api_key, seat_key in seat_map.items():
                val = dto.get(api_key)
                if val is not None:
                    try:
                        # 价格单位是角，转为元
                        prices[seat_key] = float(val) / 10.0
                    except (ValueError, TypeError):
                        pass

            if prices:
                return prices
            # 找到了目标车次但该区间无价格数据，不必继续遍历其余车次
            break

        return None

    # ----------------------------------------------------------
    # 主流程
    # ----------------------------------------------------------
    def run(self):
        """执行全量票价爬取（支持并发）"""
        init_prices_table()
        logger.info("[DB] prices 表已就绪")

        if not self.init_session():
            logger.error("会话初始化失败，终止")
            sys.exit(1)

        rw_conn = get_railway_conn()
        p_conn = get_prices_conn()
        cursor = rw_conn.cursor()

        if self.target_train:
            train_list = [self.target_train]
        else:
            cursor.execute("SELECT train_num FROM trains ORDER BY train_num")
            train_list = [row[0] for row in cursor.fetchall()]

        rw_conn.close()

        already_crawled = set()
        if self.resume:
            already_crawled = get_crawled_price_trains(p_conn)
            logger.info(f"[续爬] 已有 {len(already_crawled)} 趟车次已爬取，跳过")
        p_conn.close()

        workers = self.max_workers if not self.target_train else 1
        if workers > 1:
            logger.info(f"[并发] 启动 {workers} 个并发线程爬取 {len(train_list)} 趟车次")
            with ThreadPoolExecutor(max_workers=workers) as executor:
                futures = {}
                for train_num in train_list:
                    if _shutdown_requested or self._shutdown_event.is_set():
                        break
                    future = executor.submit(self._crawl_single_train, train_num, already_crawled)
                    futures[future] = train_num

                for future in as_completed(futures):
                    try:
                        result = future.result()
                        with self._stats_lock:
                            self.total_pairs += result["pair_ok"] + result["pair_fail"]
                            self.success_count += result["pair_ok"]
                            self.fail_count += result["pair_fail"]
                    except Exception as e:
                        tn = futures.get(future, "?")
                        logger.error(f"[异常] {tn}: {e}")
        else:
            # 单线程模式（与修改前行为一致）
            p_conn = get_prices_conn()
            try:
                for train_num in train_list:
                    if _shutdown_requested:
                        logger.info("[中止] 检测到退出信号，停止爬取")
                        break
                    result = self._crawl_single_train(train_num, already_crawled, p_conn)
                    self.total_pairs += result["pair_ok"] + result["pair_fail"]
                    self.success_count += result["pair_ok"]
                    self.fail_count += result["pair_fail"]
            finally:
                p_conn.close()

        self._print_report()

    def _crawl_single_train(self, train_num: str, already_crawled: set,
                            shared_p_conn=None) -> dict:
        """
        爬取一趟车的票价（线程安全）。
        --resume 时自动校验数据完整性，不全的车次会重新爬取。
        返回 {"pair_ok": int, "pair_fail": int}。
        shared_p_conn: 单线程模式复用已有连接；并发模式每个线程创建独立连接。
        """
        if _shutdown_requested or self._shutdown_event.is_set():
            return {"pair_ok": 0, "pair_fail": 0}

        # 并发模式下创建独立连接和 Session
        own_conn = shared_p_conn is None
        rw_conn = get_railway_conn()
        p_conn = shared_p_conn or get_prices_conn()
        local_session = requests.Session()
        local_session.headers.update(self.session.headers) if own_conn else None

        try:
            cursor = rw_conn.cursor()
            cursor.execute("""
                SELECT station_id, station_name FROM train_stops
                WHERE train_num = ?
                ORDER BY stop_no
            """, (train_num,))
            stops = [{"station_id": r[0], "station_name": r[1]} for r in cursor.fetchall()]

            if len(stops) < 2:
                logger.warning(f"[跳过] {train_num} 经停站不足 2 个")
                with self._failed_log_lock:
                    with open(self._failed_log, "a", encoding="utf-8") as f:
                        f.write(f"{train_num}\t-\t-\t经停站不足2个\n")
                return {"pair_ok": 0, "pair_fail": 0}

            # --resume 时验证数据完整性，不全则重新爬取
            if train_num in already_crawled:
                expected = len(stops) * (len(stops) - 1) // 2
                p_cursor = p_conn.cursor()
                p_cursor.execute(
                    "SELECT COUNT(DISTINCT from_station_id || '|' || to_station_id) "
                    "FROM prices WHERE train_num = ?", (train_num,)
                )
                actual = p_cursor.fetchone()[0]
                if actual >= expected:
                    logger.info(f"[跳过] {train_num} 已爬取完整 ({actual}/{expected})")
                    return {"pair_ok": 0, "pair_fail": 0}
                else:
                    logger.info(f"[续爬] {train_num} 数据不全 ({actual}/{expected})，重新爬取")

            logger.info(f"[爬取] {train_num} ...")

            p_conn.execute("DELETE FROM prices WHERE train_num = ?", (train_num,))
            p_conn.commit()

            session = local_session if own_conn else None
            pair_ok, pair_fail = self._crawl_pairs(p_conn, train_num, stops, session=session)

            if pair_ok > 0:
                logger.info(f"[完成] {train_num}: {pair_ok}/{pair_ok + pair_fail} 站对成功")
                if pair_fail == 0:
                    self._compute_train_pairs(p_conn, train_num, stops)
            else:
                logger.warning(f"[失败] {train_num}: 全部 {pair_fail} 个站对均无数据")

            return {"pair_ok": pair_ok, "pair_fail": pair_fail}
        finally:
            rw_conn.close()
            if own_conn:
                p_conn.close()

    def supplement(self):
        """补充爬取：仅爬缺失的相邻站对，不删已有数据"""
        init_prices_table()
        logger.info("[DB] prices 表已就绪")

        if not self.init_session():
            logger.error("会话初始化失败，终止")
            sys.exit(1)

        rw_conn = get_railway_conn()
        p_conn = get_prices_conn()
        cursor = rw_conn.cursor()
        p_cursor = p_conn.cursor()

        p_cursor.execute("SELECT DISTINCT train_num FROM prices ORDER BY train_num")
        partial_trains = [row[0] for row in p_cursor.fetchall()]
        logger.info(f"[补充] 共 {len(partial_trains)} 趟车次有票价数据，检查缺失站对...")

        supplement_pairs = 0
        for train_num in partial_trains:
            if _shutdown_requested:
                logger.info("[中止] 检测到退出信号，停止补充")
                break
            if self.target_train and train_num != self.target_train:
                continue

            cursor.execute("""
                SELECT station_id, station_name FROM train_stops
                WHERE train_num = ?
                ORDER BY stop_no
            """, (train_num,))
            stops = [{"station_id": r[0], "station_name": r[1]} for r in cursor.fetchall()]
            if len(stops) < 2:
                continue

            # 在 prices.db 中查出已存在的站对
            p_cursor.execute("""
                SELECT DISTINCT from_station_id, to_station_id FROM prices
                WHERE train_num = ?
            """, (train_num,))
            existing = {(r[0], r[1]) for r in p_cursor.fetchall()}

            missing_pairs = []
            for i in range(len(stops) - 1):
                pair = (stops[i]["station_id"], stops[i + 1]["station_id"])
                if pair not in existing:
                    missing_pairs.append((stops[i]["station_name"], stops[i + 1]["station_name"],
                                          pair[0], pair[1]))

            if not missing_pairs:
                continue

            logger.info(f"[补充] {train_num}: {len(missing_pairs)} 个缺失站对")
            ok, fail = self._crawl_pairs(p_conn, train_num, stops,
                                         only_missing={(p[2], p[3]) for p in missing_pairs})
            supplement_pairs += ok
            if fail == 0:
                self._compute_train_pairs(p_conn, train_num, stops)

        p_conn.close()
        rw_conn.close()
        logger.info(f"[补充] 完成，补充了 {supplement_pairs} 个站对")

    def _compute_train_pairs(self, p_conn, train_num, stops):
        """
        对一趟车的所有非相邻段（A→C、A→D…）累加计算票价。
        p_conn: prices.db 连接。
        """
        cursor = p_conn.cursor()

        # 检查相邻段是否齐全
        cursor.execute("""
            SELECT DISTINCT from_station_id, to_station_id FROM prices
            WHERE train_num = ?
        """, (train_num,))
        existing_adj = {(r[0], r[1]) for r in cursor.fetchall()}
        all_adj = {(stops[i]["station_id"], stops[i + 1]["station_id"])
                   for i in range(len(stops) - 1)}
        if all_adj - existing_adj:
            return 0

        # 读相邻段各席别价格
        cursor.execute("""
            SELECT from_station_id, to_station_id, seat, price FROM prices
            WHERE train_num = ?
        """, (train_num,))
        adj_prices = {}
        for r in cursor.fetchall():
            adj_prices[(r[0], r[1], r[2])] = r[3]

        cursor.execute("SELECT DISTINCT seat FROM prices WHERE train_num = ?", (train_num,))
        seats = [r[0] for r in cursor.fetchall()]

        n = len(stops)
        computed = 0
        for i in range(n):
            for j in range(i + 2, n):
                f_id = stops[i]["station_id"]
                t_id = stops[j]["station_id"]
                for seat in seats:
                    total = 0.0
                    valid = True
                    for k in range(i, j):
                        key = (stops[k]["station_id"], stops[k + 1]["station_id"], seat)
                        if key not in adj_prices:
                            valid = False
                            break
                        total += adj_prices[key]
                    if valid:
                        save_price(p_conn, train_num, f_id, t_id, seat, round(total, 2))
                        computed += 1
        p_conn.commit()
        if computed:
            logger.info(f"  📐 已计算 {computed} 条非相邻段票价")
        return computed

    def _crawl_pairs(self, p_conn, train_num, stops, only_missing=None,
                     session: requests.Session = None):
        """
        爬取指定车次的相邻站对。
        每站对尝试3轮，每轮所有同组车次各试5次。
        3轮后仍无数据则换下一天重试（最多第3/4/5天）。
        全部日期都失败才放弃整趟车。
        p_conn: prices.db 连接。
        only_missing: 若指定，只爬这些 {(from_id, to_id)}。
        session: 可选，并发时传入独立 Session。
        返回 (pair_ok, pair_fail)。
        """
        siblings = self.same_train_map.get(train_num, [])
        all_trains = [train_num] + siblings
        effective_tn = train_num
        pair_ok = 0
        pair_fail = 0
        current_date_idx = 0  # 当前生效的日期索引

        for i in range(len(stops) - 1):
            if _shutdown_requested or self._shutdown_event.is_set():
                break
            f_id, f_name = stops[i]["station_id"], stops[i]["station_name"]
            t_id, t_name = stops[i + 1]["station_id"], stops[i + 1]["station_name"]
            if only_missing is not None and (f_id, t_id) not in only_missing:
                continue
            with self._stats_lock:
                self.total_pairs += 1

            prices = None
            # 逐天重试：先用当前生效日期，失败则换下一天
            start_date_idx = current_date_idx
            for date_idx in range(start_date_idx, len(self.query_dates)):
                crawl_date = self.query_dates[date_idx]
                if date_idx != start_date_idx:
                    logger.info(f"  ⟳ 换日期 {crawl_date} 重试 {f_name}→{t_name}")

                for round_idx in range(3):
                    ordered_trains = [effective_tn] + [t for t in all_trains if t != effective_tn]
                    for try_tn in ordered_trains:
                        for attempt in range(5):
                            prices = self.query_price(f_id, t_id, try_tn,
                                                      session=session, query_date=crawl_date)
                            if prices is not None:
                                if try_tn != train_num:
                                    logger.info(f"  ↪ 用 {try_tn} 查到 {f_name}→{t_name}")
                                if date_idx != current_date_idx:
                                    current_date_idx = date_idx
                                effective_tn = try_tn
                                break
                            logger.info(f"  ⟳ {f_name}→{t_name} [{try_tn}] 第{attempt+1}次无数据")
                        if prices is not None:
                            break
                    if prices is not None:
                        break
                    if round_idx < 2:
                        logger.info(f"  ⟳ 第{round_idx+1}轮无果，进入下一轮")

                if prices is not None:
                    break

            if prices is None:
                logger.info(f"  ✗ {f_name}→{t_name} 3轮无数据，放弃整趟 {train_num}")
                with self._failed_log_lock:
                    with open(self._failed_log, "a", encoding="utf-8") as f:
                        f.write(f"{train_num}\t{f_name}({f_id})\t{t_name}({t_id})\t全车放弃\n")
                        # 剩余未爬站对也记入（从 i+1 开始，避免重复写入已记入的失败站对）
                        for remaining in range(i + 1, len(stops) - 1):
                            rf = stops[remaining]
                            rt = stops[remaining + 1]
                            f.write(f"{train_num}\t{rf['station_name']}({rf['station_id']})\t"
                                    f"{rt['station_name']}({rt['station_id']})\t未爬取\n")
                pair_fail = len(stops) - 1 - i
                break

            for seat, price in prices.items():
                save_price(p_conn, train_num, f_id, t_id, seat, price)
            p_conn.commit()
            pair_ok += 1
            logger.info(f"  ✓ {f_name}→{t_name} {prices}")

        return pair_ok, pair_fail

    def _print_report(self):
        logger.info("=" * 50)
        logger.info(f"爬取完成！")
        logger.info(f"  总站对: {self.total_pairs}")
        logger.info(f"  成功:   {self.success_count}")
        logger.info(f"  失败:   {self.fail_count}")
        if self.total_pairs > 0:
            logger.info(f"  成功率: {self.success_count / self.total_pairs * 100:.1f}%")


# ============================================================
# 入口
# ============================================================
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="12306 票价爬虫")
    parser.add_argument("--resume", action="store_true", help="断点续爬，跳过已爬取的车次")
    parser.add_argument("--supplement", action="store_true", help="补充模式：仅爬缺失的站对，不删已有数据")
    parser.add_argument("--train", type=str, help="仅爬取指定车次（如 G1）")
    parser.add_argument("--workers", type=int, default=1, help="并发线程数（默认 1，建议 3~5）")
    args = parser.parse_args()

    collector = PriceCollector(resume=args.resume, target_train=args.train, max_workers=args.workers)
    if args.supplement:
        collector.supplement()
    else:
        collector.run()
