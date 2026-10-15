// Корневое приложение: состояние фильтров, агрегаты, раскладка
/* global d3, Vue */
import { SERVICE, DELIVERED, fmt, shiftMonth, monthRange, loadData, summarize, showTip, moveTip, hideTip, el } from './utils.js';
import { MonthChart, ItemsButterfly, Sparkline, drawPriceHistory } from './charts.js';

const { createApp, ref, computed, shallowRef } = Vue;

const COLOR = { count: 'var(--c-count)', money: 'var(--c-money)', rate: 'var(--c-rate)' };

const METRICS = [
  { key: 'orders', label: 'Заказов', kind: 'bar', color: COLOR.count, format: fmt.int, axis: fmt.int, delta: 'rel' },
  { key: 'spend', label: 'Сумма трат', kind: 'bar', color: COLOR.money, format: fmt.rub, axis: fmt.axisRub, delta: 'rel' },
  { key: 'check', label: 'Средний чек', kind: 'line', color: COLOR.money, format: fmt.rub, axis: fmt.axisRub, delta: 'rel' },
  { key: 'discount', label: 'Средняя скидка', kind: 'line', color: COLOR.rate, format: (v) => fmt.pct(v), axis: (v) => fmt.pct(v, 0), delta: 'pp' },
];

const PERIODS = [
  { key: '12', label: '12 мес' },
  { key: '24', label: '24 мес' },
  { key: 'all', label: 'Всё время' },
];

const TOP_N = 15;

