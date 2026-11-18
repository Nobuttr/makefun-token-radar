// Launch Radar's dashboard. It reads window.RADAR (written beside dashboard/ by main.ts) and
// renders the ranked board of launch candidates, the watchlist view, the live-token and
// set-aside views, a detail view per protocol with its farm plan, and the model itself.
// No network: every byte it shows is in data.js.
//
// The page recomputes every row's implied value from the snapshot figures and the model's
// stated constants, in impliedOf below: the same arithmetic lib/model.ts runs, so the number
// on the screen and the number in board.json are one number derived twice, never copied.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var M = DATA.model;
  var app = document.getElementById('board');
  var state = { q: '', category: 'all', chain: 'all', tab: 'board', sort: 'implied', dir: -1, selected: null };

  var usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd0.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
  function round4(n) { return Math.round(n * 1e4) / 1e4; }

  // The value model, recomputed on the page from a row's own figures. lib/model.ts holds the
  // same chain: multiple from the snapshot's live comparables, launch FDV, momentum, maturity,
  // community pool, launch likelihood, and the implied value the board ranks by.
  function impliedOf(r) {
    var growthPct = clamp(r.change_7d === null || r.change_7d === undefined ? 0 : r.change_7d, M.growth_floor_pct, M.growth_cap_pct);
    var momentum = 1 + (growthPct / 100) * M.momentum_weight;
    var age = r.age_days === null || r.age_days === undefined ? M.unknown_age_days : r.age_days;
    var endurance = clamp(age, 0, M.maturity_days) / M.maturity_days;
    var maturity = M.maturity_base + M.maturity_range * endurance;
    var pool = r.tvl_usd * r.multiple * momentum * maturity * r.community_share;
    var scale = clamp(Math.log10(Math.max(r.tvl_usd, 1) / 5000000) / Math.log10(M.scale_top_usd / 5000000), 0, 1);
    var traction = (growthPct - M.growth_floor_pct) / (M.growth_cap_pct - M.growth_floor_pct);
    var likelihood = clamp(M.likelihood_base + M.likelihood_scale_weight * scale + M.likelihood_traction_weight * traction + M.likelihood_endurance_weight * endurance, M.likelihood_floor, M.likelihood_cap);
    return {
      fdv: Math.round(r.tvl_usd * r.multiple),
      momentum: round4(momentum),
      maturity: round4(maturity),
      pool: Math.round(pool),
      likelihood: round4(likelihood),
      implied: Math.max(1, Math.round(pool * likelihood))
    };
  }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('p')) state.selected = params.get('p');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('chain')) state.chain = params.get('chain');
    if (params.get('tab')) state.tab = params.get('tab');
    if (params.get('sort')) state.sort = params.get('sort');
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.tab !== 'board') params.set('tab', state.tab);
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' },
        el('span', { class: 'rings', 'aria-hidden': 'true' }),
        el('div', null,
          el('div', { class: 'brand-name', text: 'LAUNCH RADAR' }),
          el('div', { class: 'brand-sub', text: 'pre-token protocols, ranked by implied launch value' })
        )
      ),
      el('div', { class: 'top-meta' },
        el('span', { text: 'snapshot ' + DATA.as_of }),
        el('span', { text: DATA.counts.protocols + ' protocols' }),
        el('span', { text: 'model ' + DATA.model_version })
      )
    );
  }

  function lede() {
    var c = DATA.counts;
    return el('section', { class: 'lede' },
      el('div', null,
        el('h1', { text: 'Farm the launches before they exist' }),
        el('p', null,
          'Every protocol in the snapshot that records no token and is not a wrapped, staked, bridged or exchange product of one that trades, ranked by ',
          el('b', { text: 'implied value' }),
          ': what its launch would distribute, weighted by the chance it launches at all. The house watchlist of ' + c.watchlist + ' is the floor, not the ceiling: the radar ranks ' + c.candidates + ' candidates, most of them below the watchlist\u2019s $' + Math.round(DATA.floor_usd / 1e6) + 'M line. Each row carries the farm plan that earns it.'
        )
      ),
      el('div', { class: 'stats' },
        el('div', { class: 'stat' }, el('span', { text: 'Candidates ranked' }), el('b', { text: String(c.candidates) })),
        el('div', { class: 'stat' }, el('span', { text: 'Watchlist covered' }), el('b', null, el('em', { text: c.watchlist + ' / ' + c.watchlist }))),
        el('div', { class: 'stat' }, el('span', { text: 'Distribution pool modelled' }), el('b', { text: fmtUsd(DATA.pool_total_usd) })),
        el('div', { class: 'stat' }, el('span', { text: 'Set aside: live / products' }), el('b', { text: c.live + ' / ' + c.represented }))
      )
    );
  }

  function picks() {
    var top = DATA.rows.slice(0, 5);
    return el('section', { 'aria-label': 'Top five candidates' },
      el('div', { class: 'picks' }, top.map(function (r) {
        return el('button', { class: 'pick', type: 'button', onclick: function () { openDetail(r.slug); } },
          el('span', { class: 'rk', text: 'RANK ' + r.rank + (r.watchlist ? ' · WATCHLIST' : '') }),
          el('h3', { text: r.name }),
          el('div', { class: 'cat', text: (r.category || 'Uncategorised') + ' · TVL ' + fmtUsd(r.tvl_usd) }),
          el('div', { class: 'val', text: fmtUsd(r.implied_value_usd) }),
          el('div', { class: 'why', text: 'Pool ' + fmtUsd(r.pool_usd) + ' at ' + Math.round(r.likelihood * 100) + '% likelihood' }),
          el('div', { class: 'meter', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.round(r.likelihood * 100) + '%' }))
        );
      }))
    );
  }

  var TABS = [
    ['board', 'Ranked board'],
    ['watchlist', 'Watchlist'],
    ['live', 'Live tokens'],
    ['aside', 'Set aside']
  ];

  function controls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Uncategorised'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.flatMap(function (r) { return r.chains || []; }))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, slug, category, chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    function select(id, label, values, current, onchange) {
      var s = el('select', { id: id, 'aria-label': label },
        values.map(function (v) { return el('option', { value: v[0], text: v[1], selected: current === v[0] ? 'selected' : null }); })
      );
      s.addEventListener('change', function () { onchange(s.value); writeHash(); render(); });
      return s;
    }
    var catSel = select('category', 'Filter by category', [['all', 'All categories']].concat(categories.map(function (c) { return [c, c]; })), state.category, function (v) { state.category = v; });
    var chainSel = select('chain', 'Filter by chain', [['all', 'All chains']].concat(chains.map(function (c) { return [c, c]; })), state.chain, function (v) { state.chain = v; });
    var sortSel = select('sort', 'Sort the board', [
      ['implied', 'Implied value'], ['tvl', 'TVL'], ['growth', '7d growth'], ['age', 'Age with no token'], ['likelihood', 'Launch likelihood'], ['efficiency', 'Value per $ of TVL']
    ], state.sort, function (v) { state.sort = v; state.dir = -1; });
    var tabs = el('div', { class: 'tabs', role: 'group', 'aria-label': 'Views' },
      TABS.map(function (t) {
        return el('button', { type: 'button', 'aria-pressed': state.tab === t[0] ? 'true' : 'false', text: t[1], onclick: function () { state.tab = t[0]; writeHash(); render(); } });
      })
    );
    var count = state.tab === 'live' ? DATA.live.length + ' shown of ' + DATA.counts.live
      : state.tab === 'aside' ? DATA.represented.length + ' shown of ' + DATA.counts.represented
      : visibleRows().length + ' rows shown';
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('span', { class: 'lab', text: 'View' }), tabs),
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), catSel),
      el('div', { class: 'field' }, el('label', { for: 'chain', text: 'Chain' }), chainSel),
      el('div', { class: 'field' }, el('label', { for: 'sort', text: 'Sort' }), sortSel),
      el('span', { class: 'count', text: count })
    );
  }

  function visibleRows() {
    var q = state.q.trim().toLowerCase();
    var list = DATA.rows.filter(function (r) {
      if (state.tab === 'watchlist' && !r.watchlist) return false;
      if (state.category !== 'all' && (r.category || 'Uncategorised') !== state.category) return false;
      if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category || '', (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
    var key = state.sort;
    return list.sort(function (a, b) {
      var av, bv;
      if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? -1 : a.age_days; bv = b.age_days === null ? -1 : b.age_days; }
      else if (key === 'likelihood') { av = a.likelihood; bv = b.likelihood; }
      else if (key === 'efficiency') { av = a.implied_value_usd / Math.max(1, a.tvl_usd); bv = b.implied_value_usd / Math.max(1, b.tvl_usd); }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function sortHeader(key, label, numeric) {
    return el('th', { scope: 'col', class: numeric ? 'num' : null },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } render(); } },
        label + (state.sort === key ? (state.dir < 0 ? ' \u25bc' : ' \u25b2') : '')
      )
    );
  }

  function boardTable() {
    var list = visibleRows();
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No candidate matches that filter' }),
        el('p', { text: 'Clear the search or widen the category and chain to see the board again.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; writeHash(); render(); } })
      ));
    }
    var max = Math.max.apply(null, list.map(function (r) { return r.implied_value_usd; })) || 1;
    var tbody = el('tbody');
    list.forEach(function (r) {
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var tr = el('tr', { 'data-clickable': 'true', tabindex: '0', onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } } },
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', null, el('div', { class: 'name' },
          el('b', { text: r.name }),
          r.watchlist ? el('span', { class: 'badge watch', text: 'WATCHLIST' }) : null,
          el('span', { class: 'sub', text: (r.category || 'Uncategorised') + ' \u00b7 ' + (r.chains.length ? r.chains.slice(0, 3).join(', ') + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') : 'no chain on record') })
        )),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', { class: 'num', text: r.multiple.toFixed(2) + '\u00d7' }),
        el('td', null, el('div', { class: 'lik' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.round(r.likelihood * 100) + '%' })),
          el('span', { class: 'num', text: Math.round(r.likelihood * 100) + '%' })
        )),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(2, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) })
        ))
      );
      tbody.appendChild(tr);
    });
    var caption = state.tab === 'watchlist'
      ? 'The house watchlist: every protocol at or above the floor that records no token and is no product of one that trades. All ' + DATA.counts.watchlist + ' are on the board; the ranked board adds the candidates below the floor.'
      : 'Launch candidates ranked by implied value. Select a row for its factor chain and farm plan.';
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { text: caption }),
          el('thead', null, el('tr', null,
            sortHeader('implied', 'Rank', true),
            el('th', { scope: 'col', text: 'Protocol' }),
            sortHeader('tvl', 'TVL', true),
            sortHeader('growth', '7d', true),
            sortHeader('age', 'Age', true),
            el('th', { scope: 'col', class: 'num', text: 'Multiple' }),
            sortHeader('likelihood', 'Likelihood', true),
            sortHeader('implied', 'Implied value', true)
          )),
          tbody
        )
      )
    );
  }

  function liveTable() {
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'badge pre', text: r.symbol || 'TOKEN' }), el('span', { class: 'sub', text: (r.category || 'Uncategorised') + ' \u00b7 ' + (r.chains.slice(0, 3).join(', ') || 'no chain on record') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) })
      ));
    });
    return el('div', { class: 'panel' }, el('div', { class: 'table-wrap' },
      el('table', null,
        el('caption', { text: 'Already trading: these protocols record a token, so their market cap is a fact, not a model. They calibrate the board\u2019s multiples and are never ranked as launches. The ' + DATA.live.length + ' largest by market cap are shown, of ' + DATA.counts.live + '.' }),
        el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', class: 'num', text: 'TVL' }), el('th', { scope: 'col', class: 'num', text: '7d' }), el('th', { scope: 'col', class: 'num', text: 'Market cap' }))),
        tbody
      )
    ));
  }

  function asideTable() {
    var tbody = el('tbody');
    DATA.represented.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: r.category || 'Uncategorised' }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'sub', text: r.reason })
      ));
    });
    return el('div', { class: 'panel' }, el('div', { class: 'table-wrap' },
      el('table', null,
        el('caption', { text: 'Set aside, with the reason on the record: pre-token by the record, but a wrapped, staked, bridged or exchange product of an asset that already trades is not a launch of its own. The ' + DATA.represented.length + ' largest by TVL are shown, of ' + DATA.counts.represented + '.' }),
        el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', class: 'num', text: 'TVL' }), el('th', { scope: 'col', text: 'Why it is set aside' }))),
        tbody
      )
    ));
  }

  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); render(); });

  function splitStep(s) {
    var ci = s.indexOf(' Cost: ');
    var ti = s.lastIndexOf('. Time: ');
    if (ci < 0 || ti < ci) return { action: s, cost: null, time: null };
    return { action: s.slice(0, ci), cost: s.slice(ci + 7, ti), time: s.slice(ti + 8).replace(/\.$/, '') };
  }

  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    state.selected = slug;
    writeHash();
    var v = impliedOf(row);
    dialog.textContent = '';
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'rk', text: 'RANK ' + row.rank + ' OF ' + DATA.counts.candidates + (row.watchlist ? ' \u00b7 ON THE HOUSE WATCHLIST' : '') }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Uncategorised') + ' \u00b7 ' + (row.chains.length ? row.chains.join(', ') : 'no chain on record') + ' \u00b7 records no token in the snapshot' })
      ),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    function box(label, value, final) {
      return el('div', { class: 'link-box' + (final ? ' final' : '') }, el('span', { text: label }), el('b', { text: value }));
    }
    dialog.appendChild(el('section', { class: 'detail-sec' },
      el('h3', { text: 'How the implied value is built' }),
      el('div', { class: 'chain' },
        box('TVL', fmtUsd(row.tvl_usd)),
        el('span', { class: 'op', text: '\u00d7' }), box('Category multiple', row.multiple.toFixed(2) + '\u00d7'),
        el('span', { class: 'op', text: '=' }), box('Launch FDV', fmtUsd(v.fdv)),
        el('span', { class: 'op', text: '\u00d7' }), box('Momentum', v.momentum.toFixed(2) + '\u00d7'),
        el('span', { class: 'op', text: '\u00d7' }), box('Maturity', v.maturity.toFixed(2) + '\u00d7'),
        el('span', { class: 'op', text: '\u00d7' }), box('Community share', Math.round(row.community_share * 100) + '%'),
        el('span', { class: 'op', text: '=' }), box('Pool', fmtUsd(v.pool)),
        el('span', { class: 'op', text: '\u00d7' }), box('Likelihood', Math.round(v.likelihood * 100) + '%'),
        el('span', { class: 'op', text: '=' }), box('Implied value', fmtUsd(row.implied_value_usd), true)
      ),
      el('p', { class: 'sub', text: 'This page recomputes the chain from the row\u2019s own figures: ' + fmtUsd(v.implied) + (v.implied === row.implied_value_usd ? ', the same number board.json carries.' : ' recomputed, against ' + fmtUsd(row.implied_value_usd) + ' on the board.') + ' An estimate from a stated model, not a price and not a promise.' })
    ));
    dialog.appendChild(el('section', { class: 'detail-sec' },
      el('h3', { text: 'The snapshot record' }),
      el('div', { class: 'record' },
        el('div', null, el('span', { text: 'TVL' }), el('b', { text: fmtUsd(row.tvl_usd) })),
        el('div', null, el('span', { text: '7d change' }), el('b', { text: fmtPct(row.change_7d) })),
        el('div', null, el('span', { text: 'Age with no token' }), el('b', { text: fmtAge(row.age_days) })),
        el('div', null, el('span', { text: 'First tracked' }), el('b', { text: row.listed_at || 'not recorded' })),
        el('div', null, el('span', { text: 'Chains' }), el('b', { text: String(row.chains.length) })),
        el('div', null, el('span', { text: 'Category' }), el('b', { text: row.category || 'none' })),
        el('div', null, el('span', { text: 'Token on record' }), el('b', { text: 'none' })),
        el('div', null, el('span', { text: 'Watchlist' }), el('b', { text: row.watchlist ? 'yes' : 'no' }))
      )
    ));
    dialog.appendChild(el('section', { class: 'detail-sec' },
      el('h3', { text: 'Farm plan' }),
      el('ol', { class: 'steps' }, row.farm_steps.map(function (s) {
        var parts = splitStep(s);
        return el('li', null, el('div', null,
          el('b', { text: parts.action }),
          el('span', { class: 'chips' },
            parts.cost ? el('span', { class: 'chip cost', text: 'Cost: ' + parts.cost }) : null,
            parts.time ? el('span', { class: 'chip', text: 'Time: ' + parts.time }) : null
          )
        ));
      }))
    ));
    if (typeof dialog.showModal === 'function') { if (!dialog.open) dialog.showModal(); }
    else dialog.setAttribute('open', '');
  }

  function methodPanel() {
    var multRows = DATA.multiples.filter(function (m) { return m.samples > 0; });
    var tbody = el('tbody');
    multRows.forEach(function (m) {
      tbody.appendChild(el('tr', null,
        el('td', { text: m.category }),
        el('td', { class: 'num', text: String(m.samples) }),
        el('td', { class: 'num', text: m.median === null ? 'n/a' : m.median.toFixed(2) + '\u00d7' }),
        el('td', { class: 'num', text: m.used.toFixed(2) + '\u00d7' })
      ));
    });
    return el('section', { class: 'panel method' },
      el('h2', { text: 'The model, stated whole' }),
      el('p', null, 'One function scores every candidate from the snapshot\u2019s own figures. No protocol name is special-cased, no row is hand-picked, and the page recomputes each row from the same figures, so the board and the code cannot drift apart. A protocol ', el('b', { text: 'records no token' }), ' when the snapshot carries no market cap, no CoinGecko id and no symbol for it: the record is what is claimed, never the world.'),
      el('div', { class: 'formula' },
        el('span', { class: 'k', text: 'implied' }), ' = round( pool \u00d7 likelihood )\n',
        el('span', { class: 'k', text: 'pool' }), ' = tvl \u00d7 category multiple \u00d7 momentum \u00d7 maturity \u00d7 community share\n',
        el('span', { class: 'k', text: 'likelihood' }), ' = clamp( 0.10 + 0.60\u00b7scale + 0.20\u00b7traction + 0.10\u00b7endurance, 0.05, 0.95 )'
      ),
      el('div', { class: 'factors' },
        el('div', { class: 'factor' }, el('b', { text: 'Category multiple' }), el('span', { text: 'The median market-cap / TVL of this snapshot\u2019s live-token protocols in the same category, shrunk toward the global median of ' + DATA.global_multiple.toFixed(2) + '\u00d7 by sample size and clamped to [0.03\u00d7, 2.5\u00d7]. Learned from the snapshot on every run, so a future snapshot re-prices itself.' })),
        el('div', { class: 'factor' }, el('b', { text: 'Momentum and maturity' }), el('span', { text: 'Momentum is 1 + clamp(7d change, \u221260%, +150%) \u00d7 0.35. Maturity is 0.75 + 0.35 \u00d7 min(age, 4y) / 4y: the longer a protocol has run with no token on record, the more proven its launch. An unrecorded age counts as one year, an unrecorded change as zero.' })),
        el('div', { class: 'factor' }, el('b', { text: 'Pool and likelihood' }), el('span', { text: 'The community share, 10\u201320% by category, is the part of a launch that reaches farmers. Likelihood rises with TVL on a log ramp to $3B (scale), with seven-day traction, and with endurance. The ranking is the pool weighted by that likelihood.' })),
        el('div', { class: 'factor' }, el('b', { text: 'Who is ranked' }), el('span', { text: 'Candidates record no token and are not a wrapped, staked, bridged or exchange product of one that trades: the snapshot\u2019s own watchlist reading, applied at every TVL instead of only above its $' + Math.round(DATA.floor_usd / 1e6) + 'M floor.' })),
        el('div', { class: 'factor' }, el('b', { text: 'Who is set aside' }), el('span', { text: 'Protocols that record a token are live: their market cap is a fact and calibrates the multiples. Pre-token products of a trading asset are represented, each shown with the record signal that marks it.' })),
        el('div', { class: 'factor' }, el('b', { text: 'What it is not' }), el('span', { text: 'Implied value is this model\u2019s claim from one frozen snapshot, not a prediction that a token will exist or a price it will reach. Farm plans carry real cost and real risk; sizes are stated so a reader can refuse them.' }))
      ),
      el('h3', { text: 'Category multiples, learned from this snapshot' }),
      el('div', { class: 'table-wrap' }, el('table', { class: 'mult-table' },
        el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Category' }), el('th', { scope: 'col', class: 'num', text: 'Live samples' }), el('th', { scope: 'col', class: 'num', text: 'Median mcap / TVL' }), el('th', { scope: 'col', class: 'num', text: 'Multiple used' }))),
        tbody
      ))
    );
  }

  function footer() {
    return el('footer', null,
      el('span', { text: 'Data: ' + DATA.source }),
      el('span', { text: 'Implied value is a model\u2019s estimate, not investment advice.' }),
      el('span', { text: 'Launch Radar \u00b7 model ' + DATA.model_version })
    );
  }

  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(lede());
    if (state.tab === 'board') shell.appendChild(picks());
    shell.appendChild(controls());
    if (state.tab === 'live') shell.appendChild(liveTable());
    else if (state.tab === 'aside') shell.appendChild(asideTable());
    else shell.appendChild(boardTable());
    if (state.tab === 'board' || state.tab === 'watchlist') shell.appendChild(methodPanel());
    shell.appendChild(footer());
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    if (state.selected) openDetail(state.selected);
  }

  readHash();
  render();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
