/**
 * 主应用逻辑模块
 * 处理导航、全局状态、各页面初始化
 */

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
  /** API Key 配置 */
  apiConfig: {
    configs: [{ name: '默认配置', key: '', baseUrl: 'https://api.deepseek.com', model: '' }],
    activeIndex: 0,
  },

  /** 初始化应用 */
  init: function() {
    // 从 localStorage 恢复 API 配置
    this._loadApiConfig();
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

  /** 获取当前激活的 API 配置 */
  _getActiveConfig: function() {
    const configs = this.apiConfig.configs || [];
    const idx = this.apiConfig.activeIndex || 0;
    return configs[idx] || configs[0] || { key: '', baseUrl: '', model: '' };
  },

  /** 从 localStorage 加载 API 配置（兼容旧格式） */
  _loadApiConfig: function() {
    try {
      const saved = localStorage.getItem('benchmark_api_config');
      if (saved) {
        const config = JSON.parse(saved);
        // 兼容旧格式 { test: {...}, eval: {...} } → 迁移到新格式
        if (config.configs) {
          this.apiConfig = config;
        } else if (config.test) {
          this.apiConfig.configs = [{
            name: '默认配置',
            key: config.test.key || '',
            baseUrl: config.test.baseUrl || 'https://api.deepseek.com',
            model: config.test.model || '',
          }];
          this.apiConfig.activeIndex = 0;
        }
      }
    } catch (e) {
      // 忽略
    }
  },

  /** 保存 API 配置到 localStorage */
  _saveApiConfig: function() {
    try {
      localStorage.setItem('benchmark_api_config', JSON.stringify(this.apiConfig));
    } catch (e) {
      // 忽略
    }
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

    const active = this._getActiveConfig();
    if (!active.key) {
      this._showApiKeyModal();
    }
  },

  /** 更新模型连接状态显示 */
  _updateModelStatusDisplay: function() {
    const active = this._getActiveConfig();
    const statusText = active.key ? `● ${active.model || active.name || '已配置'}` : '● 未连接';
    const statusColor = active.key ? '#22c55e' : '#ef4444';
    document.querySelectorAll('.test-model-status').forEach(el => {
      el.textContent = statusText;
      el.style.color = statusColor;
    });
  },

  /** 按题号分组自然序排序：数字题在前（1,2,3,10…），字母前缀题在后（a1,a2,a10…），其他格式最后 */
  _sortQuestionsByQid: function(questions) {
    const keyOf = (id) => {
      const s = String(id || '');
      const m = s.match(/^([a-z]*)(\d+)$/i);
      if (!m) return [2, s, 0];
      const prefix = (m[1] || '').toLowerCase();
      return [prefix === '' ? 0 : 1, prefix, parseInt(m[2], 10)];
    };
    const cmp = (ka, kb) => {
      if (ka[0] !== kb[0]) return ka[0] - kb[0];
      if (ka[0] === 2) return ka[1] < kb[1] ? -1 : ka[1] > kb[1] ? 1 : 0;
      if (ka[1] !== kb[1]) return ka[1] < kb[1] ? -1 : 1;
      return ka[2] - kb[2];
    };
    return questions.sort((a, b) => cmp(keyOf(a.question_id), keyOf(b.question_id)));
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

  /** 显示 API Key 填写弹窗 */
  _showApiKeyModal: function() {
    const configs = this.apiConfig.configs || [];
    const activeIdx = this.apiConfig.activeIndex || 0;
    const active = configs[activeIdx] || configs[0] || { name: '', key: '', baseUrl: '', model: '' };

    // 配置列表项
    let configListHtml = '<div style="margin-bottom:12px;max-height:120px;overflow-y:auto">';
    configs.forEach((c, i) => {
      const isActive = i === activeIdx;
      configListHtml += `<div style="display:flex;align-items:center;gap:8px;padding:4px 6px;background:${isActive ? 'var(--gray-1)' : 'transparent'};border-radius:4px;cursor:pointer" onclick="App._switchApiConfig(${i})">
        <span style="font-weight:${isActive ? '600' : '400'}">${isActive ? '▶' : ''} ${c.name || '未命名'}</span>
        <span style="font-size:11px;color:var(--gray-4);flex:1">${c.model || ''}</span>
        <span style="color:${c.key ? 'var(--success-green)' : 'var(--error-red)'};font-size:11px">${c.key ? '●' : '○'}</span>
      </div>`;
    });
    configListHtml += '</div>';

    const bodyHtml = `
      ${configListHtml}
      <div style="display:flex;flex-direction:column;gap:8px">
        <input class="input" id="cfg-name" placeholder="配置名称" value="${active.name || ''}">
        <input class="input" id="cfg-key" placeholder="API Key" value="${active.key || ''}">
        <input class="input" id="cfg-url" placeholder="API Base URL" value="${active.baseUrl || 'https://api.deepseek.com'}">
        <input class="input" id="cfg-model" placeholder="模型名称" value="${active.model || ''}">
      </div>
    `;
    const footerHtml = `
      <div style="display:flex;gap:8px">
        <button class="btn btn-secondary btn-sm" onclick="App._addApiConfig()">➕ 新建</button>
        <button class="btn btn-secondary btn-sm" onclick="App._deleteApiConfig()" ${configs.length <= 1 ? 'disabled' : ''}>🗑 删除</button>
        <button class="btn btn-primary" onclick="App._saveApiKeys()" style="margin-left:auto">✅ 保存并连接</button>
      </div>
    `;

    Components.showModal('API Key 设置', bodyHtml, footerHtml);
  },

  /** 切换 API 配置 */
  _switchApiConfig: function(index) {
    this.apiConfig.activeIndex = index;
    this._saveApiConfig();
    this._updateModelStatusDisplay();
    Components.closeModal();
    this._showApiKeyModal();
  },

  /** 新建空白配置 */
  _addApiConfig: function() {
    const configs = this.apiConfig.configs || [];
    configs.push({ name: `配置${configs.length + 1}`, key: '', baseUrl: 'https://api.deepseek.com', model: '' });
    this.apiConfig.activeIndex = configs.length - 1;
    this._saveApiConfig();
    Components.closeModal();
    this._showApiKeyModal();
  },

  /** 删除当前配置 */
  _deleteApiConfig: function() {
    const configs = this.apiConfig.configs || [];
    if (configs.length <= 1) return;
    const idx = this.apiConfig.activeIndex || 0;
    configs.splice(idx, 1);
    this.apiConfig.activeIndex = Math.min(idx, configs.length - 1);
    this._saveApiConfig();
    Components.closeModal();
    this._showApiKeyModal();
  },

  /** 保存当前配置并测试连接 */
  _saveApiKeys: async function() {
    const name = document.getElementById('cfg-name').value.trim() || '未命名';
    const key = document.getElementById('cfg-key').value.trim();
    const baseUrl = document.getElementById('cfg-url').value.trim() || 'https://api.deepseek.com';
    const model = document.getElementById('cfg-model').value.trim();

    if (!key) {
      alert('请输入 API Key');
      return;
    }

    this._setModalStatus('正在连接...', 'pending');

    try {
      const result = await this._testConnection(model || 'deepseek-chat', key, baseUrl);

      if (!result.ok) {
        throw new Error(result.msg);
      }

      // 保存配置
      const idx = this.apiConfig.activeIndex || 0;
      if (!this.apiConfig.configs) this.apiConfig.configs = [];
      this.apiConfig.configs[idx] = {
        name: name,
        key: key,
        baseUrl: baseUrl,
        model: result.modelUsed || model,
      };
      this._saveApiConfig();
      this._updateModelStatusDisplay();

      this._setModalStatus(`✅ 连接成功！模型: ${result.modelUsed}`, 'success');
      setTimeout(() => Components.closeModal(), 1200);
    } catch (e) {
      this._setModalStatus(`❌ ${e.message}`, 'error');
    }
  },

  /** 测试模型连接 */
  _testConnection: async function(modelName, apiKey, baseUrl) {
    const url = (baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '') + '/chat/completions';
    const model = modelName || 'deepseek-chat';
    const body = {
      model: model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 5,
    };
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const errData = await resp.json().catch(() => ({}));
      return { ok: false, msg: `连接失败 (${resp.status}): ${errData.error?.message || resp.statusText}` };
    }
    const data = await resp.json();
    const modelUsed = data.model || model;
    return { ok: true, modelUsed, msg: `模型 ${modelUsed} 连接成功` };
  },

  /** 在 modal 中显示连接状态 */
  _setModalStatus: function(text, type) {
    let el = document.getElementById('conn-status');
    const colors = { pending: '#f59e0b', success: '#22c55e', error: '#ef4444' };
    if (!el) {
      el = document.createElement('div');
      el.id = 'conn-status';
      el.style.cssText = 'margin-top:12px;padding:8px 12px;border-radius:6px;text-align:center;font-weight:600;font-size:14px';
      const footer = document.querySelector('.modal-footer');
      if (footer) footer.before(el);
    }
    el.textContent = text;
    el.style.color = colors[type] || '#333';
    el.style.background = type === 'error' ? '#fef2f2' : type === 'success' ? '#f0fdf4' : '#fffbeb';
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
      const activeCfg = this._getActiveConfig();
      const response = await API.sendChatStream({
        message: text,
        model_name: activeCfg.model,
        api_key: activeCfg.key,
        api_base_url: activeCfg.baseUrl,
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
      fake_interference: true,
      interference_density: parseFloat(document.getElementById('auto-interference-density')?.value || '0.001'),
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
    const container = document.getElementById('preview-container');
    if (container) container.innerHTML = '';
  },

  /** 重新出题：保留表单输入，清除上次预览缓存并重新生成 */
  _reAutoGenerate: async function() {
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
    // 用现有表单参数重新生成
    await this._onAutoGenerate();
  },

  // ============================================================
  // 选择性问题出题初始化
  // ============================================================
  initSelectiveQuestion: function() {
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

    // 干扰密度滑块联动
    const densitySlider = document.getElementById('sel-density');
    const densityLabel = document.getElementById('sel-density-label');
    if (densitySlider && densityLabel) {
      densitySlider.oninput = function() {
        densityLabel.textContent = parseFloat((this.value * 100).toFixed(3)) + '%';
      };
    }

    // 题型切换显示混合配置
    const typeSelect = document.getElementById('sel-question-type');
    if (typeSelect) {
      typeSelect.onchange = function() {
        const mixedConfig = document.getElementById('sel-mixed-config');
        if (mixedConfig) {
          const show = this.value === 'mixed';
          mixedConfig.style.display = show ? 'block' : 'none';
          if (show) App._renderSegmentPlans('sel');
        }
      };
    }

    // 换乘次数变化时重新渲染
    document.addEventListener('change', function(e) {
      if (e.target.id === 'sel-mixed-transfers') {
        App._renderSegmentPlans('sel');
      }
    });

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

  /** 选择性出题 */
  _onSelectiveGenerate: async function() {
    const form = {
      question_type: document.getElementById('sel-question-type')?.value || 'direct',
      mode: 'selective',
      from_station_id: document.getElementById('sel-from-station')?.value.trim(),
      to_station_id: document.getElementById('sel-to-station')?.value.trim(),
      random_tickets: true,
      fake_interference: false,
      interference_density: parseFloat(document.getElementById('sel-density')?.value || '0.02'),
      people_count: parseInt(document.getElementById('sel-people-count')?.value || '2', 10),
      seat_type: document.getElementById('sel-seat-type')?.value || 'class2',
      depart_earliest: document.getElementById('sel-depart-earliest')?.value || null,
      depart_latest: document.getElementById('sel-depart-latest')?.value || null,
      arrive_earliest: document.getElementById('sel-arrive-earliest')?.value || null,
      arrive_latest: document.getElementById('sel-arrive-latest')?.value || null,
      min_transfer_minutes: parseInt(document.getElementById('sel-min-transfer')?.value || '0', 10) || 0,
      max_transfer_minutes: parseInt(document.getElementById('sel-max-transfer')?.value || '', 10) || null,
      custom_qid: document.getElementById('sel-output-qid')?.value.trim() || '',
    };

    // 题目名必填
    if (!form.custom_qid) {
      alert('请填写题目名');
      return;
    }

    // 混合题型
    if (form.question_type === 'mixed') {
      form.transfers = parseInt(document.getElementById('sel-mixed-transfers')?.value || '1', 10);
      form.segment_plans = [];
      for (let i = 0; i <= form.transfers; i++) {
        const sel = document.getElementById('sel-seg-' + i);
        form.segment_plans.push(sel ? sel.value : 'direct');
      }
      if (form.transfers < 1) {
        alert('换乘数至少为 1');
        return;
      }
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
    const density = document.getElementById('sel-density')?.value || '0.15';

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
      confirmBtn.dataset.density = document.getElementById('sel-density')?.value || '0.08';
    }
    const reBtn = document.getElementById('btn-sel-regenerate');
    if (reBtn) {
      reBtn.style.display = 'inline-flex';
      reBtn.dataset.questionId = qid;
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
    // 用现有表单参数重新生成
    await this._onSelectiveGenerate();
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

    this._refreshQuestionList();
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
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--gray-4);padding:30px">暂无符合条件的题目</td></tr>';
        return;
      }

      const sorted = this._sortQuestionsByQid(data.questions);
      let html = '';
      sorted.forEach(q => {
        const qtypeLabel = q.question_type ? this._questionTypeLabel(q.question_type) : (q.type || '-');
        const modeTag = (q.type && q.type !== q.question_type) ? ` <span style="color:${q.type === '选择性' ? '#7c3aed' : '#2563eb'};font-size:11px">(${q.type})</span>` : '';
        const ansPreview = q.answer ? q.answer.substring(0, 30) + (q.answer.length > 30 ? '...' : '') : '-';
        html += `<tr>
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
      } else if (planStatus === 'no_solution') {
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
        'db_not_found': { label: '❌ 题目数据库不存在', bg: '#fef2f2', color: '#dc2626' },
      };
      const vInfo = verdictMap[verify.verdict] || { label: verify.verdict || '未知', bg: '#f5f5f5', color: '#6b7280' };
      const hasIssues = (verify.issues || []).length > 0;

      // 题型模式（存在性/选择性检测不同）
      const modeMap = {
        'fake': { label: '存在性问题 · 答案唯一（对标标答）', color: '#2563eb', bg: '#eff6ff' },
        'real': { label: '选择性问题 · 答案多个（全程可达+时间约束）', color: '#7c3aed', bg: '#f5f3ff' },
      };
      const modeInfo = modeMap[verify.question_mode] || { label: '题目类型未知（按存在性核查）', color: '#6b7280', bg: '#f3f4f6' };

      // ---- 问题类型元数据：标签 + 颜色 + 分组 ----
      const ISSUE_META = {
        'hallucination': { label: '余票不符', color: '#dc2626', group: '硬错误' },
        'price_wrong': { label: '票价不符', color: '#dc2626', group: '硬错误' },
        'route_mismatch': { label: '路线不符标答', color: '#dc2626', group: '硬错误' },
        'route_invalid': { label: '区间无效', color: '#dc2626', group: '硬错误' },
        'route_discontinuity': { label: '乘坐不连续', color: '#dc2626', group: '硬错误' },
        'transfer_time_conflict': { label: '换乘时间冲突', color: '#dc2626', group: '硬错误' },
        'start_not_covered': { label: '未连接出发站', color: '#dc2626', group: '硬错误' },
        'end_not_covered': { label: '未连接到达站', color: '#dc2626', group: '硬错误' },
        'no_route': { label: '无可达路线', color: '#dc2626', group: '硬错误' },
        'transfer_too_short': { label: '换乘时间不足', color: '#f59e0b', group: '约束' },
        'transfer_too_long': { label: '换乘时间过长', color: '#f59e0b', group: '约束' },
        'depart_time_violation': { label: '出发时间不符', color: '#f59e0b', group: '约束' },
        'arrive_time_violation': { label: '到达时间不符', color: '#f59e0b', group: '约束' },
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
      html += card(verify.correct_items || 0, '正确', '#16a34a', '#f0fdf4');
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
        test_file: '',
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
          <div class="stat-card"><div class="stat-card-value">${summary.completion_rate || 0}%</div><div class="stat-card-label">完成率</div></div>
          <div class="stat-card"><div class="stat-card-value">${summary.hallucination_rate || 0}%</div><div class="stat-card-label">错误率</div></div>
        `;
      }

      // 渲染模型对比表格
      const tableContainer = document.getElementById('model-comparison-table');
      if (tableContainer && data.models) {
        let html = '<table class="table"><thead><tr><th>模型</th><th>测试数</th><th>完成率</th><th>错误率</th><th>平均分</th><th>平均Token</th><th>平均耗时</th></tr></thead><tbody>';
        for (const [name, stats] of Object.entries(data.models)) {
          html += `<tr>
            <td><strong>${name}</strong></td>
            <td>${stats.total_tests}</td>
            <td>${stats.completion_rate}%</td>
            <td>${stats.hallucination_rate}%</td>
            <td>${stats.avg_score}</td>
            <td>${stats.avg_tokens}</td>
            <td>${stats.avg_duration}s</td>
          </tr>`;
        }
        html += '</tbody></table>';
        tableContainer.innerHTML = html;
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