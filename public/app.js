// Giao diện chat + vòng lặp tool (agent loop).
//
// Luồng: người dùng gõ yêu cầu -> gửi lịch sử lên /api/chat -> Claude trả lời, có thể kèm
// các lệnh tool_use -> trình duyệt chạy từng lệnh trong Photopea -> gửi tool_result lên lại
// -> lặp cho tới khi Claude trả lời xong (không còn tool_use).
import { PhotopeaBridge } from './photopea-bridge.js';
import { ToolRunner } from './tool-runner.js';
import { toolLabel } from './shared/tools.js';
import { setupColorPanel, setupFillPanel, syncPaintButtons, bindSelectTools } from './quick-panels.js';
import { ActionLog } from './history.js';
import { usageCost, totalCost, formatUsd } from './shared/prices.js';
import { getJson, postJson } from './api.js';
import { parseQuickCommand, nextStrength } from './shared/quick-commands.js';
import { setupEditStrip, setupVoice, setupRecall, setupSaved } from './chat-extras.js';

const MAX_ROUNDS = 15; // số lượt gọi Claude tối đa cho một yêu cầu
const PREVIEW_SIZE = 768; // cạnh dài ảnh xem trước gửi cho Claude (đủ để đánh giá màu, ít token hơn 1024)
// Các tool không làm thay đổi ảnh nhìn thấy được: không cần gắn ảnh "sau khi chỉnh".
const NON_VISUAL_TOOLS = new Set(['get_document_info', 'view_image', 'export_image', 'select_area', 'select_by_color', 'create_document']);
const AREA_PREFIX = 'Chỉnh: '; // lớp của một lần chỉnh vùng (adjust_area)
// Công cụ chỉ chọn vùng: không đổi "thao tác gần nhất" (khoanh vùng xong rồi nói "mạnh hơn" vẫn là lần chỉnh trước đó).
const SELECT_TOOLS = new Set(['select_area', 'select_by_color']);
// Không ghi vào "công thức" của ảnh (làm giống ảnh trước): chỉ xem, tải về.
const RECIPE_SKIP = new Set(['get_document_info', 'view_image', 'export_image']);

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
  /** tên lần chỉnh vùng nếu thao tác chỉnh ảnh gần nhất là nó ("mạnh hơn" không kèm tên nói tới lần đó), không thì null */
  lastAreaEdit: null,
  /** các bước đã làm với ảnh trước (cho "làm giống ảnh trước"): { image, items: [{ text, steps }] } hoặc null */
  previousRecipe: null,
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

/**
 * "Công thức" của ảnh đang mở: mỗi thao tác (một câu chat, một lệnh làm ngay, một nút) với các tool đã chạy, bỏ
 * thao tác đã hoàn tác. Mở ảnh khác thì thành ghi chú cho Claude để "làm giống ảnh trước".
 */
const recipe = {
  image: null,
  items: [],
  stack: [],
  seq: 0,
  begin(text) {
    const item = { id: ++this.seq, text: String(text).slice(0, 200), steps: [], undone: false };
    this.stack.push(item);
    return item;
  },
  end(item) {
    this.stack = this.stack.filter((i) => i !== item);
    if (item.steps.length) this.items.push(item);
    if (this.items.length > 30) this.items.shift();
  },
  step(name, input) {
    const item = this.stack.at(-1);
    if (!item || RECIPE_SKIP.has(name) || item.steps.length >= 40) return;
    const copy = { ...input };
    if (typeof copy.script === 'string' && copy.script.length > 300) copy.script = `${copy.script.slice(0, 300)}…`;
    item.steps.push({ tool: name, input: copy });
  },
  mark(id, undone) {
    const item = this.items.find((i) => i.id === id);
    if (item) item.undone = undone;
  },
  live() {
    return this.items.filter((i) => !i.undone).map(({ text, steps }) => ({ text, steps }));
  },
  restart(image) {
    this.image = image;
    this.items = [];
    this.stack = [];
  },
};
// Mọi thao tác ghi vào ActionLog (chat, nút, lệnh làm ngay) cũng là một mục của công thức; hoàn tác thì bỏ mục đó.
const recordAction = log.record.bind(log);
log.record = async (meta, fn) => {
  const item = recipe.begin(meta.recipe ?? meta.label);
  try {
    return await recordAction({ ...meta, id: item.id }, fn);
  } finally {
    recipe.end(item);
  }
};
for (const [method, undone] of [['undo', true], ['redo', false]]) {
  const original = log[method].bind(log);
  log[method] = async () => {
    const out = await original();
    if (!out.isError && out.entry?.id) recipe.mark(out.entry.id, undone);
    return out;
  };
}

