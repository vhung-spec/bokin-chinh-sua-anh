// Kiểm thử toàn bộ vòng lặp: giao diện chat -> server -> "Claude API" (giả lập) -> tool chạy trong Photopea
// -> tool_result gửi lên lại -> câu trả lời cuối hiển thị. Không cần API key thật.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer, openApp, tool, json } from './helpers.js';

const requests = [];
let failNext = null; // { status, body } để giả lập lỗi
let scenario = 'design'; // 'design' (tạo ảnh + chữ) | 'color' (một lần chỉnh màu)

const mock = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  requests.push({ url: req.url, headers: req.headers, body });
  if (failNext) {
    const f = failNext;
    failNext = null;
    res.writeHead(f.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(f.body));
    return;
  }
  // Kịch bản: lượt 1 tạo ảnh, lượt 2 gọi song song thêm chữ + xem ảnh, lượt 3 trả lời.
  const lastUser = body.messages.at(-1);
  const hasToolResult = Array.isArray(lastUser.content) && lastUser.content.some((b) => b.type === 'tool_result');
  const ids = new Set(body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).map((b) => b.tool_use_id).filter(Boolean));
  let reply;
  if (scenario === 'color') {
    reply = hasToolResult
      ? { content: [{ type: 'text', text: 'Đã cân bằng lại màu.' }], stop_reason: 'end_turn' }
      : { content: [{ type: 'tool_use', id: `tu_c${requests.length}`, name: 'adjust_color_balance', input: { midtones: [0, 0, 25] } }], stop_reason: 'tool_use' };
  } else if (!hasToolResult) {
    reply = {
      content: [
        { type: 'thinking', thinking: '', signature: 'sig-1' },
        { type: 'text', text: 'Mình sẽ tạo ảnh nền xanh.' },
        { type: 'tool_use', id: 'tu_1', name: 'create_document', input: { width: 320, height: 200, background: '#336699' } },
      ],
      stop_reason: 'tool_use',
    };
  } else if (!ids.has('tu_2')) {
    reply = {
      content: [
        { type: 'tool_use', id: 'tu_2', name: 'add_text', input: { text: 'Xin chào', x: 20, y: 100, size: 40, color: '#FFFFFF', layer_name: 'Lời chào' } },
        { type: 'tool_use', id: 'tu_3', name: 'view_image', input: {} },
      ],
      stop_reason: 'tool_use',
    };
  } else {
    reply = { content: [{ type: 'text', text: 'Xong rồi! Ảnh **320x200** đã có chữ:\n- Nền xanh\n- Chữ trắng' }], stop_reason: 'end_turn' };
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: body.model,
    ...reply, stop_details: null, usage: { input_tokens: 10, output_tokens: 5 },
  }));
});

let server, browser, page, pageErrors;

before(async () => {
  mock.listen(0, '127.0.0.1');
  await new Promise((r) => mock.once('listening', r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${mock.address().port}`;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  ({ server } = await startServer());
  ({ browser, page, pageErrors } = await openApp(`http://127.0.0.1:${server.address().port}`, {
    // Ảnh chụp màn hình (nếu bật E2E_SCREENSHOT) để người xem: độ phân giải 2x.
    deviceScaleFactor: process.env.E2E_SCREENSHOT ? 2 : 1,
  }));
});

after(async () => {
  await browser?.close();
  server?.close();
  mock.close();
});

