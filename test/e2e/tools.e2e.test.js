// Kiểm thử từng tool trên Photopea thật: chạy tool rồi đo pixel để chắc chắn ảnh thực sự thay đổi.
// Chạy: npm run test:e2e   (cần mạng tới www.photopea.com)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, openApp, tool, json, stats, pixel, freshDoc } from './helpers.js';

let server, browser, page, pageErrors;

before(async () => {
  ({ server, url: globalThis.__url } = await startServer());
  ({ browser, page, pageErrors } = await openApp(globalThis.__url));
});

after(async () => {
  await browser?.close();
  server?.close();
});

const info = async () => json(await tool(page, 'get_document_info'));
const noisyDoc = async () => {
  await freshDoc(page);
  await page.evaluate(() => window.bokin.bridge.exec('app.activeDocument.activeLayer.applyAddNoise(12);'));
};

test('chưa mở ảnh: get_document_info báo không có tài liệu, tool chỉnh ảnh báo lỗi rõ ràng', async () => {
  assert.equal((await info()).has_document, false);
  const r = await tool(page, 'adjust_brightness_contrast', { brightness: 10 });
  assert.equal(r.isError, true);
  assert.match(r.content, /Chưa có ảnh/);
});

test('create_document + get_document_info', async () => {
  const created = await freshDoc(page, { width: 400, height: 300, background: '#336699' });
  assert.equal(created.width, 400);
  const i = await info();
  assert.equal(i.width, 400);
  assert.equal(i.height, 300);
  assert.equal(i.layers[0].type, 'pixel');
  const s = await stats(page);
  assert.deepEqual([s.r, s.g, s.b], [0x33, 0x66, 0x99]);

  await tool(page, 'create_document', { width: 50, height: 40, background: 'transparent' });
  assert.equal((await stats(page)).alpha, 0);
});

test('chỉnh sáng/tương phản + hoàn tác / làm lại', async () => {
  await freshDoc(page);
  const base = (await stats(page)).mean;
  json(await tool(page, 'adjust_brightness_contrast', { brightness: 40 }));
  const brighter = (await stats(page)).mean;
  assert.ok(brighter > base + 10, `${brighter} > ${base}`);
  json(await tool(page, 'undo'));
  assert.equal((await stats(page)).mean, base);
  json(await tool(page, 'redo'));
  assert.equal((await stats(page)).mean, brighter);
  assert.equal((await tool(page, 'redo')).isError, true, 'không còn gì để làm lại');
});

test('Levels, Curves, Hue/Saturation, Vibrance thay đổi pixel', async () => {
  await freshDoc(page, { background: '#9E9E9E' });
  json(await tool(page, 'adjust_levels', { input_white: 200 }));
  assert.ok((await stats(page)).mean > 190);

  await freshDoc(page, { background: '#9E9E9E' });
  json(await tool(page, 'adjust_curves', { points: [[0, 0], [128, 64], [255, 255]] }));
  assert.ok((await stats(page)).mean < 120);

  await freshDoc(page, { background: '#C86432' });
  json(await tool(page, 'adjust_hue_saturation', { saturation: -100 }));
  let s = await stats(page);
  assert.ok(Math.abs(s.r - s.b) < 4, JSON.stringify(s));

  await freshDoc(page, { background: '#C86432' });
  json(await tool(page, 'adjust_hue_saturation', { hue: 200, saturation: 50, colorize: true }));
  s = await stats(page);
  assert.ok(s.b > s.r, JSON.stringify(s));

  await freshDoc(page, { background: '#C86432' });
  json(await tool(page, 'adjust_vibrance', { vibrance: -100, saturation: -100 }));
  s = await stats(page);
  assert.ok(s.r - s.b < 100, JSON.stringify(s));

  for (const mode of ['auto_levels', 'auto_contrast']) json(await tool(page, 'auto_adjust', { mode }));
});

test('hiệu ứng màu', async () => {
  const cases = {
    grayscale: (s) => Math.abs(s.r - s.b) < 4,
    sepia: (s) => s.r > s.b + 10,
    invert: (s) => s.r === 255 - 0xC8,
    warm: (s) => s.r > s.b + 10,
    cool: (s) => s.b > s.r + 10,
    posterize: (s) => s.r !== 0xC8 || s.g !== 0x64,
    threshold: (s) => s.r === s.g && (s.r === 0 || s.r === 255),
  };
  for (const [effect, ok] of Object.entries(cases)) {
    // warm/cool đo trên nền xám để thấy rõ hướng lệch màu
    await freshDoc(page, { background: effect === 'warm' || effect === 'cool' ? '#9E9E9E' : '#C86432' });
    json(await tool(page, 'color_effect', { effect, ...(effect === 'posterize' ? { amount: 2 } : {}) }));
    const s = await stats(page);
    assert.ok(ok(s), `${effect}: ${JSON.stringify(s)}`);
  }
});