const isBusy = () => state.busy || state.toolbarBusy;
const openImage = () => els.fileInput.click();
const colorPanel = setupColorPanel({ runner, bridge, log, isBusy, addNote, openImage, reference });
const fillPanel = setupFillPanel({ runner, bridge, log, isBusy, addNote, openImage });

// Sau mỗi tool: có chỉnh sửa mới thì không còn gì để "làm lại"; cập nhật thẻ Bắt đầu và vùng chọn.
const NO_EDIT_TOOLS = new Set(['undo', 'redo', 'get_document_info', 'view_image', 'export_image']);
runner.onExecuted = async (name, outcome, input) => {
  if (!outcome.isError && !NO_EDIT_TOOLS.has(name)) log.clearRedo();
  if (!NO_EDIT_TOOLS.has(name)) scheduleRefresh();
  if (!outcome.isError) {
    recipe.step(name, input ?? {});
    if (name === 'adjust_area') state.lastAreaEdit = JSON.parse(outcome.content).name;
    else if (!NO_EDIT_TOOLS.has(name) && !SELECT_TOOLS.has(name)) state.lastAreaEdit = null;
  }
  // Ảnh mới tạo (kể cả do Claude tạo): đây là "ảnh gốc" để so sánh.
  if (name === 'create_document' && !outcome.isError) {
    runner.forgetAreaEdits();
    state.lastAreaEdit = null;
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

// Thanh "Đã chỉnh": mỗi lần chỉnh vùng một hàng (kéo đổi mức, ẩn để so sánh, bỏ), không gọi Claude.
const strip = setupEditStrip({
  box: $('edits'),
  list: $('edits-list'),
  load: () => (bridge.isReady ? runner.areaEditList() : Promise.resolve([])),
  onScale: (name, value) => toolbarAction(async () => {
    const out = await log.record({ kind: 'quick', label: `mức chỉnh "${name}" ${value}%`, recipe: `Đổi mức chỉnh "${name}" thành ${value}%` },
      () => runner.rescaleAreaEdit(name, value));
    if (out.isError) return showToast(out.content, 'error');
    addNote(`scale-${name}`, `(Ghi chú hệ thống: người dùng kéo thanh "Đã chỉnh": lần chỉnh "${name}" giờ ở mức ${value}% (strength).)`);
  }),
  onToggle: (name, visible) => toolbarAction(async () => {
    const out = await log.record({ kind: 'quick', label: `${visible ? 'hiện' : 'ẩn'} lần chỉnh "${name}"` },
      () => runner.setAreaEditVisible(name, visible));
    if (out.isError) return showToast(out.content, 'error');
    addNote(`visible-${name}`, `(Ghi chú hệ thống: người dùng đã ${visible ? 'hiện lại' : 'ẩn'} lớp của lần chỉnh "${name}".)`);
  }),
  onRemove: (name) => toolbarAction(() => quickRemove(name, `Bỏ lần chỉnh "${name}"`)),
});

// Hàng chọn vùng ngay trong ô chat (giống hàng "Vùng cần chỉnh" của tab Màu nhanh).
bindSelectTools($('chat-region'), $('chat-region-info'), {
  runner,
  bridge,
  isBusy,
  onChange: async () => {
    await updateSelectionHint();
    colorPanel.refresh();
  },
  setStatus: (text, kind) => showToast(text, kind === 'error' ? 'error' : ''),
});

const voice = setupVoice({
  button: $('mic-btn'),
  input: els.input,
  onError: (text) => showToast(text, 'error'),
  onEnd: autoGrow,
});
const recall = setupRecall(els.input);
const saved = setupSaved({ button: $('saved-btn'), menu: $('saved-menu'), emptyBox: $('saved-group'), onUse: (text) => handleText(text) });
saved.on(() => {
  for (const b of els.chat.querySelectorAll('.msg.user .save')) markSaved(b);
});
$('saved-group').addEventListener('click', (e) => {
  const button = e.target.closest('button');
  if (button) handleText(button.textContent.trim());
});

window.bokin = { bridge, runner, state, log, showTab, reference, recipe, executeTool: (name, input) => runner.execute(name, input) };

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
  if (button) handleText(button.textContent.trim());
});
// Phím "/" ở ngoài ô nhập: tới ô chat để gõ ngay.
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.target.closest('textarea, input, select, [contenteditable]')) return;
  e.preventDefault();
  showTab('chat');
  els.input.focus();
});
els.stop.addEventListener('click', () => {
  state.stopRequested = true;
  state.abort?.abort();
});

