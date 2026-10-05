// Media blob storage. OPFS when available (streamable, huge capacity),
// IndexedDB as a fallback. Same API either way.
//
//   saveFile(key, fileOrBlob)  -> void
//   getFile(key)               -> Blob | null
//   getStream(key)             -> ReadableStream | null   (OPFS only)
//   deleteFile(key)            -> void
//   listFiles()                -> string[]                (keys)
//   usage()                    -> { engine, count }

import { kvGet, kvSet, kvDelete } from './idb-kv.js';

const STORE = 'audio';
const IDB_NAME = 'musync-files';
const IDB_VERSION = 1;
const OPFS_DIR = 'musync-media';

// ---------- OPFS ----------
async function opfsRoot() {
  if (!navigator.storage?.getDirectory) return null;
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(OPFS_DIR, { create: true });
  } catch {
    return null;
  }
}

function opfsName(key) {
  // sanitize: keys are generated ids, but be safe
  return String(key).replace(/[^a-zA-Z0-9_-]/g, '_') + '.bin';
}

// ---------- IndexedDB ----------
let idbPromise = null;
function idbOpen() {
  if (idbPromise) return idbPromise;
  idbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return idbPromise;
}

async function idbPut(key, blob) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(blob, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbKeys() {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAllKeys();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

// ---------- public API ----------
export async function saveFile(key, fileOrBlob) {
  const dir = await opfsRoot();
  if (dir) {
    const fh = await dir.getFileHandle(opfsName(key), { create: true });
    const w = await fh.createWritable();
    await w.write(fileOrBlob);
    await w.close();
    return;
  }
  await idbPut(key, fileOrBlob);
}

export async function getFile(key) {
  const dir = await opfsRoot();
  if (dir) {
    try {
      const fh = await dir.getFileHandle(opfsName(key));
      return await fh.getFile();
    } catch {
      return null;
    }
  }
  return await idbGet(key);
}

export async function getStream(key) {
  const file = await getFile(key);
  return file ? file.stream() : null;
}

export async function deleteFile(key) {
  const dir = await opfsRoot();
  if (dir) {
    try { await dir.removeEntry(opfsName(key)); } catch {}
    // also clean up any stale IDB copy just in case
    try { await idbDelete(key); } catch {}
    return;
  }
  await idbDelete(key);
}

export async function listFiles() {
  const dir = await opfsRoot();
  if (dir) {
    const out = [];
    for await (const [name] of dir.entries()) {
      out.push(name.replace(/\.bin$/, ''));
    }
    return out;
  }
  return await idbKeys();
}

export async function usage() {
  const dir = await opfsRoot();
  const keys = await listFiles();
  return { engine: dir ? 'opfs' : 'indexeddb', count: keys.length };
}
