// Vue-компоненты с d3-графиками
/* global d3 */
import { fmt, observeWidth } from './utils.js';

const { h, ref, onMounted, onBeforeUnmount, watch } = Vue;

// Хелпер: компонент рисует себя в <div>, перерисовывается при изменении props и ширины
function d3Component(name, props, draw, emits = []) {
  return {
    name,
    props,
    emits,
    setup(p, { emit }) {
      const root = ref(null);
      let width = 0;
      let stop = null;
      const render = () => { if (root.value && width) draw(root.value, p, width, emit); };
      onMounted(() => {
        width = root.value.clientWidth;
        render();
        stop = observeWidth(root.value, (w) => { if (w !== width) { width = w; render(); } });
      });
      onBeforeUnmount(() => stop && stop());
      watch(() => Object.values(p).map((v) => v), render, { deep: false });
      return () => h('div', { ref: root, class: `chart chart-${name}` });
    },
  };
}

// ---------------------------------------------------------------------------
// Помесячный график KPI: 24 столбика (аддитивные метрики) или линия (средние)
// ---------------------------------------------------------------------------
export const MonthChart = d3Component(
  'month',
  { points: Array, kind: String, active: String, color: String, format: Function, axisFormat: Function },
  (node, p, width, emit) => {
    const H = 132, m = { t: 14, r: 4, b: 26, l: 4 };
    const pts = p.points;
    const svg = d3.select(node).selectAll('svg').data([0]).join('svg')
      .attr('viewBox', `0 0 ${width} ${H}`).attr('width', width).attr('height', H)
      .attr('role', 'img');
    const x = d3.scaleBand().domain(pts.map((d) => d.month)).range([m.l, width - m.r]).paddingInner(0.28).paddingOuter(0.1);
    const vals = pts.map((d) => d.value).filter((v) => v != null);
    const max = d3.max(vals) || 1;
    const y = d3.scaleLinear().domain([0, max * 1.08]).nice(3).range([H - m.b, m.t]);
    const avg = d3.mean(vals);

    // сетка - 2 линии, подписи прямо над линией
    const ticks = y.ticks(3).filter((t) => t > 0);
    svg.selectAll('g.grid').data([0]).join('g').attr('class', 'grid')
      .selectAll('g').data(ticks).join((e) => { const g = e.append('g'); g.append('line'); g.append('text'); return g; })
      .call((g) => g.select('line').attr('x1', m.l).attr('x2', width - m.r).attr('y1', (d) => y(d)).attr('y2', (d) => y(d)))
      .call((g) => g.select('text').attr('x', m.l).attr('y', (d) => y(d) - 3).text((d) => p.axisFormat(d)));
    svg.select('g.grid').raise();

    svg.selectAll('line.base').data([0]).join('line').attr('class', 'base')
      .attr('x1', m.l).attr('x2', width - m.r).attr('y1', y(0)).attr('y2', y(0));

    // ось X: кварталы, январь подписывается годом
    const xt = pts.filter((d) => ['01', '04', '07', '10'].includes(d.month.slice(5)));
    svg.selectAll('g.xaxis').data([0]).join('g').attr('class', 'xaxis')
      .selectAll('text').data(xt, (d) => d.month).join('text')
      .attr('x', (d) => x(d.month) + x.bandwidth() / 2).attr('y', H - 8)
      .attr('class', (d) => (d.month.endsWith('-01') ? 'yr' : null))
      .text((d) => (d.month.endsWith('-01') ? d.month.slice(0, 4) : fmt.monthShort(d.month)));

    const marks = svg.selectAll('g.marks').data([0]).join('g').attr('class', 'marks');
    const color = p.color;
    if (p.kind === 'bar') {
      const r = Math.min(4, x.bandwidth() / 2);
      marks.selectAll('path.bar').data(pts.filter((d) => d.value), (d) => d.month).join('path')
        .attr('class', 'bar')
        .attr('fill', color)
        .attr('fill-opacity', (d) => (d.month === p.active ? 1 : 0.38))
        .attr('d', (d) => {
          const x0 = x(d.month), w = x.bandwidth(), y0 = y(0), y1 = y(d.value);
          const rr = Math.min(r, y0 - y1);
          return `M${x0},${y0}V${y1 + rr}Q${x0},${y1} ${x0 + rr},${y1}H${x0 + w - rr}Q${x0 + w},${y1} ${x0 + w},${y1 + rr}V${y0}Z`;
        });
      marks.selectAll('path.line, circle').remove();
    } else {
      const line = d3.line().defined((d) => d.value != null).x((d) => x(d.month) + x.bandwidth() / 2).y((d) => y(d.value)).curve(d3.curveMonotoneX);
      marks.selectAll('path.line').data([pts]).join('path').attr('class', 'line').attr('stroke', color).attr('d', line);
      const a = pts.find((d) => d.month === p.active && d.value != null);
      marks.selectAll('circle').data(a ? [a] : []).join('circle')
        .attr('r', 4.5).attr('fill', color).attr('cx', (d) => x(d.month) + x.bandwidth() / 2).attr('cy', (d) => y(d.value));
      marks.selectAll('path.bar').remove();
    }

    // средняя за 24 месяца
    const ag = svg.selectAll('g.avg').data(avg != null ? [avg] : []).join((e) => { const g = e.append('g').attr('class', 'avg'); g.append('line'); g.append('text'); return g; });
    ag.select('line').attr('x1', m.l).attr('x2', width - m.r).attr('y1', y(avg)).attr('y2', y(avg));
    ag.select('text').attr('x', width - m.r).attr('y', y(avg) - 4).attr('text-anchor', 'end').text(`среднее ${p.format(avg)}`);

    // курсор + зоны наведения на всю высоту
    const cur = svg.selectAll('line.cursor').data(p.active ? [p.active] : []).join('line').attr('class', 'cursor')
      .attr('x1', (d) => x(d) + x.bandwidth() / 2).attr('x2', (d) => x(d) + x.bandwidth() / 2).attr('y1', m.t - 6).attr('y2', H - m.b);
    cur.lower();
    const step = x.step();
    svg.selectAll('g.hits').data([0]).join('g').attr('class', 'hits')
      .selectAll('rect').data(pts, (d) => d.month).join('rect')
      .attr('x', (d) => x(d.month) - (step - x.bandwidth()) / 2).attr('width', step)
      .attr('y', 0).attr('height', H).attr('fill', 'transparent')
      .on('pointerenter', (e, d) => emit('hover', d.month))
      .on('pointerleave', () => emit('hover', null))
      .on('click', (e, d) => emit('pick', d.month));
  },
  ['hover', 'pick'],
);

