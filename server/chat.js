// Gọi Claude API cho một lượt hội thoại.
//
// Vòng lặp tool (agent loop) chạy ở TRÌNH DUYỆT vì các tool phải thực thi trong Photopea.
// Server chỉ làm nhiệm vụ: giữ API key, gắn system prompt + danh sách tool, gọi Claude
// một lần cho mỗi request, rồi trả nội dung về trình duyệt.

import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { systemPrompt } from './system-prompt.js';
import { toolDefinitions } from '../shared/tools.js';

export const config = {
  model: process.env.CLAUDE_MODEL || 'claude-opus-5-5',
  // Opus 5.5 mặc định effort "medium"; có thể đặt low | medium | high | xhigh | max.
  effort: process.env.CLAUDE_EFFORT || 'medium',
  // Khi bộ lọc an toàn từ chối một yêu cầu, API tự chạy lại trên model dự phòng do Anthropic chọn.
  // Đặt CLAUDE_FALLBACKS=off để tắt.
  fallbacks: (process.env.CLAUDE_FALLBACKS || 'default').toLowerCase() !== 'off',
  maxTokens: 16000,
  // Model rẻ cho việc nhỏ (dịch câu lệnh Generative Fill sang tiếng Anh).
  fastModel: process.env.CLAUDE_FAST_MODEL || 'claude-haiku-5-5',
  // Chi phí tối đa (USD, ước tính) cho một yêu cầu trước khi Bokin tạm dừng hỏi người dùng.
  maxCostPerRequest: Number(process.env.CLAUDE_MAX_COST_PER_REQUEST) > 0 ? Number(process.env.CLAUDE_MAX_COST_PER_REQUEST) : 0.5,
};

// Hai bộ cấu hình cố định (có / không có ai_edit) để prompt caching không bị phá.
// Điểm cache tường minh ở cuối system prompt: tools + system (~9.000 token, giống hệt nhau ở mọi cuộc
// trò chuyện) được ghi cache một lần rồi đọc lại với giá rẻ, kể cả khi bắt đầu cuộc trò chuyện mới.
// Phần hội thoại phía sau do cache tự động (cache_control ở cấp request) lo.
const cachedSystem = (text) => [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
const VARIANTS = {
  withAi: { system: cachedSystem(systemPrompt({ aiEdit: true })), tools: toolDefinitions() },
  withoutAi: { system: cachedSystem(systemPrompt({ aiEdit: false })), tools: toolDefinitions().filter((t) => t.name !== 'ai_edit') },
};

/**
 * Tạo tham số request gửi Claude (tách riêng để dễ kiểm thử).
 * @param {{ aiEdit?: boolean }} [options] - server có bật chỉnh sửa bằng AI tạo ảnh không
 */
export function buildRequest(messages, { aiEdit = false } = {}) {
  const variant = aiEdit ? VARIANTS.withAi : VARIANTS.withoutAi;
  const params = {
    model: config.model,
    max_tokens: config.maxTokens,
    system: variant.system,
    tools: variant.tools,
    messages,
    output_config: { effort: config.effort },
    // Tự động cache tiền tố (system + tools + lịch sử) giữa các lượt.
    cache_control: { type: 'ephemeral' },
  };
  if (config.fallbacks) {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  return params;
}

// ───────────────────────────── Dịch câu lệnh Generative Fill ─────────────────────────────

export const FILL_SYSTEM = `You turn a user's request for a generative-fill edit (usually written in Vietnamese, possibly without diacritics) into ONE instruction for an instruction-following image editing model (Qwen-Image-Edit).
- The model receives a crop centered on the area the user selected, so refer to the target as being "in the middle of the image".
- Removal requests: say what to remove (or "the object in the middle" if unspecified) and to fill the area naturally so it matches the surrounding background.
- Additions or replacements: describe the new content concretely (subject, color, size, material, style), placed in the middle of the image, matching the lighting, perspective and style of the photo.
- End with "Keep everything else unchanged."
- Write in English, at most two sentences. Output only the instruction, no quotes or explanations.`;

/** Câu lệnh cố định khi người dùng để trống ô nhập: xoá vật thể trong vùng chọn (không cần gọi Claude). */
export const REMOVE_INSTRUCTION = 'Remove the object in the middle of the image and fill the area naturally so it matches the surrounding background. Keep everything else unchanged.';

export function buildFillRequest(prompt) {
  const params = {
    model: config.fastModel,
    max_tokens: 1024,
    system: FILL_SYSTEM,
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: prompt }],
  };
  // Haiku 5.5 cho phép tắt suy nghĩ (ở effort high trở xuống): việc dịch ngắn không cần suy nghĩ.
  // Opus/Sonnet 5.5 không nhận {type:'disabled'} nên chỉ tắt với Haiku.
  if (config.fastModel.startsWith('claude-haiku')) params.thinking = { type: 'disabled' };
  return params;
}

export class RefusalError extends Error {}

/** Dịch yêu cầu Generative Fill sang câu lệnh tiếng Anh cho mô hình ảnh. */
export async function translateFillPrompt(prompt, anthropic = getClient()) {
  const response = await anthropic.messages.create(buildFillRequest(prompt));
  if (response.stop_reason === 'refusal') throw new RefusalError('Yêu cầu này bị bộ lọc an toàn từ chối. Hãy diễn đạt lại.');
  const instruction = response.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
  if (!instruction) throw new Error('Không dịch được câu lệnh.');
  return { instruction, model: response.model, usage: response.usage };
}

