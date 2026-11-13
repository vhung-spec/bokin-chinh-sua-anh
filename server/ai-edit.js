// Chỉnh sửa ảnh bằng AI tạo ảnh (xoá vật thể, đổi nền, thêm chi tiết...) qua Hugging Face Inference Providers.
//
// Mặc định dùng Qwen-Image-Edit-2511 (giấy phép Apache-2.0, dùng thương mại được), chạy trên nhà cung cấp
// do Hugging Face chọn (fal-ai / wavespeed...). Cần HF_TOKEN; chi phí tính vào tài khoản Hugging Face.
//
// Có thể thay bằng dịch vụ khác (ComfyUI tự host, fal.ai trực tiếp...) bằng cách viết một hàm cùng chữ ký
// với editWithHuggingFace và truyền vào createApp({ aiEditor }).

import {
  InferenceClient,
  InferenceClientError,
  InferenceClientHubApiError,
  InferenceClientProviderApiError,
} from '@huggingface/inference';

export const aiConfig = {
  model: process.env.AI_EDIT_MODEL || 'Qwen/Qwen-Image-Edit-2511',
  // "auto" = nhà cung cấp đầu tiên theo thứ tự trong https://hf.co/settings/inference-providers
  provider: process.env.AI_EDIT_PROVIDER || 'auto',
  // Cạnh dài tối đa của ảnh gửi cho AI. Giá ~0,03 USD / megapixel: 1024px ≈ 1 MP ≈ 0,03 USD,
  // 1536px ≈ 2,4 MP ≈ 0,07 USD. Vùng chọn nhỏ vẫn được gửi ở kích thước thật (rẻ hơn nữa).
  maxSide: Math.min(2048, Math.max(256, Number(process.env.AI_EDIT_MAX_SIDE) || 1024)),
};

/** Bật khi có HF_TOKEN, trừ khi tạm tắt bằng AI_EDIT=off (công cụ chỉ còn chỉnh màu, chỉnh vùng). */
export function aiEditEnabled() {
  return Boolean(process.env.HF_TOKEN) && (process.env.AI_EDIT || '').toLowerCase() !== 'off';
}

let client;

/**
 * @param {{ buffer: Buffer, mimeType: string, instruction: string }} input
 * @returns {Promise<{ buffer: Buffer, mimeType: string }>}
 */
export async function editWithHuggingFace({ buffer, mimeType, instruction }) {
  client ??= new InferenceClient(process.env.HF_TOKEN);
  const blob = await client.imageToImage({
    provider: aiConfig.provider,
    model: aiConfig.model,
    inputs: new Blob([buffer], { type: mimeType }),
    parameters: { prompt: instruction },
  });
  return { buffer: Buffer.from(await blob.arrayBuffer()), mimeType: blob.type || 'image/png' };
}

/** Kiểm tra body của POST /api/ai-edit. Trả về chuỗi lỗi hoặc null. */
export function checkAiEditBody(body) {
  if (!body || typeof body.instruction !== 'string' || !body.instruction.trim()) return 'Thiếu instruction.';
  if (body.instruction.length > 2000) return 'instruction quá dài.';
  if (typeof body.image !== 'string' || body.image.length < 100) return 'Thiếu ảnh (base64).';
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(body.mime_type)) return 'mime_type phải là image/png, image/jpeg hoặc image/webp.';
  return null;
}

/** Chuyển lỗi của dịch vụ AI thành mã HTTP + thông báo tiếng Việt. */
export function describeAiError(error) {
  const status = error?.httpResponse?.status;
  if (error instanceof InferenceClientProviderApiError || error instanceof InferenceClientHubApiError) {
    if (status === 401 || status === 403) return { status: 502, message: 'HF_TOKEN không hợp lệ hoặc không có quyền gọi Inference Providers.' };
    if (status === 402) return { status: 502, message: 'Tài khoản Hugging Face đã hết hạn mức/credit cho Inference Providers.' };
    if (status === 429) return { status: 429, message: 'Dịch vụ AI đang giới hạn tốc độ. Đợi một lát rồi thử lại.' };
    return { status: 502, message: `Dịch vụ AI báo lỗi${status ? ` (${status})` : ''}: ${error.message}` };
  }
  if (error instanceof InferenceClientError) return { status: 502, message: `Lỗi khi gọi dịch vụ AI: ${error.message}` };
  return { status: 500, message: `Lỗi chỉnh sửa AI: ${error?.message ?? error}` };
}
