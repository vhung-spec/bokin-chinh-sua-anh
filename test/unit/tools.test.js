import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, TOOL_MAP, toolDefinitions } from '../../shared/tools.js';
import { validate } from '../../shared/validate.js';
import { findUnsupportedSyntax, lit, hex, RESULT_PREFIX } from '../../shared/script-kit.js';

// Ví dụ đầu vào cho mỗi tool chạy bằng script (mỗi ví dụ phải hợp lệ theo schema).
const EXAMPLES = {
  get_document_info: [{}],
  create_document: [{ width: 1200, height: 630 }, { width: 500, height: 500, background: 'transparent', name: 'Bìa "đẹp"' }],
  resize_image: [{ width: 800 }, { height: 600 }, { scale_percent: 50 }, { width: 100, height: 100 }],
  crop: [{ x: 10, y: 20, width: 300, height: 200 }, { aspect_ratio: '1:1' }, { aspect_ratio: '16:9', center_x: 400, center_y: 300 }],
  rotate_flip_image: [{ angle: 90 }, { flip: 'vertical' }, { angle: -15, flip: 'horizontal' }],
  resize_canvas: [{ padding: 40, fill_color: '#fff' }, { width: 1000, height: 1000, anchor: 'top_left' }],
  adjust_brightness_contrast: [{ brightness: 20 }, { brightness: -10, contrast: 15, layer: 'Ảnh gốc' }],
  adjust_levels: [{ input_black: 10, input_white: 240, gamma: 1.2 }],
  adjust_curves: [{ points: [[0, 0], [64, 54], [192, 202], [255, 255]] }],
  adjust_hue_saturation: [{ saturation: 20 }, { hue: 30, saturation: 40, colorize: true }],
  adjust_vibrance: [{ vibrance: 30 }],
  auto_adjust: [{ mode: 'auto_levels' }, { mode: 'auto_contrast' }],
  color_effect: ['grayscale', 'sepia', 'invert', 'warm', 'cool', 'posterize', 'threshold'].map((effect) => ({ effect })),
  apply_filter: ['blur', 'motion_blur', 'sharpen', 'sharpen_more', 'unsharp_mask', 'add_noise', 'reduce_noise'].map((filter) => ({ filter })),
  select_area: [{ mode: 'rect', x: 0, y: 0, width: 10, height: 10 }, { mode: 'ellipse', x: 5, y: 5, width: 50, height: 30, feather: 4 }, { mode: 'all' }, { mode: 'none' }, { mode: 'invert' }],
  edit_selection: [{ action: 'fill', color: '#123456', opacity: 50 }, { action: 'clear' }, { action: 'stroke', color: '#000', stroke_width: 4 }],
  add_text: [{ text: "Xin chào 'Việt Nam'\nDòng 2 \u2028 \"ngoặc\" \\ gạch", x: 10, y: 50, size: 40, color: '#ff0000', font: 'Roboto-Bold', align: 'center', bold: true }],
  edit_text: [{ layer: 'Tiêu đề', text: 'Mới', size: 20, x: 5, y: 5 }],
  add_shape: [{ shape: 'rectangle', x: 0, y: 0, width: 100, height: 40, fill_color: '#000000', opacity: 60 }, { shape: 'ellipse', x: 0, y: 0, width: 50, height: 50, stroke_color: '#fff' }],
  manage_layer: ['select', 'new', 'duplicate', 'delete', 'rename', 'bring_to_front', 'send_to_back', 'move_up', 'move_down', 'merge_down', 'flatten']
    .map((action) => ({ action, layer: 'Layer 1', new_name: 'Tên mới' })),
  layer_properties: [{ opacity: 50 }, { blend_mode: 'multiply', visible: false, layer: 'A' }],
  transform_layer: [{ move_x: 10, move_y: -5 }, { align: 'bottom_right', margin: 20 }, { scale_percent: 50, rotate: 15, flip: 'horizontal' }],
};

test('mọi tool đều có tên, nhãn, mô tả và schema dạng object', () => {
  const names = new Set();
  for (const t of TOOLS) {
    assert.match(t.name, /^[a-z_]+$/);
    assert.ok(!names.has(t.name), `trùng tên ${t.name}`);
    names.add(t.name);
    assert.ok(t.label && t.description.length > 20, t.name);
    assert.equal(t.input_schema.type, 'object');
    assert.equal(t.input_schema.additionalProperties, false, t.name);
    assert.ok(t.kind === 'script' ? typeof t.build === 'function' : t.kind === 'client', t.name);
  }
});

