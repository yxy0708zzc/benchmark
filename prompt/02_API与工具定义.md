# 02_API与工具定义.md（给 Trae 的完整提示词）

本文件是 Trae 生成代码时的完整约束文档，涵盖第三章（工具构建）的全部内容：FastAPI 端点定义、OpenAI Tools 格式定义、查询逻辑说明。

**Trae 使用说明**：按以下顺序实现。所有端点路径、参数名、返回值结构、工具定义格式均已明确，无需猜测。先实现 FastAPI 服务层，再定义 Tools 格式（Tools 是对端点的封装，供大模型调用）。最后注册到工具列表。


## 第一部分：FastAPI 端点定义

### 1.1 基础信息

| 项目 | 值 |
|------|-----|
| 框架 | FastAPI |
| 数据库 | SQLite（`data/railway.db`） |
| 跨域 | 启用 CORS（`allow_origins=["*"]`） |
| 响应格式 | JSON |

所有端点返回的 JSON 中，日期时间格式统一为 `HH:MM`（如 `"08:30"`），不包含日期和秒。


### 1.2 GET /api/train（车次列表）

**功能**：返回所有 G 车次号列表，支持关键词搜索和分页。

**请求参数**（Query）：

| 参数名 | 类型 | 必填 | 默认值 | 说明 |
|--------|------|------|--------|------|
| `keyword` | string | 否 | 空字符串 | 按车次号模糊搜索，如 `G1` 匹配 G1、G10、G100 等 |
| `page` | int | 否 | 1 | 页码，≥1 |
| `limit` | int | 否 | 50 | 每页条数，1~200 |

**返回值**：

```json
{
  "total": 1500,
  "page": 1,
  "limit": 50,
  "total_pages": 30,
  "data": [
    { "train_num": "G1" },
    { "train_num": "G2" },
    { "train_num": "G4" }
  ]
}
```

**实现逻辑**：
- 如果 `keyword` 非空，执行 `WHERE train_num LIKE '%keyword%'`
- 查询 `trains` 表，按 `train_num` 排序
- 分页使用 `LIMIT offset, limit`，`offset = (page - 1) * limit`
- 同时执行 `COUNT(*)` 查询获取总数


### 1.3 GET /api/station（车站列表）

**功能**：返回所有车站列表（电报码 + 中文名），支持关键词搜索和分页。

**请求参数**（Query）：

| 参数名 | 类型 | 必填 | 默认值 | 说明 |
|--------|------|------|--------|------|
| `keyword` | string | 否 | 空字符串 | 按站名或电报码模糊搜索，如 `北京` 匹配所有含"北京"的车站 |
| `page` | int | 否 | 1 | 页码，≥1 |
| `limit` | int | 否 | 50 | 每页条数，1~200 |

**返回值**：

```json
{
  "total": 3000,
  "page": 1,
  "limit": 50,
  "total_pages": 60,
  "data": [
    { "station_id": "VNP", "station_name": "北京南" },
    { "station_id": "BXP", "station_name": "北京西" }
  ]
}
```

**实现逻辑**：
- 如果 `keyword` 非空：`WHERE station_name LIKE '%keyword%' OR station_id LIKE '%keyword%'`
- 查询 `stations` 表，按 `station_name` 排序
- 分页同上


### 1.4 GET /api/train/{train_num}（车次详情）

**功能**：返回指定车次的完整信息（含经停站列表）。

**路径参数**：

| 参数名 | 类型 | 说明 |
|--------|------|------|
| `train_num` | string | 车次号，如 `G1` |

**返回值**：

```json
{
  "train_num": "G1",
  "train_no": "240000G110",
  "stops": [
    { "stop_no": 1, "station_id": "VNP", "station_name": "北京南", "stop_time": "07:00" },
    { "stop_no": 2, "station_id": "JNK", "station_name": "济南西", "stop_time": "08:30" },
    { "stop_no": 3, "station_id": "NKG", "station_name": "南京南", "stop_time": "10:00" },
    { "stop_no": 4, "station_id": "AOH", "station_name": "上海虹桥", "stop_time": "11:30" }
  ]
}
```

**错误码**：

| HTTP 状态 | 返回内容 | 条件 |
|-----------|----------|------|
| 404 | `{"detail": "车次 G1 未找到"}` | `train_num` 不在 `trains` 表中 |

**实现逻辑**：
1. 查 `trains` 表验证 `train_num` 是否存在
2. 查 `train_stops` 表按 `stop_no` 排序获取所有经停站
3. `stop_time` 直接从表中读取（爬虫已按规则填充）
4. 返回 `train_no` 仅作为内部标识，可保留也可省略（不影响功能）


### 1.5 GET /api/station/{station_id}（车站详情）

**功能**：返回指定车站的经停车次列表（车站大屏）。

**路径参数**：

| 参数名 | 类型 | 说明 |
|--------|------|------|
| `station_id` | string | 车站电报码，如 `VNP` |

