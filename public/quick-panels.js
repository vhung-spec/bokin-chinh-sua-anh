// Hai tab thao tác nhanh, chạy thẳng trong Photopea mà KHÔNG chạy vòng lặp Claude:
//   - Màu nhanh: preset màu + độ mạnh, màu theo ảnh mẫu (Match Color) cho vùng khoanh / tô,
//     tự cân màu, ấm/lạnh hơn, tươi/nhạt hơn (miễn phí).
//   - Tạo bằng AI (Generative Fill): khoanh vùng -> mô tả -> Tạo (chỉ trả tiền ảnh AI).
// Mọi thao tác được ghi vào ActionLog để nút Hoàn tác chung gỡ được cả cụm.
import { COLOR_PRESETS } from './shared/color.js';
import { postJson } from './api.js';

const PRESET_NAMES = {
  cinematic: 'Điện ảnh',
  vintage: 'Cổ điển',
  warm: 'Ấm áp',
  cool_moody: 'Lạnh trầm',
  korean: 'Tông Hàn',
  faded_matte: 'Phai màu',
  bw_dramatic: 'Đen trắng',
  vivid: 'Rực rỡ',
};

// Mỗi nút nhanh = một lần gọi tool (một bước lịch sử).
const QUICK_ACTIONS = {
  auto: { label: 'Tự cân màu', tool: 'auto_adjust', input: { mode: 'auto_levels' } },
  warmer: { label: 'Ấm hơn', tool: 'adjust_color_balance', input: { midtones: [6, 0, -10] } },
  cooler: { label: 'Lạnh hơn', tool: 'adjust_color_balance', input: { midtones: [-6, 0, 10] } },
  more: { label: 'Tươi hơn', tool: 'adjust_vibrance', input: { vibrance: 15 } },
  less: { label: 'Nhạt hơn', tool: 'adjust_hue_saturation', input: { saturation: -15 } },
};

// Công cụ khoanh vùng của Photopea + hướng dẫn ngắn khi chọn.
const SELECT_HINTS = {
  lassoTool: 'Giữ chuột và vẽ quanh vật thể trong Photopea.',
  marqueeRectTool: 'Kéo một khung chữ nhật quanh vùng cần sửa.',
  marqueeEllipTool: 'Kéo một khung elip quanh vùng cần sửa.',
  quickSelectTool: 'Tô lên vật thể; Photopea tự bắt theo viền.',
  magicWandTool: 'Bấm vào vùng cùng màu (ví dụ bầu trời).',
  eyedropperTool: 'Bấm vào một màu trên ảnh trong Photopea, rồi gõ trong ô chat: "đổi màu này thành xanh navy", "làm màu này nhạt hơn"… hoặc bấm "Chọn vùng màu này".',
};

const AM = "var _c = function (k) { return app.charIDToTypeID(k); }; var _s = function (k) { return app.stringIDToTypeID(k); };";

const PAINT_HINT = 'Tô màu đen lên vùng cần chỉnh trong Photopea (hiện màu đỏ); phím X đổi sang màu trắng để xoá bớt, phím [ ] đổi cỡ cọ. Tô xong bấm "✓ Xong tô".';

/** Nút "Tô vùng" ở mọi tab cùng hiện trạng thái tô (runner.onPaintChange gọi hàm này). */
export function syncPaintButtons(on) {
  for (const b of document.querySelectorAll('button[data-paint]')) {
    b.classList.toggle('active', on);
    b.textContent = on ? '✓ Xong tô' : '🖌 Tô vùng';
  }
}

/**
 * Hàng nút khoanh vùng: data-tool = đổi công cụ chọn của Photopea, data-select = select_area (invert, none),
 * data-paint = Tô vùng (Quick Mask: tô bằng cọ, bấm lần nữa là xong).
 */
