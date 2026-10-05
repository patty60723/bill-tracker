// IndexedDB:所有資料(含照片)只存在這支手機的瀏覽器裡。
// stores: templates(固定繳費)、bills(每期帳單)、files(繳費單照片、繳費證明)、
//         meta(雜項狀態,例如上次通知了什麼)
// 這個檔案也會在 service worker 裡用(背景通知),所以不能碰 DOM。

const DB_NAME = 'bill-tracker';
const VERSION = 2;
let dbPromise;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (e.oldVersion < 1) {
        db.createObjectStore('templates', { keyPath: 'id' });
        const bills = db.createObjectStore('bills', { keyPath: 'id' });
        bills.createIndex('period', 'period');
        db.createObjectStore('files', { keyPath: 'id' });
      }
      if (e.oldVersion < 2) db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => {
      // 另一個分頁 / service worker 要升級資料庫時,讓出連線
      req.result.onversionchange = () => {
        req.result.close();
        dbPromise = undefined;
      };
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name, mode = 'readonly') {
  return (await open()).transaction(name, mode).objectStore(name);
}

export const uid = () => (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export const getAll = async (name) => wrap((await store(name)).getAll());
export const get = async (name, id) => wrap((await store(name)).get(id));
export const put = async (name, value) => wrap((await store(name, 'readwrite')).put(value));
export const del = async (name, id) => wrap((await store(name, 'readwrite')).delete(id));
export const clear = async (name) => wrap((await store(name, 'readwrite')).clear());
export const getMeta = async (key) => (await get('meta', key))?.value;
export const setMeta = (key, value) => put('meta', { key, value });

export async function saveFile(blob, name = '') {
  const id = uid();
  await put('files', { id, blob, name, type: blob.type, createdAt: new Date().toISOString() });
  return id;
}

/** 刪帳單時順便把它的照片、證明一起刪掉。 */
export async function deleteBill(bill) {
  for (const id of [...(bill.billFiles || []), ...(bill.proofFiles || [])]) await del('files', id);
  await del('bills', bill.id);
}

const blobToDataURL = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

/** 完整備份(含照片)成一個 JSON。 */
export async function exportAll() {
  const files = await Promise.all((await getAll('files')).map(async (f) => ({
    ...f, blob: undefined, dataURL: await blobToDataURL(f.blob),
  })));
  return {
    app: 'bill-tracker', version: 1, exportedAt: new Date().toISOString(),
    templates: await getAll('templates'), bills: await getAll('bills'), files,
  };
}

export async function importAll(data) {
  if (data?.app !== 'bill-tracker') throw new Error('不是這個 app 的備份檔');
  for (const name of ['templates', 'bills', 'files']) await clear(name);
  for (const t of data.templates || []) await put('templates', t);
  for (const b of data.bills || []) await put('bills', b);
  for (const f of data.files || []) {
    const blob = await (await fetch(f.dataURL)).blob();
    const { dataURL, ...rest } = f;
    await put('files', { ...rest, blob });
  }
}
