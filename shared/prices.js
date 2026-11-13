// Bảng giá Claude (USD / 1 triệu token) dùng để ƯỚC TÍNH chi phí từ `usage` mà API trả về.
// [input, output, đọc cache, ghi cache 5 phút]. Cập nhật tháng 11/2026; xem bảng giá chính thức khi thay đổi.
export const PRICES = {
  'claude-opus-5-5': [4, 20, 0.2, 5],
  'claude-sonnet-5-5': [2, 10, 0.1, 2.5],
  'claude-haiku-5-5': [0.1, 0.5, 0.01, 0.125],
  // Model dự phòng có thể chạy khi yêu cầu bị bộ lọc an toàn từ chối
  'claude-opus-5': [5, 25, 0.5, 6.25],
  'claude-opus-4-8': [5, 25, 0.5, 6.25],
  'claude-sonnet-5': [2, 10, 0.2, 2.5],
};

/** Chi phí ước tính (USD) của một `usage`; null nếu không biết giá model. */
export function usageCost(usage) {
  const p = PRICES[usage?.model];
  if (!p) return null;
  return ((usage.input_tokens ?? 0) * p[0]
    + (usage.output_tokens ?? 0) * p[1]
    + (usage.cache_read_input_tokens ?? 0) * p[2]
    + (usage.cache_creation_input_tokens ?? 0) * p[3]) / 1e6;
}

/** Tổng chi phí của nhiều `usage` (bỏ qua model không rõ giá). */
export function totalCost(usages) {
  return usages.reduce((sum, u) => sum + (usageCost(u) ?? 0), 0);
}

/** Định dạng kiểu Việt Nam: "~0,012 USD". */
export function formatUsd(usd) {
  const digits = usd < 0.01 ? 4 : usd < 1 ? 3 : 2;
  return `~${usd.toFixed(digits).replace('.', ',')} USD`;
}
