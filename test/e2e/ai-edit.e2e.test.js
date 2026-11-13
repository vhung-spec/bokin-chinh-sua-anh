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

let server, browser, page, pageErrors;

before(async () => {
  ({ server } = await startServer({ aiEditor: fakeEditor }));
  ({ browser, page, pageErrors } = await openApp(`http://127.0.0.1:${server.address().port}`));
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
  assert.deepEqual(r.bounds, { x: 0, y: 0, width: 600, height: 400 });
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

test('không có lỗi JavaScript trên trang', () => {
  assert.deepEqual(pageErrors, [], pageErrors.join('\n'));
});
