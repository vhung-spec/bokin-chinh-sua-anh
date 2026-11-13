import { createApp } from './app.js';
import { config } from './chat.js';

const port = Number(process.env.PORT) || 3000;
// Mặc định chỉ nghe trên máy này: server dùng API key của bạn, đừng mở ra mạng ngoài
// nếu chưa có đăng nhập/giới hạn truy cập.
const host = process.env.HOST || '127.0.0.1';

createApp().listen(port, host, () => {
  console.log(`Bokin đang chạy: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
  console.log(`Model: ${config.model} (effort: ${config.effort})`);
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.warn('Chưa có ANTHROPIC_API_KEY. Sao chép .env.example thành .env và điền key của bạn.');
  }
});