function submitInput() {
  const text = els.input.value.trim();
  if (!text || isBusy()) return;
  voice.stop();
  els.input.value = '';
  autoGrow();
  recall.remember(text);
  handleText(text);
}

/** Một câu của người dùng: lệnh ngắn thì Bokin làm ngay (không tốn phí), câu khác gửi Claude. */
async function handleText(text) {
  if (isBusy()) return;
  if (await tryQuick(text)) return;
  await send(text);
}

/**
 * Lệnh làm ngay: hoàn tác, làm lại, bỏ / đảo vùng chọn, so sánh, tải ảnh, "mạnh hơn" / "nhẹ hơn" và "bỏ chỉnh <tên>"
 * của lần chỉnh vùng. Trả về false nếu câu này phải gửi Claude.
 * @param {string} text
 * @param {object} [forced] - lệnh đã biết (nút gợi ý), không cần đọc câu
 */
async function tryQuick(text, forced = null) {
  if (!bridge.isReady) return false;
  const edits = await runner.areaEditList().catch(() => []);
  const names = edits.map((e) => e.name);
  const cmd = forced ?? parseQuickCommand(text, { edits: names, last: names.includes(state.lastAreaEdit) ? state.lastAreaEdit : null });
  if (!cmd) return false;
  if (cmd.kind === 'scale') {
    const edit = edits.find((e) => e.name === cmd.name);
    cmd.strength = edit ? nextStrength(edit.strength ?? 100, cmd.factor) : null;
    if (cmd.strength === null) return false; // hết mức (hoặc không còn lần chỉnh đó): để Claude đổi chính các giá trị
  }
  showTab('chat');
  $('selection-hint').hidden = true;
  $('chat-region-info').hidden = true;
  for (const old of els.chat.querySelectorAll('.followups')) old.remove();
  renderUser(text);
  await toolbarAction(() => runQuick(cmd, text));
  return true;
}

