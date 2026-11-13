// Giao diện chat + vòng lặp tool (agent loop).
//
// Luồng: người dùng gõ yêu cầu -> gửi lịch sử lên /api/chat -> Claude trả lời, có thể kèm
// các lệnh tool_use -> trình duyệt chạy từng lệnh trong Photopea -> gửi tool_result lên lại
// -> lặp cho tới khi Claude trả lời xong (không còn tool_use).
import { PhotopeaBridge } from './photopea-bridge.js';
import { ToolRunner } from './tool-runner.js';
import { toolLabel } from '/shared/tools.js';
import { setupColorPanel, setupFillPanel } from './quick-panels.js';

const MAX_ROUNDS = 30; // số lượt gọi Claude tối đa cho một yêu cầu
const PREVIEW_SIZE = 768; // cạnh dài ảnh xem trước gửi cho Claude (đủ để đánh giá màu, ít token hơn 1024)
// Các tool không làm thay đổi ảnh nhìn thấy được: không cần gắn ảnh "sau khi chỉnh".
const NON_VISUAL_TOOLS = new Set(['get_document_info', 'view_image', 'export_image', 'select_area', 'select_by_color', 'create_document']);

const $ = (id) => document.getElementById(id);
const els = {
  iframe: $('photopea'),
  editorLoading: $('editor-loading'),
  status: $('status'),
  notice: $('notice'),
  chat: $('chat'),
  empty: $('empty'),
  composer: $('composer'),
  input: $('input'),
  send: $('send-btn'),
  stop: $('stop-btn'),
  openBtn: $('open-btn'),
  fileInput: $('file-input'),
  downloadBtn: $('download-btn'),
  downloadMenu: $('download-menu'),
  newChat: $('new-chat-btn'),
  dropOverlay: $('drop-overlay'),
};

const state = {
  /** @type {Array<{role: 'user'|'assistant', content: any}>} lịch sử gửi cho Claude (chỉ nối thêm, không sửa) */
  messages: [],
  busy: false,
  stopRequested: false,
  abort: null,
  /** ghi chú hệ thống gửi kèm tin nhắn tiếp theo (ví dụ: người dùng vừa mở ảnh mới) */
  pendingNotes: [],
  /** token đã dùng cho mỗi lần gọi Claude (để theo dõi chi phí) */
  usage: [],
  /** server có bật chỉnh sửa bằng AI tạo ảnh không */
  aiEnabled: false,
};

const bridge = new PhotopeaBridge(els.iframe, { config: { environment: { lang: 'vi' } } });
const runner = new ToolRunner(bridge, { onDownload: triggerDownload });

/** Thêm ghi chú hệ thống cho tin nhắn tiếp theo; ghi chú cùng key thay thế ghi chú cũ. */
function addNote(key, text) {
  state.pendingNotes = state.pendingNotes.filter((n) => n.key !== key);
  state.pendingNotes.push({ key, text });
}

const colorPanel = setupColorPanel({ runner, bridge, isBusy: () => state.busy, addNote });
rememberOpen(document.getElementById('color-panel'), 'bokin.colorPanelOpen');
const fillPanel = setupFillPanel({ runner, isBusy: () => state.busy, addNote });
rememberOpen(document.getElementById('fill-panel'), 'bokin.fillPanelOpen');

// Cho phép kiểm thử tự động / gỡ lỗi từ console.
window.bokin = { bridge, runner, state, executeTool: (name, input) => runner.execute(name, input) };

// ───────────────────────────── Khởi động ─────────────────────────────
setStatus('Đang tải Photopea…');
bridge.ready.then(() => {
  els.editorLoading.hidden = true;
  setStatus('Photopea đã sẵn sàng', 'ok');
});

fetch('/api/health')
  .then((r) => r.json())
  .then((h) => {
    if (!h.has_api_key) {
      showNotice('Server chưa có ANTHROPIC_API_KEY. Tạo file .env (xem .env.example), điền key rồi khởi động lại server.');
    }
    state.aiEnabled = Boolean(h.ai_edit?.enabled);
    fillPanel.setEnabled(state.aiEnabled);
    if (state.aiEnabled) {
      for (const text of ['Xoá vật thể trong vùng tôi vừa khoanh', 'Đổi nền thành bãi biển lúc hoàng hôn']) {
        const chip = make('button', '', text);
        chip.type = 'button';
        $('suggestions').append(chip);
      }
    }
  })
  .catch(() => showNotice('Không kết nối được server. Hãy chạy "npm start".'));

