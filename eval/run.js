// Đánh giá Bokin với Claude API THẬT: chạy từng câu lệnh tiếng Việt qua giao diện thật + Photopea thật,
// kiểm tra kết quả tự động, ghi lại số lượt gọi, tool đã dùng, token và chi phí ước tính.
//
//   npm run eval                 # chạy tất cả tình huống
//   npm run eval -- them-chu     # chỉ chạy tình huống có id chứa "them-chu"
//
// LƯU Ý: tốn tiền API thật (khoảng 1–3 USD cho toàn bộ với claude-opus-5-5).
// Kết quả: eval/out/<thời gian>/report.md (+ ảnh kết quả của từng tình huống).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, openApp } from '../test/e2e/helpers.js';
import { SCENARIOS } from './scenarios.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// Giá USD / 1 triệu token: [input, output, đọc cache, ghi cache]
const PRICES = {
  'claude-opus-5-5': [4, 20, 0.2, 5],
  'claude-sonnet-5-5': [2, 10, 0.1, 2.5],
};

const filters = process.argv.slice(2);
const scenarios = filters.length
  ? SCENARIOS.filter((s, i) => filters.some((f) => s.id.includes(f)) || (s.setup === 'continue' && filters.some((f) => SCENARIOS[i - 1]?.id.includes(f))))
  : SCENARIOS;

if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
  console.error('Thiếu ANTHROPIC_API_KEY (đặt trong .env).');
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = path.join(here, 'out', stamp);
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
    const ctx = { info: () => docInfo(page), textColor: (name) => textColor(page, name) };
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

await fs.writeFile(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
await fs.writeFile(path.join(outDir, 'report.md'), report(results));
const passed = results.filter((r) => r.pass).length;
const total = results.reduce((s, r) => s + r.usd, 0);
console.log(`\nĐạt ${passed}/${results.length}. Chi phí ước tính: $${total.toFixed(2)}. Báo cáo: ${path.relative(process.cwd(), outDir)}/report.md`);
process.exitCode = passed === results.length ? 0 : 1;

// ───────────────────────────── Hàm phụ trợ ─────────────────────────────

async function resetChat(page, setup) {
  await page.click('#new-chat-btn');
  await page.evaluate(() => window.bokin.bridge.exec('while (app.documents.length) { app.activeDocument.close(2); }'));
  await page.evaluate(() => { window.bokin.runner.undoDepth = 0; });
  if (setup === 'photo') {
    const b64 = await page.evaluate(makeSamplePhoto);
    await page.setInputFiles('#file-input', { name: 'anh-mau.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(b64, 'base64') });
    await page.waitForSelector('.msg.info >> text=Đã mở ảnh', { timeout: 30_000 });
  }
}

/** Ảnh mẫu 1200x800: bầu trời, bãi cỏ, quả bóng đỏ tâm (820, 470) bán kính 110; có nhiễu và hơi tối. */
async function makeSamplePhoto() {
  const W = 1200, H = 800;
  const c = new OffscreenCanvas(W, H);
  const x = c.getContext('2d');
  const sky = x.createLinearGradient(0, 0, 0, 480);
  sky.addColorStop(0, '#3b5b8a'); sky.addColorStop(1, '#a9bdd6');
  x.fillStyle = sky; x.fillRect(0, 0, W, 480);
  const grass = x.createLinearGradient(0, 480, 0, H);
  grass.addColorStop(0, '#4d7a34'); grass.addColorStop(1, '#2f4d1f');
  x.fillStyle = grass; x.fillRect(0, 480, W, H - 480);
  const ball = x.createRadialGradient(790, 440, 20, 820, 470, 110);
  ball.addColorStop(0, '#ff6b5a'); ball.addColorStop(1, '#c41f1f');
  x.fillStyle = ball; x.beginPath(); x.arc(820, 470, 110, 0, Math.PI * 2); x.fill();
  const img = x.getImageData(0, 0, W, H);
  let seed = 42;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rand() - 0.5) * 36;
    for (let k = 0; k < 3; k++) img.data[i + k] = Math.max(0, Math.min(255, (img.data[i + k] + n) * 0.62));
  }
  x.putImageData(img, 0, 0);
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Phân tích ảnh hiện tại: kích thước, màu trung bình, độ bão hoà, quả bóng đỏ, độ nét nền/bóng. */
function analyze(page) {
  return page.evaluate(async () => {
    const exported = await window.bokin.bridge.exportDocument('png');
    if (!exported) return null;
    const bmp = await createImageBitmap(new Blob([exported.buffer]));
    const W = bmp.width, H = bmp.height;
    const cv = new OffscreenCanvas(W, H);
    const ctx = cv.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, W, H).data;
    const lum = new Float32Array(W * H);
    let r = 0, g = 0, b = 0, sat = 0, redN = 0, redX = 0, redY = 0;
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      const R = d[i], G = d[i + 1], B = d[i + 2];
      r += R; g += G; b += B;
      sat += Math.max(R, G, B) - Math.min(R, G, B);
      lum[p] = (R + G + B) / 3;
      if (R > 70 && R > 1.8 * G && R > 1.8 * B) { redN++; redX += p % W; redY += Math.floor(p / W); }
    }
    const n = W * H;
    const mean = (r + g + b) / 3 / n;
    let v = 0;
    for (let p = 0; p < n; p++) v += (lum[p] - mean) ** 2;
    const sharp = (x0, y0, x1, y1) => {
      let s = 0, k = 0;
      for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
        for (let x = Math.max(0, x0); x < Math.min(W, x1) - 1; x++) { s += Math.abs(lum[y * W + x + 1] - lum[y * W + x]); k++; }
      }
      return k ? +(s / k).toFixed(2) : 0;
    };
    const cx = redN ? Math.round(redX / redN) : null;
    const cy = redN ? Math.round(redY / redN) : null;
    const c0 = ctx.getImageData(2, 2, 1, 1).data;
    return {
      width: W, height: H,
      r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n),
      mean: Math.round(mean), std: +Math.sqrt(v / n).toFixed(1),
      saturation: Math.round(sat / n),
      red: { count: redN, cx, cy },
      corner: { r: c0[0], g: c0[1], b: c0[2], a: c0[3] },
      sharpness: {
        background: sharp(0, 0, W, Math.round(H * 0.35)),
        ball: redN > 500 ? sharp(cx - 50, cy - 50, cx + 50, cy + 50) : 0,
      },
    };
  });
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
    `Đạt **${passed}/${rows.length}** · chi phí ước tính **$${usd.toFixed(2)}** · model ${rows[0]?.usage[0]?.model ?? '?'}`,
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
