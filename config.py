"""
全局配置模块
定义所有路径、字段名、配置项
"""

import os
from datetime import datetime, timedelta

# ============================================================
# 项目根目录
# ============================================================
PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))

# ============================================================
# 本地环境变量（.env，已被 .gitignore 忽略，不会上传）
# 用途：集中存放各输入点的 API Key / 模型 / 接口地址。
#   - TEST_API_KEY       测试器（server.py 兜底，前端未传时用）
#   - NL_API_KEY         nl_question.py（未传 --api-key 时用）
#   - DEFAULT_MODEL / DEFAULT_BASE_URL  两处共用默认
# ============================================================
def load_env(path: str = None) -> dict:
    """读取项目根目录 .env（KEY=VALUE，忽略 # 注释/空行，支持引号包裹的值）。"""
    path = path or os.path.join(PROJECT_ROOT, ".env")
    env = {}
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                env[k.strip()] = v.strip().strip('"').strip("'")
    return env


ENV = load_env()

# ============================================================
# 文件夹路径
# ============================================================
DATA_DIR = os.path.join(PROJECT_ROOT, "data")
QUESTION_DIR = os.path.join(PROJECT_ROOT, "question")
LOGS_DIR = os.path.join(PROJECT_ROOT, "logs")
LOGS_TEST_DIR = os.path.join(LOGS_DIR, "test")
LOGS_RESULT_DIR = os.path.join(LOGS_DIR, "result")
LOGS_REPORT_DIR = os.path.join(LOGS_DIR, "report")
TEMPLATES_DIR = os.path.join(PROJECT_ROOT, "templates")
TOOLS_DIR = os.path.join(PROJECT_ROOT, "tools")
STATISTICS_DIR = os.path.join(PROJECT_ROOT, "statistics")

# ============================================================
# 数据库文件路径
# ============================================================
RAILWAY_DB_PATH = os.path.join(DATA_DIR, "railway.db")       # 基础数据库（只读）
PRICES_DB_PATH = os.path.join(DATA_DIR, "prices.db")          # 票价数据库
METADATA_PATH = os.path.join(QUESTION_DIR, "metadata.json")   # 题目元数据

# ============================================================
# 爬虫配置（12306 请求限速 / 超时 / 重试 / 基准日期）
# ============================================================
CRAWLER_CONFIG = {
    "min_interval": 0.15,             # 请求最小间隔（秒）
    "request_timeout": 15,            # 请求超时（秒）
    "max_retries": 3,                 # 最大重试次数
    "batch_sleep_interval": 50,       # 每 N 次请求后额外休眠
    "batch_sleep_duration": (5, 10),  # 额外休眠时长范围（秒）
    "query_date_days_ahead": 3,       # 基准日期（未来第 N 天）
    "query_date_days_list": [3, 9, 13],  # 爬取日期候选列表，逐天重试
    "user_agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
}

# ============================================================
# 出题器配置
# ============================================================
QUESTION_CONFIG = {
    "default_interference_density": 0.02,  # 默认干扰密度（全局池统一默认 2%）
    "ticket_max_value": 1000,              # 余票上限（宽松兜底；合法解/真干扰最大 1.5×人数 ≤ 30，留足余量）
    "max_people_count": 20,                # 需求人数上限（答案票 1~1.5×人数，真干扰 0.5~1.5×人数）
    # 遗留（不再使用）：合法解票数现由 server.py `_random_solution_tickets` 生成（1~1.5×人数随机）
    "default_solution_ticket_min": 1,
    "default_solution_ticket_max": 5,
}

# ============================================================
# API 服务配置
# ============================================================
API_CONFIG = {
    "host": "127.0.0.1",
    "port": 8000,
    "cors_allow_origins": ["*"],
}

# ============================================================
# 日志配置
# ============================================================
LOG_CONFIG = {
    "level": "INFO",
    "format": "%(asctime)s - %(levelname)s - %(message)s",
}

# ============================================================
# 工具函数
# ============================================================
def get_query_date() -> str:
    """获取爬虫基准日期，格式 YYYY-MM-DD"""
    return (datetime.now() + timedelta(days=CRAWLER_CONFIG["query_date_days_ahead"])).strftime("%Y-%m-%d")

def ensure_directories():
    """确保所有必要的目录存在"""
    dirs = [
        DATA_DIR, QUESTION_DIR,
        LOGS_DIR, LOGS_TEST_DIR, LOGS_RESULT_DIR, LOGS_REPORT_DIR,
        TEMPLATES_DIR, TOOLS_DIR, STATISTICS_DIR,
    ]
    for d in dirs:
        os.makedirs(d, exist_ok=True)

def get_question_db_path(question_id: str) -> str:
    """获取题目数据库路径"""
    return os.path.join(QUESTION_DIR, f"{question_id}.db")