// ───────────────────────────── Gửi tin nhắn ─────────────────────────────
els.composer.addEventListener('submit', (e) => {
  e.preventDefault();
  submitInput();
});
els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submitInput();
  }
});
els.input.addEventListener('input', autoGrow);
// Khi người dùng vừa khoanh vùng trong Photopea rồi bấm vào ô chat: cho biết Bokin thấy vùng chọn đó
// (giống Generative Fill của Photoshop: khoanh vùng -> gõ yêu cầu).
els.input.addEventListener('focus', updateSelectionHint);
$('suggestions').addEventListener('click', (e) => {
  const button = e.target.closest('button');
  if (button) send(button.textContent.trim());
});
els.stop.addEventListener('click', () => {
  state.stopRequested = true;
  state.abort?.abort();
});

function submitInput() {
  const text = els.input.value.trim();
  if (!text || state.busy) return;
  els.input.value = '';
  autoGrow();
  send(text);
}

async function send(text) {
  if (state.busy) return;
  $('selection-hint').hidden = true;
  setBusy(true);
  renderUser(text);
  // Gửi kèm trạng thái hiện tại (thông tin ảnh + ảnh xem trước) để Claude không phải tốn 2 lượt gọi đầu tiên.
  const snapshot = await snapshotBlocks().catch(() => []);
  const content = [...snapshot, ...state.pendingNotes.map((note) => ({ type: 'text', text: note.text }))];
  state.pendingNotes = [];
  content.push({ type: 'text', text });
  state.messages.push({ role: 'user', content });
  await runLoop();
}

/** Ảnh chụp trạng thái tự động gửi kèm mỗi tin nhắn của người dùng. */
async function snapshotBlocks() {
  const info = await runner.execute('get_document_info', {});
  if (info.isError) return [];
  const data = JSON.parse(info.content);
  if (!data.has_document) return [{ type: 'text', text: '(Trạng thái tự động: chưa có ảnh nào đang mở trong Photopea.)' }];
  const blocks = [{
    type: 'text',
    text: `(Trạng thái tự động lúc người dùng gửi tin nhắn; không cần gọi get_document_info hay view_image để xem lại.)\nThông tin ảnh: ${JSON.stringify(data)}`,
  }];
  const preview = await runner.execute('view_image', { max_size: PREVIEW_SIZE });
  if (!preview.isError) blocks.push(...preview.content);
  return blocks;
}

async function runLoop() {
  if (!state.busy) setBusy(true);
  try {
    await agentLoop();
  } catch (error) {
    if (error.name === 'AbortError') renderInfo('Đã dừng.');
    else renderError(error.message, () => runLoop());
  } finally {
    setBusy(false);
  }
}

async function agentLoop() {
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (state.stopRequested) {
      renderInfo('Đã dừng.');
      return;
    }
    const data = await callClaude();
    if (data.usage) state.usage.push({ model: data.model, ...data.usage });

    if (data.stop_reason === 'refusal') {
      // Bỏ tin nhắn bị từ chối khỏi lịch sử (nếu là tin nhắn chữ của người dùng) để không ảnh hưởng các lượt sau.
      const last = state.messages.at(-1);
      if (last?.role === 'user' && !last.content.some?.((b) => b.type === 'tool_result')) state.messages.pop();
      renderError('Yêu cầu này không được xử lý (bị bộ lọc an toàn từ chối). Hãy diễn đạt lại.');
      return;
    }

    const content = data.content ?? [];
    if (content.length) state.messages.push({ role: 'assistant', content });
    for (const block of content) {
      if (block.type === 'text' && block.text.trim()) renderAssistant(block.text);
    }

    const toolUses = content.filter((b) => b.type === 'tool_use');
    if (toolUses.length === 0) {
      if (data.stop_reason === 'max_tokens') renderInfo('Câu trả lời bị cắt ngắn do quá dài.');
      return;
    }

    const results = [];
    for (const toolUse of toolUses) {
      if (state.stopRequested || data.stop_reason === 'max_tokens') {
        results.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          is_error: true,
          content: state.stopRequested ? 'Người dùng đã dừng thao tác.' : 'Tham số bị cắt ngắn (max_tokens); hãy gọi lại.',
        });
        continue;
      }
      const step = renderStep(toolUse);
      const outcome = await runner.execute(toolUse.name, toolUse.input ?? {});
      finishStep(step, outcome);
      results.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: outcome.content,
        ...(outcome.isError ? { is_error: true } : {}),
      });
    }
    await attachAfterPreview(toolUses, results);
    // Luôn gửi đủ tool_result cho mọi tool_use để lịch sử hợp lệ.
    state.messages.push({ role: 'user', content: results });
  }
  renderInfo(`Đã chạy ${MAX_ROUNDS} lượt cho yêu cầu này. Gõ "tiếp tục" nếu muốn làm tiếp.`);
}

