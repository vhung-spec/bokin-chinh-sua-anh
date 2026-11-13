// Kiểm thử bố cục và cách dùng: thẻ Bắt đầu, tab (nhớ tab đã chọn), thanh công cụ, giữ để xem ảnh gốc.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, openApp, tool, json, pixel } from './helpers.js';

let server, browser, page, pageErrors, url;

before(async () => {
  ({ server, url } = await startServer());
  ({ browser, page, pageErrors } = await openApp(url));
});

after(async () => {
  await browser?.close();
  server?.close();
});

const closeAll = () => page.evaluate(() => window.bokin.bridge.exec('while (app.documents.length) { app.activeDocument.close(2); }'));
const idle = () => page.waitForFunction(() => !window.bokin.state.toolbarBusy);

test('chưa có ảnh: hiện thẻ Bắt đầu, khoá nút Tải/Hoàn tác; tạo ảnh trống từ thẻ thì thẻ biến mất', async () => {
  await closeAll();
  await page.dispatchEvent('#photopea', 'mouseleave');
  await page.waitForSelector('#start-card:not([hidden])');
  for (const id of ['#download-btn', '#undo-btn', '#redo-btn', '#compare-btn']) assert.equal(await page.isDisabled(id), true, id);

  await page.selectOption('#start-size', '1200x630');
  await page.click('#start-blank');
  await page.waitForSelector('#start-card', { state: 'hidden' });
  const info = json(await tool(page, 'get_document_info'));
  assert.equal(info.width, 1200);
  assert.equal(info.height, 630);
  assert.equal(await page.isDisabled('#undo-btn'), false);
  assert.match(await page.textContent('#toast'), /Đã tạo ảnh trống 1200×630/);
});

test('ba tab: mỗi lúc một tab, nhớ tab đã chọn khi tải lại trang', async () => {
  assert.equal(await page.getAttribute('#tab-chat', 'aria-selected'), 'true', 'mặc định: Trò chuyện');
  assert.equal(await page.isVisible('#input'), true);
  await page.click('#tab-color');
  assert.equal(await page.isVisible('#preset-grid'), true);
  assert.equal(await page.isVisible('#input'), false);
  await page.click('#tab-fill');
  assert.equal(await page.isVisible('#select-tools'), true);
  assert.equal(await page.isVisible('#preset-grid'), false);

  await page.reload();
  await page.waitForFunction(() => window.bokin?.bridge?.isReady === true, null, { timeout: 120_000 });
  assert.equal(await page.getAttribute('#tab-fill', 'aria-selected'), 'true', 'nhớ tab Tạo bằng AI');
  // Liên kết "Mô tả trong tab Trò chuyện" ở tab Màu nhanh
  await page.click('#tab-color');
  await page.click('#panel-color [data-goto="chat"]');
  assert.equal(await page.getAttribute('#tab-chat', 'aria-selected'), 'true');
});

test('giữ nút "So sánh" hiện ảnh gốc, thả ra quay lại ảnh đã chỉnh', async () => {
  await closeAll();
  json(await tool(page, 'create_document', { width: 80, height: 60, background: '#808080' }));
  json(await tool(page, 'adjust_brightness_contrast', { brightness: 60 }));
  const edited = await pixel(page, 5, 5);
  assert.ok(edited.r > 140);
  await page.dispatchEvent('#photopea', 'mouseleave');
  await page.waitForSelector('#compare-btn:not([disabled])');

  await page.hover('#compare-btn');
  await page.mouse.down();
  await page.waitForFunction(() => document.getElementById('compare-btn').classList.contains('pressed'));
  await page.waitForTimeout(300);
  assert.equal((await pixel(page, 5, 5)).r, 128, 'đang giữ: ảnh gốc');
  await page.mouse.up();
  await idle();
  assert.deepEqual(await pixel(page, 5, 5), edited, 'thả ra: ảnh đã chỉnh');
  // Sau khi so sánh, hoàn tác vẫn đúng
  await page.click('#undo-btn');
  await idle();
  assert.equal((await pixel(page, 5, 5)).r, 128);
});

test('Hoàn tác từng bước với chỉnh sửa không thuộc thao tác nào; báo khi không còn gì để làm lại', async () => {
  await closeAll();
  json(await tool(page, 'create_document', { width: 40, height: 40, background: '#808080' }));
  json(await tool(page, 'adjust_brightness_contrast', { brightness: 30 }));
  json(await tool(page, 'adjust_brightness_contrast', { brightness: 30 }));
  const two = await pixel(page, 5, 5);
  await page.click('#undo-btn');
  await idle();
  const one = await pixel(page, 5, 5);
  assert.ok(one.r < two.r && one.r > 128, 'gỡ đúng một bước');
  assert.match(await page.textContent('#toast'), /Đã hoàn tác một bước/);
  await page.click('#redo-btn');
  await idle();
  assert.deepEqual(await pixel(page, 5, 5), two);
  await page.click('#redo-btn');
  await idle();
  assert.match(await page.textContent('#toast'), /Không có bước nào để làm lại/);
});

test('không có lỗi JavaScript trên trang', () => {
  assert.deepEqual(pageErrors, [], pageErrors.join('\n'));
});