test('bộ lọc làm mờ / làm nét / nhiễu', async () => {
  const expectations = {
    blur: 'down', motion_blur: 'down', reduce_noise: 'down',
    sharpen: 'up', sharpen_more: 'up', unsharp_mask: 'up', add_noise: 'up',
  };
  for (const [filter, dir] of Object.entries(expectations)) {
    await noisyDoc();
    const before = (await stats(page)).std;
    json(await tool(page, 'apply_filter', { filter, ...(filter === 'add_noise' ? { amount: 20 } : {}), ...(filter === 'blur' ? { radius: 3 } : {}) }));
    const afterStd = (await stats(page)).std;
    assert.ok(dir === 'down' ? afterStd < before * 0.8 : afterStd > before * 1.2, `${filter}: ${before} -> ${afterStd}`);
  }
});

test('cắt, đổi kích thước, xoay, đổi khung', async () => {
  await freshDoc(page, { width: 400, height: 300 });
  json(await tool(page, 'crop', { x: 10, y: 10, width: 200, height: 100 }));
  let s = await stats(page);
  assert.deepEqual([s.width, s.height], [200, 100]);

  await freshDoc(page, { width: 400, height: 300 });
  const c = json(await tool(page, 'crop', { aspect_ratio: '1:1' }));
  assert.equal(c.new_size, '300x300');

  json(await tool(page, 'resize_image', { width: 150 }));
  s = await stats(page);
  assert.deepEqual([s.width, s.height], [150, 150]);
  json(await tool(page, 'resize_image', { scale_percent: 200 }));
  assert.equal((await stats(page)).width, 300);

  await freshDoc(page, { width: 400, height: 300 });
  json(await tool(page, 'rotate_flip_image', { angle: 90, flip: 'vertical' }));
  s = await stats(page);
  assert.deepEqual([s.width, s.height], [300, 400]);

  await freshDoc(page, { width: 100, height: 80, background: '#FF0000' });
  json(await tool(page, 'resize_canvas', { padding: 10, fill_color: '#0000FF' }));
  s = await stats(page);
  assert.deepEqual([s.width, s.height], [120, 100]);
  assert.deepEqual(await pixel(page, 2, 2), { r: 0, g: 0, b: 255, a: 255 });
  assert.deepEqual(await pixel(page, 60, 50), { r: 255, g: 0, b: 0, a: 255 });
  const i = await info();
  assert.equal(i.layers.at(-1).name, 'Nền khung', 'lớp nền nằm dưới cùng');
});

test('vùng chọn: tô, xoá, viền', async () => {
  await freshDoc(page, { width: 200, height: 200, background: '#FFFFFF' });
  json(await tool(page, 'select_area', { mode: 'rect', x: 0, y: 0, width: 100, height: 200 }));
  json(await tool(page, 'edit_selection', { action: 'fill', color: '#000000' }));
  json(await tool(page, 'select_area', { mode: 'none' }));
  assert.equal((await pixel(page, 50, 100)).r, 0);
  assert.equal((await pixel(page, 150, 100)).r, 255);

  // Làm tối chỉ trong vùng chọn
  json(await tool(page, 'select_area', { mode: 'ellipse', x: 120, y: 20, width: 60, height: 60 }));
  json(await tool(page, 'adjust_brightness_contrast', { brightness: -80 }));
  json(await tool(page, 'select_area', { mode: 'none' }));
  assert.ok((await pixel(page, 150, 50)).r < 255);
  assert.equal((await pixel(page, 150, 150)).r, 255);

  json(await tool(page, 'select_area', { mode: 'rect', x: 150, y: 150, width: 40, height: 40 }));
  json(await tool(page, 'edit_selection', { action: 'clear' }));
  json(await tool(page, 'select_area', { mode: 'none' }));
  assert.equal((await pixel(page, 170, 170)).a, 0);
});