/**
 * Khi có khối `fallback` (model dự phòng đã tiếp quản), các khối thinking/tool_use đứng TRƯỚC
 * khối fallback cuối cùng không được gửi lại. Giữ nguyên khối fallback ở đúng vị trí.
 */
export function prepareForEcho(content) {
  let lastFallback = -1;
  content.forEach((b, i) => { if (b.type === 'fallback') lastFallback = i; });
  if (lastFallback < 0) return content;
  const drop = new Set(['thinking', 'redacted_thinking', 'tool_use']);
  return content.filter((b, i) => i >= lastFallback || !drop.has(b.type));
}

/** Kiểm tra sơ bộ cấu trúc messages nhận từ trình duyệt. */
export function checkMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return 'messages phải là mảng không rỗng.';
  for (const m of messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return 'Mỗi message cần role là user hoặc assistant.';
    if (typeof m.content !== 'string' && !Array.isArray(m.content)) return 'content phải là chuỗi hoặc mảng.';
  }
  if (messages[0].role !== 'user') return 'Message đầu tiên phải là của user.';
  if (messages.at(-1).role !== 'user') return 'Message cuối cùng phải là của user.';
  return null;
}

/**
 * Server có cách xác thực với Claude API không: API key, auth token, hoặc profile của `ant auth login`.
 * (Khi thiếu, SDK ném một Error thường, không phải lớp lỗi riêng, nên kiểm tra trước để báo lỗi rõ ràng.)
 */
export function hasAnthropicCredentials(env = process.env) {
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_PROFILE || env.ANTHROPIC_IDENTITY_TOKEN_FILE) return true;
  return fs.existsSync(path.join(os.homedir(), '.config', 'anthropic'));
}

export const MISSING_KEY_MESSAGE = 'Server chưa có API key của Claude. Tạo file .env (xem .env.example), điền ANTHROPIC_API_KEY rồi khởi động lại server.';

let client;
export function getClient() {
  // Tạo lười: SDK tự đọc ANTHROPIC_API_KEY (hoặc ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL) từ môi trường.
  client ??= new Anthropic();
  return client;
}

/** Gọi Claude một lần. Trả về dữ liệu gọn cho trình duyệt. */
export async function runTurn(messages, anthropic = getClient(), { aiEdit = false } = {}) {
  const response = await anthropic.beta.messages.create(buildRequest(messages, { aiEdit }));
  return {
    content: prepareForEcho(response.content),
    stop_reason: response.stop_reason,
    stop_details: response.stop_details ?? null,
    model: response.model,
    usage: response.usage,
  };
}

/**
 * Giữ cache ấm khi người dùng tạm dừng: gửi lại ĐÚNG yêu cầu trước đó với max_tokens: 0.
 * API chỉ đọc lại phần đã cache (giá đọc cache, không sinh output) và làm mới thời hạn 5 phút,
 * nên lần gõ tiếp theo không phải ghi lại toàn bộ lịch sử (kể cả ảnh) với giá ghi cache.
 * Phải giữ nguyên thinking/effort/tools/system như yêu cầu thật để trúng cùng mục cache.
 */
export async function keepAlive(messages, anthropic = getClient(), { aiEdit = false } = {}) {
  const response = await anthropic.beta.messages.create({ ...buildRequest(messages, { aiEdit }), max_tokens: 0 });
  return { model: response.model, usage: response.usage };
}

/** Chuyển lỗi SDK thành mã HTTP + thông báo tiếng Việt. */
export function describeError(error) {
  if (error instanceof Anthropic.AuthenticationError) {
    return { status: 401, message: 'API key không hợp lệ. Kiểm tra ANTHROPIC_API_KEY trong file .env rồi khởi động lại server.' };
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return { status: 403, message: `API key không có quyền dùng model này (${config.model}).` };
  }
  if (error instanceof Anthropic.NotFoundError) {
    return { status: 404, message: `Không tìm thấy model "${config.model}". Kiểm tra CLAUDE_MODEL trong .env.` };
  }
  if (error instanceof Anthropic.RateLimitError) {
    return { status: 429, message: 'Đang bị giới hạn tốc độ (rate limit). Đợi một lát rồi thử lại.' };
  }
  if (error instanceof Anthropic.BadRequestError) {
    const tooLarge = /too large|maximum|exceed/i.test(error.message);
    return {
      status: 400,
      message: tooLarge
        ? 'Cuộc trò chuyện quá dài (nhiều ảnh xem trước). Bấm "Trò chuyện mới" để bắt đầu lại.'
        : `Yêu cầu không hợp lệ: ${error.message}`,
    };
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return { status: 502, message: 'Không kết nối được tới Claude API. Kiểm tra mạng.' };
  }
  if (error instanceof Anthropic.APIError) {
    return { status: error.status ?? 500, message: `Claude API báo lỗi (${error.status}): ${error.message}` };
  }
  if (error instanceof Anthropic.AnthropicError) {
    // Ví dụ: thiếu API key -> SDK không tạo được header xác thực.
    return { status: 500, message: `Chưa cấu hình được Claude API: ${error.message}. Hãy đặt ANTHROPIC_API_KEY trong file .env.` };
  }
  return { status: 500, message: `Lỗi server: ${error?.message ?? error}` };
}
