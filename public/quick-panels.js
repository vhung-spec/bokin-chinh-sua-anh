// Hai tab thao tác nhanh, chạy thẳng trong Photopea mà KHÔNG chạy vòng lặp Claude:
//   - Màu nhanh: preset màu + độ mạnh, tự cân màu, ấm/lạnh hơn, tươi/nhạt hơn (miễn phí).
//   - Tạo bằng AI (Generative Fill): khoanh vùng -> mô tả -> Tạo (chỉ trả tiền ảnh AI).
// Mọi thao tác được ghi vào ActionLog để nút Hoàn tác chung gỡ được cả cụm.
import { COLOR_PRESETS } from '/shared/color.js';

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
};

const AM = "var _c = function (k) { return app.charIDToTypeID(k); }; var _s = function (k) { return app.stringIDToTypeID(k); };";

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
 * @param {import('./history.js').ActionLog} deps.log
 * @param {() => boolean} deps.isBusy - đang có thao tác khác (ô chat, hoàn tác...)
 * @param {(key: string, text: string) => void} deps.addNote - ghi chú gửi kèm tin nhắn tiếp theo cho Claude
 * @param {() => void} deps.openImage
 */
export function setupColorPanel({ runner, log, isBusy, addNote, openImage }) {
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

  return {
    /** Bỏ đánh dấu preset (khi hoàn tác, mở ảnh khác...). */
    reset() {
      markActive(null);
      setStatus('');
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
    const sel = await runner._selectionBounds().catch(() => null);
    hasSelection = Boolean(sel);
    selectionInfo.textContent = sel
      ? `Đã khoanh vùng ${Math.round(sel.width)}×${Math.round(sel.height)} px. Sang bước 2.`
      : 'Chưa có vùng chọn: chọn một công cụ ở trên rồi khoanh trong Photopea.';
    selectionInfo.className = `fill-selection ${sel ? 'ok' : ''}`;
    updateRunButton();
  }

  tools.addEventListener('click', async (e) => {
    const button = e.target.closest('button');
    if (!button || running || isBusy()) return;
    if (button.dataset.tool) {
      const r = await bridge.exec(`${AM} var d = new ActionDescriptor(); var r = new ActionReference(); r.putClass(_s(${JSON.stringify(button.dataset.tool)})); d.putReference(_c('null'), r); app.executeAction(_c('slct'), d, DialogModes.NO);`);
      for (const b of tools.querySelectorAll('button[data-tool]')) b.classList.toggle('active', b === button);
      selectionInfo.textContent = r.completed ? SELECT_HINTS[button.dataset.tool] : 'Không đổi được công cụ; hãy chọn công cụ trực tiếp trong Photopea.';
      selectionInfo.className = 'fill-selection';
      return;
    }
    const out = await runner.execute('select_area', { mode: button.dataset.select });
    if (out.isError) setStatus(out.content, 'error');
    await refreshSelection();
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
      const res = await fetch('/api/fill-instruction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: text }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Server trả lỗi HTTP ${res.status}`);
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
    setEnabled(value) {
      enabled = value;
      off.hidden = value;
      off.textContent = 'Chưa bật AI tạo ảnh: thêm HF_TOKEN (token Hugging Face) vào file .env rồi khởi động lại server. Vẫn khoanh vùng được để chỉnh màu riêng vùng đó.';
      updateRunButton();
    },
  };
}
