import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { createApp, normalizeRecord, SQLiteStore } from "../server.js";

class MemoryStore {
  constructor() {
    this.records = new Map();
  }

  async ping() {}

  async getAll() {
    return [...this.records.values()];
  }

  async upsert(record) {
    const saved = { ...record, updatedAt: new Date().toISOString() };
    this.records.set(record.contactId, saved);
    return saved;
  }

  async sync(records, { overwrite }) {
    for (const record of records.map((item) => normalizeRecord(item))) {
      if (overwrite || !this.records.has(record.contactId)) await this.upsert(record);
    }
    return records.length;
  }
}

const store = new MemoryStore();
const app = createApp({ store });
let server;
let baseUrl;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test("health endpoint is available", async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("a phone number is saved and returned in shared state", async () => {
  const saveResponse = await fetch(`${baseUrl}/api/contacts/1008`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: "+49 170 1234567", owner: "semih" }),
  });
  assert.equal(saveResponse.status, 200);
  const saved = await saveResponse.json();
  assert.equal(saved.record.phone, "+49 170 1234567");

  const stateResponse = await fetch(`${baseUrl}/api/state`);
  const state = await stateResponse.json();
  assert.equal(state.records[0].contactId, "1008");
  assert.equal(state.records[0].owner, "semih");
});

test("invalid contact updates are rejected", async () => {
  const response = await fetch(`${baseUrl}/api/contacts/not-a-number`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: "keine nummer", owner: "open" }),
  });
  assert.equal(response.status, 400);
});

test("legacy sync does not overwrite an existing shared value", async () => {
  const response = await fetch(`${baseUrl}/api/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      overwrite: false,
      records: [{ contactId: "1008", phone: "999", owner: "ramil" }],
    }),
  });
  assert.equal(response.status, 200);

  const state = await (await fetch(`${baseUrl}/api/state`)).json();
  assert.equal(state.records[0].phone, "+49 170 1234567");
  assert.equal(state.records[0].owner, "semih");
});

test("SQLite keeps phone numbers after the store is reopened", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "telefonliste-"));
  const databasePath = path.join(directory, "phonebook.sqlite");
  try {
    const firstStore = new SQLiteStore(databasePath);
    await firstStore.init();
    await firstStore.upsert({ contactId: "1671", phone: "0171 5551234", owner: "tural" });
    await firstStore.close();

    const reopenedStore = new SQLiteStore(databasePath);
    await reopenedStore.init();
    const records = await reopenedStore.getAll();
    assert.equal(records.length, 1);
    assert.equal(records[0].phone, "0171 5551234");
    assert.equal(records[0].owner, "tural");
    await reopenedStore.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
