// Điều khiển bằng chat: lệnh ngắn Bokin làm ngay (không gọi Claude), thanh "Đã chỉnh", chọn vùng và hút màu ngay
// trong ô chat, nói thay gõ, ↑ gọi lại câu cũ, lệnh đã lưu, "làm giống ảnh trước". Claude là máy chủ giả lập.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { startServer, openApp, tool, json, pixel } from './helpers.js';

const requests = [];
const lastText = (body) => {
  const last = body.messages.at(-1);
  return Array.isArray(last.content) ? last.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : String(last.content);
};

const mock = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  if (body.max_tokens === 0) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'k', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: 'max_tokens', usage: { input_tokens: 0, output_tokens: 0 } }));
    return;
  }
  requests.push(body);
  const last = body.messages.at(-1);
  const hasToolResult = Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result');
  const text = lastText(body);
  const n = requests.length;
  let reply;
  if (hasToolResult) reply = { content: [{ type: 'text', text: 'Xong.' }], stop_reason: 'end_turn' };
  else if (/Đổi màu áo|Làm giống ảnh trước/.test(text)) {
    reply = {
      content: [
        { type: 'tool_use', id: `s${n}`, name: 'select_by_color', input: { method: 'color', color: '#C83232', tolerance: 30 } },
        { type: 'tool_use', id: `a${n}`, name: 'adjust_area', input: { name: 'Áo', target_color: '#1E3264' } },
      ],
      stop_reason: 'tool_use',
    };
  } else if (/Sáng cả ảnh/.test(text)) {
    reply = { content: [{ type: 'tool_use', id: `b${n}`, name: 'adjust_brightness_contrast', input: { brightness: 30 } }], stop_reason: 'tool_use' };
  } else reply = { content: [{ type: 'text', text: `Trả lời ${n}` }], stop_reason: 'end_turn' };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id: `m${n}`, type: 'message', role: 'assistant', model: body.model, ...reply, usage: { input_tokens: 10, output_tokens: 5 } }));
});

// Nhận giọng nói giả: bấm 🎤 là "nghe" được câu trong window.__voiceText (Chromium mới có cả tên không tiền tố).
const fakeSpeech = () => {
  window.SpeechRecognition = window.webkitSpeechRecognition = class {
    start() {
      setTimeout(() => {
        const said = window.__voiceText ?? '';
        this.onresult?.({ results: [[{ transcript: said.slice(0, 6) }]] });
        this.onresult?.({ results: [[{ transcript: said }]] });
        this.onend?.();
      }, 50);
    }
    stop() { this.onend?.(); }
    abort() {}
  };
};

let server, browser, page, pageErrors;

before(async () => {
  mock.listen(0, '127.0.0.1');
  await new Promise((r) => mock.once('listening', r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${mock.address().port}`;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  ({ server } = await startServer());
  ({ browser, page, pageErrors } = await openApp(`http://127.0.0.1:${server.address().port}`, {
    init: fakeSpeech,
    deviceScaleFactor: process.env.E2E_SCREENSHOT ? 2 : 1,
  }));
});

after(async () => {
  await browser?.close();
  server?.close();
  mock.close();
});

const RED = { r: 200, g: 50, b: 50, a: 255 };
const BLUE = { r: 50, g: 50, b: 200, a: 255 };
const info = async () => json(await tool(page, 'get_document_info'));
const idle = () => page.waitForFunction(() => !window.bokin.state.busy && !window.bokin.state.toolbarBusy);

