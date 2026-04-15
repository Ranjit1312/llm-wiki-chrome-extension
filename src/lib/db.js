/**
 * lib/db.js — IndexedDB wrapper
 *
 * Object stores:
 *  - chunks       : { id, text, source, chunkIndex }
 *  - triplets     : { id, source, rel, target, type, chunkId }
 *  - embeddings   : { id, entityName, vector: Float32Array, communityId }
 *  - perspectives : { id, label, entities[], topEntities[] }
 *  - modelMeta    : { id, name, totalBytes, storedBytes, complete }
 *  - modelChunks  : { id, modelName, chunkIndex, data: ArrayBuffer }
 */

const DB_NAME    = 'llm-wiki-db';
const DB_VERSION = 1;

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
      if (!db.objectStoreNames.contains('perspectives')) {
        db.createObjectStore('perspectives', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('modelMeta')) {
        db.createObjectStore('modelMeta', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('modelChunks')) {
        const mcs = db.createObjectStore('modelChunks', { keyPath: 'id', autoIncrement: true });
        mcs.createIndex('modelName_chunkIndex', ['modelName', 'chunkIndex'], { unique: true });
      }
    };

    req.onsuccess  = (e) => { _db = e.target.result; resolve(_db); };
    req.onerror    = (e) => reject(e.target.error);
  });
}

// ─── Generic helpers ──────────────────────────────────────────────────────────
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
  const store = await tx(storeName);
  return req2promise(store.getAll());
}

async function putRecord(storeName, record) {
  const store = await tx(storeName, 'readwrite');
  return req2promise(store.put(record));
}

async function bulkPut(storeName, records) {
  const db   = await openDB();
  const txn  = db.transaction(storeName, 'readwrite');
  const store = txn.objectStore(storeName);
  return new Promise((resolve, reject) => {
    let count = 0;
    records.forEach((r) => {
      const req = store.put(r);
      req.onerror = (e) => reject(e.target.error);
      req.onsuccess = () => { if (++count === records.length) resolve(count); };
    });
    if (!records.length) resolve(0);
  });
}

async function clearStore(storeName) {
  const store = await tx(storeName, 'readwrite');
  return req2promise(store.clear());
}

// ─── Domain-specific API ──────────────────────────────────────────────────────

/** Chunks ------------------------------------------------------------------- */
export async function saveChunks(chunks) {
  await clearStore('chunks');
  return bulkPut('chunks', chunks);
}
export const getChunks = () => getAll('chunks');

/** Triplets ----------------------------------------------------------------- */
export async function saveTriplets(triplets) {
  await clearStore('triplets');
  return bulkPut('triplets', triplets);
}
export const getTriplets = () => getAll('triplets');

/** Embeddings --------------------------------------------------------------- */
export async function saveEmbeddings(embeddings) {
  // embeddings: [{ entityName, vector: Float32Array, communityId }]
  await clearStore('embeddings');
  return bulkPut('embeddings', embeddings);
}
export const getEmbeddings = () => getAll('embeddings');

export async function getEmbeddingsByCommunity(communityId) {
  const db   = await openDB();
  const txn  = db.transaction('embeddings', 'readonly');
  const idx  = txn.objectStore('embeddings').index('communityId');
  return req2promise(idx.getAll(communityId));
}

/** Perspectives ------------------------------------------------------------- */
export async function savePerspectives(perspectives) {
  await clearStore('perspectives');
  return bulkPut('perspectives', perspectives);
}
export const getPerspectives = () => getAll('perspectives');

/** Model caching ------------------------------------------------------------ */
const MODEL_CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB per IDB record

export async function isModelCached(modelId) {
  const store = await tx('modelMeta');
  const meta  = await req2promise(store.get(modelId));
  return meta?.complete === true;
}

export async function getModelBuffer(modelId) {
  const db     = await openDB();
  const txn    = db.transaction('modelChunks', 'readonly');
  const idx    = txn.objectStore('modelChunks').index('modelName_chunkIndex');
  // Iterate all chunks ordered by chunkIndex
  return new Promise((resolve, reject) => {
    const chunks = [];
    const range  = IDBKeyRange.bound([modelId, 0], [modelId, Infinity]);
    const cursor = idx.openCursor(range);
    cursor.onsuccess = (e) => {
      const c = e.target.result;
      if (c) { chunks.push(c.value.data); c.continue(); }
      else {
        const total  = chunks.reduce((s, c) => s + c.byteLength, 0);
        const merged = new Uint8Array(total);
        let offset   = 0;
        chunks.forEach((c) => { merged.set(new Uint8Array(c), offset); offset += c.byteLength; });
        resolve(merged.buffer);
      }
    };
    cursor.onerror = (e) => reject(e.target.error);
  });
}

export async function streamModelToCache(modelId, modelName, totalBytes, fetchUrl, onProgress) {
  const resp   = await fetch(fetchUrl);
  const reader = resp.body.getReader();
  const db     = await openDB();

  let chunkIndex = 0;
  let received   = 0;
  let buffer     = new Uint8Array(0);

  const flush = async (data) => {
    const txn   = db.transaction('modelChunks', 'readwrite');
    const store = txn.objectStore('modelChunks');
    await req2promise(store.put({ modelName, chunkIndex, data: data.buffer }));
    chunkIndex++;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    onProgress?.(received, totalBytes);

    // Accumulate into buffer
    const merged = new Uint8Array(buffer.length + value.length);
    merged.set(buffer);
    merged.set(value, buffer.length);
    buffer = merged;

    // Flush when buffer exceeds chunk size
    while (buffer.length >= MODEL_CHUNK_SIZE) {
      await flush(buffer.slice(0, MODEL_CHUNK_SIZE));
      buffer = buffer.slice(MODEL_CHUNK_SIZE);
    }
  }

  // Flush remaining
  if (buffer.length > 0) await flush(buffer);

  // Mark complete
  await putRecord('modelMeta', { id: modelId, name: modelName, totalBytes, storedBytes: received, complete: true });
}
