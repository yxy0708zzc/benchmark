/**
 * 主应用逻辑模块
 * 处理导航、全局状态、各页面初始化
 */

// 评判标准 key → 中文标签（选择性题 metadata.criterion，单选必选）
const CRITERION_LABELS = {
  comprehensive: '综合考虑',
  fastest: '最快',
  cheapest: '最便宜',
  depart_latest: '出发最晚',
  arrive_earliest: '最早到达',
};

// 行为约束 key → 中文标签（选择性题 metadata.constraints，多选可选）
const CONSTRAINT_LABELS = {
  no_transfer: '不允许换乘',
  no_short_buy_extra: '不允许买短补长与额外购买',
};

const App = {
  /** 当前题目 ID */
  currentQuestionId: null,
  /** 会话 ID */
  sessionId: 'default',
  /** 对话历史 */
  messages: [],
  /** 出题页当前会话已加载的车次列表（仅出题模式使用） */
  loadedTrains: [],
  /** 题目 ID → 自然语言问法（nl_question）映射，用于加载题目时自动填充 */
  _questionNlMap: {},
  /** 当前加载的测评记录中的工具调用记录（结构化换乘方案） */
  _currentToolRecords: [],
  /** 编辑器前缀：出题=''，改题='edit-' */
  _editorPrefix: '',
  /** AbortController，用于中断流式请求 */
  _abortController: null,
  /** 聊天区是否自动滚动到底部（用户上翻时置 false） */
  _autoScroll: true,
  /** 初始化应用 */
  init: function() {
    // 模型/API 配置统一来自服务端 .env（前端不再存 localStorage）
    // 页面加载后立即更新模型状态显示（影响顶部栏和侧边栏）
    this._updateModelStatusDisplay();
    this._setupEventListeners();

    // 根据 URL 路径切换到对应页面
    const path = window.location.pathname;
    const pageMap = {
      '/': 'test',
      '/index.html': 'test',
      '/auto_question': 'auto-question',
      '/selective_question': 'selective-question',
      '/batch_question': 'batch-question',
      '/batch_nl_question': 'batch-nl-question',
      '/batch_test_question': 'batch-test-question',
      '/edit_question': 'edit-question',
      '/question_manager': 'question-manager',
      '/stats': 'stats',
      '/eval': 'eval',
    };
    const pageName = pageMap[path] || 'test';
    this._switchToPage(pageName, false);
  },

  /** 高亮当前导航项（按 data-page 匹配） */
  _highlightNav: function(pageName) {
    document.querySelectorAll('.nav-item').forEach(item => {
      item.classList.remove('active');
      if (item.dataset.page === pageName) {
        item.classList.add('active');
      }
    });
  },

  /** SPA 页面切换 */
  _switchToPage: function(pageName, updateUrl = true) {
    // 更新导航高亮
    this._highlightNav(pageName);

    // 隐藏所有页面，显示目标页面
    document.querySelectorAll('.page-section').forEach(section => {
      section.style.display = 'none';
    });
    const target = document.getElementById(`page-${pageName}`);
    if (target) {
      target.style.display = 'flex';
    }

    // 更新 URL（不刷新页面）
    if (updateUrl) {
      const urlMap = {
        'test': '/',
        'edit-question': '/edit_question',
        'auto-question': '/auto_question',
        'selective-question': '/selective_question',
        'batch-question': '/batch_question',
        'batch-nl-question': '/batch_nl_question',
        'batch-test-question': '/batch_test_question',
        'question-manager': '/question_manager',
        'stats': '/stats',
        'eval': '/eval',
      };
      const url = urlMap[pageName] || '/';
      window.history.pushState({ page: pageName }, '', url);
    }

    // 初始化对应页面
    // 延迟确保 DOM 可见后初始化
    setTimeout(() => {
      switch (pageName) {
        case 'test':
          this.initTester();
          break;
        case 'edit-question':
          this.initEditQuestion();
          break;
        case 'auto-question':
          this.initAutoQuestion();
          break;
        case 'selective-question':
          this.initSelectiveQuestion();
          break;
        case 'batch-question':
          this.initBatchQuestion();
          break;
        case 'batch-nl-question':
          this.initBatchNlQuestion();
          break;
        case 'batch-test-question':
          this.initBatchTestQuestion();
          break;
        case 'question-manager':
          this.initQuestionManager();
          break;
        case 'stats':
          this.initStats();
          break;
        case 'eval':
          this.initEval();
          break;
      }
    }, 50);
  },

  /** 设置全局事件监听 */
  _setupEventListeners: function() {
    // 回车发送消息
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        const input = e.target.closest('.chat-input');
        if (input) {
          e.preventDefault();
          this.sendMessage();
        }
      }
    });
  },

  // ============================================================
  // 测试器初始化
  // ============================================================
  initTester: function() {
    if (document.querySelector('#page-test')?.dataset.initialized) return;
    document.querySelector('#page-test').dataset.initialized = '1';

    API.resetChat(this.sessionId);
    const msgContainer = document.getElementById('chat-messages');
    if (msgContainer) msgContainer.innerHTML = '';

    // 重置自动滚动状态
    this._autoScroll = true;

    // 智能滚动：仅在用户接近底部时自动滚到底
    if (msgContainer) {
      msgContainer.addEventListener('scroll', () => {
        this._autoScroll = (msgContainer.scrollHeight - msgContainer.scrollTop - msgContainer.clientHeight) < 80;
      });
    }

    this._loadQuestionList();

    // 题目列表筛选事件
    ['q-filter-type'].forEach(id => {
      document.getElementById(id)?.addEventListener('change', () => this._loadQuestionList());
    });
    document.getElementById('q-filter-keyword')?.addEventListener('input', () => this._loadQuestionList());

    const sendBtn = document.getElementById('btn-send');
    if (sendBtn) sendBtn.onclick = () => this.sendMessage();

    const completeBtn = document.getElementById('btn-complete');
    if (completeBtn) completeBtn.onclick = () => this._onTestComplete();

    const resetBtn = document.getElementById('btn-reset');
    if (resetBtn) resetBtn.onclick = () => this._onResetChat();

    const loadBtn = document.getElementById('btn-load-question');
    if (loadBtn) loadBtn.onclick = () => this._onLoadQuestion();

    this._updateModelStatusDisplay();
  },

  /** 更新模型连接状态显示（模型配置来自服务端 .env） */
  _updateModelStatusDisplay: function() {
    document.querySelectorAll('.test-model-status').forEach(el => {
      el.textContent = '● .env 配置';
      el.style.color = '#22c55e';
    });
  },

  /** 题号排序：后端 /api/question/list 已按统一自然序排好，前端不再二次排序（避免双份逻辑漂移） */
  _sortQuestionsByQid: function(questions) {
    return questions;
  },

  /** 加载题目列表 */
  _loadQuestionList: async function() {
    const container = document.getElementById('question-list');
    if (!container) return;

    // 读取筛选条件
    const type = document.getElementById('q-filter-type')?.value || '';
    const keyword = document.getElementById('q-filter-keyword')?.value.trim() || '';

    try {
      const data = await API.getQuestionList({ status: 'completed', type, keyword });
      const sorted = this._sortQuestionsByQid(data.questions);
      // 保留列表滚动位置（避免刷新/筛选后跳到顶部或底部）
      const prevScroll = container.scrollTop;
      // 记录每题的填充文本（优先 nl_question，其次原始 question），供加载题目时自动填充
      this._questionNlMap = {};
      sorted.forEach(q => { this._questionNlMap[q.question_id] = q.nl_question || q.question || ''; });
      let html = '';
      sorted.forEach(q => {
        const typeTag = q.type || '';
        const qtypeTag = q.question_type ? this._questionTypeLabel(q.question_type) : '';
        const modeTag = typeTag ? `<span class="tag" style="background:${typeTag === '选择性' ? '#f5f3ff' : '#eff6ff'};color:${typeTag === '选择性' ? '#7c3aed' : '#2563eb'};border-radius:8px">${typeTag}</span>` : '';
        html += `<div class="question-item" data-qid="${q.question_id}" onclick="App._selectQuestion(this)">
          <input type="radio" name="question" value="${q.question_id}" id="q_${q.question_id}">
          <label for="q_${q.question_id}">${q.question_id} ${qtypeTag ? `<span class="tag tag-secondary">${qtypeTag}</span>` : ''}${modeTag}
            <span style="font-size:var(--font-size-small);color:var(--gray-4)">${q.train_count}列车次</span>
          </label>
        </div>`;
      });
      container.innerHTML = html || '<div style="color:var(--gray-4);padding:12px">暂无符合条件的题目</div>';
      container.scrollTop = prevScroll;
    } catch (e) {
      container.innerHTML = '<div style="color:var(--error-red)">加载题目列表失败</div>';
    }
  },

  /** 选择题目 */
  _selectQuestion: function(el) {
    document.querySelectorAll('.question-item').forEach(item => item.classList.remove('selected'));
    el.classList.add('selected');
    const radio = el.querySelector('input[type="radio"]');
    if (radio) radio.checked = true;
  },

  /** 加载选中题目 */
  _onLoadQuestion: function() {
    const selected = document.querySelector('.question-item.selected');
    if (!selected) {
      alert('请先选择一个题目');
      return;
    }
    const qid = selected.dataset.qid;
    this.currentQuestionId = qid;
    document.getElementById('current-question').textContent = qid;

    // 自动填充：优先自然语言问法（nl_question），其次原始题面（question），都没有则清空输入框
    const nl = this._questionNlMap[qid] || '';
    const input = document.getElementById('chat-input');
    if (input) input.value = nl;

    // 重置对话
    this._onResetChat();
  },

  /** 随机选站：随机获取一个车站填入指定输入框 */
  _randomStation: async function(inputId) {
    try {
      const data = await API.getRandomStation();
      const input = document.getElementById(inputId);
      if (input && data && data.station_name) {
        input.value = data.station_name;
      }
    } catch (e) {
      console.error('随机选站失败:', e);
    }
  },

  /** 发送消息（流式） */
  sendMessage: async function() {
    const input = document.getElementById('chat-input');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';

    // 如果已有正在进行的请求，先中止
    if (this._abortController) {
      this._abortController.abort();
    }
    this._abortController = new AbortController();
    const signal = this._abortController.signal;

    // 添加用户消息（发送时必然在底部，恢复自动滚动）
    this._autoScroll = true;
    this._appendMessage('user', text);

    // 禁用发送按钮
    const sendBtn = document.getElementById('btn-send');
    if (sendBtn) sendBtn.disabled = true;

    // 添加占位符助手消息
    const container = document.getElementById('chat-messages');
    const placeholderHtml = Components.renderMessage('assistant', '<span style="color:var(--gray-4)">思考中...</span>', [], '');
    container.insertAdjacentHTML('beforeend', placeholderHtml);
    this._scrollChatToBottom();

    let fullContent = '';
    let fullReasoning = '';
    let toolCallsList = [];

    /** 更新最后一条助手消息的显示内容（保留展开/折叠状态）
     *  plain=true：流式期间纯文本渲染；plain=false：完成后用 marked 渲染 Markdown */
    const updateMsg = (cursor = false, plain = true) => {
      const displayContent = fullContent + (cursor ? '<span style="color:var(--gray-4)">▌</span>' : '');
      const lastMsg = container.lastElementChild;

      // 保存当前 details 展开/折叠状态
      let savedDetailsStates = [];
      if (lastMsg && lastMsg.classList.contains('message-assistant')) {
        lastMsg.querySelectorAll('details').forEach(d => savedDetailsStates.push(d.open));
      }

      const html = Components.renderMessage('assistant', displayContent || ' ', toolCallsList, fullReasoning, plain);

      if (lastMsg && lastMsg.classList.contains('message-assistant')) {
        // 先替换为新的 outerHTML
        lastMsg.outerHTML = html;
        // 恢复 details 展开/折叠状态
        if (savedDetailsStates.length > 0) {
          const newMsg = container.lastElementChild;
          const newDetails = newMsg.querySelectorAll('details');
          newDetails.forEach((d, i) => {
            if (i < savedDetailsStates.length) {
              d.open = savedDetailsStates[i];
            }
          });
        }
      } else {
        container.insertAdjacentHTML('beforeend', html);
      }
      this._scrollChatToBottom();
    };

    let doneCalled = false;

    try {
      const maxIter = parseInt(document.getElementById('max-iterations')?.value, 10) || 100;
      const response = await API.sendChatStream({
        message: text,
        // 模型/API 配置由服务端 .env 提供（前端不再存 localStorage）
        model_name: '',
        api_key: '',
        api_base_url: '',
        question_id: this.currentQuestionId || '',
        session_id: this.sessionId,
        max_iterations: maxIter,
      }, signal);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const evt = JSON.parse(line.slice(6));

            switch (evt.type) {
              case 'reasoning':
                fullReasoning += evt.content || '';
                break;

              case 'token':
                fullContent += evt.content || '';
                updateMsg(true, true);  // 显示光标（纯文本）
                break;

              case 'tool_call':
                if (evt.tool_calls) {
                  for (const [name, argsStr] of evt.tool_calls) {
                    let args = {};
                    try { args = JSON.parse(argsStr); } catch (e) {}
                    toolCallsList.push({ tool_name: name, arguments: args, result: {}, _pending: true });
                  }
                }
                updateMsg(false, true);
                break;

              case 'tool_result':
                // 工具已执行完毕，更新对应工具调用的结果用于显示
                if (evt.tool_name) {
                  // 按添加顺序找到第一个 pending 的匹配工具调用
                  for (let i = 0; i < toolCallsList.length; i++) {
                    if (toolCallsList[i].tool_name === evt.tool_name && toolCallsList[i]._pending) {
                      toolCallsList[i].result = evt.result;
                      toolCallsList[i]._pending = false;
                      break;
                    }
                  }
                }
                updateMsg(false, true);
                break;

              case 'done':
                // 前端已通过 token 事件累加完整内容，不再用 evt.content 覆盖
                doneCalled = true;
                updateMsg(false, false);  // 移除光标，最终用 marked 渲染
                break;

              case 'error':
                fullContent = '错误: ' + (evt.content || '未知错误');
                toolCallsList = [];
                updateMsg(false, true);
                doneCalled = true;
                break;
            }
          } catch (e) {
            console.error('SSE parse error:', e);
          }
        }
      }
    } catch (e) {
      if (e.name === 'AbortError') {
        // 用户中止，不做任何提示
        return;
      }
      if (!doneCalled) {
        fullContent = `请求失败: ${e.message}`;
        toolCallsList = [];
        fullReasoning = '';
        updateMsg(false, true);
      }
    } finally {
      if (sendBtn) sendBtn.disabled = false;
    }
  },

  /** 追加消息到对话界面 */
  _appendMessage: function(role, content, toolCalls = [], reasoning = '') {
    const container = document.getElementById('chat-messages');
    if (!container) return;

    const html = Components.renderMessage(role, content, toolCalls, reasoning);
    container.insertAdjacentHTML('beforeend', html);
    this._scrollChatToBottom();
  },

  /** 仅当用户接近底部时自动滚动到聊天区底部 */
  _scrollChatToBottom: function() {
    if (!this._autoScroll) return;
    const container = document.getElementById('chat-messages');
    if (container) container.scrollTop = container.scrollHeight;
  },

  /** 测试完成 */
  _onTestComplete: async function() {
    if (!confirm('确认测试完成？这将保存当前对话记录。')) return;

    try {
      const result = await API.testComplete(this.sessionId);
      if (!result.success) {
        alert(`保存失败: ${result.detail || '未知错误'}`);
        return;
      }

      // 构建结构化的结果信息
      let summaryParts = [];
      
      // token 用量
      const tu = result.token_usage || {};
      summaryParts.push(`Token: ${tu.total_tokens || 0} (输入 ${tu.prompt_tokens || 0} / 输出 ${tu.completion_tokens || 0})`);
      
      // 运行时间
      const dur = result.duration || 0;
      summaryParts.push(`耗时: ${(typeof dur === 'number' ? dur.toFixed(1) : dur)}s`);

      // 最终乘车方案
      const finalPlan = result.final_plan || [];
      let planStr = '';
      if (finalPlan.length > 0) {
        planStr = '\n\n🎫 最终乘车方案：\n';
        finalPlan.forEach((t, i) => {
          planStr += `  ${i+1}. ${t.train_num} ${t.seat_type} | ${t.from_station_id} → ${t.to_station_id} | ${t.tickets}张\n`;
        });
      } else {
        planStr = '\n\n⚠️ 未检测到最终乘车方案（模型可能未调用余票查询工具）';
      }

      alert(`✅ 测试记录已保存: ${result.message}\n\n${summaryParts.join(' | ')}${planStr}\n\n💡 详细测评（代码核查、意图完成率等）请在"测评"页面查看。`);
    } catch (e) {
      alert(`保存失败: ${e.message}`);
    }
  },

  /** 重置对话 */
  _onResetChat: async function() {
    // 中止正在进行的流式请求
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
    // 重置自动滚动
    this._autoScroll = true;
    try {
      await API.resetChat(this.sessionId);
      const container = document.getElementById('chat-messages');
      if (container) container.innerHTML = '';
    } catch (e) {
      console.error('重置对话失败:', e);
    }
  },

  // ============================================================
  // 改题器初始化
  // ============================================================
  initEditQuestion: function() {
    // 确保前缀正确（可能被其他页面覆盖）
    this._editorPrefix = 'edit-';
    this._initQuestionEditor('edit');
    // 每次进入改题页都刷新下拉列表（确保新创建的题目可见）
    this._loadEditQuestionOptions();

    // 车次输入框回车触发加载
    const trainInput = document.getElementById('edit-train-input');
    if (trainInput) {
      trainInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          document.getElementById('edit-btn-load-train')?.click();
        }
      });
    }
  },

  /** 刷新改题页题目下拉（只刷新列表，不影响其他） */
  _loadEditQuestionOptions: function() {
    const select = document.getElementById('edit-question-select');
    if (!select) return;
    select.innerHTML = '<option value="">-- 选择题目 --</option>';
    API.getQuestionList().then(data => {
      const sorted = this._sortQuestionsByQid(data.questions);
      sorted.forEach(q => {
        const opt = document.createElement('option');
        opt.value = q.question_id;
        opt.textContent = `${q.question_id} (${q.status})`;
        // 如果之前已选中某个题目且该题仍存在，恢复选中
        if (this.currentQuestionId && q.question_id === this.currentQuestionId) {
          opt.selected = true;
        }
        select.appendChild(opt);
      });
    }).catch(() => {});
  },

  /** 通用出题/改题编辑器初始化 */
  _initQuestionEditor: function(mode) {
    this._editorPrefix = mode === 'edit' ? 'edit-' : '';
    const P = this._editorPrefix;

    // 绑定"加载题目"按钮（改题器专用）
    if (mode === 'edit') {
      const loadQBtn = document.getElementById(P + 'btn-load-question');
      if (loadQBtn) {
        loadQBtn.onclick = () => this._loadEditQuestion();
      }
    }

    // 绑定加载车次按钮
    const loadBtn = document.getElementById(P + 'btn-load-train');
    if (loadBtn) {
      loadBtn.onclick = () => this._loadTrainForEditor(mode);
    }

    // 绑定随机填充按钮
    const randomBtn = document.getElementById(P + 'btn-random-fill');
    if (randomBtn) {
      randomBtn.onclick = () => this._randomFillCurrentTrain();
    }

    // 绑定保存按钮
    const saveBtn = document.getElementById(P + 'btn-save');
    if (saveBtn) {
      saveBtn.onclick = () => this._saveQuestion();
    }
  },

  /** 加载已选题目（改题器专用）：更新当前题号、已填车次列表 */
  _loadEditQuestion: async function() {
    const P = this._editorPrefix;
    const select = document.getElementById(P + 'question-select');
    if (!select || !select.value) {
      alert('请先选择一个题目');
      return;
    }
    const qid = select.value;
    this.currentQuestionId = qid;
    document.getElementById(P + 'current-question').textContent = qid;
    document.getElementById(P + 'current-train').textContent = '-';
    // 清空矩阵
    const mc = document.getElementById(P + 'matrix-container');
    if (mc) mc.innerHTML = '<div style="text-align:center;color:var(--gray-4);padding:40px">请先输入车次号并点击"加载车次"</div>';
    // 加载已填车次列表
    await this._updateFilledTrains(qid);
  },

  /** 加载车次进行编辑 */
  _loadTrainForEditor: async function(mode) {
    const P = this._editorPrefix;

    const trainNum = document.getElementById(P + 'train-input')?.value.trim();
    if (!trainNum) {
      alert('请输入车次号');
      return;
    }
    const isEdit = mode === 'edit';

    // 获取题目 ID
    let questionId;
    if (mode === 'edit') {
      questionId = document.getElementById(P + 'question-select')?.value;
    } else {
      questionId = document.getElementById('question-id-input')?.value.trim() || 'q001';
    }
    if (!questionId) {
      alert('请选择或输入题目编号');
      return;
    }

    this.currentQuestionId = questionId;

    try {
      // 获取车次详情
      const detail = await API.getTrainDetail(trainNum);
      if (detail.detail) {
        alert(detail.detail);
        return;
      }

      // ① 每次加载车次都调用 API（确保车次加入 metadata，幂等操作）
      const initResult = await API.initQuestionTrain(questionId, trainNum);
      if (!initResult.success) {
        alert(`初始化失败: ${initResult.detail || '未知错误'}`);
        return;
      }

      // 渲染半矩阵
      const container = document.getElementById(P + 'matrix-container');
      if (!container) return;

      const seatType = document.getElementById(P + 'seat-type-select')?.value || 'class2';

      // ② 从题目数据库读取余票（含刚才初始化的全0记录和已有的非0值）
      let ticketsData = {};
      try {
        const tickets = await API.getTickets(trainNum, null, null, null, questionId);
        if (tickets.tickets && tickets.tickets[seatType]) {
          ticketsData = tickets.tickets[seatType];
        }
      } catch (e) {
        console.warn('读取余票失败，使用空数据', e);
      }

      // ③ 确保所有站对在数据中都有值，防止空字典导致显示空白
      for (let i = 0; i < detail.stops.length; i++) {
        for (let j = i + 1; j < detail.stops.length; j++) {
          const key = `${detail.stops[i].station_id}|${detail.stops[j].station_id}`;
          if (ticketsData[key] === undefined) {
            ticketsData[key] = 0;
          }
        }
      }

      const html = Components.renderMatrixTable(
        detail.stops, ticketsData, trainNum, questionId, seatType,
        null, false
      );

      container.innerHTML = html;

      // 更新信息
      document.getElementById(P + 'current-train').textContent = trainNum;
      document.getElementById(P + 'current-question').textContent = questionId;

      // 更新已填车次列表
      // 出题模式：添加到本地已加载列表
      if (!isEdit) {
        if (!this.loadedTrains.includes(trainNum)) {
          this.loadedTrains.push(trainNum);
        }
      }
      this._updateFilledTrains(questionId);

    } catch (e) {
      alert(`加载失败: ${e.message}`);
    }
  },

  /** 随机填充当前车次 */
  _randomFillCurrentTrain: async function() {
    const P = this._editorPrefix;
    const trainNum = document.getElementById(P + 'current-train')?.textContent;
    if (!trainNum || trainNum === '-') {
      alert('请先加载车次');
      return;
    }

    try {
      const detail = await API.getTrainDetail(trainNum);
      const stops = detail.stops;
      const questionId = this.currentQuestionId;
      const seatType = document.getElementById(P + 'seat-type-select')?.value || 'class2';

      // 遍历所有站对
      for (let i = 0; i < stops.length; i++) {
        for (let j = i + 1; j < stops.length; j++) {
          const tickets = Math.floor(Math.random() * 31);
          await API.updateTicket({
            question_id: questionId,
            train_num: trainNum,
            from_station_id: stops[i].station_id,
            to_station_id: stops[j].station_id,
            seat_type: seatType,
            tickets: tickets,
          });
        }
      }

      // 刷新矩阵（改题模式）
      await this._loadTrainForEditor('edit');
    } catch (e) {
      alert(`随机填充失败: ${e.message}`);
    }
  },

  /** 更新已填车次列表（可点击跳转） */
  _updateFilledTrains: async function(questionId) {
    const P = this._editorPrefix;
    const container = document.getElementById(P + 'filled-trains');
    if (!container) return;

    // 合并本地已加载列表 + API查询到的车次列表
    let allTrains = [];

    // 1) 从 API 查询 metadata 中已存储的车次
    try {
      const resp = await fetch(`/api/question/${encodeURIComponent(questionId)}/trains`);
      if (resp.ok) {
        const data = await resp.json();
        if (data.trains && data.trains.length > 0) {
          allTrains = data.trains.map(t => t.train_num);
        }
      }
    } catch (e) {
      // API 查询失败时忽略
    }

    // 2) 合并本地已加载车次
    if (this.loadedTrains && this.loadedTrains.length > 0) {
      this.loadedTrains.forEach(tn => {
        if (!allTrains.includes(tn)) {
          allTrains.push(tn);
        }
      });
    }

    if (allTrains.length > 0) {
      this._renderFilledTrainList(container, allTrains.map(t => ({ train_num: t })));
    } else {
      container.innerHTML = '<div style="color:var(--gray-4)">暂无机车</div>';
    }
  },

  /** 渲染已填车次列表 */
  _renderFilledTrainList: function(container, trains) {
    const P = this._editorPrefix;
    let html = '';
    trains.forEach(t => {
      html += `<div class="filled-train-item" data-train="${t.train_num}" style="display:flex;align-items:center;justify-content:space-between;padding:4px 8px;font-size:var(--font-size-small);cursor:pointer;border-radius:4px;transition:background 0.15s">
        <span>${t.train_num}</span>
        <span class="delete-train-btn" data-train="${t.train_num}" style="color:var(--error-red);cursor:pointer;font-size:12px;padding:0 4px;display:none" title="删除此车次">✕</span>
      </div>`;
    });
    container.innerHTML = html;

    // 绑定点击事件：点击车次跳转到该车次的编辑矩阵
    container.querySelectorAll('.filled-train-item').forEach(el => {
      const deleteBtn = el.querySelector('.delete-train-btn');
      el.addEventListener('click', (e) => {
        if (e.target.closest('.delete-train-btn')) return; // 点击删除按钮时不跳转
        const tn = el.dataset.train;
        document.getElementById(P + 'train-input').value = tn;
        this._loadTrainForEditor('edit');
      });
      // 悬浮显示删除按钮
      el.addEventListener('mouseenter', () => {
        el.style.background = 'var(--gray-1)';
        if (deleteBtn) deleteBtn.style.display = 'inline';
      });
      el.addEventListener('mouseleave', () => {
        el.style.background = 'transparent';
        if (deleteBtn) deleteBtn.style.display = 'none';
      });
    });

    // 绑定删除按钮事件
    container.querySelectorAll('.delete-train-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const tn = btn.dataset.train;
        const qid = this.currentQuestionId;
        if (!qid || !tn) return;
        if (!confirm(`确认从题目 ${qid} 中删除车次 ${tn}？\n该车次的所有余票数据将被清除。`)) return;
        try {
          const result = await API.deleteQuestionTrain(qid, tn);
          if (!result.success) {
            alert(`删除失败: ${result.detail || '未知错误'}`);
            return;
          }
          // 刷新已填车次列表
          await this._updateFilledTrains(qid);
          // 如果当前编辑的车次正是被删除的，清空矩阵
          const currentTrainEl = document.getElementById(P + 'current-train');
          if (currentTrainEl && currentTrainEl.textContent === tn) {
            currentTrainEl.textContent = '-';
            const mc = document.getElementById(P + 'matrix-container');
            if (mc) mc.innerHTML = '<div style="text-align:center;color:var(--gray-4);padding:40px">车次已删除，请选择其他车次</div>';
          }
        } catch (e) {
          alert(`删除失败: ${e.message}`);
        }
      });
    });
  },

  /** 保存题目（出题页自动创建新题，改题页仅标记完成） */
  _saveQuestion: async function() {
    // 优先使用 currentQuestionId，若为 null 则从输入框读取（解决 blur 异步未完成时的竞态问题）
    let qid = this.currentQuestionId;
    const P = this._editorPrefix;
    if (!qid) {
      if (P === 'edit') {
        qid = document.getElementById(P + 'question-select')?.value;
      } else {
        qid = document.getElementById('question-id-input')?.value.trim();
      }
      if (!qid) {
        alert('请先输入题目编号');
        return;
      }
      this.currentQuestionId = qid;
    }

    const isEdit = !!document.getElementById(P + 'question-select');
    const confirmMsg = isEdit
      ? `确认将题目 ${qid} 标记为已完成？`
      : `确认保存题目 ${qid}？保存后自动创建新题目。`;
    if (confirm(confirmMsg)) {
      try {
        const result = await API.completeQuestion(qid);
        if (!result.success) {
          alert(`保存失败: ${result.detail || '未知错误'}`);
          return;
        }
      } catch (e) {
        alert(`保存失败: ${e.message}`);
        return;
      }
      if (isEdit) {
        alert(`题目 ${qid} 已标记为完成`);
      } else {
        // 出题页：保存成功后自动重置为新题目
        this._resetForNewQuestion();
      }
    }
  },

  /** 重置界面为新题目（清空输入，等待用户输入新题号） */
  _resetForNewQuestion: function() {
    const qidInput = document.getElementById('question-id-input');
    if (qidInput) {
      qidInput.value = '';
      // 清除上次检查记录，让 blur 能重新检查
      delete qidInput.dataset.lastChecked;
    }
    // 清除本地已加载车次列表
    this.loadedTrains = [];
    document.getElementById('current-question').textContent = '-';
    document.getElementById('current-train').textContent = '-';
    document.getElementById('train-input').value = '';
    document.getElementById('matrix-container').innerHTML =
      '<div style="text-align:center;color:var(--gray-4);padding:40px">请先输入题目编号，再输入车次号加载</div>';
    document.getElementById('filled-trains').innerHTML =
      '<div style="color:var(--gray-4)">请输入题目编号</div>';

    this.currentQuestionId = null;
  },

  // ============================================================
  // auto出题器初始化
  // ============================================================
  initAutoQuestion: function() {
    // 每次进入该页：需求人数随机 3~6
    this._randomPeopleInto('auto-people-count');
    const generateBtn = document.getElementById('btn-generate');
    if (generateBtn) {
      generateBtn.onclick = () => this._onAutoGenerate();
    }

    const confirmBtn = document.getElementById('btn-confirm-generate');
    if (confirmBtn) {
      confirmBtn.onclick = () => this._confirmAutoGenerate();
    }

    const regenerateBtn = document.getElementById('btn-regenerate');
    if (regenerateBtn) {
      regenerateBtn.onclick = () => this._reAutoGenerate();
    }

    const swapBtn = document.getElementById('btn-swap');
    if (swapBtn) {
      swapBtn.onclick = () => this._swapAutoSolution();
    }

    // 题型切换时显示/隐藏混合配置
    const typeSelect = document.getElementById('question-type');
    if (typeSelect) {
      typeSelect.onchange = function() {
        const mixedConfig = document.getElementById('mixed-config');
        if (mixedConfig) {
          const show = this.value === 'mixed';
          mixedConfig.style.display = show ? 'block' : 'none';
          if (show) App._renderSegmentPlans('auto');
        }
      };
    }

    // 换乘次数变化时重新渲染段方案
    document.addEventListener('change', function(e) {
      if (e.target.id === 'auto-mixed-transfers') {
        App._renderSegmentPlans('auto');
      }
    });

    // 出发站/到达站输入框回车触发生成
    ['auto-from-station', 'auto-to-station'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            document.getElementById('btn-generate')?.click();
          }
        });
      }
    });

    // 伪干扰密度滑块联动
    const aiDensitySlider = document.getElementById('auto-interference-density');
    const aiDensityLabel = document.getElementById('auto-interference-density-label');
    if (aiDensitySlider && aiDensityLabel) {
      aiDensitySlider.oninput = function() {
        aiDensityLabel.textContent = parseFloat((this.value * 100).toFixed(3)) + '%';
      };
    }
    // 伪干扰开关：关闭时淡化密度配置
    const aiCheckbox = document.getElementById('auto-fake-interference');
    if (aiCheckbox) {
      aiCheckbox.onchange = function() {
        const cfg = document.getElementById('auto-fake-interference-config');
        if (cfg) cfg.style.opacity = this.checked ? '1' : '0.4';
      };
    }
  },

  /** 渲染混合题段方案下拉框 */
  _renderSegmentPlans: function(prefix) {
    const transfers = parseInt(document.getElementById(prefix + '-mixed-transfers')?.value || '1', 10);
    const container = document.getElementById(prefix + '-mixed-segment-plans');
    if (!container) return;
    const plans = ['direct', 'short_buy', 'extra_front', 'extra_rear'];
    const labels = {direct: '直达', short_buy: '买短补长', extra_front: '额外(前)', extra_rear: '额外(后)'};
    let html = '';
    for (let i = 0; i <= transfers; i++) {
      html += `<div><label style="font-weight:500;font-size:12px">段 ${i+1} 方案:</label>
        <select class="select" id="${prefix}-seg-${i}" style="margin-left:8px">`;
      plans.forEach(p => {
        html += `<option value="${p}">${labels[p]}</option>`;
      });
      html += '</select></div>';
    }
    container.innerHTML = html;
  },

  /** auto出题 */
  _onAutoGenerate: async function() {
    const form = {
      question_type: document.getElementById('question-type')?.value || 'direct',
      mode: 'existence',
      from_station_id: document.getElementById('auto-from-station')?.value.trim(),
      to_station_id: document.getElementById('auto-to-station')?.value.trim(),
      people_count: parseInt(document.getElementById('auto-people-count')?.value || '2', 10),
      seat_type: document.getElementById('auto-seat-type')?.value || 'class2',
      random_tickets: document.getElementById('auto-fake-interference')?.checked ?? true,
      fake_interference: document.getElementById('auto-fake-interference')?.checked ?? true,
      interference_density: parseFloat(document.getElementById('auto-interference-density')?.value || '0.02'),
      custom_qid: document.getElementById('output-qid')?.value.trim() || '',
    };

    // 题目名必填
    if (!form.custom_qid) {
      alert('请填写题目名');
      return;
    }

    // 混合题型
    if (form.question_type === 'mixed') {
      form.transfers = parseInt(document.getElementById('auto-mixed-transfers')?.value || '1', 10);
      form.segment_plans = [];
      for (let i = 0; i <= form.transfers; i++) {
        const sel = document.getElementById('auto-seg-' + i);
        form.segment_plans.push(sel ? sel.value : 'direct');
      }
      if (form.transfers < 1) {
        alert('换乘数至少为 1');
        return;
      }
    }

    if (!form.from_station_id || !form.to_station_id) {
      alert('请填写出发站和到达站电报码');
      return;
    }

    const previewContainer = document.getElementById('preview-container');
    if (previewContainer) {
      previewContainer.innerHTML = '<div style="padding:20px;text-align:center;color:var(--gray-4)">正在生成...</div>';
    }

    try {
      const result = await API.autoGenerate(form);
      if (result.success) {
        this._showAutoPreview(result);
      } else {
        alert(`生成失败: ${result.detail || '未知错误'}`);
        if (previewContainer) previewContainer.innerHTML = '';
      }
    } catch (e) {
      alert(`生成失败: ${e.message}`);
      if (previewContainer) previewContainer.innerHTML = '';
    }
  },

  /** 显示 auto 出题预览（存在性自动出两份：0_无伪干扰 / 1_有伪干扰） */
  _showAutoPreview: function(data) {
    const container = document.getElementById('preview-container');
    if (!container) return;

    const questions = data.questions || [];
    if (questions.length === 0) return;

    // 每份题渲染一张卡片
    const cardsHtml = questions.map(q => {
      const preview = q.preview || {};
      const qid = q.question_id || '';
      const isFake = qid.startsWith('1_');
      const modeLabel = isFake ? '有伪干扰' : '无伪干扰';
      const modeColor = isFake ? '#7c3aed' : '#2563eb';

      let pathsHtml = '';
      if (preview.solution_segments && preview.solution_segments.length > 0) {
        preview.solution_segments.forEach(seg => {
          pathsHtml += `<div>✅ ${seg.train_num}: ${seg.from}→${seg.to} (${seg.tickets}张 ${seg.seat_type})</div>`;
        });
      }
      const pathDesc = preview.path_description || '';

      return `
      <div class="card">
        <div class="card-header">${qid} <span class="tag" style="background:#f5f3ff;color:${modeColor};border-radius:8px">${modeLabel}</span></div>
        <div style="display:flex;flex-direction:column;gap:12px">
          <div><strong>题型：</strong>${preview.question_type}</div>
          <div><strong>需求人数：</strong>${document.getElementById('auto-people-count')?.value || '2'} 人</div>
          <div><strong>答案票等级：</strong>${document.getElementById('auto-seat-type')?.value || 'class2'}</div>
          <div><strong>目标区间：</strong>${preview.target_section}</div>
          <div><strong>路径描述：</strong>${pathDesc}</div>
          <div><strong>合法路径（有票段）：</strong></div>
          <div style="padding-left:20px">${pathsHtml || '<div style="color:var(--gray-4)">无</div>'}</div>
          <div style="color:var(--success-green);font-weight:600">✅ 有合法解</div>
        </div>
      </div>`;
    }).join('<div style="height:12px"></div>');

    container.innerHTML = cardsHtml;

    // 显示确认按钮和重新出题按钮（存所有题名，确认时循环保存）
    const confirmBtn = document.getElementById('btn-confirm-generate');
    if (confirmBtn) {
      confirmBtn.style.display = 'inline-flex';
      confirmBtn.dataset.questionIds = questions.map(q => q.question_id).join(',');
      confirmBtn.dataset.questionType = (questions[0].preview || {}).question_type || '';
      confirmBtn.dataset.answer = (questions[0].preview || {}).path_description || '';
    }
    const reBtn = document.getElementById('btn-regenerate');
    if (reBtn) {
      reBtn.style.display = 'inline-flex';
      reBtn.dataset.questionIds = questions.map(q => q.question_id).join(',');
    }
    const swapBtn = document.getElementById('btn-swap');
    if (swapBtn) {
      const qtype = (questions[0].preview || {}).question_type;
      const isSwapable = qtype === 'transfer' || qtype === 'mixed';
      swapBtn.style.display = isSwapable ? 'inline-flex' : 'none';
      if (isSwapable) swapBtn.dataset.questionIds = questions.map(q => q.question_id).join(',');
    }
  },

  /** 确认生成 */
  _confirmAutoGenerate: async function() {
    const confirmBtn = document.getElementById('btn-confirm-generate');
    if (!confirmBtn || !confirmBtn.dataset.questionIds) return;

    // 存在性一次出两份（0_无伪干扰 / 1_有伪干扰），循环确认保存
    const questionIds = (confirmBtn.dataset.questionIds || '').split(',').filter(Boolean);
    for (const questionId of questionIds) {
      try {
        const result = await API.confirmAutoGenerate({
          question_id: questionId,
          question_type: confirmBtn.dataset.questionType || '',
          answer: confirmBtn.dataset.answer || '',
        });
        if (!result.success) {
          alert(`确认失败: ${result.detail || '未知错误'}`);
          return;
        }
      } catch (e) {
        alert(`确认失败: ${e.message}`);
        return;
      }
    }
    // 全部保存成功，清空预览，回到输入状态
    confirmBtn.style.display = 'none';
    const reBtn = document.getElementById('btn-regenerate');
    if (reBtn) reBtn.style.display = 'none';
    const swapBtn = document.getElementById('btn-swap');
    if (swapBtn) swapBtn.style.display = 'none';
    const container = document.getElementById('preview-container');
    if (container) container.innerHTML = '';
  },

  /** 重新出题：保留表单输入，清除上次预览缓存并重新生成 */
  _reAutoGenerate: async function() {
    // 重新出题时需求人数随机 3~6
    this._randomPeopleInto('auto-people-count');
    const reBtn = document.getElementById('btn-regenerate');
    const questionIds = (reBtn?.dataset.questionIds || reBtn?.dataset.questionId || '').split(',').filter(Boolean);
    // 清除后端预览缓存（存在性一次可能有多份）
    for (const questionId of questionIds) {
      try {
        await API.clearAutoGenerate(questionId);
      } catch (e) {
        console.error('清除预览缓存失败:', e);
      }
    }
    // 重置预览区域（保留表单输入不变）
    const container = document.getElementById('preview-container');
    if (container) {
      container.innerHTML = '<div style="text-align:center;color:var(--gray-4);padding:60px 20px">正在重新出题...</div>';
    }
    const confirmBtn = document.getElementById('btn-confirm-generate');
    if (confirmBtn) confirmBtn.style.display = 'none';
    if (reBtn) reBtn.style.display = 'none';
    const swapBtn = document.getElementById('btn-swap');
    if (swapBtn) swapBtn.style.display = 'none';
    // 用现有表单参数重新生成
    await this._onAutoGenerate();
  },

  /** 换方案（存在性）：不变第一程车，换中间站/换乘车次；0_/1_ 同步换 */
  _swapAutoSolution: async function() {
    const swapBtn = document.getElementById('btn-swap');
    const questionIds = (swapBtn?.dataset.questionIds || swapBtn?.dataset.questionId || '').split(',').filter(Boolean);
    if (!questionIds.length) return;
    const qid = questionIds[0]; // 0_ 与 1_ 同车，后端会同步两者
    try {
      const res = await API.swapAutoGenerate(qid);
      if (!res.success) { alert(`换方案失败: ${res.detail || '未知错误'}`); return; }
      this._showAutoPreview({ questions: res.questions });
    } catch (e) { alert(`换方案失败: ${e.message}`); }
  },

  // ============================================================
  // 选择性问题出题初始化
  // ============================================================
  initSelectiveQuestion: function() {
    // 每次进入该页：需求人数随机 3~6
    this._randomPeopleInto('sel-people-count');
    const generateBtn = document.getElementById('btn-sel-generate');
    if (generateBtn) {
      generateBtn.onclick = () => this._onSelectiveGenerate();
    }

    const confirmBtn = document.getElementById('btn-sel-confirm');
    if (confirmBtn) {
      confirmBtn.onclick = () => this._confirmSelectiveGenerate();
    }

    const regenerateBtn = document.getElementById('btn-sel-regenerate');
    if (regenerateBtn) {
      regenerateBtn.onclick = () => this._reSelectiveGenerate();
    }

    const swapBtn = document.getElementById('btn-sel-swap');
    if (swapBtn) {
      swapBtn.onclick = () => this._swapSelectiveSolution();
    }

    // 干扰密度滑块联动
    const densitySlider = document.getElementById('sel-density');
    const densityLabel = document.getElementById('sel-density-label');
    if (densitySlider && densityLabel) {
      densitySlider.oninput = function() {
        densityLabel.textContent = parseFloat((this.value * 100).toFixed(3)) + '%';
      };
    }

    // 选择性题题型由后端按行为约束自动推导（不允许换乘→买短补长；否则→换乘），前端不再需要题型选择

    // 回车触发
    ['sel-from-station', 'sel-to-station'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            document.getElementById('btn-sel-generate')?.click();
          }
        });
      }
    });
  },

  /** 收集选择性表单勾选的行为约束（新约束键：不允许换乘 / 不允许买短补长与额外购买） */
  _selectedConstraints: function() {
    const out = [];
    if (document.getElementById('sel-const-no-transfer')?.checked) out.push('no_transfer');
    if (document.getElementById('sel-const-no-short-buy-extra')?.checked) out.push('no_short_buy_extra');
    return out;
  },

  /** 收集选择性表单的评判标准（单选必选，默认综合） */
  _selectedCriterion: function() {
    const checked = document.querySelector('input[name="sel-criterion"]:checked');
    return checked ? checked.value : 'comprehensive';
  },

  /** 人数随机 3~6：进入页面 / 重新出题时写入对应人数输入框（仍可手动修改） */
  _randomPeopleInto: function(elementId) {
    const el = document.getElementById(elementId);
    if (el) {
      el.value = Math.floor(Math.random() * 4) + 3; // 3 ~ 6
    }
  },

  /** 选择性出题 */
  _onSelectiveGenerate: async function() {
    const form = {
      mode: 'selective',
      from_station_id: document.getElementById('sel-from-station')?.value.trim(),
      to_station_id: document.getElementById('sel-to-station')?.value.trim(),
      random_tickets: true,
      fake_interference: false,
      interference_density: parseFloat(document.getElementById('sel-density')?.value || '0.02'),
      people_count: parseInt(document.getElementById('sel-people-count')?.value || '2', 10),
      seat_type: document.getElementById('sel-seat-type')?.value || 'class2',
      criterion: this._selectedCriterion(),
      custom_qid: document.getElementById('sel-output-qid')?.value.trim() || '',
      constraints: this._selectedConstraints(),
    };

    // 题目名必填
    if (!form.custom_qid) {
      alert('请填写题目名');
      return;
    }

    if (!form.from_station_id || !form.to_station_id) {
      alert('请填写出发站和到达站');
      return;
    }

    const previewContainer = document.getElementById('sel-preview-container');
    if (previewContainer) {
      previewContainer.innerHTML = '<div style="padding:20px;text-align:center;color:var(--gray-4)">正在生成...</div>';
    }

    try {
      const result = await API.autoGenerate(form);
      if (result.success) {
        this._showSelectivePreview(result);
      } else {
        alert(`生成失败: ${result.detail || '未知错误'}`);
        if (previewContainer) previewContainer.innerHTML = '';
      }
    } catch (e) {
      alert(`生成失败: ${e.message}`);
      if (previewContainer) previewContainer.innerHTML = '';
    }
  },

  /** 显示选择性问题预览（选择性出一份，前缀 2_） */
  _showSelectivePreview: function(data) {
    const container = document.getElementById('sel-preview-container');
    if (!container) return;

    const questions = data.questions || [];
    const first = questions[0] || {};
    const preview = first.preview || {};
    const qid = first.question_id || '';
    const density = document.getElementById('sel-density')?.value || '0.02';

    let pathsHtml = '';
    if (preview.solution_segments && preview.solution_segments.length > 0) {
      preview.solution_segments.forEach(seg => {
        pathsHtml += `<div>✅ ${seg.train_num}: ${seg.from}→${seg.to} (${seg.tickets}张 ${seg.seat_type})</div>`;
      });
    }

    const pathDesc = preview.path_description || '';

    container.innerHTML = `
      <div class="card">
        <div class="card-header">预览：即将生成题目</div>
        <div style="display:flex;flex-direction:column;gap:12px">
          <div><strong>题目名：</strong>${qid}</div>
          <div><strong>题型：</strong>${preview.question_type}</div>
          <div><strong>需求人数：</strong>${document.getElementById('sel-people-count')?.value || '2'} 人</div>
          <div><strong>答案票等级：</strong>${document.getElementById('sel-seat-type')?.value || 'class2'}</div>
          <div><strong>干扰密度：</strong>${Math.round(parseFloat(density) * 100)}%</div>
          <div><strong>评判标准：</strong>${CRITERION_LABELS[preview.criterion] || preview.criterion || '综合考虑'}</div>
          <div><strong>行为约束：</strong>${(preview.constraints && preview.constraints.length) ? preview.constraints.map(c => CONSTRAINT_LABELS[c] || c).join('、') : '无'}</div>
          <div><strong>目标区间：</strong>${preview.target_section}</div>
          <div><strong>路径描述：</strong>${pathDesc}</div>
          <div><strong>合法解（有票段）：</strong></div>
          <div style="padding-left:20px">${pathsHtml || '<div style="color:var(--gray-4)">无</div>'}</div>
          <div style="color:var(--success-green);font-weight:600">✅ 有合法解</div>
        </div>
      </div>
    `;

    const confirmBtn = document.getElementById('btn-sel-confirm');
    if (confirmBtn) {
      confirmBtn.style.display = 'inline-flex';
      confirmBtn.dataset.questionId = qid;
      confirmBtn.dataset.questionType = preview.question_type || '';
      confirmBtn.dataset.answer = preview.path_description || '';
      confirmBtn.dataset.interference = 'true';
      confirmBtn.dataset.density = document.getElementById('sel-density')?.value || '0.02';
    }
    const reBtn = document.getElementById('btn-sel-regenerate');
    if (reBtn) {
      reBtn.style.display = 'inline-flex';
      reBtn.dataset.questionId = qid;
    }
    const swapBtn = document.getElementById('btn-sel-swap');
    if (swapBtn) {
      const qtype = preview.question_type;
      const isSwapable = qtype === 'transfer' || qtype === 'mixed';
      swapBtn.style.display = isSwapable ? 'inline-flex' : 'none';
      if (isSwapable) swapBtn.dataset.questionId = qid;
    }
  },

  /** 确认生成选择性题目 */
  _confirmSelectiveGenerate: async function() {
    const confirmBtn = document.getElementById('btn-sel-confirm');
    if (!confirmBtn || !confirmBtn.dataset.questionId) return;

    const questionId = confirmBtn.dataset.questionId;
    try {
      const result = await API.confirmAutoGenerate({
        question_id: questionId,
        question_type: confirmBtn.dataset.questionType || '',
        answer: confirmBtn.dataset.answer || '',
        interference: confirmBtn.dataset.interference === 'true',
        interference_density: parseFloat(confirmBtn.dataset.density || '0'),
      });
      if (result.success) {
        // 清空预览，回到输入状态
        confirmBtn.style.display = 'none';
        const reBtn = document.getElementById('btn-sel-regenerate');
        if (reBtn) reBtn.style.display = 'none';
        const swapBtn = document.getElementById('btn-sel-swap');
        if (swapBtn) swapBtn.style.display = 'none';
        const container = document.getElementById('sel-preview-container');
        if (container) container.innerHTML = '';
      } else {
        alert(`确认失败: ${result.detail || '未知错误'}`);
      }
    } catch (e) {
      alert(`确认失败: ${e.message}`);
    }
  },

  /** 重新出题（选择性）：保留表单输入，清除上次预览缓存并重新生成 */
  _reSelectiveGenerate: async function() {
    // 重新出题时需求人数随机 3~6
    this._randomPeopleInto('sel-people-count');
    const reBtn = document.getElementById('btn-sel-regenerate');
    const questionIds = (reBtn?.dataset.questionIds || reBtn?.dataset.questionId || '').split(',').filter(Boolean);
    // 清除后端预览缓存
    for (const questionId of questionIds) {
      try {
        await API.clearAutoGenerate(questionId);
      } catch (e) {
        console.error('清除预览缓存失败:', e);
      }
    }
    // 重置预览区域（保留表单输入不变）
    const container = document.getElementById('sel-preview-container');
    if (container) {
      container.innerHTML = '<div style="text-align:center;color:var(--gray-4);padding:60px 20px">正在重新出题...</div>';
    }
    const confirmBtn = document.getElementById('btn-sel-confirm');
    if (confirmBtn) confirmBtn.style.display = 'none';
    if (reBtn) reBtn.style.display = 'none';
    const swapBtn = document.getElementById('btn-sel-swap');
    if (swapBtn) swapBtn.style.display = 'none';
    // 用现有表单参数重新生成
    await this._onSelectiveGenerate();
  },

  /** 换方案（选择性）：不变第一程车，换中间站/换乘车次 */
  _swapSelectiveSolution: async function() {
    const swapBtn = document.getElementById('btn-sel-swap');
    const qid = swapBtn?.dataset.questionId || '';
    if (!qid) return;
    try {
      const res = await API.swapAutoGenerate(qid);
      if (!res.success) { alert(`换方案失败: ${res.detail || '未知错误'}`); return; }
      this._showSelectivePreview({ questions: res.questions });
    } catch (e) { alert(`换方案失败: ${e.message}`); }
  },

  // ============================================================
  // 批量出题
  // ============================================================
  batchDistribution: null,   // 解析后的分布表 [{category,name,has_interference,no_interference,question_type,transfers,segment_plans}]
  batchSelective: [],        // 解析后的选择性区 [{criterion,behavior,count}]
  batchStations: [],         // 站对 [[from,to], ...]
  batchReportData: null,     // 批量完成后服务端返回的回执数据

  initBatchQuestion: function() {
    // 批量出题
    const btnParseDist = document.getElementById('btn-batch-parse-distribution');
    if (btnParseDist) btnParseDist.onclick = () => this._parseBatchDistribution();

    const btnParseStations = document.getElementById('btn-batch-parse-stations');
    if (btnParseStations) btnParseStations.onclick = () => this._parseBatchStations();

    const btnGenerate = document.getElementById('btn-batch-generate');
    if (btnGenerate) btnGenerate.onclick = () => this._startBatchGenerate();

    const btnReport = document.getElementById('btn-batch-report');
    if (btnReport) btnReport.onclick = () => this._downloadBatchReport();

    // 干扰密度滑块联动
    const densitySlider = document.getElementById('batch-density');
    const densityLabel = document.getElementById('batch-density-label');
    if (densitySlider && densityLabel) {
      densitySlider.oninput = function() {
        densityLabel.textContent = parseFloat((this.value * 100).toFixed(3)) + '%';
      };
    }

    // 座位等级比例实时校验（总和必须=100%）
    ['batch-seat-class0', 'batch-seat-class1', 'batch-seat-class2'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.oninput = () => this._validateSeatTotal();
    });
    this._validateSeatTotal();
    this._resetBatchProgress();
    // 服务端任务若仍在运行（如页面刷新后），自动恢复进度与日志轮询
    this._resumeBatchPolling('batch_generate');
  },

  /** 批量自然语言化页初始化（导航栏独立页） */
  initBatchNlQuestion: function() {
    const nlScan = document.getElementById('btn-batch-nl-scan');
    if (nlScan) nlScan.onclick = () => this._scanBatchNl();
    const nlGen = document.getElementById('btn-batch-nl-generate');
    if (nlGen) nlGen.onclick = () => this._startBatchNl();
    const nlAll = document.getElementById('btn-batch-nl-select-all');
    if (nlAll) nlAll.onclick = () => this._selectBatchNl(true);
    const nlNone = document.getElementById('btn-batch-nl-select-none');
    if (nlNone) nlNone.onclick = () => this._selectBatchNl(false);

    // 拖选：按住鼠标划过选框即可批量勾选/取消勾选
    this._bindDragSelect(
      document.getElementById('batch-nl-table'),
      'input[data-nl-qid]',
      (cb, checked) => {
        cb.checked = checked;
        if (checked) this.batchNlSelected.add(cb.dataset.nlQid);
        else this.batchNlSelected.delete(cb.dataset.nlQid);
      },
    );

    // 服务端任务若仍在运行（如页面刷新后），自动恢复进度与日志轮询
    this._resumeBatchPolling('batch_nl');
  },

  /** 批量测试页初始化（导航栏独立页） */
  initBatchTestQuestion: function() {
    const testScan = document.getElementById('btn-batch-test-scan');
    if (testScan) testScan.onclick = () => this._scanBatchTest();
    const testStart = document.getElementById('btn-batch-test-start');
    if (testStart) testStart.onclick = () => this._startBatchTest();
    const testAll = document.getElementById('btn-batch-test-select-all');
    if (testAll) testAll.onclick = () => this._selectBatchTest(true);
    const testNone = document.getElementById('btn-batch-test-select-none');
    if (testNone) testNone.onclick = () => this._selectBatchTest(false);

    // 拖选：按住鼠标划过选框即可批量勾选/取消勾选（不可测的 disabled 项自动跳过）
    this._bindDragSelect(
      document.getElementById('batch-test-table'),
      'input[data-test-qid]',
      (cb, checked) => {
        cb.checked = checked;
        if (checked) this.batchTestSelected.add(cb.dataset.testQid);
        else this.batchTestSelected.delete(cb.dataset.testQid);
      },
      (cb) => !cb.disabled,
    );

    // 服务端任务若仍在运行（如页面刷新后），自动恢复进度与日志轮询
    this._resumeBatchPolling('batch_test');
  },

  /** 校验座位等级比例总和 = 100% */
  _validateSeatTotal: function() {
    const get = id => parseFloat(document.getElementById(id)?.value || '0') || 0;
    const total = get('batch-seat-class0') + get('batch-seat-class1') + get('batch-seat-class2');
    const label = document.getElementById('batch-seat-total-label');
    if (!label) return;
    const ok = Math.abs(total - 100) < 0.01;
    label.textContent = `= ${total}%`;
    label.style.color = ok ? 'var(--success-green)' : 'var(--error-red)';
    label.style.fontWeight = ok ? '400' : '700';
    return ok;
  },

  /** 重置单进度条 */
  _resetBatchProgress: function() {
    const bar = document.getElementById('batch-total-bar');
    if (bar) bar.style.width = '0%';
    const count = document.getElementById('batch-total-count');
    if (count) count.textContent = '0 / 0';
    const cur = document.getElementById('batch-current-task');
    if (cur) cur.textContent = '尚未开始';
    const result = document.getElementById('batch-result');
    if (result) { result.style.display = 'none'; result.innerHTML = ''; }
    const btnReport = document.getElementById('btn-batch-report');
    if (btnReport) btnReport.style.display = 'none';
    this._resetBatchLog('batch-gen-log', 'batch_generate');
  },

  /** 解析 1.xlsx 分布表 */
  _parseBatchDistribution: async function() {
    const fileInput = document.getElementById('batch-distribution-file');
    const file = fileInput?.files?.[0];
    if (!file) { alert('请先选择 1.xlsx 文件'); return; }
    try {
      const result = await API.batchParseDistribution(file);
      if (!result.success) { alert(`解析失败: ${result.detail || '未知错误'}`); return; }
      this.batchDistribution = result.exists || [];
      this.batchSelective = result.selective || [];
      this._renderBatchDistributionTable();
    } catch (e) { alert(`解析失败: ${e.message}`); }
  },

  /** 渲染可编辑分布表 */
  _renderBatchDistributionTable: function() {
    const container = document.getElementById('batch-distribution-table');
    if (!container) return;
    let html = '<div style="overflow-x:auto"><table class="table" style="width:100%"><thead><tr>';
    html += '<th>类型</th><th>类别</th><th>名称</th><th>有干扰数</th><th>无干扰数</th></tr></thead><tbody>';
    (this.batchDistribution || []).forEach((row, i) => {
      html += `<tr>
        <td>存在性</td>
        <td>${row.category}</td>
        <td>${row.name}</td>
        <td><input class="input" type="number" min="0" data-dist-idx="${i}" data-dist-key="has_interference" value="${row.has_interference}" style="width:70px"></td>
        <td><input class="input" type="number" min="0" data-dist-idx="${i}" data-dist-key="no_interference" value="${row.no_interference}" style="width:70px"></td>
      </tr>`;
    });
    html += '</tbody></table></div>';

    html += '<div style="margin-top:8px;overflow-x:auto"><table class="table" style="width:100%"><thead><tr>';
    html += '<th>评判标准</th><th>行为约束</th><th>数量</th></tr></thead><tbody>';
    (this.batchSelective || []).forEach((row, i) => {
      html += `<tr>
        <td>${CRITERION_LABELS[row.criterion] || row.criterion}</td>
        <td>${row.behavior === 'none' ? '随意' : CONSTRAINT_LABELS[row.behavior] || row.behavior}</td>
        <td><input class="input" type="number" min="0" data-sel-idx="${i}" data-sel-key="count" value="${row.count}" style="width:70px"></td>
      </tr>`;
    });
    html += '</tbody></table></div>';
    container.innerHTML = html;
  },

  /** 解析 2.xlsx 站对表 */
  _parseBatchStations: async function() {
    const fileInput = document.getElementById('batch-stations-file');
    const file = fileInput?.files?.[0];
    if (!file) { alert('请先选择 2.xlsx 文件'); return; }
    try {
      const result = await API.batchParseStations(file);
      if (!result.success) { alert(`解析失败: ${result.detail || '未知错误'}`); return; }
      this.batchStations = result.stations || [];
      this._renderBatchStationsTable();
    } catch (e) { alert(`解析失败: ${e.message}`); }
  },

  /** 渲染可编辑站对表 */
  _renderBatchStationsTable: function() {
    const container = document.getElementById('batch-stations-table');
    if (!container) return;
    const pairs = this.batchStations || [];
    if (!pairs.length) {
      container.innerHTML = '<div style="text-align:center;color:var(--gray-4);padding:20px">未解析到站对</div>';
      return;
    }
    let html = '<div style="overflow-x:auto"><table class="table" style="width:100%"><thead><tr><th>#</th><th>出发站</th><th>到达站</th></tr></thead><tbody>';
    pairs.forEach((p, i) => {
      html += `<tr>
        <td>${i + 1}</td>
        <td><input class="input" type="text" data-st-idx="${i}" data-st-side="from" value="${p[0]}" style="width:100%"></td>
        <td><input class="input" type="text" data-st-idx="${i}" data-st-side="to" value="${p[1]}" style="width:100%"></td>
      </tr>`;
    });
    html += '</tbody></table></div>';
    html += '<div style="color:var(--gray-4);margin-top:6px">出题时随机选取站对，方向随机可倒置，允许重复使用</div>';
    container.innerHTML = html;
  },

  /** 从可编辑表格回读分布与站对（含单元格修改） */
  _collectBatchInputs: function() {
    // 分布表
    const distRows = (this.batchDistribution || []).map(row => ({...row}));
    document.querySelectorAll('[data-dist-idx][data-dist-key]').forEach(input => {
      const idx = parseInt(input.dataset.distIdx, 10);
      const key = input.dataset.distKey;
      if (distRows[idx]) distRows[idx][key] = parseInt(input.value || '0', 10) || 0;
    });
    const selRows = (this.batchSelective || []).map(row => ({...row}));
    document.querySelectorAll('[data-sel-idx][data-sel-key]').forEach(input => {
      const idx = parseInt(input.dataset.selIdx, 10);
      if (selRows[idx]) selRows[idx].count = parseInt(input.value || '0', 10) || 0;
    });
    // 站对表
    const stations = (this.batchStations || []).map(p => [...p]);
    document.querySelectorAll('[data-st-idx][data-st-side]').forEach(input => {
      const idx = parseInt(input.dataset.stIdx, 10);
      const side = input.dataset.stSide === 'from' ? 0 : 1;
      if (stations[idx]) stations[idx][side] = input.value.trim();
    });
    return { distribution: distRows, selective: selRows, stations };
  },

  /** 开始批量出题（一键生成并落盘，单进度条轮询） */
  _startBatchGenerate: async function() {
    if (!this._validateSeatTotal()) { alert('座位等级比例总和必须为 100%'); return; }
    const { distribution, selective, stations } = this._collectBatchInputs();
    const totalCount = distribution.reduce((s, r) => s + (r.has_interference || 0) + (r.no_interference || 0), 0)
      + selective.reduce((s, r) => s + (r.count || 0), 0);
    if (!totalCount) { alert('分布表数量全为 0，无可生成题目'); return; }
    if (!stations.length) { alert('请先解析 2.xlsx 站对表'); return; }

    const payload = {
      distribution,
      selective,
      stations,
      seat_weights: {
        class0: parseFloat(document.getElementById('batch-seat-class0')?.value || '0') || 0,
        class1: parseFloat(document.getElementById('batch-seat-class1')?.value || '0') || 0,
        class2: parseFloat(document.getElementById('batch-seat-class2')?.value || '0') || 0,
      },
      interference_density: parseFloat(document.getElementById('batch-density')?.value || '0.02'),
      max_retries: parseInt(document.getElementById('batch-max-retries')?.value || '40', 10) || 40,
    };
    // 注：批量自然语言化已独立成框（/api/batch_nl/*），不再内嵌于批量出题请求

    this._resetBatchProgress();
    const count = document.getElementById('batch-total-count');
    if (count) count.textContent = `0 / ${totalCount}`;

    try {
      const result = await API.batchGenerate(payload);
      if (!result.success) { alert(`批量出题启动失败: ${result.detail || '未知错误'}`); this._resetBatchProgress(); return; }
      if (!this._batchGenPolling) this._pollBatchStatus();
    } catch (e) {
      alert(`批量出题启动失败: ${e.message}`);
      this._resetBatchProgress();
    }
  },

  /** 轮询批量状态，更新单进度条与日志（skipLogReplay=true 仅同步游标不回放旧日志） */
  _pollBatchStatus: async function(skipLogReplay) {
    this._batchGenPolling = true;
    try {
      const status = await API.batchStatus(this._batchLogSeqs.batch_generate || 0);
      this._renderBatchProgress(status);
      this._appendBatchLog('batch-gen-log', 'batch_generate', status.logs, skipLogReplay);
      if (status.running) {
        setTimeout(() => this._pollBatchStatus(), 500);
      } else {
        this._batchGenPolling = false;
        if (status.done) {
          this._renderBatchResult(status.result);
          // 任务在本页面会话中运行结束后，弹窗提示失败题目数
          const failed = status.result?.summary?.failed;
          if (this._batchGenWasRunning && typeof failed === 'number') {
            alert(`批量出题结束\n失败题目数：${failed}`);
          }
          this._batchGenWasRunning = false;
        }
      }
    } catch (e) {
      console.error('批量状态轮询失败:', e);
      setTimeout(() => this._pollBatchStatus(), 500);
    }
  },

  /** 渲染单进度条 */
  _renderBatchProgress: function(status) {
    const bar = document.getElementById('batch-total-bar');
    if (bar) bar.style.width = status.total ? `${Math.round((status.done_count / status.total) * 100)}%` : '0%';
    const count = document.getElementById('batch-total-count');
    if (count) count.textContent = `${status.done_count || 0} / ${status.total || 0}`;
    const cur = document.getElementById('batch-current-task');
    if (cur) cur.textContent = status.current || '';
    // 标记任务在本页面会话中处于运行态（用于结束时弹窗判断）
    if (status.running) this._batchGenWasRunning = true;
  },

  // ============================================================
  // 批量日志通用渲染（三个批量工具共用）
  // ============================================================
  // 各任务已读日志游标（seq），与服务端全局自增序号对应
  _batchLogSeqs: { batch_generate: 0, batch_nl: 0, batch_test: 0 },
  // 各任务轮询进行中标志（防止多条轮询链并行）
  _batchGenPolling: false,
  _batchNlPolling: false,
  _batchTestPolling: false,
  // 批量出题任务在本页面会话中处于运行态（结束时据此弹窗提示失败数）
  _batchGenWasRunning: false,

  /** 增量追加日志行并自动滚动到底部（textContent 渲染，防注入）
   *  syncOnly=true 时仅同步游标、不渲染（进入页面时避免回放旧日志，只显示新出现的） */
  _appendBatchLog: function(containerId, job, payload, syncOnly) {
    if (!payload) return;
    this._batchLogSeqs[job] = payload.last_seq ?? this._batchLogSeqs[job] ?? 0;
    const items = payload.items || [];
    if (syncOnly || !items.length) return;
    const box = document.getElementById(containerId);
    if (!box) return;
    if (box.dataset.hasLog !== '1') { box.innerHTML = ''; box.dataset.hasLog = '1'; }
    const frag = document.createDocumentFragment();
    items.forEach(it => {
      const div = document.createElement('div');
      div.style.color = it.level === 'error' ? 'var(--error-red)'
        : it.level === 'success' ? 'var(--success-green)'
        : it.level === 'warn' ? '#d97706' : 'var(--gray-5)';
      div.textContent = `[${it.t}] ${it.msg}`;
      frag.appendChild(div);
    });
    box.appendChild(frag);
    box.scrollTop = box.scrollHeight;
  },

  /** 重置日志区（任务启动时调用） */
  _resetBatchLog: function(containerId, job) {
    this._batchLogSeqs[job] = 0;
    const box = document.getElementById(containerId);
    if (box) {
      box.dataset.hasLog = '0';
      box.innerHTML = '<div style="color:var(--gray-4)">暂无日志</div>';
    }
  },

  /** 进入页面时恢复轮询：服务端任务仍在运行（如刷新页面后）则继续更新进度与日志。
   *  首次拉取仅同步日志游标（不回放旧日志，前端只显示之后新出现的日志） */
  _resumeBatchPolling: function(job) {
    const flag = { batch_generate: '_batchGenPolling', batch_nl: '_batchNlPolling', batch_test: '_batchTestPolling' }[job];
    if (this[flag]) return;
    const start = {
      batch_generate: () => this._pollBatchStatus(true),
      batch_nl: () => this._pollBatchNlStatus(true),
      batch_test: () => this._pollBatchTestStatus(true),
    }[job];
    if (start) start();
  },

  /** 渲染批量结果 + 显示回执下载按钮 */
  _renderBatchResult: function(result) {
    const container = document.getElementById('batch-result');
    if (!container) return;
    container.style.display = 'block';
    let html = '<div class="card"><div class="card-header">📋 批量出题结果</div>';
    html += `<div style="display:flex;gap:16px;padding:8px 0;font-size:var(--font-size-small)">
      <div><strong>总题数：</strong>${result.summary.total}</div>
      <div style="color:var(--success-green)"><strong>成功：</strong>${result.summary.success}</div>
      <div style="color:var(--error-red)"><strong>失败：</strong>${result.summary.failed}</div>
    </div>`;
    const nl = result.summary || {};
    if (nl.nl_generated !== undefined) {
      html += `<div style="display:flex;gap:16px;padding:4px 0;font-size:var(--font-size-small)">
        <div><strong>自然语言生成：</strong><span style="color:var(--success-green)">${nl.nl_generated}</span> 成功</div>
        <div style="color:var(--error-red)">${nl.nl_failed} 失败</div>
        <div style="color:var(--gray-4)">${nl.nl_skipped} 跳过</div>
      </div>`;
      if (nl.nl_error) {
        html += `<div style="color:var(--gray-5);font-size:var(--font-size-small);padding-bottom:4px">${nl.nl_error}</div>`;
      }
    }
    if (result.summary.failed > 0) {
      html += '<div style="color:var(--error-red);font-size:var(--font-size-small);padding-bottom:8px">失败明细见回执 xlsx（每格=该格失败题数，表头=总失败数），可点击下方按钮下载</div>';
    }
    if (result.details && result.details.length) {
      html += '<div style="max-height:260px;overflow-y:auto;font-size:var(--font-size-small)"><table class="table" style="width:100%"><thead><tr><th>题号</th><th>类型行</th><th>尝试次数</th><th>结果</th></tr></thead><tbody>';
      result.details.forEach(d => {
        html += `<tr><td>${d.question_id}</td><td>${d.row || ''}</td><td>${d.attempts}</td>
          <td style="color:${d.ok ? 'var(--success-green)' : 'var(--error-red)'}">${d.ok ? '✅ 成功' : `❌ ${d.error || '失败'}`}</td></tr>`;
      });
      html += '</tbody></table></div>';
    }
    html += '</div>';
    container.innerHTML = html;
    this.batchReportData = result.report || null;
    const btnReport = document.getElementById('btn-batch-report');
    if (btnReport) btnReport.style.display = this.batchReportData ? 'inline-flex' : 'none';
  },

  /** 下载失败回执 xlsx */
  _downloadBatchReport: async function() {
    if (!this.batchReportData) { alert('暂无回执数据'); return; }
    try {
      const blob = await API.batchReport(this.batchReportData);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'batch_failure_report.xlsx';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) { alert(`下载回执失败: ${e.message}`); }
  },

  // ============================================================
  // 批量自然语言化（独立框，与批量出题异步）
  // ============================================================
  batchNlItems: [],   // 扫描结果 [{question_id, type, question, ...}]
  batchNlSelected: new Set(),
  batchNlReport: null,

  /** 扫描缺失自然语言的题目 */
  _scanBatchNl: async function() {
    try {
      const res = await API.batchNlScan();
      if (!res.success) { alert(`扫描失败: ${res.detail || '未知错误'}`); return; }
      this.batchNlItems = res.items || [];
      this.batchNlSelected = new Set(this.batchNlItems.map(i => i.question_id));
      this._renderBatchNlTable();
    } catch (e) { alert(`扫描失败: ${e.message}`); }
  },

  /** 渲染批量自然语言扫描表（勾选增删） */
  _renderBatchNlTable: function() {
    const container = document.getElementById('batch-nl-table');
    if (!container) return;
    if (!this.batchNlItems.length) {
      container.innerHTML = '<div style="text-align:center;color:var(--gray-4);padding:16px">没有缺失自然语言的题目（全部已生成）</div>';
      return;
    }
    let html = '<table class="table" style="width:100%"><thead><tr><th></th><th>题号</th><th>类型</th><th>题型</th><th>行程</th><th>人数</th><th>座位</th><th>评判标准</th><th>行为约束</th></tr></thead><tbody>';
    this.batchNlItems.forEach(item => {
      const sel = this.batchNlSelected.has(item.question_id);
      html += `<tr>
        <td style="text-align:center;user-select:none"><input type="checkbox" data-nl-qid="${item.question_id}" ${sel ? 'checked' : ''} style="cursor:pointer;vertical-align:middle"></td>
        <td>${item.question_id}</td>
        <td>${item.type || ''}</td>
        <td>${item.question_type || ''}</td>
        <td>${item.question || ''}</td>
        <td>${item.people_count ?? ''}</td>
        <td>${item.seat_type || ''}</td>
        <td>${CRITERION_LABELS[item.criterion] || item.criterion || ''}</td>
        <td>${(item.constraints || []).map(c => CONSTRAINT_LABELS[c] || c).join('、')}</td>
      </tr>`;
    });
    html += '</tbody></table>';
    container.innerHTML = html;
    container.querySelectorAll('input[data-nl-qid]').forEach(input => {
      input.onchange = () => {
        if (input.checked) this.batchNlSelected.add(input.dataset.nlQid);
        else this.batchNlSelected.delete(input.dataset.nlQid);
      };
    });
  },

  /** 批量自然语言全选/取消 */
  _selectBatchNl: function(all) {
    this.batchNlSelected = all ? new Set(this.batchNlItems.map(i => i.question_id)) : new Set();
    this._renderBatchNlTable();
  },

  /** 开始批量自然语言化 */
  _startBatchNl: async function() {
    if (!this.batchNlSelected.size) { alert('未勾选任何题目'); return; }
    try {
      const res = await API.batchNlGenerate({ question_ids: [...this.batchNlSelected] });
      if (!res.success) { alert(`启动失败: ${res.detail || '未知错误'}`); return; }
      this._resetBatchNlProgress();
      if (!this._batchNlPolling) this._pollBatchNlStatus();
    } catch (e) { alert(`启动失败: ${e.message}`); }
  },

  /** 轮询批量自然语言化进度（含增量日志；skipLogReplay=true 仅同步游标不回放旧日志） */
  _pollBatchNlStatus: async function(skipLogReplay) {
    this._batchNlPolling = true;
    try {
      const status = await API.batchNlStatus(this._batchLogSeqs.batch_nl || 0);
      this._renderBatchNlProgress(status);
      this._appendBatchLog('batch-nl-log', 'batch_nl', status.logs, skipLogReplay);
      if (status.running) { setTimeout(() => this._pollBatchNlStatus(), 600); }
      else { this._batchNlPolling = false; if (status.done) this._renderBatchNlResult(status.result); }
    } catch (e) {
      console.error('自然语言化进度轮询失败:', e);
      setTimeout(() => this._pollBatchNlStatus(), 600);
    }
  },

  _resetBatchNlProgress: function() {
    const bar = document.getElementById('batch-nl-bar');
    if (bar) bar.style.width = '0%';
    const count = document.getElementById('batch-nl-count');
    if (count) count.textContent = `0 / ${this.batchNlSelected.size}`;
    const cur = document.getElementById('batch-nl-current');
    if (cur) cur.textContent = '尚未开始';
    const res = document.getElementById('batch-nl-result');
    if (res) { res.style.display = 'none'; res.innerHTML = ''; }
    this._resetBatchLog('batch-nl-log', 'batch_nl');
  },

  _renderBatchNlProgress: function(status) {
    const bar = document.getElementById('batch-nl-bar');
    if (bar) bar.style.width = status.total ? `${Math.round((status.done_count / status.total) * 100)}%` : '0%';
    const count = document.getElementById('batch-nl-count');
    if (count) count.textContent = `${status.done_count || 0} / ${status.total || 0}`;
    const cur = document.getElementById('batch-nl-current');
    if (cur) cur.textContent = status.current || '';
  },

  _renderBatchNlResult: function(result) {
    const container = document.getElementById('batch-nl-result');
    if (!container) return;
    container.style.display = 'block';
    const s = result.summary || {};
    let html = '<div class="card"><div class="card-header">📋 批量自然语言化结果</div>';
    html += `<div style="display:flex;gap:16px;padding:8px 0;font-size:var(--font-size-small)">
      <div><strong>总数：</strong>${s.total}</div>
      <div style="color:var(--success-green)"><strong>生成成功：</strong>${s.generated}</div>
      <div style="color:var(--error-red)"><strong>失败：</strong>${s.failed}</div>
      <div style="color:var(--gray-4)"><strong>跳过：</strong>${s.skipped}</div>
    </div>`;
    if (result.error) html += `<div style="color:var(--error-red);font-size:var(--font-size-small);padding-bottom:6px">${result.error}</div>`;
    if (result.details && result.details.length) {
      html += '<div style="max-height:220px;overflow-y:auto;font-size:var(--font-size-small)"><table class="table" style="width:100%"><thead><tr><th>题号</th><th>结果</th></tr></thead><tbody>';
      result.details.forEach(d => {
        html += `<tr><td>${d.question_id}</td>
          <td style="color:${d.ok ? 'var(--success-green)' : 'var(--error-red)'}">${d.ok ? '✅ 已生成' : `❌ ${d.error || '失败'}`}</td></tr>`;
      });
      html += '</tbody></table></div>';
    }
    html += '</div>';
    container.innerHTML = html;
    // 完成后刷新扫描（缺 nl 的题目已减少）
    this._scanBatchNl();
  },

  // ============================================================
  // 批量测试（扫描可测题目 → 勾选 → 逐题测试）
  // ============================================================
  batchTestItems: [],   // 扫描结果 [{question_id, ..., testable, tested_models}]
  batchTestSelected: new Set(),

  /** 扫描可测试题目（模型未测过且信息完备） */
  _scanBatchTest: async function() {
    const model = document.getElementById('batch-test-model')?.value.trim();
    if (!model) { alert('请先填写测试模型编号（名称）'); return; }
    try {
      const res = await API.batchTestScan({ model });
      if (!res.success) { alert(`扫描失败: ${res.detail || '未知错误'}`); return; }
      this.batchTestItems = res.items || [];
      // 默认勾选全部可测试项
      this.batchTestSelected = new Set(this.batchTestItems.filter(i => i.testable).map(i => i.question_id));
      this._renderBatchTestTable();
    } catch (e) { alert(`扫描失败: ${e.message}`); }
  },

  /** 渲染批量测试扫描表（勾选增删 + 基本信息） */
  _renderBatchTestTable: function() {
    const container = document.getElementById('batch-test-table');
    if (!container) return;
    if (!this.batchTestItems.length) {
      container.innerHTML = '<div style="text-align:center;color:var(--gray-4);padding:16px">没有可测试题目（模型已全部测过，或题目缺自然语言）</div>';
      return;
    }
    let html = '<table class="table" style="width:100%"><thead><tr><th></th><th>题号</th><th>类型</th><th>题型</th><th>行程</th><th>自然语言</th><th>已测模型</th><th>可测</th></tr></thead><tbody>';
    this.batchTestItems.forEach(item => {
      const sel = this.batchTestSelected.has(item.question_id);
      const testable = item.testable;
      html += `<tr>
        <td style="text-align:center;user-select:none"><input type="checkbox" data-test-qid="${item.question_id}" ${sel && testable ? 'checked' : ''} ${testable ? '' : 'disabled'} style="cursor:pointer;vertical-align:middle"></td>
        <td>${item.question_id}</td>
        <td>${item.type || ''}</td>
        <td>${item.question_type || ''}</td>
        <td>${item.question || ''}</td>
        <td>${item.nl_exists ? '✅ 有' : '❌ 缺'}</td>
        <td>${(item.tested_models || []).join('、') || '—'}</td>
        <td>${testable ? '<span style="color:var(--success-green)">可测</span>' : '<span style="color:var(--error-red)">不可测</span>'}</td>
      </tr>`;
    });
    html += '</tbody></table>';
    container.innerHTML = html;
    container.querySelectorAll('input[data-test-qid]').forEach(input => {
      input.onchange = () => {
        if (input.checked) this.batchTestSelected.add(input.dataset.testQid);
        else this.batchTestSelected.delete(input.dataset.testQid);
      };
    });
  },

  /** 批量测试全选/取消（仅可测项） */
  _selectBatchTest: function(all) {
    this.batchTestSelected = all
      ? new Set(this.batchTestItems.filter(i => i.testable).map(i => i.question_id))
      : new Set();
    this._renderBatchTestTable();
  },

  /** 开始批量测试 */
  _startBatchTest: async function() {
    if (!this.batchTestSelected.size) { alert('未勾选任何可测试题目'); return; }
    const model = document.getElementById('batch-test-model')?.value.trim();
    if (!model) { alert('请先填写测试模型编号（名称）'); return; }
    const maxIter = parseInt(document.getElementById('batch-test-max-iter')?.value || '30', 10) || 30;
    try {
      const res = await API.batchTestStart({ model, question_ids: [...this.batchTestSelected], max_iterations: maxIter });
      if (!res.success) { alert(`启动失败: ${res.detail || '未知错误'}`); return; }
      this._resetBatchTestProgress();
      if (!this._batchTestPolling) this._pollBatchTestStatus();
    } catch (e) { alert(`启动失败: ${e.message}`); }
  },

  /** 轮询批量测试进度（含增量日志；skipLogReplay=true 仅同步游标不回放旧日志） */
  _pollBatchTestStatus: async function(skipLogReplay) {
    this._batchTestPolling = true;
    try {
      const status = await API.batchTestStatus(this._batchLogSeqs.batch_test || 0);
      this._renderBatchTestProgress(status);
      this._appendBatchLog('batch-test-log', 'batch_test', status.logs, skipLogReplay);
      if (status.running) { setTimeout(() => this._pollBatchTestStatus(), 800); }
      else { this._batchTestPolling = false; if (status.done) this._renderBatchTestResult(status.result); }
    } catch (e) {
      console.error('批量测试进度轮询失败:', e);
      setTimeout(() => this._pollBatchTestStatus(), 800);
    }
  },

  _resetBatchTestProgress: function() {
    const bar = document.getElementById('batch-test-bar');
    if (bar) bar.style.width = '0%';
    const count = document.getElementById('batch-test-count');
    if (count) count.textContent = `0 / ${this.batchTestSelected.size}`;
    const cur = document.getElementById('batch-test-current');
    if (cur) cur.textContent = '尚未开始';
    const res = document.getElementById('batch-test-result');
    this._resetBatchLog('batch-test-log', 'batch_test');
    if (res) { res.style.display = 'none'; res.innerHTML = ''; }
  },

  _renderBatchTestProgress: function(status) {
    const bar = document.getElementById('batch-test-bar');
    if (bar) bar.style.width = status.total ? `${Math.round((status.done_count / status.total) * 100)}%` : '0%';
    const count = document.getElementById('batch-test-count');
    if (count) count.textContent = `${status.done_count || 0} / ${status.total || 0}`;
    const cur = document.getElementById('batch-test-current');
    if (cur) cur.textContent = status.current || '';
  },

  _renderBatchTestResult: function(result) {
    const container = document.getElementById('batch-test-result');
    if (!container) return;
    container.style.display = 'block';
    const s = result.summary || {};
    let html = '<div class="card"><div class="card-header">🧪 批量测试结果</div>';
    html += `<div style="display:flex;gap:16px;padding:8px 0;font-size:var(--font-size-small)">
      <div><strong>模型：</strong>${s.model || ''}</div>
      <div><strong>总数：</strong>${s.total}</div>
      <div style="color:var(--success-green)"><strong>成功：</strong>${s.success}</div>
      <div style="color:var(--error-red)"><strong>失败/跳过：</strong>${s.failed}</div>
    </div>`;
    if (result.details && result.details.length) {
      html += '<div style="max-height:280px;overflow-y:auto;font-size:var(--font-size-small)"><table class="table" style="width:100%"><thead><tr><th>题号</th><th>结果</th><th>记录文件</th><th>plan_status</th><th>耗时(s)</th></tr></thead><tbody>';
      result.details.forEach(d => {
        html += `<tr><td>${d.question_id}</td>
          <td style="color:${d.ok ? 'var(--success-green)' : 'var(--error-red)'}">${d.ok ? '✅ 已保存测试记录' : `❌ ${d.error || '失败'}`}</td>
          <td>${d.filename || ''}</td>
          <td>${d.plan_status || ''}</td>
          <td>${d.duration ?? ''}</td></tr>`;
      });
      html += '</tbody></table></div>';
    }
    html += '</div>';
    container.innerHTML = html;
    // 测试后刷新扫描（该模型已测的项将变为不可测）
    this._scanBatchTest();
  },

  // ============================================================
  // 题目管理
  // ============================================================
  initQuestionManager: function() {
    if (document.querySelector('#page-question-manager')?.dataset.initialized) return;
    document.querySelector('#page-question-manager').dataset.initialized = '1';

    // 筛选变化自动刷新
    ['qm-status', 'qm-type'].forEach(id => {
      document.getElementById(id)?.addEventListener('change', () => this._refreshQuestionList());
    });
    document.getElementById('qm-keyword')?.addEventListener('input', () => this._refreshQuestionList());

    // 表头全选/全不选
    document.getElementById('qm-check-all')?.addEventListener('change', (e) => {
      this._toggleQmAll(e.target.checked);
    });

    // 拖选：按住鼠标划过选框即可批量勾选/取消勾选
    this._bindDragSelect(
      document.getElementById('qm-tbody'),
      'input.qm-check',
      (cb, checked) => this._setQmCheck(cb, checked),
    );

    this._refreshQuestionList();
  },

  // 选中状态：qid 集合（刷新后按可见列表裁剪）
  _qmSelected: new Set(),

  // 拖选公共状态：{mode:boolean, onSet:function}，mouseup 时清除
  _dragSelecting: null,

  /**
   * 通用复选框拖选绑定（事件委托，绑定一次）
   * @param {HTMLElement} container 事件委托容器（可被整体重渲染）
   * @param {string} checkboxSelector 容器内复选框选择器
   * @param {(cb: HTMLInputElement, checked: boolean)=>void} onSet 状态变更回调
   * @param {(cb: HTMLInputElement)=>boolean} [isEnabled] 返回 false 则跳过该选框（如 disabled）
   */
  _bindDragSelect: function(container, checkboxSelector, onSet, isEnabled) {
    if (!container || container.dataset.dragSelectBound) return;
    container.dataset.dragSelectBound = '1';

    container.addEventListener('mousedown', (e) => {
      const cb = e.target.closest(checkboxSelector);
      if (!cb || cb.disabled || (isEnabled && !isEnabled(cb))) return;
      // 阻止原生点击与文本选择，统一走拖选状态机
      e.preventDefault();
      this._dragSelecting = { mode: !cb.checked, onSet };
      onSet(cb, this._dragSelecting.mode);
    });
    container.addEventListener('mouseover', (e) => {
      if (!this._dragSelecting || this._dragSelecting.onSet !== onSet) return;
      const cb = e.target.closest(checkboxSelector);
      if (!cb || cb.disabled || (isEnabled && !isEnabled(cb))) return;
      onSet(cb, this._dragSelecting.mode);
    });
    // 全局 mouseup 结束拖选（防重绑定：统一走 window 一次性标记）
    if (!window.__dragSelectMouseUpBound) {
      window.__dragSelectMouseUpBound = true;
      document.addEventListener('mouseup', () => { this._dragSelecting = null; });
    }
  },

  _setQmCheck: function(cb, checked) {
    cb.checked = checked;
    const qid = cb.dataset.qid;
    if (checked) this._qmSelected.add(qid);
    else this._qmSelected.delete(qid);
    this._updateQmSelInfo();
  },

  _updateQmSelInfo: function() {
    const boxes = Array.from(document.querySelectorAll('#qm-tbody input.qm-check'));
    const selCount = boxes.filter(b => b.checked).length;
    const info = document.getElementById('qm-sel-info');
    if (info) info.textContent = selCount > 0
      ? `已选择 ${selCount} 题`
      : '未选择（按住鼠标拖过选框可批量勾选）';
    const btnDel = document.getElementById('qm-btn-batch-del');
    if (btnDel) btnDel.disabled = selCount === 0;
    const btnClr = document.getElementById('qm-btn-clear-sel');
    if (btnClr) btnClr.disabled = selCount === 0;
    const all = document.getElementById('qm-check-all');
    if (all) {
      all.checked = boxes.length > 0 && selCount === boxes.length;
      all.indeterminate = selCount > 0 && selCount < boxes.length;
    }
  },

  _toggleQmAll: function(checked) {
    document.querySelectorAll('#qm-tbody input.qm-check').forEach(cb => {
      this._setQmCheck(cb, checked);
    });
  },

  _clearQmSelection: function() {
    this._toggleQmAll(false);
  },

  _batchDeleteQuestions: async function() {
    const ids = Array.from(document.querySelectorAll('#qm-tbody input.qm-check'))
      .filter(cb => cb.checked)
      .map(cb => cb.dataset.qid);
    if (!ids.length) return;
    if (!confirm(`确认批量删除选中的 ${ids.length} 道题目？\n这些题的所有余票数据将被清除，且不可恢复。`)) return;

    const btn = document.getElementById('qm-btn-batch-del');
    if (btn) { btn.disabled = true; btn.textContent = '删除中...'; }

    const failed = [];
    for (const qid of ids) {
      try {
        const resp = await fetch(`/api/question/${encodeURIComponent(qid)}`, { method: 'DELETE' });
        const result = await resp.json();
        if (!result.success) failed.push(`${qid}: ${result.detail || '未知错误'}`);
      } catch (e) {
        failed.push(`${qid}: ${e.message}`);
      }
    }

    this._qmSelected.clear();
    if (btn) btn.textContent = '🗑 批量删除';
    await this._refreshQuestionList();
    if (failed.length) {
      alert(`批量删除完成：成功 ${ids.length - failed.length} 题，失败 ${failed.length} 题\n` + failed.join('\n'));
    }
  },

  _refreshQuestionList: async function() {
    const params = new URLSearchParams();
    const status = document.getElementById('qm-status')?.value;
    const type = document.getElementById('qm-type')?.value;
    const keyword = document.getElementById('qm-keyword')?.value.trim();
    if (status) params.set('status_filter', status);
    if (type) params.set('type', type);
    if (keyword) params.set('keyword', keyword);

    try {
      const resp = await fetch(`/api/question/list?${params}`);
      const data = await resp.json();
      const tbody = document.getElementById('qm-tbody');
      const countEl = document.getElementById('qm-count');
      if (!tbody) return;
      if (countEl) countEl.textContent = `（共 ${data.total || 0} 题）`;

      if (!data.questions || data.questions.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--gray-4);padding:30px">暂无符合条件的题目</td></tr>';
        this._qmSelected.clear();
        this._updateQmSelInfo();
        return;
      }

      const sorted = this._sortQuestionsByQid(data.questions);
      // 选中集只保留当前可见列表中的题号
      const visibleIds = new Set(sorted.map(q => q.question_id));
      this._qmSelected = new Set([...this._qmSelected].filter(id => visibleIds.has(id)));
      let html = '';
      sorted.forEach(q => {
        const qtypeLabel = q.question_type ? this._questionTypeLabel(q.question_type) : (q.type || '-');
        const modeTag = (q.type && q.type !== q.question_type) ? ` <span style="color:${q.type === '选择性' ? '#7c3aed' : '#2563eb'};font-size:11px">(${q.type})</span>` : '';
        const ansPreview = q.answer ? q.answer.substring(0, 30) + (q.answer.length > 30 ? '...' : '') : '-';
        const checked = this._qmSelected.has(q.question_id) ? ' checked' : '';
        html += `<tr>
          <td style="text-align:center;user-select:none"><input type="checkbox" class="qm-check" data-qid="${q.question_id}"${checked} style="cursor:pointer;vertical-align:middle"></td>
          <td><strong>${q.question_id}</strong></td>
          <td>${qtypeLabel}${modeTag}</td>
          <td>${q.train_count}</td>
          <td><span class="tag ${q.status === 'completed' ? 'tag-success' : 'tag-warning'}">${q.status}</span></td>
          <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${q.answer || ''}">${ansPreview}</td>
          <td>
            <button class="btn btn-sm btn-secondary" onclick="App._jumpToEdit('${q.question_id}')">改题</button>
            <button class="btn btn-sm btn-danger" onclick="App._deleteQuestion('${q.question_id}')">删除</button>
          </td>
        </tr>`;
      });
      tbody.innerHTML = html;
      this._updateQmSelInfo();
    } catch (e) {
      console.error('加载题目列表失败', e);
    }
  },

  _questionTypeLabel: function(type) {
    const map = {
      'transfer': '换乘', 'short_buy': '买短补长',
      'extra_front': '前额外', 'extra_rear': '后额外', 'mixed': '混合',
    };
    return map[type] || type || '-';
  },

  _jumpToEdit: function(qid) {
    // 先设置 currentQuestionId，让 initEditQuestion 能直接选中该题
    this.currentQuestionId = qid;
    this._switchToPage('edit-question');
    // 等待 initEditQuestion 的异步加载完成后自动加载车次列表
    setTimeout(() => {
      const loadBtn = document.getElementById('edit-btn-load-question');
      const trainInput = document.getElementById('edit-train-input');
      // 如果有已加载的车次，直接显示第一个
      const filled = document.querySelector('#edit-filled-trains .filled-train-item');
      if (filled) {
        filled.click();
      }
    }, 500);
  },

  _deleteQuestion: async function(qid) {
    if (!confirm(`确认删除题目 ${qid}？\n该题的所有余票数据将被清除。`)) return;
    try {
      const resp = await fetch(`/api/question/${encodeURIComponent(qid)}`, { method: 'DELETE' });
      const result = await resp.json();
      if (result.success) {
        this._qmSelected.delete(qid);
        this._refreshQuestionList();
      } else {
        alert(`删除失败: ${result.detail || '未知错误'}`);
      }
    } catch (e) {
      alert(`删除失败: ${e.message}`);
    }
  },

  // ============================================================
  // 测评面板初始化
  // ============================================================
  initEval: function() {
    // 如果已初始化，跳过
    if (document.querySelector('#page-eval')?.dataset.initialized) return;
    document.querySelector('#page-eval').dataset.initialized = '1';

    // 加载测试记录列表
    this._loadEvalRecords();

    // 绑定按钮事件
    document.getElementById('btn-eval-load').onclick = () => this._loadEvalRecord();
    document.getElementById('btn-eval-verify').onclick = () => this._runEvalVerify();
    document.getElementById('btn-eval-complete').onclick = () => this._saveEvalResult();

    // 绑定 Tab 切换
    document.querySelectorAll('#page-eval .tab-btn').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('#page-eval .tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('eval-verify-panel').style.display = btn.dataset.tab === 'verify' ? '' : 'none';
        document.getElementById('eval-details-panel').style.display = btn.dataset.tab === 'details' ? '' : 'none';
      };
    });
  },

  /** 加载测试记录列表 */
  _loadEvalRecords: async function() {
    const container = document.getElementById('eval-record-list');
    if (!container) return;
    try {
      const data = await API.getTestRecords();
      let html = '';
      data.records.forEach(r => {
        html += `<div class="eval-record-item" data-filename="${r.filename}" onclick="App._selectEvalRecord(this)" style="padding:6px 8px;cursor:pointer;border-radius:4px;font-size:var(--font-size-small);border-bottom:1px solid var(--gray-1)">
          <div><strong>${r.question_id || '未知'}</strong></div>
          <div style="color:var(--gray-4)">${r.timestamp || ''}</div>
        </div>`;
      });
      container.innerHTML = html || '<div style="color:var(--gray-4);padding:12px">暂无测试记录</div>';
    } catch (e) {
      container.innerHTML = '<div style="color:var(--error-red)">加载失败</div>';
    }
  },

  /** 选择测评记录（支持切换取消选中） */
  _selectEvalRecord: function(el) {
    // 重复点击已选中的 → 取消选中
    if (el.classList.contains('selected')) {
      el.classList.remove('selected');
      return;
    }
    // 点击不同的 → 切换选中
    document.querySelectorAll('#eval-record-list .eval-record-item').forEach(item => item.classList.remove('selected'));
    el.classList.add('selected');
  },

  /** 加载选中的测评记录 */
  _loadEvalRecord: async function() {
    const selected = document.querySelector('#eval-record-list .eval-record-item.selected');
    if (!selected) { alert('请先选择一条测试记录'); return; }
    const filename = selected.dataset.filename;
    try {
      this._currentEvalRecord = await API.loadTestRecord(filename);
      this._currentEvalFilename = filename;
      const r = this._currentEvalRecord;

      // --- 提取结构化工具调用记录（换乘方案） ---
      const toolRecords = [];
      if (r.conversation) {
        for (const msg of r.conversation) {
          if (msg.role === 'assistant' && msg.tool_calls) {
            for (const tc of msg.tool_calls) {
              if (tc.function?.name === 'query_tickets') {
                try {
                  const args = JSON.parse(tc.function.arguments || '{}');
                  toolRecords.push({
                    train_num: args.train_num || '',
                    from: args.from_station_id || '',
                    to: args.to_station_id || '',
                    seat_types: args.seat_types || '',
                  });
                } catch(e) {}
              }
            }
          }
        }
      }

      // --- 代码核查面板：基本信息 ---
      const planStatus = r.plan_status || '';
      let statusBadge = '';
      if (planStatus === 'no_plan') {
        statusBadge = '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;background:#fef2f2;color:#dc2626;margin-left:8px">无方案输出</span>';
      } else if (planStatus === 'empty_plan') {
        statusBadge = '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;background:#fefce8;color:#ca8a04;margin-left:8px">模型认为无解</span>';
      } else if (planStatus === 'has_solution') {
        statusBadge = '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;background:#f0fdf4;color:#16a34a;margin-left:8px">有方案</span>';
      }
      document.getElementById('eval-verify-panel').innerHTML = `
        <div style="padding:16px">
          <div style="margin-bottom:12px"><strong>已加载记录：</strong> ${r.question_id || '-'}${statusBadge}</div>
          <div><strong>用户需求：</strong> ${r.user_input || '-'}</div>
          <div><strong>模型回复：</strong> ${r.final_answer ? r.final_answer.substring(0, 300) + '...' : '-'}</div>
          <div style="margin-top:8px;color:var(--gray-4)">点击"代码核查"按钮验证回复真实性</div>
        </div>`;

      // --- 测试详情面板：token + 耗时 + 结构化换乘方案 ---
      const tu = r.token_usage || {};
      const dur = r.duration || 0;
      let statsHtml = `
        <div style="padding:16px">
          <div style="margin-bottom:16px;font-weight:600">📊 性能统计 ${statusBadge}</div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:20px">
            <div class="stat-card"><div class="stat-card-value">${tu.total_tokens || 0}</div><div class="stat-card-label">总 Token</div></div>
            <div class="stat-card"><div class="stat-card-value">${typeof dur === 'number' ? dur.toFixed(1) + 's' : dur + 's'}</div><div class="stat-card-label">运行时间</div></div>
            <div class="stat-card"><div class="stat-card-value">${tu.prompt_tokens || 0}</div><div class="stat-card-label">输入 Token</div></div>
            <div class="stat-card"><div class="stat-card-value">${tu.completion_tokens || 0}</div><div class="stat-card-label">输出 Token</div></div>
            <div class="stat-card"><div class="stat-card-value">${r.model_name || '-'}</div><div class="stat-card-label">模型</div></div>
            <div class="stat-card"><div class="stat-card-value">${r.timestamp || '-'}</div><div class="stat-card-label">时间</div></div>
          </div>`;

      // 结构化换乘方案 + 最终乘车方案
      const finalPlan = r.final_plan || [];

      // 工具查询记录
      if (toolRecords.length > 0) {
        statsHtml += `<div style="margin-bottom:8px;font-weight:600">🔧 工具查询记录</div>`;
        statsHtml += `<table class="table" style="font-size:var(--font-size-small)">`;
        statsHtml += `<thead><tr><th>#</th><th>车次</th><th>出发站</th><th>到达站</th><th>座位类型</th></tr></thead><tbody>`;
        toolRecords.forEach((t, i) => {
          statsHtml += `<tr><td>${i+1}</td><td>${t.train_num}</td><td>${t.from}</td><td>${t.to}</td><td>${t.seat_types || '-'}</td></tr>`;
        });
        statsHtml += `</tbody></table>`;
      } else {
        statsHtml += `<div style="color:var(--gray-4);margin-bottom:12px">未检测到工具调用记录</div>`;
      }

      // 最终乘车方案
      if (finalPlan.length > 0) {
        statsHtml += `<div style="margin-bottom:8px;font-weight:600;margin-top:12px">🎫 最终乘车方案</div>`;
        statsHtml += `<table class="table" style="font-size:var(--font-size-small)">`;
        statsHtml += `<thead><tr><th>#</th><th>车次</th><th>出发站</th><th>到达站</th><th>座位</th><th>票数</th><th>票价(元)</th></tr></thead><tbody>`;
        finalPlan.forEach((t, i) => {
          const priceStr = t.price !== undefined && t.price !== null ? t.price : '-';
          statsHtml += `<tr><td>${i+1}</td><td>${t.train_num}</td><td>${t.from_station_id}</td><td>${t.to_station_id}</td><td>${t.seat_type}</td><td>${t.tickets}</td><td>${priceStr}</td></tr>`;
        });
        statsHtml += `</tbody></table>`;
      }
      statsHtml += `</div>`;
      document.getElementById('eval-details-panel').innerHTML = statsHtml;

      this._evalVerifyResult = null;
      this._currentToolRecords = toolRecords;
      alert('记录已加载');
    } catch (e) {
      alert('加载失败: ' + e.message);
    }
  },

  /** 运行代码核查 */
  _runEvalVerify: async function() {
    if (!this._currentEvalRecord) { alert('请先加载测试记录'); return; }
    const r = this._currentEvalRecord;
    const panel = document.getElementById('eval-verify-panel');
    panel.innerHTML = '<div style="padding:20px;text-align:center">正在验证最终乘车方案...</div>';
    try {
      const qid = r.question_id || this.currentQuestionId || '';
      const finalPlan = r.final_plan || [];
      const verify = await API.verifyTickets(qid, finalPlan);
      this._evalVerifyResult = verify;
      let html = `<div style="padding:16px">`;

      // verdict 徽章
      const verdictMap = {
        'pass': { label: '✅ 全部通过', bg: '#f0fdf4', color: '#16a34a' },
        'hallucination': { label: '❌ 存在错误', bg: '#fef2f2', color: '#dc2626' },
        'empty_plan': { label: '⚠️ 最终方案为空', bg: '#f5f5f5', color: '#6b7280' },
        'no_plan': { label: '⚠️ 无可核查方案', bg: '#f5f5f5', color: '#6b7280' },
        'db_not_found': { label: '❌ 题目数据库不存在', bg: '#fef2f2', color: '#dc2626' },
      };
      const vInfo = verdictMap[verify.verdict] || { label: verify.verdict || '未知', bg: '#f5f5f5', color: '#6b7280' };
      const hasIssues = (verify.issues || []).length > 0;

      // 题型模式（分类按 type：存在性=对标标答 / 选择性=全程可达+行为约束）
      const modeMap = {
        '存在性': { label: '存在性问题 · 答案唯一（对标标答）', color: '#2563eb', bg: '#eff6ff' },
        '选择性': { label: '选择性问题 · 答案多个（全程可达+行为约束）', color: '#7c3aed', bg: '#f5f3ff' },
      };
      const modeInfo = modeMap[verify.question_mode] || { label: '题目类型未知', color: '#6b7280', bg: '#f3f4f6' };

      // ---- 问题类型元数据：标签 + 颜色 + 分组 ----
      const ISSUE_META = {
        'hallucination': { label: '余票不符', color: '#dc2626', group: '硬错误' },
        'price_wrong': { label: '票价不符', color: '#dc2626', group: '硬错误' },
        'route_mismatch': { label: '路线不符标答', color: '#dc2626', group: '硬错误' },
        'route_mismatch_train': { label: '车次不符', color: '#dc2626', group: '硬错误' },
        'route_mismatch_route': { label: '购买区间不符', color: '#dc2626', group: '硬错误' },
        'route_mismatch_seat': { label: '座位不符', color: '#dc2626', group: '硬错误' },
        'route_mismatch_ride': { label: '乘坐区间不符', color: '#dc2626', group: '硬错误' },
        'route_invalid': { label: '区间无效', color: '#dc2626', group: '硬错误' },
        'route_discontinuity': { label: '乘坐不连续', color: '#dc2626', group: '硬错误' },
        'transfer_time_conflict': { label: '换乘时间冲突', color: '#dc2626', group: '硬错误' },
        'start_not_covered': { label: '未连接出发站', color: '#dc2626', group: '硬错误' },
        'end_not_covered': { label: '未连接到达站', color: '#dc2626', group: '硬错误' },
        'no_route': { label: '无法构成全程', color: '#dc2626', group: '硬错误' },
        'no_transfer_violated': { label: '违反不允许换乘', color: '#dc2626', group: '硬错误' },
        'no_short_buy_violated': { label: '违反不允许买短补长', color: '#dc2626', group: '硬错误' },
        'no_extra_violated': { label: '违反不允许额外购买', color: '#dc2626', group: '硬错误' },
        'ticket_shortage': { label: '票数不足', color: '#f59e0b', group: '约束' },
        'price_missing': { label: '票价缺失', color: '#f59e0b', group: '约束' },
        'invalid_seat': { label: '无效座位', color: '#f59e0b', group: '格式' },
        'invalid_plan_item': { label: '无效条目', color: '#f59e0b', group: '格式' },
        'missing_ride': { label: '缺乘坐区间', color: '#f59e0b', group: '格式' },
      };
      const issueMeta = (t) => (ISSUE_META[t] || { label: t || '错误', color: '#dc2626', group: '硬错误' });

      // ---- 头部：verdict + 题型 ----
      html += `<div style="margin-bottom:12px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <span style="font-weight:600">🔍 代码核查结果</span>
        <span style="display:inline-block;padding:3px 12px;border-radius:12px;font-size:13px;font-weight:600;background:${vInfo.bg};color:${vInfo.color}">${vInfo.label}</span>
        <span style="display:inline-block;padding:3px 12px;border-radius:12px;font-size:12px;font-weight:600;background:${modeInfo.bg};color:${modeInfo.color}">${modeInfo.label}</span>
      </div>`;
      html += `<div style="margin-bottom:14px;padding:10px 14px;border-radius:6px;background:${hasIssues ? '#fef2f2' : '#f0fdf4'};color:${hasIssues ? 'var(--error-red)' : 'var(--success-green)'}">
        ${verify.summary || (hasIssues ? '存在核查问题' : '✅ 未发现问题')}
      </div>`;

      // ---- 统计卡：正确 + 各错误类型聚合（动态，不杂乱）----
      const countMap = {};
      (verify.issues || []).forEach(iss => { countMap[iss.type] = (countMap[iss.type] || 0) + 1; });
      const card = (val, label, color, bg) =>
        `<div style="background:${bg};padding:6px 12px;border-radius:8px;font-size:12px;text-align:center;min-width:64px">
           <div style="font-weight:700;font-size:17px;color:${color}">${val}</div>
           <div style="color:${color};opacity:.85;margin-top:2px">${label}</div>
         </div>`;
      html += `<div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap">`;
      html += card(verify.total_items || 0, '方案总数', '#374151', '#f3f4f6');
      html += card(verify.correct_items || 0, '余票通过', '#16a34a', '#f0fdf4');
      Object.entries(countMap).forEach(([typ, cnt]) => {
        const m = issueMeta(typ);
        html += card(cnt, m.label, m.color, `${m.color}14`);
      });
      if (!hasIssues && (verify.total_items || 0) > 0) html += card(0, '无问题', '#16a34a', '#f0fdf4');
      html += `</div>`;

      // ---- 按 (车次|购买起|购买止|座位) 关联每条问题到明细行 ----
      const keyOf = (o) => `${o.train_num || ''}|${o.from_station_id || o.from || ''}|${o.to_station_id || o.to || ''}|${o.seat_type || ''}`;
      const rowIssueMap = {};
      (verify.issues || []).forEach(iss => {
        if (!iss.train_num) return;
        const k = keyOf(iss);
        (rowIssueMap[k] = rowIssueMap[k] || []).push(iss.type);
      });

      // ---- 乘车方案明细表（购买 vs 乘坐 对照，逐项核对）----
      if ((verify.results || []).length > 0) {
        html += `<details style="margin:8px 0" open><summary style="cursor:pointer;font-weight:600;margin-bottom:8px">🚄 乘车方案明细（${verify.results.length} 段）</summary>`;
        html += `<table class="table" style="font-size:var(--font-size-small)">
          <thead><tr>
            <th>#</th><th>车次</th><th>购买区间</th><th>乘坐区间</th><th>座位</th>
            <th>票数<br>声称/实际</th><th>票价(元)<br>声称/实际</th><th>核对</th>
          </tr></thead><tbody>`;
        (verify.results || []).forEach((t, i) => {
          const rowIssues = rowIssueMap[keyOf(t)] || [];
          const ok = t.match === true && rowIssues.length === 0;
          const rowBg = rowIssues.length > 0 ? '#fef2f2' : (t.match === true ? '#f0fdf4' : '#fef2f2');
          const buySeg = `${t.from_name || t.from_station_id} → ${t.to_name || t.to_station_id}`;
          const rideSeg = (t.ride_from_name || t.ride_from_station_id)
            ? `${t.ride_from_name || t.ride_from_station_id} → ${t.ride_to_name || t.ride_to_station_id}` : '—';
          const rideDiff = (t.ride_from_station_id && t.ride_to_station_id &&
                            (t.ride_from_station_id !== t.from_station_id || t.ride_to_station_id !== t.to_station_id))
            ? ' <span style="color:#7c3aed;font-weight:600">买≠坐</span>' : '';
          let priceCell;
          if (t.price_match === true) priceCell = `${t.price_actual} ✅`;
          else if (t.price_match === false) priceCell = `${t.price_claimed}→${t.price_actual} ❌`;
          else if (t.price_claimed !== undefined && t.price_claimed !== null) priceCell = `${t.price_claimed} ❓`;
          else priceCell = '—';
          let rowTags = '';
          rowIssues.forEach(typ => {
            const m = issueMeta(typ);
            rowTags += `<span style="display:inline-block;margin:1px 3px 1px 0;padding:0 6px;border-radius:8px;font-size:11px;background:${m.color}18;color:${m.color};font-weight:600">${m.label}</span>`;
          });
          const actualTxt = (t.actual !== null && t.actual !== undefined) ? t.actual : 'N/A';
          html += `<tr style="background:${rowBg}">
            <td>${i+1}</td>
            <td>${t.train_num}</td>
            <td>${buySeg}${rideDiff}</td>
            <td>${rideSeg}</td>
            <td>${t.seat_type || '—'}</td>
            <td>${t.claimed}<span style="color:${t.match ? '#16a34a' : '#dc2626'};font-weight:600">/${actualTxt}</span></td>
            <td>${priceCell}</td>
            <td>${rowTags || (t.match ? '<span style="color:#16a34a;font-weight:600">✅ 正确</span>' : '<span style="color:#dc2626;font-weight:600">❌ 有误</span>')}</td>
          </tr>`;
        });
        html += `</tbody></table></details>`;
      } else {
        html += `<div style="color:var(--gray-4);margin:12px 0">⚠️ 测试记录中无可核查的购票段（模型可能未输出 final_plan）</div>`;
      }

      // ---- 问题清单：按严重度分组（硬错误 / 约束 / 格式）----
      if (hasIssues) {
        const groupTitles = { '硬错误': '🚫 硬错误（方案不可行）', '约束': '⚠️ 约束不满足', '格式': '📝 格式 / 缺失' };
        Object.entries(groupTitles).forEach(([g, title]) => {
          const items = (verify.issues || []).filter(i => issueMeta(i.type).group === g);
          if (!items.length) return;
          html += `<div style="margin-top:14px"><strong>${title}（${items.length} 项）</strong></div>`;
          items.forEach((issue) => {
            const m = issueMeta(issue.type);
            html += `<div style="padding:8px 10px;margin:4px 0;background:#fef2f2;border-radius:6px;font-size:var(--font-size-small);border-left:3px solid ${m.color}">
              <span style="color:${m.color};font-weight:600">[${m.label}]</span> ${issue.detail || ''}</div>`;
          });
        });
      }
      html += `</div>`;
      panel.innerHTML = html;
    } catch (e) {
      panel.innerHTML = `<div style="padding:20px;color:var(--error-red)">核查失败: ${e.message}</div>`;
    }
  },

  /** 保存测评结果 */
  _saveEvalResult: async function() {
    if (!this._currentEvalRecord) { alert('请先加载测试记录'); return; }
    const r = this._currentEvalRecord;
    const tu = r.token_usage || {};
    const dur = r.duration || 0;

    // 核查统计
    const verify = this._evalVerifyResult || {};
    const hallucinationCount = verify.hallucination_count || 0;
    const issueCount = verify.issue_count || 0;

    try {
      const result = await API.evalComplete({
        question_id: r.question_id || '',
        model_name: r.model_name || 'unknown',
        user_input: r.user_input || '',
        test_file: this._currentEvalFilename || '',
        score_summary: {
          hallucination_count: hallucinationCount,
          issue_count: issueCount,
          total_tokens: tu.total_tokens || 0,
          duration_seconds: dur,
          tool_calls: this._currentToolRecords || [],
        },
        verification: verify,
        human_confirmed: true,
        human_notes: '',
      });
      if (result.success) {
        alert(`测评结果已保存: ${result.message}\n错误数: ${hallucinationCount} | Token: ${tu.total_tokens || 0}`);
      } else {
        alert('保存失败: ' + (result.detail || '未知错误'));
      }
    } catch (e) {
      alert('保存失败: ' + e.message);
    }
  },
  initStats: async function() {
    const exportJsonBtn = document.getElementById('btn-export-json');
    if (exportJsonBtn) {
      exportJsonBtn.onclick = async () => {
        const report = await API.exportJsonReport();
        const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `benchmark_report_${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
      };
    }

    const exportMdBtn = document.getElementById('btn-export-md');
    if (exportMdBtn) {
      exportMdBtn.onclick = async () => {
        const md = await API.exportMarkdownReport();
        const blob = new Blob([md], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `benchmark_report_${Date.now()}.md`;
        a.click();
        URL.revokeObjectURL(url);
      };
    }

    const refreshBtn = document.getElementById('btn-refresh-stats');
    if (refreshBtn) {
      refreshBtn.onclick = () => this._loadStats();
    }

    await this._loadStats();
  },

  /** 加载统计数据 */
  _loadStats: async function() {
    try {
      const data = await API.getStatsSummary();

      // 更新统计卡片
      const summary = data.summary || {};
      const statContainer = document.getElementById('stat-cards');
      if (statContainer) {
        statContainer.innerHTML = `
          <div class="stat-card"><div class="stat-card-value">${data.total_tests || 0}</div><div class="stat-card-label">总测试数</div></div>
          <div class="stat-card"><div class="stat-card-value">${summary.avg_score || 0}</div><div class="stat-card-label">平均分</div></div>
          <div class="stat-card"><div class="stat-card-value">${summary.pass_rate || 0}%</div><div class="stat-card-label">通过率</div></div>
          <div class="stat-card"><div class="stat-card-value">${summary.error_rate || 0}%</div><div class="stat-card-label">错误率</div></div>
          <div class="stat-card"><div class="stat-card-value">${summary.completion_rate || 0}%</div><div class="stat-card-label">完成率</div></div>
        `;
      }

      // 渲染模型对比表格
      const tableContainer = document.getElementById('model-comparison-table');
      if (tableContainer && data.models) {
        let html = '<table class="table"><thead><tr><th>模型</th><th>测试数</th><th>通过率</th><th>错误率</th><th>未规划/空</th><th>平均分</th><th>平均Token</th><th>平均耗时</th></tr></thead><tbody>';
        for (const [name, stats] of Object.entries(data.models)) {
          html += `<tr>
            <td><strong>${name}</strong></td>
            <td>${stats.total_tests}</td>
            <td>${stats.pass_rate}%</td>
            <td>${stats.error_rate}%</td>
            <td>${(stats.no_plan_count || 0) + (stats.empty_count || 0)}</td>
            <td>${stats.avg_score}</td>
            <td>${stats.avg_tokens}</td>
            <td>${stats.avg_duration}s</td>
          </tr>`;
        }
        html += '</tbody></table>';
        tableContainer.innerHTML = html;
      }

      // 问题类型分布（全局 top10）
      const issueCounts = summary.issue_type_counts || {};
      const issueLabels = {
        'hallucination': '余票不符', 'price_wrong': '票价不符', 'route_mismatch': '路线不符标答',
        'route_mismatch_train': '车次不符', 'route_mismatch_route': '购买区间不符',
        'route_mismatch_seat': '座位不符', 'route_mismatch_ride': '乘坐区间不符',
        'route_invalid': '区间无效', 'route_discontinuity': '乘坐不连续',
        'transfer_time_conflict': '换乘时间冲突', 'start_not_covered': '未连接出发站',
        'end_not_covered': '未连接到达站', 'no_route': '无法构成全程',
        'no_transfer_violated': '违反不允许换乘',
        'ticket_shortage': '票数不足', 'price_missing': '票价缺失',
        'missing_ride': '缺乘坐区间', 'invalid_seat': '无效座位', 'invalid_plan_item': '无效条目',
      };
      const issueEntries = Object.entries(issueCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
      const issueContainer = document.getElementById('issue-distribution');
      if (issueContainer) {
        issueContainer.innerHTML = issueEntries.length
          ? issueEntries.map(([t, c]) => {
              const label = issueLabels[t] || t;
              return `<span style="display:inline-block;margin:2px 6px 2px 0;padding:2px 10px;border-radius:10px;background:#f3f4f6;font-size:12px">${label} ×${c}</span>`;
            }).join('')
          : '<span style="color:var(--gray-4);font-size:12px">暂无问题数据</span>';
      }

      // 渲染结论
      if (data.models) {
        const ranking = Object.entries(data.models)
          .sort((a, b) => b[1].avg_score - a[1].avg_score)
          .map(([name, s], i) => `${i + 1}. ${name} (平均分 ${s.avg_score})`);

        const insightsContainer = document.getElementById('insights');
        if (insightsContainer) {
          insightsContainer.innerHTML = ranking.map(r => `<div>🏆 ${r}</div>`).join('');
        }
      }

    } catch (e) {
      console.error('加载统计数据失败:', e);
    }
  },
};

// ============================================================
// 页面加载完成后初始化
// ============================================================
document.addEventListener('DOMContentLoaded', function() {
  App.init();
});