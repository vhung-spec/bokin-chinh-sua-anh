// Lệnh ngắn trong ô chat mà Bokin tự làm ngay, không gọi Claude (tức thì, không tốn phí): hoàn tác, làm lại,
// bỏ chọn, đảo vùng chọn, tải ảnh, xem ảnh gốc, "mạnh hơn" / "nhẹ hơn" và "bỏ chỉnh <tên>" cho các lần chỉnh vùng.
// Chỉ nhận câu ngắn, đúng mẫu; câu khác (hay câu có thêm ý: "đậm hơn và ấm hơn") vẫn gửi Claude.
// Dùng chung cho trình duyệt (public/app.js) và kiểm thử Node.

/** Chữ thường, bỏ dấu tiếng Việt (gõ không dấu vẫn nhận), gộp khoảng trắng, bỏ dấu câu ở hai đầu. */
export function fold(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[“”"'`]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.,!?;:…-]+|[\s.,!?;:…-]+$/g, '')
    .trim();
}

// Lời lịch sự ở hai đầu câu (đã bỏ dấu): "bạn ơi", "giúp mình", "nhé"…
const POLITE = /^(?:(?:ban |bokin |oi |nho |hay |vui long |giup (?:minh|toi|em) |lam on )+)|(?: (?:giup|cho|ho) (?:minh|toi|em|voi)| voi| nhe| nha| di| oi| dum| giup)+$/g;

const MAX_LENGTH = 60; // câu dài hơn là có ý khác: để Claude hiểu

// Từ chỉ mức: "một chút" → nhỏ, mặc định → vừa, "nhiều" → lớn.
const STRONGER = { small: 1.25, normal: 1.4, big: 1.8 };
const WEAKER = { small: 0.8, normal: 0.7, big: 0.5 };
const AMOUNT = [
  [/(?:^| )(?:mot )?(?:chut|ti|xiu|it|chut xiu|ti xiu|ti nua|chut nua)$/, 'small'],
  [/(?:^| )(?:nhieu|han|that nhieu|nhieu nua|gap doi|rat nhieu)$/, 'big'],
];

const FORMATS = { jpg: 'jpg', jpeg: 'jpg', png: 'png', webp: 'webp', psd: 'psd' };

/**
 * Đọc một câu trong ô chat thành lệnh làm tại chỗ, hoặc null nếu phải gửi Claude.
 * @param {string} text
 * @param {{ edits?: string[], last?: string|null }} [context] - edits: tên các lần chỉnh vùng đang có (lần gần nhất
 *   đứng cuối); last: lần chỉnh mà "mạnh hơn" không kèm tên nói tới (thao tác gần nhất là lần chỉnh vùng đó), null =
 *   thao tác gần nhất không phải chỉnh vùng (để Claude hiểu), mặc định lần chỉnh cuối
 * @returns {null | { kind: 'undo'|'redo', steps: number } | { kind: 'deselect'|'invert'|'compare' }
 *   | { kind: 'export', format: string } | { kind: 'scale', name: string, factor: number }
 *   | { kind: 'remove', name: string }}
 */
export function parseQuickCommand(text, { edits = [], last } = {}) {
  if (String(text ?? '').length > MAX_LENGTH) return null;
  let t = fold(text).replace(POLITE, '').trim();
  if (!t || /[,;]| va | roi | sau do | them /.test(` ${t} `)) return null;

  let m = t.match(/^(?:hoan tac|undo|ctrl ?z|huy buoc vua (?:roi|lam)|quay lai buoc truoc)(?: (\d+|mot|hai|ba) (?:buoc|lan))?$/);
  if (m) return { kind: 'undo', steps: count(m[1]) };
  m = t.match(/^(?:lam lai|redo|ctrl ?y)(?: (\d+|mot|hai|ba) (?:buoc|lan))?$/);
  if (m) return { kind: 'redo', steps: count(m[1]) };
  if (/^(?:bo|huy|xoa) (?:vung )?chon$|^deselect$/.test(t)) return { kind: 'deselect' };
  if (/^dao (?:nguoc )?(?:vung )?chon$|^dao vung$|^chon phan con lai$/.test(t)) return { kind: 'invert' };
  if (/^(?:so sanh|xem (?:lai )?(?:anh )?goc|xem truoc sau|so sanh (?:voi )?(?:anh )?goc|so sanh truoc sau)$/.test(t)) return { kind: 'compare' };
  m = t.match(/^(?:tai|luu|xuat)(?: anh)?(?: (?:ve|ve may|xuong))?(?: (?:dang|file|kieu|duoi|ban))?(?: (jpe?g|png|webp|psd))?$/);
  if (m) return { kind: 'export', format: FORMATS[m[1] ?? 'jpg'] };

  // Bỏ hẳn một lần chỉnh vùng: "bỏ chỉnh áo", "xoá chỉnh bầu trời".
  m = t.match(/^(?:bo|xoa|go|huy) (?:lop )?(?:chinh|lan chinh|phan chinh)(?: (?:mau|vung))? (.+)$/);
  if (m) {
    const name = findEdit(m[1], edits);
    return name ? { kind: 'remove', name } : null;
  }

  // "mạnh hơn", "áo nhẹ hơn chút", "chỉnh bầu trời mạnh hơn nữa". Chỉ từ chỉ mức của hiệu ứng: "đậm/nhạt hơn",
  // "sáng hơn"… là ý về màu (sau khi giảm màu, "đậm hơn" là giảm bớt), để Claude hiểu.
  m = t.match(/^(?:(?:lam|cho|chinh) )?(?:(.+?) )?(manh|nhe|diu)(?: tay)? hon(?: (.+))?$/);
  if (!m) return null;
  const tail = (m[3] ?? '').replace(/(?:^| )nua$/, '').trim();
  let size = 'normal';
  if (tail) {
    const hit = AMOUNT.find(([re]) => re.test(` ${tail}`));
    if (!hit) return null;
    size = hit[1];
  }
  let name = last === undefined ? edits.at(-1) : last;
  if (m[1]) {
    // Có nói tên vùng: phải đúng một lần chỉnh đang có ("áo đậm hơn"); "màu đậm hơn", "ảnh sáng hơn"… là ý khác.
    if (/^(?:mot )?(?:chut|ti|xiu)$/.test(m[1])) size = 'small';
    else name = findEdit(m[1], edits);
  }
  if (!name) return null;
  const stronger = m[2] === 'manh';
  return { kind: 'scale', name, factor: (stronger ? STRONGER : WEAKER)[size] };
}

/** Tên lần chỉnh khớp với cách người dùng gọi ("ao", "vung ao", "cai ao", "chinh ao"). */
function findEdit(spoken, edits) {
  const want = fold(spoken).replace(/^(?:lop |vung |cai |phan |mau |chinh |cho )+/, '').trim();
  if (!want) return null;
  const hits = edits.filter((name) => {
    const n = fold(name);
    return n === want || n.replace(/^(?:vung |cai |phan )+/, '') === want;
  });
  return hits.at(-1) ?? null;
}

function count(word) {
  if (!word) return 1;
  const n = { mot: 1, hai: 2, ba: 3 }[word] ?? Number(word);
  return Math.min(10, Math.max(1, Math.round(n) || 1));
}

/** Mức mới (%) sau "mạnh hơn" / "nhẹ hơn", trong 10-200; null nếu đã ở mức cuối (để Claude tự đổi giá trị). */
export function nextStrength(current, factor) {
  const now = Number(current) || 100;
  const next = Math.round(Math.min(200, Math.max(10, now * factor)) / 5) * 5;
  return next === now ? null : next;
}
