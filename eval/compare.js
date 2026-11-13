// So sánh nhiều cấu hình (model + mức suy nghĩ) trên cùng các tình huống để chọn cấu hình rẻ nhất mà vẫn đạt.
//
//   npm run eval:compare                         # xem kế hoạch + chi phí ước tính (KHÔNG chạy)
//   npm run eval:compare -- --yes                # chạy thật nhóm "color" với 3 cấu hình mặc định
//   npm run eval:compare -- fill --yes
//   npm run eval:compare -- color --configs claude-opus-5-5:low,claude-sonnet-5-5:medium --yes
//
// Mỗi cấu hình chạy eval/run.js trong một tiến trình riêng; kết quả gộp vào eval/out/compare-<thời gian>/report.md.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectScenarios } from './scenarios.js';
import { PRICES } from './prices.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIGS = ['claude-opus-5-5:medium', 'claude-opus-5-5:low', 'claude-sonnet-5-5:low'];

const argv = process.argv.slice(2);
const yes = argv.includes('--yes');
const configsArg = argv.includes('--configs') ? argv[argv.indexOf('--configs') + 1] : null;
const filters = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--configs');
const groupFilters = filters.length ? filters : ['color'];
const configs = (configsArg ? configsArg.split(',') : DEFAULT_CONFIGS).map((c) => {
  const [model, effort = 'medium'] = c.trim().split(':');
  return { model, effort, label: `${model} · ${effort}` };
});
const scenarios = selectScenarios(groupFilters);

// Ước tính thô: ~3 lượt gọi mỗi tình huống; mỗi lượt ~10k token đọc cache, ~2k token ghi cache,
// output ~1.000 token (effort low ~ một nửa). Chỉ để biết tầm chi phí, số thật nằm trong báo cáo.
function roughCost({ model, effort }) {
  const [, out, read, write] = PRICES[model] ?? PRICES['claude-opus-5-5'];
  const outputTokens = effort === 'low' ? 500 : effort === 'medium' ? 1000 : 1800;
  const perCall = (10_000 * read + 2_000 * write + outputTokens * out) / 1e6;
  return scenarios.length * 3 * perCall;
}

console.log(`Tình huống (${scenarios.length}): ${scenarios.map((s) => s.id).join(', ')}`);
console.log('Cấu hình:');
let estimate = 0;
for (const c of configs) {
  const e = roughCost(c);
  estimate += e;
  console.log(`  - ${c.label.padEnd(32)} ước tính thô ~$${e.toFixed(2)}`);
}
console.log(`Tổng ước tính thô: ~$${estimate.toFixed(2)} (chưa gồm phí AI tạo ảnh nếu có nhóm fill).`);
if (!yes) {
  console.log('\nChưa chạy. Thêm --yes để chạy thật (tốn tiền API).');
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outRoot = path.join(here, 'out', `compare-${stamp}`);
await fs.mkdir(outRoot, { recursive: true });

const rows = [];
for (const c of configs) {
  const dir = path.join(outRoot, c.label.replace(/[^a-z0-9.-]+/gi, '_'));
  console.log(`\n▶ ${c.label}`);
  await new Promise((resolve) => {
    const child = spawn(process.execPath, ['--env-file-if-exists=.env', path.join(here, 'run.js'), ...groupFilters, '--model', c.model, '--effort', c.effort, '--out', dir], { stdio: 'inherit' });
    child.on('exit', resolve);
  });
  try {
    const { results } = JSON.parse(await fs.readFile(path.join(dir, 'results.json'), 'utf-8'));
    const n = results.length || 1;
    rows.push({
      ...c,
      passed: results.filter((r) => r.pass).length,
      total: results.length,
      usd: results.reduce((s, r) => s + r.usd, 0),
      rounds: results.reduce((s, r) => s + r.rounds, 0) / n,
      seconds: results.reduce((s, r) => s + r.seconds, 0) / n,
      failed: results.filter((r) => !r.pass).map((r) => r.id),
      dir: path.relative(outRoot, dir),
    });
  } catch {
    rows.push({ ...c, error: 'không có kết quả (xem log ở trên)' });
  }
}

const lines = [
  `# So sánh cấu hình (${stamp})`,
  '',
  `Tình huống: ${scenarios.map((s) => s.id).join(', ')}`,
  '',
  '| Cấu hình | Đạt | Chi phí | Chi phí / tình huống | Lượt gọi TB | Thời gian TB | Trượt |',
  '|---|---|---|---|---|---|---|',
  ...rows.map((r) => (r.error
    ? `| ${r.label} | - | - | - | - | - | ${r.error} |`
    : `| ${r.label} | ${r.passed}/${r.total} | $${r.usd.toFixed(2)} | $${(r.usd / (r.total || 1)).toFixed(3)} | ${r.rounds.toFixed(1)} | ${r.seconds.toFixed(0)}s | ${r.failed.join(', ') || '-'} |`)),
  '',
  'Chọn cấu hình rẻ nhất có cùng số tình huống đạt với cấu hình tốt nhất, rồi đặt trong .env:',
  '`CLAUDE_MODEL=...` và `CLAUDE_EFFORT=...`. Chi tiết từng cấu hình nằm trong các thư mục con.',
];
await fs.writeFile(path.join(outRoot, 'report.md'), lines.join('\n'));
console.log(`\n${lines.slice(4, 6 + rows.length).join('\n')}\n\nBáo cáo: ${path.relative(process.cwd(), outRoot)}/report.md`);
