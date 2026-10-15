// 画面のつなぎ込み。データ（feed）はここで 1 つだけ持ち、編集・検証・地図・保存をつなぐ。
(function () {
  'use strict';
  const G = window.GTFS, SPEC = window.FLEX_SPEC, V = window.FlexValidate, STORE = window.FlexStore;
  const $ = s => document.querySelector(s);
  const el = (tag, attrs, ...kids) => { const e = document.createElement(tag); if (attrs) for (const [k, v] of Object.entries(attrs)) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (k === 'html') e.innerHTML = v; else e.setAttribute(k, v); } for (const k of kids) if (k != null) e.append(k); return e; };

  const S = {
    feed: null, original: null, name: '', issues: [], dirty: false, diff: null, diffFile: '',
    file: 'stop_times.txt', mode: 'table', page: 0, pageSize: 200, filter: '', hlRow: null, formIndex: 0,
    group: '', loc: -1, stop: null, disabledRules: new Set(),
  };
  const PAGE_SIZE = 200;

  // ---------- 地図 ----------
  const M = window.FlexMap.create($('#map'), {
    onStopClick(id) {
      if (M.getMode() === 'pickStops' && S.group) { toggleMember(S.group, id); return; }
      selectStop(id, { popup: true });
    },
    onMapClick(ll) {
      if (M.getMode() !== 'addStop') return;
      const t = G.ensureTable(S.feed, 'stops.txt');
      const id = nextId(t.rows.map(r => r.stop_id), 'S');
      t.rows.push(G.newRow('stops.txt', { stop_id: id, stop_name: '新しい停留所', stop_lat: ll.lat.toFixed(6), stop_lon: ll.lng.toFixed(6), location_type: '0' }));
      S.stop = id; changed(); renderStopForm(); refreshMap(false);
      const nameInput = $('#stopForm input[data-col=stop_name]'); if (nameInput) { nameInput.focus(); nameInput.select(); }
    },
    onStopMoved(id, ll, done) {
      const r = G.rows(S.feed, 'stops.txt').find(x => x.stop_id === id); if (!r) return;
      r.stop_lat = ll[1].toFixed(6); r.stop_lon = ll[0].toFixed(6);
      if (done) { changed(); renderStopForm(); }
      refreshMap(false);
    },
    onPolygonDone(ring) {
      if (!S.feed.locations) S.feed.locations = { type: 'FeatureCollection', features: [] };
      const ids = S.feed.locations.features.map(f => String(f.id));
      const id = nextId(ids, 'area');
      S.feed.locations.features.push({ type: 'Feature', id, properties: { stop_name: '新しい区域' }, geometry: { type: 'Polygon', coordinates: [ccw(ring)] } });
      S.loc = S.feed.locations.features.length - 1;
      changed(); renderZones(); refreshMap();
      $('#btnLocDraw').classList.remove('on');
    },
    onVertexMoved(ring, index, ll, done) {
      const f = S.feed.locations && S.feed.locations.features[S.loc]; if (!f) return;
      const r = f.geometry.coordinates[ring]; r[index] = ll; if (index === 0) r[r.length - 1] = ll.slice();
      if (done) changed();
      M.setLocations(S.feed.locations, S.loc);
    },
    onVertexInsert(ring, index, ll) {
      const f = S.feed.locations && S.feed.locations.features[S.loc]; if (!f) return;
      f.geometry.coordinates[ring].splice(index, 0, ll);
      M.setLocations(S.feed.locations, S.loc);
    },
    onVertexDelete(ring, index) {
      const f = S.feed.locations && S.feed.locations.features[S.loc]; if (!f) return;
      const r = f.geometry.coordinates[ring]; if (r.length <= 4) return;
      r.splice(index, 1); if (index === 0) r[r.length - 1] = r[0].slice();
      changed(); M.setLocations(S.feed.locations, S.loc);
    },
    onLocationClick(i) { S.loc = i; renderZones(); refreshMap(); },
    onLocateFallback() { const f = stopFeatures(); if (f.length) M.fitTo(f); },
  });
  // 地図の入れ物の大きさが変わったら描き直す（初期化時に 0 だったり、ブラウザの表示領域が後から決まることがある）
  window.addEventListener('resize', () => M.map.resize());
  document.addEventListener('visibilitychange', () => M.map.resize());
  M.map.once('load', () => { M.map.resize(); setTimeout(() => M.map.resize(), 300); });
  if (window.ResizeObserver) new ResizeObserver(() => M.map.resize()).observe($('#map'));
  const modeBadge = el('div', { class: 'map-mode' });
  $('#map').appendChild(modeBadge);
  $('#map').addEventListener('modechange', e => {
    const m = e.detail;
    const text = { draw: '区域を描いています: クリックで頂点、ダブルクリックか Enter で確定、Esc で中止', addStop: '地図をクリックした所に停留所を追加します', moveStop: '停留所をドラッグして動かせます', pickStops: '停留所をクリックするとグループに出し入れします' }[m];
    modeBadge.style.display = text ? 'block' : 'none'; modeBadge.textContent = text || '';
    for (const [id, mode] of [['#btnLocDraw', 'draw'], ['#btnStopAdd', 'addStop'], ['#btnStopMove', 'moveStop'], ['#btnPickStops', 'pickStops']]) $(id).classList.toggle('on', m === mode);
  });
  function toggleMode(m) { M.setMode(M.getMode() === m ? 'none' : m); }

  function stopFeatures() { return M.setStops(G.rows(S.feed, 'stops.txt'), memberSet(S.group), S.stop, S.stopIssues); }
  // 停留所ごとの検証結果（stops.txt の行、location_group_stops.txt の行、stop_times.txt の stop_id のある行）
  function collectStopIssues() {
    const m = new Map(), list = new Map();
    const rowsOf = n => (S.feed.files[n] ? S.feed.files[n].rows : []);
    for (const it of S.issues) {
      if (it.level === 'info' || it.row == null) continue;
      let sid = null;
      const r = rowsOf(it.file)[it.row - 2];
      if (!r) continue;
      if (it.file === 'stops.txt') sid = r.stop_id;
      else if (it.file === 'location_group_stops.txt' || it.file === 'stop_times.txt') sid = r.stop_id;
      else if (it.file === 'transfers.txt' || it.file === 'pathways.txt') sid = r.from_stop_id;
      if (!sid) continue;
      if (it.level === 'error' || !m.has(sid)) m.set(sid, it.level);
      if (!list.has(sid)) list.set(sid, []);
      list.get(sid).push(it);
    }
    S.stopIssues = m; S.stopIssueList = list;
  }
  function refreshMap(fit) {
    if (!S.feed) return;
    M.map.resize();
    const feats = stopFeatures();
    M.setLocations(S.feed.locations, S.loc);
    if (fit) M.fitTo(feats.concat((S.feed.locations && S.feed.locations.features) || []));
  }

  // ---------- 変更・保存 ----------
  const saver = STORE.autosaver(() => S.feed ? { feed: S.feed, original: S.original, name: S.name, savedAt: Date.now() } : null, (t, e) => {
    $('#saveStatus').textContent = e ? '自動保存に失敗: ' + e.message : '自動保存: ' + t.toLocaleTimeString('ja-JP');
  }, 3000);
  let validateTimer = null;
  function changed() {
    S.dirty = true;
    $('#saveStatus').textContent = '自動保存: 変更あり…';
    saver.schedule();
    clearTimeout(validateTimer);
    validateTimer = setTimeout(() => { runValidate(); renderChanges(); }, 1000);
  }
  setInterval(() => { if (S.dirty) saver.flush(); }, 60000);
  window.addEventListener('beforeunload', () => { if (S.dirty) saver.flush(); });

  // ---------- 読み込み ----------
  async function loadFeed(feed, name, original) {
    // 古い版（v2 ドラフト）なら正式版へ直してから扱う。何を直したかは概要に出す
    if (!feed.flexVersion) {
      const conv = window.FlexVersions.toCanonical(feed);
      feed.flexVersion = conv.version; feed.conversionNotes = conv.notes;
    }
    S.feed = feed; S.name = name; S.dirty = false; S.hlRow = null; S.page = 0; S.filter = '';
    S.original = original || structuredClone(feed);
    S.diffFile = '';
    S.group = (G.rows(feed, 'location_groups.txt')[0] || {}).location_group_id || '';
    S.loc = feed.locations && feed.locations.features.length ? 0 : -1;
    S.stop = null;
    fillFileSelect();
    runValidate();
    renderEditor(); renderZones(); renderTrips(); renderChanges();
    // map.loaded() はタイル待ちでも false になるので、層ができているかで判断する
    if (M.map.getSource('stops')) refreshMap(true); else M.map.once('load', () => refreshMap(true));
    saver.schedule();
  }
  $('#fileInput').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    try { await loadFeed(await G.loadZip(await f.arrayBuffer()), f.name); } catch (err) { alert('読み込めませんでした: ' + err.message); }
    e.target.value = '';
  });
  const odptSel = $('#odptSelect');
  for (const d of window.ODPT_FLEX_DATASETS) odptSel.append(el('option', { value: d.url }, d.title));
  $('#odptLoad').addEventListener('click', async () => {
    const url = odptSel.value; if (!url) return;
    const d = window.ODPT_FLEX_DATASETS.find(x => x.url === url);
    $('#odptLoad').disabled = true; $('#odptLoad').textContent = '取得中…';
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const feed = await G.loadZip(await res.arrayBuffer());
      feed.others = feed.others || {};
      await loadFeed(feed, d.title);
      $('#feedSummary').textContent += `\n出典: 公共交通オープンデータセンター ${d.page}（CC BY 4.0）`;
    } catch (err) { alert('ODPT から取得できませんでした: ' + err.message); }
    $('#odptLoad').disabled = false; $('#odptLoad').textContent = '読み込む';
  });
  $('#btnNew').addEventListener('click', () => $('#newDialog').showModal());
  $('#newForm').querySelector('[name=bookingType]').addEventListener('change', e => { const v = e.target.value; $('#newForm .bt1').style.display = v === '1' ? '' : 'none'; $('#newForm .bt2').style.display = v === '2' ? '' : 'none'; });
  $('#newForm .bt2').style.display = 'none';
  $('#newForm').addEventListener('submit', e => {
    if (e.submitter && e.submitter.value !== 'ok') return;
    const fd = new FormData(e.target);
    const o = Object.fromEntries(fd.entries());
    o.days = [0, 1, 2, 3, 4, 5, 6].map(i => fd.get('d' + i) ? 1 : 0);
    o.agencyId = 'agency1'; o.zoneName = '運行区域';
    if (!o.bookingMessage) {
      const how = [o.phone ? '電話' : '', o.bookingUrl ? 'Web' : ''].filter(Boolean).join('か') || '電話';
      o.bookingMessage = o.bookingType === '0' ? '予約なしで乗れます' : o.bookingType === '2' ? `${o.lastDay || 1} 日前の ${(o.lastTime || '17:00:00').slice(0, 5)} までに${how}で予約してください` : `ご利用の ${o.noticeMin || 30} 分前までに${how}で予約してください`;
    }
    loadFeed(G.templateFeed(o), '新規');
    setTab('zones');
  });

  // ---------- 書き出し ----------
  $('#btnExport').addEventListener('click', async () => {
    if (!S.feed) return;
    const ver = $('#exportVersion').value;
    if (ver === 'noflex' && !confirm('デマンド交通の便・区域・予約ルールを外した、通常の GTFS だけを書き出します。\nGoogle 乗換案内は Flex を含むデータを受け付けないので（2025 年 12 月時点、GTFS-JP v4 仕様書）、Google 向けはこちらを使います。\nODPT への提供は正式版（Flex 込み）です。続けますか？')) return;
    if (ver !== 'canonical' && ver !== 'noflex' && !confirm(`${window.FlexVersions.VERSIONS[ver].label} の形で書き出します。\n正式版の経路検索（ODPT への提供も）には正式版を使ってください。続けますか？`)) return;
    const blob = await G.saveZip(window.FlexVersions.fromCanonical(S.feed, ver));
    const a = el('a', { href: URL.createObjectURL(blob), download: (S.name || 'gtfs-flex').replace(/\.zip$/i, '') + (ver === 'canonical' ? '' : '-' + ver) + '.zip' });
    document.body.append(a); a.click(); a.remove();
  });

  // ---------- 検証 ----------
  function runValidate() {
    if (!S.feed) return;
    S.issues = V.validate(S.feed, { disabled: [...S.disabledRules] });
    const n = l => S.issues.filter(i => i.level === l).length;
    $('#cntErr').textContent = 'エラー ' + n('error'); $('#cntWarn').textContent = '警告 ' + n('warn'); $('#cntInfo').textContent = '情報 ' + n('info');
    const F = S.feed.files;
    const cnt = name => (F[name] ? F[name].rows.length : 0);
    const flexKind = S.feed.locations && S.feed.locations.features.length ? '区域ポリゴン' : (cnt('location_groups.txt') ? '停留所グループ' : '（区域なし）');
    const ag = (F['agency.txt'] && F['agency.txt'].rows[0]) || {};
    const VER = window.FlexVersions.VERSIONS;
    const jp = window.FlexVersions.detectJp(S.feed);
    const verLine = (S.feed.flexVersion && S.feed.flexVersion !== 'canonical' ? `\n読み込んだ形式: ${VER[S.feed.flexVersion].short} → 正式版に直して扱っています${(S.feed.conversionNotes || []).length ? '\n　' + S.feed.conversionNotes.join('\n　') : ''}` : '') + `\n仕様: ${jp.label}${jp.jpFiles.length ? '　独自拡張ファイル: ' + jp.jpFiles.join(', ') : ''}`;
    $('#feedSummary').textContent = `${S.name}\n事業者: ${ag.agency_name || '-'}　路線 ${cnt('routes.txt')}　便 ${cnt('trips.txt')}　停留所 ${cnt('stops.txt')}　stop_times ${cnt('stop_times.txt')} 行\n区域の表し方: ${flexKind}　グループ ${cnt('location_groups.txt')}　ポリゴン ${S.feed.locations ? S.feed.locations.features.length : 0}　予約ルール ${cnt('booking_rules.txt')}${verLine}\n` + (n('error') === 0 ? '✔ エラーはありません' : `✖ エラーが ${n('error')} 件あります`);
    const fs = $('#filterFile'); const cur = fs.value; fs.innerHTML = '<option value="">すべてのファイル</option>';
    for (const f of [...new Set(S.issues.map(i => i.file))].sort()) fs.append(el('option', { value: f }, f));
    fs.value = cur;
    renderIssues();
    renderSteps();
    collectStopIssues();
    if (M.map.getSource('stops')) stopFeatures();
    if (S.mode === 'table') markBadCells();
  }
  // 運行事業者がゼロから作るときの手順。済んだものに ✔、未完のものは該当タブへ飛べる。
  function renderSteps() {
    const F = S.feed.files, R = n => (F[n] ? F[n].rows : []);
    const members = new Set(R('location_group_stops.txt').map(r => r.location_group_id));
    const polys = (S.feed.locations && S.feed.locations.features.length) || 0;
    const nErr = S.issues.filter(i => i.level === 'error').length;
    const goFile = (f, mode) => () => { S.file = f; S.mode = mode || 'form'; S.formIndex = 0; $('#fileSelect').value = f; document.querySelectorAll('.modes button').forEach(x => x.classList.toggle('active', x.dataset.mode === S.mode)); setTab('files'); renderEditor(); };
    const steps = [
      { label: '事業者の名前・URL・電話番号を入れる', done: R('agency.txt').some(a => a.agency_name && a.agency_url && a.agency_phone), go: goFile('agency.txt') },
      { label: '運行する曜日と期間を入れる（calendar.txt）', done: R('calendar.txt').length > 0 && R('calendar.txt').every(c => c.start_date && c.end_date), go: goFile('calendar.txt') },
      { label: '路線（サービス名）を入れる', done: R('routes.txt').some(r => r.route_long_name || r.route_short_name), go: goFile('routes.txt') },
      { label: '停留所（乗降場所）を地図に置く', done: R('stops.txt').some(s => s.stop_lat && s.stop_lon), go: () => setTab('zones'), note: 'ポリゴン区域だけで運行するなら不要' },
      { label: '区域を作る（停留所グループに停留所を入れる、またはポリゴンを描く）', done: [...members].some(g => R('location_groups.txt').some(x => x.location_group_id === g)) || polys > 0, go: () => setTab('zones') },
      { label: '予約ルール（予約の種類・電話番号や URL）を入れる', done: R('booking_rules.txt').some(b => b.booking_type === '0' || b.phone_number || b.booking_url || b.info_url), go: goFile('booking_rules.txt') },
      { label: '便（乗り降りできる時間帯）を足す', done: R('trips.txt').length > 0 && R('stop_times.txt').some(t => t.start_pickup_drop_off_window), go: () => setTab('trips') },
      { label: 'データ情報（feed_info.txt: 公開者・有効期間・版）を入れる', done: R('feed_info.txt').some(f => f.feed_publisher_name && f.feed_start_date && f.feed_end_date && f.feed_version), go: goFile('feed_info.txt') },
      { label: '検証のエラーを 0 にする', done: nErr === 0 && S.issues.length >= 0, go: () => { $('#showErr').checked = true; renderIssues(); } },
      { label: 'zip に書き出して ODPT（公共交通オープンデータセンター）へ提供する', done: false, go: () => $('#btnExport').click(), note: '書き出した zip を ODPT の提供者向け手続きで登録' },
    ];
    const ol = $('#steps'); ol.innerHTML = '';
    let doneCount = 0;
    for (const st of steps) {
      if (st.done) doneCount++;
      ol.append(el('li', { class: st.done ? 'done' : '' }, el('span', { class: 'mark' }, st.done ? '✔' : '○'), el('span', { class: 'lab' }, st.label, st.note ? el('small', { class: 'muted' }, '　' + st.note) : null), st.done ? null : el('button', { class: 'btn small', onclick: st.go }, '開く')));
    }
    $('#stepsCount').textContent = `${doneCount} / ${steps.length}`;
    $('#stepsBox').open = doneCount < steps.length - 1;
  }
  $('#btnValidate').addEventListener('click', () => { runValidate(); setTab('validate'); });
  for (const id of ['#showErr', '#showWarn', '#showInfo', '#filterFile']) $(id).addEventListener('change', renderIssues);
  function applyFix(it) {
    try { it.fix.apply(S.feed); } catch (e) { alert('修正を適用できませんでした: ' + e.message); return; }
    changed(); runValidate(); renderChanges();
    if (document.querySelector('#tab-files.active')) renderEditor();
    renderZones(); renderTrips(); refreshMap(false);
  }
  $('#btnFixAll').addEventListener('click', () => {
    const list = S.issues.filter(i => i.fix && i.fix.safe);
    if (!list.length) return;
    if (!confirm(`安全な修正案 ${list.length} 件をまとめて適用しますか（値の整形や空欄化など。行の削除は含みません）`)) return;
    let n = 0;
    for (const it of list) { try { it.fix.apply(S.feed); n++; } catch (e) { /* 次へ */ } }
    changed(); runValidate(); renderChanges(); renderEditor(); renderZones(); renderTrips(); refreshMap(false);
    alert(`${n} 件を適用しました。もう一度「検証する」で結果を確かめてください。`);
  });
  function renderIssues() {
    const show = { error: $('#showErr').checked, warn: $('#showWarn').checked, info: $('#showInfo').checked };
    const ff = $('#filterFile').value;
    const ul = $('#issueList'); ul.innerHTML = '';
    const list = S.issues.filter(i => show[i.level] && (!ff || i.file === ff));
    const safeCount = S.issues.filter(i => i.fix && i.fix.safe).length;
    $('#btnFixAll').textContent = `安全な修正案をまとめて適用（${safeCount}）`;
    $('#btnFixAll').disabled = !safeCount;
    const frag = document.createDocumentFragment();
    for (const it of list.slice(0, 500)) {
      const li = el('li', { class: it.level, onclick: () => jumpTo(it) },
        el('div', null, it.msg),
        el('div', { class: 'loc' }, `${it.file}${it.row ? ' ' + it.row + ' 行目' : ''}${it.field ? ' / ' + it.field + '（' + SPEC.label(it.file, it.field) + '）' : ''}`));
      if (it.fix) li.append(el('div', { class: 'fix' }, el('span', null, '修正案: ' + it.fix.label), el('button', { class: 'btn small', onclick: e => { e.stopPropagation(); applyFix(it); } }, '適用')));
      li._issue = it;
      frag.append(li);
    }
    if (list.length > 500) frag.append(el('li', { class: 'info' }, `…ほか ${list.length - 500} 件`));
    if (!list.length && S.feed) frag.append(el('li', { class: 'info' }, '該当なし'));
    ul.append(frag);
  }
  const ruleList = $('#ruleList');
  for (const r of V.RULES) {
    const cb = el('input', { type: 'checkbox', checked: '' });
    cb.addEventListener('change', () => { if (cb.checked) S.disabledRules.delete(r.id); else S.disabledRules.add(r.id); runValidate(); });
    ruleList.append(el('label', null, cb, ' ' + r.label));
  }
  // 検証結果から該当箇所へ。戻れるように、どこから来たかを覚えておく
  function jumpTo(it) {
    S.backTo = { issue: it, scrollTop: $('#issueList').scrollTop };
    $('#backInfo').textContent = it.msg;
    $('#backBar').hidden = false;
    document.querySelectorAll('#issueList li').forEach(li => li.classList.toggle('current', li._issue === it));
    const rowsOf = n => (S.feed.files[n] ? S.feed.files[n].rows : []);
    const row = it.row != null && S.feed.files[it.file] ? rowsOf(it.file)[it.row - 2] : null;
    if (it.file === 'locations.geojson') {
      if (it.row) { S.loc = it.row - 2; setTab('zones'); renderZones(); refreshMap(false); const f = S.feed.locations.features[S.loc]; if (f) M.fitTo([f]); }
      return;
    }
    if (!S.feed.files[it.file]) return;
    S.file = it.file; S.mode = 'table'; S.filter = ''; S.hlRow = it.row ? it.row - 2 : null; S.hlField = it.field;
    S.page = S.hlRow == null ? 0 : Math.floor(S.hlRow / PAGE_SIZE);
    $('#fileSelect').value = S.file;
    document.querySelectorAll('.modes button').forEach(x => x.classList.toggle('active', x.dataset.mode === 'table'));
    setTab('files'); renderEditor();
    if (row) showRowOnMap(it.file, row);
  }
  // 行が地図のどこに当たるかを示す。検証結果からの移動と、ファイル編集で行を選んだときに使う
  function showGroup(gid) { if (!gid) return; S.group = gid; renderZones(); refreshMap(false); const ms = memberSet(gid); const feats = G.rows(S.feed, 'stops.txt').filter(r => ms.has(r.stop_id) && r.stop_lat && r.stop_lon).map(r => ({ geometry: { type: 'Point', coordinates: [+r.stop_lon, +r.stop_lat] } })); if (feats.length) M.fitTo(feats); }
  function showLoc(lid) { const i = ((S.feed.locations && S.feed.locations.features) || []).findIndex(f => String(f.id) === String(lid)); if (i < 0) return; S.loc = i; renderZones(); refreshMap(false); M.fitTo([S.feed.locations.features[i]]); }
  let lastShown = null;
  function showRowOnMap(file, row) {
    if (!row || lastShown === row) return; // 同じ行で何度も寄せない
    lastShown = row;
    if (file === 'stops.txt') { if (row.stop_id) selectStop(row.stop_id, { center: true, popup: true }); }
    else if (file === 'location_group_stops.txt') { showGroup(row.location_group_id); if (row.stop_id) selectStop(row.stop_id, { center: true, popup: true }); }
    else if (file === 'location_groups.txt') showGroup(row.location_group_id);
    else if (file === 'stop_times.txt') { if (row.stop_id) selectStop(row.stop_id, { center: true, popup: true }); else if (row.location_group_id) showGroup(row.location_group_id); else if (row.location_id) showLoc(row.location_id); }
    else if (file === 'transfers.txt' || file === 'pathways.txt') { if (row.from_stop_id) selectStop(row.from_stop_id, { center: true, popup: true }); }
    else if (file === 'stop_areas.txt') { if (row.stop_id) selectStop(row.stop_id, { center: true, popup: true }); }
  }
  $('#btnBack').addEventListener('click', () => {
    const b = S.backTo; if (!b) return;
    setTab('validate');
    const ul = $('#issueList'); ul.scrollTop = b.scrollTop;
    const li = [...ul.querySelectorAll('li')].find(x => x._issue === b.issue);
    if (li) { li.classList.add('current'); li.scrollIntoView({ block: 'center' }); }
    $('#backBar').hidden = true;
  });

  // ---------- タブ ----------
  function setTab(name) {
    document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + name));
    if (name !== 'zones') M.setMode('none');
    if (name === 'changes') renderChanges();
    if (name === 'validate') $('#backBar').hidden = true;
    M.map.resize();
  }
  document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));

  // ---------- ファイル編集 ----------
  function fillFileSelect() {
    const sel = $('#fileSelect'); sel.innerHTML = '';
    const names = SPEC.ORDER.filter(n => S.feed.files[n]).concat(Object.keys(S.feed.files).filter(n => !SPEC.ORDER.includes(n)));
    for (const n of names) sel.append(el('option', { value: n }, `${n}（${SPEC.FILES[n] ? SPEC.FILES[n].label : '仕様外'}・${S.feed.files[n].rows.length} 行）`));
    if (!names.includes(S.file)) S.file = names[0] || '';
    sel.value = S.file;
  }
  $('#fileSelect').addEventListener('change', e => { S.file = e.target.value; S.page = 0; S.filter = ''; S.hlRow = null; S.formIndex = 0; renderEditor(); });
  document.querySelectorAll('.modes button').forEach(b => b.addEventListener('click', () => { S.mode = b.dataset.mode; document.querySelectorAll('.modes button').forEach(x => x.classList.toggle('active', x === b)); renderEditor(); }));
  $('#btnAddFile').addEventListener('click', () => {
    if (!S.feed) return;
    const cands = SPEC.ORDER.filter(n => !S.feed.files[n]);
    const name = prompt('足すファイル名（候補: ' + cands.join(', ') + '）\n仕様にない名前でも構いません。', cands[0] || '');
    if (!name) return;
    const n = name.endsWith('.txt') ? name : name + '.txt';
    G.ensureTable(S.feed, n); S.file = n; changed(); fillFileSelect(); renderEditor();
  });

  function renderEditor() {
    const box = $('#editor'); box.innerHTML = '';
    if (!S.feed || !S.file) return;
    if (S.mode === 'table') renderTable(box);
    else if (S.mode === 'form') renderForm(box);
    else renderText(box);
  }

  function cellInput(file, col, row, onchange) {
    const fd = SPEC.field(file, col);
    let inp;
    if (fd && fd.type === 'enum') {
      inp = el('select', null, el('option', { value: '' }, ''));
      for (const [v, lab] of Object.entries(fd.values)) if (v !== '') inp.append(el('option', { value: v }, lab));
      if (row[col] && !(row[col] in fd.values)) inp.append(el('option', { value: row[col] }, row[col] + ' (仕様外)'));
      inp.value = row[col] || '';
    } else if (fd && fd.type === 'ref') {
      inp = el('input', { list: 'dl-' + fd.ref.replace(/\W/g, '_') });
      inp.value = row[col] || '';
    } else {
      inp = el('input', fd && (fd.type === 'int' || fd.type === 'float' || fd.type === 'lat' || fd.type === 'lon') ? { inputmode: 'decimal' } : {});
      inp.value = row[col] || '';
    }
    inp.addEventListener('change', () => { row[col] = inp.value.trim(); onchange && onchange(); changed(); });
    return inp;
  }
  function ensureDatalists() {
    for (const ref of ['agency.txt', 'stops.txt', 'routes.txt', 'trips.txt', 'booking_rules.txt', 'location_groups.txt', 'fare_attributes.txt', 'calendar', 'locations.geojson']) {
      const id = 'dl-' + ref.replace(/\W/g, '_');
      let dl = document.getElementById(id); if (!dl) { dl = el('datalist', { id }); document.body.append(dl); }
      dl.innerHTML = '';
      let items = [];
      if (ref === 'calendar') items = [...new Set([...G.rows(S.feed, 'calendar.txt'), ...G.rows(S.feed, 'calendar_dates.txt')].map(r => r.service_id))].map(v => [v, '']);
      else if (ref === 'locations.geojson') items = ((S.feed.locations && S.feed.locations.features) || []).map(f => [String(f.id), (f.properties || {}).stop_name || '']);
      else { const key = SPEC.FILES[ref].key; items = G.rows(S.feed, ref).map(r => [r[key], r.stop_name || r.route_long_name || r.route_short_name || r.agency_name || r.location_group_name || r.trip_headsign || '']); }
      for (const [v, lab] of items.slice(0, 2000)) dl.append(el('option', { value: v }, lab));
    }
  }

  function renderTable(box) {
    ensureDatalists();
    const t = S.feed.files[S.file];
    const spec = SPEC.FILES[S.file];
    const cols = spec ? spec.fields.map(f => f.name).filter(c => t.header.includes(c)).concat(t.header.filter(c => !spec.fields.some(f => f.name === c))) : t.header.slice();
    // 絞り込み
    const q = S.filter.trim().toLowerCase();
    const idx = [];
    t.rows.forEach((r, i) => { if (!q || cols.some(c => (r[c] || '').toLowerCase().includes(q))) idx.push(i); });
    const pages = Math.max(1, Math.ceil(idx.length / PAGE_SIZE));
    if (S.page >= pages) S.page = pages - 1;
    const bar = el('div', { class: 'tablebar' });
    const filt = el('input', { placeholder: '絞り込み（どの列でも）', value: S.filter });
    let ft; filt.addEventListener('input', () => { clearTimeout(ft); ft = setTimeout(() => { S.filter = filt.value; S.page = 0; renderEditor(); }, 300); });
    bar.append(filt,
      el('button', { class: 'btn small', onclick: () => { t.rows.push(G.newRow(S.file, defaultsFor(S.file))); S.filter = ''; S.page = Math.floor((t.rows.length - 1) / PAGE_SIZE); S.hlRow = t.rows.length - 1; changed(); renderEditor(); } }, '＋ 行を足す'),
      el('button', { class: 'btn small', onclick: () => {
        const cands = (spec ? spec.fields.map(f => f.name) : []).filter(c => !t.header.includes(c));
        const c = prompt('足す列の名前' + (cands.length ? '\n仕様の列で今ないもの: ' + cands.join(', ') : '') + '\n仕様にない名前でも構いません。', cands[0] || '');
        if (c && c.trim() && !t.header.includes(c.trim())) { t.header.push(c.trim()); changed(); renderEditor(); }
      } }, '＋ 列を足す'),
      el('span', { class: 'muted' }, `${idx.length} 行${q ? '（全 ' + t.rows.length + ' 行）' : ''}`),
      el('button', { class: 'btn small', onclick: () => { S.page = Math.max(0, S.page - 1); renderEditor(); } }, '‹'),
      el('span', null, `${S.page + 1} / ${pages}`),
      el('button', { class: 'btn small', onclick: () => { S.page = Math.min(pages - 1, S.page + 1); renderEditor(); } }, '›'));
    box.append(bar);
    const wrap = el('div', { class: 'tablewrap' });
    const table = el('table', { class: 'grid' });
    const thead = el('tr', null, el('th', null, '#'));
    for (const c of cols) {
      const fd = SPEC.field(S.file, c);
      const del = el('button', { class: 'coldel', title: `列 ${c} を消す`, onclick: e => {
        e.stopPropagation();
        const n = t.rows.filter(r => (r[c] || '') !== '').length;
        if (fd && fd.required === true) { alert(`${c} は必須の列なので消せません`); return; }
        if (!confirm(`列 ${c}（${fd ? fd.label : '仕様外'}）を消しますか？\n${n} 行に値が入っています。値も消えます（「列を足す」で列は戻せますが、値は戻りません）`)) return;
        t.header = t.header.filter(x => x !== c); for (const r of t.rows) delete r[c];
        changed(); renderEditor(); refreshMap(false);
      } }, '✕');
      thead.append(el('th', { class: fd && fd.required === true ? 'req' : '', title: (fd && fd.help ? fd.help + '\n' : '') + reqTitle(fd) }, c, reqMark(fd), fd && fd.required === true ? null : del, el('small', null, fd ? fd.label : '仕様外')));
    }
    thead.append(el('th', null, ''));
    table.append(el('thead', null, thead));
    const tbody = el('tbody');
    for (const i of idx.slice(S.page * PAGE_SIZE, (S.page + 1) * PAGE_SIZE)) {
      const r = t.rows[i];
      const tr = el('tr', { class: i === S.hlRow ? 'hl' : '', 'data-row': i });
      const pick = () => { tbody.querySelectorAll('tr.cur').forEach(x => x.classList.remove('cur')); tr.classList.add('cur'); showRowOnMap(S.file, r); };
      tr.addEventListener('focusin', pick); tr.addEventListener('click', pick);
      tr.append(el('td', { class: 'rownum' }, String(i + 2)));
      for (const c of cols) tr.append(el('td', { 'data-col': c }, cellInput(S.file, c, r, () => { if (S.file === 'stops.txt' || S.file === 'location_group_stops.txt' || S.file === 'location_groups.txt') refreshMap(false); })));
      tr.append(el('td', { class: 'del' }, el('button', { title: 'この行を消す', onclick: () => {
        if (S.file === 'stops.txt') { deleteStop(r.stop_id); return; }
        if (S.file === 'location_groups.txt') { deleteGroup(r.location_group_id); return; }
        if (confirm((i + 2) + ' 行目を消しますか')) { t.rows.splice(i, 1); changed(); renderEditor(); refreshMap(false); }
      } }, '✕')));
      tbody.append(tr);
    }
    table.append(tbody); wrap.append(table); box.append(wrap);
    markBadCells();
    if (S.hlRow != null) { const tr = tbody.querySelector(`tr[data-row="${S.hlRow}"]`); if (tr) { tr.scrollIntoView({ block: 'center' }); const td = S.hlField && tr.querySelector(`td[data-col="${S.hlField}"]`); const inp = td && td.querySelector('input,select'); if (inp) inp.focus(); } }
  }
  function markBadCells() {
    const box = $('#editor'); const tbody = box.querySelector('tbody'); if (!tbody) return;
    tbody.querySelectorAll('td.bad').forEach(td => { td.classList.remove('bad'); td.title = ''; });
    for (const it of S.issues) {
      if (it.file !== S.file || it.row == null || it.level === 'info') continue;
      const tr = tbody.querySelector(`tr[data-row="${it.row - 2}"]`); if (!tr) continue;
      const td = it.field ? tr.querySelector(`td[data-col="${it.field}"]`) : null;
      if (td) { td.classList.add('bad'); td.title = (td.title ? td.title + '\n' : '') + it.msg; }
    }
  }
  function defaultsFor(file) {
    const o = {};
    for (const fd of (SPEC.FILES[file] ? SPEC.FILES[file].fields : [])) if (fd.default != null) o[fd.name] = fd.default;
    if (file === 'stop_times.txt') { const last = G.rows(S.feed, file).slice(-1)[0]; if (last) { o.trip_id = last.trip_id; o.stop_sequence = String((+last.stop_sequence || 0) + 1); } }
    return o;
  }

  function renderForm(box) {
    ensureDatalists();
    const t = S.feed.files[S.file];
    const spec = SPEC.FILES[S.file];
    if (!t.rows.length) { box.append(el('p', { class: 'muted' }, '行がありません。'), el('button', { class: 'btn small', onclick: () => { t.rows.push(G.newRow(S.file, defaultsFor(S.file))); changed(); renderEditor(); } }, '＋ 行を足す')); return; }
    if (S.formIndex >= t.rows.length) S.formIndex = t.rows.length - 1;
    const r = t.rows[S.formIndex];
    const nav = el('div', { class: 'formnav' },
      el('button', { class: 'btn small', onclick: () => { S.formIndex = Math.max(0, S.formIndex - 1); renderEditor(); } }, '‹ 前'),
      el('span', null, `${S.formIndex + 1} / ${t.rows.length} 行目（ファイルの ${S.formIndex + 2} 行目）`),
      el('button', { class: 'btn small', onclick: () => { S.formIndex = Math.min(t.rows.length - 1, S.formIndex + 1); renderEditor(); } }, '次 ›'),
      el('button', { class: 'btn small', onclick: () => { t.rows.push(G.newRow(S.file, defaultsFor(S.file))); S.formIndex = t.rows.length - 1; changed(); renderEditor(); } }, '＋ 行を足す'),
      el('button', { class: 'btn small danger', onclick: () => { if (confirm('この行を消しますか')) { t.rows.splice(S.formIndex, 1); changed(); renderEditor(); } } }, '消す'));
    box.append(nav);
    showRowOnMap(S.file, r);
    const form = el('div', { class: 'form' });
    const cols = spec ? spec.fields.map(f => f.name).concat(t.header.filter(c => !spec.fields.some(f => f.name === c))) : t.header;
    const inputs = {};
    for (const c of cols) {
      const fd = SPEC.field(S.file, c);
      form.append(el('label', { title: c + (reqTitle(fd) ? '　' + reqTitle(fd) : '') }, (fd ? fd.label : c) + ' ', el('small', { class: 'muted' }, c), reqMark(fd)));
      inputs[c] = cellInput(S.file, c, r, () => { refreshMap(false); if (S.file === 'booking_rules.txt') applyBookingEnable(); });
      form.append(inputs[c]);
      if (fd && fd.help) form.append(el('div', { class: 'help' }, fd.help));
    }
    box.append(form);
    // 予約の種類で使える欄が変わる。使えない欄は灰色にして、入っている値は残す（検証で指摘される）
    function applyBookingEnable() {
      const bt = r.booking_type;
      const allow = {
        prior_notice_duration_min: bt === '1', prior_notice_duration_max: bt === '1',
        prior_notice_last_day: bt === '2', prior_notice_last_time: bt === '2',
        prior_notice_start_day: bt !== '0', prior_notice_start_time: bt !== '0', prior_notice_service_id: bt === '2',
      };
      for (const [c, ok] of Object.entries(allow)) if (inputs[c]) { inputs[c].disabled = !ok && !r[c]; inputs[c].classList.toggle('na', !ok); inputs[c].title = ok ? '' : 'この予約の種類では使わない欄'; }
    }
    if (S.file === 'booking_rules.txt') applyBookingEnable();
  }

  function renderText(box) {
    const t = S.feed.files[S.file];
    const ta = el('textarea', { class: 'csv', spellcheck: 'false' });
    ta.value = G.tableToCSV(S.file, t).replace(/^﻿/, '');
    const msg = el('span', { class: 'muted' }, 'CSV をそのまま編集できます。「反映」で表に戻します。Excel からの貼り付けも可（タブ区切りは自動でカンマに直します）。');
    const bar = el('div', { class: 'tablebar' }, el('button', { class: 'btn small primary', onclick: () => {
      let text = ta.value;
      if (text.includes('\t') && !text.split('\n')[0].includes(',')) text = text.split('\n').map(l => l.split('\t').map(v => /[",]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v).join(',')).join('\n');
      const nt = G.tableFromCSV(text);
      if (!nt.header.length) { alert('ヘッダー行がありません'); return; }
      S.feed.files[S.file] = nt; G.ensureTable(S.feed, S.file);
      changed(); fillFileSelect(); renderEditor(); refreshMap(false);
    } }, '反映'), msg);
    box.append(bar, ta);
  }

  // ---------- 区域・停留所 ----------
  function memberSet(gid) { return new Set(G.rows(S.feed, 'location_group_stops.txt').filter(r => r.location_group_id === gid).map(r => r.stop_id)); }
  function toggleMember(gid, sid) {
    const t = G.ensureTable(S.feed, 'location_group_stops.txt');
    const i = t.rows.findIndex(r => r.location_group_id === gid && r.stop_id === sid);
    if (i >= 0) t.rows.splice(i, 1); else t.rows.push(G.newRow('location_group_stops.txt', { location_group_id: gid, stop_id: sid }));
    changed(); renderZones(); refreshMap(false);
  }
  function renderZones() {
    if (!S.feed) return;
    const gs = $('#groupSelect'); gs.innerHTML = '';
    const groups = G.rows(S.feed, 'location_groups.txt');
    for (const g of groups) gs.append(el('option', { value: g.location_group_id }, `${g.location_group_id}: ${g.location_group_name || '(名前なし)'}`));
    if (!groups.some(g => g.location_group_id === S.group)) S.group = groups[0] ? groups[0].location_group_id : '';
    gs.value = S.group;
    const g = groups.find(x => x.location_group_id === S.group);
    $('#groupName').value = g ? g.location_group_name : '';
    $('#groupName').disabled = !g;
    $('#groupCount').textContent = g ? `停留所 ${memberSet(S.group).size} 件` : '';
    const ls = $('#locSelect'); ls.innerHTML = '';
    const feats = (S.feed.locations && S.feed.locations.features) || [];
    feats.forEach((f, i) => ls.append(el('option', { value: i }, `${f.id}: ${(f.properties || {}).stop_name || '(名前なし)'}`)));
    if (S.loc >= feats.length) S.loc = feats.length - 1;
    ls.value = S.loc;
    const lf = $('#locForm'); lf.innerHTML = '';
    const f = feats[S.loc];
    if (f) {
      const idIn = el('input', { value: f.id == null ? '' : f.id }); idIn.addEventListener('change', () => { f.id = idIn.value.trim(); changed(); renderZones(); refreshMap(false); });
      lf.append(el('label', { title: '必須' }, '区域ID ', el('small', { class: 'muted' }, 'id'), el('span', { class: 'req' }, ' *')), idIn);
      f.properties = f.properties || {};
      for (const p of SPEC.LOCATION_PROPS) {
        const inp = el('input', { value: f.properties[p.name] || '' });
        inp.addEventListener('change', () => { if (inp.value.trim()) f.properties[p.name] = inp.value.trim(); else delete f.properties[p.name]; changed(); renderZones(); refreshMap(false); });
        lf.append(el('label', null, p.label + ' ', el('small', { class: 'muted' }, p.name)), inp);
      }
      const n = f.geometry && f.geometry.type === 'Polygon' ? f.geometry.coordinates[0].length - 1 : '-';
      lf.append(el('label', null, '頂点'), el('div', { class: 'muted' }, `${n} 点（${f.geometry ? f.geometry.type : '-'}）`));
    }
    renderStopForm();
  }
  $('#groupSelect').addEventListener('change', e => { S.group = e.target.value; renderZones(); refreshMap(false); });
  // グループ名は打つたびに反映する（選択欄の表示もその場で直す。入力欄から出たら全体を描き直す）
  $('#groupName').addEventListener('input', e => {
    const g = G.rows(S.feed, 'location_groups.txt').find(x => x.location_group_id === S.group); if (!g) return;
    g.location_group_name = e.target.value.trim(); changed();
    const opt = $('#groupSelect').querySelector(`option[value="${CSS.escape(S.group)}"]`); if (opt) opt.textContent = `${S.group}: ${g.location_group_name || '(名前なし)'}`;
  });
  $('#groupName').addEventListener('change', () => renderZones());
  $('#btnGroupAdd').addEventListener('click', () => {
    if (!S.feed) return;
    const t = G.ensureTable(S.feed, 'location_groups.txt');
    const id = prompt('グループID（英数字）', nextId(t.rows.map(r => r.location_group_id), 'zone')); if (!id) return;
    if (t.rows.some(r => r.location_group_id === id)) { alert('同じ ID があります'); return; }
    t.rows.push(G.newRow('location_groups.txt', { location_group_id: id, location_group_name: '' }));
    S.group = id; changed(); renderZones(); refreshMap(false);
  });
  $('#btnGroupDel').addEventListener('click', () => { if (S.group) deleteGroup(S.group); });
  $('#btnPickStops').addEventListener('click', () => { if (S.group) toggleMode('pickStops'); else alert('先にグループを選ぶか追加してください'); });
  $('#btnGroupAll').addEventListener('click', () => {
    if (!S.group) return;
    const t = G.ensureTable(S.feed, 'location_group_stops.txt'); const have = memberSet(S.group);
    for (const s of G.rows(S.feed, 'stops.txt')) if (!have.has(s.stop_id) && (s.location_type || '0') === '0') t.rows.push(G.newRow('location_group_stops.txt', { location_group_id: S.group, stop_id: s.stop_id }));
    changed(); renderZones(); refreshMap(false);
  });
  $('#btnGroupNone').addEventListener('click', () => { if (!S.group) return; const t = S.feed.files['location_group_stops.txt']; if (t) t.rows = t.rows.filter(r => r.location_group_id !== S.group); changed(); renderZones(); refreshMap(false); });
  $('#locSelect').addEventListener('change', e => { S.loc = +e.target.value; renderZones(); refreshMap(false); const f = S.feed.locations.features[S.loc]; if (f) M.fitTo([f]); });
  $('#btnLocDraw').addEventListener('click', () => { if (!S.feed) return; toggleMode('draw'); });
  $('#btnLocDel').addEventListener('click', () => { if (S.feed && S.feed.locations) deleteLocation(S.loc); });
  $('#btnStopAdd').addEventListener('click', () => { if (!S.feed) return; toggleMode('addStop'); if (M.getMode() === 'addStop') { S.stop = null; if (stopPopup) { stopPopup.remove(); stopPopup = null; } refreshMap(false); } renderStopForm(); });
  $('#map').addEventListener('modechange', () => renderStopForm());
  $('#btnStopMove').addEventListener('click', () => { if (!S.feed) return; toggleMode('moveStop'); });
  $('#btnStopDel').addEventListener('click', () => { if (S.stop) deleteStop(S.stop); });
  // 停留所を消す。参照している行（グループの対応、便の行、乗継、構内経路、運賃エリア、親駅）も一緒に消す
  function deleteStop(id) {
    const R = n => G.rows(S.feed, n);
    const st = R('stops.txt').find(r => r.stop_id === id); if (!st) return false;
    const refs = {
      groups: R('location_group_stops.txt').filter(r => r.stop_id === id),
      times: R('stop_times.txt').filter(r => r.stop_id === id),
      transfers: R('transfers.txt').filter(r => r.from_stop_id === id || r.to_stop_id === id),
      pathways: R('pathways.txt').filter(r => r.from_stop_id === id || r.to_stop_id === id),
      areas: R('stop_areas.txt').filter(r => r.stop_id === id),
      children: R('stops.txt').filter(r => r.parent_station === id),
    };
    const trips = [...new Set(refs.times.map(r => r.trip_id))];
    const lines = [];
    if (refs.groups.length) lines.push(`・グループの対応 ${refs.groups.length} 件（${[...new Set(refs.groups.map(r => r.location_group_id))].join(', ')}）`);
    if (refs.times.length) lines.push(`・便の行 ${refs.times.length} 件（便 ${trips.slice(0, 5).join(', ')}${trips.length > 5 ? ' ほか' : ''}）。行が減った便は検証で確かめてください`);
    if (refs.transfers.length) lines.push(`・乗継 ${refs.transfers.length} 件`);
    if (refs.pathways.length) lines.push(`・構内経路 ${refs.pathways.length} 件`);
    if (refs.areas.length) lines.push(`・運賃エリアの対応 ${refs.areas.length} 件`);
    if (refs.children.length) lines.push(`・${refs.children.length} 件の停留所の parent_station を空にする`);
    if (!confirm(`停留所 "${id}" ${st.stop_name || ''} を消しますか？` + (lines.length ? '\n次も一緒に消します:\n' + lines.join('\n') : '\n参照している行はありません'))) return false;
    const F = S.feed.files;
    F['stops.txt'].rows = F['stops.txt'].rows.filter(r => r.stop_id !== id);
    for (const r of refs.children) r.parent_station = '';
    if (F['location_group_stops.txt']) F['location_group_stops.txt'].rows = F['location_group_stops.txt'].rows.filter(r => r.stop_id !== id);
    if (F['stop_times.txt']) F['stop_times.txt'].rows = F['stop_times.txt'].rows.filter(r => r.stop_id !== id);
    if (F['transfers.txt']) F['transfers.txt'].rows = F['transfers.txt'].rows.filter(r => r.from_stop_id !== id && r.to_stop_id !== id);
    if (F['pathways.txt']) F['pathways.txt'].rows = F['pathways.txt'].rows.filter(r => r.from_stop_id !== id && r.to_stop_id !== id);
    if (F['stop_areas.txt']) F['stop_areas.txt'].rows = F['stop_areas.txt'].rows.filter(r => r.stop_id !== id);
    if (S.stop === id) S.stop = null;
    if (stopPopup) { stopPopup.remove(); stopPopup = null; }
    changed(); fillFileSelect(); renderZones(); renderTrips(); refreshMap(false);
    if (document.querySelector('#tab-files.active')) renderEditor();
    return true;
  }
  // グループを消す。停留所との対応と、そのグループを使う便の行も消す
  function deleteGroup(gid) {
    const R = n => G.rows(S.feed, n);
    const times = R('stop_times.txt').filter(r => r.location_group_id === gid);
    const trips = [...new Set(times.map(r => r.trip_id))];
    if (!confirm(`グループ "${gid}" ${groupLabel(gid)} を消しますか？\n・停留所との対応 ${R('location_group_stops.txt').filter(r => r.location_group_id === gid).length} 件も消します` + (times.length ? `\n・便の行 ${times.length} 件（便 ${trips.slice(0, 5).join(', ')}${trips.length > 5 ? ' ほか' : ''}）も消します。行が減った便は検証で確かめてください` : ''))) return false;
    const F = S.feed.files;
    F['location_groups.txt'].rows = F['location_groups.txt'].rows.filter(r => r.location_group_id !== gid);
    if (F['location_group_stops.txt']) F['location_group_stops.txt'].rows = F['location_group_stops.txt'].rows.filter(r => r.location_group_id !== gid);
    if (F['stop_times.txt']) F['stop_times.txt'].rows = F['stop_times.txt'].rows.filter(r => r.location_group_id !== gid);
    if (S.group === gid) S.group = '';
    changed(); fillFileSelect(); renderZones(); renderTrips(); refreshMap(false);
    if (document.querySelector('#tab-files.active')) renderEditor();
    return true;
  }
  // 区域ポリゴンを消す。その区域を使う便の行も消す
  function deleteLocation(index) {
    const f = S.feed.locations && S.feed.locations.features[index]; if (!f) return false;
    const lid = String(f.id);
    const times = G.rows(S.feed, 'stop_times.txt').filter(r => String(r.location_id) === lid);
    const trips = [...new Set(times.map(r => r.trip_id))];
    if (!confirm(`区域 "${lid}" ${(f.properties || {}).stop_name || ''} を消しますか？` + (times.length ? `\n・便の行 ${times.length} 件（便 ${trips.slice(0, 5).join(', ')}${trips.length > 5 ? ' ほか' : ''}）も消します。行が減った便は検証で確かめてください` : '\n参照している便の行はありません'))) return false;
    S.feed.locations.features.splice(index, 1);
    const F = S.feed.files; if (F['stop_times.txt']) F['stop_times.txt'].rows = F['stop_times.txt'].rows.filter(r => String(r.location_id) !== lid);
    S.loc = Math.min(S.loc, S.feed.locations.features.length - 1);
    changed(); fillFileSelect(); renderZones(); renderTrips(); refreshMap(false);
    if (document.querySelector('#tab-files.active')) renderEditor();
    return true;
  }
  // 停留所を選ぶ。地図のクリック、「停留所を探す」、表からの移動で共通に使う
  let stopPopup = null;
  function selectStop(id, o) {
    o = o || {};
    S.stop = id;
    renderStopForm(); refreshMap(false);
    const r = id && G.rows(S.feed, 'stops.txt').find(x => x.stop_id === id);
    if (stopPopup) { stopPopup.remove(); stopPopup = null; }
    if (!r || isNaN(+r.stop_lat) || isNaN(+r.stop_lon)) return;
    if (o.center) M.map.easeTo({ center: [+r.stop_lon, +r.stop_lat], zoom: Math.max(M.map.getZoom(), 15) });
    if (!o.popup) return;
    const inG = S.group ? memberSet(S.group).has(r.stop_id) : null;
    const div = el('div', { class: 'stop-popup' },
      el('b', null, r.stop_name || '(名前なし)'),
      el('div', { class: 'muted small' }, `stop_id ${r.stop_id}${r.stop_code ? '　番号 ' + r.stop_code : ''}`),
      el('div', { class: 'muted small' }, `${r.stop_lat}, ${r.stop_lon}`),
      ...((S.stopIssueList && S.stopIssueList.get(r.stop_id)) || []).slice(0, 4).map(it => el('div', { class: 'popup-issue ' + it.level, onclick: () => { setTab('validate'); const li = [...$('#issueList').querySelectorAll('li')].find(x => x._issue === it); if (li) { li.classList.add('current'); li.scrollIntoView({ block: 'center' }); } } }, (it.level === 'error' ? '✖ ' : '△ ') + it.msg)),
      el('div', { class: 'row' },
        el('button', { class: 'btn small', onclick: () => { setTab('zones'); renderStopForm(); $('#stopForm').scrollIntoView({ block: 'center' }); } }, '編集'),
        S.group ? el('button', { class: 'btn small', title: `location_group_id ${S.group}`, onclick: () => { toggleMember(S.group, r.stop_id); selectStop(r.stop_id, { popup: true }); } }, inG ? `グループ「${groupLabel(S.group)}」から外す` : `グループ「${groupLabel(S.group)}」に入れる`) : null,
        el('button', { class: 'btn small', onclick: () => { S.file = 'stops.txt'; S.mode = 'table'; S.filter = r.stop_id; S.page = 0; S.hlRow = null; $('#fileSelect').value = S.file; document.querySelectorAll('.modes button').forEach(x => x.classList.toggle('active', x.dataset.mode === 'table')); setTab('files'); renderEditor(); } }, '表で見る'),
        el('button', { class: 'btn small danger', onclick: () => deleteStop(r.stop_id) }, '消す')));
    stopPopup = new maplibregl.Popup({ offset: 12, maxWidth: '300px' }).setLngLat([+r.stop_lon, +r.stop_lat]).setDOMContent(div).addTo(M.map);
  }
  $('#stopFind').addEventListener('change', e => {
    if (!S.feed) return;
    const q = e.target.value.trim().toLowerCase(); if (!q) return;
    const rows = G.rows(S.feed, 'stops.txt');
    const r = rows.find(x => x.stop_id.toLowerCase() === q) || rows.find(x => (x.stop_name || '').toLowerCase() === q) || rows.find(x => (x.stop_name || '').toLowerCase().includes(q) || x.stop_id.toLowerCase().includes(q));
    if (!r) { alert('見つかりません: ' + e.target.value); return; }
    ensureDatalists();
    selectStop(r.stop_id, { popup: true, center: true });
    e.target.value = '';
  });
  $('#stopFind').addEventListener('focus', () => { if (S.feed) ensureDatalists(); });

  // 左の幅を変える仕切り。幅はブラウザに記憶する
  (() => {
    const side = document.querySelector('.side'), sp = $('#splitter');
    try { const w = +localStorage.getItem('sideWidth'); if (w >= 280) side.style.width = w + 'px'; } catch (e) { /* 使えない環境 */ }
    let dragging = false;
    sp.addEventListener('pointerdown', e => { dragging = true; sp.classList.add('on'); document.body.classList.add('resizing'); sp.setPointerCapture(e.pointerId); e.preventDefault(); });
    sp.addEventListener('pointermove', e => {
      if (!dragging) return;
      const w = Math.min(window.innerWidth - 320, Math.max(280, e.clientX - side.getBoundingClientRect().left));
      side.style.width = w + 'px'; side.style.maxWidth = 'none';
      M.map.resize();
    });
    const end = () => { if (!dragging) return; dragging = false; sp.classList.remove('on'); document.body.classList.remove('resizing'); try { localStorage.setItem('sideWidth', String(side.getBoundingClientRect().width | 0)); } catch (e) { /* 使えない環境 */ } M.map.resize(); };
    sp.addEventListener('pointerup', end); sp.addEventListener('pointercancel', end);
  })();

  function renderStopForm() {
    const box = $('#stopForm'); box.innerHTML = '';
    const r = S.stop && G.rows(S.feed, 'stops.txt').find(x => x.stop_id === S.stop);
    if (M.getMode() === 'addStop' && !r) { box.append(el('div', { class: 'hint' }, '新規追加: 地図をクリックすると、その場所に停留所を作ります。作ったあと、ここで名前などを直せます。')); return; }
    if (!r) { box.append(el('div', { class: 'muted' }, '停留所が選ばれていません（地図の停留所をクリックするか、「停留所を探す」で選びます）')); return; }
    box.append(el('div', { class: 'formtitle' }, `編集中: ${r.stop_id}${r.stop_name ? '　' + r.stop_name : ''}`));
    ensureDatalists();
    // 主な欄（location_type は GTFS-JP v4 で必須なのでここに入れる）。残りは「その他の欄を表示」で
    const main = ['stop_id', 'stop_name', 'stop_code', 'stop_lat', 'stop_lon', 'location_type', 'stop_desc'];
    const header = (S.feed.files['stops.txt'] || { header: [] }).header;
    const rest = header.filter(c => c && !main.includes(c));
    const addField = c => {
      const inp = cellInput('stops.txt', c, r, () => { refreshMap(false); renderStopForm(); });
      inp.dataset.col = c;
      const fd = SPEC.field('stops.txt', c);
      box.append(el('label', { title: c + (reqTitle(fd) ? '　' + reqTitle(fd) : '') }, (fd ? fd.label : c) + ' ', el('small', { class: 'muted' }, c), reqMark(fd)), inp);
      if (fd && fd.help) box.append(el('div', { class: 'help' }, fd.help));
    };
    for (const c of main) if (header.includes(c) || main.includes(c)) addField(c);
    if (rest.length) {
      const tog = el('button', { class: 'btn small', onclick: () => { S.stopFormAll = !S.stopFormAll; renderStopForm(); } }, S.stopFormAll ? `その他の欄を隠す（${rest.length}）` : `その他の欄を表示（${rest.length}）`);
      box.append(el('label', null, ''), tog);
      if (S.stopFormAll) for (const c of rest) addField(c);
    }
    if (S.group) {
      const inG = memberSet(S.group).has(r.stop_id);
      box.append(el('label', null, 'グループ'), el('button', { class: 'btn small', title: `location_group_id ${S.group}`, onclick: () => toggleMember(S.group, r.stop_id) }, inG ? `「${groupLabel(S.group)}」から外す` : `「${groupLabel(S.group)}」に入れる`));
    }
  }

  // ---------- 便を追加 ----------
  function renderTrips() {
    if (!S.feed) return;
    const f = $('#tripForm'); f.innerHTML = '';
    const sel = (opts, val) => { const s = el('select'); for (const [v, l] of opts) s.append(el('option', { value: v }, l)); if (val != null) s.value = val; return s; };
    const routes = G.rows(S.feed, 'routes.txt').map(r => [r.route_id, `${r.route_id}: ${r.route_long_name || r.route_short_name}`]);
    const services = [...new Set([...G.rows(S.feed, 'calendar.txt'), ...G.rows(S.feed, 'calendar_dates.txt')].map(r => r.service_id))].map(v => [v, v]);
    const refs = [].concat(
      G.rows(S.feed, 'location_groups.txt').map(g => ['location_group_id|' + g.location_group_id, `グループ ${g.location_group_id}: ${g.location_group_name || ''}`]),
      ((S.feed.locations && S.feed.locations.features) || []).map(x => ['location_id|' + x.id, `区域 ${x.id}: ${(x.properties || {}).stop_name || ''}`]),
      G.rows(S.feed, 'stops.txt').slice(0, 500).map(s => ['stop_id|' + s.stop_id, `停留所 ${s.stop_id}: ${s.stop_name || ''}`]));
    const rules = [['', '（なし）']].concat(G.rows(S.feed, 'booking_rules.txt').map(b => [b.booking_rule_id, `${b.booking_rule_id}: ${b.message || ('種類 ' + b.booking_type)}`]));
    const trips = G.rows(S.feed, 'trips.txt');
    const w = {
      tripId: el('input', { value: nextId(trips.map(t => t.trip_id), 'trip') }),
      route: sel(routes), service: sel(services), from: sel(refs), to: sel(refs),
      start: el('input', { value: '08:00:00', pattern: '\\d{1,2}:\\d{2}:\\d{2}' }), end: el('input', { value: '17:00:00', pattern: '\\d{1,2}:\\d{2}:\\d{2}' }),
      rule: sel(rules), headsign: el('input', { value: '' }), headsignBack: el('input', { value: '' }),
      roundTrip: el('input', { type: 'checkbox', checked: '' }), intraZone: el('input', { type: 'checkbox' }),
    };
    const rows = [['便ID', 'trip_id', w.tripId, true], ['路線', 'route_id', w.route, true], ['運行日', 'service_id', w.service, true], ['乗る場所', 'stop_sequence 1', w.from, true], ['降りる場所', '最後の stop_sequence', w.to, true], ['乗降時間帯 開始', 'start_pickup_drop_off_window', w.start, true], ['乗降時間帯 終了', 'end_pickup_drop_off_window', w.end, true], ['予約ルール', 'pickup/drop_off_booking_rule_id', w.rule, false], ['行き先表示', 'trip_headsign', w.headsign, false]];
    for (const [lab, col, inp, req] of rows) f.append(el('label', { title: req ? '必須' : '' }, lab + ' ', el('small', { class: 'muted' }, col), req ? el('span', { class: 'req' }, ' *') : null), inp);
    const optRound = el('div', { class: 'row' }, el('label', null, w.roundTrip, ' 復路の便も作る（便ID に _1 / _2 を付け、direction_id 0 / 1）'));
    const optBack = el('label', null, '復路の行き先表示 ', el('small', { class: 'muted' }, 'trip_headsign'));
    const optIntra = el('div', { class: 'row' }, el('label', null, w.intraZone, ' 「乗る場所」の区域の中だけの利用もできる（その区域の行を往復とも 2 つにする）'));
    f.append(el('div'), optRound, optBack, w.headsignBack, el('div'), optIntra);
    const syncOpts = () => { const same = w.from.value === w.to.value; optRound.style.display = same ? 'none' : ''; optBack.style.display = same || !w.roundTrip.checked ? 'none' : ''; w.headsignBack.style.display = same || !w.roundTrip.checked ? 'none' : ''; optIntra.style.display = same ? 'none' : ''; };
    w.from.addEventListener('change', () => { w.to.value = w.from.value; syncOpts(); });
    w.to.addEventListener('change', syncOpts); w.roundTrip.addEventListener('change', syncOpts); syncOpts();
    $('#btnTripAdd').onclick = () => {
      if (!routes.length || !services.length || !refs.length) { alert('路線・運行日・区域（またはグループ・停留所）が先に必要です'); return; }
      const id = w.tripId.value.trim(); if (!id) return;
      if (trips.some(t => t.trip_id === id)) { alert('同じ便IDがあります'); return; }
      const parse = v => { const [k, val] = v.split('|'); return { [k]: val }; };
      if (trips.some(t => t.trip_id === id + '_1' || t.trip_id === id + '_2')) { alert('同じ便IDがあります'); return; }
      G.addZoneTrip(S.feed, { tripId: id, routeId: w.route.value, serviceId: w.service.value, ref: parse(w.from.value), refTo: parse(w.to.value), start: w.start.value, end: w.end.value, bookingRuleId: w.rule.value, headsign: w.headsign.value, headsignBack: w.headsignBack.value, roundTrip: w.roundTrip.checked, intraZone: w.intraZone.checked });
      changed(); fillFileSelect(); renderTrips();
    };
    const ul = $('#tripList'); ul.innerHTML = '';
    const st = G.rows(S.feed, 'stop_times.txt');
    for (const t of trips.slice(0, 300)) {
      const rowsOf = st.filter(x => x.trip_id === t.trip_id);
      const desc = rowsOf.map(x => (x.location_group_id ? 'G:' + x.location_group_id : x.location_id ? 'A:' + x.location_id : x.stop_id) + (x.start_pickup_drop_off_window ? ` ${x.start_pickup_drop_off_window.slice(0, 5)}-${x.end_pickup_drop_off_window.slice(0, 5)}` : x.departure_time ? ' ' + x.departure_time.slice(0, 5) : '')).join(' → ');
      ul.append(el('li', null, el('span', null, el('b', null, t.trip_id), ` (${t.route_id} / ${t.service_id}) `, el('span', { class: 'muted small' }, desc || '行なし')),
        el('button', { class: 'btn small', onclick: () => { S.file = 'stop_times.txt'; S.mode = 'table'; S.filter = t.trip_id; S.page = 0; $('#fileSelect').value = S.file; setTab('files'); renderEditor(); } }, '行を見る'),
        el('button', { class: 'btn small danger', onclick: () => { if (!confirm(`便 "${t.trip_id}" とその行を消しますか`)) return; S.feed.files['trips.txt'].rows = trips.filter(x => x !== t); S.feed.files['stop_times.txt'].rows = st.filter(x => x.trip_id !== t.trip_id); changed(); fillFileSelect(); renderTrips(); } }, '消す')));
    }
    if (trips.length > 300) ul.append(el('li', { class: 'muted' }, `…ほか ${trips.length - 300} 便（ファイル編集で見てください）`));
  }

  // ---------- 変更（元データとの差） ----------
  function renderChanges() {
    if (!S.feed) return;
    const d = S.diff = window.FlexDiff.diff(S.original, S.feed);
    const t = d.totals;
    const badge = $('#changeBadge'); badge.textContent = (t.added + t.updated + t.deleted) ? `${t.added + t.updated + t.deleted}` : '';
    $('#changeSummary').textContent = (t.added + t.updated + t.deleted) ? `読み込んだときのデータと比べて、追加 ${t.added} 件・更新 ${t.updated} 件・削除 ${t.deleted} 件。ファイルを選ぶと内訳が出ます。` : '読み込んだときのデータと比べた変更はありません。';
    const tbl = $('#diffTable'); tbl.innerHTML = '';
    tbl.append(el('thead', null, el('tr', null, el('th', null, 'ファイル'), el('th', null, '追加'), el('th', null, '更新'), el('th', null, '削除'))));
    const tb = el('tbody');
    const names = Object.keys(d.files).sort((a, b) => (SPEC.ORDER.indexOf(a) + 1 || 99) - (SPEC.ORDER.indexOf(b) + 1 || 99));
    for (const n of names) {
      const f = d.files[n];
      if (!f.added.length && !f.updated.length && !f.deleted.length) continue;
      tb.append(el('tr', { class: n === S.diffFile ? 'sel' : '', onclick: () => { S.diffFile = n; renderChanges(); } },
        el('td', null, n), el('td', { class: 'add' }, f.added.length ? '+' + f.added.length : ''), el('td', { class: 'upd' }, f.updated.length ? '~' + f.updated.length : ''), el('td', { class: 'del' }, f.deleted.length ? '-' + f.deleted.length : '')));
    }
    tbl.append(tb);
    const box = $('#diffDetail'); box.innerHTML = '';
    const f = d.files[S.diffFile]; if (!f) return;
    const isGeo = S.diffFile === 'locations.geojson';
    const jump = (index) => { if (isGeo) { S.loc = index; setTab('zones'); renderZones(); refreshMap(); } else { S.file = S.diffFile; S.mode = 'table'; S.filter = ''; S.hlRow = index; S.hlField = null; S.page = Math.floor(index / PAGE_SIZE); $('#fileSelect').value = S.file; setTab('files'); renderEditor(); } };
    const after = () => { changed(); runValidate(); renderChanges(); renderZones(); renderTrips(); refreshMap(false); if (document.querySelector('#tab-files.active')) renderEditor(); };
    const addItem = (cls, title, changes, ops) => {
      const div = el('div', null, el('b', null, title));
      if (changes && changes.length) div.append(el('div', { class: 'chg' }, changes.map(c => `${c.col}: "${c.from}" → "${c.to}"`).join('　')));
      else if (changes) div.append(el('div', { class: 'chg' }, changes));
      const item = el('div', { class: 'diffitem ' + cls }, div);
      for (const [lab, fn] of ops) item.append(el('button', { class: 'btn small', onclick: fn }, lab));
      box.append(item);
    };
    for (const x of f.added.slice(0, 300)) addItem('add', '追加: ' + x.key, isGeo ? null : SPEC.FILES[S.diffFile] ? Object.entries(x.row).filter(([k, v]) => v).map(([k, v]) => k + '=' + v).join(', ') : null, [['行へ', () => jump(x.index)], ['取り消す（消す）', () => { if (isGeo) S.feed.locations.features.splice(x.index, 1); else S.feed.files[S.diffFile].rows.splice(x.index, 1); after(); }]]);
    for (const x of f.updated.slice(0, 300)) addItem('upd', '更新: ' + x.key, x.changes, [['行へ', () => jump(x.index)], ['元に戻す', () => { if (isGeo) { const o = S.original.locations.features.find(g => String(g.id) === x.key); if (o) S.feed.locations.features[x.index] = structuredClone(o); } else { for (const c of x.changes) x.row[c.col] = c.from; } after(); }]]);
    for (const x of f.deleted.slice(0, 300)) addItem('del', '削除: ' + x.key, isGeo ? null : Object.entries(x.row).filter(([k, v]) => v).map(([k, v]) => k + '=' + v).join(', '), [['元に戻す（復活）', () => { if (isGeo) { S.feed.locations.features.push(structuredClone(x.feature)); } else { G.ensureTable(S.feed, S.diffFile).rows.push(structuredClone(x.row)); } after(); }]]);
    if (f.colsAdded.length || f.colsRemoved.length) box.append(el('div', { class: 'muted small' }, `列の追加: ${f.colsAdded.join(', ') || 'なし'}　列の削除: ${f.colsRemoved.join(', ') || 'なし'}`));
    const more = f.added.length + f.updated.length + f.deleted.length - 900;
    if (more > 0) box.append(el('div', { class: 'muted small' }, `…ほか ${more} 件`));
  }

  // ---------- 小物 ----------
  // 必須の印: * は必須、※ は条件付きで必須（状況によって必須になる。検証で指摘する）
  function reqMark(fd) {
    if (!fd) return null;
    if (fd.required === true) return el('span', { class: 'req' }, ' *');
    if (fd.required === 'cond') return el('span', { class: 'cond' }, ' ※');
    return null;
  }
  function reqTitle(fd) { return !fd ? '' : fd.required === true ? '必須' : fd.required === 'cond' ? '条件付きで必須' : ''; }
  // グループの表示名: 名前があれば名前、なければ「ID 1」のように
  function groupLabel(gid) { const g = G.rows(S.feed, 'location_groups.txt').find(x => x.location_group_id === gid); return g && g.location_group_name ? g.location_group_name : 'ID ' + gid; }
  function nextId(existing, prefix) { const set = new Set(existing); let n = 1; while (set.has(prefix + n)) n++; return prefix + n; }
  function ccw(ring) { let a = 0; for (let i = 0; i < ring.length - 1; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]; return a < 0 ? ring.slice().reverse() : ring; }

  // 開発者ツールから触れるように（デバッグ用）
  window.FlexApp = { S, M, refreshMap, runValidate, selectStop, loadFeed };

  // ---------- 起動: 前回の続き ----------
  (async () => {
    try {
      const saved = await STORE.load();
      if (saved && saved.feed) {
        $('#resumeInfo').textContent = `「${saved.name || '無題'}」を ${new Date(saved.savedAt).toLocaleString('ja-JP')} に自動保存しています。`;
        const dlg = $('#resumeDialog');
        // 「捨てる」と明示したときだけ消す。Esc や外側クリックで閉じたときは続きから（消すのは取り返しがつかない）
        // ボタンの click で直接扱う（環境によって dialog の close イベントが来ないことがあった）。close / cancel は保険
        let handled = false;
        const act = v => {
          if (handled) return; handled = true;
          if (v === 'discard') { STORE.clear(); return; }
          loadFeed(saved.feed, saved.name, saved.original || null).catch(e => { console.error('前回の続きの読み込みに失敗', e); alert('前回の続きを読み込めませんでした: ' + e.message); });
        };
        dlg.querySelector('button[value=resume]').addEventListener('click', () => act('resume'));
        dlg.querySelector('button[value=discard]').addEventListener('click', () => act('discard'));
        dlg.addEventListener('close', () => act(dlg.returnValue), { once: true });
        dlg.addEventListener('cancel', () => act('resume'), { once: true });
        dlg.showModal();
      }
    } catch (e) { console.warn('自動保存の読み込みに失敗', e); }
  })();
})();
