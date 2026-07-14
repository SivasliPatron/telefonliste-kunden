import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("the GitHub client points to the shared JustRunMyApp API", async () => {
  const config = await readFile(new URL("../config.js", import.meta.url), "utf8");
  assert.match(config, /https:\/\/telefonliste-kunden\.f\.jrnm\.app/);
});

test("configuration loads before the phonebook application", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.ok(html.indexOf('src="config.js?') < html.indexOf('src="app.js?'));
  assert.match(html, /id="syncStatus"/);
  assert.match(html, /id="saveButton"/);
  assert.match(html, /id="contactPickerButton"/);
});

test("saving waits for the shared API and reports failures", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(app, /await requestJson\(`\/api\/contacts\//);
  assert.match(app, /Telefonnummer online gespeichert/);
  assert.match(app, /Nicht gespeichert\. Bitte erneut versuchen\./);
});

test("a customer click can open the system contact picker", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(app, /navigator\.contacts\.select\(\["name", "tel"\]/);
  assert.match(app, /const openPicker = Boolean\(contact && !isComplete\(contact\)/);
  assert.match(app, /Nummer von \$\{contactName\} übernommen/);
});

test("Safari falls back to pasting a copied phone number", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(app, /navigator\.clipboard\.readText\(\)/);
  assert.match(app, /supportsContactPicker\(\) \? "Kontakte" : "Einfügen"/);
  assert.match(app, /await pastePhoneFromClipboard\(\)/);
});
