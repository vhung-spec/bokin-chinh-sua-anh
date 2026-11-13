// Chỉnh màu vùng chọn theo ảnh mẫu (Match Color) và "Tô vùng" (Quick Mask), trên Photopea thật.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, openApp, tool, json, pixel, freshDoc, solidPng } from './helpers.js';

let server, browser, page, pageErrors, url;

before(async () => {
  ({ server, url } = await startServer());
  ({ browser, page, pageErrors } = await openApp(url));
});

after(async () => {
  await browser?.close();
  server?.close();
});

const GREEN = [40, 160, 70];
const RED = { r: 200, g: 50, b: 50, a: 255 };
const BLUE = { r: 50, g: 50, b: 200, a: 255 };
const near = (p, [r, g, b], tol = 6) => Math.abs(p.r - r) <= tol && Math.abs(p.g - g) <= tol && Math.abs(p.b - b) <= tol;
const run = (s) => page.evaluate((x) => window.bokin.bridge.exec(x), s);
const idle = () => page.waitForFunction(() => !window.bokin.state.toolbarBusy);

/** Ảnh 200×100: nửa trái đỏ, nửa phải xanh dương. */
async function twoHalves() {
  await freshDoc(page, { width: 200, height: 100, background: '#3232C8' });
  json(await tool(page, 'select_area', { mode: 'rect', x: 0, y: 0, width: 100, height: 100 }));
  json(await tool(page, 'edit_selection', { action: 'fill', color: '#C83232' }));
  json(await tool(page, 'select_area', { mode: 'none' }));
}

/** Đặt ảnh mẫu một màu (PNG tạo sẵn) qua đúng hàm giao diện dùng. */
async function setReference(rgb, name = 'mau-xanh.png') {
  const b64 = solidPng(64, 48, rgb).toString('base64');
  return page.evaluate(async ([data, n]) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const ref = await window.bokin.runner.setReference(new Blob([bytes], { type: 'image/png' }), n);
    return { name: ref.name, colors: ref.colors, thumb: ref.thumb.slice(0, 23) };
  }, [b64, name]);
}

test('chưa có ảnh mẫu: báo rõ', async () => {
  await twoHalves();
  await page.evaluate(() => window.bokin.runner.clearReference());
  const out = await tool(page, 'match_reference_colors', {});
  assert.equal(out.isError, true);
  assert.match(out.content, /Chưa có ảnh mẫu/);
});

test('chỉ vùng chọn đổi sang màu ảnh mẫu, phần ngoài giữ nguyên; vùng chọn còn nguyên sau đó', async () => {
  await twoHalves();
  const ref = await setReference(GREEN);
  assert.equal(ref.thumb, 'data:image/jpeg;base64,');
  assert.ok(ref.colors.green_magenta < 0, 'ảnh mẫu ngả xanh lá');
  const info = json(await tool(page, 'get_document_info'));
  assert.equal(info.reference_image.name, 'mau-xanh.png', 'Claude thấy ảnh mẫu trong thông tin ảnh');

  json(await tool(page, 'select_area', { mode: 'rect', x: 0, y: 0, width: 100, height: 100 }));
  const out = json(await tool(page, 'match_reference_colors', {}));
  assert.equal(out.masked_to, 'selection');
  assert.equal(out.layer, 'Màu theo ảnh mẫu');
  assert.ok(near(await pixel(page, 50, 50), GREEN), JSON.stringify(await pixel(page, 50, 50)));
  assert.deepEqual(await pixel(page, 150, 50), BLUE, 'ngoài vùng chọn không đổi');
  const after = json(await tool(page, 'get_document_info'));
  assert.deepEqual(after.selection, { x: 0, y: 0, width: 100, height: 100 });
  assert.deepEqual(after.layers.map((l) => l.name), ['Màu theo ảnh mẫu', 'Background']);
});

test('vùng chọn hình bất kỳ (elip): chỉ đúng hình đó đổi, mép mềm', async () => {
  await twoHalves();
  await setReference(GREEN);
  json(await tool(page, 'select_area', { mode: 'ellipse', x: 10, y: 10, width: 80, height: 80 }));
  json(await tool(page, 'match_reference_colors', {}));
  assert.ok(near(await pixel(page, 50, 50), GREEN), 'tâm elip');
  assert.deepEqual(await pixel(page, 12, 12), RED, 'góc ngoài elip (trong khung chữ nhật) giữ nguyên');
});

