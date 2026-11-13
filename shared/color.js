// Sinh mã Action Manager (app.executeAction) cho các thao tác màu, và các preset chỉnh màu (color grading).
// Mọi hàm ở đây chạy trên layer đang chọn và tôn trọng vùng chọn hiện tại; mỗi lần gọi = một bước lịch sử.
// Đã kiểm chứng trên Photopea thật (2026-11): Color Balance, Curves/Levels từng kênh R/G/B,
// Hue/Saturation theo dải màu, Vibrance đều thay đổi pixel đúng như mong đợi.

import { num } from './script-kit.js';

const CHANNEL_IDS = { rgb: 'Cmps', red: 'Rd  ', green: 'Grn ', blue: 'Bl  ' };

// Dải màu cho Hue/Saturation (giống Photoshop): [LclR, BgnR, BgnS, EndS, EndR]
const HUE_RANGES = {
  reds: [1, 315, 345, 15, 45],
  yellows: [2, 15, 45, 75, 105],
  greens: [3, 75, 105, 135, 165],
  cyans: [4, 135, 165, 195, 225],
  blues: [5, 195, 225, 255, 285],
  magentas: [6, 255, 285, 315, 345],
};
export const COLOR_RANGES = ['all', ...Object.keys(HUE_RANGES)];

let uid = 0;
const v = (name) => `__${name}${++uid}`;

const chanRef = (ref, channel) =>
  `var ${ref} = new ActionReference(); ${ref}.putEnumerated(_c('Chnl'), _c('Chnl'), _c(${JSON.stringify(CHANNEL_IDS[channel])}));`;

/**
 * Curves trên một hoặc nhiều kênh trong một bước.
 * @param {{ rgb?: number[][], red?: number[][], green?: number[][], blue?: number[][] }} curves
 */
export function amCurves(curves) {
  const d = v('d'), list = v('l');
  const parts = [`var ${d} = new ActionDescriptor(); var ${list} = new ActionList();`];
  for (const [channel, points] of Object.entries(curves)) {
    if (!points) continue;
    const a = v('a'), ref = v('r'), pts = v('p');
    parts.push(`var ${a} = new ActionDescriptor(); ${chanRef(ref, channel)} ${a}.putReference(_c('Chnl'), ${ref});`);
    parts.push(`var ${pts} = new ActionList();`);
    for (const [x, y] of [...points].sort((p, q) => p[0] - q[0])) {
      const p = v('pt');
      parts.push(`var ${p} = new ActionDescriptor(); ${p}.putDouble(_c('Hrzn'), ${num(x)}); ${p}.putDouble(_c('Vrtc'), ${num(y)}); ${pts}.putObject(_c('Pnt '), ${p});`);
    }
    parts.push(`${a}.putList(_c('Crv '), ${pts}); ${list}.putObject(_c('CrvA'), ${a});`);
  }
  parts.push(`${d}.putList(_c('Adjs'), ${list}); app.executeAction(_c('Crvs'), ${d}, DialogModes.NO);`);
  return parts.join('\n');
}

/** Levels trên một kênh. */
export function amLevels({ channel = 'rgb', inputBlack = 0, inputWhite = 255, gamma = 1, outputBlack = 0, outputWhite = 255 }) {
  const d = v('d'), list = v('l'), a = v('a'), ref = v('r'), inp = v('i'), out = v('o');
  return `var ${d} = new ActionDescriptor(); var ${list} = new ActionList(); var ${a} = new ActionDescriptor();
${chanRef(ref, channel)} ${a}.putReference(_c('Chnl'), ${ref});
var ${inp} = new ActionList(); ${inp}.putInteger(${num(inputBlack)}); ${inp}.putInteger(${num(inputWhite)}); ${a}.putList(_c('Inpt'), ${inp});
${a}.putDouble(_c('Gmm '), ${num(gamma)});
var ${out} = new ActionList(); ${out}.putInteger(${num(outputBlack)}); ${out}.putInteger(${num(outputWhite)}); ${a}.putList(_c('Otpt'), ${out});
${list}.putObject(_c('LvlA'), ${a}); ${d}.putList(_c('Adjs'), ${list});
app.executeAction(_c('Lvls'), ${d}, DialogModes.NO);`;
}

/**
 * Color Balance. Mỗi vùng là [cyan↔red, magenta↔green, yellow↔blue], từ -100 đến 100.
 */
export function amColorBalance({ shadows = [0, 0, 0], midtones = [0, 0, 0], highlights = [0, 0, 0], preserveLuminosity = true }) {
  const d = v('d');
  const lst = (name, values) => {
    const l = v('cb');
    return `var ${l} = new ActionList(); ${values.map((x) => `${l}.putInteger(${num(Math.round(x))});`).join(' ')} ${d}.putList(_c(${JSON.stringify(name)}), ${l});`;
  };
  return `var ${d} = new ActionDescriptor();
${lst('ShdL', shadows)}
${lst('MdtL', midtones)}
${lst('HghL', highlights)}
${d}.putBoolean(_c('PrsL'), ${preserveLuminosity ? 'true' : 'false'});
app.executeAction(_c('ClrB'), ${d}, DialogModes.NO);`;
}

