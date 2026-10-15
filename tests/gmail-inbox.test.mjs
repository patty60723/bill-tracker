// tools/gmail-inbox/Code.gs(Google Apps Script)在 node 裡跑:用假的 GmailApp / PropertiesService 測它的行為。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function loadScript({ messages }) {
  const props = new Map();
  const attachment = (name, type, size) => ({ getName: () => name, getContentType: () => type, getSize: () => size, getBytes: () => [...Buffer.from(`bytes of ${name}`)] });
  const msgs = messages.map((m) => ({
    getId: () => m.id, getSubject: () => m.subject, getFrom: () => m.from, getDate: () => new Date(m.date),
    getAttachments: () => m.attachments.map((a) => attachment(...a)),
  }));
  const ctx = {
    GmailApp: {
      search: (q) => { ctx.lastQuery = q; return [{ getMessages: () => msgs }]; },
      getMessageById: (id) => msgs.find((m) => m.getId() === id) || null,
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props.get(k) ?? null, setProperty: (k, v) => props.set(k, v) }) },
    Utilities: { getUuid: () => '1234-5678', base64Encode: (bytes) => Buffer.from(bytes).toString('base64') },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ body: s, setMimeType() { return this; } }) },
    Logger: { log() {} },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(new URL('../tools/gmail-inbox/Code.gs', import.meta.url), 'utf8'), ctx);
  const call = (parameter) => JSON.parse(ctx.doGet({ parameter }).body);
  return { ctx, call };
}

test('Gmail 收件匣 Apps Script:金鑰、列出帳單附件、下載、標成已記錄', () => {
  const { ctx, call } = loadScript({
    messages: [
      { id: 'm2', subject: '電信帳單', from: 'tw <a@x>', date: '2026-10-12T01:00:00Z', attachments: [['bill.pdf', 'application/pdf', 200000]] },
      { id: 'm1', subject: '電費帳單', from: 'tp <b@x>', date: '2026-10-10T01:00:00Z', attachments: [['logo.png', 'image/png', 2000], ['e.pdf', 'application/octet-stream', 90000]] },
    ],
  });
  assert.deepEqual(call({}), { error: 'unauthorized' });
  const key = '12345678'; // getUuid 去掉「-」
  assert.equal(call({ key }).app, 'bill-tracker-inbox');
  const { items } = call({ key, action: 'list' });
  assert.match(ctx.lastQuery, /label:帳單 has:attachment newer_than:60d/);
  // 依日期由舊到新;logo(太小的圖)不算;副檔名是 .pdf 但 type 不對的也算
  assert.deepEqual(items.map((i) => i.id), ['m1:1', 'm2:0']);
  assert.equal(items[0].subject, '電費帳單');
  const file = call({ key, action: 'get', id: 'm2:0' });
  assert.equal(Buffer.from(file.data, 'base64').toString(), 'bytes of bill.pdf');
  assert.deepEqual(call({ key, action: 'ack', id: 'm1:1' }), { ok: true });
  assert.deepEqual(call({ key, action: 'list' }).items.map((i) => i.id), ['m2:0']);
  assert.match(call({ key, action: 'get', id: 'nope:0' }).error, /找不到附件/);
});
