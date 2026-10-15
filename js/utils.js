// Общие константы, форматтеры, загрузка данных и тултип
/* global d3 */

export const SERVICE = 'Услуги Груши';
export const DELIVERED = 'доставлен';

const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MONTHS_FULL = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const MONTHS_DAT = ['январю', 'февралю', 'марту', 'апрелю', 'маю', 'июню', 'июлю', 'августу', 'сентябрю', 'октябрю', 'ноябрю', 'декабрю'];
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

const ru = d3.formatLocale({ decimal: ',', thousands: ' ', grouping: [3], currency: ['', ' ₽'] });
const fInt = ru.format(',.0f');
const fPct1 = ru.format('.1f');

export const fmt = {
  int: (v) => (v == null || Number.isNaN(v) ? '-' : fInt(v)),
  rub: (v) => (v == null || Number.isNaN(v) ? '-' : fInt(v) + ' ₽'),
  // 41 250 → «41,3 тыс ₽»; для крупных значений на осях
  rubShort: (v) => {
    if (v == null) return '-';
    if (Math.abs(v) >= 1e6) return fPct1(v / 1e6) + ' млн ₽';
    if (Math.abs(v) >= 1e3) return fPct1(v / 1e3).replace(/,0$/, '') + ' тыс ₽';
    return fInt(v) + ' ₽';
  },
  axisRub: (v) => (v >= 1000 ? fInt(v / 1000) + ' тыс' : fInt(v)),
  pct: (v, digits = 1) => (v == null || Number.isNaN(v) ? '-' : ru.format(`.${digits}f`)(v * 100) + ' %'),
  pp: (v) => ru.format('+.1f')(v * 100).replace('-', '−') + ' п. п.',
  signedPct: (v) => (v == null || !Number.isFinite(v) ? '-' : ru.format('+.0f')(v * 100).replace('-', '−') + ' %'),
  monthShort: (key) => MONTHS_SHORT[+key.slice(5, 7) - 1],
  monthLabel: (key) => `${MONTHS_SHORT[+key.slice(5, 7) - 1]} ${key.slice(0, 4)}`,
  monthFull: (key) => `${MONTHS_FULL[+key.slice(5, 7) - 1]} ${key.slice(0, 4)}`,
  monthDat: (key) => `${MONTHS_DAT[+key.slice(5, 7) - 1]} ${key.slice(0, 4)}`,
  dayLabel: (date) => `${date.getDate()} ${MONTHS_GEN[date.getMonth()]} ${date.getFullYear()}`,
  plural: (n, one, few, many) => {
    const n10 = n % 10, n100 = n % 100;
    if (n10 === 1 && n100 !== 11) return one;
    if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return few;
    return many;
  },
};

// ключ месяца 'YYYY-MM' → соседние месяцы
export function shiftMonth(key, delta) {
  const y = +key.slice(0, 4), m = +key.slice(5, 7) - 1 + delta;
  const d = new Date(y, m, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function monthRange(first, last) {
  const out = [];
  for (let k = first; k <= last; k = shiftMonth(k, 1)) out.push(k);
  return out;
}

const parseDay = d3.timeParse('%Y-%m-%d');

export async function loadData() {
  const [rows, items] = await Promise.all([
    d3.csv('data/orders.csv', (d) => ({
      id: d.order_id,
      day: d.order_date,
      date: parseDay(d.order_date),
      month: d.order_date.slice(0, 7),
      status: d.status,
      item: d.item_name,
      cat: d.category,
      price: +d.price,
      priceD: +d.price_discounted,
      disc: +d.discount,
      qty: +d.quantity,
      amount: +d.amount,
      service: d.category === SERVICE,
    })),
    d3.csv('data/items.csv'),
  ]);
  const images = new Map(items.map((d) => [d.item_name, d.image]));
  return { rows, images };
}

// Метрики по набору строк одного месяца (или любого среза)
export function summarize(lines) {
  const orders = new Set();
  let spend = 0, base = 0, disc = 0;
  for (const r of lines) {
    orders.add(r.id);
    spend += r.amount;
    if (!r.service) {
      base += r.price * r.qty;
      disc += r.disc * r.qty;
    }
  }
  const n = orders.size;
  return {
    orders: n,
    spend,
    check: n ? spend / n : null,
    discount: base ? disc / base : null,
    saved: disc,
  };
}

// ---------- Тултип: один на страницу, контент собирается через DOM (textContent) ----------
let tipEl = null;
function tip() {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'tip';
    tipEl.setAttribute('role', 'tooltip');
    document.body.appendChild(tipEl);
  }
  return tipEl;
}

export function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export function showTip(build, event) {
  const t = tip();
  t.replaceChildren();
  build(t);
  t.classList.add('on');
  moveTip(event);
}

export function moveTip(event) {
  if (!tipEl || !event) return;
  const pad = 14;
  const r = tipEl.getBoundingClientRect();
  let x, y, ax;
  if (event.type !== 'focus' && event.clientX != null) {
    ax = event.clientX;
    x = event.clientX + pad;
    y = event.clientY + pad;
  } else {
    const b = event.target.getBoundingClientRect();
    ax = b.left;
    x = b.right + pad;
    y = b.top;
  }
  if (x + r.width > window.innerWidth - 8) x = Math.max(8, ax - r.width - pad);
  if (y + r.height > window.innerHeight - 8) y = Math.max(8, window.innerHeight - r.height - 8);
  tipEl.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}

export function hideTip() {
  if (tipEl) tipEl.classList.remove('on');
}

// Повторно используемый ResizeObserver для компонентов-графиков
export function observeWidth(node, cb) {
  const ro = new ResizeObserver((entries) => {
    const w = Math.floor(entries[0].contentRect.width);
    if (w > 0) cb(w);
  });
  ro.observe(node);
  return () => ro.disconnect();
}
