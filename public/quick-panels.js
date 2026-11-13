// Các bảng thao tác nhanh, chạy thẳng trong Photopea mà KHÔNG gọi Claude (không tốn phí API).
//   - Màu nhanh: preset màu + độ mạnh, tự cân màu, ấm/lạnh hơn, tươi/nhạt hơn, hoàn tác.
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

/**
 * @param {object} deps
 * @param {import('./tool-runner.js').ToolRunner} deps.runner
 * @param {import('./photopea-bridge.js').PhotopeaBridge} deps.bridge
 * @param {() => boolean} deps.isBusy - ô chat đang xử lý yêu cầu
 * @param {(key: string, text: string) => void} deps.addNote - ghi chú gửi kèm tin nhắn tiếp theo cho Claude
 */
export function setupColorPanel({ runner, bridge, isBusy, addNote }) {
  const $ = (id) => document.getElementById(id);
  const grid = $('preset-grid');
  const strength = $('preset-strength');
  const strengthValue = $('strength-value');
  const actions = $('quick-actions');
  const status = $('color-status');
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
  for (const [key, action] of Object.entries({ ...QUICK_ACTIONS, undo: { label: 'Hoàn tác' } })) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.action = key;
    b.textContent = action.label;
    actions.append(b);
    buttons.push(b);
  }

  /** Thao tác nhanh gần nhất: { kind, preset?, steps, historyLength } để thay thế / hoàn tác đúng số bước. */
  let last = null;
  let running = false;

  const markActive = (preset) => {
    for (const b of grid.querySelectorAll('button')) b.classList.toggle('active', b.dataset.preset === preset);
  };

  const setStatus = (text, kind = '') => {
    status.textContent = text;
    status.className = `quick-status ${kind}`;
  };

  async function historyLength() {
    const r = await bridge.exec("if (app.documents.length) { app.echoToOE('__H__' + app.activeDocument.historyStates.length); }");
    const line = r.echoes.find((e) => e.startsWith('__H__'));
    return line ? Number(line.slice(5)) : null;
  }

  /** Thao tác nhanh trước đó vẫn là thao tác mới nhất (chưa có chỉnh sửa nào khác xen vào)? */
  async function lastIsLatest() {
    return Boolean(last) && runner.undoDepth === 0 && (await historyLength()) === last.historyLength;
  }

  async function guarded(task) {
    if (running) return;
    if (isBusy()) {
      setStatus('Bokin đang xử lý yêu cầu trong ô chat, đợi xong rồi thử lại.', 'warn');
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

  async function scopeText() {
    return (await runner._selectionBounds()) ? ' (trong vùng chọn)' : '';
  }

  async function applyPreset(preset) {
    const value = Number(strength.value);
    const scope = await scopeText();
    let replaced = null;
    if (last?.kind === 'preset' && (await lastIsLatest())) {
      const undo = await runner.execute('undo', { steps: last.steps });
      if (!undo.isError) replaced = last.preset;
    }
    const out = await runner.execute('color_grade', { preset, strength: value });
    if (out.isError) {
      last = null;
      markActive(null);
      setStatus(out.content, 'error');
      return;
    }
    markActive(preset);
    const { history_steps: steps } = JSON.parse(out.content);
    last = { kind: 'preset', preset, steps, historyLength: await historyLength() };
    const name = PRESET_NAMES[preset];
    setStatus(replaced && replaced !== preset
      ? `Đã thay "${PRESET_NAMES[replaced]}" bằng "${name}" ${value}%${scope}.`
      : `Đã áp "${name}" ${value}%${scope}. Kéo thanh độ mạnh hoặc bấm phong cách khác để thay.`, 'ok');
    addNote('color-preset', `(Ghi chú hệ thống: người dùng đã tự áp phong cách màu "${preset}" độ mạnh ${value}%${scope} bằng bảng Màu nhanh.)`);
  }

  async function applyAction(key) {
    if (key === 'undo') {
      const steps = (await lastIsLatest()) ? last.steps : 1;
      const out = await runner.execute('undo', { steps });
      last = null;
      markActive(null);
      setStatus(out.isError ? out.content : `Đã hoàn tác ${steps} bước.`, out.isError ? 'error' : 'ok');
      if (!out.isError) addNote('color-undo', '(Ghi chú hệ thống: người dùng đã hoàn tác thao tác màu nhanh gần nhất.)');
      return;
    }
    const action = QUICK_ACTIONS[key];
    const scope = await scopeText();
    const out = await runner.execute(action.tool, action.input);
    if (out.isError) {
      setStatus(out.content, 'error');
      return;
    }
    last = { kind: 'action', steps: 1, historyLength: await historyLength() };
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
  // Kéo xong thanh độ mạnh: áp lại preset vừa dùng với độ mạnh mới (thay thế, không chồng lên).
  strength.addEventListener('change', () => {
    if (last?.kind === 'preset') guarded(() => applyPreset(last.preset));
  });

  return {
    /** Gọi khi người dùng mở ảnh khác: quên thao tác cũ để không hoàn tác nhầm. */
    reset() {
      last = null;
      markActive(null);
      setStatus('');
    },
  };
}
