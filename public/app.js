// Giao diện chat + vòng lặp tool (agent loop).
//
// Luồng: người dùng gõ yêu cầu -> gửi lịch sử lên /api/chat -> Claude trả lời, có thể kèm
// các lệnh tool_use -> trình duyệt chạy từng lệnh trong Photopea -> gửi tool_result lên lại
// -> lặp cho tới khi Claude trả lời xong (không còn tool_use).
import { PhotopeaBridge } from './photopea-bridge.js';
import { ToolRunner } from './tool-runner.js';
import { toolLabel } from './shared/tools.js';
import { setupColorPanel, setupFillPanel, syncPaintButtons } from './quick-panels.js';
import { ActionLog } from './history.js';
import { usageCost, totalCost, formatUsd } from './shared/prices.js';
import { getJson, postJson } from './api.js';

const MAX_ROUNDS = 15; // số lượt gọi Claude tối đa cho một yêu cầu
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
  /** yêu cầu gần nhất đã gửi Claude (để giữ cache ấm) và thời điểm bắt đầu gửi */
  lastRequest: null,
  /** khoảng cách giữa các lần giữ cache ấm (ms) và số lần tối đa cho mỗi lần tạm dừng */
  keepAliveMs: 240_000,
  keepAliveMax: 5,
  keepAliveTimer: null,
  /** dữ liệu ảnh xem trước gần nhất Claude đã thấy trong cuộc trò chuyện này (để không gửi lại ảnh trùng) */
  lastPreviewData: null,
  // Ảnh mẫu (runner.reference) đã gửi cho Claude trong cuộc trò chuyện này chưa (theo id).
  referenceSentId: null,
  /** giới hạn chi phí ước tính cho một yêu cầu (USD; server gửi qua /api/health) */
  budget: 0.5,
  /** vị trí trong state.usage nơi yêu cầu hiện tại bắt đầu tính chi phí */
  requestUsageStart: 0,
  /** vị trí trong state.usage nơi cuộc trò chuyện hiện tại bắt đầu */
  conversationUsageStart: 0,
  /** đang chạy thao tác của thanh công cụ (hoàn tác, so sánh...) */
  toolbarBusy: false,
};

const bridge = new PhotopeaBridge(els.iframe, { config: { environment: { lang: 'vi' } } });
const runner = new ToolRunner(bridge, { onDownload: triggerDownload });

/** Thêm ghi chú hệ thống cho tin nhắn tiếp theo; ghi chú cùng key thay thế ghi chú cũ. */
function addNote(key, text, images = []) {
  state.pendingNotes = state.pendingNotes.filter((n) => n.key !== key);
  state.pendingNotes.push({ key, text, images });
}

// Ảnh mẫu để chỉnh màu giống (tab Màu nhanh và nút "🖼 Ảnh mẫu" của ô chat dùng chung một ảnh).
const referenceListeners = [];
const reference = {
  async set(file) {
    const ref = await runner.setReference(file, file.name || 'ảnh mẫu');
    referenceListeners.forEach((fn) => fn(ref));
    return ref;
  },
  clear() {
    runner.clearReference();
    referenceListeners.forEach((fn) => fn(null));
    if (state.referenceSentId) {
      addNote('reference', '(Ghi chú hệ thống: người dùng đã bỏ ảnh mẫu; không còn ảnh mẫu nào.)');
      state.referenceSentId = null;
    }
  },
  on(fn) {
    referenceListeners.push(fn);
  },
};

/** Lần đầu có ảnh mẫu trong cuộc trò chuyện: gửi kèm tin nhắn một ghi chú và ảnh mẫu thu nhỏ cho Claude. */
function referenceBlocks() {
  const ref = runner.reference;
  if (!ref || state.referenceSentId === ref.id) return [];
  state.referenceSentId = ref.id;
  return [
    { type: 'text', text: `(Ghi chú hệ thống: người dùng đã chọn ảnh mẫu "${ref.name}" (${ref.width}×${ref.height}) để lấy màu; ảnh thu nhỏ ở dưới. Muốn chỉnh màu vùng chọn hay cả ảnh giống ảnh mẫu thì dùng match_reference_colors.)` },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: ref.thumb.slice(ref.thumb.indexOf(',') + 1) } },
  ];
}