test('chữ tiếng Việt, hình, layer', async () => {
  await freshDoc(page, { width: 600, height: 400, background: '#FFFFFF' });
  const t = json(await tool(page, 'add_text', { text: 'Khuyến mãi đặc biệt', x: 40, y: 120, size: 48, color: '#E02020', font: 'Roboto-Bold', layer_name: 'Tiêu đề' }));
  assert.equal(t.layer, 'Tiêu đề');
  assert.ok(t.bounds.width > 100 && t.bounds.y < 120 && t.bounds.y + t.bounds.height > 100, `bounds đã ổn định: ${JSON.stringify(t)}`);
  let i = await info();
  assert.equal(i.layers[0].type, 'text');
  assert.equal(i.layers[0].text, 'Khuyến mãi đặc biệt');

  json(await tool(page, 'edit_text', { layer: 'Tiêu đề', text: 'Giảm 50%', size: 64 }));
  i = await info();
  assert.equal(i.layers[0].text, 'Giảm 50%');

  // Chỉnh pixel trên layer chữ -> lỗi có hướng dẫn
  const bad = await tool(page, 'adjust_brightness_contrast', { brightness: 10, layer: 'Tiêu đề' });
  assert.equal(bad.isError, true);
  assert.match(bad.content, /layer chữ/);
  assert.equal((await tool(page, 'adjust_brightness_contrast', { brightness: 10, layer: 'Không tồn tại' })).isError, true);

  json(await tool(page, 'add_shape', { shape: 'rectangle', x: 0, y: 300, width: 600, height: 100, fill_color: '#000000', opacity: 50, layer_name: 'Thanh nền' }));
  json(await tool(page, 'add_shape', { shape: 'ellipse', x: 500, y: 20, width: 80, height: 80, fill_color: '#FFCC00', stroke_color: '#000000' }));
  const p = await pixel(page, 300, 350);
  assert.ok(p.r > 100 && p.r < 160, `opacity 50%: ${JSON.stringify(p)}`);

  const moved = json(await tool(page, 'transform_layer', { layer: 'Tiêu đề', align: 'bottom_right', margin: 10 }));
  assert.ok(Math.abs(moved.bounds.x + moved.bounds.width - 590) <= 2, JSON.stringify(moved));
  assert.ok(Math.abs(moved.bounds.y + moved.bounds.height - 390) <= 2, JSON.stringify(moved));
  const scaled = json(await tool(page, 'transform_layer', { layer: 'Thanh nền', scale_percent: 50 }));
  assert.equal(Math.round(scaled.bounds.width), 300);

  json(await tool(page, 'layer_properties', { layer: 'Thanh nền', opacity: 20, blend_mode: 'multiply' }));
  json(await tool(page, 'layer_properties', { layer: 'Thanh nền', visible: false }));
  i = await info();
  assert.equal(i.layers.find((l) => l.name === 'Thanh nền').visible, false);

  let r = json(await tool(page, 'manage_layer', { action: 'duplicate', layer: 'Tiêu đề', new_name: 'Tiêu đề 2' }));
  assert.ok(r.top_level_layers_top_to_bottom.includes('Tiêu đề 2'));
  r = json(await tool(page, 'manage_layer', { action: 'send_to_back', layer: 'Tiêu đề 2' }));
  assert.equal(r.top_level_layers_top_to_bottom.at(-1), 'Tiêu đề 2');
  r = json(await tool(page, 'manage_layer', { action: 'move_up', layer: 'Tiêu đề 2' }));
  assert.equal(r.top_level_layers_top_to_bottom.at(-2), 'Tiêu đề 2');
  r = json(await tool(page, 'manage_layer', { action: 'bring_to_front', layer: 'Tiêu đề 2' }));
  assert.equal(r.top_level_layers_top_to_bottom[0], 'Tiêu đề 2');
  r = json(await tool(page, 'manage_layer', { action: 'rename', layer: 'Tiêu đề 2', new_name: 'Bản sao' }));
  assert.equal(r.top_level_layers_top_to_bottom[0], 'Bản sao');
  r = json(await tool(page, 'manage_layer', { action: 'delete', layer: 'Bản sao' }));
  assert.equal(r.deleted, 'Bản sao');
  r = json(await tool(page, 'manage_layer', { action: 'new', new_name: 'Trống' }));
  assert.equal(r.active_layer, 'Trống');
  r = json(await tool(page, 'manage_layer', { action: 'flatten' }));
  assert.equal(r.top_level_layers_top_to_bottom.length, 1);
});

test('merge_down gộp hai layer ảnh', async () => {
  await freshDoc(page, { width: 100, height: 100 });
  json(await tool(page, 'manage_layer', { action: 'new', new_name: 'A' }));
  json(await tool(page, 'edit_selection', { action: 'fill', color: '#FF0000' }));
  json(await tool(page, 'manage_layer', { action: 'new', new_name: 'B' }));
  json(await tool(page, 'add_shape', { shape: 'rectangle', x: 0, y: 0, width: 50, height: 50, fill_color: '#00FF00', layer_name: 'C' }));
  const before = (await info()).layer_count;
  const r = await tool(page, 'manage_layer', { action: 'merge_down', layer: 'C' });
  assert.equal(r.isError, false, r.content);
  assert.equal((await info()).layer_count, before - 1);
});

