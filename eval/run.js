// Đánh giá Bokin với Claude API THẬT: chạy từng câu lệnh tiếng Việt qua giao diện thật + Photopea thật,
// kiểm tra kết quả tự động, ghi lại số lượt gọi, tool đã dùng, token và chi phí ước tính.
//
//   npm run eval                          # tất cả tình huống
//   npm run eval -- color                 # một nhóm: color | fill | basic
//   npm run eval -- them-chu cat-vuong    # tình huống có id chứa các từ này
//   npm run eval -- color --model claude-sonnet-5-5 --effort low   # thử cấu hình khác
//
// LƯU Ý: tốn tiền API thật. Xem chi phí thực của từng tình huống trong báo cáo.
// Kết quả: eval/out/<thời gian>/report.md + results.json (+ ảnh kết quả của từng tình huống).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENARIOS, selectScenarios } from './scenarios.js';
import { makeSamplePhoto, analyze } from './lib.js';
import { PRICES } from './prices.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const args = parseArgs(process.argv.slice(2));
// Đặt cấu hình TRƯỚC khi nạp server (server đọc biến môi trường lúc khởi động).
if (args.model) process.env.CLAUDE_MODEL = args.model;
if (args.effort) process.env.CLAUDE_EFFORT = args.effort;
const { startServer, openApp } = await import('../test/e2e/helpers.js');
const { config } = await import('../server/chat.js');

const scenarios = selectScenarios(args.filters);
if (!scenarios.length) {
  console.error(`Không có tình huống nào khớp: ${args.filters.join(' ')}. Có: ${SCENARIOS.map((s) => s.id).join(', ')}`);
  process.exit(1);
}

if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
  console.error('Thiếu ANTHROPIC_API_KEY (đặt trong .env).');
  process.exit(1);
}
console.log(`Cấu hình: ${config.model}, effort ${config.effort} · ${scenarios.length} tình huống`);

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = args.out ? path.resolve(args.out) : path.join(here, 'out', stamp);
await fs.mkdir(outDir, { recursive: true });

const { server, url } = await startServer();
const { browser, page } = await openApp(url);
const health = await (await fetch(`${url}/api/health`)).json();
const results = [];

try {
  for (const sc of scenarios) {
    if (sc.requires === 'ai_edit' && !health.ai_edit?.enabled) {
      console.log(`- ${sc.id.padEnd(16)} bỏ qua (chưa có HF_TOKEN)`);
      continue;
    }
    if (sc.setup !== 'continue') await resetChat(page, sc.setup);
    const ctx = { info: () => docInfo(page), textColor: (name) => textColor(page, name), tool: (n, i) => page.evaluate(([a, b]) => window.bokin.executeTool(a, b), [n, i]) };
    if (sc.prepare) await sc.prepare(ctx);
    const before = await analyze(page);
    const mark = await page.evaluate(() => ({ m: window.bokin.state.messages.length, u: window.bokin.state.usage.length }));
    const started = Date.now();
    await page.fill('#input', sc.prompt);
    await page.press('#input', 'Enter');
    await page.waitForFunction(() => !window.bokin.state.busy, null, { timeout: 300_000 });
    const seconds = (Date.now() - started) / 1000;

    const run = await page.evaluate(({ m, u }) => {
      const s = window.bokin.state;
      const msgs = s.messages.slice(m);
      const calls = [];
      const toolErrors = [];
      const texts = [];
      for (const msg of msgs) {
        if (!Array.isArray(msg.content)) continue;
        for (const b of msg.content) {
          if (b.type === 'tool_use') calls.push(`${b.name}(${JSON.stringify(b.input)})`);
          if (b.type === 'text' && msg.role === 'assistant') texts.push(b.text);
          if (b.type === 'tool_result' && b.is_error) toolErrors.push(String(b.content).slice(0, 300));
        }
      }
      const uiErrors = [...document.querySelectorAll('.msg.error')].map((e) => e.textContent);
      return { calls, toolErrors, reply: texts.join('\n'), usage: s.usage.slice(u), uiErrors };
    }, mark);

    const after = await analyze(page);
    let failure;
    try {
      failure = run.uiErrors.length ? `lỗi giao diện: ${run.uiErrors.join(' | ')}` : await sc.check(before, after, ctx);
    } catch (error) {
      failure = `lỗi khi kiểm tra: ${error.message}`;
    }
    const cost = costOf(run.usage);
    await saveImage(page, path.join(outDir, `${sc.id}.jpg`));
    const result = { id: sc.id, prompt: sc.prompt, pass: !failure, failure, seconds, rounds: run.usage.length, ...run, ...cost };
    results.push(result);
    console.log(`${result.pass ? '✔' : '✘'} ${sc.id.padEnd(16)} ${String(result.rounds).padStart(2)} lượt  ${seconds.toFixed(0).padStart(3)}s  $${cost.usd.toFixed(3)}  ${failure ?? ''}`);
  }
} finally {
  await browser.close();
  server.close();
}