test('độ mạnh 50% = nửa đường; giữ độ sáng: chỉ lấy màu', async () => {
  await twoHalves();
  await setReference(GREEN);
  json(await tool(page, 'select_area', { mode: 'rect', x: 0, y: 0, width: 100, height: 100 }));
  json(await tool(page, 'match_reference_colors', { strength: 50 }));
  const half = await pixel(page, 50, 50);
  assert.ok(near(half, [120, 105, 60], 12), `pha 50%: ${JSON.stringify(half)}`);

  await twoHalves();
  await setReference([20, 80, 35]); // xanh lá tối
  json(await tool(page, 'select_area', { mode: 'rect', x: 0, y: 0, width: 100, height: 100 }));
  json(await tool(page, 'match_reference_colors', { keep_brightness: true }));
  const kept = await pixel(page, 50, 50);
  const lum = (p) => 0.2126 * p.r + 0.7152 * p.g + 0.0722 * p.b;
  assert.ok(kept.g > kept.r, `đã ngả xanh lá: ${JSON.stringify(kept)}`);
  assert.ok(Math.abs(lum(kept) - lum(RED)) < 25, `độ sáng gần như cũ: ${lum(kept)} vs ${lum(RED)}`);
});

test('không có vùng chọn: cả ảnh lấy màu ảnh mẫu', async () => {
  await twoHalves();
  await setReference(GREEN);
  const out = json(await tool(page, 'match_reference_colors', {}));
  assert.equal(out.masked_to, 'whole image');
  const left = await pixel(page, 50, 50);
  const right = await pixel(page, 150, 50);
  assert.ok(left.g > left.r && right.g > right.b, JSON.stringify({ left, right }));
});

test('Tô vùng: phần tô thành vùng chọn; vùng chọn đang có được giữ và cộng thêm', async () => {
  await twoHalves();
  const paintRect = (x, y, w, h) => run(`var c = new SolidColor(); c.rgb.hexValue = '000000'; var d = app.activeDocument;
d.selection.select([[${x},${y}],[${x + w},${y}],[${x + w},${y + h}],[${x},${y + h}]]); d.selection.fill(c); d.selection.deselect(); app.echoToOE('p');`);
  const start = await page.evaluate(() => window.bokin.runner.startPaint());
  assert.equal(start.isError, false, start.content);
  assert.equal(json(await tool(page, 'get_document_info')).painting_selection, true);
  await paintRect(20, 20, 40, 30); // như người dùng tô bằng cọ đen
  const done = await page.evaluate(() => window.bokin.runner.finishPaint());
  assert.deepEqual(JSON.parse(done.content).selection, { x: 20, y: 20, width: 40, height: 30 });

  // vùng chọn đang có (chữ nhật bên phải) + tô thêm bên trái = cả hai
  json(await tool(page, 'select_area', { mode: 'rect', x: 140, y: 40, width: 30, height: 30 }));
  await page.evaluate(() => window.bokin.runner.startPaint());
  await paintRect(20, 20, 40, 30);
  const both = JSON.parse((await page.evaluate(() => window.bokin.runner.finishPaint())).content).selection;
  assert.deepEqual(both, { x: 20, y: 20, width: 150, height: 50 });

  // một lệnh chạy khi còn đang tô: Bokin tự kết thúc tô trước
  await page.evaluate(() => window.bokin.runner.startPaint());
  await paintRect(10, 10, 20, 20);
  await setReference(GREEN);
  json(await tool(page, 'match_reference_colors', {}));
  assert.equal(await page.evaluate(() => window.bokin.runner.painting), false);
  // vùng gồm cả đỏ lẫn xanh dương: tông chung thành xanh lá, các chỗ vẫn khác nhau tương đối (như Match Color)
  const p = await pixel(page, 20, 20);
  assert.ok(p.g > p.r + 40 && p.g > p.b + 40, `chỗ vừa tô đã ngả xanh lá: ${JSON.stringify(p)}`);
  assert.deepEqual(await pixel(page, 185, 90), BLUE, 'ngoài vùng không đổi');
});