const log = new ActionLog(runner, bridge);
const isBusy = () => state.busy || state.toolbarBusy;
const openImage = () => els.fileInput.click();
const colorPanel = setupColorPanel({ runner, bridge, log, isBusy, addNote, openImage, reference });
const fillPanel = setupFillPanel({ runner, bridge, log, isBusy, addNote, openImage });

// Sau mỗi tool: có chỉnh sửa mới thì không còn gì để "làm lại"; cập nhật thẻ Bắt đầu và vùng chọn.
const NO_EDIT_TOOLS = new Set(['undo', 'redo', 'get_document_info', 'view_image', 'export_image']);
runner.onExecuted = async (name, outcome) => {
  if (!outcome.isError && !NO_EDIT_TOOLS.has(name)) log.clearRedo();
  if (!NO_EDIT_TOOLS.has(name)) scheduleRefresh();
  // Ảnh mới tạo (kể cả do Claude tạo): đây là "ảnh gốc" để so sánh.
  if (name === 'create_document' && !outcome.isError) {
    runner.areaEdits.clear();
    runner.picking = false;
    log.reset();
    await log.markOrigin();
  }
};

// Cho phép kiểm thử tự động / gỡ lỗi từ console.
// Tô vùng (Quick Mask): mọi nút "Tô vùng" cùng đổi; vùng chọn đổi nên không còn gì để "làm lại".
runner.onPaintChange = (on) => {
  syncPaintButtons(on);
  log.clearRedo();
  if (!on) scheduleRefresh();
};

// Ô chat: chip ảnh mẫu + nút đính kèm (cùng ô chọn tệp với tab Màu nhanh).
reference.on((ref) => {
  $('ref-chip').hidden = !ref;
  if (ref) {
    $('ref-chip-thumb').src = ref.thumb;
    $('ref-chip-name').textContent = `Ảnh mẫu: ${ref.name}`;
  }
});
$('ref-btn').addEventListener('click', () => $('match-file').click());
$('ref-chip-clear').addEventListener('click', () => reference.clear());

window.bokin = { bridge, runner, state, log, showTab, reference, executeTool: (name, input) => runner.execute(name, input) };

// ───────────────────────────── Khởi động ─────────────────────────────
setStatus('Đang tải Photopea…');
bridge.ready.then(() => {
  els.editorLoading.hidden = true;
  setStatus('Photopea đã sẵn sàng', 'ok');
  refreshUi();
});

getJson('api/health')
  .then((h) => {
    if (!h.has_api_key) {
      showNotice(h.hints?.no_key || 'Server chưa có ANTHROPIC_API_KEY. Tạo file .env (xem .env.example), điền key rồi khởi động lại server.');
    }
    if (h.max_cost_per_request > 0) state.budget = h.max_cost_per_request;
    state.aiEnabled = Boolean(h.ai_edit?.enabled);
    if (h.ai_edit?.max_side) runner.aiMaxSide = h.ai_edit.max_side;
    fillPanel.setEnabled(state.aiEnabled, h.hints?.no_ai);
    // Không có AI tạo ảnh (chưa cấu hình, hoặc quản trị viên tạm tắt Generative Fill): bỏ hẳn tab Tạo bằng AI.
    $('tab-fill').hidden = !state.aiEnabled;
    $('start-tip-fill').hidden = !state.aiEnabled;
    if (!state.aiEnabled && $('tab-fill').getAttribute('aria-selected') === 'true') showTab('color');
    if (state.aiEnabled) {
      for (const text of ['Xoá vật thể trong vùng tôi vừa khoanh', 'Đổi nền thành bãi biển lúc hoàng hôn']) {
        const chip = make('button', '', text);
        chip.type = 'button';
        $('suggestions').append(chip);
      }
    }
  })
  .catch((error) => showNotice(error?.status ? error.message : 'Không kết nối được máy chủ của Bokin (chạy trên máy thì gõ "npm start").'));

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
  showTab('chat');
  for (const old of els.chat.querySelectorAll('.followups')) old.remove();
  setBusy(true);
  renderUser(text);
  // Gửi kèm trạng thái hiện tại (thông tin ảnh + ảnh xem trước) để Claude không phải tốn 2 lượt gọi đầu tiên.
  const snapshot = await snapshotBlocks().catch(() => []);
  const content = [
    ...snapshot,
    ...state.pendingNotes.flatMap((note) => [{ type: 'text', text: note.text }, ...(note.images ?? [])]),
    ...referenceBlocks(),
  ];
  state.pendingNotes = [];
  content.push({ type: 'text', text });
  state.messages.push({ role: 'user', content });
  state.requestUsageStart = state.usage.length;
  // Ghi cả yêu cầu thành MỘT thao tác: bấm Hoàn tác là gỡ mọi chỉnh sửa Claude làm cho yêu cầu này.
  const short = text.length > 40 ? `${text.slice(0, 40)}…` : text;
  const before = log.undoStack.length;
  await log.record({ kind: 'chat', label: `yêu cầu "${short}"` }, () => runLoop());
  if (log.undoStack.length > before) renderFollowups();
  refreshUi();
}

