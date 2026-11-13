// Gọi Claude API cho một lượt hội thoại.
//
// Vòng lặp tool (agent loop) chạy ở TRÌNH DUYỆT vì các tool phải thực thi trong Photopea.
// Server chỉ làm nhiệm vụ: giữ API key, gắn system prompt + danh sách tool, gọi Claude
// một lần cho mỗi request, rồi trả nội dung về trình duyệt.

import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT } from './system-prompt.js';
import { toolDefinitions } from '../shared/tools.js';

export const config = {
  model: process.env.CLAUDE_MODEL || 'claude-opus-5-5',
  // Opus 5.5 mặc định effort "medium"; có thể đặt low | medium | high | xhigh | max.
  effort: process.env.CLAUDE_EFFORT || 'medium',
  // Khi bộ lọc an toàn từ chối một yêu cầu, API tự chạy lại trên model dự phòng do Anthropic chọn.
  // Đặt CLAUDE_FALLBACKS=off để tắt.
  fallbacks: (process.env.CLAUDE_FALLBACKS || 'default').toLowerCase() !== 'off',
  maxTokens: 16000,
};

const TOOLS = toolDefinitions();

/** Tạo tham số request gửi Claude (tách riêng để dễ kiểm thử). */
export function buildRequest(messages) {
  const params = {
    model: config.model,
    max_tokens: config.maxTokens,
    system: SYSTEM_PROMPT,
    tools: TOOLS,
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

let client;
export function getClient() {
  // Tạo lười: SDK tự đọc ANTHROPIC_API_KEY (hoặc ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL) từ môi trường.
  client ??= new Anthropic();
  return client;
}

/** Gọi Claude một lần. Trả về dữ liệu gọn cho trình duyệt. */
export async function runTurn(messages, anthropic = getClient()) {
  const response = await anthropic.beta.messages.create(buildRequest(messages));
  return {
    content: prepareForEcho(response.content),
    stop_reason: response.stop_reason,
    stop_details: response.stop_details ?? null,
    model: response.model,
    usage: response.usage,
  };
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