/** Hue/Saturation, có thể giới hạn trong một dải màu (reds, blues...). */
export function amHueSaturation({ hue = 0, saturation = 0, lightness = 0, colorize = false, range = 'all' }) {
  const d = v('d'), list = v('l'), a = v('a');
  const r = HUE_RANGES[range];
  const rangeCode = r && !colorize
    ? `${a}.putInteger(_c('LclR'), ${r[0]}); ${a}.putInteger(_c('BgnR'), ${r[1]}); ${a}.putInteger(_c('BgnS'), ${r[2]}); ${a}.putInteger(_c('EndS'), ${r[3]}); ${a}.putInteger(_c('EndR'), ${r[4]});`
    : '';
  return `var ${d} = new ActionDescriptor(); ${d}.putBoolean(_c('Clrz'), ${colorize ? 'true' : 'false'});
var ${list} = new ActionList(); var ${a} = new ActionDescriptor();
${rangeCode}
${a}.putInteger(_c('H   '), ${num(Math.round(hue))}); ${a}.putInteger(_c('Strt'), ${num(Math.round(saturation))}); ${a}.putInteger(_c('Lght'), ${num(Math.round(lightness))});
${list}.putObject(_c('Hst2'), ${a}); ${d}.putList(_c('Adjs'), ${list});
app.executeAction(_c('HStr'), ${d}, DialogModes.NO);`;
}

export function amVibrance({ vibrance = 0, saturation = 0 }) {
  const d = v('d');
  return `var ${d} = new ActionDescriptor(); ${d}.putInteger(_s('vibrance'), ${num(Math.round(vibrance))}); ${d}.putInteger(_c('Strt'), ${num(Math.round(saturation))});
app.executeAction(_s('vibrance'), ${d}, DialogModes.NO);`;
}

// ───────────────────────────── Preset chỉnh màu ─────────────────────────────

/** Kéo các điểm curve về đường thẳng theo độ mạnh s (0..1). */
const lerpCurve = (points, s) => points.map(([x, y]) => [x, Math.round(x + (y - x) * s)]);
const scale = (values, s) => values.map((x) => Math.round(x * s));

/**
 * Mỗi preset trả về danh sách bước (mỗi bước là mã AM) theo độ mạnh s (0..1).
 * Giá trị được chọn bảo thủ; strength 100 = đúng như định nghĩa.
 */
export const COLOR_PRESETS = {
  cinematic: {
    label: 'Điện ảnh: bóng tối xanh ngọc, vùng sáng cam (teal & orange)',
    steps: (s) => [
      amCurves({ rgb: lerpCurve([[0, 0], [64, 56], [192, 200], [255, 255]], s) }),
      amColorBalance({ shadows: scale([-18, 0, 22], s), midtones: scale([4, 0, -4], s), highlights: scale([18, 0, -22], s) }),
    ],
  },
  vintage: {
    label: 'Cổ điển: nâng vùng tối, ngả vàng, giảm màu',
    steps: (s) => [
      amCurves({ rgb: lerpCurve([[0, 30], [128, 128], [255, 232]], s), blue: lerpCurve([[0, 20], [255, 225]], s) }),
      amColorBalance({ shadows: scale([8, 0, -10], s), highlights: scale([10, 0, -18], s) }),
      amHueSaturation({ saturation: -25 * s }),
    ],
  },
  warm: {
    label: 'Ấm áp: tông vàng cam nhẹ như nắng chiều',
    steps: (s) => [
      amColorBalance({ midtones: scale([14, 2, -20], s), highlights: scale([6, 0, -10], s) }),
      amVibrance({ vibrance: 10 * s }),
    ],
  },
  cool_moody: {
    label: 'Lạnh, trầm: tông xanh, tối hơn, ít màu',
    steps: (s) => [
      amCurves({ rgb: lerpCurve([[0, 0], [128, 112], [255, 245]], s) }),
      amColorBalance({ shadows: scale([-8, 0, 12], s), midtones: scale([-10, 0, 14], s) }),
      amHueSaturation({ saturation: -20 * s }),
    ],
  },
  korean: {
    label: 'Tông Hàn Quốc: sáng, trong, tương phản thấp, hơi hồng',
    steps: (s) => [
      amCurves({ rgb: lerpCurve([[0, 18], [128, 150], [255, 255]], s) }),
      amColorBalance({ midtones: scale([3, -2, 0], s), highlights: scale([6, -4, 4], s) }),
      amHueSaturation({ saturation: -12 * s }),
    ],
  },
  faded_matte: {
    label: 'Phai màu, mờ đục (matte)',
    steps: (s) => [
      amCurves({ rgb: lerpCurve([[0, 40], [64, 74], [192, 190], [255, 240]], s) }),
      amHueSaturation({ saturation: -18 * s }),
    ],
  },
  bw_dramatic: {
    label: 'Đen trắng tương phản mạnh',
    steps: (s) => [
      amHueSaturation({ saturation: -100 * s }),
      amCurves({ rgb: lerpCurve([[0, 0], [64, 45], [192, 210], [255, 255]], s) }),
    ],
  },
  vivid: {
    label: 'Rực rỡ: màu tươi, tương phản vừa',
    steps: (s) => [
      amVibrance({ vibrance: 35 * s, saturation: 8 * s }),
      amCurves({ rgb: lerpCurve([[0, 0], [64, 58], [192, 198], [255, 255]], s) }),
    ],
  },
};
