// Kiểm thử tool ai_edit trên Photopea thật, với dịch vụ AI giả lập (trả ảnh một màu, KHÁC kích thước ảnh gửi đi)
// để kiểm tra: ảnh gửi đi đúng vùng, kết quả được co giãn/đặt đúng chỗ, mask chỉ thay vùng yêu cầu.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, openApp, tool, json, pixel, freshDoc, solidPng, pngSize } from './helpers.js';

const calls = [];
let mode = 'ok';
const fakeEditor = async ({ buffer, mimeType, instruction }) => {
  calls.push({ size: pngSize(buffer), mimeType, instruction });
  if (mode === 'error') throw new Error('dịch vụ AI giả lập bị lỗi');
  return { buffer: solidPng(64, 48, [255, 0, 255]), mimeType: 'image/png' };
};

// "Claude" giả cho việc dịch câu lệnh Generative Fill (model rẻ)
const translations = [];
const fakeAnthropic = {
  messages: {
    create: async (params) => {
      translations.push(params);
      return { content: [{ type: 'text', text: 'Add a small cat in the middle of the image. Keep everything else unchanged.' }], stop_reason: 'end_turn', model: params.model, usage: {} };
    },
  },
  beta: { messages: { create: async () => { throw new Error('không dùng vòng lặp chat trong file này'); } } },
};

let server, browser, page, pageErrors;

before(async () => {
  ({ server } = await startServer({ aiEditor: fakeEditor, anthropic: fakeAnthropic }));
  ({ browser, page, pageErrors } = await openApp(`http://127.0.0.1:${server.address().port}`, { deviceScaleFactor: process.env.E2E_SCREENSHOT ? 2 : 1 }));
});

after(async () => {
  await browser?.close();
  server?.close();
});

const MAGENTA = { r: 255, g: 0, b: 255, a: 255 };
const RED = { r: 255, g: 0, b: 0, a: 255 };

test('/api/health báo AI đã bật', async () => {
  const h = await (await fetch(`http://127.0.0.1:${server.address().port}/api/health`)).json();
  assert.equal(h.ai_edit.enabled, true);
});

test('sửa toàn ảnh: kết quả phủ đúng toàn bộ ảnh, nằm ở layer mới trên cùng', async () => {
  await freshDoc(page, { width: 600, height: 400, background: '#FF0000' });
  const r = json(await tool(page, 'ai_edit', { instruction: 'Make everything magenta' }));
  assert.equal(calls.at(-1).instruction, 'Make everything magenta');
  assert.deepEqual(calls.at(-1).size, { width: 600, height: 400 });
  assert.deepEqual(r.sent_area, { x: 0, y: 0, width: 600, height: 400 });
  assert.deepEqual(r.layers, ['AI: Make everything magenta']);
  const info = json(await tool(page, 'get_document_info'));
  assert.equal(info.layers[0].name, 'AI: Make everything magenta');
  assert.equal(info.layers.length, 2, 'ảnh gốc vẫn còn bên dưới');
  assert.equal(info.name, 'Thiết kế mới', 'giữ nguyên tên tài liệu');
  assert.deepEqual(info.open_documents, ['Thiết kế mới'], 'đã đóng tài liệu tạm');
  assert.deepEqual(await pixel(page, 10, 10), MAGENTA);
  assert.deepEqual(await pixel(page, 590, 390), MAGENTA);
});

test('sửa theo vùng: chỉ gửi vùng + ngữ cảnh, chỉ thay đúng vùng', async () => {
  await freshDoc(page, { width: 600, height: 400, background: '#FF0000' });
  const r = json(await tool(page, 'ai_edit', {
    instruction: 'Remove the object', region: { x: 200, y: 150, width: 100, height: 100 }, feather: 0,
  }));
  // lề ngữ cảnh 50% => vùng gửi đi 200x200 bắt đầu tại (150, 100)
  assert.deepEqual(calls.at(-1).size, { width: 200, height: 200 });
  assert.deepEqual(r.sent_area, { x: 150, y: 100, width: 200, height: 200 });
  assert.deepEqual(r.masked_to, { x: 200, y: 150, width: 100, height: 100 });
  assert.deepEqual(await pixel(page, 250, 200), MAGENTA, 'trong vùng: đã thay');
  assert.deepEqual(await pixel(page, 160, 110), RED, 'ngoài vùng nhưng trong ngữ cảnh: giữ nguyên');
  assert.deepEqual(await pixel(page, 10, 10), RED);
});