/**
 * Sau một lượt có chỉnh sửa nhìn thấy được, gắn ảnh kết quả vào tool_result thành công cuối cùng,
 * để Claude kiểm tra ngay mà không phải gọi thêm view_image (tiết kiệm một lượt gọi).
 */
async function attachAfterPreview(toolUses, results) {
  if (toolUses.some((t) => t.name === 'view_image')) return;
  let index = -1;
  results.forEach((r, i) => { if (!r.is_error && !NON_VISUAL_TOOLS.has(toolUses[i].name)) index = i; });
  if (index < 0) return;
  const preview = await runner.execute('view_image', { max_size: PREVIEW_SIZE });
  if (preview.isError) return;
  const r = results[index];
  const base = typeof r.content === 'string' ? [{ type: 'text', text: r.content }] : r.content;
  r.content = [...base, { type: 'text', text: 'Ảnh sau khi chỉnh (tự động):' }, ...preview.content];
}

async function callClaude() {
  const thinking = renderThinking();
  state.abort = new AbortController();
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: state.messages }),
      signal: state.abort.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Server trả lỗi HTTP ${res.status}`);
    return data;
  } finally {
    thinking.remove();
    state.abort = null;
  }
}

async function updateSelectionHint() {
  const hint = $('selection-hint');
  if (state.busy || !bridge.isReady) return;
  const sel = await runner._selectionBounds().catch(() => null);
  if (!sel) {
    hint.hidden = true;
    return;
  }
  const size = `${Math.round(sel.width)}×${Math.round(sel.height)} px`;
  hint.textContent = state.aiEnabled
    ? `Đang có vùng chọn ${size}. Ví dụ: "xoá vật thể trong vùng chọn", "thêm một chậu cây vào đây", "chỉnh màu vùng này ấm hơn".`
    : `Đang có vùng chọn ${size}: các chỉnh sửa (màu, sáng, bộ lọc…) sẽ chỉ áp dụng trong vùng này.`;
  hint.hidden = false;
}

function setBusy(busy) {
  state.busy = busy;
  if (busy) state.stopRequested = false;
  els.send.disabled = busy;
  els.stop.hidden = !busy;
  els.input.placeholder = busy ? 'Bokin đang làm…' : 'Ví dụ: tăng độ sáng 20%, làm nét ảnh, thêm viền trắng 40px…';
}

// ───────────────────────────── Mở / tải ảnh ─────────────────────────────
els.openBtn.addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', () => {
  const file = els.fileInput.files?.[0];
  if (file) openFile(file);
  els.fileInput.value = '';
});

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types?.includes('Files')) return;
  dragDepth++;
  els.dropOverlay.hidden = false;
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) els.dropOverlay.hidden = true;
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  els.dropOverlay.hidden = true;
  const file = e.dataTransfer?.files?.[0];
  if (file) openFile(file);
});

async function openFile(file) {
  try {
    setStatus(`Đang mở ${file.name}…`);
    await bridge.openFile(await file.arrayBuffer(), file.name);
    runner.undoDepth = 0;
    colorPanel.reset();
    addNote('opened-file', `(Ghi chú hệ thống: người dùng vừa mở ảnh "${file.name}" trong Photopea; đây là tài liệu đang hoạt động.)`);
    renderInfo(`Đã mở ảnh: ${file.name}`);
    setStatus('Photopea đã sẵn sàng', 'ok');
  } catch (error) {
    renderError(error.message);
    setStatus('Photopea đã sẵn sàng', 'ok');
  }
}

els.downloadBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleMenu(els.downloadMenu.hidden);
});
document.addEventListener('click', () => toggleMenu(false));
els.downloadMenu.addEventListener('click', async (e) => {
  const format = e.target.closest('button')?.dataset.format;
  if (!format) return;
  toggleMenu(false);
  const outcome = await runner.execute('export_image', { format });
  if (outcome.isError) renderError(outcome.content);
});

function toggleMenu(open) {
  els.downloadMenu.hidden = !open;
  els.downloadBtn.setAttribute('aria-expanded', String(open));
}

function triggerDownload(url, name) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
}

els.newChat.addEventListener('click', () => {
  if (state.busy) {
    state.stopRequested = true;
    state.abort?.abort();
  }
  state.messages = [];
  state.pendingNotes = [];
  els.chat.replaceChildren(els.empty);
  els.empty.hidden = false;
  els.input.focus();
});

// ───────────────────────────── Hiển thị ─────────────────────────────
function append(el) {
  els.empty.hidden = true;
  els.chat.append(el);
  els.chat.scrollTop = els.chat.scrollHeight;
  return el;
}

function make(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function renderUser(text) {
  append(make('div', 'msg user', text));
}

function renderAssistant(text) {
  const el = make('div', 'msg assistant');
  el.innerHTML = miniMarkdown(text);
  append(el);
}

function renderInfo(text) {
  append(make('div', 'msg info', text));
}

function renderError(text, retry) {
  const el = make('div', 'msg error', text);
  if (retry) {
    const button = make('button', 'btn', 'Thử lại');
    button.type = 'button';
    button.addEventListener('click', () => {
      el.remove();
      if (!state.busy) retry();
    }, { once: true });
    el.append(document.createElement('br'), button);
  }
  append(el);
}

function renderThinking() {
  return append(make('div', 'thinking', 'Đang suy nghĩ'));
}

function renderStep(toolUse) {
  const el = make('div', 'step running');
  el.append(make('span', 'step-icon'), make('span', 'step-label', toolLabel(toolUse.name)));
  const detail = summarizeInput(toolUse.name, toolUse.input ?? {});
  if (detail) {
    const d = make('span', 'step-detail', detail);
    d.title = detail;
    el.append(d);
  }
  return append(el);
}

function finishStep(el, outcome) {
  el.classList.remove('running');
  el.classList.add(outcome.isError ? 'error' : 'ok');
  if (outcome.isError) el.append(make('span', 'step-error', String(outcome.content)));
  if (outcome.preview) {
    const img = make('img');
    img.src = outcome.preview;
    img.alt = 'Ảnh Bokin vừa xem';
    el.append(img);
  }
  if (outcome.download) {
    const a = make('a', '', `Tải lại ${outcome.download.name}`);
    a.href = outcome.download.url;
    a.download = outcome.download.name;
    el.append(a);
  }
  els.chat.scrollTop = els.chat.scrollHeight;
}

function summarizeInput(name, input) {
  if (name === 'run_script') return input.purpose ?? '';
  if (name === 'ai_edit') return `(có thể mất tới 1 phút) ${input.instruction}`;
  return Object.entries(input)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join(', ')
    .slice(0, 200);
}

/** Nhớ trạng thái mở/đóng của một bảng <details> (chỉ là tiện ích, không bắt buộc). */
function rememberOpen(details, key) {
  try {
    if (localStorage.getItem(key) === '1') details.open = true;
    details.addEventListener('toggle', () => {
      try { localStorage.setItem(key, details.open ? '1' : '0'); } catch { /* bỏ qua */ }
    });
  } catch { /* localStorage có thể bị chặn */ }
}

function setStatus(text, kind = '') {
  els.status.textContent = text;
  els.status.className = `brand-sub ${kind}`;
}

function showNotice(text) {
  els.notice.textContent = text;
  els.notice.hidden = false;
}

function autoGrow() {
  els.input.style.height = 'auto';
  els.input.style.height = `${Math.min(els.input.scrollHeight, 160)}px`;
}

/** Markdown tối giản và an toàn (escape HTML trước): đoạn văn, danh sách "- ", **đậm**, `code`. */
function miniMarkdown(text) {
  const escape = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const inline = (s) => escape(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  const out = [];
  let list = null;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const item = line.match(/^\s*[-*•]\s+(.*)$/);
    if (item) {
      list ??= [];
      list.push(`<li>${inline(item[1])}</li>`);
      continue;
    }
    if (list) {
      out.push(`<ul>${list.join('')}</ul>`);
      list = null;
    }
    if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push(`<ul>${list.join('')}</ul>`);
  return out.join('');
}