async function runQuick(cmd, text) {
  switch (cmd.kind) {
    case 'undo':
    case 'redo': {
      const labels = [];
      for (let i = 0; i < cmd.steps; i++) {
        const r = await (cmd.kind === 'undo' ? log.undo() : log.redo());
        if (r.isError) {
          if (!labels.length) return renderError(r.content);
          break;
        }
        labels.push(r.label ?? 'một bước');
      }
      if (cmd.kind === 'undo') colorPanel.reset();
      const verb = cmd.kind === 'undo' ? 'hoàn tác' : 'làm lại';
      addNote('undo', `(Ghi chú hệ thống: người dùng gõ "${text}", Bokin đã ${verb}: ${labels.join(', ')}.)`);
      renderQuick(`Đã ${verb} ${labels.join(', ')}.`);
      return renderFollowups();
    }
    case 'deselect':
    case 'invert': {
      const out = await runner.execute('select_area', { mode: cmd.kind === 'deselect' ? 'none' : 'invert' });
      if (out.isError) return renderError(out.content);
      return renderQuick(cmd.kind === 'deselect'
        ? 'Đã bỏ vùng chọn: yêu cầu tiếp theo áp cho cả ảnh.'
        : 'Đã đảo vùng chọn: giờ đang chọn phần còn lại.');
    }
    case 'compare': {
      if (!(await runner._hasDocument())) return renderError('Chưa có ảnh nào đang mở.');
      const note = renderQuick('Đang hiện ảnh gốc 2 giây…');
      $('compare-btn').classList.add('pressed');
      try {
        await log.showOriginal();
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } finally {
        await log.restore();
        $('compare-btn').classList.remove('pressed');
      }
      note.textContent = 'Đã hiện ảnh gốc 2 giây. Muốn xem lâu hơn: nhấn giữ nút So sánh ở trên.';
      return null;
    }
    case 'export': {
      const out = await runner.execute('export_image', { format: cmd.format });
      if (out.isError) return renderError(out.content);
      return renderQuick(`Đã tải ${JSON.parse(out.content).saved_as}.`);
    }
    case 'scale': {
      const out = await log.record({ kind: 'quick', label: `mức chỉnh "${cmd.name}" ${cmd.strength}%`, recipe: text },
        () => runner.rescaleAreaEdit(cmd.name, cmd.strength));
      if (out.isError) return renderError(out.content);
      addNote(`scale-${cmd.name}`, `(Ghi chú hệ thống: người dùng gõ "${text}", Bokin tự đổi mức lần chỉnh "${cmd.name}" thành ${cmd.strength}% (strength).)`);
      renderQuick(`Đã chỉnh "${cmd.name}" ${cmd.factor > 1 ? 'mạnh' : 'nhẹ'} hơn: mức ${cmd.strength}%. Kéo thanh "Đã chỉnh" ở trên để thử mức khác.`);
      return renderFollowups();
    }
    case 'remove':
      await quickRemove(cmd.name, text);
      return renderFollowups();
    default:
      return null;
  }
}

/** Bỏ hẳn một lần chỉnh vùng (xoá lớp "Chỉnh: <tên>"); hoàn tác được. */
async function quickRemove(name, text) {
  const out = await log.record({ kind: 'quick', label: `bỏ chỉnh "${name}"`, recipe: text },
    () => runner.execute('manage_layer', { action: 'delete', layer: `${AREA_PREFIX}${name}` }));
  if (out.isError) return renderError(out.content);
  addNote(`remove-${name}`, `(Ghi chú hệ thống: Bokin đã bỏ lần chỉnh "${name}" (xoá lớp của nó) theo lời người dùng.)`);
  renderQuick(`Đã bỏ lần chỉnh "${name}". Muốn lấy lại: gõ "hoàn tác".`);
  return null;
}

async function send(text) {
  if (state.busy) return;
  $('selection-hint').hidden = true;
  $('chat-region-info').hidden = true;
  showTab('chat');
  for (const old of els.chat.querySelectorAll('.followups')) old.remove();
  setBusy(true);
  renderUser(text);
  voice.stop();
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
  await log.record({ kind: 'chat', label: `yêu cầu "${short}"`, recipe: text }, () => runLoop());
  if (log.undoStack.length > before) renderFollowups();
  refreshUi();
}

/**
 * Nút gợi ý sau một chỉnh sửa. ⚡ = Bokin làm ngay, không gọi Claude: mạnh / nhẹ hơn khi thao tác vừa rồi là một
 * lần chỉnh vùng (đổi mức của lần đó), bỏ lần chỉnh đó, hoàn tác, tải ảnh.
 */
