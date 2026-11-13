import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, runTurn, checkMessages, describeError, getClient } from './chat.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Tạo ứng dụng Express.
 * @param {{ anthropic?: import('@anthropic-ai/sdk').default }} [options] - cho phép truyền client giả khi kiểm thử.
 */
export function createApp({ anthropic } = {}) {
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
      has_api_key: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
    });
  });

  app.post('/api/chat', async (req, res) => {
    const messages = req.body?.messages;
    const problem = checkMessages(messages);
    if (problem) return res.status(400).json({ error: problem });
    try {
      const result = await runTurn(messages, anthropic ?? getClient());
      res.json(result);
    } catch (error) {
      const { status, message } = describeError(error);
      console.error(`[chat] ${status}: ${error?.message ?? error}`);
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