/** PNG 200×100: nửa trái đỏ (áo), nửa phải xanh dương. */
function twoHalvesPng() {
  const W = 200, H = 100;
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    for (let x = 0; x < W; x++) raw.set(x < 100 ? [200, 50, 50] : [50, 50, 200], y * (W * 3 + 1) + 1 + x * 3);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function openPng(name) {
  await page.setInputFiles('#file-input', { name, mimeType: 'image/png', buffer: twoHalvesPng() });
  await page.waitForSelector(`.msg.info >> text=${name}`);
  await idle();
}

/** Gõ một câu rồi Enter; chờ câu mới hiện ra và Bokin làm xong (cả khi câu giống một câu đã gửi trước đó). */
async function say(text) {
  await idle();
  const count = await page.locator('.msg.user').count();
  await page.fill('#input', text);
  await page.press('#input', 'Enter');
  await page.waitForFunction(([t, n]) => {
    const all = document.querySelectorAll('.msg.user');
    return all.length > n && all[all.length - 1].firstChild?.textContent === t;
  }, [text, count]);
  await idle();
}

const strengthOf = async (name) => (await info()).area_edits?.find((e) => e.name === name)?.strength ?? 100;

test('lệnh ngắn làm ngay không gọi Claude: mạnh hơn, hoàn tác, bỏ chỉnh, tải ảnh, bỏ chọn', async () => {
  await page.click('#tab-chat');
  await openPng('ao-do.png');
  await say('Đổi màu áo đỏ thành xanh navy');
  const navy = await pixel(page, 50, 50);
  assert.ok(navy.b > navy.r, JSON.stringify(navy));
  assert.deepEqual(await page.locator('.followups button').allTextContents(), ['Mạnh hơn', 'Nhẹ hơn', 'Bỏ "Áo"', 'Hoàn tác', 'Tải JPG']);
  assert.equal(await page.locator('.followups button.local').count(), 5, 'mọi nút gợi ý đều làm ngay');

  const calls = requests.length;
  await say('mạnh hơn');
  assert.match(await page.locator('.msg.quick').last().textContent(), /Đã chỉnh "Áo" mạnh hơn: mức 140%/);
  assert.equal(await strengthOf('Áo'), 140);
  const stronger = await pixel(page, 50, 50);
  assert.ok(stronger.b !== navy.b || stronger.r !== navy.r, 'ảnh đổi');
  assert.deepEqual(await pixel(page, 150, 50), BLUE, 'ngoài vùng giữ nguyên');

  await say('nhe hon mot chut'); // gõ không dấu vẫn hiểu
  assert.equal(await strengthOf('Áo'), 110);
  await say('hoàn tác');
  assert.match(await page.locator('.msg.quick').last().textContent(), /Đã hoàn tác mức chỉnh "Áo" 110%/);
  assert.equal(await strengthOf('Áo'), 140, 'sau hoàn tác: Claude thấy đúng mức đang áp');
  await say('làm lại');
  if (await strengthOf('Áo') !== 110) console.log('DEBUG', JSON.stringify(await page.evaluate(async () => ({ info: await window.bokin.runner.historyInfo(), hist: window.bokin.runner.areaHistory.map((v) => [v.strength ?? 100, v.at]), redo: window.bokin.log.redoStack, undo: window.bokin.log.undoStack.map((e) => [e.label, e.before, e.after]), msgs: [...document.querySelectorAll('.msg.quick, .msg.error')].map((m) => m.textContent) }))));
  assert.equal(await strengthOf('Áo'), 110);

  await say('bỏ chỉnh áo');
  assert.deepEqual(await pixel(page, 50, 50), RED);
  assert.equal((await info()).area_edits, undefined);
  await say('hoàn tác');
  assert.equal(await strengthOf('Áo'), 110, 'hoàn tác lấy lại lần chỉnh');

  json(await tool(page, 'select_area', { mode: 'rect', x: 0, y: 0, width: 50, height: 50 }));
  await say('bỏ chọn');
  assert.equal((await info()).selection, null);

  const download = page.waitForEvent('download');
  await say('tải ảnh png');
  assert.match((await download).suggestedFilename(), /\.png$/);
  assert.equal(requests.length, calls, 'không lần nào gọi Claude');

  // Tin nhắn tiếp theo gửi Claude kèm ghi chú những gì Bokin đã tự làm, và mức đang áp.
  await say('Cảm ơn');
  const sent = JSON.stringify(requests.at(-1).messages.at(-1).content);
  assert.match(sent, /Bokin tự đổi mức lần chỉnh \\"Áo\\"/);
  assert.match(sent, /\\"strength\\":110/);
});

test('thanh "Đã chỉnh": kéo đổi mức, ẩn để so sánh, bỏ', async () => {
  const row = page.locator('#edits .edit-row[data-name="Áo"]');
  await row.waitFor();
  assert.equal(await row.locator('output').textContent(), '110%');
  const before = await pixel(page, 50, 50);
  await row.locator('input[type=range]').evaluate((el) => {
    el.value = '50';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(() => window.bokin.state.pendingNotes.some((n) => /giờ ở mức 50%/.test(n.text)));
  await idle();
  assert.equal(await strengthOf('Áo'), 50);
  const lighter = await pixel(page, 50, 50);
  assert.ok(lighter.r > before.r, `nửa đường về màu cũ: ${JSON.stringify({ before, lighter })}`);

  await row.locator('button.eye').click();
  await page.waitForSelector('#edits .edit-row.off');
  await idle();
  assert.deepEqual(await pixel(page, 50, 50), RED, 'ẩn lần chỉnh: thấy ảnh gốc');
  assert.equal((await info()).area_edits[0].hidden, true);
  await page.locator('#edits .edit-row button.eye').click();
  await page.waitForSelector('#edits .edit-row:not(.off)');
  await idle();

  await page.locator('#edits .edit-row button.x').click();
  await page.waitForSelector('#edits', { state: 'hidden' });
  assert.deepEqual(await pixel(page, 50, 50), RED);
});

test('"mạnh hơn" sau một chỉnh sửa không phải chỉnh vùng thì gửi Claude', async () => {
  await say('Đổi màu áo đỏ thành xanh navy');
  await say('Sáng cả ảnh lên');
  assert.deepEqual(await page.locator('.followups button.local').allTextContents(), ['Hoàn tác', 'Tải JPG']);
  const calls = requests.length;
  await say('mạnh hơn');
  assert.equal(requests.length, calls + 1, 'Claude nhận "mạnh hơn"');
  await say('áo mạnh hơn'); // nói rõ tên vùng: vẫn làm ngay
  assert.equal(requests.length, calls + 1);
  assert.equal(await strengthOf('Áo'), 140);
});

test('chọn vùng và hút màu ngay trong ô chat; dòng gợi ý cho biết màu vừa hút', async () => {
  // màu tiền cảnh lúc bấm Hút màu (chưa hút gì) không được báo là "màu vừa hút"
  await page.evaluate(() => window.bokin.bridge.exec("var c = new SolidColor(); c.rgb.hexValue = '000000'; app.foregroundColor = c;"));
  await page.click('#chat-region button[data-tool="eyedropperTool"]');
  await page.dispatchEvent('#photopea', 'mouseleave');
  await page.waitForTimeout(600);
  assert.doesNotMatch(await page.textContent('#selection-hint'), /Màu vừa hút/);
  await page.waitForSelector('#chat-region-info:has-text("Bấm vào một màu")');
  await page.evaluate(() => window.bokin.bridge.exec("var c = new SolidColor(); c.rgb.hexValue = '3232C8'; app.foregroundColor = c;"));
  await page.dispatchEvent('#photopea', 'mouseleave');
  await page.waitForSelector('#selection-hint:has-text("Màu vừa hút #3232C8")');
  assert.equal(await page.isHidden('#chat-region-info'), true);
  await say('Màu này là màu gì?');
  assert.match(JSON.stringify(requests.at(-1).messages.at(-1).content), /picked_color\\":\\"#3232C8/);

  await page.click('#chat-region button[data-paint]');
  await page.waitForFunction(() => window.bokin.runner.painting);
  assert.match(await page.textContent('#chat-region button[data-paint]'), /Xong tô/);
  await page.click('#chat-region button[data-paint]');
  await page.waitForFunction(() => !window.bokin.runner.painting);
});

test('nói thay gõ, ↑ gọi lại câu đã gửi, lệnh đã lưu, phím /', async () => {
  await page.evaluate(() => { window.__voiceText = 'làm áo sáng hơn'; });
  await page.click('#mic-btn');
  await page.waitForFunction(() => document.querySelector('#input').value === 'làm áo sáng hơn');
  await page.waitForSelector('#mic-btn:has-text("🎤")');
  await page.fill('#input', '');

  await page.focus('#input');
  await page.keyboard.press('ArrowUp');
  assert.equal(await page.inputValue('#input'), 'Màu này là màu gì?');
  await page.keyboard.press('ArrowUp');
  assert.equal(await page.inputValue('#input'), 'áo mạnh hơn');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.inputValue('#input'), '', 'xuống hết: về câu đang gõ');

  const star = page.locator('.msg.user', { hasText: 'Sáng cả ảnh lên' }).last().locator('button.save');
  await star.click({ force: true });
  assert.equal(await star.textContent(), '★');
  await page.click('#saved-btn');
  await page.waitForSelector('#saved-menu .saved-use:has-text("Sáng cả ảnh lên")');
  const calls = requests.length;
  const replies = await page.locator('.msg.assistant').count();
  await page.click('#saved-menu .saved-use');
  await page.waitForFunction((n) => document.querySelectorAll('.msg.assistant').length > n && !window.bokin.state.busy, replies);
  await idle();
  assert.equal(requests.length, calls + 2, 'lệnh đã lưu được gửi (một lần chỉnh, một câu trả lời)');
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('bokin.saved'))), ['Sáng cả ảnh lên']);

  await page.evaluate(() => document.activeElement?.blur());
  await page.click('#tab-color');
  await page.keyboard.press('/');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'input');
  assert.equal(await page.getAttribute('#tab-chat', 'aria-selected'), 'true');
});

