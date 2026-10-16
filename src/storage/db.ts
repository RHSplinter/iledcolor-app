import { DEFAULT_SETTINGS, validateSettings, type Preset, type Settings } from './presets';
import type { ApproachSettings } from '../approach/tiers';

const DB_NAME = 'iledcolor';
const DB_VERSION = 1;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('presets', { keyPath: 'id' });
      db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error(`Storage unavailable: ${req.error?.message ?? 'unknown error'}`));
    req.onblocked = () => reject(new Error('Storage is blocked by another tab.'));
  });
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return open().then((db) => new Promise<T | undefined>((resolve, reject) => {
    const t = db.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => { db.close(); resolve(r ? (r as IDBRequest<T>).result : undefined); };
    const fail = () => {
      db.close();
      const e = t.error;
      reject(new Error(e?.name === 'QuotaExceededError'
        ? 'Storage is full. Export your presets, free space, then try again.'
        : `Storage error: ${e?.message ?? 'unknown'}`));
    };
    t.onerror = fail;
    t.onabort = fail;
  }));
}

export async function listPresets(): Promise<Preset[]> {
  const all = (await tx<Preset[]>('presets', 'readonly', (s) => s.getAll())) ?? [];
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}
export const savePreset = (p: Preset) => tx('presets', 'readwrite', (s) => { s.put(p); }).then(() => undefined);
export const deletePreset = (id: string) => tx('presets', 'readwrite', (s) => { s.delete(id); }).then(() => undefined);

export async function replaceAllPresets(presets: Preset[]): Promise<void> {
  await tx('presets', 'readwrite', (s) => { s.clear(); presets.forEach((p) => s.put(p)); });
}

/** Commit a validated import together so a storage failure cannot apply only part of it. */
export async function restoreBackup(presets: Preset[], settings?: Settings, approach?: ApproachSettings): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(['presets', 'kv'], 'readwrite');
      t.oncomplete = () => resolve();
      t.onabort = () => reject(new Error(`Import could not be saved: ${t.error?.message ?? 'storage transaction aborted'}`));
      t.onerror = () => reject(new Error(`Import could not be saved: ${t.error?.message ?? 'storage error'}`));
      try {
        const store = t.objectStore('presets');
        store.clear();
        presets.forEach((p) => store.put(p));
        if (settings) t.objectStore('kv').put(settings, 'settings');
        if (approach) t.objectStore('kv').put(approach, 'approach');
      } catch (e) {
        t.abort();
        reject(new Error(`Import could not be saved: ${(e as Error).message}`));
      }
    });
  } finally { db.close(); }
}

export async function loadSettings(): Promise<Settings> {
  const raw = await tx<unknown>('kv', 'readonly', (s) => s.get('settings'));
  if (raw === undefined) return DEFAULT_SETTINGS;
  try { return validateSettings(raw); } catch { return DEFAULT_SETTINGS; }
}
export const saveSettings = (s: Settings) => tx('kv', 'readwrite', (st) => { st.put(s, 'settings'); }).then(() => undefined);

/** Untyped key-value access for feature settings that validate themselves (e.g. approach mode). */
export const loadKv = (key: string) => tx<unknown>('kv', 'readonly', (s) => s.get(key));
export const saveKv = (key: string, value: unknown) => tx('kv', 'readwrite', (st) => { st.put(value, key); }).then(() => undefined);

/** Ask the browser not to evict our data; harmless if unsupported. */
export async function requestPersistence(): Promise<boolean> {
  try { return (await navigator.storage?.persist?.()) ?? false; } catch { return false; }
}
