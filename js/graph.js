// ファイルのつながり（参照）を調べて図にする。
// analyze(feed) → { nodes, edges }。edges は「from の列 field が to の ID を参照している」。broken は参照先がない行。
// render(svgBox, a, handlers) → SVG を描く。traceTrip(feed, tripId) → 便から順にたどった結果。
(function () {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';

  // 箱の位置（viewBox 600×630）。上から 事業者 → 路線・運行日 → 便 → 時刻・予約 → 乗降場所 → グループの停留所
  // 下の 3 段は矢印が集まるので、段の間を広くとる（件数の札が線や箱に重ならないように）
  const VIEW_H = 630;
  const NODES = [
    { id: 'agency', file: 'agency.txt', label: '事業者', x: 100, y: 40, required: true },
    { id: 'feed_info', file: 'feed_info.txt', label: 'データ情報', x: 500, y: 40, required: true },
    { id: 'routes', file: 'routes.txt', label: '路線', x: 100, y: 140, required: true },
    { id: 'calendar', file: 'calendar.txt', label: '運行日', x: 345, y: 140, required: true, alt: 'calendar_dates.txt' },
    { id: 'trips', file: 'trips.txt', label: '便', x: 220, y: 240, required: true },
    { id: 'stop_times', file: 'stop_times.txt', label: '時刻・乗降時間帯', x: 220, y: 350, required: true },
    { id: 'booking_rules', file: 'booking_rules.txt', label: '予約ルール', x: 500, y: 350 },
    { id: 'stops', file: 'stops.txt', label: '停留所', x: 85, y: 485 },
    { id: 'location_groups', file: 'location_groups.txt', label: '停留所グループ', x: 300, y: 485 },
    { id: 'locations', file: 'locations.geojson', label: '区域ポリゴン', x: 515, y: 485 },
    { id: 'location_group_stops', file: 'location_group_stops.txt', label: 'グループの停留所', x: 192, y: 590 },
  ];
  const W = 160, H = 50;

  // 参照の定義: [from, 列, to, 列の日本語]
  // 5 番目: つながっている必要があるか（必須・推奨・任意）と、その説明
  const REFS = [
    ['routes', 'agency_id', 'agency', '事業者ID', ['必須', 'どの路線も、どれかの事業者に属する（事業者が 1 つなら空でもよい。GTFS-JP では必須）']],
    ['trips', 'route_id', 'routes', '路線ID', ['必須', 'どの便も、どれかの路線に属する']],
    ['trips', 'service_id', 'calendar', '運行日ID', ['必須', 'どの便も、走る日（運行日）を持つ']],
    ['stop_times', 'trip_id', 'trips', '便ID', ['必須', 'どの行も、どれかの便に属する']],
    ['stop_times', 'stop_id', 'stops', '停留所ID', ['どれか 1 つ必須', '各行は 停留所・グループ・区域 のどれか 1 つを指す']],
    ['stop_times', 'location_group_id', 'location_groups', 'グループID', ['どれか 1 つ必須', '各行は 停留所・グループ・区域 のどれか 1 つを指す']],
    ['stop_times', 'location_id', 'locations', '区域ID', ['どれか 1 つ必須', '各行は 停留所・グループ・区域 のどれか 1 つを指す']],
    ['stop_times', 'pickup_booking_rule_id', 'booking_rules', '予約ルール', ['推奨', '仕様上は任意。ただし「事業者に連絡して乗る・降りる」（2）の行に予約ルールがないと、経路検索が予約方法（電話・何分前まで）を案内できない。乗車・降車できない（1）の行には付けない']],
    ['stop_times', 'drop_off_booking_rule_id', 'booking_rules', '予約ルール', ['推奨', '']],
    ['location_group_stops', 'location_group_id', 'location_groups', 'グループID', ['必須', 'グループの停留所は、どれかのグループに属する']],
    ['location_group_stops', 'stop_id', 'stops', '停留所ID', ['必須', 'グループに入れる停留所は stops.txt にある']],
    ['booking_rules', 'prior_notice_service_id', 'calendar', '運行日ID', ['任意', '前日予約（2）で、締め切りの日数を営業日で数えたいときだけ使う（例: 前日まで、ただし土日祝は数えない）。ふつうは使わない']],
  ];

  function rowsOf(feed, id) {
    const n = NODES.find(x => x.id === id);
    if (id === 'locations') return (feed.locations && feed.locations.features) || [];
    const r = feed.files[n.file] ? feed.files[n.file].rows : [];
    if (id === 'calendar' && feed.files['calendar_dates.txt']) return r.concat(feed.files['calendar_dates.txt'].rows);
    return r;
  }
  function idsOf(feed, id) {
    const key = { agency: 'agency_id', routes: 'route_id', calendar: 'service_id', trips: 'trip_id', stops: 'stop_id', location_groups: 'location_group_id', booking_rules: 'booking_rule_id' }[id];
    if (id === 'locations') return new Set(rowsOf(feed, id).map(f => String(f.id)));
    return new Set(rowsOf(feed, id).map(r => r[key]).filter(v => v != null && v !== ''));
  }

  function analyze(feed) {
    const nodes = NODES.map(n => {
      const rows = rowsOf(feed, n.id);
      const exists = n.id === 'locations' ? !!(feed.locations && feed.locations.features && feed.locations.features.length) : !!(feed.files[n.file] && feed.files[n.file].rows.length) || !!(n.alt && feed.files[n.alt] && feed.files[n.alt].rows.length);
      return Object.assign({}, n, { rows: rows.length, exists, unused: 0 });
    });
    const byId = Object.fromEntries(nodes.map(n => [n.id, n]));
    const edges = [];
    for (const [from, col, to, colLabel, need] of REFS) {
      const src = rowsOf(feed, from);
      const ids = idsOf(feed, to);
      let refs = 0; const broken = [];
      src.forEach((r, i) => {
        const v = r[col]; if (v == null || v === '') return;
        refs++;
        if (!ids.has(String(v))) broken.push({ row: i, value: String(v) });
      });
      // 同じ from→to は 1 本にまとめる（予約ルールの乗車・降車など）
      const e = edges.find(x => x.from === from && x.to === to);
      if (e) { e.refs += refs; e.broken.push(...broken.map(b => Object.assign(b, { col }))); e.cols.push(col); }
      else edges.push({ from, to, cols: [col], colLabel, need: need[0], needNote: need[1], refs, broken: broken.map(b => Object.assign(b, { col })) });
    }
    // 「どれか 1 つ必須」の矢印（便の行 → 停留所・グループ・区域）: ほかの矢印が使われていれば、使っていない矢印は問題ない
    const alt = edges.filter(e => e.need === 'どれか 1 つ必須');
    for (const e of alt) if (!e.refs) { const used = alt.filter(x => x.from === e.from && x.refs).map(x => byId[x.to].label); if (used.length) e.altUsed = used; }
    // どこからも使われていない行（参照される側）
    const used = (to) => { const s = new Set(); for (const [from, col, t] of REFS) if (t === to) for (const r of rowsOf(feed, from)) if (r[col]) s.add(String(r[col])); return s; };
    for (const id of ['routes', 'calendar', 'trips', 'stops', 'location_groups', 'locations', 'booking_rules']) {
      const u = used(id); const all = idsOf(feed, id);
      if (id === 'trips') { const st = new Set(rowsOf(feed, 'stop_times').map(r => r.trip_id)); byId.trips.unused = [...all].filter(x => !st.has(x)).length; byId.trips.unusedLabel = '時刻の行がない便'; continue; }
      if (id === 'stops') { const parents = new Set(rowsOf(feed, 'stops').map(r => r.parent_station).filter(Boolean)); byId.stops.unused = rowsOf(feed, 'stops').filter(r => (r.location_type || '0') === '0' && !u.has(r.stop_id) && !parents.has(r.stop_id)).length; byId.stops.unusedLabel = 'どの便・グループにも使われていない停留所'; continue; }
      byId[id].unused = [...all].filter(x => !u.has(x)).length; byId[id].unusedLabel = 'どこからも使われていない';
    }
    // 区域（グループ・ポリゴン・停留所）が 1 つもない便は使えない
    return { nodes, edges, broken: edges.reduce((a, e) => a + e.broken.length, 0) };
  }

  function el(tag, attrs, text) { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v); if (text != null) e.textContent = text; return e; }

  function render(box, a, H_) {
    const h = Object.assign({ onNode() {}, onEdge() {} }, H_ || {});
    box.innerHTML = '';
    const svg = el('svg', { viewBox: `0 0 600 ${VIEW_H}`, class: 'graph', role: 'img', 'aria-label': 'ファイルのつながり' });
    const defs = el('defs');
    for (const [id, color] of [['ok', '#2a9d4a'], ['bad', '#d33'], ['none', '#aaa']]) {
      const m = el('marker', { id: 'arr-' + id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' });
      m.appendChild(el('path', { d: 'M0,0 L10,5 L0,10 z', fill: color })); defs.appendChild(m);
    }
    svg.appendChild(defs);
    const pos = Object.fromEntries(a.nodes.map(n => [n.id, n]));
    // 箱の縁との交点
    const clip = (p, q) => { const dx = q.x - p.x, dy = q.y - p.y; const sx = Math.abs(dx) / (W / 2 + 4), sy = Math.abs(dy) / (H / 2 + 4); const s = Math.max(sx, sy) || 1; return { x: p.x + dx / s, y: p.y + dy / s }; };
    for (const e of a.edges) {
      const p = pos[e.from], q = pos[e.to];
      const kind = e.broken.length ? 'bad' : e.refs ? 'ok' : 'none';
      if (kind === 'none' && !p.exists) continue; // 元の表がない参照は描かない
      const s = clip(p, q), t = clip(q, p);
      const g = el('g', { class: 'edge ' + kind, tabindex: 0 });
      g.appendChild(el('line', { x1: s.x, y1: s.y, x2: t.x, y2: t.y, class: 'hit' }));
      g.appendChild(el('line', { x1: s.x, y1: s.y, x2: t.x, y2: t.y, 'marker-end': `url(#arr-${kind})` }));
      const mx = (s.x + t.x) / 2, my = (s.y + t.y) / 2;
      const label = e.broken.length ? `途切れ ${e.broken.length}` : e.refs ? `${e.refs}` : e.need === '任意' ? '任意' : e.altUsed ? '使っていない' : '0';
      const lw = [...label].reduce((w, ch) => w + (ch.charCodeAt(0) > 255 ? 13 : 8), 0) + 14;
      g.appendChild(el('rect', { x: mx - lw / 2, y: my - 11, width: lw, height: 22, rx: 11, class: 'tag' }));
      g.appendChild(el('text', { x: mx, y: my + 5, 'text-anchor': 'middle' }, label));
      g.appendChild(el('title', null, `${p.file} の ${e.cols.join(' / ')} → ${q.file}（${e.need}）\n参照 ${e.refs} 件${e.broken.length ? `、うち参照先がない ${e.broken.length} 件` : ''}`));
      g.addEventListener('click', () => h.onEdge(e)); g.addEventListener('keydown', ev => { if (ev.key === 'Enter') h.onEdge(e); });
      svg.appendChild(g);
    }
    for (const n of a.nodes) {
      const cls = ['node', n.exists ? 'ok' : (n.required ? 'missing' : 'empty'), n.unused ? 'unused' : ''].join(' ');
      const g = el('g', { class: cls, transform: `translate(${n.x - W / 2},${n.y - H / 2})`, tabindex: 0 });
      g.appendChild(el('rect', { width: W, height: H, rx: 8 }));
      g.appendChild(el('text', { x: W / 2, y: 21, 'text-anchor': 'middle', class: 'nlabel' }, n.label));
      g.appendChild(el('text', { x: W / 2, y: 40, 'text-anchor': 'middle', class: 'nfile' }, n.exists ? `${n.file}・${n.rows} 行` : (n.required ? `${n.file}・未作成（必須）` : `${n.file}・なし`)));
      if (n.unused) { g.appendChild(el('circle', { cx: W - 4, cy: 4, r: 11, class: 'ubadge' })); g.appendChild(el('text', { x: W - 4, y: 8, 'text-anchor': 'middle', class: 'ubtext' }, String(n.unused > 99 ? '99+' : n.unused))); }
      g.appendChild(el('title', null, `${n.label}（${n.file}）${n.exists ? ` ${n.rows} 行` : ''}${n.unused ? `\n${n.unusedLabel}: ${n.unused}` : ''}`));
      g.addEventListener('click', () => h.onNode(n)); g.addEventListener('keydown', ev => { if (ev.key === 'Enter') h.onNode(n); });
      svg.appendChild(g);
    }
    box.appendChild(svg);
  }

  const hm = v => { const m = /^(\d{1,2}):(\d{2})/.exec(v || ''); return m ? m[1].padStart(2, '0') + ':' + m[2] : ''; };

  // 便から順にたどる。各段: { label, ok, text, file?, row? }
  function traceTrip(feed, tripId) {
    const F = n => (feed.files[n] ? feed.files[n].rows : []);
    const out = [];
    const trip = F('trips.txt').find(t => t.trip_id === tripId);
    if (!trip) return [{ label: '便', ok: false, text: `便 ${tripId} がない` }];
    const ti = F('trips.txt').indexOf(trip);
    out.push({ label: '便', ok: true, text: `${trip.trip_id}${trip.trip_headsign ? '（' + trip.trip_headsign + '）' : ''}`, file: 'trips.txt', row: ti });
    const route = F('routes.txt').find(r => r.route_id === trip.route_id);
    out.push({ label: '路線', ok: !!route, text: route ? `${route.route_id} ${route.route_long_name || route.route_short_name || ''}` : `路線 ${trip.route_id || '(空)'} が routes.txt にない`, file: route ? 'routes.txt' : 'trips.txt', row: route ? F('routes.txt').indexOf(route) : ti, col: route ? null : 'route_id' });
    if (route) {
      const ags = F('agency.txt'); const ag = route.agency_id ? ags.find(a => a.agency_id === route.agency_id) : (ags.length === 1 ? ags[0] : null);
      out.push({ label: '事業者', ok: !!ag, text: ag ? `${ag.agency_name}` : `事業者 ${route.agency_id || '(空)'} がない`, file: ag ? 'agency.txt' : 'routes.txt', row: ag ? ags.indexOf(ag) : F('routes.txt').indexOf(route), col: ag ? null : 'agency_id' });
    }
    const cal = F('calendar.txt').find(c => c.service_id === trip.service_id); const cds = F('calendar_dates.txt').filter(c => c.service_id === trip.service_id);
    const days = cal ? ['月', '火', '水', '木', '金', '土', '日'].filter((d, i) => cal[['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'][i]] === '1').join('') : '';
    out.push({ label: '運行日', ok: !!(cal || cds.length), text: cal ? `${trip.service_id}: ${days || '曜日なし'}　${cal.start_date}〜${cal.end_date}${cds.length ? `、例外 ${cds.length} 日` : ''}` : cds.length ? `${trip.service_id}: 例外日のみ ${cds.length} 日` : `運行日 ${trip.service_id || '(空)'} がない`, file: cal ? 'calendar.txt' : 'trips.txt', row: cal ? F('calendar.txt').indexOf(cal) : ti, col: cal ? null : 'service_id' });
    const st = F('stop_times.txt').map((r, i) => ({ r, i })).filter(x => x.r.trip_id === tripId).sort((a, b) => (+a.r.stop_sequence) - (+b.r.stop_sequence));
    if (!st.length) out.push({ label: '時刻', ok: false, text: 'stop_times.txt に行がない', file: 'trips.txt', row: ti });
    const groups = F('location_groups.txt'), lgs = F('location_group_stops.txt'), stops = F('stops.txt'), rules = F('booking_rules.txt');
    const locs = (feed.locations && feed.locations.features) || [];
    for (const { r, i } of st) {
      const act = [r.pickup_type === '1' ? '' : '乗', r.drop_off_type === '1' ? '' : '降'].join('') || '乗降不可';
      const when = r.start_pickup_drop_off_window ? `${hm(r.start_pickup_drop_off_window)}〜${hm(r.end_pickup_drop_off_window)}` : hm(r.arrival_time || r.departure_time);
      let where, ok = true;
      if (r.location_group_id) { const g = groups.find(x => x.location_group_id === r.location_group_id); const n = lgs.filter(x => x.location_group_id === r.location_group_id).length; ok = !!g && n > 0; where = g ? `グループ「${g.location_group_name || g.location_group_id}」（停留所 ${n}）${n ? '' : ' ← 停留所が入っていない'}` : `グループ ${r.location_group_id} がない`; }
      else if (r.location_id) { const f = locs.find(x => String(x.id) === r.location_id); ok = !!f; where = f ? `区域「${(f.properties || {}).stop_name || f.id}」` : `区域 ${r.location_id} がない`; }
      else if (r.stop_id) { const s = stops.find(x => x.stop_id === r.stop_id); ok = !!s; where = s ? `停留所「${s.stop_name}」` : `停留所 ${r.stop_id} がない`; }
      else { ok = false; where = '乗降場所がない'; }
      const ruleIds = [r.pickup_booking_rule_id, r.drop_off_booking_rule_id].filter(Boolean);
      const ruleTxt = ruleIds.map(id => { const b = rules.find(x => x.booking_rule_id === id); if (!b) { ok = false; return `予約ルール ${id} がない`; } return `予約 ${id}（${{ 0: '予約なし', 1: `当日 ${b.prior_notice_duration_min || '?'} 分前まで`, 2: `${b.prior_notice_last_day || '?'} 日前 ${hm(b.prior_notice_last_time)} まで` }[b.booking_type] || '種類不明'}）`; });
      out.push({ label: `${r.stop_sequence}. ${act}`, ok, text: `${where}　${when}${ruleTxt.length ? '　' + [...new Set(ruleTxt)].join('、') : ''}`, file: 'stop_times.txt', row: i });
    }
    return out;
  }

  window.FlexGraph = { NODES, REFS, analyze, render, traceTrip };
})();
