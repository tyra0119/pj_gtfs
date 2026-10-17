// 地図（MapLibre GL JS）。停留所・区域の表示と、区域ポリゴンの描画・頂点編集、停留所の追加・移動。
// 操作は Google マップと同じ: 左ドラッグ移動、右ドラッグ回転、ホイール拡大縮小、2 本指でひねり・拡大・傾き。
// ボタンは右下に 方角・現在地・拡大・縮小。
(function () {
  'use strict';

  const GSI_ATTR = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">地理院タイル</a>';
  // 背景地図。見やすさは場所と目的で変わるので、画面で切り替えられるようにする
  const BASEMAPS = {
    pale: { label: '淡色地図（地理院）', tiles: ['https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png'], attribution: GSI_ATTR, maxzoom: 18 },
    std: { label: '標準地図（地理院）', tiles: ['https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png'], attribution: GSI_ATTR, maxzoom: 18 },
    blank: { label: '白地図（地理院）', tiles: ['https://cyberjapandata.gsi.go.jp/xyz/blank/{z}/{x}/{y}.png'], attribution: GSI_ATTR, maxzoom: 14 },
    photo: { label: '航空写真（地理院）', tiles: ['https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg'], attribution: GSI_ATTR, maxzoom: 18 },
    osm: { label: 'OpenStreetMap', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors', maxzoom: 19 },
  };

  function create(container, handlers) {
    const H = Object.assign({ onStopClick() {}, onMapClick() {}, onStopMoved() {}, onPolygonDone() {}, onVertexMoved() {}, onVertexInsert() {}, onVertexDelete() {}, onVertexClick() {}, onLocationClick() {} }, handlers || {});
    const map = new maplibregl.Map({
      container,
      style: {
        version: 8,
        glyphs: 'https://maps.gsi.go.jp/xyz/noto-jp/{fontstack}/{range}.pbf', // 地理院の配信。openmaptiles は 2026-10 時点で HTML を返す
        sources: Object.fromEntries(Object.entries(BASEMAPS).map(([k, b]) => ['base-' + k, { type: 'raster', tiles: b.tiles, tileSize: 256, attribution: b.attribution, maxzoom: b.maxzoom }])),
        layers: Object.keys(BASEMAPS).map(k => ({ id: 'base-' + k, type: 'raster', source: 'base-' + k, layout: { visibility: k === 'pale' ? 'visible' : 'none' }, paint: { 'raster-opacity': 0.8 } })),
      },
      center: [139.7, 35.7], zoom: 9, maxZoom: 20, attributionControl: false,
      dragRotate: true, touchZoomRotate: true, touchPitch: true, pitchWithRotate: true,
    });
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    map.on('contextmenu', e => {
      e.preventDefault();
      if (!map.getLayer('verts')) return;
      const feats = map.queryRenderedFeatures(e.point, { layers: ['verts'] }).filter(f => f.properties.kind === 'vert');
      if (feats.length && state.mode !== 'draw') H.onVertexDelete(feats[0].properties.ring, feats[0].properties.index);
    });

    const state = { mode: 'none', selectedFeature: -1, draft: [], drag: null, memberIds: new Set(), selectedStop: null };
    const empty = () => ({ type: 'FeatureCollection', features: [] });

    map.on('load', () => {
      map.addSource('locations', { type: 'geojson', data: empty() });
      map.addLayer({ id: 'loc-fill', type: 'fill', source: 'locations', paint: { 'fill-color': ['case', ['boolean', ['get', '_selected'], false], '#f0a030', '#7c4dff'], 'fill-opacity': ['case', ['boolean', ['get', '_dim'], false], 0.05, 0.22] } });
      // 区域の線: 選択中は橙、エラーのある区域は赤、警告のある区域は黄土色（太め）
      map.addLayer({ id: 'loc-line', type: 'line', source: 'locations', paint: { 'line-color': ['case', ['boolean', ['get', '_selected'], false], '#d07000', ['==', ['get', '_issue'], 'error'], '#d33', ['==', ['get', '_issue'], 'warn'], '#e0a000', '#5a2fd0'], 'line-width': ['case', ['has', '_issue'], 4, 3], 'line-opacity': ['case', ['boolean', ['get', '_dim'], false], 0.25, 1] } });
      // 選んだ便の経路（停留所を順に結ぶ線。shapes.txt があればその形）
      map.addSource('trip-line', { type: 'geojson', data: empty() });
      map.addLayer({ id: 'trip-line', type: 'line', source: 'trip-line', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#00897b', 'line-width': 4, 'line-opacity': 0.8 } });
      map.addLayer({ id: 'loc-label', type: 'symbol', source: 'locations', layout: { 'text-field': ['coalesce', ['get', 'stop_name'], ['get', '_id']], 'text-size': 13, 'text-font': ['NotoSansCJKjp-Regular'] }, paint: { 'text-color': '#1a3f8a', 'text-halo-color': '#fff', 'text-halo-width': 1.5 } });
      map.addSource('draft', { type: 'geojson', data: empty() });
      map.addLayer({ id: 'draft-fill', type: 'fill', source: 'draft', paint: { 'fill-color': '#f0a030', 'fill-opacity': 0.15 } });
      map.addLayer({ id: 'draft-line', type: 'line', source: 'draft', paint: { 'line-color': '#d07000', 'line-width': 2, 'line-dasharray': [2, 1] } });
      map.addSource('verts', { type: 'geojson', data: empty() });
      map.addLayer({ id: 'verts', type: 'circle', source: 'verts', filter: ['==', ['get', 'kind'], 'vert'], paint: { 'circle-radius': ['case', ['boolean', ['get', '_sel'], false], 8, 6], 'circle-color': ['case', ['boolean', ['get', '_sel'], false], '#d07000', '#fff'], 'circle-stroke-color': '#d07000', 'circle-stroke-width': 2 } });
      map.addLayer({ id: 'mids', type: 'circle', source: 'verts', filter: ['==', ['get', 'kind'], 'mid'], paint: { 'circle-radius': 4, 'circle-color': '#fde', 'circle-stroke-color': '#d07000', 'circle-stroke-width': 1 } });
      map.addSource('stops', { type: 'geojson', data: empty() });
      map.addLayer({ id: 'stops', type: 'circle', source: 'stops', paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, ['case', ['boolean', ['get', '_selected'], false], 8, 4], 14, ['case', ['boolean', ['get', '_selected'], false], 11, 7], 17, ['case', ['boolean', ['get', '_selected'], false], 14, 10]],
        'circle-color': ['case', ['boolean', ['get', '_selected'], false], '#ff9800', ['has', '_color'], ['get', '_color'], ['boolean', ['get', '_member'], false], '#e53935', '#1e88e5'],
        'circle-stroke-color': ['case', ['boolean', ['get', '_selected'], false], '#b35c00', ['==', ['get', '_issue'], 'error'], '#b71c1c', ['==', ['get', '_issue'], 'warn'], '#d78a00', '#fff'],
        'circle-stroke-width': ['case', ['boolean', ['get', '_selected'], false], 3, ['has', '_issue'], 3, 2] } });
      map.addLayer({ id: 'stop-issue', type: 'symbol', source: 'stops', filter: ['has', '_issue'], layout: { 'text-field': '!', 'text-size': 14, 'text-font': ['NotoSansCJKjp-Regular'], 'text-offset': [0, -1.3], 'text-allow-overlap': true, 'text-ignore-placement': true }, paint: { 'text-color': ['case', ['==', ['get', '_issue'], 'error'], '#d33', '#d78a00'], 'text-halo-color': '#fff', 'text-halo-width': 1.5 } });
      // 便を選んだときの、停留所の順番（1, 2, …）
      map.addLayer({ id: 'stop-seq', type: 'symbol', source: 'stops', filter: ['has', '_seq'], layout: { 'text-field': ['get', '_seq'], 'text-size': 11, 'text-font': ['NotoSansCJKjp-Regular'], 'text-allow-overlap': true, 'text-ignore-placement': true }, paint: { 'text-color': '#fff' } });
      map.addLayer({ id: 'stop-label', type: 'symbol', source: 'stops', minzoom: 13, layout: { 'text-field': ['get', 'stop_name'], 'text-size': 12, 'text-offset': [0, 1.0], 'text-anchor': 'top', 'text-font': ['NotoSansCJKjp-Regular'], 'text-optional': true }, paint: { 'text-color': '#1a1a1a', 'text-halo-color': '#fff', 'text-halo-width': 1.6 } });
      // マウスを乗せたら名前を出す（拡大しなくても分かるように）
      const tip = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10, className: 'stop-tip' });
      map.on('mousemove', 'stops', e => { const f = e.features[0]; if (!f) return; tip.setLngLat(f.geometry.coordinates).setText((f.properties.stop_name || '(名前なし)') + '　' + f.properties.stop_id).addTo(map); });
      map.on('mouseleave', 'stops', () => tip.remove());
      // 区域にマウスを乗せても名前を出す（停留所の上では停留所を優先）
      map.on('mousemove', 'loc-fill', e => {
        if (state.mode === 'draw' || map.queryRenderedFeatures(e.point, { layers: ['stops'] }).length) return;
        const p = e.features[0] && e.features[0].properties; if (!p) return;
        tip.setLngLat(e.lngLat).setText((p.stop_name || '(名前なし)') + '　区域 ' + p._id).addTo(map);
      });
      map.on('mouseleave', 'loc-fill', () => tip.remove());
      wire();
    });

    function wire() {
      const canvas = map.getCanvas();
      map.on('mouseenter', 'stops', () => { if (state.mode !== 'draw') canvas.style.cursor = 'pointer'; });
      map.on('mouseleave', 'stops', () => { canvas.style.cursor = state.mode === 'draw' || state.mode === 'addStop' ? 'crosshair' : ''; });
      map.on('mouseenter', 'verts', () => { canvas.style.cursor = 'move'; });
      map.on('mouseleave', 'verts', () => { canvas.style.cursor = ''; });
      map.on('mouseenter', 'loc-fill', () => { if (state.mode === 'none') canvas.style.cursor = 'pointer'; });
      map.on('mouseleave', 'loc-fill', () => { if (state.mode === 'none') canvas.style.cursor = ''; });

      map.on('click', e => {
        if (state.mode === 'draw') { state.draft.push([e.lngLat.lng, e.lngLat.lat]); renderDraft(); return; }
        if (state.mode === 'addStop') { H.onMapClick(e.lngLat); return; }
        // 頂点を押す → 吹き出し（消す）。辺の真ん中の点を押す → そこに頂点を足す
        const vhit = map.queryRenderedFeatures(e.point, { layers: ['verts', 'mids'] });
        if (vhit.length) {
          const v = vhit.find(f => f.properties.kind === 'vert'), mid = vhit.find(f => f.properties.kind === 'mid');
          if (v) { state.selVert = { ring: v.properties.ring, index: v.properties.index }; H.onVertexClick(v.properties.ring, v.properties.index, v.geometry.coordinates); }
          else if (mid) { state.selVert = null; H.onVertexInsert(mid.properties.ring, mid.properties.index + 1, mid.geometry.coordinates.slice(), true); }
          return;
        }
        state.selVert = null;
        const stops = map.queryRenderedFeatures(e.point, { layers: ['stops'] });
        if (stops.length) { H.onStopClick(stops[0].properties.stop_id, e); return; }
        const locs = map.queryRenderedFeatures(e.point, { layers: ['loc-fill'] });
        // 区域が重なっていれば、押した所にある区域をすべて渡す（どれを選ぶかは画面側で決める）
        if (locs.length) { H.onLocationClick(locs[0].properties._index, e.lngLat, [...new Set(locs.map(f => f.properties._index))]); return; }
      });
      map.on('dblclick', e => { if (state.mode === 'draw') { e.preventDefault(); finishDraw(); } });
      document.addEventListener('keydown', e => {
        if (e.key === 'Enter' && state.mode === 'draw') finishDraw();
        if (e.key === 'Escape' && state.mode === 'draw') { state.draft = []; renderDraft(); setMode('none'); }
        if (e.key === 'Escape' && state.mode === 'freehand') { fh.pts = null; renderDraft(); setMode('none'); }
        if (e.key === 'Backspace' && state.mode === 'draw' && document.activeElement === document.body) { state.draft.pop(); renderDraft(); }
      });

      // 頂点・停留所のドラッグ（マウスとタッチ）
      const startDrag = (e, kind) => {
        const feats = map.queryRenderedFeatures(e.point, { layers: kind === 'vert' ? ['verts', 'mids'] : ['stops'] });
        if (!feats.length) return false;
        const p = feats[0].properties;
        if (kind === 'stop' && state.mode !== 'moveStop') return false;
        state.drag = { kind, p, x: e.point.x, y: e.point.y, moved: false };
        map.dragPan.disable();
        e.preventDefault();
        return true;
      };
      // 3 ピクセル以上動かしたらドラッグ。動かさずに離したときは「押した」として click に任せる
      // （前は、辺の真ん中の点を押すと離したときに隣の頂点がその位置へ動き、続く click がその頂点を押したことになって頂点が増えなかった）
      const moveDrag = e => {
        if (!state.drag) return;
        if (!state.drag.moved) { if (Math.hypot(e.point.x - state.drag.x, e.point.y - state.drag.y) < 3) return; state.drag.moved = true; }
        const ll = [e.lngLat.lng, e.lngLat.lat];
        if (state.drag.kind === 'vert') {
          if (state.drag.p.kind === 'mid') { H.onVertexInsert(state.drag.p.ring, state.drag.p.index + 1, ll); state.drag.p = Object.assign({}, state.drag.p, { kind: 'vert', index: state.drag.p.index + 1 }); }
          else H.onVertexMoved(state.drag.p.ring, state.drag.p.index, ll);
        } else H.onStopMoved(state.drag.p.stop_id, ll, false);
      };
      const endDrag = e => {
        if (!state.drag) return;
        if (!state.drag.moved) { state.drag = null; map.dragPan.enable(); return; }
        if (state.drag.kind === 'stop') H.onStopMoved(state.drag.p.stop_id, [e.lngLat.lng, e.lngLat.lat], true);
        else H.onVertexMoved(state.drag.p.ring, state.drag.p.index, [e.lngLat.lng, e.lngLat.lat], true);
        state.drag = null;
        map.dragPan.enable();
      };
      map.on('mousedown', e => { if (e.originalEvent.button !== 0 || state.mode === 'freehand' || state.mode === 'draw') return; if (startDrag(e, 'vert') || startDrag(e, 'stop')) { map.on('mousemove', moveDrag); map.once('mouseup', ev => { map.off('mousemove', moveDrag); endDrag(ev); }); } });
      map.on('touchstart', e => { if (e.points.length !== 1) return; if (startDrag(e, 'vert') || startDrag(e, 'stop')) { map.on('touchmove', moveDrag); map.once('touchend', ev => { map.off('touchmove', moveDrag); endDrag(ev); }); } });
    }

    function finishDraw() {
      if (state.draft.length >= 3) { const ring = state.draft.slice(); ring.push(ring[0].slice()); H.onPolygonDone(ring); }
      state.draft = []; renderDraft(); setMode('none');
    }
    // ---- なぞって描く ----
    // 左ボタンを押したまま（指 1 本で）外周をなぞり、離すと、線を間引いて頂点に変える（画面で 3 ピクセルより小さいぶれは省く）
    const fh = { pts: null };
    const FH_STEP = 3, FH_TOL = 3, FH_MAX = 300;
    function fhStart(p) { fh.pts = [[p.x, p.y]]; fhRender(); }
    function fhMove(p) { if (!fh.pts) return; const l = fh.pts[fh.pts.length - 1]; if (Math.hypot(p.x - l[0], p.y - l[1]) >= FH_STEP) { fh.pts.push([p.x, p.y]); fhRender(); } }
    function fhRender() {
      const src = map.getSource('draft'); if (!src) return;
      const c = (fh.pts || []).map(p => { const ll = map.unproject(p); return [ll.lng, ll.lat]; });
      src.setData({ type: 'FeatureCollection', features: c.length >= 2 ? [{ type: 'Feature', geometry: { type: 'LineString', coordinates: c.concat(c.length >= 3 ? [c[0]] : []) } }] : [] });
    }
    // 線を間引く（Ramer-Douglas-Peucker）
    function simplify(pts, tol) {
      if (pts.length < 3) return pts.slice();
      const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
      const stack = [[0, pts.length - 1]];
      while (stack.length) {
        const [a, b] = stack.pop(); const [ax, ay] = pts[a], [bx, by] = pts[b]; const L = Math.hypot(bx - ax, by - ay) || 1;
        let md = 0, mi = -1;
        for (let i = a + 1; i < b; i++) { const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / L; if (d > md) { md = d; mi = i; } }
        if (md > tol && mi > 0) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
      }
      return pts.filter((_, i) => keep[i]);
    }
    function fhEnd() {
      if (!fh.pts) return;
      let pts = fh.pts; fh.pts = null;
      // 終わりが始まりの近くなら、その点は始まりと同じとみなす
      if (pts.length > 3 && Math.hypot(pts[pts.length - 1][0] - pts[0][0], pts[pts.length - 1][1] - pts[0][1]) < 12) pts = pts.slice(0, -1);
      let s = simplify(pts, FH_TOL), tol = FH_TOL;
      while (s.length > FH_MAX) { tol *= 1.5; s = simplify(pts, tol); }
      const r6 = v => Math.round(v * 1e6) / 1e6;
      const ring = s.map(p => { const ll = map.unproject(p); return [r6(ll.lng), r6(ll.lat)]; });
      // 面積がほとんどない（線を 1 本引いただけ）なら区域にしない
      let area = 0; for (let i = 0; i < s.length; i++) { const a = s[i], b = s[(i + 1) % s.length]; area += a[0] * b[1] - b[0] * a[1]; }
      renderDraft();
      setMode('none');
      if (ring.length >= 3 && Math.abs(area) / 2 > 100) { ring.push(ring[0].slice()); H.onPolygonDone(ring); }
    }
    // 画面の点の並びで、なぞる操作をまとめて行う（テスト・開発者ツール用）
    function drawPath(points) { fhStart(points[0]); for (const p of points.slice(1)) fhMove(p); fhEnd(); }
    function renderDraft() {
      const src = map.getSource('draft'); if (!src) return;
      const feats = [];
      if (state.draft.length >= 2) feats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: state.draft } });
      if (state.draft.length >= 3) feats.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [state.draft.concat([state.draft[0]])] } });
      src.setData({ type: 'FeatureCollection', features: feats });
      const v = map.getSource('verts');
      if (v && state.mode === 'draw') v.setData({ type: 'FeatureCollection', features: state.draft.map((c, i) => ({ type: 'Feature', properties: { kind: 'vert', ring: -1, index: i }, geometry: { type: 'Point', coordinates: c } })) });
    }

    function setMode(m) {
      const prev = state.mode;
      state.mode = m;
      map.getCanvas().style.cursor = (m === 'draw' || m === 'addStop' || m === 'freehand') ? 'crosshair' : '';
      if (m === 'draw' || m === 'freehand') map.doubleClickZoom.disable(); else map.doubleClickZoom.enable();
      // なぞって描く間は、左ドラッグ（指 1 本）を線を引く操作にする。右ドラッグの回転・ホイールの拡大縮小はそのまま
      if (m === 'freehand') map.dragPan.disable(); else if (prev === 'freehand') { fh.pts = null; map.dragPan.enable(); }
      if (m !== 'draw') { state.draft = []; renderDraft(); }
      container.dispatchEvent(new CustomEvent('modechange', { detail: m }));
    }

    // ---- データの反映 ----
    // issues: Map(stop_id -> 'error' | 'warn')。縁取りと「!」で示す
    // o.colorOf: 停留所ごとの色（グループごとの色分け・便の乗車／降車）、o.seqOf: 便の中の順番
    function setStops(rows, memberIds, selectedId, issues, o) {
      o = o || {};
      state.memberIds = memberIds || new Set(); state.selectedStop = selectedId || null;
      const feats = [];
      for (const r of rows) {
        const lat = parseFloat(r.stop_lat), lon = parseFloat(r.stop_lon);
        if (isNaN(lat) || isNaN(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue; // 範囲外の座標は置けない（検証で指摘する）
        const props = { stop_id: r.stop_id, stop_name: r.stop_name || '', _member: state.memberIds.has(r.stop_id), _selected: r.stop_id === state.selectedStop };
        if (o.colorOf && o.colorOf.has(r.stop_id)) props._color = o.colorOf.get(r.stop_id);
        if (o.seqOf && o.seqOf.has(r.stop_id)) props._seq = String(o.seqOf.get(r.stop_id));
        if (issues && issues.has(r.stop_id)) props._issue = issues.get(r.stop_id);
        feats.push({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [lon, lat] } });
      }
      const src = map.getSource('stops'); if (src) src.setData({ type: 'FeatureCollection', features: feats });
      return feats;
    }
    // focus: 強調する区域の id の集合（選んだ便が使う区域）。ほかは薄くする。null なら全部ふつう
    // issues: 区域の id → 'error' / 'warn'（線の色を変える）
    function setLocations(fc, selectedIndex, focus, issues) {
      state.selectedFeature = selectedIndex == null ? -1 : selectedIndex;
      const feats = ((fc && fc.features) || []).map((f, i) => { const p = Object.assign({}, f.properties || {}, { _id: f.id, _index: i, _selected: i === state.selectedFeature, _dim: !!(focus && !focus.has(String(f.id))) }); const lv = issues && issues.get(String(f.id)); if (lv) p._issue = lv; return { type: 'Feature', properties: p, geometry: f.geometry }; });
      const src = map.getSource('locations'); if (src) src.setData({ type: 'FeatureCollection', features: feats });
      renderVerts(fc);
    }
    function renderVerts(fc) {
      const src = map.getSource('verts'); if (!src) return;
      const f = fc && fc.features && fc.features[state.selectedFeature];
      if (!f || !f.geometry || f.geometry.type !== 'Polygon') { src.setData(empty()); return; }
      const feats = [];
      f.geometry.coordinates.forEach((ring, ri) => {
        for (let i = 0; i < ring.length - 1; i++) {
          const sel = !!(state.selVert && state.selVert.ring === ri && state.selVert.index === i);
          feats.push({ type: 'Feature', properties: { kind: 'vert', ring: ri, index: i, _sel: sel }, geometry: { type: 'Point', coordinates: ring[i] } });
          const a = ring[i], b = ring[i + 1];
          feats.push({ type: 'Feature', properties: { kind: 'mid', ring: ri, index: i }, geometry: { type: 'Point', coordinates: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] } });
        }
      });
      src.setData({ type: 'FeatureCollection', features: feats });
    }
    function fitTo(feats) {
      const b = new maplibregl.LngLatBounds();
      let n = 0;
      const walk = c => { if (typeof c[0] === 'number') { if (Math.abs(c[1]) <= 90 && Math.abs(c[0]) <= 180) { b.extend(c); n++; } } else c.forEach(walk); };
      for (const f of feats) if (f && f.geometry) walk(f.geometry.coordinates);
      if (n) map.fitBounds(b, { padding: 60, maxZoom: 15, duration: 600 });
    }

    // ---- 右下のボタン（方角・現在地・拡大・縮小）----
    const top = document.createElement('div');
    top.className = 'map-top';
    const sel = document.createElement('select');
    sel.title = '背景の地図'; sel.id = 'baseMap';
    for (const [k, b] of Object.entries(BASEMAPS)) { const o = document.createElement('option'); o.value = k; o.textContent = b.label; sel.appendChild(o); }
    const op = document.createElement('input'); op.type = 'range'; op.min = '20'; op.max = '100'; op.value = '80'; op.title = '背景の濃さ';
    top.append(sel, op);
    container.appendChild(top);
    const applyBase = () => { if (!map.getLayer('base-pale')) return; for (const k of Object.keys(BASEMAPS)) { map.setLayoutProperty('base-' + k, 'visibility', k === sel.value ? 'visible' : 'none'); map.setPaintProperty('base-' + k, 'raster-opacity', (+op.value) / 100); } try { localStorage.setItem('basemap', sel.value); localStorage.setItem('baseOpacity', op.value); } catch (e) { /* 使えない環境 */ } };
    try { const b = localStorage.getItem('basemap'); if (b && BASEMAPS[b]) sel.value = b; const o = localStorage.getItem('baseOpacity'); if (o) op.value = o; } catch (e) { /* 使えない環境 */ }
    sel.addEventListener('change', applyBase); op.addEventListener('input', applyBase);
    map.on('load', applyBase);
    const legend = document.createElement('div');
    legend.className = 'map-legend';
    legend.innerHTML = '<span><i style="background:#1e88e5"></i>停留所</span><span><i style="background:#e53935"></i>選択中グループの停留所</span><span><i style="background:#ff9800"></i>選択中</span><span><i style="background:#fff;border:3px solid #b71c1c"></i>エラーあり</span><span><i style="background:#fff;border:3px solid #d78a00"></i>警告あり</span><span><i style="background:rgba(124,77,255,.3);border:2px solid #5a2fd0;border-radius:2px"></i>区域</span>';
    container.appendChild(legend);

    const ctl = document.createElement('div');
    ctl.className = 'map-ctl';
    ctl.innerHTML = '<button class="mc-compass" title="北を上に"><svg viewBox="0 0 24 24"><polygon points="12,2 16,12 12,10 8,12" fill="#e0442a"/><polygon points="12,22 8,12 12,14 16,12" fill="#999"/></svg></button>' +
      '<button class="mc-locate" title="現在地"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" fill="#333"/><circle cx="12" cy="12" r="7" fill="none" stroke="#333" stroke-width="2"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4" stroke="#333" stroke-width="2"/></svg></button>' +
      '<div class="mc-zoom"><button class="mc-in" title="拡大">＋</button><button class="mc-out" title="縮小">−</button></div>';
    container.appendChild(ctl);
    const compass = ctl.querySelector('.mc-compass svg');
    map.on('rotate', () => { compass.style.transform = `rotate(${-map.getBearing()}deg)`; });
    ctl.querySelector('.mc-compass').onclick = () => map.easeTo({ bearing: 0, pitch: 0 });
    ctl.querySelector('.mc-in').onclick = () => map.zoomIn();
    ctl.querySelector('.mc-out').onclick = () => map.zoomOut();
    ctl.querySelector('.mc-locate').onclick = () => {
      if (!navigator.geolocation) return;
      navigator.geolocation.getCurrentPosition(p => map.easeTo({ center: [p.coords.longitude, p.coords.latitude], zoom: Math.max(map.getZoom(), 14) }), () => { if (H.onLocateFallback) H.onLocateFallback(); });
    };

    function setTripLine(coords) { const src = map.getSource('trip-line'); if (src) src.setData(coords && coords.length > 1 ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }] } : empty()); }
    // 凡例の下に足す説明（グループの色、選んだ便の乗車・降車の色）
    const legendExtra = document.createElement('div'); legendExtra.className = 'legend-extra'; legend.appendChild(legendExtra);
    function setLegendExtra(items) { legendExtra.innerHTML = ''; for (const [color, text] of items || []) { const s = document.createElement('span'); const i = document.createElement('i'); i.style.background = color; s.append(i, document.createTextNode(text)); legendExtra.appendChild(s); } legendExtra.style.display = items && items.length ? '' : 'none'; }
    setLegendExtra(null);
    // なぞって描く: マウス（左ボタン）と指 1 本。2 本目の指が触れたらやめる
    map.on('mousedown', e => {
      if (state.mode !== 'freehand' || (e.originalEvent && e.originalEvent.button !== 0)) return;
      if (e.preventDefault) e.preventDefault();
      fhStart(e.point);
      const mv = ev => fhMove(ev.point);
      map.on('mousemove', mv);
      window.addEventListener('mouseup', () => { map.off('mousemove', mv); fhEnd(); }, { once: true });
    });
    map.on('touchstart', e => {
      if (state.mode !== 'freehand') return;
      if (e.points.length !== 1) { fh.pts = null; renderDraft(); return; }
      if (e.preventDefault) e.preventDefault();
      fhStart(e.point);
      const tm = ev => { if (ev.points.length !== 1) { fh.pts = null; renderDraft(); return; } fhMove(ev.point); };
      map.on('touchmove', tm);
      map.once('touchend', () => { map.off('touchmove', tm); fhEnd(); });
    });
    return { map, state, setMode, setStops, setLocations, setTripLine, setLegendExtra, fitTo, finishDraw, drawPath, getMode: () => state.mode, top };
  }

  window.FlexMap = { create };
})();
