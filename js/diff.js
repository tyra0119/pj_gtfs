// 読み込んだ元データ（original）と今のデータ（current）の違い。
// ファイルごとに 追加・更新・削除 の行を出す。行の対応づけは「行の鍵」で行う:
//   ID のあるファイル: その ID / stop_times: trip_id+stop_sequence / calendar_dates: service_id+date / location_group_stops: 両方 / それ以外: 行番号
(function () {
  'use strict';
  const { FILES } = window.FLEX_SPEC;
  const NATURAL_KEYS = {
    'stop_times.txt': ['trip_id', 'stop_sequence'],
    'calendar_dates.txt': ['service_id', 'date'],
    'location_group_stops.txt': ['location_group_id', 'stop_id'],
    'frequencies.txt': ['trip_id', 'start_time'],
    'fare_rules.txt': ['fare_id', 'route_id', 'origin_id', 'destination_id', 'contains_id'],
    'transfers.txt': ['from_stop_id', 'to_stop_id', 'from_route_id', 'to_route_id', 'from_trip_id', 'to_trip_id'],
    'translations.txt': ['table_name', 'field_name', 'language', 'record_id', 'record_sub_id', 'field_value'],
    'shapes.txt': ['shape_id', 'shape_pt_sequence'],
    'route_jp.txt': ['route_id'],
  };
  function keyCols(name) {
    if (FILES[name] && FILES[name].key) return [FILES[name].key];
    return NATURAL_KEYS[name] || null;
  }
  function keyOf(name, row, i, cols) {
    if (!cols) return '#' + i;
    return cols.map(c => row[c] == null ? '' : row[c]).join('\u0001');
  }
  function index(name, rows) {
    const cols = keyCols(name);
    const m = new Map();
    rows.forEach((r, i) => {
      let k = keyOf(name, r, i, cols);
      if (m.has(k)) { let n = 2; while (m.has(k + '#' + n)) n++; k = k + '#' + n; } // 鍵の重複は別の行として扱う
      m.set(k, { row: r, index: i });
    });
    return m;
  }
  function keyLabel(name, row, i) {
    const cols = keyCols(name);
    return cols ? cols.map(c => row[c] || '').filter(Boolean).join(' / ') : `${i + 2} 行目`;
  }

  function diffTable(name, orig, cur) {
    const A = index(name, orig ? orig.rows : []), B = index(name, cur ? cur.rows : []);
    const cols = [...new Set([...(orig ? orig.header : []), ...(cur ? cur.header : [])])];
    const added = [], deleted = [], updated = [];
    for (const [k, b] of B) {
      const a = A.get(k);
      if (!a) { added.push({ key: keyLabel(name, b.row, b.index), index: b.index, row: b.row }); continue; }
      const changes = [];
      for (const c of cols) { const x = a.row[c] == null ? '' : a.row[c], y = b.row[c] == null ? '' : b.row[c]; if (x !== y) changes.push({ col: c, from: x, to: y }); }
      if (changes.length) updated.push({ key: keyLabel(name, b.row, b.index), index: b.index, row: b.row, orig: a.row, changes });
    }
    for (const [k, a] of A) if (!B.has(k)) deleted.push({ key: keyLabel(name, a.row, a.index), origIndex: a.index, row: a.row });
    const colsAdded = cur && orig ? cur.header.filter(c => !orig.header.includes(c)) : [];
    const colsRemoved = cur && orig ? orig.header.filter(c => !cur.header.includes(c)) : [];
    return { added, deleted, updated, colsAdded, colsRemoved };
  }

  function diffLocations(orig, cur) {
    const A = new Map(((orig && orig.features) || []).map((f, i) => [String(f.id), { f, i }]));
    const B = new Map(((cur && cur.features) || []).map((f, i) => [String(f.id), { f, i }]));
    const added = [], deleted = [], updated = [];
    for (const [k, b] of B) {
      const a = A.get(k);
      if (!a) { added.push({ key: k, index: b.i }); continue; }
      const changes = [];
      const pa = a.f.properties || {}, pb = b.f.properties || {};
      for (const c of new Set([...Object.keys(pa), ...Object.keys(pb)])) if ((pa[c] || '') !== (pb[c] || '')) changes.push({ col: c, from: pa[c] || '', to: pb[c] || '' });
      if (JSON.stringify(a.f.geometry) !== JSON.stringify(b.f.geometry)) changes.push({ col: 'geometry', from: '（形）', to: '（形が変わった）' });
      if (changes.length) updated.push({ key: k, index: b.i, changes });
    }
    for (const [k, a] of A) if (!B.has(k)) deleted.push({ key: k, origIndex: a.i, feature: a.f });
    return { added, deleted, updated, colsAdded: [], colsRemoved: [] };
  }

  function diff(orig, cur) {
    const files = {};
    const names = new Set([...Object.keys((orig && orig.files) || {}), ...Object.keys((cur && cur.files) || {})]);
    for (const n of names) files[n] = diffTable(n, orig && orig.files[n], cur && cur.files[n]);
    if ((orig && orig.locations) || (cur && cur.locations)) files['locations.geojson'] = diffLocations(orig && orig.locations, cur && cur.locations);
    const totals = { added: 0, updated: 0, deleted: 0 };
    for (const d of Object.values(files)) { totals.added += d.added.length; totals.updated += d.updated.length; totals.deleted += d.deleted.length; }
    return { files, totals };
  }

  window.FlexDiff = { diff, keyCols };
})();