test('làm giống ảnh trước: Claude nhận các bước của ảnh trước (trừ bước đã hoàn tác) và làm lại trên ảnh mới', async () => {
  await openPng('anh-1.png');
  await say('Đổi màu áo đỏ thành xanh navy');
  await say('Sáng cả ảnh lên');
  await say('hoàn tác'); // bước này không vào công thức
  await say('áo mạnh hơn');
  assert.equal(await strengthOf('Áo'), 140);

  await openPng('anh-2.png');
  const again = page.locator('.followups.again button');
  assert.match(await again.textContent(), /Làm giống ảnh trước \(2 thao tác\)/);
  assert.equal(await page.isVisible('#empty'), true, 'vẫn thấy các gợi ý');
  const start = requests.length;
  await again.click();
  await page.waitForFunction((n) => !window.bokin.state.busy && document.querySelectorAll('.msg.assistant').length > 0, start);
  await idle();
  const first = JSON.stringify(requests[start].messages.at(-1).content);
  assert.match(first, /các bước đã làm với ảnh trước \\"anh-1.png\\"/);
  assert.match(first, /Đổi màu áo đỏ thành xanh navy\\": select_by_color/);
  assert.match(first, /adjust_area \{\\"name\\":\\"Áo\\",\\"strength\\":140/);
  assert.doesNotMatch(first, /adjust_brightness_contrast/, 'bước đã hoàn tác không gửi');
  const navy = await pixel(page, 50, 50);
  assert.ok(navy.b > navy.r, `ảnh mới cũng đổi màu: ${JSON.stringify(navy)}`);

  if (process.env.E2E_SCREENSHOT) {
    await say('mạnh hơn');
    await page.screenshot({ path: process.env.E2E_SCREENSHOT });
  }
});

test('không có lỗi JavaScript trên trang', () => {
  assert.deepEqual(pageErrors, [], pageErrors.join('\n'));
});
