// 地図（MapLibre GL JS）。停留所・区域の表示と、区域ポリゴンの描画・頂点編集、停留所の追加・移動。
// 操作は Google マップと同じ: 左ドラッグ移動、右ドラッグ回転、ホイール拡大縮小、2 本指でひねり・拡大・傾き。
// ボタンは右下に 方角・現在地・拡大・縮小。
(function () {
  'use strict';

  const GSI_ATTR = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">地理院タイル</a>';

  function create(container, handlers) {
    const H = Object.assign({ onStopClick() {}, onMapClick() {}, onStopMoved() {}, onPolygonDone() {}, onVertexMoved() {}, onVertexInsert() {}, onVertexDelete() {}, onLocationClick() {} }, handlers || {});
    const map = new maplibregl.Map({
      container,
      style: {
        version: 8,
        glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
        sources: { gsi: { type: 'raster', tiles: ['https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png'], tileSize: 256, attribution: GSI_ATTR, maxzoom: 18 } },
        layers: [{ id: 'gsi', type: 'raster', source: 'gsi' }],
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
      map.addLayer({ id: 'loc-fill', type: 'fill', source: 'locations', paint: { 'fill-color': ['case', ['boolean', ['get', '_selected'], false], '#f0a030', '#2a7fff'], 'fill-opacity': 0.25 } });
      map.addLayer({ id: 'loc-line', type: 'line', source: 'locations', paint: { 'line-color': ['case', ['boolean', ['get', '_selected'], false], '#d07000', '#1a5fd0'], 'line-width': 2 } });
      map.addLayer({ id: 'loc-label', type: 'symbol', source: 'locations', layout: { 'text-field': ['coalesce', ['get', 'stop_name'], ['get', '_id']], 'text-size': 13, 'text-font': ['Noto Sans Regular'] }, paint: { 'text-color': '#1a3f8a', 'text-halo-color': '#fff', 'text-halo-width': 1.5 } });
      map.addSource('draft', { type: 'geojson', data: empty() });
      map.addLayer({ id: 'draft-fill', type: 'fill', source: 'draft', paint: { 'fill-color': '#f0a030', 'fill-opacity': 0.15 } });
      map.addLayer({ id: 'draft-line', type: 'line', source: 'draft', paint: { 'line-color': '#d07000', 'line-width': 2, 'line-dasharray': [2, 1] } });
      map.addSource('verts', { type: 'geojson', data: empty() });
      map.addLayer({ id: 'verts', type: 'circle', source: 'verts', paint: { 'circle-radius': 6, 'circle-color': '#fff', 'circle-stroke-color': '#d07000', 'circle-stroke-width': 2 } });
      map.addLayer({ id: 'mids', type: 'circle', source: 'verts', filter: ['==', ['get', 'kind'], 'mid'], paint: { 'circle-radius': 4, 'circle-color': '#fde', 'circle-stroke-color': '#d07000', 'circle-stroke-width': 1 } });
      map.addSource('stops', { type: 'geojson', data: empty() });
      map.addLayer({ id: 'stops', type: 'circle', source: 'stops', paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 3, 14, 6, 17, 9],
        'circle-color': ['case', ['boolean', ['get', '_member'], false], '#e0442a', ['boolean', ['get', '_selected'], false], '#f0a030', '#2a9d4a'],
        'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 } });
      map.addLayer({ id: 'stop-label', type: 'symbol', source: 'stops', minzoom: 14, layout: { 'text-field': ['get', 'stop_name'], 'text-size': 11, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-font': ['Noto Sans Regular'], 'text-optional': true }, paint: { 'text-color': '#222', 'text-halo-color': '#fff', 'text-halo-width': 1.2 } });
      wire();
    });

    function wire() {
      const canvas = map.getCanvas();
      map.on('mouseenter', 'stops', () => { if (state.mode !== 'draw') canvas.style.cursor = 'pointer'; });
      map.on('mouseleave', 'stops', () => { canvas.style.cursor = state.mode === 'draw' || state.mode === 'addStop' ? 'crosshair' : ''; });
      map.on('mouseenter', 'verts', () => { canvas.style.cursor = 'move'; });
      map.on('mouseleave', 'verts', () => { canvas.style.cursor = ''; });

      map.on('click', e => {
        if (state.mode === 'draw') { state.draft.push([e.lngLat.lng, e.lngLat.lat]); renderDraft(); return; }
        if (state.mode === 'addStop') { H.onMapClick(e.lngLat); return; }
        const verts = map.queryRenderedFeatures(e.point, { layers: ['verts'] });
        if (verts.length) return;
        const stops = map.queryRenderedFeatures(e.point, { layers: ['stops'] });
        if (stops.length) { H.onStopClick(stops[0].properties.stop_id, e); return; }
        const locs = map.queryRenderedFeatures(e.point, { layers: ['loc-fill'] });
        if (locs.length) { H.onLocationClick(locs[0].properties._index); return; }
      });
      map.on('dblclick', e => { if (state.mode === 'draw') { e.preventDefault(); finishDraw(); } });
      document.addEventListener('keydown', e => {
        if (e.key === 'Enter' && state.mode === 'draw') finishDraw();
        if (e.key === 'Escape' && state.mode === 'draw') { state.draft = []; renderDraft(); setMode('none'); }
        if (e.key === 'Backspace' && state.mode === 'draw' && document.activeElement === document.body) { state.draft.pop(); renderDraft(); }
      });

      // 頂点・停留所のドラッグ（マウスとタッチ）
      const startDrag = (e, kind) => {
        const feats = map.queryRenderedFeatures(e.point, { layers: [kind === 'vert' ? 'verts' : 'stops'] });
        if (!feats.length) return false;
        const p = feats[0].properties;
        if (kind === 'stop' && state.mode !== 'moveStop') return false;
        state.drag = { kind, p };
        map.dragPan.disable();
        e.preventDefault();
        return true;
      };
      const moveDrag = e => {
        if (!state.drag) return;
        const ll = [e.lngLat.lng, e.lngLat.lat];
        if (state.drag.kind === 'vert') {
          if (state.drag.p.kind === 'mid') { H.onVertexInsert(state.drag.p.ring, state.drag.p.index + 1, ll); state.drag.p = Object.assign({}, state.drag.p, { kind: 'vert', index: state.drag.p.index + 1 }); }
          else H.onVertexMoved(state.drag.p.ring, state.drag.p.index, ll);
        } else H.onStopMoved(state.drag.p.stop_id, ll, false);
      };
      const endDrag = e => {
        if (!state.drag) return;
        if (state.drag.kind === 'stop') H.onStopMoved(state.drag.p.stop_id, [e.lngLat.lng, e.lngLat.lat], true);
        else H.onVertexMoved(state.drag.p.ring, state.drag.p.index, [e.lngLat.lng, e.lngLat.lat], true);
        state.drag = null;
        map.dragPan.enable();
      };
      map.on('mousedown', e => { if (e.originalEvent.button !== 0) return; if (startDrag(e, 'vert') || startDrag(e, 'stop')) { map.on('mousemove', moveDrag); map.once('mouseup', ev => { map.off('mousemove', moveDrag); endDrag(ev); }); } });
      map.on('touchstart', e => { if (e.points.length !== 1) return; if (startDrag(e, 'vert') || startDrag(e, 'stop')) { map.on('touchmove', moveDrag); map.once('touchend', ev => { map.off('touchmove', moveDrag); endDrag(ev); }); } });
    }

    function finishDraw() {
      if (state.draft.length >= 3) { const ring = state.draft.slice(); ring.push(ring[0].slice()); H.onPolygonDone(ring); }
      state.draft = []; renderDraft(); setMode('none');
    }
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
      state.mode = m;
      map.getCanvas().style.cursor = (m === 'draw' || m === 'addStop') ? 'crosshair' : '';
      if (m === 'draw') map.doubleClickZoom.disable(); else map.doubleClickZoom.enable();
      if (m !== 'draw') { state.draft = []; renderDraft(); }
      container.dispatchEvent(new CustomEvent('modechange', { detail: m }));
    }

    // ---- データの反映 ----
    function setStops(rows, memberIds, selectedId) {
      state.memberIds = memberIds || new Set(); state.selectedStop = selectedId || null;
      const feats = [];
      for (const r of rows) {
        const lat = parseFloat(r.stop_lat), lon = parseFloat(r.stop_lon);
        if (isNaN(lat) || isNaN(lon)) continue;
        feats.push({ type: 'Feature', properties: { stop_id: r.stop_id, stop_name: r.stop_name || '', _member: state.memberIds.has(r.stop_id), _selected: r.stop_id === state.selectedStop }, geometry: { type: 'Point', coordinates: [lon, lat] } });
      }
      const src = map.getSource('stops'); if (src) src.setData({ type: 'FeatureCollection', features: feats });
      return feats;
    }
    function setLocations(fc, selectedIndex) {
      state.selectedFeature = selectedIndex == null ? -1 : selectedIndex;
      const feats = ((fc && fc.features) || []).map((f, i) => ({ type: 'Feature', properties: Object.assign({}, f.properties || {}, { _id: f.id, _index: i, _selected: i === state.selectedFeature }), geometry: f.geometry }));
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
          feats.push({ type: 'Feature', properties: { kind: 'vert', ring: ri, index: i }, geometry: { type: 'Point', coordinates: ring[i] } });
          const a = ring[i], b = ring[i + 1];
          feats.push({ type: 'Feature', properties: { kind: 'mid', ring: ri, index: i }, geometry: { type: 'Point', coordinates: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] } });
        }
      });
      src.setData({ type: 'FeatureCollection', features: feats });
    }
    function fitTo(feats) {
      const b = new maplibregl.LngLatBounds();
      let n = 0;
      const walk = c => { if (typeof c[0] === 'number') { b.extend(c); n++; } else c.forEach(walk); };
      for (const f of feats) if (f && f.geometry) walk(f.geometry.coordinates);
      if (n) map.fitBounds(b, { padding: 60, maxZoom: 15, duration: 600 });
    }

    // ---- 右下のボタン（方角・現在地・拡大・縮小）----
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

    return { map, state, setMode, setStops, setLocations, fitTo, finishDraw, getMode: () => state.mode };
  }

  window.FlexMap = { create };
})();