**返回值**：

```json
{
  "station_id": "VNP",
  "station_name": "北京南",
  "train_count": 150,
  "trains": [
    { "stop_num": "G1", "stop_time": "07:00" },
    { "stop_num": "G2", "stop_time": "07:15" },
    { "stop_num": "G3", "stop_time": "07:30" }
  ]
}
```

**排序规则**：按 `stop_num`（车次号）升序排序。数字部分按数值大小排序（G1 < G2 < G10），而非字典序（G1 < G10 < G2）。

**错误码**：

| HTTP 状态 | 返回内容 | 条件 |
|-----------|----------|------|
| 404 | `{"detail": "车站 VNP 未找到"}` | `station_id` 不在 `stations` 表中 |

**实现逻辑**：
1. 查 `stations` 表验证 `station_id` 是否存在
2. 查 `station_trains` 表读取 `data` 字段（JSON）
3. 解析 JSON 返回 `trains` 列表
4. 如果 `station_trains` 尚未物化（数据为空），从 `train_stops` 临时聚合生成（但生产环境中应在爬虫完成后一次性物化）


### 1.6 GET /api/train/{train_num}/ticket（余票查询）

**功能**：返回指定车次在当前题目下的余票数据。

**路径参数**：

| 参数名 | 类型 | 说明 |
|--------|------|------|
| `train_num` | string | 车次号，如 `G1` |

**请求参数**（Query）：

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `from_station_id` | string | 否 | 出发站电报码，不传则返回所有站对 |
| `to_station_id` | string | 否 | 到达站电报码，不传则返回所有站对 |
| `seat_types` | string | 否 | 逗号分隔，如 `class2,class1`，不传则返回全部三种 |

**隐式继承**：当前题目 ID（如 `q003`）由测试器在启动时设置，不在 API 参数中传递。实现方式：在工具函数内部从全局变量/上下文状态中读取 `current_question_id`。

**返回值**：

```json
{
  "train_num": "G1",
  "question_id": "q003",
  "tickets": {
    "class2": {
      "VNP|JNK": 5,
      "VNP|NKG": 0,
      "VNP|AOH": 12,
      "JNK|NKG": 3
    },
    "class1": {
      "VNP|JNK": 2,
      "VNP|NKG": 0,
      "VNP|AOH": 8,
      "JNK|NKG": 1
    },
    "class0": {
      "VNP|JNK": 0,
      "VNP|NKG": 0,
      "VNP|AOH": 3,
      "JNK|NKG": 0
    }
  }
}
```

**实现逻辑**：
1. 从全局状态读取 `current_question_id`
2. 连接 `question/{current_question_id}.db`
3. 查 `class2` / `class1` / `class0` 表
4. 如果指定了 `from_station_id` 和 `to_station_id`，只返回该站对
5. 如果指定了 `seat_types`，只返回指定类型
6. 返回的键格式为 `{from_station_id}|{to_station_id}`

**错误处理**：
- 如果 `current_question_id` 未设置 → 返回 `{"detail": "未选择题目"}`
- 如果 `question/{current_question_id}.db` 不存在 → 返回 `{"detail": "题目不存在"}`
- 如果 `train_num` 在题目数据库中无记录 → 返回空对象 `{}`


### 1.7 GET /api/routes（两站之间车次）

**功能**：查询同时经过出发站和到达站的所有车次，返回区间实际到发时间。

**请求参数**（Query）：

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `from_station_id` | string | 是 | 出发站电报码 |
| `to_station_id` | string | 是 | 到达站电报码 |

**返回值**：

```json
{
  "from_station_id": "JNK",
  "to_station_id": "NKG",
  "count": 3,
  "data": [
    {
      "train_num": "G1",
      "depart_time": "08:30",
      "arrive_time": "10:00",
      "duration": "01:30"
    },
    {
      "train_num": "G3",
      "depart_time": "09:00",
      "arrive_time": "10:30",
      "duration": "01:30"
    }
  ]
}
```

**重要设计原则**：返回值中的 `depart_time` 和 `arrive_time` 是**在出发站和到达站的实际时间**，不是整趟车的始发/终到时间。不返回整趟车的始发站/终到站/全程起止时间。

**实现逻辑**：

```sql
-- 伪代码，实际用 SQL JOIN
SELECT DISTINCT t.train_num,
    s1.stop_time AS depart_time,  -- 在 from_station_id 的 stop_time
    s2.stop_time AS arrive_time   -- 在 to_station_id 的 stop_time
FROM train_stops s1
JOIN train_stops s2 ON s1.train_num = s2.train_num
JOIN trains t ON t.train_num = s1.train_num
WHERE s1.station_id = '{from_station_id}'
  AND s2.station_id = '{to_station_id}'
  AND s1.stop_no < s2.stop_no  -- 出发站在到达站之前
ORDER BY s1.stop_time
```