test('ảnh lớn được thu nhỏ tối đa 1536px trước khi gửi', async () => {
  await freshDoc(page, { width: 3072, height: 1024, background: '#FF0000' });
  json(await tool(page, 'ai_edit', { instruction: 'x' }));
  assert.deepEqual(calls.at(-1).size, { width: 1536, height: 512 });
  assert.deepEqual(await pixel(page, 3000, 1000), MAGENTA, 'kết quả vẫn phủ hết ảnh gốc');
});

test('dịch vụ AI lỗi: tool báo lỗi, tài liệu không bị đổi', async () => {
  await freshDoc(page, { width: 100, height: 100, background: '#FF0000' });
  mode = 'error';
  const r = await tool(page, 'ai_edit', { instruction: 'x' });
  mode = 'ok';
  assert.equal(r.isError, true);
  assert.match(r.content, /Lỗi chỉnh sửa AI/);
  const info = json(await tool(page, 'get_document_info'));
  assert.equal(info.layers.length, 1);
  assert.equal(info.name, 'Thiết kế mới');
});

test('Generative Fill theo vùng chọn hình elip của người dùng', async () => {
  await freshDoc(page, { width: 400, height: 300, background: '#FF0000' });
  json(await tool(page, 'select_area', { mode: 'ellipse', x: 100, y: 75, width: 200, height: 150 }));
  const before = calls.length;
  const r = json(await tool(page, 'ai_edit', { instruction: 'Add a cat in the middle', use_selection: true }));
  assert.equal(calls.length, before + 1);
  // bounds elip 200x150 + lề 100 mỗi phía, bị cắt theo mép ảnh => toàn ảnh 400x300
  assert.deepEqual(calls.at(-1).size, { width: 400, height: 300 });
  assert.equal(r.masked_to, 'selection');
  assert.deepEqual(await pixel(page, 200, 150), MAGENTA, 'tâm elip: đã thay');
  assert.deepEqual(await pixel(page, 105, 80), RED, 'góc hộp bao (ngoài elip): giữ nguyên => mask theo hình dạng vùng chọn');
  assert.deepEqual(await pixel(page, 10, 10), RED);
  const info = json(await tool(page, 'get_document_info'));
  assert.ok(info.selection && Math.abs(info.selection.x - 100) <= 1 && Math.abs(info.selection.width - 200) <= 2,
    `vùng chọn vẫn còn sau khi fill: ${JSON.stringify(info.selection)}`);
  assert.deepEqual(info.layers.map((l) => l.name), ['AI: Add a cat in the middle', 'Background'], 'không để lại layer tạm');
  json(await tool(page, 'select_area', { mode: 'none' }));
});

test('vùng chọn nhỏ: chỉ gửi vùng + ngữ cảnh', async () => {
  await freshDoc(page, { width: 1000, height: 800, background: '#FF0000' });
  json(await tool(page, 'select_area', { mode: 'rect', x: 400, y: 300, width: 100, height: 80 }));
  const r = json(await tool(page, 'ai_edit', { instruction: 'Remove it', use_selection: true }));
  assert.deepEqual(r.sent_area, { x: 350, y: 250, width: 200, height: 180 });
  assert.deepEqual(calls.at(-1).size, { width: 200, height: 180 });
  assert.deepEqual(await pixel(page, 450, 340), MAGENTA);
  assert.deepEqual(await pixel(page, 360, 260), RED);
  json(await tool(page, 'select_area', { mode: 'none' }));
});

test('3 phương án: 3 layer, chỉ phương án 1 hiện', async () => {
  await freshDoc(page, { width: 300, height: 200, background: '#FF0000' });
  json(await tool(page, 'select_area', { mode: 'rect', x: 100, y: 50, width: 100, height: 100 }));
  const before = calls.length;
  const r = json(await tool(page, 'ai_edit', { instruction: 'Add a flower', use_selection: true, variations: 3 }));
  assert.equal(calls.length, before + 3, 'gọi AI 3 lần');
  assert.deepEqual(r.layers, ['AI 1/3: Add a flower', 'AI 2/3: Add a flower', 'AI 3/3: Add a flower']);
  const info = json(await tool(page, 'get_document_info'));
  const visible = Object.fromEntries(info.layers.map((l) => [l.name, l.visible]));
  assert.deepEqual(visible, { 'AI 3/3: Add a flower': false, 'AI 2/3: Add a flower': false, 'AI 1/3: Add a flower': true, Background: true });
  assert.deepEqual(await pixel(page, 150, 100), MAGENTA);
  json(await tool(page, 'select_area', { mode: 'none' }));
});

test('use_selection khi không có vùng chọn: báo lỗi hướng dẫn, không gọi AI', async () => {
  await freshDoc(page, { width: 100, height: 100, background: '#FF0000' });
  const before = calls.length;
  const r = await tool(page, 'ai_edit', { instruction: 'x', use_selection: true });
  assert.equal(r.isError, true);
  assert.match(r.content, /Không có vùng chọn/);
  assert.equal(calls.length, before);
});

