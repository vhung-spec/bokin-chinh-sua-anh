// Công cụ dựng script chạy trong Photopea.
//
// Photopea chạy script bằng trình thông dịch riêng (giống API scripting của Photoshop),
// KHÔNG phải engine JavaScript của trình duyệt. Đã kiểm tra thực tế (2026-11):
//   - Chạy được: var/let/const, function, vòng lặp for/while, IIFE, đệ quy, JSON, RegExp,
//     Math, Object.keys, các hàm chuỗi.
//   - KHÔNG chạy được: arrow function (=>), template string (`...`), `arguments`,
//     callback truyền vào hàm có sẵn (Array.map/forEach/filter/sort(fn) ...).
//   - Khi script ném lỗi, try/catch KHÔNG bắt được và Photopea không gửi "done".
//     => Script phải tự kiểm tra điều kiện và báo lỗi bằng __fail(...) thay vì throw.
//
// Mỗi script của tool kết thúc bằng một dòng echo có tiền tố RESULT_PREFIX chứa JSON kết quả.

export const RESULT_PREFIX = '__BOKIN_RESULT__';

// Hàm phụ trợ được chèn vào đầu mỗi script (viết theo cú pháp ES5 đơn giản).
const PRELUDE = `
function __out(o) { app.echoToOE('${RESULT_PREFIX}' + JSON.stringify(o)); }
function __ok(o) { if (!o) { o = {}; } o.ok = true; __out(o); }
function __fail(msg) { __out({ ok: false, error: msg }); }
function __num(v) { if (v !== null && v !== undefined && v.value !== undefined) { return Number(v.value); } return Number(v); }
function __round(v) { return Math.round(v * 100) / 100; }
function __bounds(l) {
  var b = l.bounds;
  var x0 = __num(b[0]), y0 = __num(b[1]), x1 = __num(b[2]), y1 = __num(b[3]);
  return { x: __round(x0), y: __round(y0), width: __round(x1 - x0), height: __round(y1 - y0) };
}
function __findLayer(c, name) {
  for (var i = 0; i < c.layers.length; i++) {
    var L = c.layers[i];
    if (L.name === name) { return L; }
    if (L.typename === 'LayerSet' && L.layers && L.layers.length) {
      var f = __findLayer(L, name);
      if (f) { return f; }
    }
  }
  return null;
}
function __color(hex) { var c = new SolidColor(); c.rgb.hexValue = hex; return c; }
function __isText(l) { return l.typename === 'ArtLayer' && l.kind == LayerKind.TEXT; }
function __pixelProblem(l) {
  if (l.typename === 'LayerSet') { return 'Layer "' + l.name + '" là một nhóm (group), không phải layer ảnh. Hãy chọn một layer ảnh bên trong.'; }
  if (__isText(l)) { return 'Layer "' + l.name + '" là layer chữ. Hãy chọn layer ảnh, hoặc dùng edit_text để sửa chữ.'; }
  if (l.typename === 'ArtLayer' && l.kind != LayerKind.NORMAL && l.kind != 0) { return 'Layer "' + l.name + '" là layer điều chỉnh/đặc biệt, không chỉnh pixel trực tiếp được. Hãy chọn layer ảnh.'; }
  return null;
}
var _c = function (k) { return app.charIDToTypeID(k); };
var _s = function (k) { return app.stringIDToTypeID(k); };
`;