test('view_image trả ảnh xem trước + tỉ lệ; vùng phóng to', async () => {
  await freshDoc(page, { width: 2000, height: 1000, background: '#20A040' });
  const full = await tool(page, 'view_image');
  assert.equal(full.isError, false);
  assert.match(full.content[0].text, /1024x512/);
  assert.match(full.content[0].text, /2000x1000/);
  assert.equal(full.content[1].type, 'image');
  assert.ok(full.content[1].source.data.length > 100);
  const zoom = await tool(page, 'view_image', { region: { x: 100, y: 100, width: 200, height: 100 } });
  assert.match(zoom.content[0].text, /200x100/);
});

test('export_image tạo file tải về', async () => {
  await freshDoc(page, { width: 64, height: 64 });
  const [download, outcome] = await Promise.all([
    page.waitForEvent('download'),
    tool(page, 'export_image', { format: 'jpg', quality: 80, file_name: 'ảnh thử' }),
  ]);
  assert.equal(outcome.isError, false);
  assert.equal(download.suggestedFilename(), 'anh-thu.jpg', 'tên file bỏ dấu cho an toàn');
  const png = await tool(page, 'export_image', { format: 'psd' });
  assert.match(JSON.parse(png.content).saved_as, /\.psd$/);
});

test('run_script: chạy được, chặn cú pháp không hỗ trợ, báo lỗi runtime ngay', async () => {
  await freshDoc(page, { width: 10, height: 10 });
  const ok = await tool(page, 'run_script', { script: 'app.echoToOE(String(app.activeDocument.width));', purpose: 'đọc chiều rộng' });
  assert.equal(ok.content, '10');
  const es6 = await tool(page, 'run_script', { script: 'var f = (x) => x;', purpose: 'thử' });
  assert.equal(es6.isError, true);
  const t0 = Date.now();
  const broken = await tool(page, 'run_script', { script: 'var a = null; a.x = 1;', purpose: 'lỗi' });
  assert.equal(broken.isError, true);
  assert.ok(Date.now() - t0 < 5000, 'phát hiện lỗi nhanh, không chờ timeout');
  // Photopea vẫn hoạt động sau lỗi
  assert.equal((await info()).width, 10);
});

test('tham số sai bị chặn trước khi chạy', async () => {
  const r = await tool(page, 'apply_filter', { filter: 'blur', radius: -1 });
  assert.equal(r.isError, true);
  assert.match(r.content, /radius/);
  assert.equal((await tool(page, 'khong_co_tool')).isError, true);
});

test('không có lỗi JavaScript trên trang', () => {
  assert.deepEqual(pageErrors, [], pageErrors.join('\n'));
});

// ───────────────────────────── Chỉnh màu nâng cao ─────────────────────────────

/** Tài liệu 200x100: nửa trái đỏ #C02020, nửa phải xanh #2040C0. */
async function twoColorDoc() {
  await freshDoc(page, { width: 200, height: 100, background: '#2040C0' });
  json(await tool(page, 'select_area', { mode: 'rect', x: 0, y: 0, width: 100, height: 100 }));
  json(await tool(page, 'edit_selection', { action: 'fill', color: '#C02020' }));
  json(await tool(page, 'select_area', { mode: 'none' }));
}

test('Color Balance, Curves và Levels theo từng kênh', async () => {
  await freshDoc(page, { background: '#808080' });
  json(await tool(page, 'adjust_color_balance', { midtones: [50, 0, -50] }));
  let p = await pixel(page, 5, 5);
  assert.ok(p.r > p.g + 15 && p.g > p.b + 15, `color balance: ${JSON.stringify(p)}`);

  await freshDoc(page, { background: '#808080' });
  json(await tool(page, 'adjust_curves', { red: [[0, 0], [128, 180], [255, 255]], blue: [[0, 0], [128, 80], [255, 255]] }));
  p = await pixel(page, 5, 5);
  assert.ok(p.r > 165 && p.b < 95 && Math.abs(p.g - 128) <= 2, `curves R/B: ${JSON.stringify(p)}`);

  await freshDoc(page, { background: '#808080' });
  json(await tool(page, 'adjust_levels', { channel: 'green', input_white: 200 }));
  p = await pixel(page, 5, 5);
  assert.ok(p.g > 155 && Math.abs(p.r - 128) <= 2 && Math.abs(p.b - 128) <= 2, `levels G: ${JSON.stringify(p)}`);
});

