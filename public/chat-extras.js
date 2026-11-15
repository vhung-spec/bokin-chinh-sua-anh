// Những thứ giúp điều khiển bằng chat tiện hơn, không gọi Claude:
//   - thanh "Đã chỉnh": mỗi lần chỉnh vùng (lớp "Chỉnh: <tên>") một hàng, kéo để đổi mức, ẩn để so sánh, bỏ;
//   - nói thay gõ (Web Speech API của trình duyệt, tiếng Việt);
//   - ↑ / ↓ trong ô chat gọi lại câu đã gửi;
//   - lệnh đã lưu (☆ trên câu đã gửi), giữ trong trình duyệt.

const make = (tag, className, text) => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
};

const VALUE_NAMES = {
  brightness: 'sáng', contrast: 'tương phản', warmth: 'ấm', tint: 'hồng', saturation: 'rực', hue_shift: 'xoay màu',
};

/** Tóm tắt giá trị của một lần chỉnh vùng: "sáng +20 · ấm +30 · màu #1F2A44". */
export function describeEdit(edit) {
  const parts = Object.entries(VALUE_NAMES)
    .filter(([k]) => Number(edit[k]))
    .map(([k, label]) => `${label} ${edit[k] > 0 ? '+' : ''}${edit[k]}`);
  if (edit.target_color) parts.push(`màu ${edit.target_color}`);
  return parts.join(' · ');
}

/**
 * Thanh "Đã chỉnh" trong tab Trò chuyện.
 * @param {object} deps
 * @param {HTMLElement} deps.box
 * @param {HTMLElement} deps.list
 * @param {() => Promise<object[]>} deps.load - các lần chỉnh vùng đang có (runner.areaEditList)
 * @param {(name: string, strength: number) => Promise<void>} deps.onScale
 * @param {(name: string, visible: boolean) => Promise<void>} deps.onToggle
 * @param {(name: string) => Promise<void>} deps.onRemove
 */
export function setupEditStrip({ box, list, load, onScale, onToggle, onRemove }) {
  let lastKey = '';
  let dragging = false;
  let disabled = false;

  function row(edit) {
    const strength = edit.strength ?? 100;
    const el = make('div', `edit-row${edit.visible ? '' : ' off'}`);
    el.dataset.name = edit.name;
    const eye = make('button', 'eye', edit.visible ? '👁' : '◌');
    eye.type = 'button';
    eye.title = edit.visible ? 'Ẩn lần chỉnh này để so sánh' : 'Hiện lại lần chỉnh này';
    eye.setAttribute('aria-pressed', String(edit.visible));
    eye.setAttribute('aria-label', `${edit.visible ? 'Ẩn' : 'Hiện'} "${edit.name}"`);
    const label = make('span', 'edit-name', edit.name);
    label.title = describeEdit(edit);
    const range = make('input');
    range.type = 'range';
    range.min = '10';
    range.max = '200';
    range.step = '10';
    range.value = String(strength);
    range.setAttribute('aria-label', `Mức chỉnh "${edit.name}"`);
    range.title = 'Kéo để chỉnh mạnh / nhẹ hơn (100% = như lúc chỉnh)';
    const out = make('output', '', `${strength}%`);
    const remove = make('button', 'x', '✕');
    remove.type = 'button';
    remove.title = 'Bỏ lần chỉnh này';
    remove.setAttribute('aria-label', `Bỏ "${edit.name}"`);

    // Kéo liên tục chỉ làm lại một lần khi thả tay; phím mũi tên dồn lại thành một lần.
    let timer = null;
    let want = null;
    let working = false;
    async function apply() {
      if (working) return;
      working = true;
      try {
        while (want !== null) {
          const value = want;
          want = null;
          await onScale(edit.name, value);
        }
      } finally {
        working = false;
        dragging = false;
        refresh();
      }
    }
    range.addEventListener('pointerdown', () => { dragging = true; });
    range.addEventListener('input', () => { out.textContent = `${range.value}%`; });
    range.addEventListener('change', () => {
      want = Number(range.value);
      clearTimeout(timer);
      timer = setTimeout(apply, 150);
    });
    eye.addEventListener('click', () => onToggle(edit.name, !edit.visible).finally(refresh));
    remove.addEventListener('click', () => onRemove(edit.name).finally(refresh));
    el.append(eye, label, range, out, remove);
    return el;
  }

  async function refresh() {
    if (dragging) return;
    const edits = await load().catch(() => []);
    const key = JSON.stringify(edits);
    if (key === lastKey) return;
    lastKey = key;
    box.hidden = !edits.length;
    list.replaceChildren(...edits.slice().reverse().map(row)); // lần chỉnh mới nhất ở trên cùng
    setDisabled(disabled);
  }

  function setDisabled(on) {
    disabled = on;
    for (const el of list.querySelectorAll('button, input')) el.disabled = on;
  }

  return { refresh, setDisabled, forget: () => { lastKey = ''; } };
}

const VOICE_ERRORS = {
  'not-allowed': 'Trình duyệt chưa cho dùng micro. Bấm biểu tượng ổ khoá cạnh địa chỉ trang, cho phép Micro rồi thử lại.',
  'service-not-allowed': 'Trình duyệt này không cho nhận giọng nói. Dùng Chrome hoặc Edge.',
  'no-speech': 'Không nghe thấy gì. Bấm 🎤 rồi nói ngay.',
  'audio-capture': 'Không tìm thấy micro trên máy.',
  network: 'Nhận giọng nói cần kết nối Internet. Kiểm tra mạng rồi thử lại.',
  'language-not-supported': 'Trình duyệt chưa nhận được tiếng Việt. Dùng Chrome hoặc Edge bản mới.',
};