/** Nút gợi ý sau câu trả lời có chỉnh sửa: chỉnh thêm nhanh, hoàn tác (miễn phí), tải ảnh. */
function renderFollowups() {
  const box = make('div', 'followups');
  const add = (label, onClick) => {
    const b = make('button', '', label);
    b.type = 'button';
    b.addEventListener('click', () => {
      if (isBusy()) return;
      box.remove();
      onClick();
    });
    box.append(b);
  };
  add('Mạnh hơn', () => send('Mạnh hơn một chút'));
  add('Nhẹ hơn', () => send('Nhẹ hơn một chút'));
  add('Hoàn tác', () => doUndo());
  add('Tải JPG', () => exportImage('jpg'));
  append(box);
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
  if (!preview.isError) blocks.push(...dedupePreview(preview, '(Ảnh không đổi so với ảnh xem trước gần nhất bạn đã thấy trong cuộc trò chuyện này.)'));
  return blocks;
}

/**
 * Trả về các khối ảnh xem trước để gửi Claude, hoặc chỉ một dòng chữ nếu ảnh giống hệt ảnh Claude
 * vừa thấy (so sánh chính dữ liệu ảnh, nên phát hiện được cả khi người dùng tự hoàn tác trong Photopea).
 */
function dedupePreview(preview, unchangedText) {
  const image = preview.content.find((b) => b.type === 'image');
  if (image && image.source.data === state.lastPreviewData) return [{ type: 'text', text: unchangedText }];
  if (image) state.lastPreviewData = image.source.data;
  return preview.content;
}

async function runLoop() {
  if (!state.busy) setBusy(true);
  stopKeepAlive();
  try {
    await agentLoop();
  } catch (error) {
    if (error.name === 'AbortError') renderInfo('Đã dừng.');
    else renderError(error.message, () => runLoop());
  } finally {
    setBusy(false);
    scheduleKeepAlive();
  }
}

/**
 * Cache của Claude giữ 5 phút kể từ lúc BẮT ĐẦU yêu cầu đọc/ghi nó. Khi người dùng tạm dừng (đang ngắm ảnh,
 * chỉnh tay trong Photopea...), gửi một yêu cầu max_tokens: 0 trước khi hết hạn để làm mới, tốn giá đọc cache
 * (~0,2 USD / triệu token với Opus 5.5) thay vì phải ghi lại cả lịch sử (~5 USD / triệu token) ở lần gõ sau.
 */