await fs.writeFile(path.join(outDir, 'results.json'), JSON.stringify({ config: { model: config.model, effort: config.effort }, results }, null, 2));
await fs.writeFile(path.join(outDir, 'report.md'), report(results));
const passed = results.filter((r) => r.pass).length;
const total = results.reduce((s, r) => s + r.usd, 0);
console.log(`\nĐạt ${passed}/${results.length}. Chi phí ước tính: $${total.toFixed(2)}. Báo cáo: ${path.relative(process.cwd(), outDir)}/report.md`);
process.exitCode = passed === results.length ? 0 : 1;

// ───────────────────────────── Hàm phụ trợ ─────────────────────────────

function parseArgs(argv) {
  const out = { filters: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model' || a === '--effort' || a === '--out') out[a.slice(2)] = argv[++i];
    else out.filters.push(a);
  }
  return out;
}

async function resetChat(page, setup) {
  await page.click('#new-chat-btn');
  await page.evaluate(() => window.bokin.bridge.exec('while (app.documents.length) { app.activeDocument.close(2); }'));
  await page.evaluate(() => { window.bokin.runner.undoDepth = 0; });
  if (setup === 'photo' || setup === 'photo_yellow') {
    const b64 = await page.evaluate(makeSamplePhoto, { yellowCast: setup === 'photo_yellow' });
    await page.setInputFiles('#file-input', { name: 'anh-mau.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(b64, 'base64') });
    await page.waitForSelector('.msg.info >> text=Đã mở ảnh', { timeout: 30_000 });
  }
}

async function docInfo(page) {
  const out = await page.evaluate(() => window.bokin.executeTool('get_document_info', {}));
  return JSON.parse(out.content);
}

async function textColor(page, name) {
  const r = await page.evaluate((n) => window.bokin.bridge.exec(`
var found = null; var ls = app.activeDocument.layers;
for (var i = 0; i < ls.length; i++) { if (ls[i].name === ${JSON.stringify(n)}) { found = ls[i]; } }
if (found) { app.echoToOE(found.textItem.color.rgb.hexValue); }`), name);
  const hex = r.echoes[0] ?? '000000';
  return { hex: `#${hex}`, r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) };
}

async function saveImage(page, file) {
  const b64 = await page.evaluate(async () => {
    const e = await window.bokin.bridge.exportDocument('jpg:0.8');
    if (!e) return null;
    const bytes = new Uint8Array(e.buffer);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  });
  if (b64) await fs.writeFile(file, Buffer.from(b64, 'base64'));
}

function costOf(usage) {
  const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let usd = 0;
  for (const u of usage) {
    const p = PRICES[u.model] ?? PRICES['claude-opus-5-5'];
    const input = u.input_tokens ?? 0, output = u.output_tokens ?? 0;
    const cr = u.cache_read_input_tokens ?? 0, cw = u.cache_creation_input_tokens ?? 0;
    t.input += input; t.output += output; t.cacheRead += cr; t.cacheWrite += cw;
    usd += (input * p[0] + output * p[1] + cr * p[2] + cw * p[3]) / 1e6;
  }
  return { tokens: t, usd };
}

function report(rows) {
  const passed = rows.filter((r) => r.pass).length;
  const usd = rows.reduce((s, r) => s + r.usd, 0);
  const lines = [
    `# Kết quả đánh giá Bokin (${stamp})`,
    '',
    `Đạt **${passed}/${rows.length}** · chi phí ước tính **$${usd.toFixed(2)}** · model ${config.model}, effort ${config.effort}`,
    '',
    '| Tình huống | Kết quả | Lượt | Thời gian | Chi phí | Ghi chú |',
    '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.id} | ${r.pass ? '✔' : '✘'} | ${r.rounds} | ${r.seconds.toFixed(0)}s | $${r.usd.toFixed(3)} | ${(r.failure ?? '').replace(/\|/g, '/')} |`),
    '',
  ];
  for (const r of rows) {
    lines.push(`## ${r.id} ${r.pass ? '✔' : '✘'}`, '', `> ${r.prompt}`, '', `![${r.id}](${r.id}.jpg)`, '', '**Tool đã gọi:**', '');
    lines.push(...r.calls.map((c) => `- \`${c.slice(0, 300)}\``));
    if (r.toolErrors.length) lines.push('', '**Lỗi tool:**', '', ...r.toolErrors.map((e) => `- ${e}`));
    lines.push('', '**Trả lời:**', '', r.reply || '(không có)', '',
      `Token: input ${r.tokens.input}, output ${r.tokens.output}, cache đọc ${r.tokens.cacheRead}, cache ghi ${r.tokens.cacheWrite}`, '');
  }
  return lines.join('\n');
}