/**
 * Nút 🎤: nói tiếng Việt, chữ hiện dần trong ô chat (người dùng xem lại rồi bấm Gửi). Trình duyệt không hỗ trợ
 * (Firefox…) thì ẩn nút.
 */
export function setupVoice({ button, input, onError, onEnd }) {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    button.hidden = true;
    return { supported: false, stop() {} };
  }
  button.hidden = false;
  let rec = null;
  const idle = () => {
    button.classList.remove('listening');
    button.textContent = '🎤';
    button.title = 'Nói thay gõ (tiếng Việt)';
    button.setAttribute('aria-label', 'Nói thay gõ');
  };
  idle();
  function start() {
    rec = new Recognition();
    rec.lang = 'vi-VN';
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    const base = input.value.trim();
    let failed = false;
    rec.onresult = (e) => {
      let text = '';
      for (const result of e.results) text += result[0].transcript;
      input.value = [base, text.trim()].filter(Boolean).join(' ');
      input.dispatchEvent(new Event('input'));
    };
    rec.onerror = (e) => {
      if (e.error === 'aborted') return;
      failed = true;
      onError(VOICE_ERRORS[e.error] ?? `Không nhận được giọng nói (${e.error}).`);
    };
    rec.onend = () => {
      rec = null;
      idle();
      input.focus();
      onEnd?.({ failed });
    };
    try {
      rec.start();
    } catch (error) {
      rec = null;
      onError(`Không bật được micro: ${error?.message ?? error}`);
      return;
    }
    button.classList.add('listening');
    button.textContent = '● Đang nghe';
    button.title = 'Bấm để dừng nghe';
    button.setAttribute('aria-label', 'Dừng nghe');
  }
  button.addEventListener('click', () => (rec ? rec.stop() : start()));
  return { supported: true, stop: () => rec?.abort() };
}

const read = (key, fallback) => {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null');
    return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : fallback;
  } catch {
    return fallback;
  }
};
const write = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* không bắt buộc */ }
};

/** ↑ / ↓ trong ô chat: lần lượt các câu đã gửi (giữ 30 câu gần nhất trong trình duyệt). */
export function setupRecall(input, { key = 'bokin.sent', most = 30 } = {}) {
  let sent = read(key, []);
  let index = null; // đang xem câu thứ mấy (tính từ cuối), null = đang gõ câu mới
  let draft = '';
  const show = (text) => {
    input.value = text;
    input.dispatchEvent(new Event('input'));
    input.setSelectionRange(text.length, text.length);
  };
  input.addEventListener('keydown', (e) => {
    if (e.isComposing || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
    const atEnd = input.selectionStart === input.value.length;
    if (e.key === 'ArrowUp' && (index !== null || !input.value || atStart) && sent.length) {
      if (index === null) {
        draft = input.value;
        index = 0;
      } else if (index < sent.length - 1) index++;
      else return;
      e.preventDefault();
      show(sent[sent.length - 1 - index]);
    } else if (e.key === 'ArrowDown' && index !== null && atEnd) {
      e.preventDefault();
      index = index > 0 ? index - 1 : null;
      show(index === null ? draft : sent[sent.length - 1 - index]);
    }
  });
  input.addEventListener('input', (e) => {
    if (e.isTrusted) index = null;
  });
  return {
    remember(text) {
      index = null;
      sent = sent.filter((t) => t !== text);
      sent.push(text);
      if (sent.length > most) sent = sent.slice(-most);
      write(key, sent);
    },
  };
}

/** Lệnh đã lưu: ☆ trên câu đã gửi, menu ⭐ cạnh ô chat, nhóm "Lệnh đã lưu" ở màn hình trống. */
export function setupSaved({ button, menu, emptyBox, onUse, key = 'bokin.saved', most = 20 }) {
  let saved = read(key, []);
  const listeners = [];
  const changed = () => {
    write(key, saved);
    render();
    listeners.forEach((fn) => fn());
  };
  function render() {
    menu.replaceChildren();
    if (!saved.length) {
      menu.append(make('div', 'menu-empty', 'Chưa có lệnh nào. Bấm ☆ trên câu bạn đã gửi để lưu dùng lại.'));
    }
    for (const text of saved) {
      const item = make('div', 'saved-item');
      const use = make('button', 'saved-use', text);
      use.type = 'button';
      use.title = 'Gửi lệnh này';
      use.addEventListener('click', () => {
        toggle(false);
        onUse(text);
      });
      const remove = make('button', 'saved-x', '✕');
      remove.type = 'button';
      remove.title = 'Bỏ khỏi danh sách';
      remove.setAttribute('aria-label', `Bỏ lệnh "${text}"`);
      remove.addEventListener('click', (e) => {
        e.stopPropagation();
        api.remove(text);
      });
      item.append(use, remove);
      menu.append(item);
    }
    if (emptyBox) {
      emptyBox.hidden = !saved.length;
      const chips = emptyBox.querySelector('.suggestions');
      chips.replaceChildren(...saved.slice(0, 6).map((text) => {
        const b = make('button', '', text);
        b.type = 'button';
        return b;
      }));
    }
  }
  function toggle(open) {
    menu.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  }
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    toggle(menu.hidden);
  });
  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target)) toggle(false);
  });
  const api = {
    has: (text) => saved.includes(text),
    add(text) {
      if (saved.includes(text)) return;
      saved = [text, ...saved].slice(0, most);
      changed();
    },
    remove(text) {
      saved = saved.filter((t) => t !== text);
      changed();
    },
    on: (fn) => listeners.push(fn),
  };
  render();
  return api;
}