function scheduleKeepAlive(count = 0) {
  stopKeepAlive();
  const last = state.lastRequest;
  if (!last || count >= state.keepAliveMax) return;
  const delay = Math.max(0, last.startedAt + state.keepAliveMs - Date.now());
  state.keepAliveTimer = setTimeout(async () => {
    state.keepAliveTimer = null;
    if (state.busy || state.lastRequest !== last) return;
    // Nếu đã quá 5 phút (máy ngủ, tab bị treo...) thì cache đã hết hạn: gửi lúc này chỉ tốn tiền ghi lại vô ích.
    if (Date.now() - last.startedAt > Math.max(state.keepAliveMs + 30_000, 290_000)) return;
    const startedAt = Date.now();
    try {
      const data = await postJson('api/keepalive', { messages: last.messages });
      if (data.usage) state.usage.push({ model: data.model, kind: 'keepalive', ...data.usage });
      updateCostTotal();
    } catch {
      return;
    }
    last.startedAt = startedAt;
    scheduleKeepAlive(count + 1);
  }, delay);
}

function stopKeepAlive() {
  clearTimeout(state.keepAliveTimer);
  state.keepAliveTimer = null;
}

async function agentLoop() {
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (state.stopRequested) {
      renderInfo('Đã dừng.');
      return;
    }
    const spent = requestCost();
    if (round > 0 && spent > state.budget) {
      renderBudgetPause(spent);
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
      renderCostLine();
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
      const input = toolUse.input ?? {};
      if (toolUse.name === 'view_image' && !outcome.isError && !input.region && (input.max_size ?? PREVIEW_SIZE) === PREVIEW_SIZE) {
        state.lastPreviewData = outcome.content.find((b) => b.type === 'image')?.source.data ?? state.lastPreviewData;
      }
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
  renderCostLine();
}

/** Chi phí ước tính của yêu cầu hiện tại (không tính giữ cache ấm). */
function requestCost() {
  return totalCost(state.usage.slice(state.requestUsageStart).filter((u) => u.kind !== 'keepalive'));
}

/** Dòng nhỏ dưới câu trả lời: số lượt gọi và chi phí của yêu cầu; cập nhật tổng của cuộc trò chuyện. */
function renderCostLine() {
  const calls = state.usage.slice(state.requestUsageStart).filter((u) => u.kind !== 'keepalive');
  if (!calls.length) return;
  const unknown = calls.some((u) => usageCost(u) === null);
  append(make('div', 'msg meta', `${calls.length} lượt gọi · ${formatUsd(requestCost())}${unknown ? ' (chưa rõ giá model dự phòng)' : ''}`));
  updateCostTotal();
}

function updateCostTotal() {
  const used = state.usage.slice(state.conversationUsageStart);
  $('cost-total').textContent = used.length ? `Cuộc trò chuyện này: ${formatUsd(totalCost(used))}` : '';
}

/** Vượt giới hạn chi phí của một yêu cầu: tạm dừng, để người dùng quyết định có làm tiếp không. */
function renderBudgetPause(spent) {
  const el = make('div', 'msg error', `Đã tạm dừng: yêu cầu này đã dùng ${formatUsd(spent)}, vượt giới hạn ${formatUsd(state.budget)} cho một yêu cầu.`);
  const button = make('button', 'btn', 'Tiếp tục');
  button.type = 'button';
  button.addEventListener('click', () => {
    el.remove();
    if (state.busy) return;
    state.requestUsageStart = state.usage.length; // bắt đầu một khoảng ngân sách mới
    runLoop();
  }, { once: true });
  el.append(document.createElement('br'), button);
  append(el);
  renderCostLine();
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
  const blocks = dedupePreview(preview, '(Ảnh sau khi chỉnh trông không khác ảnh trước đó.)');
  r.content = blocks.some((b) => b.type === 'image')
    ? [...base, { type: 'text', text: 'Ảnh sau khi chỉnh (tự động):' }, ...blocks]
    : [...base, ...blocks];
}

async function callClaude() {
  const thinking = renderThinking();
  state.abort = new AbortController();
  // Ghi lại đúng yêu cầu này: giữ cache ấm phải gửi lại y hệt (không được kết thúc bằng câu trả lời của Claude).
  state.lastRequest = { messages: state.messages.slice(), startedAt: Date.now() };
  try {
    return await postJson('api/chat', { messages: state.messages }, { signal: state.abort.signal });
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
  if (state.busy) {
    renderError('Bokin đang làm việc với ảnh hiện tại. Đợi xong (hoặc bấm Dừng) rồi mở ảnh khác.');
    return;
  }
  try {
    setStatus(`Đang mở ${file.name}…`);
    await bridge.openFile(await file.arrayBuffer(), file.name);
    runner.undoDepth = 0;
    runner.picking = false;
    runner.areaEdits.clear();
    log.reset();
    await log.markOrigin();
    colorPanel.reset();
    // Ảnh mới: lịch sử trò chuyện về ảnh cũ (kèm các ảnh xem trước) không còn giúp ích mà lượt gọi nào cũng
    // phải gửi lại, nên bắt đầu cuộc trò chuyện mới.
    const hadConversation = state.messages.length > 0;
    if (hadConversation) resetConversation();
    addNote('opened-file', `(Ghi chú hệ thống: người dùng vừa mở ảnh "${file.name}" trong Photopea; đây là tài liệu đang hoạt động.)`);
    renderInfo(hadConversation
      ? `Đã mở ảnh: ${file.name}. Bắt đầu cuộc trò chuyện mới cho ảnh này (không gửi lại lịch sử ảnh cũ, đỡ tốn phí).`
      : `Đã mở ảnh: ${file.name}`);
    setStatus('Photopea đã sẵn sàng', 'ok');
    refreshUi();
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
els.downloadMenu.addEventListener('click', (e) => {
  const format = e.target.closest('button')?.dataset.format;
  if (!format) return;
  toggleMenu(false);
  exportImage(format);
});

async function exportImage(format) {
  const outcome = await runner.execute('export_image', { format });
  if (outcome.isError) showToast(outcome.content, 'error');
  else showToast(`Đã tải ${JSON.parse(outcome.content).saved_as}.`);
}

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
  resetConversation();
  els.input.focus();
});

/** Xoá cuộc trò chuyện (tài liệu trong Photopea giữ nguyên). */
function resetConversation() {
  state.messages = [];
  state.pendingNotes = [];
  state.lastRequest = null;
  state.lastPreviewData = null;
  state.referenceSentId = null;
  state.conversationUsageStart = state.usage.length;
  state.requestUsageStart = state.usage.length;
  updateCostTotal();
  stopKeepAlive();
  els.chat.replaceChildren(els.empty);
  els.empty.hidden = false;
}

// ───────────────────────────── Tab ─────────────────────────────
const TABS = ['chat', 'color', 'fill'];

function showTab(name) {
  if (!TABS.includes(name) || $(`tab-${name}`).hidden) return;
  for (const t of TABS) {
    $(`tab-${t}`).setAttribute('aria-selected', String(t === name));
    $(`panel-${t}`).hidden = t !== name;
  }
  try { localStorage.setItem('bokin.tab', name); } catch { /* không bắt buộc */ }
  if (name === 'fill') fillPanel.refresh();
  if (name === 'color') colorPanel.refresh();
}

for (const t of TABS) $(`tab-${t}`).addEventListener('click', () => showTab(t));
document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-goto]');
  if (target) showTab(target.dataset.goto);
});
try {
  const saved = localStorage.getItem('bokin.tab');
  if (TABS.includes(saved)) showTab(saved);
} catch { /* không bắt buộc */ }

