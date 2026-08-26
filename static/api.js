/**
 * API 客户端模块
 * 封装所有后端 API 调用
 */

const API = {
  // ============================================================
  // 基础数据查询
  // ============================================================

  /** 获取车次列表 */
  listTrains: async (keyword = '', page = 1, limit = 50) => {
    const params = new URLSearchParams({ keyword, page, limit });
    const resp = await fetch(`/api/train?${params}`);
    return resp.json();
  },

  /** 获取车站列表 */
  listStations: async (keyword = '', page = 1, limit = 50) => {
    const params = new URLSearchParams({ keyword, page, limit });
    const resp = await fetch(`/api/station?${params}`);
    return resp.json();
  },

  /** 获取随机车站 */
  getRandomStation: async () => {
    const resp = await fetch('/api/station/random');
    return resp.json();
  },

  /** 获取车次详情 */
  getTrainDetail: async (trainNum) => {
    const resp = await fetch(`/api/train/${trainNum}`);
    return resp.json();
  },

  /** 获取车站详情 */
  getStationDetail: async (stationId) => {
    const resp = await fetch(`/api/station/${stationId}`);
    return resp.json();
  },

  /** 查询两站之间车次 */
  getRoutes: async (fromStationId, toStationId) => {
    const params = new URLSearchParams({ from_station_id: fromStationId, to_station_id: toStationId });
    const resp = await fetch(`/api/routes?${params}`);
    return resp.json();
  },

  /** 查询余票 */
  getTickets: async (trainNum, fromStationId, toStationId, seatTypes, questionId) => {
    const params = new URLSearchParams();
    if (fromStationId) params.set('from_station_id', fromStationId);
    if (toStationId) params.set('to_station_id', toStationId);
    if (seatTypes) params.set('seat_types', seatTypes);
    if (questionId) params.set('question_id', questionId);
    const resp = await fetch(`/api/train/${trainNum}/ticket?${params}`);
    return resp.json();
  },

  // ============================================================
  // 出题器接口
  // ============================================================

  /** 更新余票（实时写入） */
  updateTicket: async (data) => {
    const resp = await fetch('/api/update_ticket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return resp.json();
  },

  /** 初始化题目车次余票（创建 DB + 全部置0） */
  initQuestionTrain: async (questionId, trainNum) => {
    const resp = await fetch('/api/question/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question_id: questionId, train_num: trainNum }),
    });
    return resp.json();
  },

  /** auto出题器生成题目 */
  autoGenerate: async (data) => {
    const resp = await fetch('/api/auto_generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return resp.json();
  },

  /** 确认生成自动出题 */
  confirmAutoGenerate: async (data) => {
    const resp = await fetch('/api/auto_generate/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return resp.json();
  },

  /** 清除自动出题预览缓存（重新出题用） */
  clearAutoGenerate: async (questionId) => {
    const resp = await fetch('/api/auto_generate/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question_id: questionId }),
    });
    return resp.json();
  },

  /** 换方案：不变第一程车，换中间站/换乘车次 */
  swapAutoGenerate: async (questionId) => {
    const resp = await fetch('/api/auto_generate/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question_id: questionId }),
    });
    return resp.json();
  },

  /** 从题目中删除指定车次 */
  deleteQuestionTrain: async (questionId, trainNum) => {
    const resp = await fetch(`/api/question/${encodeURIComponent(questionId)}/train/${encodeURIComponent(trainNum)}`, {
      method: 'DELETE',
    });
    return resp.json();
  },

  /** 标记题目完成 */
  completeQuestion: async (questionId) => {
    const resp = await fetch('/api/question/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question_id: questionId }),
    });
    return resp.json();
  },

  /** 检查题目是否存在 */
  questionExists: async (questionId) => {
    const resp = await fetch(`/api/question/${encodeURIComponent(questionId)}/exists`);
    return resp.json();
  },

  /** 获取题目列表 */
  getQuestionList: async (options = '') => {
    const params = new URLSearchParams();
    // 兼容旧用法：传入字符串表示 status_filter
    if (typeof options === 'string') {
      if (options) params.set('status_filter', options);
    } else {
      if (options.status) params.set('status_filter', options.status);
      if (options.source) params.set('source', options.source);
      if (options.type) params.set('type', options.type);
      if (options.keyword) params.set('keyword', options.keyword);
    }
    const resp = await fetch(`/api/question/list?${params}`);
    return resp.json();
  },

  // ============================================================
  // 测试器接口
  // ============================================================

  /** 发送对话消息（流式） */
  sendChatStream: (data, signal) => {
    return fetch('/api/test/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      signal,
    });
  },

  /** 发送对话消息（非流式，传统模式） */
  sendChat: async (data) => {
    const resp = await fetch('/api/test/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return resp.json();
  },

  /** 测试完成，保存记录 */
  testComplete: async (sessionId) => {
    const resp = await fetch('/api/test/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId }),
    });
    return resp.json();
  },

  /** 重置对话 */
  resetChat: async (sessionId = 'default') => {
    const resp = await fetch('/api/test/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId }),
    });
    return resp.json();
  },

  // ============================================================
  // 测评器接口
  // ============================================================

  /** 获取测试记录列表 */
  getTestRecords: async () => {
    const resp = await fetch('/api/test/records');
    return resp.json();
  },

  /** 加载测试记录 */
  loadTestRecord: async (filename) => {
    const resp = await fetch('/api/eval/load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename }),
    });
    return resp.json();
  },

  /** 代码核查：验证最终乘车方案与数据库是否一致 */
  verifyTickets: async (questionId, finalPlan) => {
    const resp = await fetch('/api/eval/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question_id: questionId, final_plan: finalPlan }),
    });
    return resp.json();
  },

  /** 测评完成，保存结果 */
  evalComplete: async (data) => {
    const resp = await fetch('/api/eval/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return resp.json();
  },

  /** 获取测评结果列表 */
  getEvalResults: async () => {
    const resp = await fetch('/api/eval/results');
    return resp.json();
  },

  // ============================================================
  // 统计接口
  // ============================================================

  /** 获取统计汇总 */
  getStatsSummary: async () => {
    const resp = await fetch('/api/stats/summary');
    return resp.json();
  },

  /** 导出 JSON 报告 */
  exportJsonReport: async () => {
    const resp = await fetch('/api/stats/export/json');
    return resp.json();
  },

  /** 导出 Markdown 报告 */
  exportMarkdownReport: async () => {
    const resp = await fetch('/api/stats/export/markdown');
    return resp.text();
  },

  // ============================================================
  // 批量出题接口
  // ============================================================

  /** 上传 1.xlsx 解析题目分布（返回可编辑分布表） */
  batchParseDistribution: async (file) => {
    const formData = new FormData();
    formData.append('file', file);
    const resp = await fetch('/api/batch/parse-distribution', {
      method: 'POST',
      body: formData,
    });
    return resp.json();
  },

  /** 上传 2.xlsx 解析到发站对 */
  batchParseStations: async (file) => {
    const formData = new FormData();
    formData.append('file', file);
    const resp = await fetch('/api/batch/parse-stations', {
      method: 'POST',
      body: formData,
    });
    return resp.json();
  },

  /** 启动批量出题（一键生成并直接落盘） */
  batchGenerate: async (payload) => {
    const resp = await fetch('/api/batch/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return resp.json();
  },

  /** 查询批量出题进度（单进度条状态） */
  batchStatus: async () => {
    const resp = await fetch('/api/batch/status');
    return resp.json();
  },

  /** 下载失败回执 xlsx（返回 Blob） */
  batchReport: async (reportData) => {
    const resp = await fetch('/api/batch/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reportData),
    });
    return resp.blob();
  },
};