export function bindSelectTools(container, info, { runner, bridge, isBusy, onChange, setStatus }) {
  container.addEventListener('click', async (e) => {
    const button = e.target.closest('button');
    if (!button || isBusy()) return;
    if (button.hasAttribute('data-paint')) {
      const out = runner.painting ? await runner.finishPaint() : await runner.startPaint();
      if (out.isError) setStatus(out.content, /Chưa tô/.test(out.content) ? 'warn' : 'error');
      if (runner.painting) {
        info.textContent = PAINT_HINT;
        info.className = 'fill-selection';
        info.hidden = false;
        return;
      }
      await onChange();
      return;
    }
    if (runner.painting) await runner.finishPaint();
    if (button.dataset.tool) {
      if (button.dataset.tool === 'eyedropperTool') await runner.startPicking();
      const r = await bridge.exec(`${AM} var d = new ActionDescriptor(); var r = new ActionReference(); r.putClass(_s(${JSON.stringify(button.dataset.tool)})); d.putReference(_c('null'), r); app.executeAction(_c('slct'), d, DialogModes.NO);`);
      for (const b of container.querySelectorAll('button[data-tool]')) b.classList.toggle('active', b === button);
      info.textContent = r.completed ? SELECT_HINTS[button.dataset.tool] : 'Không đổi được công cụ; hãy chọn công cụ trực tiếp trong Photopea.';
      info.className = 'fill-selection';
      info.hidden = false;
      return;
    }
    const out = await runner.execute('select_area', { mode: button.dataset.select });
    if (out.isError) setStatus(out.content, 'error');
    await onChange();
  });
}

/** Dòng trạng thái của một tab; lỗi "chưa có ảnh" kèm nút Mở ảnh. */
function statusSetter(el, openImage) {
  return (text, kind = '') => {
    el.textContent = text;
    el.className = `quick-status ${kind}`;
    if (kind === 'error' && /Chưa có ảnh/.test(text)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn small';
      b.textContent = 'Mở ảnh';
      b.addEventListener('click', openImage);
      el.append(b);
    }
  };
}

/**
 * @param {object} deps
 * @param {import('./tool-runner.js').ToolRunner} deps.runner
 * @param {import('./photopea-bridge.js').PhotopeaBridge} deps.bridge
 * @param {import('./history.js').ActionLog} deps.log
 * @param {() => boolean} deps.isBusy - đang có thao tác khác (ô chat, hoàn tác...)
 * @param {(key: string, text: string) => void} deps.addNote - ghi chú gửi kèm tin nhắn tiếp theo cho Claude
 * @param {() => void} deps.openImage
 * @param {{ set: (file: File) => Promise<object>, clear: () => void, on: (fn: (ref: object|null) => void) => void }} deps.reference
 *   - ảnh mẫu dùng chung với ô chat
 */