test('Hoàn tác MỘT lần gỡ cả lần áp màu; vùng chọn giữ nguyên', async () => {
  await twoHalves();
  await setReference(GREEN);
  json(await tool(page, 'select_area', { mode: 'rect', x: 0, y: 0, width: 100, height: 100 }));
  await page.evaluate(() => window.bokin.log.reset());
  await page.evaluate(() => window.bokin.log.record({ kind: 'match', label: 'màu theo ảnh mẫu' },
    () => window.bokin.executeTool('match_reference_colors', {})));
  assert.ok(near(await pixel(page, 50, 50), GREEN));
  await page.click('#undo-btn');
  await idle();
  assert.deepEqual(await pixel(page, 50, 50), RED);
  const info = json(await tool(page, 'get_document_info'));
  assert.deepEqual(info.layers.map((l) => l.name), ['Background']);
  assert.deepEqual(info.selection, { x: 0, y: 0, width: 100, height: 100 });
});

test('tab Màu nhanh: chọn ảnh mẫu, khoanh vùng, Áp; kéo độ mạnh thì thay kết quả; Hoàn tác một lần', async () => {
  await twoHalves();
  await page.evaluate(() => window.bokin.reference.clear());
  await page.click('#tab-color');
  assert.equal(await page.isDisabled('#match-run'), true, 'chưa có ảnh mẫu: nút Áp bị khoá');
  await page.setInputFiles('#match-file', { name: 'mau-xanh.png', mimeType: 'image/png', buffer: solidPng(64, 48, GREEN) });
  await page.waitForSelector('#match-thumb:not([hidden])');
  assert.match(await page.textContent('#match-name'), /mau-xanh\.png · 64×48/);
  assert.equal(await page.isDisabled('#match-run'), false);

  json(await tool(page, 'select_area', { mode: 'rect', x: 0, y: 0, width: 100, height: 100 }));
  await page.dispatchEvent('#photopea', 'mouseleave');
  await page.waitForSelector('#match-selection:has-text("Sẽ chỉnh vùng chọn 100×100 px")');
  await page.click('#match-run');
  await page.waitForSelector('#match-status:has-text("Đã áp màu")');
  assert.ok(near(await pixel(page, 50, 50), GREEN));
  assert.deepEqual(await pixel(page, 150, 50), BLUE);

  // kéo độ mạnh xuống 50%: thay kết quả vừa rồi (vẫn một layer), màu pha nửa
  await page.$eval('#match-strength', (el) => { el.value = '50'; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); });
  await page.waitForSelector('#match-status:has-text("độ mạnh 50%")');
  const info = json(await tool(page, 'get_document_info'));
  assert.deepEqual(info.layers.map((l) => l.name), ['Màu theo ảnh mẫu', 'Background'], 'không chồng thêm layer');
  assert.ok(near(await pixel(page, 50, 50), [120, 105, 60], 12));

  await page.click('#undo-btn');
  await idle();
  assert.deepEqual(await pixel(page, 50, 50), RED, 'một lần Hoàn tác về ảnh gốc');
  assert.match(await page.textContent('#toast'), /Đã hoàn tác màu theo ảnh mẫu/);
});

test('nút Tô vùng: đổi thành "Xong tô" ở mọi tab; tô xong thì vùng tô là vùng chọn', async () => {
  await twoHalves();
  await page.click('#tab-color');
  await page.click('#match-tools button[data-paint]');
  await page.waitForSelector('#match-tools button[data-paint].active');
  assert.equal((await page.textContent('#match-tools button[data-paint]')).trim(), '✓ Xong tô');
  assert.equal((await page.textContent('#select-tools button[data-paint]')).trim(), '✓ Xong tô', 'tab Tạo bằng AI cũng đổi');
  assert.match(await page.textContent('#match-selection'), /Tô màu đen/);
  await run(`var c = new SolidColor(); c.rgb.hexValue = '000000'; var d = app.activeDocument;
d.selection.select([[30,20],[90,20],[90,80],[30,80]]); d.selection.fill(c); d.selection.deselect(); app.echoToOE('p');`);
  await page.click('#match-tools button[data-paint]');
  await page.waitForSelector('#match-selection:has-text("Sẽ chỉnh vùng chọn 60×60 px")');
  assert.equal((await page.textContent('#match-tools button[data-paint]')).trim(), '🖌 Tô vùng');
  assert.deepEqual(json(await tool(page, 'get_document_info')).selection, { x: 30, y: 20, width: 60, height: 60 });
});

test('không có lỗi JavaScript trên trang', () => {
  assert.deepEqual(pageErrors, [], pageErrors.join('\n'));
});
