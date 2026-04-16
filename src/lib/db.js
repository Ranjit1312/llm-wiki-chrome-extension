/**
 * lib/db.js -- IndexedDB wrapper
 *
 * Object stores:
 *  - chunks       : { id, text, source, chunkIndex }
 *  - triplets     : { id, source, rel, target, type, chunkId }
 *  - embeddings   : { id, entityName, vector: Float32Array, communityId }
 *  - perspectives : { id, label, entities[], topEntities[] }
 *  - modelMeta    : { id, name, totalBytes, storedBytes, complete }
 *  - modelChunks  : { id, modelName, chunkIndex, data: ArrayBuffer }
 *  - handles      : { key, handle }  -- FileSystemHandle storage (v2)
 */

const DB_NAME    = 'llm-wiki-db';
const DB_VERSION = 2;

let _db = null;

export function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('chunks')) {
        const cs = db.createObjectStore('chunks', { keyPath: 'id', autoIncrement: true });
        cs.createIndex('source', 'source');
      }
      if (!db.objectStoreNames.contains('triplets')) {
        const ts = db.createObjectStore('triplets', { keyPath: 'id', autoIncrement: true });
        ts.createIndex('source', 'source');
        ts.createIndex('type', 'type');
      }
      if (!db.objectStoreNames.contains('embeddings')) {
        const es = db.createObjectStore('embeddings', { keyPath: 'id', autoIncrement: true });
        es.createIndex('entityName', 'entityName', { unique: true });
        es.createIndex('communityId', 'communityId');
      }
      if (!db.objectStoreNames.contains('perspectives'))
        db.createObjectStore('perspectives', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('modelMeta'))
        db.createObjectStore('modelMeta', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('modelChunks')) {
        const mcs = db.createObjectStore('modelChunks', { keyPath: 'id', autoIncrement: true });
        mcs.createIndex('modelName_chunkIndex', ['modelName', 'chunkIndex'], { unique: true });
      }
      if (!db.objectStoreNames.contains('handles'))
        db.createObjectStore('handles', { keyPath: 'key' });
    };
    req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
    req.onerror   = (e) => reject(e.target.error);
  });
}

function tx(storeName, mode = 'readonly') {
  return openDB().then((db) => db.transaction(storeName, mode).objectStore(storeName));
}
function req2promise(idbReq) {
  return new Promise((resolve, reject) => {
    idbReq.onsuccess = (e) => resolve(e.target.result);
    idbReq.onerror   = (e) => reject(e.target.error);
  });
}
async function getAll(storeName) {
  return req2promise((await tx(storeName)).getAll());
}
async function putRecord(storeName, record) {
  return req2promise((await tx(storeName, 'readwrite')).put(record));
}
async function bulkPut(storeName, records) {
  const db    = await openDB();
  const store = db.transaction(storeName, 'readwrite').objectStore(storeName);
  return new Promise((resolve, reject) => {
    let count = 0;
    records.forEach((r) => {
      const req = store.put(r);
      req.onerror   = (e) => reject(e.target.error);
      req.onsuccess = () => { if (++count === records.length) resolve(count); };
    });
    if (!records.length) resolve(0);
  });
}
async function clearStore(storeName) {
  return req2promise((await tx(storeName, 'readwrite')).clear());
}

export async function saveChunks(chunks)       { await clearStore('chunks');       return bulkPut('chunks', chunks); }
export const getChunks = () => getAll('chunks');

export async function saveTriplets(triplets)   { await clearStore('triplets');     return bulkPut('triplets', triplets); }
export const getTriplets = () => getAll('triplets');

export async function saveEmbeddings(embeddings) { await clearStore('embeddings'); return bulkPut('embeddings', embeddings); }
export const getEmbeddings = () => getAll('embeddings');

export async function getEmbeddingsByCommunity(communityId) {
  const db  = await openDB();
  const idx = db.transaction('embeddings','readonly').objectStore('embeddings').index('communityId');
  return req2promise(idx.getAll(communityId));
}

export async function savePerspectives(perspectives) { await clearStore('perspectives'); return bulkPut('perspectives', perspectives); }
export const getPerspectives = () => getAll('perspectives');

/** FileSystemHandle storage -- structured-clone OK, JSON NOT OK */
export async function saveHandle(key, handle) { return putRecord('handles', { key, handle }); }
export async function loadHandle(key) {
  const store  = await tx('handles');
  const record = await req2promise(store.get(key));
  if (!record) return null;
  const perm = await record.handle.queryPermission({ mode: 'read' });
  if (perm === 'granted') return record.handle;
  const result = await record.handle.requestPermission({ mode: 'read' });
  return result === 'granted' ? record.handle : null;
}
export async function clearHandle(key) {
  return req2promise((await tx('handles','readwrite')).delete(key));
}

