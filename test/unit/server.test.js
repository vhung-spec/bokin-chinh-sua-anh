import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, prepareForEcho, checkMessages, runTurn, describeError, config, hasAnthropicCredentials } from '../../server/chat.js';
import { createApp } from '../../server/app.js';
import Anthropic from '@anthropic-ai/sdk';
import { InferenceClientProviderApiError } from '@huggingface/inference';
import { checkAiEditBody, describeAiError } from '../../server/ai-edit.js';

const userMsg = [{ role: 'user', content: 'Làm sáng ảnh' }];

test('buildRequest: model, tools, system, effort, cache và fallback', () => {
  const req = buildRequest(userMsg);
  assert.equal(req.model, config.model);
  assert.equal(req.max_tokens, 16000);
  // Điểm cache tường minh ở cuối system (tools + system được cache chung) + cache tự động cho phần hội thoại
  assert.equal(req.system.length, 1);
  assert.ok(req.system[0].text.includes('Photopea'));
  assert.deepEqual(req.system[0].cache_control, { type: 'ephemeral' });
  assert.ok(req.tools.length >= 20);
  assert.deepEqual(req.output_config, { effort: config.effort });
  assert.deepEqual(req.cache_control, { type: 'ephemeral' });
  assert.deepEqual(req.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(req.fallbacks, 'default');
  assert.equal(req.thinking, undefined, 'Opus 5.5 tự bật adaptive thinking; không gửi cấu hình thinking');
  assert.equal(req.tool_choice, undefined);
});

test('prepareForEcho bỏ thinking/tool_use trước khối fallback cuối cùng', () => {
  const content = [
    { type: 'thinking', thinking: '' },
    { type: 'tool_use', id: 'a', name: 'x', input: {} },
    { type: 'text', text: 'trước' },
    { type: 'fallback', from: { model: 'm1' }, to: { model: 'm2' } },
    { type: 'thinking', thinking: '' },
    { type: 'tool_use', id: 'b', name: 'y', input: {} },
  ];
  assert.deepEqual(prepareForEcho(content).map((b) => b.type), ['text', 'fallback', 'thinking', 'tool_use']);
  const plain = [{ type: 'text', text: 'hi' }];
  assert.equal(prepareForEcho(plain), plain);
});

test('checkMessages', () => {
  assert.equal(checkMessages(userMsg), null);
  assert.ok(checkMessages([]));
  assert.ok(checkMessages('x'));
  assert.ok(checkMessages([{ role: 'assistant', content: 'a' }]));
  assert.ok(checkMessages([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]));
  assert.ok(checkMessages([{ role: 'system', content: 'a' }]));
});

test('runTurn gọi beta.messages.create và trả dữ liệu gọn', async () => {
  let seen;
  const fake = {
    beta: {
      messages: {
        create: async (params) => {
          seen = params;
          return { content: [{ type: 'text', text: 'Xong' }], stop_reason: 'end_turn', model: 'claude-opus-5-5', usage: { input_tokens: 1 } };
        },
      },
    },
  };
  const out = await runTurn(userMsg, fake);
  assert.equal(seen.messages, userMsg);
  assert.deepEqual(out.content, [{ type: 'text', text: 'Xong' }]);
  assert.equal(out.stop_reason, 'end_turn');
  assert.equal(out.stop_details, null);
});

test('describeError trả thông báo tiếng Việt theo loại lỗi', () => {
  const err = new Anthropic.APIConnectionError({ message: 'down' });
  assert.equal(describeError(err).status, 502);
  assert.equal(describeError(new Error('x')).status, 500);
});

test('HTTP: /api/health và /api/chat (client giả)', async () => {
  const fake = {
    beta: { messages: { create: async () => ({ content: [{ type: 'text', text: 'Chào' }], stop_reason: 'end_turn', model: 'm', usage: {} }) } },
  };
  const server = createApp({ anthropic: fake }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.ok, true);
    const bad = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(bad.status, 400);
    const okRes = await fetch(`${base}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: userMsg }),
    });
    assert.equal(okRes.status, 200);
    assert.equal((await okRes.json()).content[0].text, 'Chào');
    const page = await fetch(`${base}/`);
    assert.match(await page.text(), /Bokin/);
    const shared = await fetch(`${base}/shared/tools.js`);
    assert.equal(shared.status, 200);
  } finally {
    server.close();
  }
});

test('buildRequest: chỉ có ai_edit khi server bật AI, system prompt khớp', () => {
  const off = buildRequest(userMsg);
  assert.ok(!off.tools.some((t) => t.name === 'ai_edit'));
  assert.match(off.system[0].text, /turned off in this tool/);
  const on = buildRequest(userMsg, { aiEdit: true });
  assert.ok(on.tools.some((t) => t.name === 'ai_edit'));
  assert.match(on.system[0].text, /use ai_edit/);
  assert.ok(!on.system[0].text.includes('{{'), 'đã thay hết placeholder');
  // Cùng cấu hình -> cùng đối tượng (giữ prompt cache ổn định)
  assert.equal(buildRequest(userMsg, { aiEdit: true }).system, on.system);
});

test('checkAiEditBody', () => {
  const good = { instruction: 'Remove the ball', image: 'A'.repeat(200), mime_type: 'image/png' };
  assert.equal(checkAiEditBody(good), null);
  assert.ok(checkAiEditBody({ ...good, instruction: ' ' }));
  assert.ok(checkAiEditBody({ ...good, image: '' }));
  assert.ok(checkAiEditBody({ ...good, mime_type: 'image/gif' }));
  assert.ok(checkAiEditBody(null));
});

test('describeAiError: lỗi Hugging Face -> thông báo tiếng Việt', () => {
  const req = { url: 'https://router.huggingface.co/x', method: 'POST', headers: {} };
  const e402 = new InferenceClientProviderApiError('payment', req, { requestId: 'r', status: 402, body: '' });
  assert.match(describeAiError(e402).message, /credit/);
  const e401 = new InferenceClientProviderApiError('auth', req, { requestId: 'r', status: 401, body: '' });
  assert.match(describeAiError(e401).message, /HF_TOKEN/);
  assert.equal(describeAiError(new Error('x')).status, 500);
});

test('AI_EDIT=off tạm tắt Generative Fill dù có HF_TOKEN', async () => {
  const saved = { token: process.env.HF_TOKEN, flag: process.env.AI_EDIT };
  process.env.HF_TOKEN = 'hf_test';
  process.env.AI_EDIT = 'off';
  const app = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => app.once('listening', r));
  try {
    const h = await (await fetch(`http://127.0.0.1:${app.address().port}/api/health`)).json();
    assert.equal(h.ai_edit.enabled, false);
  } finally {
    app.close();
    for (const [k, v] of [['HF_TOKEN', saved.token], ['AI_EDIT', saved.flag]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('HTTP: /api/ai-edit tắt (501), sai body (400), chạy với editor giả (200)', async () => {
  const post = (base, body) => fetch(`${base}/api/ai-edit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const body = { instruction: 'Remove the ball', image: Buffer.from('x'.repeat(200)).toString('base64'), mime_type: 'image/png' };

  const saved = process.env.HF_TOKEN;
  delete process.env.HF_TOKEN;
  const off = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => off.once('listening', r));
  try {
    const res = await post(`http://127.0.0.1:${off.address().port}`, body);
    assert.equal(res.status, 501);
    assert.match((await res.json()).error, /HF_TOKEN/);
  } finally {
    off.close();
    if (saved !== undefined) process.env.HF_TOKEN = saved;
  }

  let seen;
  const on = createApp({ aiEditor: async (input) => { seen = input; return { buffer: Buffer.from('kết quả'), mimeType: 'image/png' }; } }).listen(0, '127.0.0.1');
  await new Promise((r) => on.once('listening', r));
  const base = `http://127.0.0.1:${on.address().port}`;
  try {
    assert.equal((await post(base, { ...body, instruction: '' })).status, 400);
    const res = await post(base, body);
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.equal(Buffer.from(out.image, 'base64').toString(), 'kết quả');
    assert.equal(seen.instruction, 'Remove the ball');
    assert.equal(seen.buffer.length, 200);
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.ai_edit.enabled, true);
  } finally {
    on.close();
  }
});

test('hasAnthropicCredentials và thông báo khi thiếu key', async () => {
  assert.equal(hasAnthropicCredentials({ ANTHROPIC_API_KEY: 'k' }), true);
  assert.equal(hasAnthropicCredentials({ ANTHROPIC_AUTH_TOKEN: 't' }), true);
  const saved = { key: process.env.ANTHROPIC_API_KEY, token: process.env.ANTHROPIC_AUTH_TOKEN };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    if (!hasAnthropicCredentials()) {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: userMsg }),
      });
      assert.equal(res.status, 500);
      assert.match((await res.json()).error, /ANTHROPIC_API_KEY/);
    }
  } finally {
    server.close();
    if (saved.key !== undefined) process.env.ANTHROPIC_API_KEY = saved.key;
    if (saved.token !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = saved.token;
  }
});

test('prompt caching: tối đa 4 điểm cache, phần cố định giống hệt nhau giữa các cuộc trò chuyện', () => {
  const a = buildRequest([{ role: 'user', content: 'Cuộc trò chuyện A' }]);
  const b = buildRequest([{ role: 'user', content: 'Cuộc trò chuyện B khác hẳn' }]);
  const breakpoints = JSON.stringify(a).split('"cache_control"').length - 1;
  assert.ok(breakpoints <= 4, `có ${breakpoints} điểm cache`);
  assert.equal(JSON.stringify(a.tools) + JSON.stringify(a.system), JSON.stringify(b.tools) + JSON.stringify(b.system));
});

test('buildFillRequest: Haiku, tắt suy nghĩ, effort thấp, không có fallbacks', async () => {
  const { buildFillRequest, FILL_SYSTEM } = await import('../../server/chat.js');
  const req = buildFillRequest('thêm con mèo');
  assert.equal(req.model, 'claude-haiku-5-5');
  assert.deepEqual(req.thinking, { type: 'disabled' });
  assert.deepEqual(req.output_config, { effort: 'low' });
  assert.equal(req.fallbacks, undefined, 'Haiku 5.5 không có server-side fallback');
  assert.equal(req.system, FILL_SYSTEM);
  assert.ok(req.max_tokens <= 2048);
});

test('HTTP: /api/fill-instruction dịch bằng model rẻ; để trống thì không gọi Claude', async () => {
  const calls = [];
  const fake = {
    messages: {
      create: async (params) => {
        calls.push(params);
        if (params.messages[0].content.includes('cấm')) return { content: [], stop_reason: 'refusal', model: params.model, usage: {} };
        return { content: [{ type: 'text', text: 'Add a small cat in the middle of the image. Keep everything else unchanged.' }], stop_reason: 'end_turn', model: params.model, usage: { input_tokens: 120, output_tokens: 20 } };
      },
    },
    beta: { messages: { create: async () => { throw new Error('không được gọi vòng lặp chat'); } } },
  };
  const server = createApp({ anthropic: fake }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const post = (prompt) => fetch(`http://127.0.0.1:${server.address().port}/api/fill-instruction`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }),
  });
  try {
    let res = await post('thêm một con mèo nhỏ');
    let out = await res.json();
    assert.equal(res.status, 200);
    assert.match(out.instruction, /^Add a small cat/);
    assert.equal(out.translated, true);
    assert.equal(calls.at(-1).model, 'claude-haiku-5-5');

    res = await post('   ');
    out = await res.json();
    assert.equal(calls.length, 1, 'để trống: không gọi Claude');
    assert.match(out.instruction, /^Remove the object in the middle/);
    assert.equal(out.translated, false);

    res = await post('nội dung bị cấm');
    assert.equal(res.status, 422);
    assert.match((await res.json()).error, /từ chối/);
  } finally {
    server.close();
  }
});

test('keepAlive: gửi lại y hệt yêu cầu thật, chỉ đổi max_tokens thành 0', async () => {
  const { keepAlive } = await import('../../server/chat.js');
  let sent;
  const fake = { beta: { messages: { create: async (p) => { sent = p; return { model: p.model, usage: { cache_read_input_tokens: 12000 } }; } } } };
  const msgs = [{ role: 'user', content: 'Làm sáng ảnh' }];
  const out = await keepAlive(msgs, fake, { aiEdit: true });
  const real = buildRequest(msgs, { aiEdit: true });
  assert.equal(sent.max_tokens, 0);
  assert.deepEqual({ ...sent, max_tokens: real.max_tokens }, real, 'mọi thứ khác giống hệt => trúng cùng mục cache');
  assert.equal(out.usage.cache_read_input_tokens, 12000);
});
