// Kiểm thử bảng "Màu nhanh" (không gọi Claude): áp preset, thay preset/độ mạnh mà không chồng lên,
// hoàn tác đúng số bước, nút nhanh, ghi chú gửi cho Claude, và không thay nhầm khi đã có chỉnh sửa khác.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, openApp, tool, json, pixel, freshDoc } from './helpers.js';

let server, browser, page, pageErrors;

before(async () => {
  ({ server } = await startServer());
  ({ browser, page, pageErrors } = await openApp(`http://127.0.0.1:${server.address().port}`));
  await page.click('#color-panel summary');
});

after(async () => {
  await browser?.close();
  server?.close();
});

const BASE = '#B07050';
const P = () => pixel(page, 5, 5);

/** Màu kết quả khi áp đúng MỘT lần preset trên ảnh mới (để so sánh). */
async function reference(preset, strength) {
  await freshDoc(page, { width: 50, height: 50, background: BASE });
  json(await tool(page, 'color_grade', { preset, strength }));
  return P();
}

async function setStrength(value) {
  await page.evaluate((v) => {
    const el = document.getElementById('preset-strength');
    el.value = String(v);
    el.dispatchEvent(new Event('input'));
    el.dispatchEvent(new Event('change'));
  }, value);
}

const waitIdle = () => page.waitForFunction(() => !document.querySelector('#preset-grid button').disabled);

test('bảng có 8 preset và các nút nhanh', async () => {
  assert.equal(await page.locator('#preset-grid button').count(), 8);
  assert.deepEqual(await page.locator('#quick-actions button').allTextContents(),
    ['Tự cân màu', 'Ấm hơn', 'Lạnh hơn', 'Tươi hơn', 'Nhạt hơn', 'Hoàn tác']);
});

test('áp preset; đổi preset / độ mạnh thì THAY THẾ chứ không chồng lên; hoàn tác về ảnh gốc', async () => {
  const cinematic60 = await reference('cinematic', 60);
  const korean60 = await reference('korean', 60);
  const korean100 = await reference('korean', 100);

  await freshDoc(page, { width: 50, height: 50, background: BASE });
  const original = await P();
  await setStrength(60);

  await page.click('#preset-grid button[data-preset="cinematic"]');
  await waitIdle();
  assert.deepEqual(await P(), cinematic60);
  assert.match(await page.textContent('#color-status'), /Đã áp "Điện ảnh" 60%/);

  await page.click('#preset-grid button[data-preset="korean"]');
  await waitIdle();
  assert.deepEqual(await P(), korean60, 'Tông Hàn thay cho Điện ảnh');
  assert.match(await page.textContent('#color-status'), /Đã thay "Điện ảnh" bằng "Tông Hàn"/);
  assert.equal(await page.getAttribute('#preset-grid button.active', 'data-preset'), 'korean', 'đánh dấu preset đang áp');

  await setStrength(100);
  await waitIdle();
  assert.deepEqual(await P(), korean100, 'kéo độ mạnh: áp lại với độ mạnh mới');

  await page.click('#quick-actions button[data-action="undo"]');
  await waitIdle();
  assert.deepEqual(await P(), original, 'hoàn tác đúng số bước của preset');

  const notes = await page.evaluate(() => window.bokin.state.pendingNotes.map((n) => n.text));
  assert.equal(notes.filter((n) => n.includes('phong cách màu')).length, 1, 'chỉ giữ ghi chú preset mới nhất');
  assert.ok(notes.some((n) => n.includes('"korean" độ mạnh 100%')));
});

test('có chỉnh sửa khác xen vào: preset mới được áp chồng lên, không hoàn tác nhầm', async () => {
  await freshDoc(page, { width: 50, height: 50, background: BASE });
  await setStrength(60);
  await page.click('#preset-grid button[data-preset="warm"]');
  await waitIdle();
  json(await tool(page, 'adjust_brightness_contrast', { brightness: 30 })); // ví dụ: Claude hoặc người dùng chỉnh thêm
  const beforeSecond = await P();
  await page.click('#preset-grid button[data-preset="vivid"]');
  await waitIdle();
  assert.notDeepEqual(await P(), beforeSecond);
  // Hoàn tác chỉ gỡ "Rực rỡ", vẫn giữ phần tăng sáng
  await page.click('#quick-actions button[data-action="undo"]');
  await waitIdle();
  assert.deepEqual(await P(), beforeSecond);
});

test('nút nhanh: ấm hơn, lạnh hơn, tươi hơn, nhạt hơn, tự cân màu', async () => {
  for (const action of ['warmer', 'cooler', 'more', 'less', 'auto']) {
    await freshDoc(page, { width: 50, height: 50, background: '#8090A0' });
    const before = await P();
    await page.click(`#quick-actions button[data-action="${action}"]`);
    await waitIdle();
    const after = await P();
    if (action === 'warmer') assert.ok(after.r > before.r && after.b < before.b, `${action}: ${JSON.stringify(after)}`);
    else if (action === 'cooler') assert.ok(after.b > before.b && after.r < before.r, `${action}: ${JSON.stringify(after)}`);
    else assert.notDeepEqual(after, before, action);
  }
});

test('áp trong vùng chọn và báo rõ; chưa mở ảnh thì báo lỗi', async () => {
  await freshDoc(page, { width: 100, height: 50, background: BASE });
  json(await tool(page, 'select_area', { mode: 'rect', x: 0, y: 0, width: 50, height: 50 }));
  await setStrength(100);
  await waitIdle();
  await page.click('#preset-grid button[data-preset="bw_dramatic"]');
  await waitIdle();
  assert.match(await page.textContent('#color-status'), /trong vùng chọn/);
  const left = await pixel(page, 10, 10);
  const right = await pixel(page, 90, 10);
  assert.ok(Math.abs(left.r - left.b) < 6, 'trái: đen trắng');
  assert.ok(right.r - right.b > 40, 'phải: giữ màu');
  json(await tool(page, 'select_area', { mode: 'none' }));

  await page.evaluate(() => window.bokin.bridge.exec('while (app.documents.length) { app.activeDocument.close(2); }'));
  await page.click('#preset-grid button[data-preset="cinematic"]');
  await waitIdle();
  assert.match(await page.textContent('#color-status'), /Chưa có ảnh/);
});

test('không có lỗi JavaScript trên trang', () => {
  assert.deepEqual(pageErrors, [], pageErrors.join('\n'));
});
