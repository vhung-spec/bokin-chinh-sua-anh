// Gọi máy chủ của Bokin. Dùng được cả khi Bokin chạy riêng (npm start) lẫn khi trang được gắn vào một web app
// khác, dưới một đường dẫn con (ví dụ /chinhanh/) và sau một lớp đăng nhập:
//   * đường dẫn luôn TƯƠNG ĐỐI (api/chat, không phải /api/chat);
//   * mọi yêu cầu có header X-Bokin: 1 (máy chủ có thể chỉ nhận POST có header này, để trang web khác không gửi thay);
//   * việc lâu (Claude, AI tạo ảnh) có thể được trả về dạng { pending: "<mã>" }, rồi trang hỏi lại
//     api/result?id=<mã> tới khi xong: nhiều proxy (ví dụ Cloudflare) cắt yêu cầu chờ quá 100 giây.
// Máy chủ Node của repo này trả lời ngay, không dùng { pending }.

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const HEADERS = { 'X-Bokin': '1' };

function httpMessage(status) {
  if (status === 401 || status === 403) return 'Không có quyền, hoặc phiên đăng nhập đã hết hạn: hãy tải lại trang.';
  if (status === 502 || status === 503 || status === 504 || status === 524) return 'Máy chủ đang bận hoặc đang khởi động lại: thử lại sau ít phút.';
  return `Máy chủ trả lỗi HTTP ${status}.`;
}

async function send(path, init) {
  try {
    const res = await fetch(path, init);
    return { res, data: await res.json().catch(() => ({})) };
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    // Phiên đăng nhập Cloudflare hết hạn thì yêu cầu bị chuyển sang trang đăng nhập (khác tên miền): trình duyệt báo lỗi mạng.
    throw new ApiError('Không kết nối được máy chủ của Bokin (hoặc phiên đăng nhập đã hết hạn: hãy tải lại trang).', 0);
  }
}

function check({ res, data }) {
  if (!res.ok || (data && data.error)) throw new ApiError(data?.error || httpMessage(res.status), res.status);
  return data;
}

/** GET một đường dẫn tương đối, trả JSON (ném ApiError nếu lỗi). */
export async function getJson(path, { signal } = {}) {
  return check(await send(path, { headers: HEADERS, signal }));
}

/** POST JSON, chờ cả khi máy chủ trả "đang làm" ({ pending }); trả JSON kết quả (ném ApiError nếu lỗi). */
export async function postJson(path, body, { signal } = {}) {
  let out = await send(path, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  // Máy chủ giữ mỗi lần hỏi tối đa vài chục giây rồi trả lại { pending } nếu chưa xong: hỏi tiếp ngay.
  while (out.res.ok && out.data && typeof out.data.pending === 'string') {
    await new Promise((resolve) => setTimeout(resolve, 250));
    out = await send(`api/result?id=${encodeURIComponent(out.data.pending)}`, { headers: HEADERS, signal });
  }
  return check(out);
}