// ───────────────────────────── Thanh công cụ ─────────────────────────────
async function toolbarAction(task) {
  if (isBusy()) {
    showToast('Bokin đang làm việc, đợi xong rồi thử lại.', 'error');
    return;
  }
  state.toolbarBusy = true;
  try {
    await task();
  } finally {
    state.toolbarBusy = false;
    refreshUi();
  }
}

function doUndo() {
  return toolbarAction(async () => {
    const r = await log.undo();
    if (r.isError) return showToast(r.content, 'error');
    colorPanel.reset();
    showToast(r.label ? `Đã hoàn tác ${r.label}.` : 'Đã hoàn tác một bước.');
    addNote('undo', `(Ghi chú hệ thống: người dùng đã bấm Hoàn tác${r.label ? `: ${r.label}` : ' một bước'}.)`);
  });
}

function doRedo() {
  return toolbarAction(async () => {
    const r = await log.redo();
    if (r.isError) return showToast(r.content, 'error');
    showToast(r.label ? `Đã làm lại ${r.label}.` : 'Đã làm lại một bước.');
    addNote('undo', `(Ghi chú hệ thống: người dùng đã bấm Làm lại${r.label ? `: ${r.label}` : ' một bước'}.)`);
  });
}

$('undo-btn').addEventListener('click', doUndo);
$('redo-btn').addEventListener('click', doRedo);