`duration` 计算方式：`arrive_time - depart_time`（字符串时间差，格式 `HH:MM`）。

**错误码**：

| HTTP 状态 | 返回内容 | 条件 |
|-----------|----------|------|
| 400 | `{"detail": "缺少 from_station_id 或 to_station_id"}` | 参数缺失 |
| 404 | `{"detail": "未找到从 JNK 到 NKG 的车次"}` | 无结果 |


## 第二部分：OpenAI Tools 定义

### 2.1 格式标准

参考 [DeepSeek Tool Call 文档](https://api-docs.deepseek.com/zh-cn/guides/tool_calls)，使用 OpenAI 标准格式：

```json
{
  "type": "function",
  "function": {
    "name": "工具名称",
    "description": "工具描述（大模型据此判断何时调用）",
    "parameters": {
      "type": "object",
      "properties": {
        "参数名": {
          "type": "string | integer | array",
          "description": "参数描述",
          "enum": [...]  // 可选
        }
      },
      "required": ["必填参数"]
    }
  }
}
```

### 2.2 Tool 1：query_trains_between_stations

对应端点：`GET /api/routes`

```json
{
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
```


### 2.3 Tool 2：query_trains_at_station

对应端点：`GET /api/station/{station_id}`

```json
{
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
```


### 2.4 Tool 3：query_train_detail

对应端点：`GET /api/train/{train_num}`

```json
{
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
```


### 2.5 Tool 4：list_stations

对应端点：`GET /api/station`

```json
{
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
          "description": "每页返回数量，默认 50，最大 200",
          "default": 50
        },
        "page": {
          "type": "integer",
          "description": "页码，默认 1",
          "default": 1
        }
      },
      "required": []
    }
  }
}
```


### 2.6 Tool 5：list_trains

对应端点：`GET /api/train`

```json
{
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
          "description": "每页返回数量，默认 50，最大 200",
          "default": 50
        },
        "page": {
          "type": "integer",
          "description": "页码，默认 1",
          "default": 1
        }
      },
      "required": []
    }
  }
}
```


### 2.7 Tool 6：query_tickets

对应端点：`GET /api/train/{train_num}/ticket`

```json
{
  "type": "function",
  "function": {
    "name": "query_tickets",
    "description": "查询指定车次各站对之间的余票数量。三种座位类型：class2=二等座（经济型，价格较低），class1=一等座（更舒适，价格中等），class0=特等座（可躺，十分舒适，价格更高）。不指定 seat_types 则返回全部三种。不指定 from_station_id/to_station_id 则返回所有站对。",
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
```

**特别说明**：`seat_types` 参数的设计是为了让大模型可以按需查询，而非每次返回全部三种座位的数据，从而节省 token。


## 第三部分：工具注册与状态管理

### 3.1 工具列表

所有 6 个工具在启动时注册到工具列表：

```python
TOOLS = [
    query_trains_between_stations,
    query_trains_at_station,
    query_train_detail,
    list_stations,
    list_trains,
    query_tickets
]
```

### 3.2 当前题目状态管理（实现细节）

```python
# 全局状态（由测试器设置）
current_question_id = None  # 如 "q003"

def set_current_question(question_id: str):
    global current_question_id
    current_question_id = question_id

def get_current_question() -> str:
    if current_question_id is None:
        raise ValueError("未设置当前题目")
    return current_question_id
```

测试器在启动时调用 `set_current_question("q003")`，Tool 6 执行时调用 `get_current_question()` 获取当前题目 ID。

**状态生命周期**：
- 测试器启动 → 用户选择题目 → 调用 `set_current_question()`
- 测试器关闭 → 状态清空


## 第四部分：扩展性说明

如需新增工具，按以下步骤操作（代码级扩展，不额外设计接口）：

1. 在 `tools/` 目录下新建工具定义文件
2. 按 OpenAI 格式定义 `name`、`description`、`parameters`
3. 实现对应的后端查询函数
4. 在工具注册列表中新增该工具
5. 重启服务即可生效

无需修改已有工具定义或端点逻辑。


## 第五部分：与其他模块的接口约定

### 5.1 依赖 01_数据爬取与数据库设计.md

- 读取 `data/railway.db` 中的四张表（`trains`、`stations`、`train_stops`、`station_trains`）
- 读取 `question/qXXX.db` 中的三张余票表（`class0`、`class1`、`class2`）
- 所有数据库路径使用 01 文档中约定的路径

### 5.2 向 03_提示词设计.md 提供的接口

- 提供 6 个工具的名称和描述（供系统提示词中说明可用工具）
- 工具调用格式为 OpenAI 标准格式

### 5.3 向 05_测试器与测评器设计.md 提供的接口

- 提供所有工具的执行入口（函数调用）
- 提供 `set_current_question()` 接口用于设置当前题目
- 提供 `get_current_question()` 接口用于获取当前题目（内部使用）
