"""
数据爬虫主程序 —— 12306 数据采集与基础数据库构建

执行流程（依据 01_数据爬取与数据库设计.md）：
1. 初始化数据库，创建四张表
2. 获取车站列表（station_name.js）→ 写入 stations 表
3. 初始化 Session，获取 Cookie
4. 通过 search API 枚举 G10-G99 + G1-G9 获取所有 G 车次的 train_no → 写入 trains 表
5. 遍历所有车次，调用车次详情接口获取经停站 → 写入 train_stops 表
6. 物化 station_trains 表
7. 数据验证与输出报告

注意：12306 已于2025年废弃 /otn/czxx/query（车站大屏）接口，
改用 search API（search.12306.cn/search/v1/train/search）枚举 train_no，
再通过 /otn/czxx/queryByTrainNo 获取详情。"""

import re
import json
import time
import random
import logging
import sys
from datetime import datetime, timedelta
from typing import Optional, Dict, List, Tuple
import os

import requests

from config import (
    CRAWLER_CONFIG, get_query_date,
    ensure_directories, RAILWAY_DB_PATH
)
from database import (
    init_railway_db, refresh_station_trains
)


# ============================================================
# 日志配置
# ============================================================
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("collector")


# ============================================================
# 反爬策略：请求限速器
# ============================================================
# 反爬检测关键词（响应体中若有则判定被反爬）
ANTICRAWL_KEYWORDS = [
    "验证码", "captcha", "CAPTCHA", "访问太频繁", "请求太频繁",
    "访问被拒绝", "Access Denied", "Too Many Requests",
    "触发风控", "trigger", "您的请求过于频繁",
]

# 站名归一化：车站名均为汉字，去掉所有非汉字字符后用于 name→id 匹配与去重
_NON_HANZI = re.compile(r"[^\u4e00-\u9fff]")


def _norm_station(name: str) -> str:
    """去除站名中的所有非汉字字符（空格/符号/字母/数字等）。"""
    return _NON_HANZI.sub("", name or "")


class RateLimiter:
    """请求限速器，控制请求间隔"""

    def __init__(self, min_interval: float = 0.15):
        self.min_interval = min_interval
        self.last_request_time = 0.0
        self.request_count = 0

    def wait(self):
        """执行请求前等待（已禁用休眠）"""
        pass