test('bấm vào ô chat khi đang có vùng chọn: hiện gợi ý Generative Fill', async () => {
  await freshDoc(page, { width: 400, height: 300, background: '#3070B0' });
  await page.evaluate(() => document.activeElement?.blur());
  await page.focus('#input');
  await page.waitForTimeout(200);
  assert.equal(await page.isVisible('#selection-hint'), false, 'không có vùng chọn: ẩn');
  json(await tool(page, 'select_area', { mode: 'ellipse', x: 120, y: 80, width: 160, height: 120 }));
  await page.evaluate(() => document.activeElement?.blur());
  await page.focus('#input');
  await page.waitForSelector('#selection-hint:not([hidden])', { timeout: 5000 });
  assert.match(await page.textContent('#selection-hint'), /vùng chọn 160×120 px.*xoá vật thể/);
  assert.equal(await page.locator('.msg').count(), 0, 'không gửi tin nhắn nào');
  if (process.env.E2E_SCREENSHOT) await page.screenshot({ path: process.env.E2E_SCREENSHOT, quality: 82 });
  json(await tool(page, 'select_area', { mode: 'none' }));
});

test('ô Generative Fill trực tiếp: dịch bằng model rẻ, 2 phương án, chuyển phương án', async () => {
  await freshDoc(page, { width: 400, height: 300, background: '#FF0000' });
  await page.click('#fill-panel summary');
  await page.waitForSelector('#fill-selection:has-text("Chưa có vùng chọn")');

  await page.click('#fill-run');
  await page.waitForSelector('#fill-status:has-text("khoanh vùng")');

  json(await tool(page, 'select_area', { mode: 'ellipse', x: 100, y: 75, width: 200, height: 150 }));
  await page.fill('#fill-prompt', 'thêm một con mèo nhỏ');
  await page.selectOption('#fill-variations', '2');
  const before = calls.length;
  await page.click('#fill-run');
  await page.waitForSelector('#fill-status:has-text("Xong")', { timeout: 30_000 });

  assert.equal(translations.length, 1);
  assert.equal(translations[0].messages[0].content, 'thêm một con mèo nhỏ');
  assert.equal(translations[0].model, 'claude-haiku-5-5');
  assert.equal(calls.length, before + 2, 'gọi AI tạo ảnh 2 lần');
  assert.match(calls.at(-1).instruction, /^Add a small cat/);
  assert.deepEqual(await page.locator('#fill-variants button').allTextContents(), ['Phương án 1', 'Phương án 2']);

  const visibility = async () => Object.fromEntries(json(await tool(page, 'get_document_info')).layers.map((l) => [l.name, l.visible]));
  let v = await visibility();
  assert.equal(v[Object.keys(v).find((n) => n.startsWith('AI 1/2'))], true, 'ban đầu phương án 1 hiện');
  await page.click('#fill-variants button:has-text("Phương án 2")');
  await page.waitForSelector('#fill-status:has-text("phương án 2")');
  v = await visibility();
  const names = Object.keys(v).filter((n) => n.startsWith('AI '));
  assert.equal(names.length, 2);
  assert.deepEqual(names.map((n) => v[n]).sort(), [false, true]);
  assert.equal(v[names.find((n) => n.startsWith('AI 2/2'))], true, 'phương án 2 đang hiện');
  assert.ok((await page.evaluate(() => window.bokin.state.pendingNotes.map((n) => n.key))).includes('fill'), 'ghi chú cho Claude');
});

test('ô Generative Fill: để trống = xoá vật thể, không gọi Claude', async () => {
  await freshDoc(page, { width: 400, height: 300, background: '#FF0000' });
  json(await tool(page, 'select_area', { mode: 'rect', x: 150, y: 100, width: 100, height: 100 }));
  await page.fill('#fill-prompt', '');
  await page.selectOption('#fill-variations', '1');
  const t0 = translations.length;
  await page.click('#fill-run');
  await page.waitForSelector('#fill-status:has-text("Xong")', { timeout: 30_000 });
  assert.equal(translations.length, t0, 'không dịch');
  assert.match(calls.at(-1).instruction, /^Remove the object in the middle/);
  assert.deepEqual(await pixel(page, 200, 150), MAGENTA);
  assert.deepEqual(await pixel(page, 20, 20), RED);
  assert.equal(await page.isVisible('#fill-variants'), false, '1 phương án: không hiện nút chuyển');
});

test('không có lỗi JavaScript trên trang', () => {
  assert.deepEqual(pageErrors, [], pageErrors.join('\n'));
});