test('Hue/Saturation chỉ một dải màu', async () => {
  await twoColorDoc();
  json(await tool(page, 'adjust_hue_saturation', { color_range: 'reds', saturation: -100 }));
  const red = await pixel(page, 50, 50);
  const blue = await pixel(page, 150, 50);
  assert.ok(Math.abs(red.r - red.b) < 6, `nửa đỏ thành xám: ${JSON.stringify(red)}`);
  // Photopea làm tròn lại khi chạy Hue/Saturation nên cho phép lệch ±2
  assert.ok(Math.abs(blue.r - 0x20) <= 2 && Math.abs(blue.g - 0x40) <= 2 && Math.abs(blue.b - 0xC0) <= 2, `nửa xanh giữ nguyên: ${JSON.stringify(blue)}`);
});

test('color_grade: mọi preset đổi màu và hoàn tác đúng số bước', async () => {
  const presets = ['cinematic', 'vintage', 'warm', 'cool_moody', 'korean', 'faded_matte', 'bw_dramatic', 'vivid'];
  for (const preset of presets) {
    await freshDoc(page, { background: '#B07050' });
    const before = await pixel(page, 5, 5);
    const r = json(await tool(page, 'color_grade', { preset, strength: 100 }));
    const after = await pixel(page, 5, 5);
    assert.notDeepEqual(after, before, `${preset} phải đổi màu`);
    json(await tool(page, 'undo', { steps: r.history_steps }));
    assert.deepEqual(await pixel(page, 5, 5), before, `${preset}: hoàn tác ${r.history_steps} bước về như cũ`);
  }
  await freshDoc(page, { background: '#808080' });
  json(await tool(page, 'color_grade', { preset: 'warm', strength: 100 }));
  const warm = await pixel(page, 5, 5);
  assert.ok(warm.r > warm.b + 10, `warm: ${JSON.stringify(warm)}`);
  await freshDoc(page, { background: '#B07050' });
  json(await tool(page, 'color_grade', { preset: 'bw_dramatic', strength: 100 }));
  const bw = await pixel(page, 5, 5);
  assert.ok(Math.abs(bw.r - bw.b) < 6, `bw: ${JSON.stringify(bw)}`);
});

test('select_by_color: magic wand, theo màu, theo dải màu; get_document_info báo vùng chọn', async () => {
  await twoColorDoc();
  assert.equal(json(await tool(page, 'get_document_info')).selection, null);

  let r = json(await tool(page, 'select_by_color', { method: 'magic_wand', x: 150, y: 50 }));
  assert.deepEqual(r.selection_bounds, { x: 100, y: 0, width: 100, height: 100 });
  assert.deepEqual(json(await tool(page, 'get_document_info')).selection, { x: 100, y: 0, width: 100, height: 100 });
  json(await tool(page, 'adjust_brightness_contrast', { brightness: -60 }));
  json(await tool(page, 'select_area', { mode: 'none' }));
  assert.ok((await pixel(page, 150, 50)).b < 0xC0, 'nửa phải tối đi');
  assert.deepEqual(await pixel(page, 50, 50), { r: 0xC0, g: 0x20, b: 0x20, a: 255 }, 'nửa trái giữ nguyên');

  await twoColorDoc();
  r = json(await tool(page, 'select_by_color', { method: 'color', color: '#C02020', tolerance: 20 }));
  assert.ok(Math.abs(r.coverage_percent - 50) < 2, JSON.stringify(r));
  json(await tool(page, 'edit_selection', { action: 'fill', color: '#00FF00' }));
  json(await tool(page, 'select_area', { mode: 'none' }));
  assert.deepEqual(await pixel(page, 50, 50), { r: 0, g: 255, b: 0, a: 255 });
  assert.deepEqual(await pixel(page, 150, 50), { r: 0x20, g: 0x40, b: 0xC0, a: 255 });
  const layers = json(await tool(page, 'get_document_info')).layers;
  assert.ok(!layers.some((l) => l.name.startsWith('__bokin')), 'không để lại layer tạm');

  await twoColorDoc();
  r = json(await tool(page, 'select_by_color', { method: 'hue_range', hue_range: 'blues' }));
  assert.ok(Math.abs(r.selection_bounds.x - 100) <= 1 && r.selection_bounds.width <= 101, JSON.stringify(r));
  json(await tool(page, 'select_area', { mode: 'none' }));

  assert.equal((await tool(page, 'select_by_color', { method: 'hue_range', hue_range: 'greens' })).isError, true, 'không có màu xanh lá');
});
