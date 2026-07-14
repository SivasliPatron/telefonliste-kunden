import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import pg from "pg";

const { Pool } = pg;
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

export class PostgresStore {
  constructor(connectionString) {
    const isLocal = /(?:localhost|127\.0\.0\.1)/i.test(connectionString);
    this.pool = new Pool({
      connectionString,
      ssl: isLocal ? false : { rejectUnauthorized: false },
      max: 5,
    });
  }

  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS phonebook_contacts (
        contact_id VARCHAR(20) PRIMARY KEY,
        phone VARCHAR(80) NOT NULL DEFAULT '',
        owner VARCHAR(16) NOT NULL DEFAULT 'open',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT phonebook_owner_check
          CHECK (owner IN ('open', 'semih', 'tural', 'ramil'))
      )
    `);
  }

  async ping() {
    await this.pool.query("SELECT 1");
  }

  async getAll() {
    const result = await this.pool.query(`
      SELECT
        contact_id AS "contactId",
        phone,
        owner,
        updated_at AS "updatedAt"
      FROM phonebook_contacts
      ORDER BY contact_id
    `);
    return result.rows;
  }

  async upsert(input) {
    const record = normalizeRecord(input);
    const result = await this.pool.query(
      `
        INSERT INTO phonebook_contacts (contact_id, phone, owner, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (contact_id) DO UPDATE SET
          phone = EXCLUDED.phone,
          owner = EXCLUDED.owner,
          updated_at = NOW()
        RETURNING
          contact_id AS "contactId",
          phone,
          owner,
          updated_at AS "updatedAt"
      `,
      [record.contactId, record.phone, record.owner],
    );
    return result.rows[0];
  }

  async sync(inputs, { overwrite }) {
    const records = inputs.map((input) => normalizeRecord(input));
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const record of records) {
        if (overwrite) {
          await client.query(
            `
              INSERT INTO phonebook_contacts (contact_id, phone, owner, updated_at)
              VALUES ($1, $2, $3, NOW())
              ON CONFLICT (contact_id) DO UPDATE SET
                phone = EXCLUDED.phone,
                owner = EXCLUDED.owner,
                updated_at = NOW()
            `,
            [record.contactId, record.phone, record.owner],
          );
        } else {
          await client.query(
            `
              INSERT INTO phonebook_contacts (contact_id, phone, owner, updated_at)
              VALUES ($1, $2, $3, NOW())
              ON CONFLICT (contact_id) DO NOTHING
            `,
            [record.contactId, record.phone, record.owner],
          );
        }
      }
      await client.query("COMMIT");
      return records.length;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
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
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");

  const store = new PostgresStore(connectionString);
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