// ---------------------------------------------------------------------------
// «Бабочка»: слева - сколько штук, справа - сколько рублей, в центре - товар с фото
// ---------------------------------------------------------------------------
export const ItemsButterfly = d3Component(
  'butterfly',
  { items: Array, sortBy: String },
  (node, p, width, emit) => {
    const minW = 620;
    const W = Math.max(width, minW);
    const rowH = 50, top = 34;
    const n = p.items.length;
    const H = top + n * rowH + 4;
    const C = Math.round(Math.min(330, Math.max(250, W * 0.36)));
    const side = (W - C) / 2;
    const roomL = 44, roomR = 84;
    const cx0 = side, cx1 = side + C; // границы центральной колонки

    const svg = d3.select(node).selectAll('svg').data([0]).join('svg')
      .attr('viewBox', `0 0 ${W} ${H}`).attr('width', W).attr('height', H);

    const xq = d3.scaleLinear().domain([0, d3.max(p.items, (d) => d.qty) || 1]).range([0, side - roomL - 10]);
    const xs = d3.scaleLinear().domain([0, d3.max(p.items, (d) => d.spend) || 1]).range([0, side - roomR - 10]);

    // заголовки сторон
    const heads = [
      { k: 'qty', x: cx0 - 6, anchor: 'end', t: 'Куплено, шт' },
      { k: 'spend', x: cx1 + 6, anchor: 'start', t: 'Потрачено, ₽' },
    ];
    svg.selectAll('text.head').data(heads).join('text').attr('class', (d) => `head ${d.k === p.sortBy ? 'on' : ''}`)
      .attr('x', (d) => d.x).attr('y', 16).attr('text-anchor', (d) => d.anchor).text((d) => d.t + (d.k === p.sortBy ? ' ↓' : ''));

    const clipId = 'imgclip';
    svg.selectAll('defs').data([0]).join('defs').selectAll('clipPath').data([0]).join('clipPath').attr('id', clipId)
      .attr('clipPathUnits', 'objectBoundingBox')
      .selectAll('rect').data([0]).join('rect').attr('width', 1).attr('height', 1).attr('rx', 0.2);

    const t = svg.transition().duration(550).ease(d3.easeCubicOut);
    const rows = svg.selectAll('g.row').data(p.items, (d) => d.item).join(
      (enter) => {
        const g = enter.append('g').attr('class', 'row').attr('opacity', 0)
          .attr('transform', (d, i) => `translate(0,${top + i * rowH})`);
        g.append('rect').attr('class', 'bg');
        g.append('path').attr('class', 'bq');
        g.append('path').attr('class', 'bs');
        g.append('text').attr('class', 'vq');
        g.append('text').attr('class', 'vs');
        g.append('rect').attr('class', 'tile');
        g.append('image').attr('clip-path', `url(#${clipId})`);
        g.append('text').attr('class', 'rank');
        g.append('text').attr('class', 'name');
        g.append('text').attr('class', 'sub');
        g.append('rect').attr('class', 'hit');
        return g;
      },
      (update) => update,
      (exit) => exit.transition(t).attr('opacity', 0).remove(),
    );
    rows.transition(t).attr('opacity', 1).attr('transform', (d, i) => `translate(0,${top + i * rowH})`);

    const bh = 18, by = (rowH - bh) / 2;
    const leftBar = (w) => { const x1 = cx0 - 6, x0 = x1 - w, r = Math.min(4, w); return `M${x1},${by}H${x0 + r}Q${x0},${by} ${x0},${by + r}V${by + bh - r}Q${x0},${by + bh} ${x0 + r},${by + bh}H${x1}Z`; };
    const rightBar = (w) => { const x0 = cx1 + 6, x1 = x0 + w, r = Math.min(4, w); return `M${x0},${by}H${x1 - r}Q${x1},${by} ${x1},${by + r}V${by + bh - r}Q${x1},${by + bh} ${x1 - r},${by + bh}H${x0}Z`; };

    rows.select('rect.bg').attr('x', 0).attr('y', 1).attr('width', W).attr('height', rowH - 2).attr('rx', 8).classed('on', false);
    rows.select('path.bq').attr('class', `bq ${p.sortBy === 'qty' ? 'lead' : ''}`).transition(t).attr('d', (d) => leftBar(Math.max(1, xq(d.qty))));
    rows.select('path.bs').attr('class', `bs ${p.sortBy === 'spend' ? 'lead' : ''}`).transition(t).attr('d', (d) => rightBar(Math.max(1, xs(d.spend))));
    rows.select('text.vq').attr('y', rowH / 2 + 4).attr('text-anchor', 'end').text((d) => fmt.int(d.qty))
      .transition(t).attr('x', (d) => cx0 - 12 - xq(d.qty));
    rows.select('text.vs').attr('y', rowH / 2 + 4).text((d) => fmt.rub(d.spend))
      .transition(t).attr('x', (d) => cx1 + 12 + xs(d.spend));

    const ix = cx0 + 34;
    rows.select('rect.tile').attr('x', ix).attr('y', 5).attr('width', 40).attr('height', 40).attr('rx', 8);
    rows.select('image').attr('href', (d) => d.img || '').attr('x', ix).attr('y', 5).attr('width', 40).attr('height', 40);
    rows.select('text.rank').attr('x', cx0 + 24).attr('y', rowH / 2 + 4).attr('text-anchor', 'end').text((d, i) => i + 1);
    const maxChars = Math.floor((C - 104) / 7.3);
    rows.select('text.name').attr('x', ix + 50).attr('y', 21)
      .text((d) => (d.item.length > maxChars ? d.item.slice(0, maxChars - 1).trimEnd() + '…' : d.item));
    rows.select('text.sub').attr('x', ix + 50).attr('y', 37)
      .text((d) => `${d.cat} · в ${fmt.int(d.orders)} ${fmt.plural(d.orders, 'заказе', 'заказах', 'заказах')}`);
    rows.select('rect.hit').attr('x', 0).attr('y', 0).attr('width', W).attr('height', rowH).attr('fill', 'transparent')
      .attr('tabindex', 0).attr('aria-label', (d) => `${d.item}: ${d.qty} шт, ${d.spend} ₽`)
      .on('pointerenter focus', function (e, d) { d3.select(this.parentNode).select('rect.bg').classed('on', true); emit('hover', d, e); })
      .on('pointermove', (e, d) => emit('move', d, e))
      .on('pointerleave blur', function () { d3.select(this.parentNode).select('rect.bg').classed('on', false); emit('hover', null); });
  },
  ['hover', 'move'],
);