function renderFollowups() {
  const box = make('div', 'followups');
  const add = (label, text, cmd = null) => {
    const b = make('button', cmd ? 'local' : '', label);
    b.type = 'button';
    if (cmd) b.title = 'Làm ngay, không gọi AI, không tốn phí';
    b.addEventListener('click', async () => {
      if (isBusy()) return;
      box.remove();
      if (cmd && (await tryQuick(text, cmd))) return;
      await send(text);
    });
    box.append(b);
  };
  const area = state.lastAreaEdit;
  if (area) {
    add('Mạnh hơn', 'mạnh hơn', { kind: 'scale', name: area, factor: 1.4 });
    add('Nhẹ hơn', 'nhẹ hơn', { kind: 'scale', name: area, factor: 0.7 });
    add(`Bỏ "${area}"`, `bỏ chỉnh ${area}`, { kind: 'remove', name: area });
  } else {
    add('Mạnh hơn', 'Mạnh hơn một chút');
    add('Nhẹ hơn', 'Nhẹ hơn một chút');
  }
  add('Hoàn tác', 'hoàn tác', { kind: 'undo', steps: 1 });
  add('Tải JPG', 'tải ảnh jpg', { kind: 'export', format: 'jpg' });
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

/** Dòng trên ô chat: vùng đang chọn / đang tô, màu vừa hút: những gì Claude sẽ hiểu là "vùng này", "màu này". */
async function updateSelectionHint() {
  const hint = $('selection-hint');
  if (state.busy || !bridge.isReady) return;
  const sel = runner.painting ? null : await runner._selectionBounds().catch(() => null);
  const color = await runner.pickedColorIfAny().catch(() => null);
  const lines = [];
  if (runner.painting) {
    lines.push(['', 'Đang tô vùng: tô lên chỗ cần chỉnh trong Photopea, rồi gõ yêu cầu và gửi (Bokin tự lấy vùng vừa tô).']);
  } else if (sel) {
    const size = `${Math.round(sel.width)}×${Math.round(sel.height)} px`;
    lines.push(['', state.aiEnabled
      ? `Đang có vùng chọn ${size}. Ví dụ: "xoá vật thể trong vùng chọn", "thêm một chậu cây vào đây", "chỉnh màu vùng này ấm hơn".`
      : `Đang có vùng chọn ${size}: gõ "làm vùng này ấm hơn", "đổi vùng này sang xanh navy"… chỉ vùng này được chỉnh.`]);
  }
  if (color) lines.push([color, `Màu vừa hút ${color}: gõ "đổi màu này thành…", "chọn mọi chỗ màu này".`]);
  hint.replaceChildren(...lines.map(([swatch, text]) => {
    const row = make('div');
    if (swatch) {
      const s = make('span', 'swatch');
      s.style.background = swatch;
      row.append(s);
    }
    row.append(text);
    return row;
  }));
  hint.hidden = !lines.length;
  // Hướng dẫn của nút chọn vùng vừa bấm: ẩn khi người dùng đã khoanh / tô / hút được (dòng trên đổi).
  const key = JSON.stringify(lines);
  if (key !== hintKey && lines.length) $('chat-region-info').hidden = true;
  hintKey = key;
}
let hintKey = '';

function setBusy(busy) {
  state.busy = busy;
  if (busy) state.stopRequested = false;
  els.send.disabled = busy;
  els.stop.hidden = !busy;
  strip.setDisabled(busy);
  for (const b of $('chat-region').querySelectorAll('button')) b.disabled = busy;
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
    runner.forgetAreaEdits();
    state.lastAreaEdit = null;
    // Các bước đã làm với ảnh vừa rồi thành "ảnh trước" (ảnh vừa rồi chưa chỉnh gì thì giữ công thức cũ hơn).
    const steps = recipe.live();
    if (steps.length) state.previousRecipe = { image: recipe.image ?? 'ảnh trước', items: steps };
    recipe.restart(file.name);
    log.reset();
    await log.markOrigin();
    colorPanel.reset();
    // Ảnh mới: lịch sử trò chuyện về ảnh cũ (kèm các ảnh xem trước) không còn giúp ích mà lượt gọi nào cũng
    // phải gửi lại, nên bắt đầu cuộc trò chuyện mới.
    const hadConversation = state.messages.length > 0;
    if (hadConversation) resetConversation();
    addNote('opened-file', `(Ghi chú hệ thống: người dùng vừa mở ảnh "${file.name}" trong Photopea; đây là tài liệu đang hoạt động.)`);
    if (state.previousRecipe) addNote('previous', previousNote(state.previousRecipe));
    renderInfo(hadConversation
      ? `Đã mở ảnh: ${file.name}. Bắt đầu cuộc trò chuyện mới cho ảnh này (không gửi lại lịch sử ảnh cũ, đỡ tốn phí).`
      : `Đã mở ảnh: ${file.name}`);
    if (state.previousRecipe) renderAgain(state.previousRecipe);
    setStatus('Photopea đã sẵn sàng', 'ok');
    refreshUi();
  } catch (error) {
    renderError(error.message);
    setStatus('Photopea đã sẵn sàng', 'ok');
  }
}

