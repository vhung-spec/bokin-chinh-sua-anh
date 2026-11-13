// Kiểm tra đầu vào của tool theo JSON Schema (chỉ phần con mà tools.js dùng):
// type, enum, required, properties, additionalProperties:false, items, minItems/maxItems, minimum/maximum.
// Trả về mảng thông báo lỗi; mảng rỗng = hợp lệ.

export function validate(value, schema, path = 'input') {
  const errors = [];
  check(value, schema, path, errors);
  return errors;
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function check(v, s, path, errors) {
  if (!s) return;
  const t = typeOf(v);
  if (s.type) {
    const ok = s.type === 'number' ? t === 'number' || t === 'integer' : t === s.type;
    if (!ok) {
      errors.push(`${path}: cần kiểu ${s.type}, nhận được ${t}`);
      return;
    }
  }
  if (s.enum && !s.enum.includes(v)) errors.push(`${path}: phải là một trong ${s.enum.join(', ')}`);
  if (t === 'number' || t === 'integer') {
    if (!Number.isFinite(v)) errors.push(`${path}: không phải số hữu hạn`);
    if (s.minimum !== undefined && v < s.minimum) errors.push(`${path}: phải >= ${s.minimum}`);
    if (s.maximum !== undefined && v > s.maximum) errors.push(`${path}: phải <= ${s.maximum}`);
  }
  if (t === 'array') {
    if (s.minItems !== undefined && v.length < s.minItems) errors.push(`${path}: cần ít nhất ${s.minItems} phần tử`);
    if (s.maxItems !== undefined && v.length > s.maxItems) errors.push(`${path}: tối đa ${s.maxItems} phần tử`);
    if (s.items) v.forEach((item, i) => check(item, s.items, `${path}[${i}]`, errors));
  }
  if (t === 'object') {
    const props = s.properties ?? {};
    for (const key of s.required ?? []) {
      if (v[key] === undefined) errors.push(`${path}.${key}: bắt buộc`);
    }
    for (const [key, val] of Object.entries(v)) {
      if (props[key]) check(val, props[key], `${path}.${key}`, errors);
      else if (s.additionalProperties === false) errors.push(`${path}.${key}: tham số không được hỗ trợ`);
    }
  }
}
