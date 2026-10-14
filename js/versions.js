// GTFS-Flex の版の違いを吸収する。内部ではつねに正式版（2024-03 に GTFS 本体へ採択された形）で持つ。
//
//   canonical  正式版（GTFS Schedule 2024-03〜）: stop_times に stop_id / location_group_id / location_id の 3 列、
//              location_groups.txt（id, name）+ location_group_stops.txt（group, stop）、start/end_pickup_drop_off_window
//   draft2022  v2 後期ドラフト（2022〜2023、MobilityData/gtfs-flex d85b752）: stop_times.stop_id 1 列に 停留所 / areas.area_id / locations の id を入れる。
//              グループは areas.txt + stop_areas.txt。列名は正式版と同じ。mean/safe_duration_* の列がある
//   draft2020  v2 初期ドラフト（2020、同 44397b2）: stop_times.stop_id 1 列に 停留所 / location_group_id / locations の id。
//              グループは location_groups.txt（location_group_id, location_id, location_group_name）の複数行。列名は start/end_pickup_dropoff_window
//
// 読み込み: detect() で版を判定し、toCanonical() で正式版へ直す（何をどう直したかを notes に残す）。
// 書き出し: fromCanonical(feed, version) で古い形に戻す（古い経路検索に渡すとき用）。
(function () {
  'use strict';
  const VERSIONS = {
    canonical: { label: 'GTFS-Flex 正式版（2024-03 採択、GTFS Schedule）', short: '正式版' },
    draft2022: { label: 'GTFS-Flex v2 後期ドラフト（2022〜23、areas / stop_areas 方式）', short: 'v2 後期ドラフト' },
    draft2020: { label: 'GTFS-Flex v2 初期ドラフト（2020、location_groups に location_id、pickup_dropoff_window）', short: 'v2 初期ドラフト' },
  };
  const DRAFT_ONLY_COLUMNS = ['mean_duration_factor', 'mean_duration_offset', 'safe_duration_factor', 'safe_duration_offset'];

  const rows = (feed, n) => (feed.files[n] ? feed.files[n].rows : []);
  const header = (feed, n) => (feed.files[n] ? feed.files[n].header : []);
  const has = (feed, n) => !!feed.files[n] && feed.files[n].rows.length > 0;
  const locIds = feed => new Set(((feed.locations && feed.locations.features) || []).map(f => String(f.id)));

  function detect(feed) {
    const stH = header(feed, 'stop_times.txt');
    if (stH.includes('start_pickup_dropoff_window') || stH.includes('end_pickup_dropoff_window')) return 'draft2020';
    if (header(feed, 'location_groups.txt').includes('location_id') && !has(feed, 'location_group_stops.txt')) return 'draft2020';
    if (stH.includes('location_group_id') || stH.includes('location_id') || has(feed, 'location_group_stops.txt')) return 'canonical';
    // 後期ドラフト: stop_times.stop_id に areas の id や locations の id が入っている
    const areaIds = new Set(rows(feed, 'areas.txt').map(r => r.area_id).concat(rows(feed, 'stop_areas.txt').map(r => r.area_id)));
    const lids = locIds(feed);
    const stopIds = new Set(rows(feed, 'stops.txt').map(r => r.stop_id));
    const st = rows(feed, 'stop_times.txt');
    const hasWindow = st.some(r => r.start_pickup_drop_off_window || r.end_pickup_drop_off_window);
    if (hasWindow && st.some(r => r.stop_id && !stopIds.has(r.stop_id) && (areaIds.has(r.stop_id) || lids.has(r.stop_id)))) return 'draft2022';
    if (DRAFT_ONLY_COLUMNS.some(c => stH.includes(c)) && !stH.includes('location_group_id')) return 'draft2022';
    return 'canonical';
  }

  // 古い形 → 正式版。feed をその場で直す。戻り値は { version, notes: [...] }
  function toCanonical(feed) {
    const version = detect(feed);
    const notes = [];
    if (version === 'canonical') return { version, notes };
    const G = window.GTFS;
    const st = feed.files['stop_times.txt'];
    if (version === 'draft2020' && st) {
      for (const [from, to] of [['start_pickup_dropoff_window', 'start_pickup_drop_off_window'], ['end_pickup_dropoff_window', 'end_pickup_drop_off_window']]) {
        if (st.header.includes(from)) {
          st.header = st.header.map(h => (h === from ? to : h));
          for (const r of st.rows) { if (r[from] != null) { if (!r[to]) r[to] = r[from]; delete r[from]; } }
          notes.push(`stop_times.txt の列 ${from} を ${to} に直した`);
        }
      }
    }
    // グループ: draft2020 の location_groups（複数行）/ draft2022 の areas + stop_areas → location_groups + location_group_stops
    const stopIds = new Set(rows(feed, 'stops.txt').map(r => r.stop_id));
    const lids = locIds(feed);
    const groups = new Map(); // id -> { name, members: [stop_id], locs: [location id] }
    if (version === 'draft2020' && header(feed, 'location_groups.txt').includes('location_id')) {
      for (const r of rows(feed, 'location_groups.txt')) {
        if (!groups.has(r.location_group_id)) groups.set(r.location_group_id, { name: r.location_group_name || '', members: [], locs: [] });
        const g = groups.get(r.location_group_id);
        if (r.location_group_name && !g.name) g.name = r.location_group_name;
        if (!r.location_id) continue;
        if (lids.has(r.location_id) && !stopIds.has(r.location_id)) g.locs.push(r.location_id); else g.members.push(r.location_id);
      }
      notes.push(`location_groups.txt（${rows(feed, 'location_groups.txt').length} 行、location_id 方式）を location_groups.txt + location_group_stops.txt に分けた`);
    }
    if (version === 'draft2022') {
      const used = new Set(rows(feed, 'stop_times.txt').map(r => r.stop_id).filter(id => id && !stopIds.has(id) && !lids.has(id)));
      const areaName = new Map(rows(feed, 'areas.txt').map(r => [r.area_id, r.area_name || '']));
      for (const id of used) groups.set(id, { name: areaName.get(id) || '', members: [], locs: [] });
      for (const r of rows(feed, 'stop_areas.txt')) {
        if (!groups.has(r.area_id)) continue;
        if (lids.has(r.stop_id) && !stopIds.has(r.stop_id)) groups.get(r.area_id).locs.push(r.stop_id); else groups.get(r.area_id).members.push(r.stop_id);
      }
      if (used.size) notes.push(`stop_times.txt が参照する areas（${[...used].join(', ')}）を location_groups.txt + location_group_stops.txt に写した（areas.txt / stop_areas.txt はそのまま残す）`);
    }
    if (groups.size) {
      const lg = G.ensureTable(feed, 'location_groups.txt'); lg.header = ['location_group_id', 'location_group_name']; lg.rows = [];
      const lgs = G.ensureTable(feed, 'location_group_stops.txt'); lgs.header = ['location_group_id', 'stop_id']; lgs.rows = [];
      for (const [id, g] of groups) {
        lg.rows.push({ location_group_id: id, location_group_name: g.name });
        for (const s of g.members) lgs.rows.push({ location_group_id: id, stop_id: s });
        if (g.locs.length) notes.push(`グループ "${id}" に区域（locations.geojson）${g.locs.join(', ')} が入っていたが、正式版ではグループに区域を入れられないので外した（便の行で location_id として直接使う）`);
      }
    }
    // stop_times.stop_id 1 列 → stop_id / location_group_id / location_id の 3 列
    if (st) {
      for (const c of ['location_group_id', 'location_id']) if (!st.header.includes(c)) st.header.splice(st.header.indexOf('stop_id') + 1, 0, c);
      let moved = 0;
      for (const r of st.rows) {
        if (!r.stop_id || stopIds.has(r.stop_id)) continue;
        if (groups.has(r.stop_id)) { r.location_group_id = r.stop_id; r.stop_id = ''; moved++; }
        else if (lids.has(r.stop_id)) { r.location_id = r.stop_id; r.stop_id = ''; moved++; }
      }
      if (moved) notes.push(`stop_times.txt の ${moved} 行で、stop_id に入っていたグループ／区域の ID を location_group_id / location_id に移した`);
      const draftCols = DRAFT_ONLY_COLUMNS.filter(c => st.header.includes(c) && st.rows.some(r => r[c]));
      if (draftCols.length) notes.push(`ドラフト版だけの列 ${draftCols.join(', ')} は正式版にないので、そのまま残す（検証で「仕様外」と出る）`);
    }
    return { version, notes };
  }

  // 正式版 → 古い形。元の feed は変えず、写しを返す
  function fromCanonical(feed, version) {
    if (!version || version === 'canonical') return feed;
    const G = window.GTFS;
    const out = structuredClone(feed);
    const st = out.files['stop_times.txt'];
    if (st) {
      for (const r of st.rows) {
        if (!r.stop_id) r.stop_id = r.location_group_id || r.location_id || '';
        delete r.location_group_id; delete r.location_id;
      }
      st.header = st.header.filter(h => h !== 'location_group_id' && h !== 'location_id');
      if (version === 'draft2020') {
        for (const [from, to] of [['start_pickup_drop_off_window', 'start_pickup_dropoff_window'], ['end_pickup_drop_off_window', 'end_pickup_dropoff_window']]) {
          st.header = st.header.map(h => (h === from ? to : h));
          for (const r of st.rows) { if (r[from] != null) { r[to] = r[from]; delete r[from]; } }
        }
      }
    }
    const lg = rows(out, 'location_groups.txt'), lgs = rows(out, 'location_group_stops.txt');
    if (version === 'draft2020') {
      const t = { header: ['location_group_id', 'location_id', 'location_group_name'], rows: [] };
      for (const g of lg) {
        const members = lgs.filter(m => m.location_group_id === g.location_group_id);
        if (!members.length) t.rows.push({ location_group_id: g.location_group_id, location_id: '', location_group_name: g.location_group_name || '' });
        for (const m of members) t.rows.push({ location_group_id: g.location_group_id, location_id: m.stop_id, location_group_name: g.location_group_name || '' });
      }
      out.files['location_groups.txt'] = t;
      delete out.files['location_group_stops.txt'];
    }
    if (version === 'draft2022') {
      const areas = G.ensureTable(out, 'areas.txt'), sa = G.ensureTable(out, 'stop_areas.txt');
      const have = new Set(areas.rows.map(r => r.area_id));
      for (const g of lg) if (!have.has(g.location_group_id)) areas.rows.push(Object.assign(G.newRow('areas.txt'), { area_id: g.location_group_id, area_name: g.location_group_name || '' }));
      const haveSA = new Set(sa.rows.map(r => r.area_id + '\u0001' + r.stop_id));
      for (const m of lgs) if (!haveSA.has(m.location_group_id + '\u0001' + m.stop_id)) sa.rows.push({ area_id: m.location_group_id, stop_id: m.stop_id });
      delete out.files['location_groups.txt'];
      delete out.files['location_group_stops.txt'];
    }
    return out;
  }

  window.FlexVersions = { VERSIONS, DRAFT_ONLY_COLUMNS, detect, toCanonical, fromCanonical };
})();
