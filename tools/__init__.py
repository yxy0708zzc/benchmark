"""
工具定义模块
依据 02_API与工具定义.md 第二部分定义的 6 个 OpenAI Tools

每个工具包含：
- function 字典（用于传入大模型的 tool 定义）
- handler 函数（实际执行逻辑）
"""

from typing import Optional, List

# ============================================================
# 全局状态：当前题目 ID
# 由测试器在启动时设置
# ============================================================
_current_question_id: Optional[str] = None


def set_current_question(question_id: str):
    """设置当前题目 ID"""
    global _current_question_id
    _current_question_id = question_id


def get_current_question() -> str:
    """获取当前题目 ID"""
    if _current_question_id is None:
        raise ValueError("未选择题目，请先加载一个题目")
    return _current_question_id


# ============================================================
# Tool 1: query_trains_between_stations
# 对应端点: GET /api/routes
# ============================================================
def _make_func_query_trains_between_stations():
    return {
        "type": "function",
        "function": {
            "name": "query_trains_between_stations",
            "description": "查询从出发站到到达站之间的所有高铁车次，返回车次号及在出发站和到达站的实际到发时间。不返回整趟车的始发站或终到站。",
            "parameters": {
                "type": "object",
                "properties": {
                    "from_station_id": {
                        "type": "string",
                        "description": "出发站电报码，如 VNP（北京南）"
                    },
                    "to_station_id": {
                        "type": "string",
                        "description": "到达站电报码，如 AOH（上海虹桥）"
                    }
                },
                "required": ["from_station_id", "to_station_id"]
            }
        }
    }


# ============================================================
# Tool 2: query_trains_at_station
# 对应端点: GET /api/station/{station_id}
# ============================================================
def _make_func_query_trains_at_station():
    return {
        "type": "function",
        "function": {
            "name": "query_trains_at_station",
            "description": "查询经过指定车站的所有车次，返回车次号及在该站的时间。结果按车次号排序。",
            "parameters": {
                "type": "object",
                "properties": {
                    "station_id": {
                        "type": "string",
                        "description": "车站电报码，如 VNP（北京南）"
                    }
                },
                "required": ["station_id"]
            }
        }
    }


# ============================================================
# Tool 3: query_train_detail
# 对应端点: GET /api/train/{train_num}
# ============================================================
def _make_func_query_train_detail():
    return {
        "type": "function",
        "function": {
            "name": "query_train_detail",
            "description": "查询指定车次的完整经停站详情，返回该车次所有经停站的序号、站名、电报码、时间。",
            "parameters": {
                "type": "object",
                "properties": {
                    "train_num": {
                        "type": "string",
                        "description": "车次号，如 G1"
                    }
                },
                "required": ["train_num"]
            }
        }
    }


# ============================================================
# Tool 4: list_stations
# 对应端点: GET /api/station
# ============================================================
def _make_func_list_stations():
    return {
        "type": "function",
        "function": {
            "name": "list_stations",
            "description": "搜索车站列表，返回车站电报码和中文名。不传 keyword 则返回全部车站（受分页限制）。",
            "parameters": {
                "type": "object",
                "properties": {
                    "keyword": {
                        "type": "string",
                        "description": "搜索关键词，匹配站名或电报码。可选。"
                    },
                    "limit": {
                        "type": "integer",
                        "description": "每页返回数量，默认 50，最大 200"
                    },
                    "page": {
                        "type": "integer",
                        "description": "页码，默认 1"
                    }
                },
                "required": []
            }
        }
    }


# ============================================================
# Tool 5: list_trains
# 对应端点: GET /api/train
# ============================================================
def _make_func_list_trains():
    return {
        "type": "function",
        "function": {
            "name": "list_trains",
            "description": "搜索车次列表，返回所有车次号。不传 keyword 则返回全部车次（受分页限制）。",
            "parameters": {
                "type": "object",
                "properties": {
                    "keyword": {
                        "type": "string",
                        "description": "搜索关键词，匹配车次号，如 G1。可选。"
                    },
                    "limit": {
                        "type": "integer",
                        "description": "每页返回数量，默认 50，最大 200"
                    },
                    "page": {
                        "type": "integer",
                        "description": "页码，默认 1"
                    }
                },
                "required": []
            }
        }
    }


# ============================================================
# Tool 6: query_tickets
# 对应端点: GET /api/train/{train_num}/ticket
# ============================================================
def _make_func_query_tickets():
    return {
        "type": "function",
        "function": {
            "name": "query_tickets",
            "description": "查询指定车次各站对之间的余票数量。三种座位类型：class2=二等座（经济型），class1=一等座（更舒适），class0=特等座（可躺，十分舒适）。不指定 seat_types 则返回全部三种。不指定 from_station_id/to_station_id 则返回所有站对。",
            "parameters": {
                "type": "object",
                "properties": {
                    "train_num": {
                        "type": "string",
                        "description": "车次号，如 G1"
                    },
                    "seat_types": {
                        "type": "array",
                        "items": {
                            "type": "string",
                            "enum": ["class0", "class1", "class2"]
                        },
                        "description": "要查询的座位类型列表，不传则返回全部三种"
                    },
                    "from_station_id": {
                        "type": "string",
                        "description": "出发站电报码，不传则返回所有站对"
                    },
                    "to_station_id": {
                        "type": "string",
                        "description": "到达站电报码，不传则返回所有站对"
                    }
                },
                "required": ["train_num"]
            }
        }
    }

# ============================================================
# Tool 7: query_ticket_price
# ============================================================
def _make_func_query_ticket_price():
    return {
        "type": "function",
        "function": {
            "name": "query_ticket_price",
            "description": "查询某车次在指定出发站到到达站之间的各席别票价（元）。返回 class2/class1/class0 的价格。如果查不到该区间的票价数据则返回 null。",
            "parameters": {
                "type": "object",
                "properties": {
                    "train_num": {
                        "type": "string",
                        "description": "车次号，如 G1"
                    },
                    "from_station_id": {
                        "type": "string",
                        "description": "出发站电报码，如 VNP"
                    },
                    "to_station_id": {
                        "type": "string",
                        "description": "到达站电报码，如 JGK"
                    }
                },
                "required": ["train_num", "from_station_id", "to_station_id"]
            }
        }
    }


# ============================================================
# 工具注册列表
# ============================================================
TOOLS = [
    _make_func_query_trains_between_stations(),
    _make_func_query_trains_at_station(),
    _make_func_query_train_detail(),
    _make_func_list_stations(),
    _make_func_list_trains(),
    _make_func_query_tickets(),
    _make_func_query_ticket_price(),
]

# ============================================================
# 工具名称 → handler 映射
# ============================================================
TOOL_HANDLERS = {
    "query_trains_between_stations": None,  # 在 server.py 中注册
    "query_trains_at_station": None,
    "query_train_detail": None,
    "list_stations": None,
    "list_trains": None,
    "query_tickets": None,
    "query_ticket_price": None,
}


def get_tool_names() -> List[str]:
    """获取所有工具名称列表"""
    return [t["function"]["name"] for t in TOOLS]