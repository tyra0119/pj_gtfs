// ブラウザ内（IndexedDB）への自動保存。zip の書き出しとは別に、作業中のデータを数秒ごとに残す。
(function () {
  'use strict';
  const DB = 'gtfs-flex-tool', STORE = 'autosave', KEY = 'current';

  function open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => { r.result.createObjectStore(STORE); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function save(obj) {
    const db = await open();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(obj, KEY);
      tx.oncomplete = () => { db.close(); res(); };
      tx.onerror = () => { db.close(); rej(tx.error); };
    });
  }
  async function load() {
    const db = await open();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readonly');
      const q = tx.objectStore(STORE).get(KEY);
      q.onsuccess = () => { db.close(); res(q.result || null); };
      q.onerror = () => { db.close(); rej(q.error); };
    });
  }
  async function clear() {
    const db = await open();
    return new Promise((res) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).delete(KEY); tx.oncomplete = () => { db.close(); res(); }; });
  }

  // 変更があってから delay ms 後に保存。保存中にさらに変更があれば、また後で。
  function autosaver(getData, onSaved, delay) {
    let timer = null, pending = false, saving = false;
    async function flush() {
      timer = null;
      if (saving) { pending = true; return; }
      saving = true;
      try { const d = getData(); if (d) { await save(d); onSaved(new Date(), null); } }
      catch (e) { onSaved(null, e); }
      saving = false;
      if (pending) { pending = false; schedule(); }
    }
    function schedule() { if (timer) clearTimeout(timer); timer = setTimeout(flush, delay || 3000); }
    return { schedule, flush };
  }

  window.FlexStore = { save, load, clear, autosaver };
})();
