// Kiểm thử toàn bộ vòng lặp: giao diện chat -> server -> "Claude API" (giả lập) -> tool chạy trong Photopea
// -> tool_result gửi lên lại -> câu trả lời cuối hiển thị. Không cần API key thật.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer, openApp, tool, json, pixel, solidPng } from './helpers.js';

const requests = [];
let failNext = null; // { status, body } để giả lập lỗi
let scenario = 'design'; // 'design' (tạo ảnh + chữ) | 'color' (một lần chỉnh màu)

const mock = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  requests.push({ url: req.url, headers: req.headers, body });
  if (body.max_tokens === 0) {
    // Yêu cầu giữ cache ấm: không sinh output, chỉ đọc cache
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'keepalive', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: 'max_tokens', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 12000 } }));
    return;
  }
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
  const lastText = Array.isArray(lastUser.content) ? lastUser.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : String(lastUser.content);
  if (scenario === 'area') {
    if (hasToolResult) reply = { content: [{ type: 'text', text: 'Đã đổi màu áo.' }], stop_reason: 'end_turn' };
    else if (lastText.includes('Đậm hơn chút')) {
      reply = { content: [{ type: 'tool_use', id: `tu_x${requests.length}`, name: 'adjust_area', input: { name: 'Áo', target_color: '#1E3264', brightness: -25 } }], stop_reason: 'tool_use' };
    } else {
      reply = {
        content: [
          { type: 'tool_use', id: `tu_s${requests.length}`, name: 'select_by_color', input: { method: 'color', color: '#C83232', tolerance: 30 } },
          { type: 'tool_use', id: `tu_a${requests.length}`, name: 'adjust_area', input: { name: 'Áo', target_color: '#1E3264' } },
        ],
        stop_reason: 'tool_use',
      };
    }
  } else if (scenario === 'match') {
    reply = hasToolResult
      ? { content: [{ type: 'text', text: 'Đã chỉnh màu vùng chọn giống ảnh mẫu.' }], stop_reason: 'end_turn' }
      : { content: [{ type: 'tool_use', id: `tu_m${requests.length}`, name: 'match_reference_colors', input: { strength: 100 } }], stop_reason: 'tool_use' };
  } else if (scenario === 'two-edits') {
    reply = hasToolResult
      ? { content: [{ type: 'text', text: 'Đã chỉnh sáng và màu.' }], stop_reason: 'end_turn' }
      : {
        content: [
          { type: 'tool_use', id: `tu_a${requests.length}`, name: 'adjust_brightness_contrast', input: { brightness: 40 } },
          { type: 'tool_use', id: `tu_b${requests.length}`, name: 'adjust_hue_saturation', input: { saturation: -60 } },
        ],
        stop_reason: 'tool_use',
      };
  } else if (scenario === 'text') {
    reply = { content: [{ type: 'text', text: `Trả lời ${requests.length}` }], stop_reason: 'end_turn' };
  } else if (scenario === 'color') {
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
    await page.screenshot({ path: process.env.E2E_SCREENSHOT, quality: 82 });
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

test('giữ cache ấm khi tạm dừng: gửi lại đúng yêu cầu trước với max_tokens 0, tối đa N lần, dừng khi trò chuyện mới', async () => {
  scenario = 'color';
  await page.evaluate(() => Object.assign(window.bokin.state, { keepAliveMs: 400, keepAliveMax: 2 }));
  const replies = await page.locator('.msg.assistant').count();
  await page.fill('#input', 'Cân bằng lại màu');
  await page.press('#input', 'Enter');
  // Chờ câu trả lời MỚI (câu trả lời giống hệt của tình huống trước vẫn còn trên màn hình)
  await page.waitForFunction((n) => document.querySelectorAll('.msg.assistant').length > n && !window.bokin.state.busy, replies, { timeout: 60_000 });
  const lastReal = requests.filter((r) => r.body.max_tokens !== 0).at(-1);
  const before = requests.length;
  await page.waitForTimeout(1800);
  const keepalives = requests.slice(before).filter((r) => r.body.max_tokens === 0);
  assert.equal(keepalives.length, 2, 'đúng số lần tối đa');
  for (const k of keepalives) {
    assert.deepEqual(k.body.messages, lastReal.body.messages, 'gửi lại đúng yêu cầu trước');
    assert.deepEqual({ ...k.body, max_tokens: lastReal.body.max_tokens }, lastReal.body, 'tham số khác giống hệt => trúng cache');
  }
  const kinds = await page.evaluate(() => window.bokin.state.usage.filter((u) => u.kind === 'keepalive').length);
  assert.equal(kinds, 2, 'ghi nhận chi phí giữ cache');

  // Gửi tin nhắn mới rồi bấm "Trò chuyện mới": không còn giữ cache cho cuộc cũ
  await page.fill('#input', 'Cân bằng thêm');
  await page.press('#input', 'Enter');
  await page.waitForFunction(() => !window.bokin.state.busy);
  await page.click('#new-chat-btn');
  const after = requests.length;
  await page.waitForTimeout(1200);
  assert.equal(requests.slice(after).filter((r) => r.body.max_tokens === 0).length, 0);
  await page.evaluate(() => Object.assign(window.bokin.state, { keepAliveMs: 240_000, keepAliveMax: 5 }));
  scenario = 'design';
});

test('không gửi lại ảnh nếu ảnh không đổi; gửi lại khi ảnh thay đổi (kể cả chỉnh tay)', async () => {
  await page.click('#new-chat-btn');
  scenario = 'text';
  json(await tool(page, 'create_document', { width: 200, height: 120, background: '#406080' }));
  const ask = async (text) => {
    const n = requests.length;
    await page.fill('#input', text);
    await page.press('#input', 'Enter');
    await page.waitForFunction(() => !window.bokin.state.busy);
    return requests.slice(n).find((r) => r.body.max_tokens !== 0).body.messages.at(-1).content;
  };
  const hasImage = (content) => content.some((b) => b.type === 'image');

  let c = await ask('Ảnh này thế nào?');
  assert.ok(hasImage(c), 'lần đầu: gửi ảnh');
  c = await ask('Còn gì nữa không?');
  assert.ok(!hasImage(c), 'ảnh không đổi: không gửi lại');
  assert.ok(c.some((b) => b.type === 'text' && /Ảnh không đổi/.test(b.text)));

  json(await tool(page, 'adjust_brightness_contrast', { brightness: 40 })); // như người dùng tự chỉnh trong Photopea
  c = await ask('Giờ thì sao?');
  assert.ok(hasImage(c), 'ảnh đã đổi: gửi ảnh mới');

  json(await tool(page, 'undo')); // hoàn tác cũng làm ảnh đổi (dù lịch sử không dài thêm)
  c = await ask('Còn bây giờ?');
  assert.ok(hasImage(c), 'sau hoàn tác: gửi ảnh mới');

  await page.click('#new-chat-btn');
  c = await ask('Cuộc trò chuyện mới');
  assert.ok(hasImage(c), 'trò chuyện mới: Claude chưa thấy ảnh nên phải gửi');
  scenario = 'design';
});

test('mở ảnh khác: tự bắt đầu cuộc trò chuyện mới, không gửi lại lịch sử ảnh cũ', async () => {
  scenario = 'text';
  await page.click('#new-chat-btn');
  json(await tool(page, 'create_document', { width: 100, height: 80, background: '#204060' }));
  await page.fill('#input', 'Ảnh thứ nhất');
  await page.press('#input', 'Enter');
  await page.waitForFunction(() => !window.bokin.state.busy && window.bokin.state.messages.length >= 2);

  const png = (await import('./helpers.js')).solidPng(64, 48, [200, 120, 40]);
  await page.setInputFiles('#file-input', { name: 'anh-moi.png', mimeType: 'image/png', buffer: png });
  await page.waitForSelector('.msg.info >> text=Bắt đầu cuộc trò chuyện mới');
  assert.equal(await page.evaluate(() => window.bokin.state.messages.length), 0, 'đã xoá lịch sử');
  assert.equal(await page.locator('.msg.user').count(), 0, 'giao diện cũng được làm mới');

  const n = requests.length;
  await page.fill('#input', 'Ảnh thứ hai');
  await page.press('#input', 'Enter');
  await page.waitForFunction(() => !window.bokin.state.busy);
  const sent = requests.slice(n).find((r) => r.body.max_tokens !== 0).body.messages;
  assert.equal(sent.length, 1, 'chỉ gửi tin nhắn mới');
  assert.ok(sent[0].content.some((b) => b.type === 'text' && b.text.includes('anh-moi.png')), 'kèm ghi chú vừa mở ảnh');
  assert.ok(sent[0].content.some((b) => b.type === 'image'), 'kèm ảnh mới');
  scenario = 'design';
});

test('hiện chi phí từng yêu cầu và cả cuộc trò chuyện; vượt giới hạn thì tạm dừng hỏi tiếp tục', async () => {
  scenario = 'color';
  await page.click('#new-chat-btn');
  json(await tool(page, 'create_document', { width: 120, height: 80, background: '#C8B060' }));
  await page.fill('#input', 'Cân bằng màu');
  await page.press('#input', 'Enter');
  await page.waitForSelector('.msg.meta');
  assert.match(await page.textContent('.msg.meta'), /^2 lượt gọi · ~0,\d+ USD$/);
  assert.match(await page.textContent('#cost-total'), /Cuộc trò chuyện này: ~0,\d+ USD/);

  // Giới hạn rất nhỏ: dừng sau lượt đầu, bấm "Tiếp tục" thì làm nốt
  await page.click('#new-chat-btn');
  assert.equal(await page.textContent('#cost-total'), '', 'trò chuyện mới: tổng về 0');
  await page.evaluate(() => { window.bokin.state.budget = 0.00001; });
  const n = requests.length;
  await page.fill('#input', 'Cân bằng màu lần nữa');
  await page.press('#input', 'Enter');
  await page.waitForSelector('.msg.error >> text=Đã tạm dừng');
  assert.equal(requests.slice(n).filter((r) => r.body.max_tokens !== 0).length, 1, 'chỉ 1 lượt rồi dừng');
  await page.click('.msg.error button:has-text("Tiếp tục")');
  await page.waitForSelector('.msg.assistant >> text=Đã cân bằng lại màu');
  assert.equal(requests.slice(n).filter((r) => r.body.max_tokens !== 0).length, 2, 'tiếp tục đúng từ chỗ dừng');
  await page.evaluate(() => { window.bokin.state.budget = 0.5; });
  scenario = 'design';
});

test('sau câu trả lời có chỉnh sửa: nút gợi ý; "Hoàn tác" gỡ MỌI chỉnh sửa của yêu cầu trong một lần bấm', async () => {
  scenario = 'two-edits';
  await page.click('#new-chat-btn');
  json(await tool(page, 'create_document', { width: 120, height: 80, background: '#C86432' }));
  const original = await page.evaluate(() => window.bokin.executeTool('get_document_info', {}));
  const px = () => page.evaluate(async () => {
    const e = await window.bokin.bridge.exportDocument('png');
    const bmp = await createImageBitmap(new Blob([e.buffer]));
    const c = new OffscreenCanvas(bmp.width, bmp.height); const x = c.getContext('2d'); x.drawImage(bmp, 0, 0);
    return [...x.getImageData(5, 5, 1, 1).data];
  });
  const before = await px();
  await page.fill('#input', 'Sáng hơn và bớt màu');
  await page.press('#input', 'Enter');
  await page.waitForSelector('.followups');
  assert.deepEqual(await page.locator('.followups button').allTextContents(), ['Mạnh hơn', 'Nhẹ hơn', 'Hoàn tác', 'Tải JPG']);
  assert.notDeepEqual(await px(), before);

  await page.click('.followups button:has-text("Hoàn tác")');
  await page.waitForFunction(() => !window.bokin.state.toolbarBusy);
  assert.deepEqual(await px(), before, 'cả 2 chỉnh sửa được gỡ trong một lần bấm');
  assert.match(await page.textContent('#toast'), /Đã hoàn tác yêu cầu "Sáng hơn và bớt màu"/);
  const notes = await page.evaluate(() => window.bokin.state.pendingNotes.map((n) => n.text).join(' '));
  assert.match(notes, /Hoàn tác/, 'báo cho Claude biết');

  // Phím tắt Ctrl+Y (ngoài ô nhập) = làm lại
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Control+y');
  await page.waitForFunction(() => !window.bokin.state.toolbarBusy);
  assert.notDeepEqual(await px(), before);
  assert.ok(original);
  scenario = 'design';
});

test('ảnh mẫu đính kèm ở ô chat: Claude nhận ảnh mẫu (một lần) và chỉnh màu vùng chọn giống ảnh đó', async () => {
  scenario = 'match';
  await page.click('#new-chat-btn');
  json(await tool(page, 'create_document', { width: 200, height: 100, background: '#C83232' }));
  json(await tool(page, 'select_area', { mode: 'rect', x: 0, y: 0, width: 100, height: 100 }));
  await page.setInputFiles('#match-file', { name: 'mau-la.png', mimeType: 'image/png', buffer: solidPng(40, 30, [40, 160, 70]) });
  await page.waitForSelector('#ref-chip:not([hidden])');
  assert.match(await page.textContent('#ref-chip'), /Ảnh mẫu: mau-la\.png/);

  const start = requests.length;
  await page.fill('#input', 'Chỉnh màu vùng này giống ảnh mẫu');
  await page.press('#input', 'Enter');
  await page.waitForSelector('.followups');
  const first = requests[start].body.messages.at(-1).content;
  const noteAt = first.findIndex((b) => b.type === 'text' && b.text.includes('ảnh mẫu "mau-la.png"'));
  assert.ok(noteAt >= 0, 'có ghi chú ảnh mẫu');
  assert.equal(first[noteAt + 1].type, 'image', 'kèm ảnh mẫu thu nhỏ');
  assert.match(first[0].text, /"reference_image":\{"name":"mau-la\.png"/, 'thông tin ảnh có reference_image');
  const left = await pixel(page, 50, 50);
  assert.ok(left.g > 120 && left.r < 90, `vùng chọn đã thành xanh lá: ${JSON.stringify(left)}`);
  assert.deepEqual(await pixel(page, 150, 50), { r: 200, g: 50, b: 50, a: 255 }, 'ngoài vùng chọn giữ nguyên');

  // Tin nhắn sau trong cùng cuộc trò chuyện: không gửi lại ảnh mẫu
  const second = requests.length;
  scenario = 'text';
  await page.fill('#input', 'Cảm ơn');
  await page.press('#input', 'Enter');
  await page.waitForFunction((n) => document.querySelectorAll('.msg.assistant').length >= n, 2);
  const again = requests[second].body.messages.at(-1).content;
  assert.ok(!again.some((b) => b.type === 'text' && b.text.includes('đã chọn ảnh mẫu')), 'không gửi lại ghi chú ảnh mẫu');
  await page.click('#ref-chip-clear');
  assert.equal(await page.isHidden('#ref-chip'), true);
  scenario = 'design';
});

test('chỉnh vùng bằng chat: đổi màu áo, rồi "đậm hơn chút" sửa lại đúng lớp đó (không chồng thêm)', async () => {
  scenario = 'area';
  await page.click('#new-chat-btn');
  json(await tool(page, 'create_document', { width: 200, height: 100, background: '#3232C8' }));
  json(await tool(page, 'select_area', { mode: 'rect', x: 0, y: 0, width: 100, height: 100 }));
  json(await tool(page, 'edit_selection', { action: 'fill', color: '#C83232' }));
  json(await tool(page, 'select_area', { mode: 'none' }));
  await page.fill('#input', 'Đổi màu áo đỏ thành xanh navy');
  await page.press('#input', 'Enter');
  await page.waitForSelector('.followups');
  const first = await pixel(page, 50, 50);
  assert.ok(first.b > first.r, `áo đã thành xanh: ${JSON.stringify(first)}`);
  assert.deepEqual(await pixel(page, 150, 50), { r: 50, g: 50, b: 200, a: 255 }, 'phần xanh dương ngoài vùng giữ nguyên');

  const start = requests.length;
  await page.fill('#input', 'Đậm hơn chút');
  await page.press('#input', 'Enter');
  await page.waitForFunction(() => document.querySelectorAll('.msg.assistant').length >= 2 && !window.bokin.state.busy);
  const snap = requests.slice(start).map((r) => JSON.stringify(r.body.messages.at(-1).content)).find((t) => t.includes('Đậm hơn chút'));
  assert.match(snap, /area_edits/, 'Claude thấy các lần chỉnh vùng đang có');
  const doc = json(await tool(page, 'get_document_info'));
  assert.deepEqual(doc.layers.map((l) => l.name), ['Chỉnh: Áo', 'Background'], 'vẫn một lớp');
  assert.equal(doc.area_edits[0].brightness, -25);
  const darker = await pixel(page, 50, 50);
  assert.ok(darker.b < first.b, `đậm hơn: ${JSON.stringify({ first, darker })}`);
  scenario = 'design';
});

test('không có lỗi JavaScript trên trang', () => {
  assert.deepEqual(pageErrors, [], pageErrors.join('\n'));
});