# ============================================================
# 12306 爬虫客户端
# ============================================================
class TicketCrawler:
    """12306 数据采集客户端"""

    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": CRAWLER_CONFIG["user_agent"],
        })
        self.rate_limiter = RateLimiter(CRAWLER_CONFIG["min_interval"])
        self.query_date = get_query_date()
        self.max_retries = CRAWLER_CONFIG["max_retries"]
        self.request_timeout = CRAWLER_CONFIG["request_timeout"]

        # 收集到的数据
        self.stations: Dict[str, str] = {}                # station_id → station_name
        self.station_name_to_id: Dict[str, str] = {}      # station_name → station_id
        self.g_trains: Dict[str, str] = {}                # train_num → train_no
        self.train_stops_data: Dict[str, List[Dict]] = {} # train_num → [stop_info]

        # 异常记录
        self.failed_train_details: List[str] = []   # 详情接口失败的车次

    @staticmethod
    def _is_anticrawl_response(response: Optional[requests.Response]) -> bool:
        """检测响应是否被反爬（状态码 + 响应体关键词）"""
        if response is None:
            return False
        # 状态码检测
        if response.status_code in (403, 429):
            return True
        # 响应体关键词检测（仅针对短响应，正常页面通常 ≥ 1KB）
        if response.status_code == 200 and len(response.text) < 1000:
            body_lower = response.text.lower()
            for kw in ANTICRAWL_KEYWORDS:
                if kw.lower() in body_lower:
                    return True
        return False

    def _request_with_retry(self, method: str, url: str,
                            params: Optional[Dict] = None,
                            headers: Optional[Dict] = None) -> Optional[requests.Response]:
        """
        带重试机制的 HTTP 请求
        重试条件：HTTP 状态码非 200 或检测到反爬
        被反爬时给出明确提示，不中止流程
        """
        for attempt in range(1, self.max_retries + 1):
            try:
                self.rate_limiter.wait()
                req_headers = self.session.headers.copy()
                if headers:
                    req_headers.update(headers)

                response = self.session.request(
                    method, url, params=params,
                    headers=req_headers, timeout=self.request_timeout
                )

                # 检测是否被反爬
                if self._is_anticrawl_response(response):
                    logger.warning(f"⚠️  ⚠️  被反爬 [尝试 {attempt}/{self.max_retries}] "
                                   f"HTTP {response.status_code}: {url}")
                    if attempt < self.max_retries:
                        # 被反爬时休眠更长时间
                        backoff = random.uniform(10, 20) * attempt
                        logger.warning(f"⏳ 等待 {backoff:.1f}s 后重试...")
                        time.sleep(backoff)
                    continue

                if response.status_code != 200:
                    logger.warning(f"[重试 {attempt}/{self.max_retries}] HTTP {response.status_code}: {url}")
                    if attempt < self.max_retries:
                        time.sleep(CRAWLER_CONFIG["min_interval"] * 5 * attempt)
                    continue

                return response

            except requests.RequestException as e:
                logger.warning(f"[重试 {attempt}/{self.max_retries}] 请求异常: {e}")
                if attempt < self.max_retries:
                    time.sleep(CRAWLER_CONFIG["min_interval"] * 5 * attempt)

        return None

    def init_session(self) -> bool:
        """
        初始化 Session：访问 leftTicket/init 获取 Cookie
        """
        url = "https://kyfw.12306.cn/otn/leftTicket/init"
        logger.info("[Session] 初始化会话...")
        response = self._request_with_retry("GET", url)
        if response is None:
            logger.error("[Session] 会话初始化失败")
            return False
        logger.info("[Session] 会话初始化成功")
        return True

    # ============================================================
    # 1. 车站列表采集
    # ============================================================
    def collect_stations(self) -> int:
        """
        采集全国车站列表
        从 station_name.js 解析站名与电报码
        station_name.js 格式：@拼音|站名|电报码|拼音全称|简称|序号
        示例：@bji|北京|BJP|beijing|bji|1
        返回采集到的车站数量
        """
        url = "https://kyfw.12306.cn/otn/resources/js/framework/station_name.js"
        headers = {"Referer": "https://kyfw.12306.cn/otn/leftTicket/init"}

        response = self._request_with_retry("GET", url, headers=headers)
        if response is None:
            logger.error("[车站] 车站列表采集失败！")
            return 0

        text = response.text
        match = re.search(r"var station_names\s*=\s*'([^']+)'", text)
        if not match:
            logger.error("[车站] 无法从响应中解析 station_names")
            return 0

        raw_data = match.group(1)
        entries = raw_data.split("@")

        count = 0
        for entry in entries:
            if not entry.strip():
                continue
            parts = entry.split("|")
            if len(parts) >= 6:
                station_name = parts[1].strip()
                station_id = parts[2].strip()
                if station_id and station_name:
                    self.stations[station_id] = station_name
                    # 以“去非汉字”后的站名为 key（车站名均为汉字，避免空格/符号导致匹配不上）
                    self.station_name_to_id[_norm_station(station_name)] = station_id
                    count += 1

        logger.info(f"[车站] 采集完成，共 {count} 个车站")
        return count

    def save_stations_to_db(self, conn):
        """将车站列表写入数据库（先清空依赖表再重写）"""
        cursor = conn.cursor()
        # 外键约束：先删依赖表数据，再删 stations
        cursor.execute("DELETE FROM station_trains")
        cursor.execute("DELETE FROM train_stops")
        cursor.execute("DELETE FROM stations")
        for station_id, station_name in self.stations.items():
            cursor.execute(
                "INSERT OR REPLACE INTO stations (station_id, station_name) VALUES (?, ?)",
                (station_id, station_name)
            )
        conn.commit()
        logger.info(f"[数据库] 已写入 {len(self.stations)} 个车站到 stations 表")

    # ============================================================
    # 2. 通过 search API 枚举 train_no 发现 G 车次
    # ============================================================
    def _search_trains_by_prefix(self, prefix: str) -> Dict[str, str]:
        """
        通过 search API 按前缀搜索车次
        接口：search.12306.cn/search/v1/train/search?keyword=G{prefix}
        部分匹配：prefix=G10 返回 G10、G100、G1001... 等所有以 G10 开头的车次
        返回 {train_num: train_no} 映射表
        """
        url = f"https://search.12306.cn/search/v1/train/search"
        headers = {
            "Referer": "https://kyfw.12306.cn/",
        }
        # search API 需要今天日期的 YYYYMMDD 格式
        today_str = datetime.now().strftime("%Y%m%d")
        params = {
            "keyword": f"G{prefix}",
            "date": today_str,
        }

        local_trains: Dict[str, str] = {}
        response = self._request_with_retry("GET", url, params=params, headers=headers)
        if response is None:
            logger.debug(f"[search] G{prefix} 请求失败")
            return local_trains

        try:
            data = response.json()
        except json.JSONDecodeError:
            logger.debug(f"[search] G{prefix} 返回非 JSON")
            return local_trains

        train_list = data.get("data", [])
        if not train_list:
            logger.debug(f"[search] G{prefix} 返回空数据")
            return local_trains

        for item in train_list:
            train_code = item.get("station_train_code", "")
            train_no = item.get("train_no", "")
            if train_code.startswith("G") and train_no:
                if train_code not in local_trains:
                    local_trains[train_code] = train_no

        return local_trains

    def discover_g_trains(self, conn) -> int:
        """
        枚举 G10-G99 + G1-G9，通过 search API 发现所有 G 车次的 train_no
        - 枚举前2位数字 G10-G99（每个返回 ≤150 条，覆盖所有车次）
        - 再取 G1-G9 的第1条数据（确保 G1-G9 本身被收录）
        返回发现的 G 车次数量
        """
        self.g_trains = {}

        # 第1步：枚举 G10-G99（两位数前缀，每个返回所有以该前缀开头的车次）
        logger.info(f"[车次] 开始枚举 G10-G99 通过 search API 发现车次...")
        for tens in range(1, 10):       # 十位数 1-9
            for ones in range(0, 10):   # 个位数 0-9
                prefix = f"{tens}{ones}"
                logger.info(f"[车次]   G{prefix} ...")
                trains = self._search_trains_by_prefix(prefix)
                new_count = 0
                for tn, tno in trains.items():
                    if tn not in self.g_trains:
                        self.g_trains[tn] = tno
                        new_count += 1
                if new_count > 0:
                    logger.info(f"  → 新增 {new_count} 个，累计 {len(self.g_trains)}")

        # 第2步：补 G1-G9（取第1条，确保 G1...G9 本身被收录）
        logger.info(f"[车次] 补充 G1-G9 ...")
        for digit in range(1, 10):
            prefix = str(digit)
            trains = self._search_trains_by_prefix(prefix)
            if trains:
                # 取返回结果中 train_code 正好匹配 G{digit} 的
                exact = next((tn for tn in trains if tn == f"G{digit}"), None)
                if exact:
                    self.g_trains[exact] = trains[exact]
                    logger.info(f"  → 收录 G{digit}: {trains[exact]}")

        logger.info(f"[车次] 发现完成，共 {len(self.g_trains)} 个 G 车次")

        # 写入数据库
        cursor = conn.cursor()
        cursor.execute("DELETE FROM trains")
        for train_num, train_no in self.g_trains.items():
            cursor.execute(
                "INSERT OR REPLACE INTO trains (train_num, train_no) VALUES (?, ?)",
                (train_num, train_no)
            )
        conn.commit()
        logger.info(f"[数据库] 已写入 {len(self.g_trains)} 个车次到 trains 表")

        return len(self.g_trains)

    # ============================================================
    # 3. 车次详情接口（获取经停站）
    # ============================================================
    def collect_train_stops(self, train_num: str, train_no: str) -> Optional[List[Dict]]:
        """
        采集指定车次的完整经停站列表
        使用 /otn/czxx/queryByTrainNo 接口
        返回 [{stop_no, station_name, station_id, stop_time}, ...]
        """
        url = "https://kyfw.12306.cn/otn/czxx/queryByTrainNo"
        headers = {
            "Referer": "https://kyfw.12306.cn/otn/leftTicket/init",
            "X-Requested-With": "XMLHttpRequest",
        }

        params = {
            "train_no": train_no,
            "from_station_telecode": "BJP",   # 不需要精确匹配
            "to_station_telecode": "SHH",
            "depart_date": self.query_date,
        }

        response = self._request_with_retry("GET", url, params=params, headers=headers)
        if response is None:
            logger.debug(f"[详情] 车次 {train_num}({train_no}) 请求失败")
            self.failed_train_details.append(train_num)
            return None

        try:
            data = response.json()
        except json.JSONDecodeError:
            logger.debug(f"[详情] 车次 {train_num} 返回非 JSON 数据")
            self.failed_train_details.append(train_num)
            return None

        if not data.get("status"):
            logger.debug(f"[详情] 车次 {train_num} 返回 status=false")
            self.failed_train_details.append(train_num)
            return None

        stops_data = data.get("data", {}).get("data", [])
        if not stops_data:
            logger.debug(f"[详情] 车次 {train_num} 经停站数据为空")
            self.failed_train_details.append(train_num)
            return None

        stops = []
        for item in stops_data:
            station_name = item.get("station_name") or ""

            # 时间字段：12306 API 中部分车站的抵达/出发字段名可能有变体
            # 尝试多个字段名，取第一个有效的 HH:MM 格式时间
            arrive_time = (item.get("arrive_time") or "").strip()
            depart_time = (item.get("depart_time") or "").strip()

            # 停站时间规则：
            # - 有抵达时间取抵达时间，没有则取出发时间
            # - 12306 可能用空串、"--"、"----"、"——" 等表示无时间
            # - 只认 HH:MM 格式，忽略所有占位符
            def _is_valid_time(t: str) -> bool:
                return bool(t and re.match(r'^\d{2}:\d{2}$', t))

            stop_time = ""
            if _is_valid_time(arrive_time):
                stop_time = arrive_time
            elif _is_valid_time(depart_time):
                stop_time = depart_time
            elif _is_valid_time((item.get("start_time") or "").strip()):
                stop_time = item.get("start_time", "").strip()
            elif _is_valid_time((item.get("begin_time") or "").strip()):
                stop_time = item.get("begin_time", "").strip()
            # 兜底：取第一个非空字段
            if not stop_time:
                for fld in ("arrive_time", "depart_time", "start_time", "begin_time"):
                    v = (item.get(fld) or "").strip()
                    if v:
                        stop_time = v
                        break

            # 查找车站电报码（通过“去非汉字”后的站名反向映射，避免空格/符号差异 miss）
            norm_name = _norm_station(station_name)
            station_id = self.station_name_to_id.get(norm_name, "")
            if not station_id:
                # 自动注册未知车站（防止外键约束失败）
                # 使用 "@" 前缀标记为自动生成 ID；仅在确无合法映射时才注册，且不覆盖已有合法映射
                station_id = f"@{station_name}"
                self.stations[station_id] = station_name
                self.station_name_to_id.setdefault(norm_name, station_id)

            stops.append({
                "stop_no": item.get("station_no", 0),
                "station_name": station_name,
                "station_id": station_id,
                "stop_time": stop_time,
                "arrive_time": arrive_time,
                "depart_time": depart_time,
                "stop_duration": item.get("stop_duration", 0),
            })

        # 校验经停站数量是否至少 2 个
        if len(stops) < 2:
            logger.debug(f"[详情] 车次 {train_num} 经停站少于 2 个：{len(stops)}")
            self.failed_train_details.append(train_num)
            return None

        return stops

    def collect_all_stops(self, conn) -> int:
        """
        遍历所有 G 车次，采集经停站信息
        返回采集到的经停记录总数
        """
        total = len(self.g_trains)
        logger.info(f"[经停] 开始遍历 {total} 个 G 车次采集经停站...")

        all_stops: List[Dict] = []
        cursor = conn.cursor()

        # 批量写入前临时关闭 FK 校验（经停数据量大，引用关系复杂）
        cursor = conn.cursor()
        try:
            cursor.execute("PRAGMA foreign_keys = OFF")
            cursor.execute("DELETE FROM train_stops")
            cursor.execute("DELETE FROM stations WHERE station_id LIKE '@%'")
            for idx, (train_num, train_no) in enumerate(self.g_trains.items(), 1):
                if idx % 20 == 0:
                    logger.info(f"[经停] 进度 {idx}/{total}")

                stops = self.collect_train_stops(train_num, train_no)
                if stops is None:
                    # 详情接口获取失败，从 trains 表中清理该车次，避免下游模块读到空经停
                    cursor.execute("DELETE FROM trains WHERE train_num = ?", (train_num,))
                    continue

                for stop in stops:
                    # 确保车站已在 stations 表中（防止外键约束失败）
                    if stop["station_id"].startswith("@"):
                        cursor.execute(
                            "INSERT OR IGNORE INTO stations (station_id, station_name) VALUES (?, ?)",
                            (stop["station_id"], stop["station_name"])
                        )
                    try:
                        cursor.execute("""
                            INSERT OR REPLACE INTO train_stops
                            (train_num, stop_no, station_id, station_name, stop_time)
                            VALUES (?, ?, ?, ?, ?)
                        """, (
                            train_num,
                            stop["stop_no"],
                            stop["station_id"],
                            stop["station_name"],
                            stop["stop_time"],
                        ))
                    except Exception as e:
                        logger.warning(f"[经停] 跳过异常记录: {train_num} 第{stop['stop_no']}站 "
                                       f"station={stop['station_name']} id={stop['station_id']} "
                                       f"time={stop['stop_time']} 错误: {e}")
                        continue
                    all_stops.append(stop)

                # 每 50 个车次提交一次
                if idx % 50 == 0:
                    conn.commit()

            conn.commit()
        finally:
            # 确保无论是否异常都重新启用 FK 校验
            cursor.execute("PRAGMA foreign_keys = ON")
        logger.info(f"[经停] 采集完成，共 {len(all_stops)} 条经停记录")
        return len(all_stops)

    # ============================================================
    # 4. 物化 station_trains 表
    # ============================================================
    def build_station_trains(self, conn):
        """物化 station_trains 表（车站→经停车次）"""
        logger.info("[物化] 构建 station_trains 表...")
        refresh_station_trains(conn)
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) FROM station_trains")
        count = cursor.fetchone()[0]
        logger.info(f"[物化] 完成，共 {count} 条车站-车次关联记录")

    # ============================================================
    # 5b. 同车多号映射
    # ============================================================
    def build_same_train_map(self, conn):
        """
        构建同车多号映射（同一物理列车对应多个车次号）。
        原理：经停站序列（站名+时间）完全相同的车次属于同一列车。
        结果保存到 data/same_trains.json。
        """
        from config import DATA_DIR
        from collections import defaultdict
        import json

        logger.info("[同车映射] 构建同车多号映射...")
        cursor = conn.cursor()
        cursor.execute(
            "SELECT train_num, stop_no, station_name, stop_time "
            "FROM train_stops ORDER BY train_num, stop_no"
        )
        rows = cursor.fetchall()

        # 按车次分组
        train_stops = defaultdict(list)
        for row in rows:
            train_stops[row[0]].append({
                "stop_no": row[1],
                "station_name": row[2],
                "stop_time": row[3],
            })

        # 停站序列哈希 -> 车次列表
        hash_to_trains = defaultdict(list)
        for tn, stops in train_stops.items():
            stop_key = "|".join([f"{s['station_name']}:{s['stop_time']}" for s in stops])
            hash_to_trains[stop_key].append(tn)

        # 找出多车次组
        same_train_groups = {k: v for k, v in hash_to_trains.items() if len(v) > 1}

        all_results = []
        for stop_key, trains in same_train_groups.items():
            first = trains[0]
            stops = train_stops[first]
            entry = {
                "trains": sorted(trains),
                "count": len(trains),
                "start_station": stops[0]["station_name"],
                "end_station": stops[-1]["station_name"],
                "num_stops": len(stops),
                "start_time": stops[0]["stop_time"],
                "end_time": stops[-1]["stop_time"],
                "route": f"{stops[0]['station_name']} → {stops[-1]['station_name']}",
            }
            all_results.append(entry)

        output_path = os.path.join(DATA_DIR, "same_trains.json")
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(all_results, f, ensure_ascii=False, indent=2)

        total_trains = sum(g["count"] for g in all_results)
        logger.info(f"[同车映射] 完成：{len(all_results)} 组，涉及 {total_trains} 个车次")
        logger.info(f"[同车映射] 已保存至: {output_path}")

    # ============================================================
    # 5. 数据验证
    # ============================================================
    def verify_data(self, conn) -> Dict:
        """
        数据完整性验证，返回验证报告
        """
        cursor = conn.cursor()

        # 车站统计
        cursor.execute("SELECT COUNT(*) FROM stations")
        station_count = cursor.fetchone()[0]

        # 车次统计
        cursor.execute("SELECT COUNT(*) FROM trains")
        train_count = cursor.fetchone()[0]

        # 经停统计
        cursor.execute("SELECT COUNT(*) FROM train_stops")
        stop_count = cursor.fetchone()[0]

        # 有经停的车次数
        cursor.execute("SELECT COUNT(DISTINCT train_num) FROM train_stops")
        trains_with_stops = cursor.fetchone()[0]

        # station_trains 统计
        cursor.execute("SELECT COUNT(*) FROM station_trains")
        st_count = cursor.fetchone()[0]

        # 异常统计
        cursor.execute("SELECT COUNT(*) FROM train_stops WHERE station_id IS NULL OR station_id = ''")
        missing_station_id = cursor.fetchone()[0]

        cursor.execute("SELECT COUNT(*) FROM train_stops WHERE stop_time IS NULL OR stop_time = ''")
        missing_stop_time = cursor.fetchone()[0]

        # 跨天车次（相邻经停站 stop_time 时间倒退，如 23:20→00:07，违反当日完成约束）
        cursor.execute("""
            SELECT COUNT(DISTINCT a.train_num)
            FROM train_stops a JOIN train_stops b
              ON a.train_num = b.train_num AND a.stop_no = b.stop_no - 1
            WHERE a.stop_time > b.stop_time
        """)
        overnight_count = cursor.fetchone()[0]

        report = {
            "station_count": station_count,
            "train_count": train_count,
            "stop_count": stop_count,
            "trains_with_stops": trains_with_stops,
            "station_trains_count": st_count,
            "missing_station_id": missing_station_id,
            "missing_stop_time": missing_stop_time,
            "overnight_train_count": overnight_count,
            "detail_failures": len(self.failed_train_details),
        }

        return report

    def print_report(self, report: Dict):
        """打印验证报告"""
        print(f"\n{'=' * 60}")
        print(f"  数据验证报告")
        print(f"{'=' * 60}")
        print(f"  ● 车站总数:        {report['station_count']}")
        print(f"  ● G 车次总数:      {report['train_count']}")
        print(f"  ● 经停记录总数:    {report['stop_count']}")
        print(f"  ● 有经停的车次数:   {report['trains_with_stops']}")
        print(f"  ● 车站-车次关联:    {report['station_trains_count']}")
        
        if report['missing_station_id'] > 0:
            print(f"  ⚠ 缺电报码:         {report['missing_station_id']}")
        if report['missing_stop_time'] > 0:
            print(f"  ⚠ 缺经停时间:       {report['missing_stop_time']}")
        if report['overnight_train_count'] > 0:
            print(f"  ⚠ 跨天车次:         {report['overnight_train_count']}（违反当日完成约束，见 cleanup_overnight_trains.py）")
        if report['detail_failures'] > 0:
            print(f"  ⚠ 详情接口失败:     {report['detail_failures']} 个车次")
        print(f"{'=' * 60}\n")