export function setupColorPanel({ runner, bridge, log, isBusy, addNote, openImage, reference }) {
  const $ = (id) => document.getElementById(id);
  const grid = $('preset-grid');
  const strength = $('preset-strength');
  const strengthValue = $('strength-value');
  const actions = $('quick-actions');
  const setStatus = statusSetter($('color-status'), openImage);
  const buttons = [];

  for (const key of Object.keys(COLOR_PRESETS)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.preset = key;
    b.textContent = PRESET_NAMES[key] ?? key;
    b.title = COLOR_PRESETS[key].label;
    grid.append(b);
    buttons.push(b);
  }
  for (const [key, action] of Object.entries(QUICK_ACTIONS)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.action = key;
    b.textContent = action.label;
    actions.append(b);
    buttons.push(b);
  }

  let running = false;
  const markActive = (preset) => {
    for (const b of grid.querySelectorAll('button')) b.classList.toggle('active', b.dataset.preset === preset);
  };

  async function guarded(task) {
    if (running) return;
    if (isBusy()) {
      setStatus('Bokin đang làm việc khác, đợi xong rồi thử lại.', 'warn');
      return;
    }
    running = true;
    buttons.forEach((b) => { b.disabled = true; });
    try {
      await task();
    } catch (error) {
      setStatus(error?.message ?? String(error), 'error');
    } finally {
      running = false;
      buttons.forEach((b) => { b.disabled = false; });
      updateMatchRun();
    }
  }

  const scopeText = async () => ((await runner._selectionBounds()) ? ' (trong vùng chọn)' : '');

  async function applyPreset(preset) {
    const value = Number(strength.value);
    const scope = await scopeText();
    const name = PRESET_NAMES[preset];
    // Preset vừa áp vẫn là thao tác mới nhất: gỡ nó trước để THAY chứ không chồng lên.
    let replaced = null;
    const top = log.top();
    if (top?.kind === 'preset' && (await log.isCurrent(top))) {
      const undo = await log.undo();
      if (!undo.isError) replaced = top.preset;
    }
    const out = await log.record({ kind: 'preset', preset, label: `phong cách "${name}" ${value}%` },
      () => runner.execute('color_grade', { preset, strength: value }));
    if (out.isError) {
      markActive(null);
      setStatus(out.content, 'error');
      return;
    }
    markActive(preset);
    setStatus(replaced && replaced !== preset
      ? `Đã thay "${PRESET_NAMES[replaced]}" bằng "${name}" ${value}%${scope}.`
      : `Đã áp "${name}" ${value}%${scope}.`, 'ok');
    addNote('color-preset', `(Ghi chú hệ thống: người dùng đã tự áp phong cách màu "${preset}" độ mạnh ${value}%${scope} bằng bảng Màu nhanh.)`);
  }

  async function applyAction(key) {
    const action = QUICK_ACTIONS[key];
    const scope = await scopeText();
    const out = await log.record({ kind: 'action', label: `"${action.label}"` }, () => runner.execute(action.tool, action.input));
    if (out.isError) {
      setStatus(out.content, 'error');
      return;
    }
    markActive(null);
    setStatus(`Đã "${action.label}"${scope}.`, 'ok');
    addNote(`color-${key}`, `(Ghi chú hệ thống: người dùng đã bấm "${action.label}"${scope} trong bảng Màu nhanh.)`);
  }

  grid.addEventListener('click', (e) => {
    const preset = e.target.closest('button')?.dataset.preset;
    if (preset) guarded(() => applyPreset(preset));
  });
  actions.addEventListener('click', (e) => {
    const key = e.target.closest('button')?.dataset.action;
    if (key) guarded(() => applyAction(key));
  });
  strength.addEventListener('input', () => {
    strengthValue.textContent = `${strength.value}%`;
  });
  // Kéo xong thanh độ mạnh: áp lại preset đang chọn với độ mạnh mới (thay thế, không chồng lên).
  strength.addEventListener('change', () => {
    const active = grid.querySelector('button.active')?.dataset.preset;
    if (active) guarded(() => applyPreset(active));
  });

  // ───────────── Màu theo ảnh mẫu ─────────────
  const m = {
    pick: $('match-pick'), file: $('match-file'), thumb: $('match-thumb'), name: $('match-name'), clear: $('match-clear'),
    selection: $('match-selection'), strength: $('match-strength'),
    strengthValue: $('match-strength-value'), keep: $('match-keep'), run: $('match-run'),
  };
  const setMatchStatus = statusSetter($('match-status'), openImage);
  buttons.push(m.run);
  function updateMatchRun() {
    m.run.disabled = running || !runner.reference;
    m.run.title = runner.reference ? '' : 'Chọn ảnh mẫu trước';
  }

  function showReference(ref) {
    m.thumb.hidden = !ref;
    if (ref) m.thumb.src = ref.thumb;
    else m.thumb.removeAttribute('src');
    m.name.textContent = ref ? `${ref.name} · ${ref.width}×${ref.height}` : 'Chưa có ảnh mẫu';
    m.clear.hidden = !ref;
    m.pick.textContent = ref ? 'Đổi ảnh mẫu' : 'Chọn ảnh mẫu';
    updateMatchRun();
  }
  reference.on(showReference);

  // Hàng "Vùng cần chỉnh" (đầu tab): dùng chung cho phong cách màu, màu theo ảnh mẫu và chỉnh nhanh.
  const region = { tools: $('region-tools'), edge: $('region-edge'), info: $('region-info') };
  const picked = { box: $('picked'), swatch: $('picked-swatch'), text: $('picked-text'), select: $('picked-select') };
  async function refreshPicked() {
    const color = await runner.pickedColorIfAny().catch(() => null);
    picked.box.hidden = !color;
    if (!color) return;
    picked.swatch.style.background = color;
    picked.text.textContent = `Màu vừa hút ${color}. Gõ trong ô chat: "đổi màu này thành…"`;
  }
  picked.select.addEventListener('click', () => guarded(async () => {
    const color = await runner.pickedColor();
    const out = await runner.execute('select_by_color', { method: 'color', color, tolerance: 30 });
    if (out.isError) setStatus(out.content, 'error');
    else setStatus(`Đã chọn mọi chỗ có màu giống ${color}.`, 'ok');
    await refreshMatch();
  }));
  async function refreshMatch() {
    if (running) return;
    await refreshPicked();
    if (runner.painting) {
      region.info.textContent = PAINT_HINT;
      region.info.className = 'fill-selection';
      m.selection.textContent = 'Đang tô vùng…';
      m.selection.className = 'fill-selection';
      for (const b of region.edge.querySelectorAll('button')) b.disabled = true;
      return;
    }
    const sel = await runner._selectionBounds().catch(() => null);
    const size = sel && `${Math.round(sel.width)}×${Math.round(sel.height)} px`;
    region.info.textContent = sel
      ? `Đang chọn vùng ${size}: mọi chỉnh màu bên dưới chỉ áp cho vùng này.`
      : 'Chưa có vùng chọn: chỉnh màu áp cho cả ảnh.';
    region.info.className = `fill-selection ${sel ? 'ok' : ''}`;
    for (const b of region.edge.querySelectorAll('button')) b.disabled = !sel;
    m.selection.textContent = sel ? `Sẽ chỉnh vùng chọn ${size}.` : 'Chưa có vùng chọn: sẽ chỉnh cả ảnh.';
    m.selection.className = `fill-selection ${sel ? 'ok' : ''}`;
  }

  async function applyMatch() {
    const ref = runner.reference;
    if (!ref) {
      setMatchStatus('Chọn ảnh mẫu trước.', 'warn');
      return;
    }
    if (runner.painting) await runner.finishPaint();
    const value = Number(m.strength.value);
    const keep = m.keep.checked;
    // Lần áp trước vẫn là thao tác mới nhất (chưa khoanh vùng khác, chưa chỉnh gì thêm): thay chứ không chồng lên.
    const top = log.top();
    if (top?.kind === 'match' && (await log.isCurrent(top))) await log.undo();
    const sel = await runner._selectionBounds();
    const scope = sel ? `vùng chọn ${Math.round(sel.width)}×${Math.round(sel.height)} px` : 'cả ảnh';
    setMatchStatus('Đang tính màu…');
    const out = await log.record({ kind: 'match', label: `màu theo ảnh mẫu "${ref.name}"` },
      () => runner.execute('match_reference_colors', { strength: value, keep_brightness: keep, use_selection: true }));
    if (out.isError) {
      setMatchStatus(out.content, 'error');
      return;
    }
    markActive(null);
    setMatchStatus(`Đã áp màu của "${ref.name}" cho ${scope} (độ mạnh ${value}%${keep ? ', giữ độ sáng' : ''}). Kéo độ mạnh để thử lại; không ưng thì bấm Hoàn tác.`, 'ok');
    addNote('match', `(Ghi chú hệ thống: người dùng đã tự áp màu theo ảnh mẫu "${ref.name}" cho ${scope}, độ mạnh ${value}%${keep ? ', giữ độ sáng' : ''} bằng bảng Màu nhanh; kết quả ở layer "Màu theo ảnh mẫu".)`);
    await refreshMatch();
  }

  m.pick.addEventListener('click', () => m.file.click());
  m.file.addEventListener('change', async () => {
    const file = m.file.files?.[0];
    m.file.value = '';
    if (!file) return;
    try {
      const ref = await reference.set(file);
      setMatchStatus(`Đã chọn ảnh mẫu "${ref.name}". Khoanh hoặc tô vùng cần chỉnh rồi bấm "Áp màu giống ảnh mẫu".`, 'ok');
    } catch (error) {
      setMatchStatus(error?.message ?? String(error), 'error');
    }
  });
  m.clear.addEventListener('click', () => {
    reference.clear();
    setMatchStatus('');
  });
  bindSelectTools(region.tools, region.info, {
    runner, bridge, isBusy: () => running || isBusy(), onChange: refreshMatch, setStatus,
  });
  region.edge.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-edge]');
    if (!b || running || isBusy()) return;
    const out = await runner.execute('select_area', { mode: b.dataset.edge, amount: Number(b.dataset.amount) });
    if (out.isError) setStatus(out.content, 'warn');
    else setStatus(`Đã ${b.textContent.toLowerCase()} mép vùng chọn ${b.dataset.amount} px.`, 'ok');
    await refreshMatch();
  });
  m.run.addEventListener('click', () => guarded(applyMatch));
  m.strength.addEventListener('input', () => {
    m.strengthValue.textContent = `${m.strength.value}%`;
  });
  // Đổi độ mạnh / giữ độ sáng ngay sau khi áp: áp lại (thay kết quả vừa rồi).
  const reapply = async () => {
    const top = log.top();
    if (top?.kind === 'match' && (await log.isCurrent(top))) guarded(applyMatch);
  };
  m.strength.addEventListener('change', reapply);
  m.keep.addEventListener('change', reapply);
  showReference(runner.reference);

  return {
    /** Bỏ đánh dấu preset (khi hoàn tác, mở ảnh khác...). */
    reset() {
      markActive(null);
      setStatus('');
      setMatchStatus('');
    },
    /** Cập nhật dòng vùng chọn của thẻ Màu theo ảnh mẫu. */
    refresh() {
      if (!document.getElementById('panel-color').hidden && !isBusy()) return refreshMatch();
      return null;
    },
  };
}