const App = {
  components: { MonthChart, ItemsButterfly, Sparkline },
  setup() {
    const ready = ref(false);
    const error = ref(null);
    const rows = shallowRef([]);
    const images = shallowRef(new Map());

    const selected = ref([]); // выбранные категории; пусто = все
    const period = ref('24');
    const sortBy = ref('qty');
    const hoverMonth = ref(null);
    const pinMonth = ref(null);
    const catSort = ref('spend');

    loadData().then((d) => {
      rows.value = d.rows;
      images.value = d.images;
      ready.value = true;
    }).catch((e) => { error.value = String(e); });

    // ---------- базовые срезы ----------
    const delivered = computed(() => rows.value.filter((r) => r.status === DELIVERED));
    const allMonths = computed(() => {
      if (!rows.value.length) return [];
      const ks = rows.value.map((r) => r.month);
      return monthRange(d3.min(ks), d3.max(ks));
    });
    const lastMonth = computed(() => allMonths.value[allMonths.value.length - 1]);
    const months24 = computed(() => allMonths.value.slice(-24));
    const activeMonth = computed(() => hoverMonth.value || pinMonth.value || lastMonth.value);

    const categories = computed(() => {
      const tot = d3.rollups(delivered.value, (v) => d3.sum(v, (r) => r.amount), (r) => r.cat)
        .sort((a, b) => (a[0] === SERVICE) - (b[0] === SERVICE) || b[1] - a[1]);
      return tot.map((d) => d[0]);
    });

    const inCats = (r) => selected.value.length === 0 || selected.value.includes(r.cat);
    const lines = computed(() => delivered.value.filter(inCats));

    const byMonth = computed(() => {
      const g = d3.group(lines.value, (r) => r.month);
      const out = new Map();
      for (const m of allMonths.value) out.set(m, summarize(g.get(m) || []));
      return out;
    });
    const cancelledByMonth = computed(() => d3.rollup(
      rows.value.filter((r) => r.status !== DELIVERED && inCats(r)), (v) => new Set(v.map((r) => r.id)).size, (r) => r.month,
    ));

    // ---------- KPI ----------
    const kpis = computed(() => {
      const S = byMonth.value;
      const a = activeMonth.value;
      const empty = { orders: null, spend: null, check: null, discount: null };
      const cur = S.get(a) || empty;
      const prev = S.get(shiftMonth(a, -1));
      const yoy = S.get(shiftMonth(a, -12));
      return METRICS.map((m) => {
        const d = (base) => {
          if (!base || base[m.key] == null || cur[m.key] == null) return null;
          if (m.delta === 'pp') return { v: cur[m.key] - base[m.key], text: fmt.pp(cur[m.key] - base[m.key]) };
          if (!base[m.key]) return null;
          const r = cur[m.key] / base[m.key] - 1;
          return { v: r, text: fmt.signedPct(r) };
        };
        return {
          ...m,
          value: cur[m.key],
          text: m.format(cur[m.key]),
          prev: d(prev),
          yoy: d(yoy),
          points: months24.value.map((k) => ({ month: k, value: (S.get(k) || empty)[m.key] })),
        };
      });
    });

    // ---------- период для товаров и категорий ----------
    const periodMonths = computed(() => (period.value === 'all' ? allMonths.value : allMonths.value.slice(-+period.value)));
    const periodStart = computed(() => periodMonths.value[0]);
    const periodLabel = computed(() => `${fmt.monthLabel(periodMonths.value[0])} - ${fmt.monthLabel(lastMonth.value)}`);
    const periodLines = computed(() => lines.value.filter((r) => r.month >= periodStart.value));

    const itemStats = computed(() => {
      const g = d3.group(periodLines.value.filter((r) => !r.service), (r) => r.item);
      return Array.from(g, ([item, v]) => ({
        item,
        cat: v[0].cat,
        qty: d3.sum(v, (r) => r.qty),
        spend: d3.sum(v, (r) => r.amount),
        orders: new Set(v.map((r) => r.id)).size,
        months: new Set(v.map((r) => r.month)).size,
        img: images.value.get(item),
        lines: v,
      }));
    });

    const topItems = computed(() => {
      const k = sortBy.value, o = k === 'qty' ? 'spend' : 'qty';
      return itemStats.value.slice().sort((a, b) => b[k] - a[k] || b[o] - a[o]).slice(0, TOP_N);
    });

    // полная история покупок товара - для тултипа с динамикой цены
    const history = computed(() => {
      const g = d3.group(delivered.value.filter((r) => !r.service), (r) => r.item);
      for (const v of g.values()) v.sort((a, b) => a.date - b.date);
      return g;
    });

    // ---------- наблюдения (правая колонка) ----------
    const insights = computed(() => {
      const items = itemStats.value;
      const nMonths = periodMonths.value.length;
      const habits = items.filter((d) => d.months >= 2).sort((a, b) => b.months - a.months || b.qty - a.qty).slice(0, 3)
        .map((d) => ({ ...d, note: `${d.months} из ${nMonths} мес.` }));

      const priceUp = items.filter((d) => d.lines.length >= 5).map((d) => {
        const s = d.lines.slice().sort((a, b) => a.date - b.date);
        const p0 = s[0].price, p1 = s[s.length - 1].price;
        return { ...d, p0, p1, ch: p1 / p0 - 1 };
      }).filter((d) => d.ch > 0).sort((a, b) => b.ch - a.ch).slice(0, 3)
        .map((d) => ({ ...d, note: `${fmt.int(d.p0)} → ${fmt.rub(d.p1)}`, badge: fmt.signedPct(d.ch) }));

      const goods = periodLines.value.filter((r) => !r.service);
      const saved = d3.sum(goods, (r) => r.disc * r.qty);
      const saleShare = goods.length ? goods.filter((r) => r.disc > 0).length / goods.length : 0;
      const topSaved = items.map((d) => ({ ...d, sv: d3.sum(d.lines, (r) => r.disc * r.qty) }))
        .filter((d) => d.sv > 0).sort((a, b) => b.sv - a.sv).slice(0, 3)
        .map((d) => ({ ...d, note: `сэкономлено ${fmt.rub(d.sv)}` }));
      return { habits, priceUp, saved, saleShare, topSaved };
    });

    // ---------- таблица категорий ----------
    const catRows = computed(() => {
      const pl = delivered.value.filter((r) => r.month >= periodStart.value);
      const total = d3.sum(pl, (r) => r.amount);
      const g = d3.group(pl, (r) => r.cat);
      const m24 = months24.value;
      const rowsOut = categories.value.map((cat) => {
        const v = g.get(cat) || [];
        const s = summarize(v);
        const byM = d3.rollup(delivered.value.filter((r) => r.cat === cat), (x) => d3.sum(x, (r) => r.amount), (r) => r.month);
        const top = cat === SERVICE ? [] : d3.rollups(v, (x) => d3.sum(x, (r) => r.qty), (r) => r.item)
          .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([item, q]) => ({ item, q, img: images.value.get(item) }));
        return {
          cat,
          spend: s.spend,
          share: total ? s.spend / total : 0,
          orders: s.orders,
          qty: d3.sum(v, (r) => r.qty),
          discount: cat === SERVICE ? null : s.discount,
          spark: m24.map((k) => byM.get(k) || 0),
          top,
          on: selected.value.length === 0 || selected.value.includes(cat),
        };
      });
      const k = catSort.value;
      return rowsOut.sort((a, b) => (b[k] ?? -1) - (a[k] ?? -1));
    });
    const catMax = computed(() => d3.max(catRows.value, (d) => d.spend) || 1);

    // ---------- действия ----------
    const toggleCat = (cat) => {
      const s = selected.value;
      selected.value = s.includes(cat) ? s.filter((c) => c !== cat) : [...s, cat];
    };
    const resetAll = () => { selected.value = []; period.value = '24'; pinMonth.value = null; hoverMonth.value = null; };
    const pick = (m) => { pinMonth.value = m === pinMonth.value || m === lastMonth.value ? null : m; };

    const selectionLabel = computed(() => {
      const s = selected.value;
      if (!s.length) return 'все категории';
      if (s.length <= 2) return s.join(' и ');
      return `${s.length} ${fmt.plural(s.length, 'категория', 'категории', 'категорий')}`;
    });

    const totals = computed(() => {
      const d = delivered.value;
      return {
        orders: new Set(d.map((r) => r.id)).size,
        items: new Set(d.filter((r) => !r.service).map((r) => r.item)).size,
        first: allMonths.value[0],
        last: lastMonth.value,
      };
    });

    // ---------- тултипы ----------
    function itemTip(d, event) {
      if (!d) { hideTip(); return; }
      const hist = history.value.get(d.item) || [];
      showTip((t) => {
        const head = el('div', 'tip-head');
        if (d.img) { const im = el('img'); im.src = d.img; im.alt = ''; head.append(im); }
        const hn = el('div');
        hn.append(el('div', 'tip-title', d.item), el('div', 'tip-sub', d.cat));
        head.append(hn);
        t.append(head);

        const grid = el('div', 'tip-grid');
        const add = (v, l, cls) => { const c = el('div', 'tip-cell ' + (cls || '')); c.append(el('b', null, v), el('span', null, l)); grid.append(c); };
        add(fmt.int(d.qty) + ' шт', `в ${fmt.int(d.orders)} ${fmt.plural(d.orders, 'заказе', 'заказах', 'заказах')}`, 'count');
        add(fmt.rub(d.spend), 'потрачено', 'money');
        add(fmt.rub(d.spend / d.qty), 'средняя цена за шт');
        t.append(grid);

        if (hist.length) {
          const p0 = hist[0].price, p1 = hist[hist.length - 1].price;
          const ch = p1 / p0 - 1;
          const line = el('div', 'tip-price');
          line.append(el('span', null, 'Цена на полке '), el('b', null, `${fmt.int(p0)} → ${fmt.rub(p1)}`));
          if (Math.abs(ch) >= 0.005) line.append(el('span', 'chip ' + (ch > 0 ? 'up' : 'down'), fmt.signedPct(ch)));
          t.append(line);
          t.append(el('div', 'tip-note', `${fmt.dayLabel(hist[0].date)} - ${fmt.dayLabel(hist[hist.length - 1].date)}, ${hist.length} ${fmt.plural(hist.length, 'покупка', 'покупки', 'покупок')}`));
          const box = el('div', 'tip-chart');
          t.append(box);
          drawPriceHistory(box, hist, period.value === 'all' ? null : new Date(+periodStart.value.slice(0, 4), +periodStart.value.slice(5) - 1, 1));
          const lg = el('div', 'tip-legend');
          const sales = hist.filter((r) => r.disc > 0).length;
          lg.append(el('span', 'lg-shelf', 'цена на полке'), el('span', 'lg-paid', 'заплатил'), el('span', 'lg-sale', `со скидкой: ${sales} из ${hist.length}`));
          t.append(lg);
        }
      }, event);
    }

    function catTip(c, event) {
      showTip((t) => {
        t.append(el('div', 'tip-title', c.cat));
        t.append(el('div', 'tip-sub', `Траты по месяцам: ${fmt.monthLabel(months24.value[0])} - ${fmt.monthLabel(lastMonth.value)}`));
        const max = d3.max(c.spark);
        const imax = c.spark.indexOf(max);
        const grid = el('div', 'tip-grid');
        const add = (v, l) => { const x = el('div', 'tip-cell'); x.append(el('b', null, v), el('span', null, l)); grid.append(x); };
        add(fmt.rub(c.spark[c.spark.length - 1]), fmt.monthLabel(lastMonth.value));
        add(fmt.rub(d3.mean(c.spark)), 'в среднем за месяц');
        add(fmt.rub(max), `пик - ${fmt.monthLabel(months24.value[imax])}`);
        t.append(grid);
      }, event);
    }

    const insightTip = (d, e) => itemTip(d, e);

    return {
      ready, error, METRICS, PERIODS, fmt,
      selected, period, sortBy, catSort, hoverMonth, pinMonth, activeMonth, lastMonth,
      categories, kpis, topItems, insights, catRows, catMax, totals, periodLabel, selectionLabel,
      cancelledByMonth, SERVICE,
      toggleCat, resetAll, pick, itemTip, catTip, insightTip, moveTip, hideTip,
    };
  },

  template: `
  <div class="page">
    <header class="top">
      <h1>Данные о заказах пользователя ДЗ 4</h1>
      <p class="lede" v-if="ready">
        {{ fmt.int(totals.orders) }} доставленных заказов и {{ fmt.int(totals.items) }} разных товаров
        с {{ fmt.monthLabel(totals.first) }} по {{ fmt.monthLabel(totals.last) }}.
        <span class="key"><i class="sw count"></i>синим - штуки и заказы</span>
        <span class="key"><i class="sw money"></i>оранжевым - рубли</span>
      </p>
    </header>

    <div v-if="error" class="state">Не удалось загрузить данные: {{ error }}</div>
    <div v-else-if="!ready" class="state">Загружаю заказы…</div>

    <template v-else>
      <nav class="filters" aria-label="Фильтры">
        <div class="f-group f-cats">
          <span class="f-label">Категории</span>
          <div class="chips" role="group" aria-label="Категории">
            <button type="button" class="chip-btn" :class="{on: !selected.length}" @click="selected = []">Все</button>
            <button v-for="c in categories" :key="c" type="button" class="chip-btn"
              :class="{on: selected.includes(c)}" :aria-pressed="selected.includes(c)" @click="toggleCat(c)">{{ c }}</button>
          </div>
        </div>
        <div class="f-group">
          <span class="f-label">Период для товаров</span>
          <div class="seg" role="radiogroup" aria-label="Период">
            <button v-for="p in PERIODS" :key="p.key" type="button" role="radio" :aria-checked="period === p.key"
              :class="{on: period === p.key}" @click="period = p.key">{{ p.label }}</button>
          </div>
        </div>
        <button type="button" class="reset" @click="resetAll" :disabled="!selected.length && period === '24' && !pinMonth">Сбросить</button>
      </nav>

      <section class="block">
        <div class="block-head">
          <h2>Месяц к месяцу <span class="muted">· {{ selectionLabel }}</span></h2>
        </div>
        <div class="kpis">
          <article v-for="k in kpis" :key="k.key" class="card kpi">
            <div class="k-top">
              <h3>{{ k.label }}</h3>
              <span class="k-month" :class="{pinned: pinMonth && !hoverMonth}">{{ fmt.monthFull(activeMonth) }}</span>
            </div>
            <div class="k-value" :class="'c-' + k.key">{{ k.text }}</div>
            <div class="k-deltas">
              <span v-if="k.prev" :class="k.prev.v > 0 ? 'up' : k.prev.v < 0 ? 'down' : ''">
                <i>{{ k.prev.v > 0 ? '▲' : k.prev.v < 0 ? '▼' : '•' }}</i>{{ k.prev.text }} <em>к {{ fmt.monthDat(shiftLabel(-1)) }}</em>
              </span>
              <span v-if="k.yoy" :class="k.yoy.v > 0 ? 'up' : k.yoy.v < 0 ? 'down' : ''">
                <i>{{ k.yoy.v > 0 ? '▲' : k.yoy.v < 0 ? '▼' : '•' }}</i>{{ k.yoy.text }} <em>к {{ fmt.monthDat(shiftLabel(-12)) }}</em>
              </span>
              <span v-if="k.key === 'orders' && cancelledByMonth.get(activeMonth)" class="k-cancel">
                + {{ cancelledByMonth.get(activeMonth) }} отменён{{ cancelledByMonth.get(activeMonth) === 1 ? '' : 'о' }}
              </span>
            </div>
            <month-chart :points="k.points" :kind="k.kind" :active="activeMonth" :color="k.color"
              :format="k.format" :axis-format="k.axis"
              @hover="hoverMonth = $event" @pick="pick"></month-chart>
          </article>
        </div>
      </section>

      <section class="block split">
        <article class="card items">
          <div class="card-head">
            <div>
              <h2>Что клиент заказывает чаще всего и на что тратит больше всего</h2>
              <p class="hint">Топ-{{ topItems.length }} товаров · {{ periodLabel }} · {{ selectionLabel }}. Без доставки и упаковки.</p>
            </div>
            <div class="seg small" role="radiogroup" aria-label="Сортировка">
              <span class="seg-label">Сортировать по</span>
              <button type="button" role="radio" :aria-checked="sortBy === 'qty'" :class="{on: sortBy === 'qty'}" @click="sortBy = 'qty'">штукам</button>
              <button type="button" role="radio" :aria-checked="sortBy === 'spend'" :class="{on: sortBy === 'spend'}" @click="sortBy = 'spend'">рублям</button>
            </div>
          </div>
          <div class="scroll-x">
            <items-butterfly v-if="topItems.length" :items="topItems" :sort-by="sortBy"
              @hover="itemTip" @move="(d, e) => moveTip(e)"></items-butterfly>
            <p v-else class="state">В этих категориях за период покупок нет.</p>
          </div>
        </article>

        <aside class="notes">
          <div class="card note">
            <h3>Постоянная корзина</h3>
            <p class="hint">Товары, которые клиент берёт почти каждый месяц</p>
            <ul class="mini">
              <li v-for="d in insights.habits" :key="d.item" tabindex="0" @pointerenter="insightTip(d, $event)" @pointermove="moveTip" @pointerleave="hideTip" @focus="insightTip(d, $event)" @blur="hideTip">
                <img :src="d.img" alt="" loading="lazy"><span class="mn">{{ d.item }}</span><b>{{ d.note }}</b>
              </li>
            </ul>
          </div>
          <div class="card note">
            <h3>Подорожало сильнее всего</h3>
            <p class="hint">Цена на полке: первая и последняя покупка за период, товары от 5 покупок</p>
            <ul class="mini">
              <li v-for="d in insights.priceUp" :key="d.item" tabindex="0" @pointerenter="insightTip(d, $event)" @pointermove="moveTip" @pointerleave="hideTip" @focus="insightTip(d, $event)" @blur="hideTip">
                <img :src="d.img" alt="" loading="lazy"><span class="mn">{{ d.item }}<small>{{ d.note }}</small></span><b class="chip up">{{ d.badge }}</b>
              </li>
              <li v-if="!insights.priceUp.length" class="empty">Ничего не подорожало</li>
            </ul>
          </div>
          <div class="card note">
            <h3>Скидки</h3>
            <p class="big"><b class="c-discount">{{ fmt.rub(insights.saved) }}</b> сэкономлено</p>
            <p class="hint">Со скидкой куплено {{ fmt.pct(insights.saleShare, 0) }} позиций. Больше всего сэкономлено на:</p>
            <ul class="mini">
              <li v-for="d in insights.topSaved" :key="d.item" tabindex="0" @pointerenter="insightTip(d, $event)" @pointermove="moveTip" @pointerleave="hideTip" @focus="insightTip(d, $event)" @blur="hideTip">
                <img :src="d.img" alt="" loading="lazy"><span class="mn">{{ d.item }}</span><b>{{ d.note }}</b>
              </li>
            </ul>
          </div>
        </aside>
      </section>

      <section class="block">
        <article class="card">
          <div class="card-head">
            <div>
              <h2>Категории</h2>
              <p class="hint">{{ periodLabel }} · клик по строке добавляет категорию в фильтр · динамика - траты за 24 месяца</p>
            </div>
          </div>
          <div class="scroll-x">
            <table class="cats">
              <thead>
                <tr>
                  <th class="l">Категория</th>
                  <th class="sortable" :class="{on: catSort === 'spend'}" @click="catSort = 'spend'">Траты {{ catSort === 'spend' ? '↓' : '' }}</th>
                  <th class="sortable" :class="{on: catSort === 'share'}" @click="catSort = 'share'">Доля</th>
                  <th class="sortable" :class="{on: catSort === 'orders'}" @click="catSort = 'orders'">Заказов {{ catSort === 'orders' ? '↓' : '' }}</th>
                  <th class="sortable" :class="{on: catSort === 'qty'}" @click="catSort = 'qty'">Штук {{ catSort === 'qty' ? '↓' : '' }}</th>
                  <th class="sortable" :class="{on: catSort === 'discount'}" @click="catSort = 'discount'">Ср. скидка {{ catSort === 'discount' ? '↓' : '' }}</th>
                  <th class="l">Динамика трат</th>
                  <th class="l">Чаще всего берёт</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="c in catRows" :key="c.cat" :class="{off: !c.on, sel: selected.includes(c.cat)}"
                  @click="toggleCat(c.cat)" tabindex="0" @keydown.enter="toggleCat(c.cat)" :aria-pressed="selected.includes(c.cat)">
                  <td class="l name"><span class="check" aria-hidden="true"></span>{{ c.cat }}</td>
                  <td class="spend"><div class="spend-in">
                    <span class="bar"><i :style="{width: (c.spend / catMax * 100) + '%'}"></i></span>
                    <b>{{ fmt.rub(c.spend) }}</b>
                  </div></td>
                  <td>{{ fmt.pct(c.share) }}</td>
                  <td>{{ fmt.int(c.orders) }}</td>
                  <td>{{ fmt.int(c.qty) }}</td>
                  <td>{{ c.discount == null ? '-' : fmt.pct(c.discount) }}</td>
                  <td class="l spark" @pointerenter="catTip(c, $event)" @pointermove="moveTip" @pointerleave="hideTip">
                    <sparkline :values="c.spark" color="var(--c-money)"></sparkline>
                  </td>
                  <td class="l thumbs"><div class="thumbs-in">
                    <span v-for="t in c.top" :key="t.item" class="thumb" :title="t.item + ' - ' + t.q + ' шт'">
                      <img :src="t.img" :alt="t.item" loading="lazy">
                    </span>
                    <span v-if="!c.top.length" class="muted">доставка и упаковка</span>
                  </div></td>
                </tr>
              </tbody>
            </table>
          </div>
        </article>
      </section>

      <footer class="foot">
        <p><b>Как считается.</b> Учтены только доставленные заказы, отменённые показаны отдельно в карточке заказов.
        Сумма трат - всё, что списано за заказ, включая доставку и упаковку. Средний чек - траты, делённые на число заказов.
        Средняя скидка - сколько рублей скидки пришлось на рубль полной цены товаров (без доставки и упаковки).
        При фильтре по категориям заказ учитывается, если в нём есть товар из выбранных категорий, а траты - только по этим товарам.</p>
      </footer>
    </template>
  </div>`,
};

// небольшой помощник для подписи «к июл 2026» в шаблоне
App.methods = {
  shiftLabel(delta) { return shiftMonth(this.activeMonth, delta); },
};

createApp(App).mount('#app');
