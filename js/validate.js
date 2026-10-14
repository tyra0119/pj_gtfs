// GTFS-Flex の検証。
// 2 段階で行う。
//   1. 仕様（spec.js）から自動で行う検査: 必須ファイル、必須列、ID の重複、型（数値・日付・時刻・URL・列挙）、参照先の存在
//   2. RULES に並べた個別の規則: Flex 固有の条件付き必須・禁止、便の整合、使われていないもの など
// 規則は id を持ち、validate(feed, { disabled: ['unused', ...] }) で外せる。規則を足すときは RULES に 1 つ足すだけ。
// 結果: { level: 'error'|'warn'|'info', file, row (1 始まりの行番号。ヘッダーが 1 行目), field, msg, code, rule }
(function () {
  'use strict';
  const { FILES } = window.FLEX_SPEC;
  const { parseTime } = window.GTFS;

  const JP = { latMin: 20, latMax: 46, lonMin: 122, lonMax: 154 };

  // ---------- 文脈 ----------
  function makeCtx(feed) {
    const out = [];
    const F = feed.files;
    const R = n => (F[n] ? F[n].rows : []);
    const has = n => !!F[n] && F[n].rows.length > 0;
    const locs = feed.locations && Array.isArray(feed.locations.features) ? feed.locations.features : [];
    let currentRule = '';
    // fix: { label, safe, apply(feed) } 修正案。safe=true は「まとめて適用」してよいもの（値の整形など）。消す系は safe にしない。
    const add = (level, file, rowIdx, field, msg, code, fix) => out.push({ level, file, row: rowIdx == null ? null : rowIdx + 2, field: field || '', msg, code, rule: currentRule, fix: fix || null });
    const delRow = (name, r, label) => ({ label: label || 'この行を消す', safe: false, apply: feed => { const t = feed.files[name]; const i = t.rows.indexOf(r); if (i >= 0) t.rows.splice(i, 1); } });
    const setVal = (r, col, val, label, safe) => ({ label: label || `${col} を "${val}" にする`, safe: !!safe, apply: () => { r[col] = val; } });
    const ctx = {
      feed, F, R, has, locs, out,
      setRule: id => { currentRule = id; },
      err: (...a) => add('error', ...a),
      warn: (...a) => add('warn', ...a),
      info: (...a) => add('info', ...a),
      delRow, setVal,
      ids: {},        // file -> Map(id -> rowIdx)
      serviceIds: new Set([...R('calendar.txt').map(r => r.service_id), ...R('calendar_dates.txt').map(r => r.service_id)].filter(Boolean)),
      locIds: new Map(),
      today: today(),
    };
    for (const [name, spec] of Object.entries(FILES)) {
      if (!spec.key || !F[name]) continue;
      const m = new Map();
      F[name].rows.forEach((r, i) => { if (r[spec.key] && !m.has(r[spec.key])) m.set(r[spec.key], i); });
      ctx.ids[name] = m;
    }
    locs.forEach((f, i) => { if (f && f.id != null && f.id !== '' && !ctx.locIds.has(String(f.id))) ctx.locIds.set(String(f.id), i); });
    ctx.refIds = ref => {
      if (ref === 'calendar') return ctx.serviceIds;
      if (ref === 'locations.geojson') return ctx.locIds;
      return ctx.ids[ref] || new Map();
    };
    return ctx;
  }

  // ---------- 型の検査 ----------
  const TYPE_CHECK = {
    int: v => /^\d+$/.test(v) ? null : '0 以上の整数',
    float: v => /^-?\d+(\.\d+)?$/.test(v) ? null : '数値',
    lat: v => { const n = parseFloat(v); return isNaN(n) || !/^-?\d+(\.\d+)?$/.test(v) ? '数値' : (n < -90 || n > 90 ? '-90〜90' : null); },
    lon: v => { const n = parseFloat(v); return isNaN(n) || !/^-?\d+(\.\d+)?$/.test(v) ? '数値' : (n < -180 || n > 180 ? '-180〜180' : null); },
    date: v => {
      if (!/^\d{8}$/.test(v)) return 'YYYYMMDD の 8 桁';
      const y = +v.slice(0, 4), m = +v.slice(4, 6), d = +v.slice(6, 8);
      const dt = new Date(Date.UTC(y, m - 1, d));
      return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? null : '実在する日付';
    },
    time: v => parseTime(v) == null ? 'HH:MM:SS（24 時を超えてもよい）' : null,
    url: v => /^https?:\/\/\S+$/.test(v) ? null : 'http(s):// で始まる URL',
    email: v => /^[^\s@]+@[^\s@]+$/.test(v) ? null : 'メールアドレス',
    color: v => /^[0-9A-Fa-f]{6}$/.test(v) ? null : '6 桁の 16 進（例 008080）',
    lang: v => /^[a-zA-Z]{2,3}(-[A-Za-z0-9]+)*$/.test(v) ? null : '言語コード（ja など）',
    tz: v => /^[A-Za-z_]+\/[A-Za-z_\-+0-9]+$/.test(v) ? null : 'タイムゾーン（Asia/Tokyo）',
  };

  // ---------- 規則 ----------
  const RULES = [
    {
      id: 'spec', label: '仕様どおりか（必須ファイル・必須列・ID 重複・型・参照）', run(c) {
        const { F, R, has, err, warn, info } = c;
        for (const [name, spec] of Object.entries(FILES)) {
          if (spec.presence === 'required' && !has(name)) err(name, null, '', `${name}（${spec.label}）がない、または行がない`, 'missing_file');
        }
        if (!has('calendar.txt') && !has('calendar_dates.txt')) err('calendar.txt', null, '', 'calendar.txt か calendar_dates.txt のどちらかが必要', 'missing_calendar');
        if (!has('feed_info.txt')) err('feed_info.txt', null, '', 'feed_info.txt がない（GTFS-JP と ODPT への提供では必須）', 'missing_feed_info', { label: 'agency.txt の内容から feed_info.txt を作る', safe: true, apply: feed => { const a = (feed.files['agency.txt'] && feed.files['agency.txt'].rows[0]) || {}; const t = window.GTFS.ensureTable(feed, 'feed_info.txt'); if (!t.rows.length) t.rows.push(window.GTFS.newRow('feed_info.txt', { feed_publisher_name: a.agency_name || '', feed_publisher_url: a.agency_url || '', feed_lang: 'ja' })); } });
        if (!has('stops.txt') && !c.locs.length && !has('location_groups.txt')) err('stops.txt', null, '', 'stops.txt がない（区域だけのデータでも locations.geojson が要る）', 'missing_file');
        if (feed_bad_geojson(c)) return;
        for (const [name, spec] of Object.entries(FILES)) {
          if (!F[name]) continue;
          const t = F[name];
          const present = new Set(t.header);
          const required = spec.fields.filter(x => x.required === true);
          for (const fd of required) if (!present.has(fd.name) && t.rows.length) err(name, null, fd.name, `必須列 ${fd.name}（${fd.label}）がない`, 'missing_column');
          for (const col of t.header) if (col && !spec.fields.some(x => x.name === col)) info(name, null, col, `仕様にない列 ${col}（そのまま書き出す）`, 'unknown_column');
          for (const fd of spec.fields) if (fd.draft && present.has(fd.name) && !t.rows.some(r => r[fd.name])) { /* 空のドラフト列は書き出しで省かれるので何も言わない */ }
          if (spec.key) {
            const seen = new Map();
            t.rows.forEach((r, i) => {
              const v = r[spec.key];
              if (!v) { err(name, i, spec.key, `${spec.key} が空`, 'empty_key'); return; }
              if (seen.has(v)) err(name, i, spec.key, `${spec.key} "${v}" が重複（${seen.get(v) + 2} 行目と同じ）`, 'dup_key');
              else seen.set(v, i);
            });
          }
          t.rows.forEach((r, i) => {
            for (const fd of spec.fields) {
              const v = r[fd.name] == null ? '' : String(r[fd.name]);
              if (v === '') { if (fd.required === true && fd.name !== spec.key && present.has(fd.name)) err(name, i, fd.name, `${fd.name}（${fd.label}）が空`, 'empty_required'); continue; }
              if (fd.type === 'enum') { if (!(v in fd.values)) err(name, i, fd.name, `${fd.name} "${v}" は ${Object.keys(fd.values).filter(Boolean).join(' / ')} のどれか`, 'bad_enum'); }
              else if (fd.type === 'ref') {
                const ids = c.refIds(fd.ref);
                if (!ids.has(v)) {
                  const child = ['stop_times.txt', 'location_group_stops.txt', 'calendar_dates.txt', 'fare_rules.txt', 'frequencies.txt', 'transfers.txt'].includes(name);
                  err(name, i, fd.name, `${fd.name} "${v}" が ${fd.ref === 'calendar' ? 'calendar.txt / calendar_dates.txt' : fd.ref} にない`, 'ref', child ? delRow(name, r) : (fd.required !== true ? setVal(r, fd.name, '', `${fd.name} を空にする`, false) : null));
                }
              }
              else if (TYPE_CHECK[fd.type]) {
                const bad = TYPE_CHECK[fd.type](v);
                if (bad) {
                  let fix = null;
                  if (fd.type === 'time' && /^\d{1,2}:\d{1,2}$/.test(v)) fix = setVal(r, fd.name, v.split(':').map(x => x.padStart(2, '0')).join(':') + ':00', null, true);
                  else if (fd.type === 'time' && /^\d{1,2}:\d{2}:\d{2}$/.test(v)) fix = setVal(r, fd.name, v.padStart(8, '0'), null, true);
                  else if (fd.type === 'date' && /^\d{4}[-\/]\d{1,2}[-\/]\d{1,2}$/.test(v)) { const m = v.split(/[-\/]/); fix = setVal(r, fd.name, m[0] + m[1].padStart(2, '0') + m[2].padStart(2, '0'), null, true); }
                  else if (fd.type === 'color' && /^#[0-9A-Fa-f]{6}$/.test(v)) fix = setVal(r, fd.name, v.slice(1), null, true);
                  else if (fd.type === 'url' && /^www\./.test(v)) fix = setVal(r, fd.name, 'https://' + v, null, true);
                  else if ((fd.type === 'int' || fd.type === 'float') && /^\s*-?[\d.]+\s*$/.test(v)) fix = setVal(r, fd.name, v.trim(), null, true);
                  err(name, i, fd.name, `${fd.name} "${v}" は ${bad}`, 'bad_' + fd.type, fix);
                }
              }
            }
          });
        }
      },
    },
    {
      id: 'flex_presence', label: 'Flex の要素があるか', run(c) {
        const { R, has, info } = c;
        const stH = c.F['stop_times.txt'] ? c.F['stop_times.txt'].header : [];
        const draftCols = (window.FlexVersions ? window.FlexVersions.DRAFT_ONLY_COLUMNS : []).filter(col => stH.includes(col) && R('stop_times.txt').some(r => r[col]));
        if (draftCols.length) info('stop_times.txt', null, draftCols[0], `ドラフト版（2020〜23）だけの列 ${draftCols.join(', ')} に値がある。正式版の経路検索は読まない（害はない）`, 'draft_column');
        if (c.feed.flexVersion && c.feed.flexVersion !== 'canonical') info('stop_times.txt', null, '', `読み込んだデータは ${window.FlexVersions.VERSIONS[c.feed.flexVersion].short} の形だったので、正式版に直して扱っている（書き出しの形式は上で選べる）`, 'converted');
        const usesFlex = R('stop_times.txt').some(r => r.location_group_id || r.location_id || r.start_pickup_drop_off_window || r.end_pickup_drop_off_window) || has('booking_rules.txt') || has('location_groups.txt') || c.locs.length > 0;
        if (!usesFlex) info('stop_times.txt', null, '', 'GTFS-Flex の要素（乗降時間帯・区域・予約ルール）が見当たらない。通常の GTFS として扱う', 'not_flex');
      },
    },
    {
      id: 'agency', label: '事業者・データ情報', run(c) {
        const { R, err, warn, info } = c;
        R('agency.txt').forEach((r, i) => {
          if (!r.agency_phone) info('agency.txt', i, 'agency_phone', '事業者の電話番号が空（デマンド交通では問い合わせ先として入れるとよい）', 'agency_phone');
          if (r.agency_timezone && r.agency_timezone !== 'Asia/Tokyo') info('agency.txt', i, 'agency_timezone', `タイムゾーンが ${r.agency_timezone}（日本なら Asia/Tokyo）`, 'tz', c.setVal(r, 'agency_timezone', 'Asia/Tokyo', null, false));
          if (R('agency.txt').length > 1 && !r.agency_id) err('agency.txt', i, 'agency_id', '事業者が複数あるときは agency_id が必須', 'cond_required', c.setVal(r, 'agency_id', 'agency' + (i + 1), null, false));
        });
        R('feed_info.txt').forEach((r, i) => {
          for (const k of ['feed_start_date', 'feed_end_date', 'feed_version']) if (!r[k]) err('feed_info.txt', i, k, `${k} が空（GTFS-JP v4 では必須。有効期間と版）`, 'publish_missing', k === 'feed_version' ? c.setVal(r, 'feed_version', c.today, `feed_version を今日の日付 ${c.today} にする`, false) : (R('calendar.txt')[0] && R('calendar.txt')[0][k === 'feed_start_date' ? 'start_date' : 'end_date'] ? c.setVal(r, k, R('calendar.txt')[0][k === 'feed_start_date' ? 'start_date' : 'end_date'], `calendar.txt の期間 ${R('calendar.txt')[0][k === 'feed_start_date' ? 'start_date' : 'end_date']} を入れる`, false) : null));
          if (r.feed_start_date && r.feed_end_date && r.feed_start_date > r.feed_end_date) err('feed_info.txt', i, 'feed_end_date', '終了日が開始日より前', 'date_order');
          if (r.feed_end_date && /^\d{8}$/.test(r.feed_end_date) && r.feed_end_date < c.today) warn('feed_info.txt', i, 'feed_end_date', `feed_end_date ${r.feed_end_date} はすでに過ぎている`, 'expired');
        });
      },
    },
    {
      id: 'stops', label: '停留所', run(c) {
        const { R, err, warn } = c;
        R('stops.txt').forEach((r, i) => {
          const lt = r.location_type || '0';
          if (lt === '0' || lt === '1' || lt === '2') {
            if (!r.stop_name) err('stops.txt', i, 'stop_name', 'stop_name（停留所名）が空', 'cond_required');
            if (!r.stop_lat || !r.stop_lon) err('stops.txt', i, 'stop_lat', '緯度経度が空', 'cond_required');
            else {
              const lat = parseFloat(r.stop_lat), lon = parseFloat(r.stop_lon);
              if (!isNaN(lat) && !isNaN(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat >= JP.latMin && lat <= JP.latMax && lon >= JP.lonMin && lon <= JP.lonMax)) {
                const swapped = lon >= JP.latMin && lon <= JP.latMax && lat >= JP.lonMin && lat <= JP.lonMax;
                warn('stops.txt', i, 'stop_lat', `日本の範囲外の座標（${lat}, ${lon}）。緯度と経度が逆になっていないか`, 'coord_outside_japan', swapped ? { label: '緯度と経度を入れ替える', safe: true, apply: () => { const a = r.stop_lat; r.stop_lat = r.stop_lon; r.stop_lon = a; } } : null);
              }
            }
          }
          if (lt === '2' || lt === '3' || lt === '4') { if (!r.parent_station) err('stops.txt', i, 'parent_station', `location_type=${lt} では parent_station が必須`, 'cond_required'); }
        });
      },
    },
    {
      id: 'routes', label: '路線', run(c) {
        const { R, err, info } = c;
        const multi = R('agency.txt').length > 1;
        R('routes.txt').forEach((r, i) => {
          if (!r.route_short_name && !r.route_long_name) err('routes.txt', i, 'route_long_name', 'route_short_name か route_long_name のどちらかが必要', 'cond_required');
          if (!r.agency_id && multi) err('routes.txt', i, 'agency_id', '事業者が複数あるので agency_id が必要', 'cond_required');
          if (r.route_type && r.route_type !== '3' && r.route_type !== '715') info('routes.txt', i, 'route_type', `route_type ${r.route_type}（バスは 3。デマンド交通に拡張の 715 を使う例もある）`, 'route_type');
        });
      },
    },
    {
      id: 'calendar', label: '運行日', run(c) {
        const { R, err, warn } = c;
        const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
        R('calendar.txt').forEach((r, i) => {
          if (days.every(d => r[d] === '0') && !R('calendar_dates.txt').some(x => x.service_id === r.service_id && x.exception_type === '1')) warn('calendar.txt', i, 'monday', `service_id "${r.service_id}" は運行する曜日がない`, 'no_days');
          if (r.start_date && r.end_date && r.start_date > r.end_date) err('calendar.txt', i, 'end_date', '終了日が開始日より前', 'date_order');
          if (r.end_date && /^\d{8}$/.test(r.end_date) && r.end_date < c.today) warn('calendar.txt', i, 'end_date', `end_date ${r.end_date} はすでに過ぎている`, 'expired');
        });
        R('calendar_dates.txt').forEach((r, i) => {
          if (r.exception_type === '2' && !R('calendar.txt').some(x => x.service_id === r.service_id)) warn('calendar_dates.txt', i, 'service_id', `calendar.txt にない service_id "${r.service_id}" を運休にしている`, 'ref');
          const cal = R('calendar.txt').find(x => x.service_id === r.service_id);
          if (cal && r.exception_type === '2' && /^\d{8}$/.test(r.date) && (r.date < cal.start_date || r.date > cal.end_date)) warn('calendar_dates.txt', i, 'date', `${r.date} は calendar.txt の期間（${cal.start_date}〜${cal.end_date}）の外`, 'date_outside');
        });
      },
    },
    {
      id: 'locations', label: '区域ポリゴン（locations.geojson）', run(c) {
        const { feed, locs, err, warn, info, ids } = c;
        if (!feed.locations || feed.locations._parseError) return;
        if (feed.locations.type !== 'FeatureCollection') err('locations.geojson', null, '', 'type は FeatureCollection', 'geojson_type');
        const stopIds = ids['stops.txt'] || new Map(), groupIds = ids['location_groups.txt'] || new Map();
        const seen = new Set();
        locs.forEach((f, i) => {
          const id = f && f.id != null ? String(f.id) : '';
          if (!id) err('locations.geojson', i, 'id', `${i + 1} 番目の区域に id がない`, 'geojson_id');
          else {
            if (seen.has(id)) err('locations.geojson', i, 'id', `区域 id "${id}" が重複`, 'dup_key');
            seen.add(id);
            if (stopIds.has(id)) err('locations.geojson', i, 'id', `区域 id "${id}" が stop_id と重複（id は stops / location_groups / locations の間で一意）`, 'id_clash');
            if (groupIds.has(id)) err('locations.geojson', i, 'id', `区域 id "${id}" が location_group_id と重複`, 'id_clash');
          }
          const g = f && f.geometry;
          if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) { err('locations.geojson', i, 'geometry', `区域 "${id}" の geometry は Polygon か MultiPolygon`, 'geojson_geom'); return; }
          const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
          polys.forEach(poly => (poly || []).forEach((ring, k) => {
            if (!Array.isArray(ring) || ring.length < 4) { err('locations.geojson', i, 'geometry', `区域 "${id}" のリングは 4 点以上（始点と終点が同じ）`, 'ring_short'); return; }
            const a = ring[0], b = ring[ring.length - 1];
            if (a[0] !== b[0] || a[1] !== b[1]) err('locations.geojson', i, 'geometry', `区域 "${id}" のリングが閉じていない（始点と終点が違う）`, 'ring_open', { label: '始点をコピーして閉じる', safe: true, apply: () => { ring.push(ring[0].slice()); } });
            const area = ringArea(ring);
            if (k === 0 && area < 0) warn('locations.geojson', i, 'geometry', `区域 "${id}" の外周が時計回り（RFC 7946 は反時計回り）`, 'ring_winding', { label: '向きを反転する', safe: true, apply: () => { ring.reverse(); } });
            if (k > 0 && area > 0) warn('locations.geojson', i, 'geometry', `区域 "${id}" の穴が反時計回り（RFC 7946 は時計回り）`, 'ring_winding', { label: '向きを反転する', safe: true, apply: () => { ring.reverse(); } });
            if (Math.abs(area) < 1e-10) warn('locations.geojson', i, 'geometry', `区域 "${id}" の面積がほぼ 0`, 'ring_zero');
            if (selfIntersects(ring)) warn('locations.geojson', i, 'geometry', `区域 "${id}" の辺が交差している（8 の字になっている）`, 'ring_cross');
            for (const p of ring) if (!(p[1] >= JP.latMin && p[1] <= JP.latMax && p[0] >= JP.lonMin && p[0] <= JP.lonMax)) { warn('locations.geojson', i, 'geometry', `区域 "${id}" に日本の範囲外の座標がある（[経度, 緯度] の順か）`, 'coord_outside_japan'); break; }
          }));
          if (!f.properties || !f.properties.stop_name) info('locations.geojson', i, 'stop_name', `区域 "${id}" に stop_name がない（案内の表示名に使われる）`, 'loc_name');
        });
      },
    },
    {
      id: 'location_groups', label: '停留所グループ', run(c) {
        const { R, err, warn, ids } = c;
        const stopIds = ids['stops.txt'] || new Map();
        const members = new Map();
        R('location_group_stops.txt').forEach((r, i) => {
          if (!members.has(r.location_group_id)) members.set(r.location_group_id, new Set());
          if (members.get(r.location_group_id).has(r.stop_id)) warn('location_group_stops.txt', i, 'stop_id', `停留所 "${r.stop_id}" がグループ "${r.location_group_id}" に 2 回入っている`, 'dup_member', c.delRow('location_group_stops.txt', r, '重複した行を消す'));
          members.get(r.location_group_id).add(r.stop_id);
        });
        R('location_groups.txt').forEach((r, i) => {
          if (!r.location_group_name) warn('location_groups.txt', i, 'location_group_name', `グループ "${r.location_group_id}" に名前がない（経路検索で区域名として表示される）`, 'group_name');
          if (!members.has(r.location_group_id) || members.get(r.location_group_id).size === 0) err('location_groups.txt', i, 'location_group_id', `グループ "${r.location_group_id}" に停留所が 1 つも入っていない`, 'group_empty', { label: 'すべての停留所をこのグループに入れる', safe: false, apply: feed => { const t = window.GTFS.ensureTable(feed, 'location_group_stops.txt'); for (const s of R('stops.txt')) if ((s.location_type || '0') === '0') t.rows.push(window.GTFS.newRow('location_group_stops.txt', { location_group_id: r.location_group_id, stop_id: s.stop_id })); } });
          if (stopIds.has(r.location_group_id)) err('location_groups.txt', i, 'location_group_id', `location_group_id "${r.location_group_id}" が stop_id と重複`, 'id_clash');
        });
      },
    },
    {
      id: 'booking_rules', label: '予約ルールの条件付き必須・禁止', run(c) {
        const { R, err, warn, info } = c;
        const f = 'booking_rules.txt';
        R(f).forEach((r, i) => {
          const bt = r.booking_type;
          if (!['0', '1', '2'].includes(bt)) return;
          const min = r.prior_notice_duration_min, max = r.prior_notice_duration_max, sday = r.prior_notice_start_day, stime = r.prior_notice_start_time, lday = r.prior_notice_last_day, ltime = r.prior_notice_last_time, sid = r.prior_notice_service_id;
          const clear = col => c.setVal(r, col, '', `${col} を空にする`, true);
          if (bt === '1' && !min) err(f, i, 'prior_notice_duration_min', 'booking_type=1 では prior_notice_duration_min（何分前まで）が必須', 'cond_required', c.setVal(r, 'prior_notice_duration_min', '0', 'prior_notice_duration_min を 0（直前まで可）にする。実際の締め切りがあれば直す', false));
          if (bt !== '1' && min) err(f, i, 'prior_notice_duration_min', 'prior_notice_duration_min は booking_type=1 のときだけ', 'cond_forbidden', clear('prior_notice_duration_min'));
          if (bt !== '1' && max) err(f, i, 'prior_notice_duration_max', 'prior_notice_duration_max は booking_type=1 のときだけ', 'cond_forbidden', clear('prior_notice_duration_max'));
          if (bt === '2' && !lday) err(f, i, 'prior_notice_last_day', 'booking_type=2 では prior_notice_last_day（何日前まで）が必須', 'cond_required', c.setVal(r, 'prior_notice_last_day', '1', 'prior_notice_last_day を 1（前日まで）にする。違えば直す', false));
          if (bt !== '2' && lday) err(f, i, 'prior_notice_last_day', 'prior_notice_last_day は booking_type=2 のときだけ', 'cond_forbidden', clear('prior_notice_last_day'));
          if (lday && !ltime) err(f, i, 'prior_notice_last_time', 'prior_notice_last_day があるときは prior_notice_last_time が必須', 'cond_required', c.setVal(r, 'prior_notice_last_time', '17:00:00', 'prior_notice_last_time を 17:00:00 にする。実際の受付終了時刻に直す', false));
          if (ltime && !lday) err(f, i, 'prior_notice_last_time', 'prior_notice_last_time は prior_notice_last_day とセット', 'cond_forbidden', clear('prior_notice_last_time'));
          if (bt === '0' && sday) err(f, i, 'prior_notice_start_day', 'booking_type=0 では prior_notice_start_day は使えない', 'cond_forbidden', clear('prior_notice_start_day'));
          // 公式仕様: prior_notice_start_day は booking_type=1 で prior_notice_duration_max が定義されているときに禁止（両方は「予約開始」の二重指定になる）
          if (bt === '1' && sday && max) err(f, i, 'prior_notice_start_day', 'booking_type=1 では prior_notice_duration_max（○分前から）と prior_notice_start_day（○日前から）を同時に使えない。どちらか一方に', 'cond_forbidden', { label: 'prior_notice_start_day / start_time を空にして duration_max を残す', safe: false, apply: () => { r.prior_notice_start_day = ''; r.prior_notice_start_time = ''; } });
          if (sday && !stime) err(f, i, 'prior_notice_start_time', 'prior_notice_start_day があるときは prior_notice_start_time が必須', 'cond_required', c.setVal(r, 'prior_notice_start_time', '00:00:00', null, true));
          if (stime && !sday) err(f, i, 'prior_notice_start_time', 'prior_notice_start_time は prior_notice_start_day とセット', 'cond_forbidden', clear('prior_notice_start_time'));
          if (sid && bt !== '2') err(f, i, 'prior_notice_service_id', 'prior_notice_service_id は booking_type=2 のときだけ', 'cond_forbidden', clear('prior_notice_service_id'));
          if (min && max && /^\d+$/.test(min) && /^\d+$/.test(max) && +min > +max) err(f, i, 'prior_notice_duration_max', 'duration_max が duration_min より小さい', 'range');
          if (sday && /^\d+$/.test(sday) && +sday > 365) warn(f, i, 'prior_notice_start_day', `prior_notice_start_day=${sday} は「日数」。分で書いていないか（${sday} 日 ≒ ${(sday / 365).toFixed(1)} 年）`, 'suspicious_day',
            bt === '1' ? { label: `値 ${sday} は分とみなし prior_notice_duration_max=${sday} に移して、start_day / start_time を空にする`, safe: false, apply: () => { r.prior_notice_duration_max = sday; r.prior_notice_start_day = ''; r.prior_notice_start_time = ''; } }
              : { label: `${sday} 分 ≒ ${Math.round(sday / 1440)} 日とみなして prior_notice_start_day=${Math.round(sday / 1440)} にする`, safe: false, apply: () => { r.prior_notice_start_day = String(Math.round(sday / 1440)); } });
          if (lday && /^\d+$/.test(lday) && +lday > 60) warn(f, i, 'prior_notice_last_day', `prior_notice_last_day=${lday} 日前まで、は長すぎないか`, 'suspicious_day');
          if (max && /^\d+$/.test(max) && +max > 60 * 24 * 60) warn(f, i, 'prior_notice_duration_max', `prior_notice_duration_max=${max} 分（約 ${(max / 1440).toFixed(0)} 日）は長すぎないか`, 'suspicious_day');
          if (bt !== '0' && !r.phone_number && !r.booking_url && !r.info_url) {
            const ag = R('agency.txt')[0] || {};
            warn(f, i, 'phone_number', '予約が必要なのに電話番号・予約 URL・案内 URL のどれもない（利用者が予約先を知れない）', 'no_contact', ag.agency_phone ? c.setVal(r, 'phone_number', ag.agency_phone, `事業者の電話番号 ${ag.agency_phone} を入れる`, false) : (ag.agency_url ? c.setVal(r, 'info_url', ag.agency_url, `事業者の URL を info_url に入れる`, false) : null));
          }
          if (bt === '1' && min === '0' && !max) info(f, i, 'prior_notice_duration_min', 'duration_min=0 は「直前まで予約可」。意図どおりか', 'notice_zero');
        });
      },
    },
    {
      id: 'stop_times', label: '便の時刻・乗降時間帯', run(c) {
        const { R, err, warn, info, ids } = c;
        const f = 'stop_times.txt';
        const byTrip = new Map();
        R(f).forEach((r, i) => {
          const refs = ['stop_id', 'location_group_id', 'location_id'].filter(k => r[k]);
          if (refs.length === 0) err(f, i, 'stop_id', 'stop_id / location_group_id / location_id のどれか 1 つが必要', 'ref_missing');
          if (refs.length > 1) err(f, i, refs[1], `${refs.join(' と ')} を同時に指定している（どれか 1 つ）`, 'ref_multi');
          const sw = r.start_pickup_drop_off_window, ew = r.end_pickup_drop_off_window;
          const hasWin = !!(sw || ew);
          const isZone = !!(r.location_group_id || r.location_id);
          if (isZone && !(sw && ew)) err(f, i, 'start_pickup_drop_off_window', '区域（location_group_id / location_id）の行には start/end_pickup_drop_off_window が必須', 'window_required');
          if ((sw && !ew) || (!sw && ew)) err(f, i, sw ? 'end_pickup_drop_off_window' : 'start_pickup_drop_off_window', '乗降時間帯は開始と終了の両方が必要', 'window_pair');
          if (hasWin && (r.arrival_time || r.departure_time)) err(f, i, 'arrival_time', '乗降時間帯のある行に arrival_time / departure_time は書けない', 'window_vs_time', { label: 'arrival_time / departure_time を空にする', safe: true, apply: () => { r.arrival_time = ''; r.departure_time = ''; } });
          if (!hasWin && !isZone && !r.arrival_time && !r.departure_time) info(f, i, 'arrival_time', '時刻も乗降時間帯もない行（通過停留所なら可）', 'no_time');
          for (const k of ['arrival_time', 'departure_time', 'start_pickup_drop_off_window', 'end_pickup_drop_off_window']) if (r[k] && /^\d:/.test(r[k])) info(f, i, k, `${k} "${r[k]}" は 0 を補って 0${r[k]} と書くのが一般的`, 'time_pad', c.setVal(r, k, '0' + r[k], null, true));
          if (sw && ew && parseTime(sw) != null && parseTime(ew) != null && parseTime(sw) >= parseTime(ew)) err(f, i, 'end_pickup_drop_off_window', '乗降時間帯の終了が開始以前', 'window_order');
          const pt = r.pickup_type || '0', dt = r.drop_off_type || '0';
          const rules = R('booking_rules.txt');
          const onlyRule = rules.length === 1 ? rules[0].booking_rule_id : null;
          if (hasWin && pt === '0') err(f, i, 'pickup_type', '乗降時間帯のある行では pickup_type=0（通常の乗車）は使えない。2（事業者に連絡）か 1（乗車不可）に', 'window_pickup0', c.setVal(r, 'pickup_type', '2', 'pickup_type を 2（事業者に連絡して乗車）にする', true));
          if (hasWin && pt === '3') err(f, i, 'pickup_type', '乗降時間帯のある行では pickup_type=3 は使えない', 'window_pickup3', c.setVal(r, 'pickup_type', '2', 'pickup_type を 2 にする', true));
          if (hasWin && dt === '0') err(f, i, 'drop_off_type', '乗降時間帯のある行では drop_off_type=0（通常の降車）は使えない。2 か 1 に', 'window_dropoff0', c.setVal(r, 'drop_off_type', '2', 'drop_off_type を 2（事業者に連絡して降車）にする', true));
          if (hasWin && dt === '3') err(f, i, 'drop_off_type', '乗降時間帯のある行では drop_off_type=3 は使えない', 'window_dropoff3', c.setVal(r, 'drop_off_type', '2', 'drop_off_type を 2 にする', true));
          if (pt === '2' && !r.pickup_booking_rule_id && hasWin) warn(f, i, 'pickup_booking_rule_id', 'pickup_type=2（連絡して乗車）なのに pickup_booking_rule_id がない。予約方法が案内されない', 'no_booking_rule', onlyRule ? c.setVal(r, 'pickup_booking_rule_id', onlyRule, `予約ルール "${onlyRule}" を入れる`, true) : null);
          if (dt === '2' && !r.drop_off_booking_rule_id && hasWin) warn(f, i, 'drop_off_booking_rule_id', 'drop_off_type=2（連絡して降車）なのに drop_off_booking_rule_id がない', 'no_booking_rule', onlyRule ? c.setVal(r, 'drop_off_booking_rule_id', onlyRule, `予約ルール "${onlyRule}" を入れる`, true) : null);
          if (pt === '1' && r.pickup_booking_rule_id) warn(f, i, 'pickup_booking_rule_id', '乗車不可（pickup_type=1）の行に pickup_booking_rule_id がある', 'rule_unused', c.setVal(r, 'pickup_booking_rule_id', '', 'pickup_booking_rule_id を空にする', true));
          if (dt === '1' && r.drop_off_booking_rule_id) warn(f, i, 'drop_off_booking_rule_id', '降車不可（drop_off_type=1）の行に drop_off_booking_rule_id がある', 'rule_unused', c.setVal(r, 'drop_off_booking_rule_id', '', 'drop_off_booking_rule_id を空にする', true));
          if (!byTrip.has(r.trip_id)) byTrip.set(r.trip_id, []);
          byTrip.get(r.trip_id).push({ r, i });
        });
        for (const [tid, list] of byTrip) {
          list.sort((a, b) => (+a.r.stop_sequence) - (+b.r.stop_sequence));
          const seqs = new Set();
          for (const { r, i } of list) { if (seqs.has(r.stop_sequence)) err(f, i, 'stop_sequence', `便 "${tid}" で stop_sequence ${r.stop_sequence} が重複`, 'dup_seq', { label: `便 "${tid}" の stop_sequence を 1, 2, 3… と振り直す`, safe: false, apply: () => { list.forEach((x, k) => { x.r.stop_sequence = String(k + 1); }); } }); seqs.add(r.stop_sequence); }
          if (list.length < 2) { err(f, list[0].i, 'trip_id', `便 "${tid}" の行が 1 つしかない（乗る行と降りる行で最低 2 行）`, 'trip_one_row'); continue; }
          const first = list[0].r, last = list[list.length - 1].r;
          if ((first.pickup_type || '0') === '1') warn(f, list[0].i, 'pickup_type', `便 "${tid}" の最初の行が乗車不可`, 'first_no_pickup');
          if ((last.drop_off_type || '0') === '1') warn(f, list[list.length - 1].i, 'drop_off_type', `便 "${tid}" の最後の行が降車不可`, 'last_no_dropoff');
          if (list.every(x => (x.r.pickup_type || '0') === '1')) err(f, list[0].i, 'pickup_type', `便 "${tid}" はどの行でも乗車できない`, 'no_pickup');
          if (list.every(x => (x.r.drop_off_type || '0') === '1')) err(f, list[0].i, 'drop_off_type', `便 "${tid}" はどの行でも降車できない`, 'no_dropoff');
          let prev = null;
          for (const { r, i } of list) {
            const t = parseTime(r.arrival_time || r.departure_time || '');
            if (t != null) { if (prev != null && t < prev) err(f, i, 'arrival_time', `便 "${tid}" で時刻が前の行より戻っている`, 'time_backwards'); prev = parseTime(r.departure_time || r.arrival_time); }
          }
        }
        const tripIds = ids['trips.txt'] || new Map();
        for (const [tid, i] of tripIds) if (!byTrip.has(tid)) err('trips.txt', i, 'trip_id', `便 "${tid}" に stop_times.txt の行がない`, 'trip_empty', c.delRow('trips.txt', R('trips.txt')[i], `便 "${tid}" を消す`));
      },
    },
    {
      // 根拠: 国交省「公共交通運行情報標準データ仕様（GTFS-JP）v4 v3との差分」3.1 / 3.2（2026-03）。国際仕様より厳しいものだけをここで見る
      id: 'gtfs_jp', label: 'GTFS-JP v4（日本標準仕様書）の必須・推奨', run(c) {
        const { R, has, err, warn, info } = c;
        const jp = 'GTFS-JP v4';
        if (!has('fare_attributes.txt')) warn('fare_attributes.txt', null, '', `fare_attributes.txt がない（${jp} では必須。均一運賃でも 1 行書く）`, 'jp_file', { label: '均一運賃の行（price は要入力）を作る', safe: false, apply: feed => { const t = window.GTFS.ensureTable(feed, 'fare_attributes.txt'); if (!t.rows.length) t.rows.push(window.GTFS.newRow('fare_attributes.txt', { fare_id: 'fare1', price: '', currency_type: 'JPY', payment_method: '0', transfers: '0' })); } });
        if (!has('translations.txt')) warn('translations.txt', null, '', `translations.txt がない（${jp} では必須。停留所名などの読み仮名・英語表記）`, 'jp_file');
        const agencies = R('agency.txt');
        agencies.forEach((r, i) => {
          if (!r.agency_id) err('agency.txt', i, 'agency_id', `agency_id が空（${jp} では事業者が 1 つでも必須）`, 'jp_required', c.setVal(r, 'agency_id', 'agency' + (i + 1), null, true));
          if (!r.agency_lang) err('agency.txt', i, 'agency_lang', `agency_lang が空（${jp} では必須）`, 'jp_required', c.setVal(r, 'agency_lang', 'ja', null, true));
        });
        R('feed_info.txt').forEach((r, i) => {
          if (!r.feed_contact_email && !r.feed_contact_url) info('feed_info.txt', i, 'feed_contact_email', `連絡先（feed_contact_email か feed_contact_url）が空（${jp} では推奨）`, 'jp_recommended');
        });
        // location_type は JP v4 で必須。全行空（列がない）なら 1 件にまとめ、一部だけ空なら行ごとに
        const stops = R('stops.txt'), ltEmpty = stops.filter(r => r.location_type === '' || r.location_type == null);
        if (stops.length && ltEmpty.length === stops.length) err('stops.txt', null, 'location_type', `location_type が全行で空（${jp} では必須。停留所は 0）`, 'jp_required', { label: `全 ${stops.length} 行の location_type を 0（停留所）にする`, safe: true, apply: feed => { const t = window.GTFS.ensureTable(feed, 'stops.txt'); if (!t.header.includes('location_type')) t.header.push('location_type'); for (const r of t.rows) if (!r.location_type) r.location_type = '0'; } });
        else ltEmpty.forEach(r => err('stops.txt', stops.indexOf(r), 'location_type', `location_type が空（${jp} では必須。停留所は 0）`, 'jp_required', c.setVal(r, 'location_type', '0', 'location_type を 0（停留所）にする', true)));
        const only = agencies.length === 1 ? agencies[0].agency_id : '';
        R('routes.txt').forEach((r, i) => {
          if (!r.agency_id) err('routes.txt', i, 'agency_id', `agency_id が空（${jp} では必須）`, 'jp_required', only ? c.setVal(r, 'agency_id', only, `agency_id を ${only} にする`, true) : null);
        });
        if (agencies.length > 1) R('fare_attributes.txt').forEach((r, i) => { if (!r.agency_id) err('fare_attributes.txt', i, 'agency_id', `事業者が複数あるので agency_id が必要（${jp}）`, 'jp_required'); });
        // 推奨の欄は行ごとに出すと多すぎるので、件数でまとめる
        const rec = (file, col, pred, label) => { const rows = R(file); const n = rows.filter(pred).length; if (n) info(file, null, col, `${col}（${label}）が空の行が ${n} 件（${jp} では推奨）`, 'jp_recommended'); };
        rec('routes.txt', 'route_color', r => !r.route_color, '路線の色');
        rec('trips.txt', 'trip_headsign', r => !r.trip_headsign, '行き先表示');
        rec('trips.txt', 'direction_id', r => !r.direction_id, '方向');
        rec('stop_times.txt', 'timepoint', r => (r.arrival_time || r.departure_time) && !r.timepoint, '時刻の正確さ。時刻のある行のみ');
        rec('agency.txt', 'agency_phone', r => !r.agency_phone, '電話番号');
        // 乗降場グループ／エリアの中だけの利用: 同じ ID の行を 2 つ [JP]
        const byTrip = new Map();
        for (const r of R('stop_times.txt')) { if (!byTrip.has(r.trip_id)) byTrip.set(r.trip_id, []); byTrip.get(r.trip_id).push(r); }
        for (const [tid, rows] of byTrip) {
          const refs = rows.map(r => r.location_group_id || r.location_id).filter(Boolean);
          if (refs.length === 1 && rows.length === 1) info('stop_times.txt', R('stop_times.txt').indexOf(rows[0]), 'location_group_id', `便 "${tid}" は区域の行が 1 つだけ。区域の中だけの利用もできるなら、同じ ID の行を 2 つ（乗る行・降りる行）にする（${jp}）`, 'jp_zone_pair');
        }
      },
    },
    {
      id: 'unused', label: '使われていないもの', run(c) {
        const { R, warn, ids, locIds } = c;
        const st = R('stop_times.txt');
        const usedGroups = new Set(st.map(r => r.location_group_id).filter(Boolean));
        for (const [g, i] of (ids['location_groups.txt'] || [])) if (!usedGroups.has(g)) warn('location_groups.txt', i, 'location_group_id', `グループ "${g}" はどの便にも使われていない`, 'unused', { label: `グループ "${g}" と、その停留所の対応を消す`, safe: false, apply: feed => { feed.files['location_groups.txt'].rows = feed.files['location_groups.txt'].rows.filter(x => x.location_group_id !== g); const m = feed.files['location_group_stops.txt']; if (m) m.rows = m.rows.filter(x => x.location_group_id !== g); } });
        const usedLocs = new Set(st.map(r => r.location_id).filter(Boolean));
        for (const [l, i] of locIds) if (!usedLocs.has(l)) warn('locations.geojson', i, 'id', `区域 "${l}" はどの便にも使われていない`, 'unused', { label: `区域 "${l}" を消す`, safe: false, apply: feed => { feed.locations.features = feed.locations.features.filter(x => String(x.id) !== l); } });
        const usedRules = new Set(st.flatMap(r => [r.pickup_booking_rule_id, r.drop_off_booking_rule_id]).filter(Boolean));
        for (const [b, i] of (ids['booking_rules.txt'] || [])) if (!usedRules.has(b)) warn('booking_rules.txt', i, 'booking_rule_id', `予約ルール "${b}" はどの行にも使われていない`, 'unused', c.delRow('booking_rules.txt', R('booking_rules.txt')[i], `予約ルール "${b}" を消す`));
        const usedRoutes = new Set(R('trips.txt').map(r => r.route_id));
        for (const [r, i] of (ids['routes.txt'] || [])) if (!usedRoutes.has(r)) warn('routes.txt', i, 'route_id', `路線 "${r}" に便がない`, 'unused', c.delRow('routes.txt', R('routes.txt')[i], `路線 "${r}" を消す`));
        const usedServices = new Set(R('trips.txt').map(r => r.service_id));
        R('calendar.txt').forEach((r, i) => { if (!usedServices.has(r.service_id)) warn('calendar.txt', i, 'service_id', `service_id "${r.service_id}" はどの便にも使われていない`, 'unused', c.delRow('calendar.txt', r, `service_id "${r.service_id}" を消す`)); });
        const usedStops = new Set([...st.map(r => r.stop_id), ...R('location_group_stops.txt').map(r => r.stop_id)].filter(Boolean));
        const parents = new Set(R('stops.txt').map(r => r.parent_station).filter(Boolean));
        R('stops.txt').forEach((r, i) => { if ((r.location_type || '0') === '0' && !usedStops.has(r.stop_id) && !parents.has(r.stop_id)) warn('stops.txt', i, 'stop_id', `停留所 "${r.stop_id}" ${r.stop_name || ''} はどの便・グループにも使われていない`, 'unused', c.delRow('stops.txt', r, `停留所 "${r.stop_id}" を消す`)); });
      },
    },
  ];

  function feed_bad_geojson(c) {
    if (c.feed.locations && c.feed.locations._parseError) { c.err('locations.geojson', null, '', 'locations.geojson が JSON として読めない: ' + c.feed.locations._parseError, 'bad_geojson'); }
    return false;
  }

  function validate(feed, opts) {
    const disabled = new Set((opts && opts.disabled) || []);
    const c = makeCtx(feed);
    for (const rule of RULES) {
      if (disabled.has(rule.id)) continue;
      c.setRule(rule.id);
      try { rule.run(c); } catch (e) { c.err('', null, '', `検証規則 ${rule.id} が内部エラー: ${e.message}`, 'rule_crash'); }
    }
    const order = { error: 0, warn: 1, info: 2 };
    c.out.sort((a, b) => order[a.level] - order[b.level] || a.file.localeCompare(b.file) || (a.row || 0) - (b.row || 0));
    return c.out;
  }

  function today() { const d = new Date(); return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0'); }
  function ringArea(ring) { let a = 0; for (let i = 0; i < ring.length - 1; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]; return a / 2; }
  function selfIntersects(ring) {
    const n = ring.length - 1;
    if (n < 4) return false;
    for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segCross(ring[i], ring[i + 1], ring[j], ring[j + 1])) return true;
    }
    return false;
  }
  function segCross(a, b, c, d) {
    const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
    return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b) && o(a, b, c) !== 0 && o(a, b, d) !== 0;
  }

  window.FlexValidate = { validate, RULES };
})();