/** Chuyển một giá trị (chuỗi/số/bool/null) thành literal an toàn để nhúng vào script. */
export function lit(value) {
  if (typeof value === 'number') return num(value);
  if (typeof value === 'boolean' || value === null) return String(value);
  // JSON.stringify tạo chuỗi hợp lệ; thoát thêm U+2028/U+2029 vì trình thông dịch cũ coi là xuống dòng.
  return JSON.stringify(String(value)).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** Số hữu hạn dạng literal; ném lỗi nếu không hợp lệ (để không bao giờ nhúng NaN/Infinity vào script). */
export function num(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Giá trị số không hợp lệ: ${value}`);
  return String(n);
}

/** Chuẩn hoá mã màu "#RGB" / "#RRGGBB" / "RRGGBB" thành "RRGGBB" (chữ hoa). */
export function hex(color) {
  let s = String(color ?? '').trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(s)) s = s.split('').map((ch) => ch + ch).join('');
  if (!/^[0-9a-f]{6}$/i.test(s)) throw new Error(`Mã màu không hợp lệ: "${color}" (cần dạng #RRGGBB)`);
  return s.toUpperCase();
}

export function hexToRgb(color) {
  const h = hex(color);
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

/**
 * Bọc phần thân script: thêm hàm phụ trợ, kiểm tra có tài liệu đang mở, gán biến `doc`.
 * @param {string} body - thân script; phải gọi __ok(...) hoặc __fail(...) rồi return.
 * @param {{ needsDocument?: boolean }} [opts]
 */
export function wrap(body, { needsDocument = true } = {}) {
  const guard = needsDocument
    ? "if (app.documents.length === 0) { __fail('Chưa có ảnh nào đang mở trong Photopea. Hãy mở ảnh (nút \"Mở ảnh\") hoặc tạo tài liệu mới.'); return; }\nvar doc = app.activeDocument;"
    : '';
  return `(function () {\n${PRELUDE}\n${guard}\n${body}\n})();`;
}

/**
 * Đoạn script chọn layer đích: biến `layer` = layer theo tên (nếu có) hoặc layer đang chọn.
 * Khi chỉ định tên, layer đó cũng được đặt làm layer đang chọn.
 */
export function targetLayer(name, { requirePixels = false } = {}) {
  let s = 'var layer = doc.activeLayer;\n';
  if (name !== undefined && name !== null && name !== '') {
    s += `layer = __findLayer(doc, ${lit(name)});\n`;
    s += `if (!layer) { __fail('Không tìm thấy layer tên ' + ${lit(JSON.stringify(name))} + '. Gọi get_document_info để xem danh sách layer.'); return; }\n`;
    s += 'doc.activeLayer = layer;\n';
  }
  if (requirePixels) {
    s += 'var __p = __pixelProblem(layer);\nif (__p) { __fail(__p); return; }\n';
  }
  return s;
}

/** Danh sách điểm (polygon) của hình elip, vì Photopea không có selectEllipse. */
export function ellipsePoints(x, y, w, h, steps = 72) {
  const pts = [];
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    const px = x + w / 2 + (w / 2) * Math.cos(a);
    const py = y + h / 2 + (h / 2) * Math.sin(a);
    pts.push(`[${+px.toFixed(2)},${+py.toFixed(2)}]`);
  }
  return `[${pts.join(',')}]`;
}

export function rectPoints(x, y, w, h) {
  const [X, Y, W, H] = [x, y, w, h].map(Number);
  return `[[${num(X)},${num(Y)}],[${num(X + W)},${num(Y)}],[${num(X + W)},${num(Y + H)}],[${num(X)},${num(Y + H)}]]`;
}

/**
 * Tìm các cú pháp mà trình thông dịch của Photopea không hỗ trợ (dùng trong unit test
 * và để cảnh báo sớm trong run_script). Trả về danh sách mô tả vấn đề.
 */
export function findUnsupportedSyntax(script) {
  const problems = [];
  const checks = [
    [/=>/, 'arrow function (=>)'],
    [/`/, 'template string (`...`)'],
    [/\barguments\b/, 'biến arguments'],
    [/\.(map|forEach|filter|reduce|some|every|find|findIndex)\s*\(/, 'callback vào hàm mảng (map/forEach/filter/...)'],
    [/\.sort\s*\(\s*function/, 'sort với hàm so sánh'],
    [/\bclass\s+[A-Za-z_$]/, 'class'],
    [/\.\.\.[A-Za-z_$[{(]/, 'spread (...)'],
    [/\basync\b|\bawait\b/, 'async/await'],
  ];
  for (const [re, label] of checks) if (re.test(script)) problems.push(label);
  return problems;
}