// ---------------------------------------------------------------------------
// Спарклайн трат категории за 24 месяца
// ---------------------------------------------------------------------------
export const Sparkline = d3Component(
  'spark',
  { values: Array, color: String, active: Number },
  (node, p, width) => {
    const H = 30, pad = 3;
    const svg = d3.select(node).selectAll('svg').data([0]).join('svg')
      .attr('viewBox', `0 0 ${width} ${H}`).attr('width', width).attr('height', H).attr('aria-hidden', 'true');
    const x = d3.scaleLinear().domain([0, p.values.length - 1]).range([pad, width - pad]);
    const y = d3.scaleLinear().domain([0, d3.max(p.values) || 1]).range([H - pad, pad]);
    const area = d3.area().x((d, i) => x(i)).y0(H - pad).y1((d) => y(d)).curve(d3.curveMonotoneX);
    const line = d3.line().x((d, i) => x(i)).y((d) => y(d)).curve(d3.curveMonotoneX);
    svg.selectAll('path.a').data([p.values]).join('path').attr('class', 'a').attr('fill', p.color).attr('fill-opacity', 0.14).attr('d', area);
    svg.selectAll('path.l').data([p.values]).join('path').attr('class', 'l').attr('stroke', p.color).attr('fill', 'none').attr('stroke-width', 1.5).attr('d', line);
    const i = p.active ?? p.values.length - 1;
    svg.selectAll('circle').data([i]).join('circle').attr('r', 2.6).attr('fill', p.color).attr('cx', (d) => x(d)).attr('cy', (d) => y(p.values[d]));
  },
);