# ============================================================
# 主流程
# ============================================================
def main():
    """采集主流程"""
    print(f"\n{'=' * 60}")
    logger.info("12306 高铁数据采集器 v1.1")
    logger.info(f"基准日期: {get_query_date()}")
    logger.info(f"采用 search API 枚举 G10-G99 发现车次")
    print(f"{'=' * 60}")

    # 1. 初始化数据库
    logger.info("[阶段 1/7] 初始化数据库...")
    conn = init_railway_db()
    crawler = TicketCrawler()

    # 2. 采集车站列表
    logger.info("[阶段 2/7] 采集车站列表 (station_name.js)...")
    station_count = crawler.collect_stations()
    if station_count == 0:
        logger.error("车站列表采集失败，退出！")
        conn.close()
        sys.exit(1)
    crawler.save_stations_to_db(conn)

    # 3. 初始化 Session
    logger.info("[阶段 3/7] 初始化 HTTP Session...")
    if not crawler.init_session():
        logger.warning("Session 初始化异常，尝试继续...")

    # 4. 发现 G 车次（search API 枚举 train_no）
    logger.info("[阶段 4/7] 枚举 train_no（search API）...")
    train_count = crawler.discover_g_trains(conn)
    if train_count == 0:
        logger.error("未发现任何 G 车次，退出！")
        conn.close()
        sys.exit(1)

    # 5. 遍历所有车次采集经停站
    logger.info("[阶段 5/7] 采集经停站信息...")
    stop_count = crawler.collect_all_stops(conn)

    # 6. 物化 station_trains 表
    logger.info("[阶段 6/7] 物化 station_trains 表...")
    crawler.build_station_trains(conn)

    # 6b. 构建同车多号映射
    logger.info("[阶段 6b/7] 构建同车多号映射...")
    crawler.build_same_train_map(conn)

    # 7. 数据验证
    logger.info("[阶段 7/7] 数据完整性验证...")
    report = crawler.verify_data(conn)

    # 关闭数据库
    conn.close()

    # 打印报告
    crawler.print_report(report)

    print(f"\n{'=' * 60}")
    print(f"  采集完成！基础数据库已保存至: {RAILWAY_DB_PATH}")
    print(f"{'=' * 60}")


if __name__ == "__main__":
    main()