/** Ghi chú cho Claude: các bước đã làm với ảnh trước, để "làm giống ảnh trước" trên ảnh vừa mở. */
function previousNote(prev) {
  const lines = [];
  let size = 0;
  for (const [i, item] of prev.items.entries()) {
    const steps = item.steps.map((s) => `${s.tool} ${JSON.stringify(s.input)}`).join('; ');
    const line = `${i + 1}. "${item.text}": ${steps}`;
    size += line.length;
    lines.push(size > 6000 ? `${i + 1}. "${item.text}" (bỏ bớt chi tiết cho gọn)` : line);
  }
  return `(Ghi chú hệ thống: các bước đã làm với ảnh trước "${prev.image}" (bỏ các bước đã hoàn tác):\n${lines.join('\n')}\n`
    + 'Nếu người dùng muốn làm giống ảnh trước ("làm giống ảnh trước", "như ảnh vừa rồi"), làm lại các bước này trên ảnh '
    + 'đang mở: cùng công cụ và giá trị; vùng chọn người dùng tự khoanh trên ảnh cũ không còn, hãy tự chọn vùng tương ứng '
    + 'trên ảnh này. Nếu không, bỏ qua ghi chú này.)';
}

/** Nút "↻ Làm giống ảnh trước" ngay sau dòng "Đã mở ảnh". */
function renderAgain(prev) {
  const box = make('div', 'followups again');
  const b = make('button', '', `↻ Làm giống ảnh trước (${prev.items.length} thao tác)`);
  b.type = 'button';
  b.title = prev.items.map((i) => `• ${i.text}`).join('\n');
  b.addEventListener('click', () => {
    if (isBusy()) return;
    box.remove();
    send('Làm giống ảnh trước');
  });
  box.append(b);
  append(box);
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
  strip.refresh();
  if (hasDoc) updateSelectionHint();
  else $('selection-hint').hidden = true;
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
// Đang xem cuối cuộc trò chuyện thì giữ ở cuối cả khi khung chat bị thu lại (dòng gợi ý, hàng chọn vùng hiện ra).
let chatAtEnd = true;
els.chat.addEventListener('scroll', () => {
  chatAtEnd = els.chat.scrollTop + els.chat.clientHeight >= els.chat.scrollHeight - 30;
});
new ResizeObserver(() => {
  if (chatAtEnd) els.chat.scrollTop = els.chat.scrollHeight;
}).observe(els.chat);

function append(el) {
  // Ghi chú hệ thống (vd. "Đã mở ảnh") không che các gợi ý: người dùng cần gợi ý nhất ngay sau khi mở ảnh.
  if (!el.classList.contains('info') && !el.classList.contains('again')) els.empty.hidden = true;
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
  const el = make('div', 'msg user', text);
  const star = make('button', 'save');
  star.type = 'button';
  star.dataset.text = text;
  star.addEventListener('click', () => (saved.has(text) ? saved.remove(text) : saved.add(text)));
  markSaved(star);
  el.append(star);
  append(el);
}

function markSaved(star) {
  const on = saved.has(star.dataset.text);
  star.classList.toggle('on', on);
  star.textContent = on ? '★' : '☆';
  star.title = on ? 'Bỏ khỏi lệnh đã lưu' : 'Lưu lệnh này để dùng lại (nút ⭐ Đã lưu)';
  star.setAttribute('aria-label', star.title);
}

/** Kết quả của một lệnh Bokin làm ngay (không gọi Claude). */
function renderQuick(text) {
  return append(make('div', 'msg quick', text));
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