// ---------------------------------------------------------------------------
// Мини-график цены для тултипа товара
// ---------------------------------------------------------------------------
export function drawPriceHistory(container, hist, periodStart) {
  const W = 300, H = 104, m = { t: 12, r: 10, b: 20, l: 34 };
  const svg = d3.select(container).append('svg').attr('width', W).attr('height', H).attr('class', 'pricechart');
  const x = d3.scaleTime().domain(d3.extent(hist, (d) => d.date)).range([m.l, W - m.r]);
  if (hist.length === 1) x.domain([d3.timeMonth.offset(hist[0].date, -1), d3.timeMonth.offset(hist[0].date, 1)]);
  const lo = d3.min(hist, (d) => d.priceD), hi = d3.max(hist, (d) => d.price);
  const y = d3.scaleLinear().domain([lo * 0.9, hi * 1.05]).nice(3).range([H - m.b, m.t]);

  if (periodStart && periodStart > x.domain()[0]) {
    svg.append('rect').attr('class', 'period').attr('x', x(periodStart)).attr('y', m.t - 6)
      .attr('width', W - m.r - x(periodStart)).attr('height', H - m.b - m.t + 6);
  }
  svg.append('g').attr('class', 'ty').selectAll('g').data(y.ticks(3)).join('g')
    .call((g) => g.append('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', (d) => y(d)).attr('y2', (d) => y(d)))
    .call((g) => g.append('text').attr('x', m.l - 5).attr('y', (d) => y(d) + 3).attr('text-anchor', 'end').text((d) => fmt.int(d)));
  const years = d3.timeYear.range(d3.timeYear.ceil(x.domain()[0]), x.domain()[1]);
  svg.append('g').attr('class', 'tx').selectAll('text').data(years).join('text')
    .attr('x', (d) => x(d)).attr('y', H - 5).attr('text-anchor', 'middle').text((d) => d.getFullYear());

  const step = d3.line().x((d) => x(d.date)).y((d) => y(d.price)).curve(d3.curveStepAfter);
  svg.append('path').attr('class', 'shelf').attr('d', step(hist));
  svg.append('g').selectAll('circle').data(hist).join('circle')
    .attr('class', (d) => (d.disc > 0 ? 'paid sale' : 'paid'))
    .attr('cx', (d) => x(d.date)).attr('cy', (d) => y(d.priceD)).attr('r', (d) => (d.disc > 0 ? 3.4 : 2.4));
}
