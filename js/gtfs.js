// GTFS / GTFS-Flex の読み書きとデータモデル。
// feed = { files: { 'stops.txt': { header: [...], rows: [ {col: value, ...}, ... ] }, ... },
//          locations: GeoJSON FeatureCollection | null,
//          others: { name: Uint8Array } (知らないファイルはそのまま持ち回る) }
(function () {
  'use strict';

  // ファイルと列の定義は spec.js にある。
  const SPEC = window.FLEX_SPEC.SPEC;
  const ORDER = window.FLEX_SPEC.ORDER;

  // ---------- CSV ----------
  function parseCSV(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const rows = [];
    let row = [], field = '', i = 0, inQ = false;
    const n = text.length;
    while (i < n) {
      const c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQ = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"') { inQ = true; i++; continue; }
      if (c === ',') { row.push(field); field = ''; i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
      field += c; i++;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function csvField(v) {
    v = v == null ? '' : String(v);
    return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }

  function tableFromCSV(text) {
    const raw = parseCSV(text);
    if (!raw.length) return { header: [], rows: [] };
    const header = raw[0].map(h => h.trim());
    const rows = [];
    for (let r = 1; r < raw.length; r++) {
      const line = raw[r];
      if (line.length === 1 && line[0].trim() === '') continue; // 空行
      const o = {};
      header.forEach((h, k) => { o[h] = (line[k] == null ? '' : line[k]).trim(); });
      rows.push(o);
    }
    return { header, rows };
  }

  function tableToCSV(name, table) {
    // 列は仕様の順。仕様にない列は末尾に。値が全部空の任意列は省く。
    const spec = SPEC[name];
    let cols = table.header.slice();
    if (spec) {
      const known = spec.cols.filter(c => cols.includes(c));
      const extra = cols.filter(c => !spec.cols.includes(c));
      cols = known.concat(extra);
      cols = cols.filter(c => spec.required.includes(c) || table.rows.some(r => (r[c] || '') !== ''));
    }
    const lines = [cols.map(csvField).join(',')];
    for (const r of table.rows) lines.push(cols.map(c => csvField(r[c])).join(','));
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  // ---------- モデル操作 ----------
  function emptyFeed() {
    return { files: {}, locations: null, others: {} };
  }
  function ensureTable(feed, name) {
    if (!feed.files[name]) {
      const spec = SPEC[name];
      feed.files[name] = { header: spec ? spec.cols.slice() : [], rows: [] };
    } else if (SPEC[name]) {
      // 仕様の列を header に足しておく（編集画面で使う）
      for (const c of SPEC[name].cols) if (!feed.files[name].header.includes(c)) feed.files[name].header.push(c);
    }
    return feed.files[name];
  }
  function rows(feed, name) { return feed.files[name] ? feed.files[name].rows : []; }
  function newRow(name, init) {
    const o = {};
    (SPEC[name] ? SPEC[name].cols : []).forEach(c => { o[c] = ''; });
    return Object.assign(o, init || {});
  }

  // ---------- zip ----------
  async function loadZip(data) {
    const zip = await JSZip.loadAsync(data);
    const feed = emptyFeed();
    const dec = new TextDecoder('utf-8');
    const sjis = (() => { try { return new TextDecoder('shift_jis'); } catch (e) { return null; } })();
    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue;
      const base = entry.name.split('/').pop();
      if (!base) continue;
      if (base.endsWith('.txt')) {
        const buf = await entry.async('uint8array');
        let text = dec.decode(buf);
        if (text.includes('�') && sjis) text = sjis.decode(buf); // 文字化けなら Shift_JIS を試す
        feed.files[base] = tableFromCSV(text);
      } else if (base === 'locations.geojson') {
        const text = await entry.async('string');
        try { feed.locations = JSON.parse(text); } catch (e) { feed.locations = { type: 'FeatureCollection', features: [], _parseError: String(e) }; }
      } else {
        feed.others[base] = await entry.async('uint8array');
      }
    }
    for (const name of ORDER) if (feed.files[name]) ensureTable(feed, name);
    return feed;
  }

  async function saveZip(feed) {
    const zip = new JSZip();
    const names = ORDER.filter(n => feed.files[n]).concat(Object.keys(feed.files).filter(n => !ORDER.includes(n)));
    for (const name of names) {
      const t = feed.files[name];
      if (!t.rows.length && !(SPEC[name] && ['agency.txt', 'stops.txt', 'routes.txt', 'trips.txt', 'stop_times.txt'].includes(name))) continue;
      zip.file(name, tableToCSV(name, t));
    }
    if (feed.locations && feed.locations.features && feed.locations.features.length) {
      zip.file('locations.geojson', JSON.stringify(feed.locations, null, 1));
    }
    for (const [name, buf] of Object.entries(feed.others)) zip.file(name, buf);
    return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  }

  // ---------- 時刻 ----------
  function parseTime(s) {
    const m = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec((s || '').trim());
    if (!m) return null;
    return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
  }
  function fmtTime(sec) {
    const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
  }

  // ---------- 新規作成のひな型 ----------
  function templateFeed(opt) {
    const f = emptyFeed();
    const aid = opt.agencyId || 'agency';
    ensureTable(f, 'agency.txt').rows.push(newRow('agency.txt', { agency_id: aid, agency_name: opt.agencyName || '', agency_url: opt.agencyUrl || '', agency_timezone: 'Asia/Tokyo', agency_lang: 'ja', agency_phone: opt.phone || '' }));
    ensureTable(f, 'feed_info.txt').rows.push(newRow('feed_info.txt', { feed_publisher_name: opt.agencyName || '', feed_publisher_url: opt.agencyUrl || '', feed_lang: 'ja', feed_start_date: opt.startDate || '', feed_end_date: opt.endDate || '', feed_version: opt.startDate || '' }));
    ensureTable(f, 'routes.txt').rows.push(newRow('routes.txt', { route_id: 'route1', agency_id: aid, route_short_name: '', route_long_name: opt.routeName || 'デマンド交通', route_type: '715' }));
    const days = opt.days || [1, 1, 1, 1, 1, 0, 0];
    ensureTable(f, 'calendar.txt').rows.push(newRow('calendar.txt', { service_id: 'service1', monday: days[0], tuesday: days[1], wednesday: days[2], thursday: days[3], friday: days[4], saturday: days[5], sunday: days[6], start_date: opt.startDate || '', end_date: opt.endDate || '' }));
    ensureTable(f, 'calendar_dates.txt');
    const bt = String(opt.bookingType == null ? '1' : opt.bookingType);
    const rule = { booking_rule_id: 'rule1', booking_type: bt, phone_number: opt.phone || '', booking_url: opt.bookingUrl || '', info_url: opt.infoUrl || '', message: opt.bookingMessage || '' };
    if (bt === '1') { rule.prior_notice_duration_min = String(opt.noticeMin == null || opt.noticeMin === '' ? 30 : opt.noticeMin); if (opt.noticeMax) rule.prior_notice_duration_max = String(opt.noticeMax); }
    if (bt === '2') { rule.prior_notice_last_day = String(opt.lastDay == null || opt.lastDay === '' ? 1 : opt.lastDay); rule.prior_notice_last_time = opt.lastTime || '17:00:00'; }
    ensureTable(f, 'booking_rules.txt').rows.push(newRow('booking_rules.txt', rule));
    ensureTable(f, 'stops.txt');
    ensureTable(f, 'trips.txt');
    ensureTable(f, 'stop_times.txt');
    ensureTable(f, 'location_groups.txt');
    ensureTable(f, 'location_group_stops.txt');
    if (opt.zoneKind === 'polygon' || opt.zoneKind === 'both') f.locations = { type: 'FeatureCollection', features: [] };
    if (opt.zoneKind !== 'polygon') {
      f.files['location_groups.txt'].rows.push(newRow('location_groups.txt', { location_group_id: 'zone1', location_group_name: opt.zoneName || '運行区域' }));
      addZoneTrip(f, { tripId: 'trip1', routeId: 'route1', serviceId: 'service1', ref: { location_group_id: 'zone1' }, start: opt.windowStart || '08:00:00', end: opt.windowEnd || '17:00:00', bookingRuleId: 'rule1' });
    }
    return f;
  }

  // 区域運行の便を足す（GTFS-JP 4.0 ガイドライン 第3部 2.7 の型に沿う）。
  // ref / refTo は { stop_id } / { location_group_id } / { location_id } のどれか。
  //   同じ区域の中だけ        : ref(乗車) → ref(降車) の 2 行、便は 1 つ
  //   区域 A から区域 B へ    : A(乗車) → B(降車)。roundTrip なら復路 B → A の便も作る（trip_id に _1 / _2）
  //   intraZone               : 乗る側の区域 A の中だけの利用もできる。往路 A(乗車) → A(乗降) → B(降車)、復路 B(乗車) → A(乗降) → A(降車) の 3 行
  function addZoneTrip(feed, o) {
    const from = o.ref, to = o.refTo || o.ref;
    const same = JSON.stringify(from) === JSON.stringify(to);
    const mk = (tripId, a, b, headsign, dir) => {
      ensureTable(feed, 'trips.txt').rows.push(newRow('trips.txt', { route_id: o.routeId, service_id: o.serviceId, trip_id: tripId, trip_headsign: headsign || '', direction_id: dir == null ? '' : String(dir) }));
      const st = ensureTable(feed, 'stop_times.txt');
      const base = { trip_id: tripId, start_pickup_drop_off_window: o.start, end_pickup_drop_off_window: o.end };
      const intra = o.intraZone && !same ? from : null; // 区域内利用ができるのは「乗る場所」に指定した区域
      const rows = [];
      rows.push(Object.assign({ pickup_type: '2', drop_off_type: '1', pickup_booking_rule_id: o.bookingRuleId || '' }, a));
      if (intra) rows.push(Object.assign({ pickup_type: '2', drop_off_type: '2', pickup_booking_rule_id: o.bookingRuleId || '', drop_off_booking_rule_id: o.bookingRuleId || '' }, intra));
      rows.push(Object.assign({ pickup_type: '1', drop_off_type: '2', drop_off_booking_rule_id: o.bookingRuleId || '' }, b));
      rows.forEach((x, k) => st.rows.push(newRow('stop_times.txt', Object.assign({}, base, { stop_sequence: String(k + 1) }, x))));
    };
    if (same || !o.roundTrip) mk(o.tripId, from, to, o.headsign, same ? null : 0);
    else { mk(o.tripId + '_1', from, to, o.headsign, 0); mk(o.tripId + '_2', to, from, o.headsignBack || '', 1); }
  }

  window.GTFS = { SPEC, ORDER, parseCSV, tableFromCSV, tableToCSV, emptyFeed, ensureTable, rows, newRow, loadZip, saveZip, parseTime, fmtTime, templateFeed, addZoneTrip };
})();
