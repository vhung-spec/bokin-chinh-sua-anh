// Xuất Bokin để gắn vào một web app khác có máy chủ riêng (không phải Node, ví dụ Python).
//
//   node scripts/export-page.js <thư mục đích>
//   (hoặc: npm run export:page -- <thư mục đích>)
//
// Ghi ra:
//   <thư mục>/page/       giao diện (public/*) và shared/*.js, y như trang của npm start
//   <thư mục>/claude.json yêu cầu gửi Claude dựng sẵn bởi server/chat.js (system prompt, 31 tool, cache, fallback),
//                         câu lệnh Generative Fill, bảng giá, giá trị mặc định: máy chủ kia chỉ cần thêm `messages`
//                         rồi gửi, nên prompt và tool chỉ có MỘT bản gốc là repo này.
// Chạy lại mỗi khi sửa giao diện, tool hay prompt, rồi commit thư mục đích bên repo của web app kia.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dest = process.argv[2];
if (!dest) {
  console.error('Cách dùng: node scripts/export-page.js <thư mục đích>');
  process.exit(2);
}

// Giá trị mặc định, không phụ thuộc file .env của máy đang chạy lệnh này (model, effort... do máy chủ kia đặt).
for (const k of ['CLAUDE_MODEL', 'CLAUDE_EFFORT', 'CLAUDE_FALLBACKS', 'CLAUDE_FAST_MODEL', 'CLAUDE_MAX_COST_PER_REQUEST',
  'AI_EDIT_MODEL', 'AI_EDIT_PROVIDER', 'AI_EDIT_MAX_SIDE']) delete process.env[k];

const { buildRequest, buildFillRequest, REMOVE_INSTRUCTION, config } = await import('../server/chat.js');
const { aiConfig } = await import('../server/ai-edit.js');
const { PRICES } = await import('../shared/prices.js');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const withoutMessages = (params) => {
  const { messages, ...rest } = params;
  return rest;
};

let commit = '';
try {
  commit = execSync('git rev-parse --short HEAD', { cwd: root, encoding: 'utf8' }).trim();
} catch { /* không phải thư mục git */ }

const claude = {
  source: `bokin-chinh-sua-anh ${pkg.version}${commit ? ` (${commit})` : ''}`,
  chat: {
    with_ai: withoutMessages(buildRequest([], { aiEdit: true })),
    without_ai: withoutMessages(buildRequest([], { aiEdit: false })),
  },
  fill: withoutMessages(buildFillRequest('')),
  remove_instruction: REMOVE_INSTRUCTION,
  prices: PRICES,
  defaults: {
    model: config.model,
    effort: config.effort,
    max_cost_per_request: config.maxCostPerRequest,
    ai_model: aiConfig.model,
    ai_provider: aiConfig.provider,
    ai_max_side: aiConfig.maxSide,
  },
};

const page = path.join(dest, 'page');
fs.rmSync(page, { recursive: true, force: true });
fs.mkdirSync(path.join(page, 'shared'), { recursive: true });
let files = 0;
for (const name of fs.readdirSync(path.join(root, 'public'))) {
  if (!/\.(html|css|js)$/.test(name)) continue;
  fs.copyFileSync(path.join(root, 'public', name), path.join(page, name));
  files++;
}
for (const name of fs.readdirSync(path.join(root, 'shared'))) {
  if (!name.endsWith('.js')) continue;
  fs.copyFileSync(path.join(root, 'shared', name), path.join(page, 'shared', name));
  files++;
}
fs.writeFileSync(path.join(dest, 'claude.json'), `${JSON.stringify(claude, null, 1)}\n`);
console.log(`Đã xuất ${files} file giao diện vào ${page} và claude.json (${claude.source}).`);