/**
 * Tab "Tạo bằng AI": 1) khoanh vùng (nút đổi công cụ chọn của Photopea) 2) mô tả 3) Tạo.
 * Câu lệnh tiếng Việt được dịch bằng model rẻ (hoặc dùng câu lệnh "xoá" có sẵn khi để trống),
 * rồi gửi thẳng cho AI tạo ảnh. Chi phí gần như chỉ còn tiền tạo ảnh.
 */
export function setupFillPanel({ runner, bridge, log, isBusy, addNote, openImage }) {
  const $ = (id) => document.getElementById(id);
  const panel = $('panel-fill');
  const off = $('fill-off');
  const tools = $('select-tools');
  const selectionInfo = $('fill-selection');
  const prompt = $('fill-prompt');
  const variations = $('fill-variations');
  const run = $('fill-run');
  const variants = $('fill-variants');
  const setStatus = statusSetter($('fill-status'), openImage);
  let enabled = false;
  let running = false;
  let hasSelection = false;

  const updateRunButton = () => {
    run.disabled = !enabled || running || !hasSelection;
    run.title = !enabled ? 'Chưa bật AI tạo ảnh' : !hasSelection ? 'Hãy khoanh vùng trong Photopea trước' : '';
  };

  async function refreshSelection() {
    if (running) return;
    if (runner.painting) {
      hasSelection = false;
      selectionInfo.textContent = PAINT_HINT;
      selectionInfo.className = 'fill-selection';
      updateRunButton();
      return;
    }
    const sel = await runner._selectionBounds().catch(() => null);
    hasSelection = Boolean(sel);
    selectionInfo.textContent = sel
      ? `Đã khoanh vùng ${Math.round(sel.width)}×${Math.round(sel.height)} px. Sang bước 2.`
      : 'Chưa có vùng chọn: chọn một công cụ ở trên rồi khoanh trong Photopea.';
    selectionInfo.className = `fill-selection ${sel ? 'ok' : ''}`;
    updateRunButton();
  }

  bindSelectTools(tools, selectionInfo, {
    runner, bridge, isBusy: () => running || isBusy(), onChange: refreshSelection, setStatus,
  });

  function showVariants(layers) {
    variants.replaceChildren();
    variants.hidden = layers.length < 2;
    layers.forEach((layer, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = `Phương án ${i + 1}`;
      b.classList.toggle('active', i === 0);
      b.addEventListener('click', async () => {
        if (running || isBusy()) return;
        running = true;
        try {
          for (const [j, name] of layers.entries()) {
            const out = await runner.execute('layer_properties', { layer: name, visible: j === i });
            if (out.isError) throw new Error(out.content);
          }
          for (const [j, el] of [...variants.children].entries()) el.classList.toggle('active', j === i);
          setStatus(`Đang hiện phương án ${i + 1}.`, 'ok');
          addNote('fill-variant', `(Ghi chú hệ thống: người dùng chọn hiện layer "${layer}", ẩn các phương án Generative Fill khác.)`);
        } catch (error) {
          setStatus(error.message, 'error');
        } finally {
          running = false;
        }
      });
      variants.append(b);
    });
  }

  async function generate() {
    if (running || run.disabled) return;
    if (isBusy()) {
      setStatus('Bokin đang làm việc khác, đợi xong rồi thử lại.', 'warn');
      return;
    }
    running = true;
    updateRunButton();
    const started = Date.now();
    let timer = null;
    try {
      const text = prompt.value.trim();
      setStatus(text ? 'Đang chuẩn bị câu lệnh…' : 'Đang xoá vật thể trong vùng chọn…');
      const data = await postJson('api/fill-instruction', { prompt: text });
      const n = Number(variations.value) || 1;
      const what = n > 1 ? `${n} phương án` : 'ảnh';
      const tick = () => setStatus(`Đang tạo ${what} bằng AI… ${Math.round((Date.now() - started) / 1000)} giây (thường 10–60 giây).`);
      tick();
      timer = setInterval(tick, 1000);
      const out = await log.record({ kind: 'fill', label: `Generative Fill "${text || 'xoá vật thể'}"` },
        () => runner.execute('ai_edit', { instruction: data.instruction, use_selection: true, variations: n }));
      if (out.isError) throw new Error(out.content);
      const result = JSON.parse(out.content);
      clearInterval(timer);
      showVariants(result.layers);
      setStatus(`Xong sau ${Math.round((Date.now() - started) / 1000)} giây: ${result.layers.length > 1 ? `${result.layers.length} phương án, chuyển bằng các nút ở trên` : 'kết quả ở layer mới'}. Không ưng thì bấm Hoàn tác rồi tạo lại.`, 'ok');
      addNote('fill', `(Ghi chú hệ thống: người dùng đã dùng tab Tạo bằng AI: "${text || 'xoá vật thể'}" trên vùng chọn; kết quả ở layer ${result.layers.map((l) => `"${l}"`).join(', ')}.)`);
    } catch (error) {
      clearInterval(timer);
      setStatus(error?.message ?? String(error), 'error');
    } finally {
      running = false;
      await refreshSelection();
    }
  }

  run.addEventListener('click', generate);
  prompt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      generate();
    }
  });
  prompt.addEventListener('focus', refreshSelection);
  $('magic-cut-btn').addEventListener('click', async () => {
    if (isBusy()) return;
    const r = await bridge.exec("if (app.documents.length === 0) { app.echoToOE('__NO_DOC__'); } else { app.showWindow('magiccut'); }");
    if (r.echoes.includes('__NO_DOC__')) setStatus('Chưa có ảnh nào đang mở.', 'error');
  });

  return {
    /** Cập nhật trạng thái vùng chọn khi tab đang hiện. */
    refresh() {
      if (!panel.hidden && !isBusy()) return refreshSelection();
      return null;
    },
    setEnabled(value, hint) {
      enabled = value;
      off.hidden = value;
      off.textContent = `${hint || 'Chưa bật AI tạo ảnh: thêm HF_TOKEN (token Hugging Face) vào file .env rồi khởi động lại server.'} Vẫn khoanh vùng được để chỉnh màu riêng vùng đó.`;
      updateRunButton();
    },
  };
}
