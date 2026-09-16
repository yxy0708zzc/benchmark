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
  /** 测试页轨迹视图：结构化消息序列 + 视图开关 */
  _trace: [],
  _traceView: false,
  _traceRenderTimer: null,
  /** 初始化应用 */
  init: function() {
    // 模型/API 配置统一来自服务端 .env（前端不再存 localStorage）
    // 页面加载后立即更新模型状态显示（影响顶部栏和侧边栏）
    this._updateModelStatusDisplay();
    this._setupEventListeners();

    // 根据 URL 路径切换到对应页面
    this._routeFromPath(window.location.pathname);

    // 浏览器前进/后退：按 URL 同步页面（不 pushState，避免历史堆栈继续增长；
    // 修复：原实现无 popstate 处理，后退键 URL 变了页面不变）
    window.addEventListener('popstate', () => {
      this._routeFromPath(window.location.pathname);
    });
  },

  /** URL 路径 → 页面名 并切换（init 与 popstate 共用） */
  _routeFromPath: function(path) {
    const pageMap = {
      '/': 'test',
      '/index.html': 'test',
      '/batch_question': 'batch-question',
      '/batch_nl_question': 'batch-nl-question',
      '/batch_test_question': 'batch-test-question',
      '/edit_question': 'edit-question',
      '/question_manager': 'question-manager',
      '/stats': 'stats',
      '/eval': 'eval',
      '/eval_manage': 'eval-manage',
      '/test_manage': 'test-manage',
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
        'batch-question': '/batch_question',
        'batch-nl-question': '/batch_nl_question',
        'batch-test-question': '/batch_test_question',
        'question-manager': '/question_manager',
        'stats': '/stats',
        'eval': '/eval',
        'eval-manage': '/eval_manage',
        'test-manage': '/test_manage',
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
        case 'eval-manage':
          this.initEvalManage();
          break;
        case 'test-manage':
          this.initTestManage();
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
    const page = document.querySelector('#page-test');
    if (page?.dataset.initialized) {
      // 二次进入不重复绑事件，但刷新题目列表（批量出题/改题后切回来能看到新题）
      this._loadQuestionList();
      return;
    }
    page.dataset.initialized = '1';

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
    // 顶栏显示 .env 解析后的测试模型名（TEST_MODEL → DEFAULT_MODEL），不含 key
    fetch('/api/env/model').then(r => r.json()).then(j => {
      const name = j.test_model || '.env 配置';
      document.querySelectorAll('.test-model-status').forEach(el => {
        el.textContent = `● ${name}`;
        el.style.color = '#22c55e';
      });
      // 批量测试输入框默认填入同一模型名（避免手填错模型导致平台报"key 无效"）
      const inp = document.getElementById('batch-test-model');
      if (inp && !inp.value.trim() && j.test_model) inp.value = j.test_model;
    }).catch(() => {
      document.querySelectorAll('.test-model-status').forEach(el => {
        el.textContent = '● .env 配置';
        el.style.color = '#22c55e';
      });
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
      const data = await API.getQuestionList({ type, keyword });
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

    // 轨迹数据：user 条目 + 按对话轮次拆分的 assistant 条目（每轮挂自己的工具调用）
    this._trace.push({ kind: 'user', content: text });
    let curTrace = { kind: 'assistant', content: '', reasoning: '', tools: [] };
    this._trace.push(curTrace);
    let sawToolResult = false;  // 工具结果返回后，下一个 token/tool_call 开启新一轮
    if (this._traceView) this._renderTrace();

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
    let toolCallsList = curTrace.tools;  // 引用当前轮轨迹条目的工具数组，流式同步

    /** 开启新一轮：新轨迹条目 + 新聊天消息卡 */
    const newRound = () => {
      curTrace = { kind: 'assistant', content: '', reasoning: '', tools: [] };
      this._trace.push(curTrace);
      toolCallsList = curTrace.tools;
      fullContent = '';
      fullReasoning = '';
      sawToolResult = false;
      container.insertAdjacentHTML('beforeend', Components.renderMessage('assistant', '<span style="color:var(--gray-4)">思考中...</span>', [], ''));
      this._scrollChatToBottom();
    };

    /** 更新最后一条助手消息的显示内容（保留展开/折叠状态）
     *  plain=true：流式期间纯文本渲染；plain=false：完成后用 marked 渲染 Markdown */
    const updateMsg = (cursor = false, plain = true) => {
      // 光标不再拼进 content（会被 plain 路径的 _escapeHtml 转成字面 HTML 源码文本），
      // 改为渲染完成后单独追加到 .message-content 尾部
      const displayContent = fullContent;
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
      // 流式光标：渲染/转义之后再追加，避免被转义成可见源码（修复：每次流式输出尾部显示 HTML 源码）
      if (cursor) {
        const curMsg = container.lastElementChild;
        const body = curMsg && curMsg.querySelector('.message-content');
        if (body) body.insertAdjacentHTML('beforeend', '<span style="color:var(--gray-4)">▌</span>');
      }
      this._scrollChatToBottom();

      // 轨迹视图同步（可见时节流重绘）
      curTrace.content = fullContent;
      curTrace.reasoning = fullReasoning;
      if (this._traceView) {
        if (this._traceRenderTimer) clearTimeout(this._traceRenderTimer);
        this._traceRenderTimer = setTimeout(() => { if (this._traceView) this._renderTrace(); }, 300);
      }
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
                if (sawToolResult) newRound();  // 工具结果后的思考 → 新一轮
                fullReasoning += evt.content || '';
                break;

              case 'token':
                if (sawToolResult) newRound();  // 工具结果后的文本 → 新一轮
                fullContent += evt.content || '';
                updateMsg(true, true);  // 显示光标（纯文本）
                break;

              case 'tool_call':
                if (sawToolResult) newRound();  // 工具结果后的新工具调用 → 新一轮
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
                sawToolResult = true;  // 下一个 token/tool_call 开启新一轮
                updateMsg(false, true);
                break;

              case 'done':
                // 前端已通过 token 事件累加完整内容，不再用 evt.content 覆盖
                doneCalled = true;
                updateMsg(false, false);  // 移除光标，最终用 marked 渲染
                break;

              case 'error':
                fullContent = '错误: ' + (evt.content || '未知错误');
                toolCallsList.length = 0;
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
        // 用户中止：收尾占位消息，避免永久停留在"思考中..."（修复：原实现直接 return）
        doneCalled = true;
        if (!fullContent) {
          fullContent = '（已中止）';
          toolCallsList.length = 0;
        }
        updateMsg(false, true);
        return;
      }
      if (!doneCalled) {
        fullContent = `请求失败: ${e.message}`;
        toolCallsList.length = 0;
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

  // ============================================================
  // 轨迹视图（harness 风格：消息/工具逐行排列，点击行右侧抽屉看详情）
  // ============================================================
  _escHtml: function(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  },

  /** HTML 属性转义（onclick 内嵌参数：防引号截断） */
  _escAttr: function(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  },

  /** 单行摘要：去换行、截断 */
  _traceSummary: function(text, n = 80) {
    const s = String(text ?? '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.substring(0, n) + '…' : (s || '—');
  },

  /** 切换对话/轨迹视图 */
  _switchChatView: function(mode) {
    this._traceView = mode === 'trace';
    const msgs = document.getElementById('chat-messages');
    const trace = document.getElementById('chat-trace');
    if (msgs) msgs.style.display = this._traceView ? 'none' : '';
    if (trace) trace.style.display = this._traceView ? '' : 'none';
    const bChat = document.getElementById('btn-view-chat');
    const bTrace = document.getElementById('btn-view-trace');
    if (bChat) bChat.style.opacity = this._traceView ? '.55' : '1';
    if (bTrace) bTrace.style.opacity = this._traceView ? '1' : '.55';
    if (this._traceView) this._renderTrace();
  },

  /** 全量重绘轨迹视图（行数少，成本低；每行可点击开详情抽屉） */
  _renderTrace: function() {
    const box = document.getElementById('chat-trace');
    if (!box) return;
    box.innerHTML = '';
    const frag = document.createDocumentFragment();

    const mkRow = (icon, badge, badgeColor, summary, clickAttr, indent) => {
      const row = document.createElement('div');
      row.setAttribute('onclick', clickAttr);
      row.style.cssText = `display:flex;align-items:center;gap:8px;padding:5px 8px;margin:2px 0;border-radius:6px;cursor:pointer;` +
        `border-left:3px solid ${badgeColor};background:#fafafa;user-select:none;${indent ? 'margin-left:22px;' : ''}`;
      row.onmouseenter = () => { row.style.background = '#f0f0f0'; };
      row.onmouseleave = () => { row.style.background = '#fafafa'; };
      row.innerHTML = `<span style="font-size:14px">${icon}</span>` +
        `<span style="flex-shrink:0;padding:1px 8px;border-radius:10px;font-size:11px;font-weight:600;color:#fff;background:${badgeColor}">${badge}</span>` +
        `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--gray-5)">${this._escHtml(summary)}</span>`;
      return row;
    };

    let round = 0;  // 对话轮次计数（每个 assistant 条目为一轮）
    this._trace.forEach((m, idx) => {
      if (m.kind === 'user') {
        frag.appendChild(mkRow('👤', 'USER', '#2563eb', this._traceSummary(m.content), `App._openTraceDetail('user',${idx})`, false));
      } else {
        round += 1;
        const asstSummary = m.content ? this._traceSummary(m.content)
          : (m.reasoning ? '💭 思考中…' : '⏳ 思考中...');
        frag.appendChild(mkRow('🤖', `ASSISTANT · 第${round}轮`, '#16a34a', asstSummary, `App._openTraceDetail('assistant',${idx})`, false));
        (m.tools || []).forEach((t, ti) => {
          const status = t._pending ? '⏳ 执行中' : '✅';
          const argsSummary = this._traceSummary(JSON.stringify(t.arguments ?? {}), 60);
          frag.appendChild(mkRow('🔧', 'TOOL', '#d97706',
            `${t.tool_name} ${status} · ${argsSummary}`,
            `App._openTraceDetail('tool',${idx},${ti})`, true));
        });
      }
    });

    if (!this._trace.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:var(--gray-4);text-align:center;padding:24px';
      empty.textContent = '暂无轨迹（发送消息后此处按 harness 轨迹方式逐行展示对话与工具调用）';
      frag.appendChild(empty);
    }
    box.appendChild(frag);
    box.scrollTop = box.scrollHeight;
  },

  /** 打开轨迹行详情抽屉 */
  _openTraceDetail: function(kind, idx, toolIdx) {
    const m = this._trace[idx];
    if (!m) return;
    const drawer = document.getElementById('trace-drawer');
    const title = document.getElementById('trace-drawer-title');
    const body = document.getElementById('trace-drawer-body');
    if (!drawer || !title || !body) return;

    const esc = this._escHtml;
    const pre = (obj) => `<pre style="white-space:pre-wrap;word-break:break-all;background:#fafafa;border:1px solid var(--gray-2);border-radius:6px;padding:8px;font-family:Consolas,monospace;font-size:12px;margin:4px 0 10px">${esc(obj)}</pre>`;
    const secTitle = (t) => `<div style="font-weight:600;margin:10px 0 2px">${t}</div>`;

    if (kind === 'user') {
      title.textContent = '👤 用户消息';
      body.innerHTML = pre(m.content);
    } else if (kind === 'assistant') {
      title.textContent = '🤖 助手消息';
      let html = '';
      if (m.reasoning) html += secTitle('💭 思考链') + pre(m.reasoning);
      html += secTitle('📝 回复内容');
      try { html += `<div class="message-content">${Components._formatContent(m.content || '')}</div>`; }
      catch (e) { html += pre(m.content); }
      if ((m.tools || []).length) html += secTitle(`🔧 本轮工具调用（${m.tools.length}）`);
      body.innerHTML = html;
    } else {
      const t = (m.tools || [])[toolIdx];
      if (!t) return;
      title.textContent = `🔧 工具调用：${t.tool_name}`;
      body.innerHTML =
        secTitle('状态') + (t._pending ? '⏳ 执行中' : '✅ 已完成') +
        secTitle('输入参数') + pre(JSON.stringify(t.arguments ?? {}, null, 2)) +
        secTitle('返回结果') + pre(JSON.stringify(t.result ?? {}, null, 2));
    }
    drawer.style.display = 'flex';
  },

  /** 关闭轨迹详情抽屉 */
  _closeTraceDrawer: function() {
    const drawer = document.getElementById('trace-drawer');
    if (drawer) drawer.style.display = 'none';
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

      // 调用计数：模型调用 = LLM API 请求轮数；工具调用 = 各轮工具总和
      if (result.model_calls != null) summaryParts.push(`模型调用: ${result.model_calls} 次`);
      if (result.tool_calls != null) summaryParts.push(`工具调用: ${result.tool_calls} 次`);

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
      // 轨迹同步清空
      this._trace = [];
      if (this._traceView) this._renderTrace();
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

    // 车次输入框回车触发加载（dataset 防重复绑定：原实现每次进页叠加一个监听器，
    // 进 N 次后按一次 Enter 触发 N 次加载）
    const trainInput = document.getElementById('edit-train-input');
    if (trainInput && !trainInput.dataset.enterBound) {
      trainInput.dataset.enterBound = '1';
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
        opt.textContent = q.question_id;  // status 概念已移除，不再拼接状态后缀
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
    // status 概念已移除：出题保存即完成，无需再调 /api/question/complete
    const confirmMsg = isEdit
      ? `题目 ${qid} 当前配置已生效，确认无误？`
      : `确认保存题目 ${qid}？保存后自动创建新题目。`;
    if (confirm(confirmMsg)) {
      if (isEdit) {
        alert(`题目 ${qid} 已确认（保存即完成）`);
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

    // 密度滑块联动（干扰=存在性 1_ / 随机票=选择性 2_）
    [['batch-density-interference', 'batch-density-interference-label'], ['batch-density-random', 'batch-density-random-label']].forEach(([sliderId, labelId]) => {
      const slider = document.getElementById(sliderId);
      const label = document.getElementById(labelId);
      if (slider && label) {
        slider.oninput = function() {
          label.textContent = parseFloat((this.value * 100).toFixed(3)) + '%';
        };
      }
    });

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
    const nlStop = document.getElementById('btn-batch-nl-stop');
    if (nlStop) nlStop.onclick = () => this._stopBatchNl();
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

    // 模型编号留空时自动填 .env 的 TEST_MODEL（避免手填错模型名导致平台报"key 无效"）
    fetch('/api/env/model').then(r => r.json()).then(j => {
      const inp = document.getElementById('batch-test-model');
      if (inp && !inp.value.trim() && j.test_model) inp.value = j.test_model;
    }).catch(() => {});

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
      interference_density: parseFloat(document.getElementById('batch-density-interference')?.value || '0.02'),
      random_tickets_density: parseFloat(document.getElementById('batch-density-random')?.value || '0.02'),
      max_retries: parseInt(document.getElementById('batch-max-retries')?.value || '40', 10) || 40,
    };
    // 注：批量自然语言化已独立成框（/api/batch_nl/*），不再内嵌于批量出题请求

    this._resetBatchProgress();
    const count = document.getElementById('batch-total-count');
    if (count) count.textContent = `0 / ${totalCount}`;

    try {
      const result = await API.batchGenerate(payload);
      if (!result.success) { alert(`批量出题启动失败: ${result.detail || '未知错误'}`); this._resetBatchProgress(); return; }
      this._pollBatchStatus();
    } catch (e) {
      alert(`批量出题启动失败: ${e.message}`);
      this._resetBatchProgress();
    }
  },

  /** 轮询批量状态，更新单进度条与日志（skipLogReplay/resumeMode 见 _startBatchPoll） */
  _pollBatchStatus: function(skipLogReplay, resumeMode) {
    this._startBatchPoll('batch_generate', (seq) => API.batchStatus(seq), 'batch-gen-log',
      (status) => {
        this._renderBatchProgress(status);
        if (status.running) this._batchGenWasRunning = true;
      },
      (status) => {
        this._renderBatchResult(status.result);
        // 任务在本页面会话中运行结束后，弹窗提示失败题目数
        const failed = status.result?.summary?.failed;
        if (this._batchGenWasRunning && typeof failed === 'number') {
          alert(`批量出题结束\n失败题目数：${failed}`);
        }
        this._batchGenWasRunning = false;
      },
      { skipLogReplay, resumeMode });
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
  _batchLogSeqs: { batch_generate: 0, batch_nl: 0, batch_test: 0, batch_eval: 0 },
  // 各任务轮询进行中标志（防止多条轮询链并行）
  _batchGenPolling: false,
  _batchNlPolling: false,
  _batchTestPolling: false,
  _batchEvalPolling: false,
  // 批量出题任务在本页面会话中处于运行态（结束时据此弹窗提示失败数）
  _batchGenWasRunning: false,
  // 轮询令牌：每次启动新链自增，旧链发现令牌不符自动退出（根治"进页面后立刻启动任务"的竞态）
  _batchPollTokens: { batch_generate: 0, batch_nl: 0, batch_test: 0, batch_eval: 0 },

  /**
   * 通用批量轮询启动器（含增量日志；新链启动自动作废旧链）
   * @param job 任务名（batch_generate/batch_nl/batch_test/batch_eval）
   * @param fetcher (afterSeq) => Promise<status>
   * @param logId 日志容器 ID
   * @param renderFn (status)=>void 进度渲染回调
   * @param onDoneFn (status)=>void 任务完成回调（可空）
   * @param opts {skipLogReplay, resumeMode}：resumeMode 时任务已结束则仅同步游标不渲染
   */
  _startBatchPoll: function(job, fetcher, logId, renderFn, onDoneFn, opts = {}) {
    const flag = { batch_generate: '_batchGenPolling', batch_nl: '_batchNlPolling', batch_test: '_batchTestPolling', batch_eval: '_batchEvalPolling' }[job];
    const interval = { batch_generate: 500, batch_nl: 600, batch_test: 800, batch_eval: 600 }[job];
    this._batchPollTokens[job] = (this._batchPollTokens[job] || 0) + 1;
    const token = this._batchPollTokens[job];
    this[flag] = true;
    const alive = () => this._batchPollTokens[job] === token;
    let warmupTicks = 0;   // 后端已受理但 worker 尚未置 running 的预热期计数（防意外死循环）
    let pollErrors = 0;    // 连续失败计数（网络故障/回调异常达到上限即停止，防死循环刷屏）
    const tick = async () => {
      if (!alive()) return;
      try {
        const status = await fetcher(this._batchLogSeqs[job] || 0);
        if (!alive()) return;
        if (opts.resumeMode && !status.running) {
          // 上一次任务已完成：刷新后不恢复旧进度条与结果，仅同步日志游标
          this[flag] = false;
          this._appendBatchLog(logId, job, status.logs, true);
          return;
        }
        pollErrors = 0;
        try {
          renderFn(status);
        } catch (err) {
          // 渲染回调异常不进入轮询重试路径（原实现会落进下方 catch 变成无限重试）
          console.error(job + ' 进度渲染失败:', err);
        }
        this._appendBatchLog(logId, job, status.logs, opts.skipLogReplay);
        if (status.running) { setTimeout(tick, interval); }
        else if (!status.done && warmupTicks < 30) {
          // 启动竞态兜底：请求已受理但 worker 尚未标记 running，继续轮询等待（约 18s 上限）
          warmupTicks += 1;
          setTimeout(tick, interval);
        }
        else {
          this[flag] = false;
          if (status.done && onDoneFn) {
            try { onDoneFn(status); } catch (err) { console.error(job + ' 完成回调失败:', err); }
          }
        }
      } catch (e) {
        if (!alive()) return;
        pollErrors += 1;
        console.error(job + ' 进度轮询失败:', e);
        if (pollErrors > 30) {
          // 连续失败上限（后端宕机/持续异常），停止轮询防止每 0.5s 一次的死循环
          this[flag] = false;
          this._appendBatchLog(logId, job, { items: [{ seq: 0, t: '', level: 'error', msg: '进度轮询连续失败，已停止（请检查服务后刷新页面）' }] }, false);
          return;
        }
        setTimeout(tick, interval);
      }
    };
    tick();
  },

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

  /** 手动清空某批量面板：进度条、计数、当前任务、日志、结果卡（任务运行中不允许） */
  _clearBatchPanel: function(job) {
    const polling = { batch_generate: '_batchGenPolling', batch_nl: '_batchNlPolling', batch_test: '_batchTestPolling', batch_eval: '_batchEvalPolling' }[job];
    if (this[polling]) { alert('任务正在运行中，请等待完成后再清空'); return; }
    const map = {
      batch_generate: { bar: 'batch-total-bar', count: 'batch-total-count', cur: 'batch-current-task', log: 'batch-gen-log', result: 'batch-result' },
      batch_nl:       { bar: 'batch-nl-bar',      count: 'batch-nl-count',      cur: 'batch-nl-current',      log: 'batch-nl-log',      result: 'batch-nl-result' },
      batch_test:     { bar: 'batch-test-bar',    count: 'batch-test-count',    cur: 'batch-test-current',    log: 'batch-test-log',    result: 'batch-test-result' },
      batch_eval:     { bar: 'batch-eval-bar',    count: 'batch-eval-count',    cur: 'batch-eval-current',    log: 'batch-eval-log',    result: 'batch-eval-result' },
    }[job];
    if (!map) return;
    const bar = document.getElementById(map.bar);
    if (bar) bar.style.width = '0%';
    const count = document.getElementById(map.count);
    if (count) count.textContent = '0 / 0';
    const cur = document.getElementById(map.cur);
    if (cur) cur.textContent = '尚未开始';
    const res = document.getElementById(map.result);
    if (res) { res.style.display = 'none'; res.innerHTML = ''; }
    if (job === 'batch_generate') {
      const btnReport = document.getElementById('btn-batch-report');
      if (btnReport) btnReport.style.display = 'none';
    }
    this._resetBatchLog(map.log, job);
  },

  /** 进入页面时恢复轮询：仅当服务端任务仍在运行时恢复（刷新后不再恢复已完成的进度条/结果）。
   *  首次拉取仅同步日志游标（不回放旧日志，前端只显示之后新出现的日志） */
  _resumeBatchPolling: function(job) {
    const flag = { batch_generate: '_batchGenPolling', batch_nl: '_batchNlPolling', batch_test: '_batchTestPolling', batch_eval: '_batchEvalPolling' }[job];
    if (this[flag]) return;
    const start = {
      batch_generate: () => this._pollBatchStatus(true, true),
      batch_nl: () => this._pollBatchNlStatus(true, true),
      batch_test: () => this._pollBatchTestStatus(true, true),
      batch_eval: () => this._pollBatchEvalStatus(true, true),
    }[job];
    if (start) start();
  },

  /** 渲染批量结果 + 显示回执下载按钮 */
  _renderBatchResult: function(result) {
    const container = document.getElementById('batch-result');
    if (!container) return;
    result = result || {};
    const s = result.summary || {};   // 任务异常结束时可能缺 summary，兜底防 TypeError
    container.style.display = 'block';
    let html = '<div class="card"><div class="card-header">📋 批量出题结果</div>';
    html += `<div style="display:flex;gap:16px;padding:8px 0;font-size:var(--font-size-small)">
      <div><strong>总题数：</strong>${s.total ?? 0}</div>
      <div style="color:var(--success-green)"><strong>成功：</strong>${s.success ?? 0}</div>
      <div style="color:var(--error-red)"><strong>失败：</strong>${s.failed ?? 0}</div>
    </div>`;
    const nl = s;
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
    if ((s.failed ?? 0) > 0) {
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

  /** 开始批量自然语言化（并发 1~20 可调，复用批量测试的线程池模式） */
  _startBatchNl: async function() {
    if (!this.batchNlSelected.size) { alert('未勾选任何题目'); return; }
    const concurrency = Math.max(1, Math.min(parseInt(document.getElementById('batch-nl-concurrency')?.value || '5', 10) || 5, 20));
    try {
      const res = await API.batchNlGenerate({ question_ids: [...this.batchNlSelected], concurrency });
      if (!res.success) { alert(`启动失败: ${res.detail || '未知错误'}`); return; }
      this._resetBatchNlProgress();
      this._pollBatchNlStatus();
    } catch (e) { alert(`启动失败: ${e.message}`); }
  },

  /** 停止正在运行的批量自然语言化（剩余题目跳过，已生成的保留） */
  _stopBatchNl: async function() {
    if (!this._batchNlPolling) { alert('当前没有运行中的批量自然语言化任务'); return; }
    if (!confirm('确认停止批量自然语言化？\n进行中的请求完成后终止，剩余题目跳过（已生成的结果保留）。')) return;
    try {
      const res = await API.batchNlStop();
      if (!res.success) { alert(res.message || '停止失败'); return; }
      const box = document.getElementById('batch-nl-log');
      if (box) this._appendBatchLog('batch-nl-log', 'batch_nl', { items: [{ t: new Date().toTimeString().substring(0, 8), level: 'warn', msg: '⏹ 已请求停止，剩余题目将跳过' }], last_seq: this._batchLogSeqs['batch_nl'] || 0 });
    } catch (e) { alert(`停止失败: ${e.message}`); }
  },

  /** 轮询批量自然语言化进度（含增量日志；skipLogReplay/resumeMode 见 _startBatchPoll） */
  _pollBatchNlStatus: function(skipLogReplay, resumeMode) {
    this._startBatchPoll('batch_nl', (seq) => API.batchNlStatus(seq), 'batch-nl-log',
      (status) => this._renderBatchNlProgress(status),
      (status) => { if (status.done) this._renderBatchNlResult(status.result); },
      { skipLogReplay, resumeMode });
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
    const stopBtn = document.getElementById('btn-batch-nl-stop');
    if (stopBtn) stopBtn.style.display = 'none';
    this._resetBatchLog('batch-nl-log', 'batch_nl');
  },

  _renderBatchNlProgress: function(status) {
    const bar = document.getElementById('batch-nl-bar');
    if (bar) bar.style.width = status.total ? `${Math.round((status.done_count / status.total) * 100)}%` : '0%';
    const count = document.getElementById('batch-nl-count');
    if (count) count.textContent = `${status.done_count || 0} / ${status.total || 0}`;
    const cur = document.getElementById('batch-nl-current');
    if (cur) cur.textContent = status.current || '';
    const stopBtn = document.getElementById('btn-batch-nl-stop');
    if (stopBtn) stopBtn.style.display = status.running ? '' : 'none';
  },

  _renderBatchNlResult: function(result) {
    const container = document.getElementById('batch-nl-result');
    if (!container) return;
    container.style.display = 'block';
    const s = result.summary || {};
    let html = '<div class="card"><div class="card-header">📋 批量自然语言化结果</div>';
    html += `<div style="display:flex;gap:16px;padding:8px 0;font-size:var(--font-size-small);flex-wrap:wrap">
      <div><strong>总数：</strong>${s.total}</div>
      <div style="color:var(--success-green)"><strong>生成成功：</strong>${s.generated}</div>
      <div style="color:var(--error-red)"><strong>失败：</strong>${s.failed}</div>
      <div style="color:var(--gray-4)"><strong>跳过：</strong>${s.skipped}</div>
      ${s.concurrency ? `<div style="color:#0891b2"><strong>并发：</strong>${s.concurrency}</div>` : ''}
    </div>`;
    if (s.stopped) html += `<div style="color:#d97706;font-size:var(--font-size-small);padding-bottom:6px">⏹ 任务被手动停止：剩余题目已跳过，已生成的结果保留</div>`;
    if (result.error) html += `<div style="color:var(--error-red);font-size:var(--font-size-small);padding-bottom:6px">${result.error}</div>`;
    if (result.details && result.details.length) {
      html += '<div style="max-height:220px;overflow-y:auto;font-size:var(--font-size-small)"><table class="table" style="width:100%"><thead><tr><th>题号</th><th>结果</th></tr></thead><tbody>';
      result.details.forEach(d => {
        const outcome = d.ok ? '✅ 已生成' : (d.error === '已停止，跳过' ? '⏹ 已停止，跳过' : `❌ ${d.error || '失败'}`);
        html += `<tr><td>${d.question_id}</td>
          <td style="color:${d.ok ? 'var(--success-green)' : (d.error === '已停止，跳过' ? '#d97706' : 'var(--error-red)')}">${outcome}</td></tr>`;
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
    // 模型自动取 .env TEST_MODEL（输入框只读展示；留空由后端回落解析）
    const model = document.getElementById('batch-test-model')?.value.trim() || '';
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
    // 模型自动取 .env TEST_MODEL（输入框只读展示；留空由后端回落解析）
    const model = document.getElementById('batch-test-model')?.value.trim() || '';
    const maxIter = parseInt(document.getElementById('batch-test-max-iter')?.value || '30', 10) || 30;
    const concurrency = parseInt(document.getElementById('batch-test-concurrency')?.value || '1', 10) || 1;
    try {
      const res = await API.batchTestStart({ model, question_ids: [...this.batchTestSelected], max_iterations: maxIter, concurrency });
      if (!res.success) { alert(`启动失败: ${res.detail || '未知错误'}`); return; }
      this._resetBatchTestProgress();
      this._pollBatchTestStatus();
    } catch (e) { alert(`启动失败: ${e.message}`); }
  },

  /** 轮询批量测试进度（含增量日志；skipLogReplay/resumeMode 见 _startBatchPoll） */
  _pollBatchTestStatus: function(skipLogReplay, resumeMode) {
    this._startBatchPoll('batch_test', (seq) => API.batchTestStatus(seq), 'batch-test-log',
      (status) => this._renderBatchTestProgress(status),
      (status) => { if (status.done) this._renderBatchTestResult(status.result); },
      { skipLogReplay, resumeMode });
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
      this._dragSelecting = { mode: !cb.checked, onSet, cb };
      cb.__dragHandled = true;
      onSet(cb, this._dragSelecting.mode);
    });
    // 原生 click 的激活行为会把 mousedown 已手动设置的勾选再翻转回去（单击"点了没反应"的根因）：
    // 仅当本次 click 对应的 mousedown 已由拖选状态机处理过时才吞掉，键盘/程序触发不受影响
    container.addEventListener('click', (e) => {
      const cb = e.target.closest(checkboxSelector);
      if (!cb || cb.disabled || (isEnabled && !isEnabled(cb))) return;
      if (cb.__dragHandled) {
        delete cb.__dragHandled;
        e.preventDefault();
      }
    });
    container.addEventListener('mouseover', (e) => {
      if (!this._dragSelecting || this._dragSelecting.onSet !== onSet) return;
      const cb = e.target.closest(checkboxSelector);
      if (!cb || cb.disabled || (isEnabled && !isEnabled(cb))) return;
      onSet(cb, this._dragSelecting.mode);
    });
    // 全局 mouseup 结束拖选（防重绑定：统一走 window 一次性标记）。
    // 注意：不能在这里清 __dragHandled —— click 在 mouseup 之后触发，提前清会让原生翻转再次生效
    if (!window.__dragSelectMouseUpBound) {
      window.__dragSelectMouseUpBound = true;
      document.addEventListener('mouseup', () => {
        this._dragSelecting = null;
      });
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
    const type = document.getElementById('qm-type')?.value;
    const keyword = document.getElementById('qm-keyword')?.value.trim();
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
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--gray-4);padding:30px">暂无符合条件的题目</td></tr>';
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
        const tested = q.tested_models || [];
        const testedHtml = tested.length
          ? tested.map(m => `<span class="tag tag-secondary" style="margin:1px 3px 1px 0;display:inline-block">${this._escHtml(m)}</span>`).join('')
          : '<span style="color:var(--gray-4)">未测试</span>';
        const checked = this._qmSelected.has(q.question_id) ? ' checked' : '';
        html += `<tr>
          <td style="text-align:center;user-select:none"><input type="checkbox" class="qm-check" data-qid="${q.question_id}"${checked} style="cursor:pointer;vertical-align:middle"></td>
          <td><strong>${q.question_id}</strong></td>
          <td>${qtypeLabel}${modeTag}</td>
          <td style="max-width:240px">${testedHtml}</td>
          <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${q.answer || ''}">${ansPreview}</td>
          <td>
            <button class="btn btn-sm btn-secondary" onclick="App._jumpToEdit('${q.question_id}')">改题</button>
            <button class="btn btn-sm btn-secondary" onclick="App._jumpToEvalManage('${q.question_id}')">测评结果</button>
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
  // 批量测评（勾选测试记录 → 批量代码核查并保存结果）
  // ============================================================
  initEval: function() {
    // 如果已初始化，跳过
    if (document.querySelector('#page-eval')?.dataset.initialized) return;
    document.querySelector('#page-eval').dataset.initialized = '1';

    document.getElementById('btn-batch-eval-scan')?.addEventListener('click', () => this._scanBatchEval());
    document.getElementById('btn-batch-eval-start')?.addEventListener('click', () => this._startBatchEval());
    document.getElementById('btn-batch-eval-select-all')?.addEventListener('click', () => this._selectBatchEval(true));
    document.getElementById('btn-batch-eval-select-none')?.addEventListener('click', () => this._selectBatchEval(false));

    // 拖选：按住鼠标划过选框即可批量勾选/取消勾选
    this._bindDragSelect(
      document.getElementById('batch-eval-table'),
      'input[data-eval-file]',
      (cb, checked) => {
        cb.checked = checked;
        if (checked) this.batchEvalSelected.add(cb.dataset.evalFile);
        else this.batchEvalSelected.delete(cb.dataset.evalFile);
      },
    );

    // 服务端任务若仍在运行（如页面刷新后），自动恢复进度与日志轮询
    this._resumeBatchPolling('batch_eval');
  },

  batchEvalItems: [],   // 扫描结果 [{filename, question_id, model_name, ...}]
  batchEvalSelected: new Set(),
  _batchEvalPolling: false,

  /** 扫描测试记录列表 */
  _scanBatchEval: async function() {
    try {
      const res = await API.batchEvalScan();
      if (!res.success) { alert(`扫描失败: ${res.detail || '未知错误'}`); return; }
      this.batchEvalItems = res.items || [];
      // 选中集按可见列表裁剪：已删除/已消失的记录不再留在 batchEvalSelected
      // （否则全选+开始测评会对已删文件逐条报错；与 tm/em/qm 的做法对齐）
      const visible = new Set(this.batchEvalItems.map(i => i.filename));
      this.batchEvalSelected = new Set([...this.batchEvalSelected].filter(f => visible.has(f)));
      this._renderBatchEvalTable();
    } catch (e) { alert(`扫描失败: ${e.message}`); }
  },

  /** 渲染批量测评勾选表（记录详情 + 勾选增删） */
  _renderBatchEvalTable: function() {
    const container = document.getElementById('batch-eval-table');
    if (!container) return;
    if (!this.batchEvalItems.length) {
      container.innerHTML = '<div style="text-align:center;color:var(--gray-4);padding:16px">没有测试记录（请先在批量测试中生成记录）</div>';
      return;
    }
    let html = '<table class="table" style="width:100%"><thead><tr><th></th><th>题号</th><th>模型</th><th>记录文件</th><th>时间</th><th>plan_status</th><th>已测评</th></tr></thead><tbody>';
    this.batchEvalItems.forEach(item => {
      const sel = this.batchEvalSelected.has(item.filename);
      html += `<tr>
        <td style="text-align:center;user-select:none"><input type="checkbox" data-eval-file="${item.filename}" ${sel ? 'checked' : ''} style="cursor:pointer;vertical-align:middle"></td>
        <td><strong>${item.question_id || '-'}</strong></td>
        <td>${item.model_name || '-'}</td>
        <td style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${item.filename}">${item.filename}</td>
        <td>${(item.timestamp || '').replace('T', ' ').substring(0, 19)}</td>
        <td>${item.plan_status || '-'}</td>
        <td>${item.evaluated ? '<span style="color:var(--success-green)">✅ 是</span>' : '<span style="color:var(--gray-4)">否</span>'}</td>
      </tr>`;
    });
    html += '</tbody></table>';
    container.innerHTML = html;
    // 键盘/单击勾选也同步进状态集（原实现只靠拖选的 mousedown 路径，
    // Space 勾选 DOM 变了但 batchEvalSelected 不知道，重渲染后被画回去）
    container.querySelectorAll('input[data-eval-file]').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) this.batchEvalSelected.add(cb.dataset.evalFile);
        else this.batchEvalSelected.delete(cb.dataset.evalFile);
      });
    });
  },

  /** 批量测评全选/取消 */
  _selectBatchEval: function(all) {
    this.batchEvalSelected = all ? new Set(this.batchEvalItems.map(i => i.filename)) : new Set();
    this._renderBatchEvalTable();
  },

  /** 开始批量测评 */
  _startBatchEval: async function() {
    if (!this.batchEvalSelected.size) { alert('未勾选任何测试记录'); return; }
    try {
      const res = await API.batchEvalStart({ records: [...this.batchEvalSelected] });
      if (!res.success) { alert(`启动失败: ${res.detail || '未知错误'}`); return; }
      this._resetBatchEvalProgress();
      this._pollBatchEvalStatus();
    } catch (e) { alert(`启动失败: ${e.message}`); }
  },

  /** 轮询批量测评进度（含增量日志；skipLogReplay/resumeMode 见 _startBatchPoll） */
  _pollBatchEvalStatus: function(skipLogReplay, resumeMode) {
    this._startBatchPoll('batch_eval', (seq) => API.batchEvalStatus(seq), 'batch-eval-log',
      (status) => this._renderBatchEvalProgress(status),
      (status) => { if (status.done) this._renderBatchEvalResult(status.result); },
      { skipLogReplay, resumeMode });
  },

  _resetBatchEvalProgress: function() {
    const bar = document.getElementById('batch-eval-bar');
    if (bar) bar.style.width = '0%';
    const count = document.getElementById('batch-eval-count');
    if (count) count.textContent = `0 / ${this.batchEvalSelected.size}`;
    const cur = document.getElementById('batch-eval-current');
    if (cur) cur.textContent = '尚未开始';
    const res = document.getElementById('batch-eval-result');
    if (res) { res.style.display = 'none'; res.innerHTML = ''; }
    this._resetBatchLog('batch-eval-log', 'batch_eval');
  },

  _renderBatchEvalProgress: function(status) {
    const bar = document.getElementById('batch-eval-bar');
    if (bar) bar.style.width = status.total ? `${Math.round((status.done_count / status.total) * 100)}%` : '0%';
    const count = document.getElementById('batch-eval-count');
    if (count) count.textContent = `${status.done_count || 0} / ${status.total || 0}`;
    const cur = document.getElementById('batch-eval-current');
    if (cur) cur.textContent = status.current || '';
  },

  /** 渲染批量测评结果（verdict 分布 + 逐条明细） */
  _renderBatchEvalResult: function(result) {
    const container = document.getElementById('batch-eval-result');
    if (!container) return;
    container.style.display = 'block';
    const s = result.summary || {};
    const verdictLabel = {
      'pass': '✅ 通过', 'hallucination': '❌ 有错误', 'no_plan': '⚠️ 无方案',
      'empty_plan': '⚠️ 空方案', 'db_not_found': '❌ 题库缺失', 'error': '❌ 失败',
    };
    let html = '<div class="card"><div class="card-header">⚖️ 批量测评结果</div>';
    html += `<div style="display:flex;gap:16px;padding:8px 0;font-size:var(--font-size-small);flex-wrap:wrap">
      <div><strong>总数：</strong>${s.total || 0}</div>
      <div style="color:var(--success-green)"><strong>成功：</strong>${s.success || 0}</div>
      <div style="color:var(--error-red)"><strong>失败：</strong>${s.failed || 0}</div>`;
    Object.entries(s.verdicts || {}).forEach(([v, c]) => {
      html += `<div><strong>${verdictLabel[v] || v}：</strong>${c}</div>`;
    });
    html += `</div>`;
    if (result.details && result.details.length) {
      html += '<div style="max-height:280px;overflow-y:auto;font-size:var(--font-size-small)"><table class="table" style="width:100%"><thead><tr><th>题号</th><th>记录文件</th><th>verdict</th><th>结果文件</th><th>状态</th></tr></thead><tbody>';
      result.details.forEach(d => {
        html += `<tr>
          <td>${d.question_id || '-'}</td>
          <td style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${d.filename}">${d.filename}</td>
          <td>${verdictLabel[d.verdict] || d.verdict || '-'}</td>
          <td style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${d.result_file || ''}">${d.result_file || '—'}</td>
          <td style="color:${d.ok ? 'var(--success-green)' : 'var(--error-red)'}">${d.ok ? '✅ 已保存' : `❌ ${d.error || '失败'}`}</td>
        </tr>`;
      });
      html += '</tbody></table></div>';
    }
    html += '</div>';
    container.innerHTML = html;
  },

  // ============================================================
  // 测试管理（浏览测试记录 logs/test：「测试后」产物）
  // 结构化展示模型输出：左栏筛选 + 右栏列表，点击行开宽幅抽屉按轨迹展示；支持单条/批量删除
  // ============================================================
  _testManageItems: [],
  _testManageSelected: new Set(),   // 已勾选的记录文件名集合（刷新后按可见列表裁剪）

  initTestManage: function() {
    const page = document.querySelector('#page-test-manage');
    if (!page) return;
    if (!page.dataset.initialized) {
      page.dataset.initialized = '1';
      document.getElementById('btn-tm-refresh')?.addEventListener('click', () => this._loadTestManageList());
      document.getElementById('tm-model')?.addEventListener('change', () => this._loadTestManageList());
      document.getElementById('tm-end')?.addEventListener('change', () => this._loadTestManageList());
      document.getElementById('tm-question')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this._loadTestManageList();
      });
      // 表头全选/全不选 + 拖选（与测评管理同套机制）
      document.getElementById('tm-table')?.addEventListener('change', (e) => {
        if (e.target.id === 'tm-check-all') this._toggleTmAll(e.target.checked);
      });
      this._bindDragSelect(
        document.getElementById('tm-table'),
        'input.tm-check',
        (cb, checked) => this._setTmCheck(cb, checked),
      );
    }
    this._loadTestManageList();
  },

  /** 加载测试记录列表（按当前筛选条件） */
  _loadTestManageList: async function() {
    const params = new URLSearchParams();
    const model = document.getElementById('tm-model')?.value.trim() || '';
    const qid = document.getElementById('tm-question')?.value.trim() || '';
    const end = document.getElementById('tm-end')?.value || '';
    if (model) params.set('model', model);
    if (qid) params.set('question_id', qid);
    if (end) params.set('end_reason', end);
    try {
      const data = await API.testManageList(params.toString());
      // 模型下拉：按返回的全部模型重建，保留当前选择
      const sel = document.getElementById('tm-model');
      if (sel) {
        const cur = (sel.value || '').trim();
        sel.innerHTML = '<option value="">全部模型</option>' +
          (data.models || []).map(m => `<option value="${this._escHtml(m)}">${this._escHtml(m)}</option>`).join('');
        sel.value = cur;
        if (sel.value !== cur) sel.value = '';
      }
      // 汇总卡
      const s = data.summary || {};
      const ec = s.end_reason_counts || {};
      const sumEl = document.getElementById('tm-summary');
      if (sumEl) {
        const endMeta = {
          completed: ['✅ completed 正常完成', 'var(--success-green)'],
          max_iterations: ['✂️ max_iterations 轮数耗尽', '#d97706'],
          error: ['❌ error 异常中断', 'var(--error-red)'],
        };
        sumEl.innerHTML =
          `<div>共 <strong>${s.total}</strong> 条 · 总 Token <strong>${s.total_tokens}</strong> · 平均耗时 <strong>${s.avg_duration}s</strong></div>` +
          Object.keys(endMeta).filter(k => ec[k]).map(k =>
            `<div style="color:${endMeta[k][1]}">${endMeta[k][0]} × ${ec[k]}</div>`).join('') ||
          '<div style="color:var(--gray-4)">暂无数据</div>';
      }
      const countEl = document.getElementById('tm-count');
      if (countEl) countEl.textContent = `（共 ${data.total} 条）`;
      this._testManageItems = data.records || [];
      const visibleFiles = new Set(this._testManageItems.map(it => it.filename));
      this._testManageSelected = new Set([...this._testManageSelected].filter(f => visibleFiles.has(f)));
      this._renderTestManageTable();
    } catch (e) {
      const box = document.getElementById('tm-table');
      if (box) box.innerHTML = `<div style="color:var(--error-red);padding:16px">加载失败: ${this._escHtml(e.message)}</div>`;
    }
  },

  /** 渲染测试记录表（点击行看轨迹详情，行内可删除；勾选列支持拖选批量管理） */
  _renderTestManageTable: function() {
    const box = document.getElementById('tm-table');
    if (!box) return;
    if (!this._testManageItems.length) {
      box.innerHTML = '<div style="text-align:center;color:var(--gray-4);padding:30px">暂无测试记录（请先在「批量测试」执行）</div>';
      this._updateTmSelInfo();
      return;
    }
    let html = '<table class="table" style="width:100%"><thead><tr>' +
      '<th style="width:36px;text-align:center"><input type="checkbox" id="tm-check-all" title="全选/全不选" style="cursor:pointer;vertical-align:middle"></th>' +
      '<th>题号</th><th>模型</th><th>结束原因</th><th>方案</th><th>模型/工具调用</th><th>Token</th><th>耗时(s)</th><th>时间</th><th>操作</th>' +
      '</tr></thead><tbody>';
    this._testManageItems.forEach(it => {
      const ts = (it.timestamp || '').replace('T', ' ').substring(0, 19);
      const checked = this._testManageSelected.has(it.filename) ? ' checked' : '';
      html += `<tr style="cursor:pointer" onclick="App._openTestDetail('${this._escAttr(it.filename)}')">
        <td style="text-align:center;user-select:none" onclick="event.stopPropagation()"><input type="checkbox" class="tm-check" data-tm-file="${this._escAttr(it.filename)}"${checked} style="cursor:pointer;vertical-align:middle"></td>
        <td><strong>${this._escHtml(it.question_id || '-')}</strong></td>
        <td>${this._escHtml(it.model_name || '-')}</td>
        <td>${this._endReasonBadge(it.end_reason)}</td>
        <td>${this._planStatusBadge(it.plan_status)}</td>
        <td>${it.model_calls ?? '-'} / ${it.tool_calls ?? '-'}</td>
        <td>${it.total_tokens ?? '-'}</td>
        <td>${it.duration != null && it.duration !== '' ? Math.round(it.duration) : '-'}</td>
        <td style="color:var(--gray-4)">${ts}</td>
        <td><button class="btn btn-sm btn-danger" onclick="event.stopPropagation();App._deleteTestRecord('${this._escAttr(it.filename)}')">删除</button></td>
      </tr>`;
    });
    html += '</tbody></table>';
    box.innerHTML = html;
    this._updateTmSelInfo();
  },

  // ---- 批量管理（与测评管理同套交互）----
  _setTmCheck: function(cb, checked) {
    cb.checked = checked;
    const file = cb.dataset.tmFile;
    if (checked) this._testManageSelected.add(file);
    else this._testManageSelected.delete(file);
    this._updateTmSelInfo();
  },

  _updateTmSelInfo: function() {
    const boxes = Array.from(document.querySelectorAll('#tm-table input.tm-check'));
    const selCount = boxes.filter(b => b.checked).length;
    const info = document.getElementById('tm-sel-info');
    if (info) info.textContent = selCount > 0
      ? `已选择 ${selCount} 条`
      : '未选择（按住鼠标拖过选框可批量勾选）';
    const btnDel = document.getElementById('tm-btn-batch-del');
    if (btnDel) btnDel.disabled = selCount === 0;
    const btnClr = document.getElementById('tm-btn-clear-sel');
    if (btnClr) btnClr.disabled = selCount === 0;
    const all = document.getElementById('tm-check-all');
    if (all) {
      all.checked = boxes.length > 0 && selCount === boxes.length;
      all.indeterminate = selCount > 0 && selCount < boxes.length;
    }
  },

  _toggleTmAll: function(checked) {
    document.querySelectorAll('#tm-table input.tm-check').forEach(cb => {
      this._setTmCheck(cb, checked);
    });
  },

  _clearTestManageSelection: function() {
    this._toggleTmAll(false);
  },

  /** 批量删除勾选的测试记录 */
  _batchDeleteTestRecords: async function() {
    const btn = document.getElementById('tm-btn-batch-del');
    const ids = Array.from(document.querySelectorAll('#tm-table input.tm-check'))
      .filter(cb => cb.checked)
      .map(cb => cb.dataset.tmFile);
    if (!ids.length) { alert('未勾选任何测试记录'); return; }
    if (!confirm(`确认批量删除 ${ids.length} 条测试记录？\n该操作不可恢复。`)) return;
    if (btn) { btn.disabled = true; btn.textContent = '🗑 删除中...'; }
    const failed = [];
    for (const filename of ids) {
      try {
        const res = await API.testManageDelete(filename);
        if (!res.success) failed.push(`${filename}: ${res.detail || '未知错误'}`);
      } catch (e) {
        failed.push(`${filename}: ${e.message}`);
      }
    }
    if (btn) btn.textContent = '🗑 批量删除';
    this._testManageSelected.clear();
    this._statsReload = true;
    await this._loadTestManageList();
    if (failed.length) {
      alert(`批量删除完成：成功 ${ids.length - failed.length} 条，失败 ${failed.length} 条\n` + failed.join('\n'));
    }
  },

  /** 删除单条测试记录 */
  _deleteTestRecord: async function(filename) {
    if (!confirm(`确认删除测试记录？\n${filename}`)) return;
    try {
      const res = await API.testManageDelete(filename);
      if (!res.success) { alert(`删除失败: ${res.detail || '未知错误'}`); return; }
      this._loadTestManageList();
    } catch (e) { alert(`删除失败: ${e.message}`); }
  },

  /** plan_status 徽章 */
  _planStatusBadge: function(s) {
    const map = {
      has_solution: ['✅ 有方案', 'var(--success-green)'],
      empty_plan: ['⚠️ 认为无解', '#d97706'],
      no_plan: ['⚠️ 未输出方案', '#d97706'],
    };
    const [label, color] = map[s] || [`❓ ${s || '未知'}`, 'var(--gray-4)'];
    return `<span style="color:${color};font-weight:600;font-size:11px">${this._escHtml(label)}</span>`;
  },

  /** end_reason 徽章（对话结束原因：completed=模型收尾 / max_iterations=轮数耗尽 / error=异常中断） */
  _endReasonBadge: function(er) {
    const map = {
      completed: ['✅ 正常完成', 'var(--success-green)'],
      max_iterations: ['✂️ 轮数耗尽', '#d97706'],
      error: ['❌ 异常中断', 'var(--error-red)'],
    };
    const [label, color] = map[er] || [`❓ ${er || '未知'}`, 'var(--gray-4)'];
    return `<span style="color:${color};font-weight:600;font-size:11px">${this._escHtml(label)}</span>`;
  },

  /** 打开测试详情抽屉（宽幅 960px，按轨迹展示） */
  _openTestDetail: async function(filename) {
    try {
      // 请求令牌：快速连点两行时丢弃先发后至的旧响应，防"标题 A 内容 B"
      const seq = (this._testDrawerSeq = (this._testDrawerSeq || 0) + 1);
      const data = await API.testManageDetail(filename);
      if (seq !== this._testDrawerSeq) return;
      this._renderTestDrawer(data);
    } catch (e) { alert(`加载详情失败: ${e.message}`); }
  },

  _closeTestDrawer: function() {
    const d = document.getElementById('test-drawer');
    if (!d) return;
    d.style.right = '-50vw';
    setTimeout(() => { d.style.display = 'none'; }, 260);
  },

  /** 渲染测试详情抽屉：基本信息 / 题面 / final_answer / final_plan / 对话轨迹（宽幅） */
  _renderTestDrawer: function(data) {
    const r = data.record || {};
    const qm = data.question_meta || {};
    const qType = qm.question_type ? this._questionTypeLabel(qm.question_type) : (qm.type || '');
    const tu = r.token_usage || {};
    const trace = Array.isArray(r.trace) ? r.trace : [];
    const traceRounds = trace.filter(e => e.type === 'assistant').length;

    let html = '';
    // 头部信息
    html += `<div style="border:1px solid var(--gray-2);border-radius:8px;padding:10px 12px;margin-bottom:12px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px">
        <strong style="font-size:14px">${this._escHtml(r.question_id || '-')}</strong>
        <span class="tag tag-secondary">${this._escHtml(qType || '未知题型')}</span>
        ${this._planStatusBadge(r.plan_status)}
        ${this._endReasonBadge(r.end_reason)}
        <span style="margin-left:auto;color:var(--gray-4);font-size:11px">${this._escHtml(r.timestamp || '')}</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:2px 12px;color:var(--gray-5)">
        <div>模型：<strong>${this._escHtml(r.model_name || '-')}</strong></div>
        <div>🤖 模型调用：<strong>${r.model_calls ?? traceRounds}</strong> 次</div>
        <div>🔧 工具调用：<strong>${r.tool_calls ?? '-'}</strong> 次</div>
        <div>总 Token：<strong>${tu.total_tokens || 0}</strong></div>
        <div>输入 / 输出：${tu.prompt_tokens || 0} / ${tu.completion_tokens || 0}</div>
        <div>耗时：<strong>${r.duration != null ? Math.round(r.duration) : '-'}s</strong></div>
      </div>
    </div>`;

    // 题面 + 标准答案
    const nl = qm.nl_question || qm.question || r.user_input || '';
    if (nl) {
      html += `<div style="margin-bottom:12px">
        <div style="font-weight:600;margin-bottom:4px">📋 题面</div>
        <div style="border:1px solid var(--gray-2);border-radius:8px;padding:8px 10px;background:#fafafa;max-height:130px;overflow-y:auto">${this._escHtml(nl)}</div>
      </div>`;
    }
    if (qm.answer) {
      html += `<div style="margin-bottom:12px">
        <div style="font-weight:600;margin-bottom:4px">✅ 标准答案</div>
        <div style="border:1px solid var(--gray-2);border-radius:8px;padding:8px 10px;background:#f0fdf4;max-height:110px;overflow-y:auto">${this._escHtml(qm.answer)}</div>
      </div>`;
    }

    // 最终回答
    if (r.final_answer) {
      html += `<div style="margin-bottom:12px">
        <div style="font-weight:600;margin-bottom:4px">💬 最终回答</div>
        <div style="border:1px solid var(--gray-2);border-radius:8px;padding:8px 10px;background:#fafafa;max-height:180px;overflow-y:auto">${Components._formatContent(r.final_answer || '')}</div>
      </div>`;
    }

    // final_plan：结构化表格 + 原始 JSON 折叠
    const fp = Array.isArray(r.final_plan) ? r.final_plan : [];
    html += `<div style="margin-bottom:12px">
      <div style="font-weight:600;margin-bottom:4px">🧾 final_plan（${fp.length ? `${fp.length} 段` : '空/未输出'}）</div>`;
    if (fp.length) {
      html += `<div style="overflow:auto;border:1px solid var(--gray-2);border-radius:8px">
      <table class="table" style="width:100%">
        <thead><tr><th>#</th><th>车次</th><th>购买区间</th><th>乘坐区间</th><th>座位</th><th>票数</th><th>票价(元)</th></tr></thead><tbody>`;
      fp.forEach((p, i) => {
        html += `<tr>
          <td>${i + 1}</td>
          <td><strong>${this._escHtml(p.train_num || '-')}</strong></td>
          <td>${this._escHtml(p.from_station_id || p.from || '?')} → ${this._escHtml(p.to_station_id || p.to || '?')}</td>
          <td>${(p.ride_from || p.ride_to)
            ? this._escHtml(`${p.ride_from_name || p.ride_from || '?'} → ${p.ride_to_name || p.ride_to || '?'}`)
            : '<span style="color:var(--gray-4)">—</span>'}</td>
          <td>${this._escHtml(p.seat_type || '-')}</td>
          <td>${p.tickets ?? '-'}</td>
          <td>${p.price != null ? p.price : '-'}</td>
        </tr>`;
      });
      html += `</tbody></table></div>`;
    }
    html += `<details style="margin-top:4px"><summary style="cursor:pointer;color:var(--gray-4);font-size:11px">原始 JSON（点击展开）</summary>
      <pre style="max-height:160px;overflow:auto;background:#0f172a;color:#e2e8f0;border-radius:8px;padding:8px 10px;font-size:11px">${this._escHtml(JSON.stringify(r.final_plan ?? null, null, 2))}</pre>
    </details></div>`;

    // 对话轨迹（宽幅 harness 风格：USER / ASSISTANT·第N轮(思考链折叠+内容) / TOOL 输入返回折叠）
    html += `<div>
      <div style="font-weight:600;margin-bottom:4px">🧭 对话轨迹（${traceRounds} 轮）</div>
      <div style="border:1px solid var(--gray-2);border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:6px;background:#fafafa">${this._renderTraceRowsHtml(trace)}</div>
    </div>`;

    const drawer = document.getElementById('test-drawer');
    const body = document.getElementById('test-drawer-body');
    const title = document.getElementById('test-drawer-title');
    if (!drawer || !body) return;
    if (title) title.textContent = `测试详情 · ${r.question_id || ''}`;
    body.innerHTML = html;
    body.scrollTop = 0;
    drawer.style.display = 'flex';
    requestAnimationFrame(() => { drawer.style.right = '0'; });
  },

  // ============================================================
  // 测评管理（浏览测评结果 logs/result：「测评后」产物）
  // 抽屉只展示结构化正误问题（判定说明/核查明细/问题清单）；轨迹与 final_plan 已剥离至测试管理
  // ============================================================
  _evalManagePreset: null,   // 跳转预置筛选 {question_id, model}
  _evalManageItems: [],
  _evalManageSelected: new Set(),   // 已勾选的结果文件名集合（刷新后按可见列表裁剪）

  initEvalManage: function() {
    const page = document.querySelector('#page-eval-manage');
    if (!page) return;
    if (!page.dataset.initialized) {
      page.dataset.initialized = '1';
      document.getElementById('btn-em-refresh')?.addEventListener('click', () => this._loadEvalManageList());
      document.getElementById('em-model')?.addEventListener('change', () => this._loadEvalManageList());
      document.getElementById('em-verdict')?.addEventListener('change', () => this._loadEvalManageList());
      document.getElementById('em-question')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this._loadEvalManageList();
      });
      // 表头全选/全不选（表头随表格重渲染，用容器级委托保证监听不丢）
      document.getElementById('em-table')?.addEventListener('change', (e) => {
        if (e.target.id === 'em-check-all') this._toggleEmAll(e.target.checked);
      });
      // 拖选：按住鼠标划过选框即可批量勾选/取消勾选（与其他批量页同一套机制）
      this._bindDragSelect(
        document.getElementById('em-table'),
        'input.em-check',
        (cb, checked) => this._setEmCheck(cb, checked),
      );
    }
    // 从题目管理/模型管理跳入：应用预置筛选（每次进入都应用，支持重复跳转）
    if (this._evalManagePreset) {
      const { question_id, model } = this._evalManagePreset;
      if (question_id) {
        const inp = document.getElementById('em-question');
        if (inp) inp.value = question_id;
      }
      if (model) {
        // 模型选项尚未构建，先记录，_loadEvalManageList 构建下拉时消费
        document.getElementById('em-model')?.setAttribute('data-preset-model', model);
      }
      this._evalManagePreset = null;
    }
    this._loadEvalManageList();
  },

  /** 跳转到测评管理并按题目（可带模型）过滤 */
  _jumpToEvalManage: function(qid, model) {
    this._evalManagePreset = { question_id: qid || '', model: model || '' };
    this._switchToPage('eval-manage');
  },

  /** 加载测评结果列表（按当前筛选条件） */
  _loadEvalManageList: async function() {
    const selEl = document.getElementById('em-model');
    // 查询模型：优先下拉当前值，其次跳转预置（下拉选项尚未构建时）
    const model = selEl ? ((selEl.value || '').trim() || (selEl.getAttribute('data-preset-model') || '').trim()) : '';
    const params = new URLSearchParams();
    const qid = document.getElementById('em-question')?.value.trim() || '';
    const verdict = document.getElementById('em-verdict')?.value || '';
    if (model) params.set('model', model);
    if (qid) params.set('question_id', qid);
    if (verdict) params.set('verdict', verdict);

    try {
      const data = await API.evalManageList(params.toString());

      // 模型下拉：每次按返回的全部模型重建，保留当前选择/跳转预置
      const sel = document.getElementById('em-model');
      if (sel) {
        const cur = (sel.value || '').trim() || (sel.getAttribute('data-preset-model') || '').trim();
        sel.removeAttribute('data-preset-model');
        sel.innerHTML = '<option value="">全部模型</option>' +
          (data.models || []).map(m => `<option value="${this._escHtml(m)}">${this._escHtml(m)}</option>`).join('');
        sel.value = cur;
        if (sel.value !== cur) sel.value = '';
      }

      // 汇总卡
      const s = data.summary || {};
      const vc = s.verdict_counts || {};
      const vOrder = ['pass', 'hallucination', 'no_plan', 'empty_plan', 'db_not_found', 'unknown'];
      const vColors = {
        pass: 'var(--success-green)', hallucination: 'var(--error-red)',
        no_plan: '#d97706', empty_plan: '#d97706',
        db_not_found: 'var(--gray-4)', unknown: 'var(--gray-4)',
      };
      const sumEl = document.getElementById('em-summary');
      if (sumEl) {
        sumEl.innerHTML =
          `<div>共 <strong>${s.total}</strong> 条</div>` +
          vOrder.filter(k => vc[k]).map(k => `<div style="color:${vColors[k]}">${k} × ${vc[k]}</div>`).join('') ||
          '<div style="color:var(--gray-4)">暂无数据</div>';
      }

      const countEl = document.getElementById('em-count');
      if (countEl) countEl.textContent = `（共 ${data.total} 条）`;

      this._evalManageItems = data.results || [];
      // 选中集只保留当前可见列表中的文件
      const visibleFiles = new Set(this._evalManageItems.map(it => it.filename));
      this._evalManageSelected = new Set([...this._evalManageSelected].filter(f => visibleFiles.has(f)));
      this._renderEvalManageTable();
    } catch (e) {
      const box = document.getElementById('em-table');
      if (box) box.innerHTML = `<div style="color:var(--error-red);padding:16px">加载失败: ${this._escHtml(e.message)}</div>`;
    }
  },

  /** 渲染测评结果表（点击行看详情，行内可删除；勾选列支持拖选批量管理） */
  _renderEvalManageTable: function() {
    const box = document.getElementById('em-table');
    if (!box) return;
    if (!this._evalManageItems.length) {
      box.innerHTML = '<div style="text-align:center;color:var(--gray-4);padding:30px">暂无测评结果（请先在「批量测评」执行）</div>';
      this._updateEmSelInfo();
      return;
    }
    let html = '<table class="table" style="width:100%"><thead><tr>' +
      '<th style="width:36px;text-align:center"><input type="checkbox" id="em-check-all" title="全选/全不选" style="cursor:pointer;vertical-align:middle"></th>' +
      '<th>题号</th><th>模型</th><th>判定</th><th>问题/幻觉</th><th>Token</th><th>耗时(s)</th><th>时间</th><th>操作</th>' +
      '</tr></thead><tbody>';
    this._evalManageItems.forEach(it => {
      const ts = (it.timestamp || '').replace('T', ' ').substring(0, 19);
      const checked = this._evalManageSelected.has(it.filename) ? ' checked' : '';
      html += `<tr style="cursor:pointer" onclick="App._openEvalDetail('${this._escAttr(it.filename)}')">
        <td style="text-align:center;user-select:none" onclick="event.stopPropagation()"><input type="checkbox" class="em-check" data-em-file="${this._escAttr(it.filename)}"${checked} style="cursor:pointer;vertical-align:middle"></td>
        <td><strong>${this._escHtml(it.question_id || '-')}</strong></td>
        <td>${this._escHtml(it.model_name || '-')}</td>
        <td>${this._evalVerdictBadge(it.verdict)}</td>
        <td>${it.issue_count}${it.hallucination_count ? ` <span style="color:var(--error-red)">(${it.hallucination_count}幻觉)</span>` : ''}</td>
        <td>${it.total_tokens}</td>
        <td>${it.duration_seconds != null ? Math.round(it.duration_seconds) : '-'}</td>
        <td style="color:var(--gray-4)">${ts}</td>
        <td><button class="btn btn-sm btn-danger" onclick="event.stopPropagation();App._deleteEvalResult('${this._escAttr(it.filename)}')">删除</button></td>
      </tr>`;
    });
    html += '</tbody></table>';
    box.innerHTML = html;
    this._updateEmSelInfo();
  },

  // ---- 批量管理（与题目管理同套交互）----

  _setEmCheck: function(cb, checked) {
    cb.checked = checked;
    const file = cb.dataset.emFile;
    if (checked) this._evalManageSelected.add(file);
    else this._evalManageSelected.delete(file);
    this._updateEmSelInfo();
  },

  _updateEmSelInfo: function() {
    const boxes = Array.from(document.querySelectorAll('#em-table input.em-check'));
    const selCount = boxes.filter(b => b.checked).length;
    const info = document.getElementById('em-sel-info');
    if (info) info.textContent = selCount > 0
      ? `已选择 ${selCount} 条`
      : '未选择（按住鼠标拖过选框可批量勾选）';
    const btnDel = document.getElementById('em-btn-batch-del');
    if (btnDel) btnDel.disabled = selCount === 0;
    const btnClr = document.getElementById('em-btn-clear-sel');
    if (btnClr) btnClr.disabled = selCount === 0;
    const all = document.getElementById('em-check-all');
    if (all) {
      all.checked = boxes.length > 0 && selCount === boxes.length;
      all.indeterminate = selCount > 0 && selCount < boxes.length;
    }
  },

  _toggleEmAll: function(checked) {
    document.querySelectorAll('#em-table input.em-check').forEach(cb => {
      this._setEmCheck(cb, checked);
    });
  },

  _clearEvalManageSelection: function() {
    this._toggleEmAll(false);
  },

  /** 批量删除勾选的测评结果 */
  _batchDeleteEvalResults: async function() {
    const btn = document.getElementById('em-btn-batch-del');
    // 从可见勾选框取文件名（与选中集取交集，避免渲染不同步）
    const ids = Array.from(document.querySelectorAll('#em-table input.em-check'))
      .filter(cb => cb.checked)
      .map(cb => cb.dataset.emFile);
    if (!ids.length) { alert('未勾选任何测评结果'); return; }
    if (!confirm(`确认批量删除 ${ids.length} 条测评结果？\n该操作不可恢复。`)) return;
    if (btn) { btn.disabled = true; btn.textContent = '🗑 删除中...'; }
    const failed = [];
    for (const filename of ids) {
      try {
        const res = await API.evalManageDelete(filename);
        if (!res.success) failed.push(`${filename}: ${res.detail || '未知错误'}`);
      } catch (e) {
        failed.push(`${filename}: ${e.message}`);
      }
    }
    if (btn) btn.textContent = '🗑 批量删除';
    this._evalManageSelected.clear();
    // 模型管理缓存可能已过期
    this._statsReload = true;
    await this._loadEvalManageList();
    if (failed.length) {
      alert(`批量删除完成：成功 ${ids.length - failed.length} 条，失败 ${failed.length} 条\n` + failed.join('\n'));
    }
  },

  /** verdict 徽章 */
  _evalVerdictBadge: function(v) {
    const map = {
      pass: ['✅ pass', 'var(--success-green)'],
      hallucination: ['❌ hallucination', 'var(--error-red)'],
      no_plan: ['⚠️ no_plan', '#d97706'],
      empty_plan: ['⚠️ empty_plan', '#d97706'],
      db_not_found: ['🗄 db_not_found', 'var(--gray-4)'],
      unknown: ['❓ unknown', 'var(--gray-4)'],
    };
    const [label, color] = map[v] || [`❓ ${v}`, 'var(--gray-4)'];
    return `<span style="color:${color};font-weight:600">${this._escHtml(label)}</span>`;
  },

  /** 删除单条测评结果 */
  _deleteEvalResult: async function(filename) {
    if (!confirm(`确认删除测评结果？\n${filename}`)) return;
    try {
      const res = await API.evalManageDelete(filename);
      if (!res.success) { alert(`删除失败: ${res.detail || '未知错误'}`); return; }
      this._loadEvalManageList();
    } catch (e) { alert(`删除失败: ${e.message}`); }
  },

  /** 打开详情抽屉 */
  _openEvalDetail: async function(filename) {
    try {
      // 请求令牌：同 _openTestDetail，防快速连点时旧响应覆盖新响应
      const seq = (this._evalDrawerSeq = (this._evalDrawerSeq || 0) + 1);
      const data = await API.evalManageDetail(filename);
      if (seq !== this._evalDrawerSeq) return;
      this._renderEvalDrawer(data);
    } catch (e) { alert(`加载详情失败: ${e.message}`); }
  },

  _closeEvalDrawer: function() {
    const d = document.getElementById('eval-drawer');
    if (!d) return;
    d.style.right = '-50vw';
    setTimeout(() => { d.style.display = 'none'; }, 260);
  },

  /** 渲染详情抽屉（只展示结构化核查结论）：判定说明 / 核查明细（声称vs实际）/ 问题清单（含判定条件）；
      final_plan 与对话轨迹已剥离至「测试管理」（2026-09-16） */
  _renderEvalDrawer: function(data) {
    const r = data.result || {};
    const tr = data.test_record;
    const qm = data.question_meta || {};
    const ver = r.verification || {};
    const ss = r.score_summary || {};
    const qType = qm.question_type ? this._questionTypeLabel(qm.question_type) : (qm.type || '');

    // 对话轨迹：测试记录的 trace（按轮次嵌套，唯一对话源）
    const trace = (tr && Array.isArray(tr.trace)) ? tr.trace : [];
    const traceRounds = trace.filter(e => e.type === 'assistant').length;
    // 双计数：优先读测试记录显式字段，旧记录由 trace 推导
    // 模型调用 = assistant 轮数（每轮一次 LLM API 请求）；工具调用 = 各轮嵌套 tools 总和
    const modelCalls = (tr && tr.model_calls != null) ? tr.model_calls : traceRounds;
    const toolCount = (tr && tr.tool_calls != null) ? tr.tool_calls : trace.reduce((n, e) => n + (e.type === 'assistant' && Array.isArray(e.tools) ? e.tools.length : 0), 0);
    const planStatus = (tr && tr.plan_status) || '-';
    const dur = ss.duration_seconds != null ? Math.round(ss.duration_seconds) : (tr && tr.duration ? Math.round(tr.duration) : '-');
    const tokens = ss.total_tokens || (tr && tr.token_usage && tr.token_usage.total_tokens) || 0;

    let html = '';
    // 头部信息
    html += `<div style="border:1px solid var(--gray-2);border-radius:8px;padding:10px 12px;margin-bottom:12px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px">
        <strong style="font-size:14px">${this._escHtml(r.question_id || '-')}</strong>
        <span class="tag tag-secondary">${this._escHtml(qType || '未知题型')}</span>
        ${this._evalVerdictBadge(ver.verdict)}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:2px 12px;color:var(--gray-5)">
        <div>模型：<strong>${this._escHtml(r.model_name || '-')}</strong></div>
        <div>时间：${(r.timestamp || '').replace('T', ' ').substring(0, 19)}</div>
        <div>Token：${tokens}</div>
        <div>耗时：${dur}s</div>
        <div>🤖 模型调用：<strong>${modelCalls}</strong> 次</div>
        <div>🔧 工具调用：<strong>${toolCount}</strong> 次</div>
        <div>plan_status：${this._escHtml(planStatus)}</div>
      </div>
    </div>`;

    // （2026-09-16）判定说明卡已移除：verdict 与下方问题清单信息重复，头部徽章保留速览；
    // 核查两阶段说明见 docs/verifier.md

    // 题面 + 标准答案
    const nl = qm.nl_question || qm.question || '';
    if (nl) {
      html += `<div style="margin-bottom:12px">
        <div style="font-weight:600;margin-bottom:4px">📋 题面</div>
        <div style="border:1px solid var(--gray-2);border-radius:8px;padding:8px 10px;background:#fafafa;max-height:150px;overflow-y:auto">${this._escHtml(nl)}</div>
      </div>`;
    }
    if (qm.answer) {
      html += `<div style="margin-bottom:12px">
        <div style="font-weight:600;margin-bottom:4px">✅ 标准答案</div>
        <div style="border:1px solid var(--gray-2);border-radius:8px;padding:8px 10px;background:#f0fdf4;max-height:120px;overflow-y:auto">${this._escHtml(qm.answer)}</div>
      </div>`;
    }

    // 用户输入（结果文件自带的提问）
    if (r.user_input && !nl) {
      html += `<div style="margin-bottom:12px">
        <div style="font-weight:600;margin-bottom:4px">💬 用户输入</div>
        <div style="border:1px solid var(--gray-2);border-radius:8px;padding:8px 10px;background:#fafafa">${this._escHtml(r.user_input)}</div>
      </div>`;
    }

    // 核查明细表
    const results = ver.results || [];
    if (results.length) {
      html += `<div style="margin-bottom:12px">
        <div style="font-weight:600;margin-bottom:4px">🔍 核查明细（声称 vs 实际）</div>
        <div style="max-height:200px;overflow:auto;border:1px solid var(--gray-2);border-radius:8px">
        <table class="table" style="width:100%">
          <thead><tr><th>车次</th><th>区间</th><th>座位</th><th>声称/实际票</th><th>票价 ✓</th></tr></thead><tbody>`;
      results.forEach(it => {
        html += `<tr style="${it.match ? '' : 'background:#fef2f2'}">
          <td><strong>${this._escHtml(it.train_num || '-')}</strong></td>
          <td>${this._escHtml((it.from_name || it.from_station_id || '?') + ' → ' + (it.to_name || it.to_station_id || '?'))}
            ${it.ride_from_name && (it.ride_from_name !== it.from_name || it.ride_to_name !== it.to_name)
              ? `<div style="color:var(--gray-4);font-size:11px">乘 ${this._escHtml((it.ride_from_name || '?') + ' → ' + (it.ride_to_name || '?'))}</div>` : ''}</td>
          <td>${this._escHtml(it.seat_type || '-')}</td>
          <td>${it.claims != null ? it.claims : it.claimed != null ? it.claimed : '-'} / ${it.actual != null ? it.actual : '-'} ${it.match ? '✅' : '❌'}</td>
          <td>${it.price_claimed != null ? `${it.price_claimed}/${it.price_actual != null ? it.price_actual : '-'}` : '-'} ${it.price_match === false ? '❌' : (it.price_match === true ? '✅' : '')}</td>
        </tr>`;
      });
      html += '</tbody></table></div></div>';
    }

    // 问题清单：按 verifier 核查体系分组（组说明 + 每项中文名（代码）+ 详情 + 判定条件，与 docs/verifier.md 一致）
    const issues = ver.issues || [];
    if (issues.length) {
      const groups = {};
      issues.forEach(it => {
        const meta = this._ISSUE_META[it.type] || { label: it.type || '未知问题', group: '其他', criteria: '' };
        (groups[meta.group] = groups[meta.group] || []).push({ it, meta });
      });
      const groupOrder = [...this._ISSUE_GROUPS, '其他'].filter(g => groups[g]);
      html += `<div style="margin-bottom:12px">
        <div style="font-weight:600;margin-bottom:4px">⚠️ 问题清单（${issues.length} 项 · 按核查体系分组）</div>
        <div style="border:1px solid var(--gray-2);border-radius:8px;overflow:hidden">`;
      groupOrder.forEach((g, gi) => {
        const gDesc = this._ISSUE_GROUP_DESC[g] || '';
        html += `<div style="padding:7px 10px;background:#fffbeb;${gi ? 'border-top:1px solid var(--gray-2);' : ''}">
          <div style="font-size:12px;font-weight:700;color:#92400e">${this._escHtml(g)}（${groups[g].length} 项）</div>
          ${gDesc ? `<div style="font-size:11px;color:#a16207;margin-top:1px">📌 ${this._escHtml(gDesc)}</div>` : ''}
          <div style="margin-top:5px;display:flex;flex-direction:column;gap:4px">`;
        groups[g].forEach(({ it, meta }) => {
          html += `<div style="background:#fff;border:1px solid #fde68a;border-radius:6px;padding:5px 8px">
            <div style="line-height:1.6"><span class="tag" style="background:#fee2e2;color:var(--error-red)">${this._escHtml(meta.label)}（${this._escHtml(it.type || '')}）</span>
            ${it.detail ? `<span style="color:var(--gray-6)">${this._escHtml(it.detail)}</span>` : ''}</div>
            ${meta.criteria ? `<div style="font-size:11px;color:var(--gray-4);margin-top:2px">⚖️ 判定条件：${this._escHtml(meta.criteria)}</div>` : ''}
          </div>`;
        });
        html += `</div></div>`;
      });
      html += `</div></div>`;
    } else {
      html += `<div style="border:1px solid #bbf7d0;background:#f0fdf4;border-radius:8px;padding:8px 10px;margin-bottom:12px;color:var(--success-green);font-weight:600">✅ 未发现核查问题（余票/票价/路线/约束/格式全部通过）</div>`;
    }

    // （2026-09-16 剥离）final_plan 与对话轨迹属「测试后」过程内容，已移至「测试管理」页查看；
    // 测评管理抽屉只保留结构化核查结论（判定说明 / 核查明细 / 问题清单）
    const tfName = (r.test_file || '').replace(/^.*[\\/]/, '');
    html += `<div style="border:1px dashed var(--gray-3);border-radius:8px;padding:8px 10px;color:var(--gray-4);font-size:11px">
      💡 完整对话轨迹、final_answer 与 final_plan 属「测试后」内容——请在「测试管理」页查看${tfName ? `（对应测试记录：${this._escHtml(tfName)}）` : ''}
    </div>`;

    const drawer = document.getElementById('eval-drawer');
    const body = document.getElementById('eval-drawer-body');
    const title = document.getElementById('eval-drawer-title');
    if (!drawer || !body) return;
    if (title) title.textContent = `测评详情 · ${r.question_id || ''}`;
    body.innerHTML = html;
    body.scrollTop = 0;
    drawer.style.display = 'flex';
    requestAnimationFrame(() => { drawer.style.right = '0'; });
  },

  /** 取单条结果的判定与扣分说明已废弃（评分功能移除，2026-09-16） */

  /** 工具行渲染（harness 风格；indent=true 时缩进挂在所属轮次下） */
  _toolRowHtml: function(t, indent) {
    const args = typeof t.arguments === 'string' ? t.arguments : JSON.stringify(t.arguments || {});
    const result = typeof t.result === 'string' ? t.result : JSON.stringify(t.result);
    return `<div style="border-left:3px solid #f59e0b;background:#fffbeb;border-radius:6px;padding:6px 8px;${indent ? 'margin-left:16px;' : ''}">
      <span style="font-size:10px;font-weight:700;color:#d97706">TOOL · ${this._escHtml(t.tool_name || '(旧记录无工具名)')}</span>
      <details style="margin-top:3px"><summary style="cursor:pointer;color:#d97706;font-size:11px">📥 输入 / 返回（点击展开）</summary>
        <pre style="background:#fff;border:1px solid var(--gray-2);border-radius:6px;padding:5px 8px;margin-top:3px;font-size:11px;white-space:pre-wrap;word-break:break-word">${this._escHtml(args)}</pre>
        <pre style="background:#fff;border:1px solid var(--gray-2);border-radius:6px;padding:5px 8px;font-size:11px;white-space:pre-wrap;word-break:break-word;max-height:200px;overflow-y:auto">${this._escHtml(result)}</pre>
      </details>
    </div>`;
  },

  /** harness 风格轨迹条目渲染（详情抽屉内；assistant 轮次下缩进挂工具行） */
  _renderTraceRowsHtml: function(trace) {
    if (!Array.isArray(trace) || !trace.length) return '<div style="color:var(--gray-4)">无轨迹数据</div>';
    let html = '';
    trace.forEach(en => {
      if (en.type === 'user') {
        html += `<div style="border-left:3px solid #6366f1;background:#eef2ff;border-radius:6px;padding:6px 8px">
          <span style="font-size:10px;font-weight:700;color:#4f46e5">USER</span>
          <div style="white-space:pre-wrap;word-break:break-word;margin-top:2px">${this._escHtml(en.content || '')}</div>
        </div>`;
      } else if (en.type === 'assistant') {
        const reasoning = en.reasoning
          ? `<details style="margin-top:3px"><summary style="cursor:pointer;color:#7c3aed;font-size:11px">💭 思考链（点击展开）</summary>
             <div style="white-space:pre-wrap;word-break:break-word;color:#6b7280;background:#f5f3ff;border-radius:6px;padding:5px 8px;margin-top:3px;font-size:11px">${this._escHtml(en.reasoning)}</div></details>`
          : '';
        const content = en.content
          ? `<div style="white-space:pre-wrap;word-break:break-word;margin-top:2px">${Components._formatContent(en.content || '')}</div>`
          : '';
        // 本轮工具调用：缩进挂在轮次下（与前端测试页轨迹视图同构）
        const toolsHtml = (Array.isArray(en.tools) && en.tools.length)
          ? `<div style="display:flex;flex-direction:column;gap:4px;margin-top:4px">${en.tools.map(t => this._toolRowHtml(t, true)).join('')}</div>`
          : '';
        html += `<div style="border-left:3px solid #10b981;background:#ecfdf5;border-radius:6px;padding:6px 8px">
          <span style="font-size:10px;font-weight:700;color:#059669">ASSISTANT · 第${this._escHtml(String(en.round || 1))}轮</span>
          ${reasoning}${content}${toolsHtml}
        </div>`;
      }
    });
    return html;
  },

  // ============================================================
  // 旧版单条测评（页面已改批量模式，以下函数保留不再被页面调用）
  // ============================================================
  _loadEvalRecordsOLD: function() {},

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
  // ============================================================
  // 模型管理（原统计页重构）：左栏模型列表 + 右栏详情
  // ============================================================
  _statsData: null,        // /api/stats/summary 缓存
  _statsReload: false,     // 下次进入强制刷新
  mmSelected: '__all__',   // 当前选中模型（'__all__' = 全部对比）
  _mmChart: null,          // Chart.js 实例（重渲染前销毁）

  initStats: async function() {
    const page = document.querySelector('#page-stats');
    if (!page) return;
    if (!page.dataset.initialized) {
      page.dataset.initialized = '1';
      document.getElementById('mm-btn-overview')?.addEventListener('click', () => {
        this.mmSelected = '__all__';
        this._mmRender();
      });
    }
    if (!this._statsData || this._statsReload) {
      try {
        this._statsData = await API.getStatsSummary();
        this._statsReload = false;
      } catch (e) {
        console.error('加载统计数据失败:', e);
      }
    }
    this._mmRender();
  },

  /** verifier 判定问题中文名映射（与 docs/verifier.md 一致；group 用于分组，criteria 为判定条件说明） */
  _ISSUE_META: {
    'route_mismatch': { label: '路线不符标答', group: '路线与标答不符', criteria: '购票段（车次+购买区间+座位+乘坐区间）与标准答案不完全一致（总体标记）' },
    'route_mismatch_train': { label: '车次不符', group: '路线与标答不符', criteria: '车次与标准答案不同' },
    'route_mismatch_route': { label: '购买区间不符', group: '路线与标答不符', criteria: '购买区间（from/to）与标准答案不同' },
    'route_mismatch_seat': { label: '座位不符', group: '路线与标答不符', criteria: '座位等级与标准答案不同' },
    'route_mismatch_ride': { label: '乘坐区间不符', group: '路线与标答不符', criteria: '实际乘坐区间与标准答案不同' },
    'hallucination': { label: '余票不符', group: '余票与票价', criteria: '声称某段有票，但数据库实际余票不足或为 0（编造余票）' },
    'price_wrong': { label: '票价不符', group: '余票与票价', criteria: '声称票价与实际数据库票价相差超过 1 元' },
    'price_missing': { label: '票价缺失', group: '余票与票价', criteria: '声称票价，但数据库中无该区间票价数据（数据端问题：统计扣分，主判不据此判错）' },
    'ticket_shortage': { label: '票数不足', group: '余票与票价', criteria: '购票张数少于需求人数' },
    'route_discontinuity': { label: '乘坐不连续', group: '全程可达', criteria: '后一段乘坐起点与前一段乘坐终点不一致（换乘站接不上）' },
    'transfer_time_conflict': { label: '换乘时间冲突', group: '全程可达', criteria: '前车到达时刻晚于后车发车时刻（赶不上）' },
    'start_not_covered': { label: '未连接出发站', group: '全程可达', criteria: '出发站不在首段乘坐区间内' },
    'end_not_covered': { label: '未连接到达站', group: '全程可达', criteria: '到达站不在末段乘坐区间内' },
    'route_invalid': { label: '区间无效', group: '全程可达', criteria: '车次不经过声称的站，或方向顺序错误，或缺少乘坐区间' },
    'no_route': { label: '无法构成全程', group: '全程可达', criteria: '无法拼接出从出发站到到达站的全程' },
    'no_transfer_violated': { label: '违反不允许换乘', group: '行为约束', criteria: '题目含 no_transfer 时，方案相邻两段乘坐车次不同（存在跨车次换乘；买短补长/额外购买均为单车次不会误判）' },
    'no_short_buy_violated': { label: '违反不允许买短补长', group: '行为约束', criteria: '题目含 no_short_buy_extra 时，任一段乘坐区间严格包含购买区间（坐得比买得多）' },
    'no_extra_violated': { label: '违反不允许额外购买', group: '行为约束', criteria: '题目含 no_short_buy_extra 时，任一段购买区间严格包含乘坐区间（买得比坐得多，前/后额外都算）' },
    'missing_ride': { label: '缺乘坐区间', group: '格式与缺失', criteria: '购票段未标注实际乘坐区间（答不全，按不全处理）' },
    'invalid_seat': { label: '无效座位', group: '格式与缺失', criteria: '座位类型非法（不在 二等/一等/特等）' },
    'invalid_plan_item': { label: '无效条目', group: '格式与缺失', criteria: '段缺少车次/出发/到达等关键字段，或不是有效对象' },
  },
  _ISSUE_GROUPS: ['路线与标答不符', '余票与票价', '全程可达', '行为约束', '格式与缺失'],

  /** 问题分组说明（判定体系定位，与 docs/verifier.md 一致） */
  _ISSUE_GROUP_DESC: {
    '路线与标答不符': '存在性题（0_/1_）专有：答案唯一，购票段须与标准答案完全一致，不一致细分 4 个维度',
    '余票与票价': '所有题型通用：对每个购票段核对数据库余票是否足够、票价是否正确、张数是否达到需求人数',
    '全程可达': '选择性题（2_）：拼接各段实际乘坐区间，检查地点连续、时间衔接、覆盖出发/到达站',
    '行为约束': '仅当题目声明对应约束时检测（no_transfer / no_short_buy_extra），否则不判定',
    '格式与缺失': '字段完整性：缺乘坐区间按答不全处理，非法座位/缺失关键字段直接判无效',
    '其他': '未归类问题',
  },

  /** 问题类型 → 中文名 */
  _mmIssueLabel: function(t) {
    const m = this._ISSUE_META[t];
    return m ? m.label : t;
  },

  _mmStatCard: function(value, label, color) {
    return `<div class="stat-card"><div class="stat-card-value"${color ? ` style="color:${color}"` : ''}>${value}</div><div class="stat-card-label">${label}</div></div>`;
  },

  /** 左栏模型列表 + 右栏详情分发 */
  _mmRender: function() {
    const data = this._statsData || {};
    const models = data.models || {};

    // 左栏列表
    const list = document.getElementById('mm-model-list');
    if (list) {
      const names = Object.keys(models);
      list.innerHTML = names.length
        ? names.map(name => {
            const s = models[name];
            const sel = this.mmSelected === name;
            return `<div onclick="App._mmSelect('${this._escAttr(name)}')" style="border:1px solid ${sel ? '#2563eb' : 'var(--gray-2)'};border-radius:8px;padding:10px;margin-bottom:8px;cursor:pointer;background:${sel ? '#eff6ff' : '#fff'}">
              <div style="font-weight:600;margin-bottom:2px">${this._escHtml(name)}</div>
              <div style="font-size:11px;color:var(--gray-4)">${s.total_tests} 题 · 通过率 ${s.pass_rate}% · 错误率 ${s.error_rate}%</div>
            </div>`;
          }).join('')
        : '<div style="color:var(--gray-4);text-align:center;padding:16px;font-size:var(--font-size-small)">暂无测评数据<br>（请先在「批量测评」执行）</div>';
    }

    // 右栏详情
    const detail = document.getElementById('mm-detail');
    if (!detail) return;
    if (this.mmSelected !== '__all__' && models[this.mmSelected]) {
      detail.innerHTML = this._mmModelHtml(this.mmSelected, models[this.mmSelected]);
      this._renderMmChart(models[this.mmSelected]);
    } else {
      detail.innerHTML = this._mmOverviewHtml(data);
      this._bindOverviewButtons();
    }
  },

  _mmSelect: function(name) {
    this.mmSelected = name;
    this._mmRender();
  },

  /** 全部对比视图 */
  _mmOverviewHtml: function(data) {
    const models = data.models || {};
    const summary = data.summary || {};
    let html = `<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
      <strong style="font-size:15px">📊 全部模型对比</strong>
      <div style="margin-left:auto;display:flex;gap:8px">
        <button class="btn btn-secondary btn-sm" id="btn-refresh-stats">🔄 刷新</button>
        <button class="btn btn-secondary btn-sm" id="btn-export-json">📥 导出 JSON</button>
        <button class="btn btn-secondary btn-sm" id="btn-export-md">📥 导出 Markdown</button>
      </div>
    </div>`;

    html += `<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:12px">
      ${this._mmStatCard(data.total_tests || 0, '总测评数')}
      ${this._mmStatCard((summary.pass_rate || 0) + '%', '通过率', 'var(--success-green)')}
      ${this._mmStatCard((summary.error_rate || 0) + '%', '错误率', 'var(--error-red)')}
      ${this._mmStatCard(Object.keys(models).length, '已测模型数')}
    </div>`;

    // 模型对比表（点击行进模型详情）
    const names = Object.keys(models);
    html += '<div class="card" style="margin-bottom:12px"><div class="card-header">📋 模型对比明细</div><div style="overflow-x:auto">';
    if (names.length) {
      html += '<table class="table"><thead><tr><th>模型</th><th>测试数</th><th>通过率</th><th>错误率</th><th>未规划/空</th><th>平均Token</th><th>平均耗时</th><th>平均模型调用</th><th>平均工具调用</th></tr></thead><tbody>';
      names.forEach(name => {
        const s = models[name];
        html += `<tr style="cursor:pointer" onclick="App._mmSelect('${this._escAttr(name)}')">
          <td><strong>${this._escHtml(name)}</strong></td>
          <td>${s.total_tests}</td>
          <td style="color:var(--success-green)">${s.pass_rate}%</td>
          <td style="color:var(--error-red)">${s.error_rate}%</td>
          <td>${(s.no_plan_count || 0) + (s.empty_count || 0)}</td>
          <td>${s.avg_tokens}</td>
          <td>${s.avg_duration}s</td>
          <td>${s.avg_model_calls ?? '-'}</td>
          <td>${s.avg_tool_calls}</td>
        </tr>`;
      });
      html += '</tbody></table>';
    } else {
      html += '<div style="text-align:center;color:var(--gray-4);padding:20px">暂无数据</div>';
    }
    html += '</div></div>';

    // 全局问题类型分布
    const issueEntries = Object.entries(summary.issue_type_counts || {}).sort((a, b) => b[1] - a[1]).slice(0, 12);
    html += `<div class="card"><div class="card-header">⚠️ 全局问题类型分布</div><div style="padding:8px 0">
      ${issueEntries.length
        ? issueEntries.map(([t, c]) => `<span style="display:inline-block;margin:2px 6px 2px 0;padding:2px 10px;border-radius:10px;background:#f3f4f6;font-size:12px">${this._escHtml(this._mmIssueLabel(t))} ×${c}</span>`).join('')
        : '<span style="color:var(--gray-4);font-size:12px">暂无问题数据</span>'}
    </div></div>`;
    return html;
  },

  /** 单模型详情视图 */
  _mmModelHtml: function(name, s) {
    const records = s.records || [];
    let html = `<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
      <strong style="font-size:15px">🤖 ${this._escHtml(name)} · 模型表现</strong>
      <span style="color:var(--gray-4);font-size:var(--font-size-small)">共 ${s.total_tests} 条测评</span>
    </div>`;

    // 指标卡
    html += `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:12px">
      ${this._mmStatCard(s.pass_rate + '%', '通过率', 'var(--success-green)')}
      ${this._mmStatCard(s.error_rate + '%', '错误率', 'var(--error-red)')}
      ${this._mmStatCard((s.no_plan_count || 0) + (s.empty_count || 0), '未规划/空方案')}
      ${this._mmStatCard(s.avg_tokens, '平均 Token')}
      ${this._mmStatCard(s.avg_duration + 's', '平均耗时')}
      ${this._mmStatCard(s.avg_model_calls ?? '-', '平均模型调用', '#2563eb')}
      ${this._mmStatCard(s.avg_tool_calls, '平均工具调用', '#d97706')}
      ${this._mmStatCard(s.completion_rate + '%', '完成率')}
    </div>`;

    // 图表行：verdict 分布 + 问题类型条形
    const issueEntries = Object.entries(s.issue_type_counts || {}).sort((a, b) => b[1] - a[1]).slice(0, 12);
    const maxC = issueEntries.length ? issueEntries[0][1] : 1;
    html += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
      <div class="card"><div class="card-header">🥧 verdict 分布</div>
        <div style="height:240px;position:relative"><canvas id="mm-verdict-chart"></canvas></div>
      </div>
      <div class="card"><div class="card-header">⚠️ 问题类型分布</div>
        <div style="padding:6px 4px;max-height:240px;overflow-y:auto">
        ${issueEntries.length
          ? issueEntries.map(([t, c]) => `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
              <div style="width:130px;flex-shrink:0;color:var(--gray-5);font-size:11px">${this._escHtml(this._mmIssueLabel(t))}</div>
              <div style="flex:1;background:var(--gray-2);border-radius:4px;height:14px"><div style="width:${Math.max(2, Math.round(c / maxC * 100))}%;height:14px;border-radius:4px;background:#ef4444"></div></div>
              <div style="width:34px;text-align:right;color:var(--gray-4);font-size:11px">${c}</div>
            </div>`).join('')
          : '<div style="color:var(--gray-4);font-size:12px;padding:8px">无问题（全部通过）</div>'}
        </div>
      </div>
    </div>`;

    // 逐题明细表
    html += `<div class="card"><div class="card-header">📋 逐题明细（${records.length} 条）</div><div style="overflow-x:auto;max-height:420px;overflow-y:auto">`;
    if (records.length) {
      html += '<table class="table" style="font-size:var(--font-size-small)"><thead><tr><th>题号</th><th>类型</th><th>判定</th><th>问题/幻觉</th><th>模型/工具调用</th><th>Token</th><th>耗时(s)</th><th>时间</th><th>操作</th></tr></thead><tbody>';
      records.forEach(it => {
        const ts = (it.timestamp || '').replace('T', ' ').substring(0, 19);
        html += `<tr>
          <td><strong>${this._escHtml(it.question_id || '-')}</strong></td>
          <td>${this._escHtml(it.type || '-')}</td>
          <td>${this._evalVerdictBadge(it.verdict)}</td>
          <td>${it.issue_count}${it.hallucination_count ? ` <span style="color:var(--error-red)">(${it.hallucination_count})</span>` : ''}</td>
          <td>${it.model_calls ?? '-'} / ${it.tool_calls ?? '-'}</td>
          <td>${it.total_tokens}</td>
          <td>${it.duration_seconds != null ? Math.round(it.duration_seconds) : '-'}</td>
          <td style="color:var(--gray-4)">${ts}</td>
          <td style="white-space:nowrap">
            <button class="btn btn-sm btn-secondary" onclick="App._mmOpenRecord('${this._escAttr(it.question_id)}')">详情</button>
            <button class="btn btn-sm btn-danger" onclick="App._mmDeleteRecord('${this._escAttr(it.filename)}')">删除</button>
          </td>
        </tr>`;
      });
      html += '</tbody></table>';
    } else {
      html += '<div style="text-align:center;color:var(--gray-4);padding:20px">暂无逐题数据</div>';
    }
    html += '</div></div>';
    return html;
  },

  /** 单模型 verdict 环图 */
  _renderMmChart: function(s) {
    const canvas = document.getElementById('mm-verdict-chart');
    if (!canvas || typeof Chart === 'undefined') return;
    if (this._mmChart) { this._mmChart.destroy(); this._mmChart = null; }
    this._mmChart = new Chart(canvas.getContext('2d'), {
      type: 'doughnut',
      data: {
        labels: ['pass 通过', 'hallucination 错误', 'no_plan 未规划', 'empty_plan 空方案', 'db_not_found 数据缺失', 'unknown'],
        datasets: [{
          data: [s.pass_count || 0, s.error_count || 0, s.no_plan_count || 0, s.empty_count || 0, s.db_count || 0, s.unknown_count || 0],
          backgroundColor: ['#22c55e', '#ef4444', '#f59e0b', '#fbbf24', '#9ca3af', '#e5e7eb'],
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 } } } },
      },
    });
  },

  /** 模型管理逐题明细 → 测评管理（按模型+题号过滤） */
  _mmOpenRecord: function(qid) {
    this._jumpToEvalManage(qid, this.mmSelected);
  },

  /** 模型管理逐题明细 → 删除该条测评结果 */
  _mmDeleteRecord: async function(filename) {
    if (!confirm(`确认删除测评结果？\n${filename}`)) return;
    try {
      const res = await API.evalManageDelete(filename);
      if (!res.success) { alert(`删除失败: ${res.detail || '未知错误'}`); return; }
      this._statsReload = true;
      await this.initStats();
    } catch (e) { alert(`删除失败: ${e.message}`); }
  },

  /** 全部对比视图按钮绑定（每次渲染后重新挂） */
  _bindOverviewButtons: function() {
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
      refreshBtn.onclick = async () => { this._statsReload = true; await this.initStats(); };
    }
  },
};

// ============================================================
// 页面加载完成后初始化
// ============================================================
document.addEventListener('DOMContentLoaded', function() {
  App.init();
});
