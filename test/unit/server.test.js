import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, prepareForEcho, checkMessages, runTurn, describeError, config } from '../../server/chat.js';
import { createApp } from '../../server/app.js';
import Anthropic from '@anthropic-ai/sdk';

const userMsg = [{ role: 'user', content: 'Làm sáng ảnh' }];

test('buildRequest: model, tools, system, effort, cache và fallback', () => {
  const req = buildRequest(userMsg);
  assert.equal(req.model, config.model);
  assert.equal(req.max_tokens, 16000);
  assert.ok(req.system.includes('Photopea'));
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