test('toolDefinitions chỉ gửi name/description/input_schema cho Claude', () => {
  for (const def of toolDefinitions()) assert.deepEqual(Object.keys(def).sort(), ['description', 'input_schema', 'name']);
});

test('mọi tool script đều có ví dụ kiểm thử', () => {
  for (const t of TOOLS.filter((t) => t.kind === 'script')) assert.ok(EXAMPLES[t.name], `thiếu ví dụ cho ${t.name}`);
});

for (const [name, inputs] of Object.entries(EXAMPLES)) {
  test(`${name}: script hợp lệ, đúng cú pháp Photopea hỗ trợ`, () => {
    const tool = TOOL_MAP.get(name);
    for (const input of inputs) {
      assert.deepEqual(validate(input, tool.input_schema), [], `ví dụ không hợp lệ: ${JSON.stringify(input)}`);
      const script = tool.build(input);
      assert.doesNotThrow(() => new Function(script), `script lỗi cú pháp: ${JSON.stringify(input)}\n${script}`);
      assert.deepEqual(findUnsupportedSyntax(script), [], `cú pháp không hỗ trợ trong ${name}:\n${script}`);
      assert.ok(script.includes(RESULT_PREFIX), 'script phải trả kết quả');
      assert.ok(!/\bNaN\b|\bundefined\b(?!\s*\))/.test(script.replace(/=== undefined|!== undefined|v\.value !== undefined/g, '')), `script chứa NaN/undefined:\n${script}`);
    }
  });
}

test('chuỗi người dùng được thoát an toàn (không phá script)', () => {
  const evil = "'); app.close(); ('\u2028\u2029`${x}`";
  const script = TOOL_MAP.get('add_text').build({ text: evil, x: 0, y: 0 });
  assert.doesNotThrow(() => new Function(script));
  assert.equal(eval(lit(evil)), evil);
  assert.ok(!script.includes('\u2028'));
});

test('hex() chuẩn hoá màu và từ chối giá trị sai', () => {
  assert.equal(hex('#abc'), 'AABBCC');
  assert.equal(hex('ff8800'), 'FF8800');
  assert.throws(() => hex('red'));
  assert.throws(() => TOOL_MAP.get('edit_selection').build({ action: 'fill', color: 'đỏ' }));
});

test('build báo lỗi rõ ràng khi thiếu tham số bắt buộc theo logic', () => {
  assert.throws(() => TOOL_MAP.get('resize_image').build({}), /width/);
  assert.throws(() => TOOL_MAP.get('crop').build({ x: 1 }), /aspect_ratio/);
  assert.throws(() => TOOL_MAP.get('crop').build({ aspect_ratio: 'vuông' }), /aspect_ratio/);
  assert.throws(() => TOOL_MAP.get('select_area').build({ mode: 'rect' }), /x, y/);
  assert.throws(() => TOOL_MAP.get('adjust_levels').build({ input_black: 200, input_white: 100 }));
});

test('validate phát hiện lỗi kiểu, enum, giới hạn, tham số lạ, thiếu bắt buộc', () => {
  const schema = TOOL_MAP.get('apply_filter').input_schema;
  assert.deepEqual(validate({ filter: 'blur', radius: 2 }, schema), []);
  assert.equal(validate({}, schema).length, 1);
  assert.equal(validate({ filter: 'xyz' }, schema).length, 1);
  assert.equal(validate({ filter: 'blur', radius: 0 }, schema).length, 1);
  assert.equal(validate({ filter: 'blur', radius: '2' }, schema).length, 1);
  assert.equal(validate({ filter: 'blur', foo: 1 }, schema).length, 1);
  const curves = TOOL_MAP.get('adjust_curves').input_schema;
  assert.equal(validate({ points: [[0, 0], [300, 1]] }, curves).length, 1);
  assert.equal(validate({ points: [[0, 0, 0], [1, 1]] }, curves).length, 1);
});

test('findUnsupportedSyntax nhận ra cú pháp ES6 mà Photopea không chạy được', () => {
  assert.deepEqual(findUnsupportedSyntax('var a = 1; for (var i = 0; i < 3; i++) { a += i; } app.echoToOE(String(a));'), []);
  assert.ok(findUnsupportedSyntax('var f = (x) => x;').length);
  assert.ok(findUnsupportedSyntax('app.echoToOE(`a${b}`)').length);
  assert.ok(findUnsupportedSyntax('[1,2].map(function (x) { return x; })').length);
  assert.ok(findUnsupportedSyntax('function f() { return arguments.length; }').length);
});