// Giữ để xem ảnh gốc: nhấn = hiện trạng thái đầu tiên trong lịch sử, thả = quay lại.
const compareBtn = $('compare-btn');
let comparing = false;
async function startCompare() {
  if (comparing || isBusy()) return;
  comparing = true;
  state.toolbarBusy = true;
  compareBtn.classList.add('pressed');
  await log.showOriginal();
}
async function endCompare() {
  if (!comparing) return;
  comparing = false;
  compareBtn.classList.remove('pressed');
  await log.restore();
  state.toolbarBusy = false;
}
compareBtn.addEventListener('pointerdown', startCompare);
for (const ev of ['pointerup', 'pointerleave', 'pointercancel', 'blur']) compareBtn.addEventListener(ev, endCompare);
compareBtn.addEventListener('keydown', (e) => {
  if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
    e.preventDefault();
    startCompare();
  }
});
compareBtn.addEventListener('keyup', (e) => {
  if (e.key === ' ' || e.key === 'Enter') endCompare();
});

// Phím tắt khi đang ở ngoài Photopea (trong Photopea, Ctrl+Z là hoàn tác riêng của Photopea).
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.target.closest('textarea, input, select')) return;
  const key = e.key.toLowerCase();
  if (key === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); }
  else if (key === 'y' || (key === 'z' && e.shiftKey)) { e.preventDefault(); doRedo(); }
});

// ───────────────────────────── Thẻ Bắt đầu + trạng thái ─────────────────────────────
$('start-open').addEventListener('click', openImage);
$('start-blank').addEventListener('click', () => toolbarAction(async () => {
  const option = $('start-size').selectedOptions[0];
  const [width, height] = option.value.split('x').map(Number);
  const out = await runner.execute('create_document', { width, height, background: '#FFFFFF', name: option.textContent });
  if (out.isError) return showToast(out.content, 'error');
  addNote('opened-file', `(Ghi chú hệ thống: người dùng vừa tạo ảnh trống ${width}x${height} px trong Photopea.)`);
  showToast(`Đã tạo ảnh trống ${width}×${height}.`);
}));

/** Cập nhật những gì phụ thuộc vào tài liệu trong Photopea: thẻ Bắt đầu, nút hoàn tác, vùng chọn. */
async function refreshUi() {
  if (!bridge.isReady || state.busy) return;
  const r = await bridge.exec('app.echoToOE(String(app.documents.length));').catch(() => null);
  const hasDoc = Number(r?.echoes?.[0]) > 0;
  $('start-card').hidden = hasDoc;
  for (const id of ['undo-btn', 'redo-btn', 'compare-btn', 'download-btn']) $(id).disabled = !hasDoc;
  fillPanel.refresh();
  colorPanel.refresh();
}

let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshUi, 300);
}
// Người dùng có thể mở / đóng ảnh, khoanh vùng ngay trong Photopea: cập nhật khi chuột rời khỏi Photopea.
els.iframe.addEventListener('mouseleave', scheduleRefresh);
window.addEventListener('focus', scheduleRefresh);

let toastTimer = null;
function showToast(text, kind = '') {
  const toast = $('toast');
  toast.textContent = text;
  toast.className = `toast ${kind}`;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, kind === 'error' ? 5000 : 2800);
}

// ───────────────────────────── Hiển thị ─────────────────────────────
function append(el) {
  // Ghi chú hệ thống (vd. "Đã mở ảnh") không che các gợi ý: người dùng cần gợi ý nhất ngay sau khi mở ảnh.
  if (!el.classList.contains('info')) els.empty.hidden = true;
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
