// Chỉnh màu theo vùng bằng chat: lớp "Chỉnh: <tên>" sửa lại được (gọi lại cùng tên), đổi màu vật, hút màu.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, openApp, tool, json, pixel, freshDoc } from './helpers.js';

let server, browser, page, pageErrors, url;

before(async () => {
  ({ server, url } = await startServer());
  ({ browser, page, pageErrors } = await openApp(url));
});

after(async () => {
  await browser?.close();
  server?.close();
});

const RED = { r: 200, g: 50, b: 50, a: 255 };
const BLUE = { r: 50, g: 50, b: 200, a: 255 };
const run = (s) => page.evaluate((x) => window.bokin.bridge.exec(x), s);
const info = async () => json(await tool(page, 'get_document_info'));

/** Ảnh 200×100: nửa trái đỏ, nửa phải xanh dương. */
async function twoHalves() {
  await freshDoc(page, { width: 200, height: 100, background: '#3232C8' });
  json(await tool(page, 'select_area', { mode: 'rect', x: 0, y: 0, width: 100, height: 100 }));
  json(await tool(page, 'edit_selection', { action: 'fill', color: '#C83232' }));
  json(await tool(page, 'select_area', { mode: 'none' }));
}

test('chỉnh vùng thành lớp có tên; gọi lại cùng tên (không còn vùng chọn) thì thay, đúng vùng cũ', async () => {
  await twoHalves();
  json(await tool(page, 'select_area', { mode: 'rect', x: 0, y: 0, width: 100, height: 100 }));
  const first = json(await tool(page, 'adjust_area', { name: 'Trái', brightness: 40 }));
  assert.equal(first.layer, 'Chỉnh: Trái');
  assert.equal(first.area, 'selection');
  const lit1 = await pixel(page, 50, 50);
  assert.ok(lit1.r > RED.r + 15, `sáng hơn: ${JSON.stringify(lit1)}`);
  assert.deepEqual(await pixel(page, 150, 50), BLUE, 'ngoài vùng không đổi');
  let doc = await info();
  assert.deepEqual(doc.selection, { x: 0, y: 0, width: 100, height: 100 }, 'vùng chọn của người dùng giữ nguyên');
  assert.deepEqual(doc.area_edits, [{ name: 'Trái', layer: 'Chỉnh: Trái', brightness: 40 }]);

  json(await tool(page, 'select_area', { mode: 'none' }));
  const again = json(await tool(page, 'adjust_area', { name: 'Trái', brightness: 80 }));
  assert.equal(again.replaced, true);
  assert.equal(again.area, 'same area as before');
  const lit2 = await pixel(page, 50, 50);
  assert.ok(lit2.r > lit1.r + 10, `mạnh hơn, tính từ ảnh gốc: ${JSON.stringify({ lit1, lit2 })}`);
  assert.deepEqual(await pixel(page, 150, 50), BLUE, 'vẫn đúng vùng cũ');
  doc = await info();
  assert.deepEqual(doc.layers.map((l) => l.name), ['Chỉnh: Trái', 'Background'], 'không chồng thêm lớp');
  assert.equal(doc.selection, null, 'không để lại vùng chọn');
  assert.equal(doc.area_edits[0].brightness, 80);

  // bỏ lần chỉnh: xoá lớp
  json(await tool(page, 'manage_layer', { action: 'delete', layer: 'Chỉnh: Trái' }));
  assert.deepEqual(await pixel(page, 50, 50), RED);
  assert.equal((await info()).area_edits, undefined);
});

test('đổi màu vật sang màu đích; ấm/lạnh; không có giá trị nào thì báo', async () => {
  await twoHalves();
  json(await tool(page, 'select_area', { mode: 'rect', x: 100, y: 0, width: 100, height: 100 }));
  json(await tool(page, 'adjust_area', { name: 'Áo', target_color: '#1E3264' }));
  const navy = await pixel(page, 150, 50);
  assert.ok(Math.abs(navy.r - 30) < 8 && Math.abs(navy.g - 50) < 8 && Math.abs(navy.b - 100) < 8, JSON.stringify(navy));
  assert.deepEqual(await pixel(page, 50, 50), RED);

  json(await tool(page, 'select_area', { mode: 'rect', x: 0, y: 0, width: 100, height: 100 }));
  json(await tool(page, 'adjust_area', { name: 'Trái', warmth: 60 }));
  const warm = await pixel(page, 50, 50);
  assert.ok(warm.b < RED.b - 15 && warm.r >= RED.r, `ấm hơn (ngả cam, bớt xanh dương): ${JSON.stringify(warm)}`);
  const none = await tool(page, 'adjust_area', { name: 'Trống' });
  assert.equal(none.isError, true);
  assert.match(none.content, /Chưa có thay đổi nào/);
  assert.deepEqual((await info()).area_edits.map((e) => e.name), ['Áo', 'Trái']);
});

test('không có vùng chọn, chưa có lớp cùng tên: chỉnh cả ảnh', async () => {
  await twoHalves();
  const out = json(await tool(page, 'adjust_area', { name: 'Cả ảnh', saturation: -100 }));
  assert.equal(out.area, 'whole image');
  const g = await pixel(page, 50, 50);
  assert.ok(Math.abs(g.r - g.g) <= 2 && Math.abs(g.g - g.b) <= 2, `đen trắng: ${JSON.stringify(g)}`);
});

test('Hút màu: picked_color cho Claude; "Chọn vùng màu này" chọn đúng chỗ cùng màu', async () => {
  await twoHalves();
  await page.click('#tab-color');
  await page.click('#region-tools button[data-tool="eyedropperTool"]');
  await page.waitForSelector('#region-info:has-text("Bấm vào một màu")');
  // như người dùng bấm vào phần đỏ bằng công cụ hút màu
  await run("var c = new SolidColor(); c.rgb.hexValue = 'C83232'; app.foregroundColor = c; app.echoToOE('x');");
  assert.equal((await info()).picked_color, '#C83232');
  await page.dispatchEvent('#photopea', 'mouseleave');
  await page.waitForSelector('#picked:not([hidden])');
  assert.match(await page.textContent('#picked-text'), /#C83232/);
  await page.click('#picked-select');
  await page.waitForSelector('#color-status:has-text("Đã chọn mọi chỗ có màu giống #C83232")');
  assert.deepEqual((await info()).selection, { x: 0, y: 0, width: 100, height: 100 });
});

test('Hoàn tác MỘT lần gỡ cả lần chỉnh vùng', async () => {
  await twoHalves();
  json(await tool(page, 'select_area', { mode: 'rect', x: 0, y: 0, width: 100, height: 100 }));
  await page.evaluate(() => window.bokin.log.reset());
  await page.evaluate(() => window.bokin.log.record({ kind: 'chat', label: 'yêu cầu "sáng hơn"' },
    () => window.bokin.executeTool('adjust_area', { name: 'Trái', brightness: 50 })));
  assert.notDeepEqual(await pixel(page, 50, 50), RED);
  await page.click('#undo-btn');
  await page.waitForFunction(() => !window.bokin.state.toolbarBusy);
  assert.deepEqual(await pixel(page, 50, 50), RED);
  assert.deepEqual((await info()).layers.map((l) => l.name), ['Background']);
});

test('không có lỗi JavaScript trên trang', () => {
  assert.deepEqual(pageErrors, [], pageErrors.join('\n'));
});
