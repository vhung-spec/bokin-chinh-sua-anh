import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, runTurn, checkMessages, describeError, getClient, hasAnthropicCredentials, MISSING_KEY_MESSAGE } from './chat.js';
import { aiConfig, aiEditEnabled, editWithHuggingFace, checkAiEditBody, describeAiError } from './ai-edit.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Tạo ứng dụng Express.
 * @param {object} [options] - cho phép thay thành phần giả khi kiểm thử
 * @param {import('@anthropic-ai/sdk').default} [options.anthropic] - client Claude
 * @param {(input: {buffer: Buffer, mimeType: string, instruction: string}) => Promise<{buffer: Buffer, mimeType: string}>} [options.aiEditor]
 *   - hàm chỉnh sửa ảnh bằng AI; mặc định dùng Hugging Face nếu có HF_TOKEN
 */
export function createApp({ anthropic, aiEditor } = {}) {
  const editor = aiEditor ?? (aiEditEnabled() ? editWithHuggingFace : null);
  const app = express();
  // Lịch sử hội thoại có kèm ảnh xem trước (base64) nên có thể khá lớn.
  app.use(express.json({ limit: '32mb' }));

  app.use(express.static(path.join(root, 'public')));
  app.use('/shared', express.static(path.join(root, 'shared')));

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      model: config.model,
      effort: config.effort,
      has_api_key: Boolean(anthropic) || hasAnthropicCredentials(),
      ai_edit: { enabled: Boolean(editor), model: aiEditor ? 'custom' : aiConfig.model },
    });
  });

  app.post('/api/chat', async (req, res) => {
    const messages = req.body?.messages;
    const problem = checkMessages(messages);
    if (problem) return res.status(400).json({ error: problem });
    if (!anthropic && !hasAnthropicCredentials()) return res.status(500).json({ error: MISSING_KEY_MESSAGE });
    try {
      const result = await runTurn(messages, anthropic ?? getClient(), { aiEdit: Boolean(editor) });
      res.json(result);
    } catch (error) {
      const { status, message } = describeError(error);
      console.error(`[chat] ${status}: ${error?.message ?? error}`);
      res.status(status).json({ error: message });
    }
  });

  // Chỉnh sửa ảnh bằng AI: nhận ảnh (base64) + chỉ dẫn, trả ảnh kết quả (base64).
  app.post('/api/ai-edit', async (req, res) => {
    if (!editor) {
      return res.status(501).json({ error: 'Chưa bật chỉnh sửa bằng AI: thêm HF_TOKEN (token Hugging Face) vào file .env rồi khởi động lại server.' });
    }
    const problem = checkAiEditBody(req.body);
    if (problem) return res.status(400).json({ error: problem });
    const started = Date.now();
    try {
      const out = await editor({
        buffer: Buffer.from(req.body.image, 'base64'),
        mimeType: req.body.mime_type,
        instruction: req.body.instruction.trim(),
      });
      console.log(`[ai-edit] ${((Date.now() - started) / 1000).toFixed(1)}s: ${req.body.instruction.slice(0, 80)}`);
      res.json({ image: out.buffer.toString('base64'), mime_type: out.mimeType });
    } catch (error) {
      const { status, message } = describeAiError(error);
      console.error(`[ai-edit] ${status}: ${error?.message ?? error}`);
      res.status(status).json({ error: message });
    }
  });

  // Lỗi body JSON quá lớn / sai định dạng.
  app.use((err, _req, res, _next) => {
    const status = err.status ?? 500;
    const message = err.type === 'entity.too.large'
      ? 'Cuộc trò chuyện quá lớn để gửi. Bấm "Trò chuyện mới" để bắt đầu lại.'
      : `Lỗi server: ${err.message}`;
    res.status(status).json({ error: message });
  });

  return app;
}