test('một yêu cầu chạy trọn vòng lặp tool và hiển thị câu trả lời', async () => {
  await page.fill('#input', 'Tạo ảnh bìa xanh có chữ Xin chào');
  await page.press('#input', 'Enter');
  await page.waitForSelector('.msg.assistant >> text=Xong rồi', { timeout: 60_000 });

  assert.equal(requests.length, 3);
  const first = requests[0];
  assert.match(first.url, /\/v1\/messages/);
  assert.match(first.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  // SDK mới gửi key qua Authorization: Bearer; SDK cũ dùng x-api-key.
  assert.equal(first.headers['x-api-key'] ?? first.headers.authorization?.replace(/^Bearer /, ''), 'test-key');
  assert.equal(first.body.model, 'claude-opus-5-5');
  assert.equal(first.body.fallbacks, 'default');
  assert.ok(first.body.tools.length >= 20);
  assert.equal(first.body.messages[0].content.at(-1).text, 'Tạo ảnh bìa xanh có chữ Xin chào');

  // Lượt 2: lịch sử giữ nguyên khối thinking, kèm tool_result của tu_1.
  const second = requests[1].body.messages;
  assert.equal(second[1].role, 'assistant');
  assert.deepEqual(second[1].content[0], { type: 'thinking', thinking: '', signature: 'sig-1' });
  assert.equal(second[2].content[0].tool_use_id, 'tu_1');
  assert.equal(second[2].content[0].is_error, undefined);

  // Lượt 3: hai tool gọi song song -> hai tool_result trong CÙNG một message; view_image kèm ảnh.
  const results = requests[2].body.messages.at(-1).content;
  assert.deepEqual(results.map((r) => r.tool_use_id), ['tu_2', 'tu_3']);
  assert.equal(JSON.parse(results[0].content).layer, 'Lời chào');
  assert.equal(results[1].content[1].type, 'image');
  assert.equal(results[1].content[1].source.media_type, 'image/jpeg');

  // Giao diện
  assert.equal(await page.locator('.step.ok').count(), 3);
  assert.equal(await page.locator('.msg.assistant strong').first().textContent(), '320x200');
  assert.equal(await page.locator('.msg.assistant li').count(), 2);
  assert.equal(await page.locator('.step img').count(), 1, 'hiển thị ảnh Claude vừa xem');
  assert.equal(await page.isEnabled('#send-btn'), true);

  // Photopea thật sự có kết quả
  const doc = json(await tool(page, 'get_document_info'));
  assert.equal(doc.width, 320);
  assert.equal(doc.layers[0].name, 'Lời chào');

  if (process.env.E2E_SCREENSHOT) {
    await page.click('#color-panel summary'); // cho thấy bảng Màu nhanh trong ảnh chụp
    await page.screenshot({ path: process.env.E2E_SCREENSHOT, quality: 82 });
    await page.click('#color-panel summary');
  }
});

test('lỗi API (sai key) hiển thị thông báo tiếng Việt và nút thử lại', async () => {
  failNext = { status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } };
  await page.fill('#input', 'Làm sáng ảnh');
  await page.press('#input', 'Enter');
  const error = page.locator('.msg.error');
  await error.waitFor({ timeout: 30_000 });
  assert.match(await error.textContent(), /API key không hợp lệ/);
  // Bấm "Thử lại" -> gửi lại cùng lịch sử, lần này thành công.
  await error.locator('button', { hasText: 'Thử lại' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.msg.assistant').length >= 3, null, { timeout: 60_000 });
  assert.equal(await page.locator('.msg.error').count(), 0);
});

test('nút "Trò chuyện mới" xoá lịch sử', async () => {
  await page.click('#new-chat-btn');
  assert.equal(await page.evaluate(() => window.bokin.state.messages.length), 0);
  assert.equal(await page.isVisible('#empty'), true);
});

test('chỉnh màu chỉ mất 2 lượt gọi: tin nhắn kèm sẵn trạng thái ảnh, kết quả kèm ảnh sau khi chỉnh', async () => {
  scenario = 'color';
  json(await tool(page, 'create_document', { width: 300, height: 200, background: '#C8B060' }));
  const start = requests.length;
  await page.fill('#input', 'Ảnh bị ám vàng, cân bằng lại màu');
  await page.press('#input', 'Enter');
  await page.waitForSelector('.msg.assistant >> text=Đã cân bằng lại màu', { timeout: 60_000 });
  assert.equal(requests.length - start, 2, 'chỉ 2 lượt gọi Claude');

  // Lượt 1: tin nhắn người dùng mở đầu bằng trạng thái tự động (thông tin + ảnh), câu lệnh ở cuối
  const userMsg = requests[start].body.messages.at(-1).content;
  assert.match(userMsg[0].text, /Trạng thái tự động/);
  assert.match(userMsg[0].text, /"width":300/);
  const snapshotImage = userMsg.find((b) => b.type === 'image');
  assert.ok(snapshotImage, 'kèm ảnh xem trước');
  assert.equal(userMsg.at(-1).text, 'Ảnh bị ám vàng, cân bằng lại màu');

  // Lượt 2: tool_result của lần chỉnh màu có kèm ảnh "sau khi chỉnh"
  const result = requests[start + 1].body.messages.at(-1).content[0];
  assert.equal(result.type, 'tool_result');
  assert.ok(Array.isArray(result.content));
  assert.ok(result.content.some((b) => b.type === 'text' && /Ảnh sau khi chỉnh/.test(b.text)));
  assert.ok(result.content.some((b) => b.type === 'image'));
  assert.notEqual(result.content.find((b) => b.type === 'image').source.data, snapshotImage.source.data, 'ảnh sau khác ảnh trước');
  // Ảnh xem trước mặc định 768px
  assert.match(userMsg.find((b) => b.type === 'text' && /Ảnh xem trước/.test(b.text)).text, /300x200/);
  scenario = 'design';
});

test('không có lỗi JavaScript trên trang', () => {
  assert.deepEqual(pageErrors, [], pageErrors.join('\n'));
});
