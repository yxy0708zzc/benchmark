/**
 * 可复用前端组件模块
 * 包含：半矩阵渲染、工具调用卡片、消息气泡、模态框等
 */

const Components = {
  /**
   * 渲染半矩阵表格
   * @param {Array} stops - 经停站列表 [{station_id, station_name, stop_no}]
   * @param {Object} data - 余票数据 { "from|to": count, ... }
   * @param {string} trainNum - 车次号
   * @param {string} questionId - 题目 ID
   * @param {string} seatType - 座位类型 (class0/class1/class2)
   * @param {Function} onChange - 修改回调 (from, to, value)
   * @param {boolean} readOnly - 是否只读
   * @returns {string} HTML 字符串
   */
  renderMatrixTable: function(stops, data, trainNum, questionId, seatType, onChange, readOnly = false) {
    const names = stops.map(s => s.station_name);
    const ids = stops.map(s => s.station_id);
    const n = stops.length;

    let html = '<table class="matrix-table">';
    
    // 表头
    html += '<thead><tr><th>出发\\到达</th>';
    for (let j = 0; j < n; j++) {
      html += `<th title="${ids[j]}">${this._truncate(names[j], 4)}</th>`;
    }
    html += '</tr></thead><tbody>';

    for (let i = 0; i < n; i++) {
      html += `<tr><th title="${ids[i]}">${this._truncate(names[i], 4)}</th>`;
      for (let j = 0; j < n; j++) {
        if (i === j) {
          // 对角线
          html += '<td class="disabled-cell">—</td>';
        } else if (i > j) {
          // 左下三角
          html += '<td class="disabled-cell">—</td>';
        } else {
          // 右上三角（可编辑）
          const key = `${ids[i]}|${ids[j]}`;
          const value = data[key] !== undefined ? data[key] : 0;
          const valueClass = value > 0 ? 'ticket-positive' : 'ticket-zero';
          
          if (readOnly) {
            html += `<td class="editable-cell"><span class="${valueClass}">${value}</span></td>`;
          } else {
            html += `<td class="editable-cell">
              <input type="number" min="0" max="30" value="${value}"
                class="${valueClass}"
                data-from="${ids[i]}" data-to="${ids[j]}"
                data-from-name="${names[i]}" data-to-name="${names[j]}"
                data-original="${value}"
                oninput="Components._handleMatrixInput(this, '${questionId}', '${trainNum}', '${seatType}')"
                onblur="Components._handleMatrixBlur(this, '${questionId}', '${trainNum}', '${seatType}')"
              />
            </td>`;
          }
        }
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    return html;
  },

  /** 截断字符串 */
  _truncate: function(str, maxLen) {
    return str.length > maxLen ? str.substring(0, maxLen) : str;
  },

  /** 矩阵输入框实时输入（带防抖，输入即存，解决焦点不移走就不存的问题） */
  _handleMatrixInput: function(input, questionId, trainNum, seatType) {
    if (input._saveTimer) clearTimeout(input._saveTimer);
    input._saveTimer = setTimeout(() => {
      this._handleMatrixBlur(input, questionId, trainNum, seatType);
    }, 400);
  },

  /** 矩阵输入框失焦处理 */
  _handleMatrixBlur: function(input, questionId, trainNum, seatType) {
    if (input._saveTimer) {
      clearTimeout(input._saveTimer);
      input._saveTimer = null;
    }
    const original = parseInt(input.dataset.original) || 0;
    const current = parseInt(input.value) || 0;
    if (current !== original) {
      this._handleMatrixChange(input, questionId, trainNum, seatType);
    }
  },

  /** 矩阵修改回调 */
  _handleMatrixChange: async function(input, questionId, trainNum, seatType) {
    let value = parseInt(input.value) || 0;
    if (value < 0) value = 0;
    if (value > 30) value = 30;
    input.value = value;

    const fromId = input.dataset.from;
    const toId = input.dataset.to;

    try {
      const result = await API.updateTicket({
        question_id: questionId,
        train_num: trainNum,
        from_station_id: fromId,
        to_station_id: toId,
        seat_type: seatType,
        tickets: value,
      });

      if (result.success) {
        input.className = value > 0 ? 'ticket-positive' : 'ticket-zero';
        input.dataset.original = String(value); // 更新基准值
      } else {
        console.error('余票保存失败:', result);
        input.style.borderColor = 'var(--error-red)';
      }
    } catch (e) {
      console.error('余票保存异常:', e);
      input.style.borderColor = 'var(--error-red)';
    }
  },

  /**
   * 渲染工具调用折叠卡片
   */
  renderToolCallCard: function(toolCall, index) {
    const args = typeof toolCall.arguments === 'string'
      ? toolCall.arguments
      : JSON.stringify(toolCall.arguments, null, 2);
    const result = typeof toolCall.result === 'string'
      ? toolCall.result
      : JSON.stringify(toolCall.result, null, 2);

    return `
      <div class="tool-call-card">
        <div class="tool-call-header" onclick="Components._toggleToolCall(this)">
          <span>🔧 [${index}] ${toolCall.tool_name}</span>
          <span>${toolCall.arguments?.from_station_id ? toolCall.arguments.from_station_id + '→' : ''}${toolCall.arguments?.to_station_id || toolCall.arguments?.train_num || toolCall.arguments?.station_id || toolCall.arguments?.keyword || ''}</span>
        </div>
        <div class="tool-call-body">
          <div><strong>参数:</strong></div>
          <pre>${args}</pre>
          <div><strong>结果:</strong></div>
          <pre>${result}</pre>
        </div>
      </div>
    `;
  },

  /** 切换工具调用折叠 */
  _toggleToolCall: function(header) {
    const body = header.nextElementSibling;
    body.classList.toggle('open');
  },

  /**
   * 渲染消息气泡
   * @param {boolean} plain  true=纯文本渲染（流式期间），false=Markdown 渲染（完成后）
   */
  renderMessage: function(role, content, toolCalls = [], reasoning = '', plain = false) {
    const roleClass = role === 'user' ? 'message-user' : 'message-assistant';
    const roleLabel = role === 'user' ? '用户' : '助手';
    const fmt = plain ? this._escapeHtml.bind(this) : this._formatContent.bind(this);

    let html = `<div class="message ${roleClass}">`;
    html += `<div class="message-bubble">`;
    html += `<div style="font-size:var(--font-size-small);color:var(--gray-4);margin-bottom:4px">${roleLabel}</div>`;

    // 思考链
    if (reasoning) {
      html += `<details style="margin-bottom:8px;font-size:var(--font-size-small)">
        <summary style="cursor:pointer;color:var(--gray-4);user-select:none">💭 思考过程</summary>
        <div style="margin-top:6px;padding:8px 10px;background:#f8f9fa;border-radius:6px;color:#555;line-height:1.6;border-left:3px solid #ddd">`;
      html += fmt(reasoning);
      html += `</div></details>`;
    }

    html += `<div>${fmt(content)}</div>`;

    // 工具调用：统一折叠目录（默认展开，避免流式刷新时自动合上）
    if (toolCalls && toolCalls.length > 0) {
      html += `<details class="tool-call-section">
        <summary style="cursor:pointer;padding:4px 0;user-select:none;color:var(--gray-5)">
          🔧 工具调用 (${toolCalls.length}次) <span style="font-size:var(--font-size-small);color:var(--gray-4)">点击展开</span>
        </summary>
        <div style="margin-top:6px">`;
      toolCalls.forEach((tc, i) => {
        html += this.renderToolCallCard(tc, i + 1);
      });
      html += `</div></details>`;
    }

    html += `</div></div>`;
    return html;
  },

  /** 格式化消息内容（Markdown 渲染） */
  _formatContent: function(content) {
    if (!content) return '';
    try {
      if (typeof marked !== 'undefined' && marked.parse) {
        return marked.parse(content, { breaks: true });
      }
    } catch (e) {
      // fallback
    }
    return content.replace(/\n/g, '<br>');
  },

  /** 流式纯文本渲染：先剥离 Markdown 语法标记（避免中间态显示源码乱码），再转义 HTML */
  _escapeHtml: function(content) {
    if (!content) return '';
    let s = String(content)
      .replace(/^#{1,6}\s*/gm, '')            // 标题 #、##
      .replace(/^\s*[-*+]\s+/gm, '')          // 无序列表 - * +
      .replace(/^\s*\d+[.)]\s+/gm, '')        // 有序列表 1. 1)
      .replace(/\*\*([^*]+)\*\*/g, '$1')      // 粗体 **x**
      .replace(/\*([^*]+)\*/g, '$1')           // 斜体 *x*
      .replace(/`{1,3}([^`]+)`{1,3}/g, '$1')    // 行内代码 `x`
      .replace(/^\s*>\s?/gm, '')              // 引用 >
      .replace(/!\[(.*?)\]\(.*?\)/g, '$1')   // 图片 ![alt](url)
      .replace(/\[(.*?)\]\(.*?\)/g, '$1')    // 链接 [text](url)
      .replace(/\|/g, '')                      // 表格管道符
      .replace(/^[\s-]+$/gm, '');              // 分隔线 / 表格分割行 ---
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/\n/g, '<br>');
  },

  /**
   * 渲染模态框
   */
  showModal: function(title, bodyHtml, footerHtml = '') {
    // 移除已有模态框
    this.closeModal();

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'modal-overlay';
    overlay.onclick = (e) => {
      if (e.target === overlay) this.closeModal();
    };

    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <div class="modal-title">${title}</div>
          <button class="modal-close" onclick="Components.closeModal()">&times;</button>
        </div>
        <div class="modal-body">${bodyHtml}</div>
        ${footerHtml ? `<div class="modal-footer">${footerHtml}</div>` : ''}
      </div>
    `;

    document.body.appendChild(overlay);

    // ESC 关闭
    this._escHandler = (e) => {
      if (e.key === 'Escape') this.closeModal();
    };
    document.addEventListener('keydown', this._escHandler);
  },

  /** 关闭模态框 */
  closeModal: function() {
    const overlay = document.getElementById('modal-overlay');
    if (overlay) overlay.remove();
    if (this._escHandler) {
      document.removeEventListener('keydown', this._escHandler);
      this._escHandler = null;
    }
  },

  /**
   * 渲染统计卡片
   */
  renderStatCard: function(label, value, icon = '') {
    return `
      <div class="stat-card">
        <div class="stat-card-value">${value}</div>
        <div class="stat-card-label">${icon ? icon + ' ' : ''}${label}</div>
      </div>
    `;
  },

  /**
   * 渲染加载动画
   */
  showLoading: function(containerId, text = '加载中...') {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = `<div style="padding:40px;text-align:center;color:var(--gray-4)">${text}</div>`;
  },
};