/** Model caching */
const CHUNK = 4 * 1024 * 1024; // 4 MB

export async function isModelCached(modelId) {
  const meta = await req2promise((await tx('modelMeta')).get(modelId));
  return meta?.complete === true;
}

export async function getModelBuffer(modelId) {
  const db  = await openDB();
  const idx = db.transaction('modelChunks','readonly').objectStore('modelChunks').index('modelName_chunkIndex');
  return new Promise((resolve, reject) => {
    const parts = [];
    const range = IDBKeyRange.bound([modelId,0],[modelId,Infinity]);
    const cur   = idx.openCursor(range);
    cur.onsuccess = (e) => {
      const c = e.target.result;
      if (c) { parts.push(c.value.data); c.continue(); }
      else {
        const total  = parts.reduce((s,p) => s + p.byteLength, 0);
        const merged = new Uint8Array(total);
        let off = 0;
        parts.forEach((p) => { merged.set(new Uint8Array(p), off); off += p.byteLength; });
        resolve(merged.buffer);
      }
    };
    cur.onerror = (e) => reject(e.target.error);
  });
}

async function _flushChunk(db, modelName, chunkIndex, data) {
  await req2promise(
    db.transaction('modelChunks','readwrite').objectStore('modelChunks')
      .put({ modelName, chunkIndex, data: data.buffer })
  );
}

async function _streamReader(reader, db, modelId, totalBytes, onProgress) {
  let idx = 0, received = 0, buf = new Uint8Array(0);
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    onProgress?.(received, totalBytes);
    const m = new Uint8Array(buf.length + value.length);
    m.set(buf); m.set(value, buf.length);
    buf = m;
    while (buf.length >= CHUNK) {
      await _flushChunk(db, modelId, idx++, buf.slice(0, CHUNK));
      buf = buf.slice(CHUNK);
    }
  }
  if (buf.length > 0) await _flushChunk(db, modelId, idx, buf);
  return received;
}

/** Download from URL and cache into IDB.
 *  If totalBytes is 0 the Content-Length response header is used automatically. */
export async function streamModelToCache(modelId, modelName, totalBytes, fetchUrl, onProgress) {
  const resp  = await fetch(fetchUrl);
  if (!resp.ok) throw new Error(`Fetch failed: ${resp.status} ${resp.statusText}`);
  const total = totalBytes || Number(resp.headers.get('content-length') || 0);
  const db    = await openDB();
  const recv  = await _streamReader(resp.body.getReader(), db, modelId, total, onProgress);
  await putRecord('modelMeta', { id: modelId, name: modelName, totalBytes: total, storedBytes: recv, complete: true });
  return { received: recv, total };
}

/** Read local File and store into IDB (no download needed) */
export async function storeModelFromFile(modelId, file, onProgress) {
  const db = await openDB();
  // Clear old chunks
  await new Promise((res, rej) => {
    const txn   = db.transaction('modelChunks','readwrite');
    const idx   = txn.objectStore('modelChunks').index('modelName_chunkIndex');
    const range = IDBKeyRange.bound([modelId,0],[modelId,Infinity]);
    const cur   = idx.openCursor(range);
    cur.onsuccess = (e) => { const c = e.target.result; if (c) { c.delete(); c.continue(); } else res(); };
    cur.onerror   = (e) => rej(e.target.error);
  });
  const recv = await _streamReader(file.stream().getReader(), db, modelId, file.size, onProgress);
  await putRecord('modelMeta', { id: modelId, name: modelId, totalBytes: file.size, storedBytes: recv, complete: true });
}

/** Stream IDB chunks directly to a FileSystemFileHandle -- no full-RAM load */
export async function streamModelToFile(modelId, fileHandle, onProgress) {
  const db       = await openDB();
  const meta     = await req2promise(db.transaction('modelMeta','readonly').objectStore('modelMeta').get(modelId));
  const total    = meta?.storedBytes ?? 0;
  const writable = await fileHandle.createWritable();
  let written    = 0;
  await new Promise((res, rej) => {
    const idx   = db.transaction('modelChunks','readonly').objectStore('modelChunks').index('modelName_chunkIndex');
    const range = IDBKeyRange.bound([modelId,0],[modelId,Infinity]);
    const cur   = idx.openCursor(range);
    cur.onsuccess = async (e) => {
      const c = e.target.result;
      if (c) {
        await writable.write(c.value.data);
        written += c.value.data.byteLength;
        onProgress?.(written, total);
        c.continue();
      } else res();
    };
    cur.onerror = (e) => rej(e.target.error);
  });
  await writable.close();
}
