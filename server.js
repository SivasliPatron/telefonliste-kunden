import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import express from "express";

const currentFile = fileURLToPath(import.meta.url);
const currentDirectory = path.dirname(currentFile);
const validOwners = new Set(["open", "semih", "tural", "ramil"]);
const publicFiles = [
  "styles.css",
  "app.js",
  "config.js",
  "contacts.js",
  "assignments.js",
];

export class InputError extends Error {}

export function normalizeRecord(input, contactIdOverride) {
  const contactId = String(contactIdOverride ?? input?.contactId ?? input?.id ?? "").trim();
  const phone = String(input?.phone ?? "").trim();
  const owner = String(input?.owner ?? "open").trim().toLowerCase();

  if (!/^\d{1,20}$/.test(contactId)) {
    throw new InputError("Ungültige Kundennummer");
  }
  if (phone.length > 80 || (phone && !/\d/.test(phone))) {
    throw new InputError("Ungültige Telefonnummer");
  }
  if (!validOwners.has(owner)) {
    throw new InputError("Ungültige Zuständigkeit");
  }

  return { contactId, phone, owner };
}

export class SQLiteStore {
  constructor(databasePath) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA busy_timeout = 5000");
  }

  async init() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS phonebook_contacts (
        contact_id TEXT PRIMARY KEY,
        phone TEXT NOT NULL DEFAULT '',
        owner TEXT NOT NULL DEFAULT 'open'
          CHECK (owner IN ('open', 'semih', 'tural', 'ramil')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )
    `);
  }

  async ping() {
    this.database.prepare("SELECT 1").get();
  }

  async getAll() {
    return this.database.prepare(`
      SELECT
        contact_id AS "contactId",
        phone,
        owner,
        updated_at AS "updatedAt"
      FROM phonebook_contacts
      ORDER BY contact_id
    `).all();
  }

  async upsert(input) {
    const record = normalizeRecord(input);
    this.database.prepare(`
      INSERT INTO phonebook_contacts (contact_id, phone, owner, updated_at)
      VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT (contact_id) DO UPDATE SET
        phone = excluded.phone,
        owner = excluded.owner,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    `).run(record.contactId, record.phone, record.owner);
    return this.database.prepare(`
      SELECT
        contact_id AS "contactId",
        phone,
        owner,
        updated_at AS "updatedAt"
      FROM phonebook_contacts
      WHERE contact_id = ?
    `).get(record.contactId);
  }

  async sync(inputs, { overwrite }) {
    const records = inputs.map((input) => normalizeRecord(input));
    const statement = this.database.prepare(
      overwrite
        ? `
            INSERT INTO phonebook_contacts (contact_id, phone, owner, updated_at)
            VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            ON CONFLICT (contact_id) DO UPDATE SET
              phone = excluded.phone,
              owner = excluded.owner,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          `
        : `
            INSERT INTO phonebook_contacts (contact_id, phone, owner, updated_at)
            VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            ON CONFLICT (contact_id) DO NOTHING
          `,
    );
    try {
      this.database.exec("BEGIN IMMEDIATE");
      for (const record of records) {
        statement.run(record.contactId, record.phone, record.owner);
      }
      this.database.exec("COMMIT");
      return records.length;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async close() {
    this.database.close();
  }
}

function configuredOrigins() {
  return new Set(
    String(process.env.CORS_ORIGINS || "https://sivaslipatron.github.io")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}

export function createApp({ store, siteRoot = currentDirectory } = {}) {
  if (!store) throw new Error("A store is required");

  const app = express();
  const allowedOrigins = configuredOrigins();
  app.disable("x-powered-by");

  app.use((request, response, next) => {
    response.set("X-Content-Type-Options", "nosniff");
    response.set("Referrer-Policy", "no-referrer");
    const origin = request.get("Origin");
    if (origin && allowedOrigins.has(origin)) {
      response.set("Access-Control-Allow-Origin", origin);
      response.set("Vary", "Origin");
      response.set("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
      response.set("Access-Control-Allow-Headers", "Content-Type, Accept");
    }
    if (request.method === "OPTIONS") return response.sendStatus(204);
    next();
  });

  app.use("/api", express.json({ limit: "1mb" }));

  app.get("/api/health", async (_request, response, next) => {
    try {
      await store.ping();
      response.set("Cache-Control", "no-store").json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/state", async (_request, response, next) => {
    try {
      const records = await store.getAll();
      response.set("Cache-Control", "no-store").json({
        version: 2,
        fetchedAt: new Date().toISOString(),
        records,
      });
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/contacts/:contactId", async (request, response, next) => {
    try {
      const record = normalizeRecord(request.body, request.params.contactId);
      const saved = await store.upsert(record);
      response.set("Cache-Control", "no-store").json({ record: saved });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/sync", async (request, response, next) => {
    try {
      const records = request.body?.records;
      if (!Array.isArray(records) || records.length > 1000) {
        throw new InputError("Ungültige Synchronisierungsdaten");
      }
      const processed = await store.sync(records, { overwrite: request.body?.overwrite === true });
      response.set("Cache-Control", "no-store").json({ processed });
    } catch (error) {
      next(error);
    }
  });

  app.get(["/", "/index.html"], (_request, response) => {
    response.set("Cache-Control", "no-cache");
    response.sendFile(path.join(siteRoot, "index.html"));
  });

  for (const fileName of publicFiles) {
    app.get(`/${fileName}`, (_request, response) => {
      const cacheControl = fileName === "config.js" ? "no-cache" : "public, max-age=300";
      response.set("Cache-Control", cacheControl);
      response.sendFile(path.join(siteRoot, fileName));
    });
  }

  app.use((error, _request, response, _next) => {
    if (error instanceof InputError || error?.type === "entity.parse.failed") {
      return response.status(400).json({ error: error.message || "Ungültige Anfrage" });
    }
    console.error(error);
    response.status(500).json({ error: "Speichern derzeit nicht möglich" });
  });

  return app;
}

export async function startServer() {
  const databasePath = process.env.DATABASE_PATH || path.join(currentDirectory, "data", "phonebook.sqlite");
  const store = new SQLiteStore(databasePath);
  await store.init();
  const app = createApp({ store });
  const port = Number(process.env.PORT || 10000);
  const server = app.listen(port, "0.0.0.0", () => {
    console.log(`Telefonliste listening on port ${port}`);
  });

  const shutdown = async () => {
    server.close();
    await store.close();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  startServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
