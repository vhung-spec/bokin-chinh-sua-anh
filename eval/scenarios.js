// Các tình huống đánh giá: câu lệnh tiếng Việt + cách kiểm tra kết quả tự động.
//
// setup:
//   'photo'    -> trò chuyện mới, mở ảnh mẫu (bầu trời, bãi cỏ, quả bóng đỏ; hơi tối, có nhiễu)
//   'empty'    -> trò chuyện mới, không mở ảnh nào
//   'continue' -> tiếp tục cuộc trò chuyện của tình huống trước
// check(before, after, ctx) trả về chuỗi lỗi (thất bại) hoặc null (đạt).
//   before/after: kết quả analyze() (kích thước, màu trung bình, độ bão hoà, vị trí bóng đỏ, độ nét...)
//   ctx.info(): get_document_info; ctx.textColor(name): mã màu của layer chữ

const near = (a, b, tol) => Math.abs(a - b) <= tol;
const textLayers = (info) => (info.layers ?? []).filter((l) => l.type === 'text');
const normalize = (s) => String(s).normalize('NFC').toLowerCase();

export const SCENARIOS = [
  {
    id: 'lam-sang',
    setup: 'photo',
    prompt: 'Ảnh này hơi tối, bạn làm sáng lên giúp mình nhé',
    check: (b, a) => (a.mean >= b.mean + 8 ? null : `độ sáng trung bình ${b.mean} -> ${a.mean} (cần tăng >= 8)`),
  },
  {
    id: 'den-trang',
    setup: 'photo',
    prompt: 'Chuyển ảnh sang đen trắng',
    check: (b, a) => (a.saturation <= 8 ? null : `độ bão hoà còn ${a.saturation}`),
  },
  {
    id: 'cat-vuong',
    setup: 'photo',
    prompt: 'Cắt ảnh thành hình vuông, giữ quả bóng đỏ ở giữa khung hình',
    check: (b, a) => {
      if (!near(a.width, a.height, 2)) return `chưa vuông: ${a.width}x${a.height}`;
      if (a.red.count < 1000) return 'mất quả bóng đỏ';
      if (Math.abs(a.red.cx - a.width / 2) > a.width * 0.2) return `bóng lệch tâm: cx=${a.red.cx}, rộng ${a.width}`;
      return null;
    },
  },
  {
    id: 'them-chu',
    setup: 'photo',
    prompt: 'Thêm dòng chữ KHAI TRƯƠNG màu vàng, thật to ở phía trên ảnh',
    check: async (b, a, ctx) => {
      const info = await ctx.info();
      const t = textLayers(info).find((l) => normalize(l.text).includes('khai trương'));
      if (!t) return 'không thấy layer chữ "KHAI TRƯƠNG"';
      const { x, y, width, height } = t.bounds;
      if (x < 0 || y < 0 || x + width > a.width + 1 || y + height > a.height + 1) return `chữ tràn ra ngoài ảnh: ${JSON.stringify(t.bounds)}`;
      if (y + height / 2 > a.height / 2) return `chữ không ở nửa trên: ${JSON.stringify(t.bounds)}`;
      if (width < a.width * 0.3) return `chữ chưa đủ to: rộng ${width}px`;
      const c = await ctx.textColor(t.name);
      if (!(c.r > 180 && c.g > 150 && c.b < 120)) return `màu chữ không phải vàng: ${c.hex}`;
      return null;
    },
  },
  {
    id: 'doi-mau-chu',
    setup: 'continue',
    prompt: 'Đổi chữ đó sang màu đỏ',
    check: async (b, a, ctx) => {
      const t = textLayers(await ctx.info())[0];
      if (!t) return 'mất layer chữ';
      const c = await ctx.textColor(t.name);
      return c.r > 180 && c.g < 100 && c.b < 100 ? null : `màu chữ ${c.hex}, chưa phải đỏ`;
    },
  },
  {
    id: 'hoan-tac',
    setup: 'continue',
    prompt: 'Thôi, hoàn tác lại bước vừa rồi',
    check: async (b, a, ctx) => {
      const t = textLayers(await ctx.info())[0];
      if (!t) return 'mất layer chữ';
      const c = await ctx.textColor(t.name);
      return c.r > 180 && c.g > 150 ? null : `màu chữ ${c.hex}, chưa về màu vàng`;
    },
  },
  {
    id: 'thu-nho',
    setup: 'photo',
    prompt: 'Thu nhỏ ảnh xuống chiều rộng 600px',
    check: (b, a) => (a.width === 600 && near(a.height, 400, 1) ? null : `kích thước ${a.width}x${a.height}`),
  },
  {
    id: 'vien-trang',
    setup: 'photo',
    prompt: 'Thêm viền trắng 30px xung quanh ảnh',
    check: (b, a) => {
      if (a.width !== b.width + 60 || a.height !== b.height + 60) return `kích thước ${a.width}x${a.height}`;
      return a.corner.r > 245 && a.corner.g > 245 && a.corner.b > 245 && a.corner.a === 255 ? null : `góc ảnh không trắng: ${JSON.stringify(a.corner)}`;
    },
  },
  {
    id: 'mo-nen',
    setup: 'photo',
    prompt: 'Làm mờ phần nền nhưng giữ quả bóng đỏ sắc nét',
    check: (b, a) => {
      if (a.sharpness.background > b.sharpness.background * 0.7) return `nền chưa mờ: ${b.sharpness.background} -> ${a.sharpness.background}`;
      if (a.sharpness.ball < b.sharpness.ball * 0.7) return `quả bóng bị mờ: ${b.sharpness.ball} -> ${a.sharpness.ball}`;
      return null;
    },
  },
  {
    id: 'bia-facebook',
    setup: 'empty',
    prompt: "Tạo ảnh bìa Facebook nền xanh đậm, có chữ 'Khai trương' màu trắng ở giữa",
    check: async (b, a, ctx) => {
      if (!a) return 'không có tài liệu nào';
      const ratio = a.width / a.height;
      if (ratio < 1.7 || ratio > 2.8) return `tỉ lệ ${a.width}x${a.height} không giống ảnh bìa`;
      if (!(a.b > a.r + 20)) return `nền không xanh: ${JSON.stringify({ r: a.r, g: a.g, b: a.b })}`;
      const t = textLayers(await ctx.info()).find((l) => normalize(l.text).includes('khai trương'));
      if (!t) return 'không thấy chữ "Khai trương"';
      const cx = t.bounds.x + t.bounds.width / 2;
      return Math.abs(cx - a.width / 2) <= a.width * 0.15 ? null : `chữ lệch tâm: cx=${cx}`;
    },
  },
  {
    id: 'xoa-bong-ai',
    setup: 'photo',
    requires: 'ai_edit', // chỉ chạy khi server có HF_TOKEN
    prompt: 'Xoá quả bóng đỏ khỏi ảnh',
    check: (b, a) => (a.red.count < b.red.count * 0.2 ? null : `vẫn còn bóng đỏ: ${b.red.count} -> ${a.red.count} pixel đỏ`),
  },
  {
    id: 'tuong-phan-net',
    setup: 'photo',
    prompt: 'Tăng tương phản rồi làm nét ảnh',
    check: (b, a) => {
      if (a.std <= b.std) return `tương phản không tăng: std ${b.std} -> ${a.std}`;
      return a.sharpness.background > b.sharpness.background ? null : `không nét hơn: ${b.sharpness.background} -> ${a.sharpness.background}`;
    },
  },
];
