(() => {
  "use strict";

  const contacts = Array.isArray(window.CONTACTS) ? window.CONTACTS : [];
  const cityAssignments = window.CITY_ASSIGNMENTS || {};
  const appConfig = window.APP_CONFIG || {};
  const apiBaseUrl = String(appConfig.apiBaseUrl || "").replace(/\/+$/, "");
  const storageKey = "telefonliste-v1";
  const ownerLabels = {
    open: "Offen",
    semih: "Semih",
    tural: "Tural",
    ramil: "Ramil",
    all: "Alle",
  };
  const collator = new Intl.Collator("de", { numeric: true, sensitivity: "base" });

  const elements = {
    globalProgress: document.querySelector("#globalProgress"),
    ownerTabs: [...document.querySelectorAll(".owner-tab")],
    ownerCountOpen: document.querySelector("#ownerCountOpen"),
    ownerCountSemih: document.querySelector("#ownerCountSemih"),
    ownerCountTural: document.querySelector("#ownerCountTural"),
    ownerCountRamil: document.querySelector("#ownerCountRamil"),
    ownerCountAll: document.querySelector("#ownerCountAll"),
    syncStatus: document.querySelector("#syncStatus"),
    searchInput: document.querySelector("#searchInput"),
    clearSearchButton: document.querySelector("#clearSearchButton"),
    cityFilter: document.querySelector("#cityFilter"),
    statusFilter: document.querySelector("#statusFilter"),
    listTitle: document.querySelector("#listTitle"),
    listCount: document.querySelector("#listCount"),
    contactList: document.querySelector("#contactList"),
    emptyList: document.querySelector("#emptyList"),
    editorPane: document.querySelector("#editorPane"),
    editorEmpty: document.querySelector("#editorEmpty"),
    editorForm: document.querySelector("#editorForm"),
    editorCustomerNumber: document.querySelector("#editorCustomerNumber"),
    editorName: document.querySelector("#editorName"),
    editorAddress: document.querySelector("#editorAddress"),
    editorEmail: document.querySelector("#editorEmail"),
    editorCity: document.querySelector("#editorCity"),
    phoneInput: document.querySelector("#phoneInput"),
    contactPickerButton: document.querySelector("#contactPickerButton"),
    saveButton: document.querySelector("#saveButton"),
    ownerButtons: [...document.querySelectorAll("[data-owner-value]")],
    closeEditorButton: document.querySelector("#closeEditorButton"),
    skipButton: document.querySelector("#skipButton"),
    editorBackdrop: document.querySelector("#editorBackdrop"),
    importButton: document.querySelector("#importButton"),
    importInput: document.querySelector("#importInput"),
    csvButton: document.querySelector("#csvButton"),
    backupButton: document.querySelector("#backupButton"),
    toast: document.querySelector("#toast"),
  };

  const saved = loadSavedState();
  const state = {
    activeOwner: "open",
    status: "pending",
    city: "all",
    query: "",
    selectedId: null,
    draftOwner: "open",
    phones: saved.phones,
    owners: saved.owners,
    isSaving: false,
    isPickingContact: false,
  };

  let toastTimer = null;
  let refreshPromise = null;

  function loadSavedState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(storageKey) || "{}");
      return {
        phones: parsed.phones && typeof parsed.phones === "object" ? parsed.phones : {},
        owners: parsed.owners && typeof parsed.owners === "object" ? parsed.owners : {},
      };
    } catch {
      return { phones: {}, owners: {} };
    }
  }

  function persistState() {
    try {
      localStorage.setItem(
        storageKey,
        JSON.stringify({
          version: 1,
          updatedAt: new Date().toISOString(),
          phones: state.phones,
          owners: state.owners,
        }),
      );
    } catch {
      showToast("Speichern im Browser nicht möglich");
    }
  }

  function apiUrl(path) {
    return `${apiBaseUrl}${path}`;
  }

  function setSyncStatus(status) {
    const labels = {
      connecting: "Verbinden...",
      online: "Online",
      offline: "Offline",
    };
    elements.syncStatus.textContent = labels[status] || labels.offline;
    elements.syncStatus.classList.toggle("is-connecting", status === "connecting");
    elements.syncStatus.classList.toggle("is-offline", status === "offline");
  }

  async function requestJson(path, options = {}) {
    const response = await fetch(apiUrl(path), {
      cache: "no-store",
      ...options,
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
    });
    if (!response.ok) {
      let message = `Serverfehler ${response.status}`;
      try {
        const payload = await response.json();
        if (payload.error) message = payload.error;
      } catch {
        // The status code is enough when the server did not return JSON.
      }
      throw new Error(message);
    }
    return response.json();
  }

  function recordsToState(records) {
    const phones = {};
    const owners = {};
    for (const record of Array.isArray(records) ? records : []) {
      const id = String(record.contactId || record.id || "");
      if (!id) continue;
      phones[id] = String(record.phone || "");
      owners[id] = normalizeOwner(record.owner);
    }
    return { phones, owners };
  }

  function localRecordsMissingRemotely(remote) {
    const validIds = new Set(contacts.map((contact) => contact.id));
    const localIds = new Set([...Object.keys(state.phones), ...Object.keys(state.owners)]);
    return [...localIds]
      .filter(
        (id) =>
          validIds.has(id) &&
          !Object.prototype.hasOwnProperty.call(remote.phones, id) &&
          !Object.prototype.hasOwnProperty.call(remote.owners, id),
      )
      .map((id) => ({
        contactId: id,
        phone: String(state.phones[id] || "").trim(),
        owner: normalizeOwner(state.owners[id]),
      }));
  }

  async function fetchRemoteState() {
    const payload = await requestJson("/api/state");
    return recordsToState(payload.records);
  }

  async function refreshRemoteState({ migrateLocal = false, quiet = false } = {}) {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      if (!quiet) setSyncStatus("connecting");
      try {
        let remote = await fetchRemoteState();
        const localRecords = migrateLocal ? localRecordsMissingRemotely(remote) : [];
        if (localRecords.length > 0) {
          await requestJson("/api/sync", {
            method: "POST",
            body: JSON.stringify({ records: localRecords, overwrite: false }),
          });
          remote = await fetchRemoteState();
        }

        state.phones = { ...state.phones, ...remote.phones };
        state.owners = { ...state.owners, ...remote.owners };
        persistState();
        renderAll();
        setSyncStatus("online");
        if (localRecords.length > 0) showToast("Lokale Eingaben online gesichert");
      } catch (error) {
        setSyncStatus("offline");
        if (!quiet) showToast("Server nicht erreichbar");
        console.error(error);
      } finally {
        refreshPromise = null;
      }
    })();
    return refreshPromise;
  }

  function normalizeOwner(value) {
    const normalized = String(value || "").toLowerCase();
    return ["semih", "tural", "ramil", "open"].includes(normalized)
      ? normalized
      : "open";
  }

  function getPhone(contact) {
    return Object.prototype.hasOwnProperty.call(state.phones, contact.id)
      ? String(state.phones[contact.id] || "")
      : String(contact.phone || "");
  }

  function getOwner(contact) {
    if (Object.prototype.hasOwnProperty.call(state.owners, contact.id)) {
      return normalizeOwner(state.owners[contact.id]);
    }
    return normalizeOwner(cityAssignments[contact.city]);
  }

  function isComplete(contact) {
    return getPhone(contact).trim().length > 0;
  }

  function normalizeText(value) {
    return String(value || "")
      .toLocaleLowerCase("de")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  }

  function contactSearchText(contact) {
    return normalizeText(
      [
        contact.id,
        contact.name,
        contact.street,
        contact.postalCode,
        contact.city,
        contact.email,
        getPhone(contact),
      ].join(" "),
    );
  }

  function filteredContacts({ ignoreStatus = false } = {}) {
    const query = normalizeText(state.query.trim());
    return contacts
      .filter((contact) => state.activeOwner === "all" || getOwner(contact) === state.activeOwner)
      .filter((contact) => state.city === "all" || contact.city === state.city)
      .filter((contact) => !query || contactSearchText(contact).includes(query))
      .filter((contact) => {
        if (ignoreStatus || state.status === "all") return true;
        return state.status === "done" ? isComplete(contact) : !isComplete(contact);
      })
      .sort((left, right) => {
        const cityOrder = collator.compare(left.city, right.city);
        if (cityOrder !== 0) return cityOrder;
        const nameOrder = collator.compare(left.name || left.id, right.name || right.id);
        return nameOrder !== 0 ? nameOrder : Number(left.id) - Number(right.id);
      });
  }

  function renderOwnerCounts() {
    const counts = { open: 0, semih: 0, tural: 0, ramil: 0 };
    for (const contact of contacts) counts[getOwner(contact)] += 1;
    elements.ownerCountOpen.textContent = counts.open;
    elements.ownerCountSemih.textContent = counts.semih;
    elements.ownerCountTural.textContent = counts.tural;
    elements.ownerCountRamil.textContent = counts.ramil;
    elements.ownerCountAll.textContent = contacts.length;

    for (const tab of elements.ownerTabs) {
      const active = tab.dataset.owner === state.activeOwner;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-current", active ? "page" : "false");
    }
  }

  function renderGlobalProgress() {
    const completed = contacts.filter(isComplete).length;
    elements.globalProgress.textContent = `${completed} von ${contacts.length} Telefonnummern erfasst`;
  }

  function renderCityOptions() {
    const available = contacts.filter(
      (contact) => state.activeOwner === "all" || getOwner(contact) === state.activeOwner,
    );
    const counts = new Map();
    for (const contact of available) {
      counts.set(contact.city, (counts.get(contact.city) || 0) + 1);
    }
    const cities = [...counts.keys()].sort(collator.compare);
    if (state.city !== "all" && !counts.has(state.city)) state.city = "all";

    elements.cityFilter.replaceChildren();
    const allOption = document.createElement("option");
    allOption.value = "all";
    allOption.textContent = `Alle Städte (${available.length})`;
    elements.cityFilter.append(allOption);

    for (const city of cities) {
      const option = document.createElement("option");
      option.value = city;
      option.textContent = `${city} (${counts.get(city)})`;
      elements.cityFilter.append(option);
    }
    elements.cityFilter.value = state.city;
  }

  function makeContactRow(contact) {
    const phone = getPhone(contact).trim();
    const row = document.createElement("button");
    row.type = "button";
    row.className = "contact-row";
    row.dataset.contactId = contact.id;
    row.classList.toggle("is-selected", contact.id === state.selectedId);
    row.setAttribute(
      "aria-label",
      `${contact.name || "Kontakt"}, ${contact.city}, ${phone || "Telefon offen"}`,
    );

    const status = document.createElement("span");
    status.className = `status-badge ${phone ? "is-done" : "is-pending"}`;
    status.textContent = phone ? "Erfasst" : "Offen";

    const primary = document.createElement("span");
    primary.className = "contact-primary";
    const name = document.createElement("strong");
    name.textContent = contact.name || `Kontakt ${contact.id}`;
    const meta = document.createElement("small");
    meta.textContent = `#${contact.id} · ${ownerLabels[getOwner(contact)]}`;
    primary.append(name, meta);

    const address = document.createElement("span");
    address.className = "contact-address";
    address.textContent = [contact.street, contact.postalCode].filter(Boolean).join(" · ") || "—";

    const city = document.createElement("span");
    city.className = "contact-city";
    city.textContent = contact.city;

    const phoneCell = document.createElement("span");
    phoneCell.className = `contact-phone${phone ? "" : " is-empty"}`;
    phoneCell.textContent = phone || "Nummer fehlt";

    row.append(status, primary, address, city, phoneCell);
    return row;
  }

  function renderList() {
    const visible = filteredContacts();
    const statusLabel = { pending: "Offene", done: "Erfasste", all: "Alle" }[state.status];
    elements.listTitle.textContent = `${statusLabel} Kontakte · ${ownerLabels[state.activeOwner]}`;
    elements.listCount.textContent = `${visible.length} ${visible.length === 1 ? "Kunde" : "Kunden"}`;
    elements.contactList.replaceChildren();

    const fragment = document.createDocumentFragment();
    for (const contact of visible) fragment.append(makeContactRow(contact));
    elements.contactList.append(fragment);
    elements.emptyList.hidden = visible.length > 0;
  }

  function renderAll() {
    renderOwnerCounts();
    renderGlobalProgress();
    renderCityOptions();
    renderList();
    elements.clearSearchButton.hidden = state.query.length === 0;
  }

  function updateOwnerPicker() {
    for (const button of elements.ownerButtons) {
      button.classList.toggle("is-active", button.dataset.ownerValue === state.draftOwner);
    }
  }

  function supportsContactPicker() {
    return Boolean(
      window.isSecureContext &&
        navigator.contacts &&
        typeof navigator.contacts.select === "function",
    );
  }

  function setPickingContact(isPicking) {
    state.isPickingContact = isPicking;
    elements.contactPickerButton.disabled = isPicking || state.isSaving;
    elements.contactPickerButton.textContent = isPicking ? "Öffnet..." : "Kontakte";
  }

  async function pickPhoneFromContacts() {
    if (state.isPickingContact || state.isSaving || !state.selectedId) return;
    if (!supportsContactPicker()) {
      showToast("Kontaktwahl ist in Safari nicht aktiviert");
      elements.phoneInput.focus({ preventScroll: true });
      return;
    }

    setPickingContact(true);
    try {
      const selectedContacts = await navigator.contacts.select(["name", "tel"], {
        multiple: false,
      });
      const selectedContact = selectedContacts?.[0];
      if (!selectedContact) {
        elements.phoneInput.focus({ preventScroll: true });
        return;
      }

      const phoneNumbers = (selectedContact.tel || [])
        .map((phone) => String(phone || "").trim())
        .filter(Boolean);
      if (phoneNumbers.length === 0) {
        showToast("Dieser Kontakt hat keine Telefonnummer");
        elements.phoneInput.focus({ preventScroll: true });
        return;
      }

      elements.phoneInput.value = phoneNumbers[0];
      elements.phoneInput.setCustomValidity("");
      const contactName = String(selectedContact.name?.[0] || "").trim();
      if (phoneNumbers.length > 1) {
        showToast(`Erste von ${phoneNumbers.length} Nummern übernommen`);
      } else {
        showToast(contactName ? `Nummer von ${contactName} übernommen` : "Nummer übernommen");
      }
    } catch (error) {
      if (error?.name !== "AbortError") {
        showToast("Kontakt konnte nicht geöffnet werden");
        console.error(error);
      }
      elements.phoneInput.focus({ preventScroll: true });
    } finally {
      setPickingContact(false);
    }
  }

  function selectContact(id, focusInput = true) {
    const contact = contacts.find((item) => item.id === id);
    if (!contact) return;

    state.selectedId = id;
    state.draftOwner = getOwner(contact);
    elements.editorCustomerNumber.textContent = `Kundennummer ${contact.id}`;
    elements.editorName.textContent = contact.name || `Kontakt ${contact.id}`;
    elements.editorAddress.textContent =
      [contact.street, contact.postalCode, contact.city].filter(Boolean).join(", ") || "Keine Adresse";
    elements.editorCity.textContent = contact.city;
    elements.phoneInput.value = getPhone(contact);
    elements.phoneInput.setCustomValidity("");

    elements.editorEmail.replaceChildren();
    if (contact.email) {
      const link = document.createElement("a");
      link.href = `mailto:${contact.email}`;
      link.textContent = contact.email;
      elements.editorEmail.append(link);
    } else {
      elements.editorEmail.textContent = "—";
    }

    updateOwnerPicker();
    elements.editorEmpty.hidden = true;
    elements.editorForm.hidden = false;
    elements.editorPane.classList.add("is-open");
    elements.editorBackdrop.hidden = window.matchMedia("(min-width: 861px)").matches;
    renderList();

    if (focusInput) {
      requestAnimationFrame(() => {
        elements.phoneInput.focus({ preventScroll: true });
        if (elements.phoneInput.value) elements.phoneInput.select();
      });
    }
  }

  function closeEditor({ render = true } = {}) {
    state.selectedId = null;
    elements.editorForm.hidden = true;
    elements.editorEmpty.hidden = false;
    elements.editorPane.classList.remove("is-open");
    elements.editorBackdrop.hidden = true;
    if (render) renderList();
  }

  function nextPendingContact(currentId) {
    const candidates = filteredContacts({ ignoreStatus: true });
    if (candidates.length === 0) return null;
    const currentIndex = candidates.findIndex((contact) => contact.id === currentId);
    for (let offset = 1; offset <= candidates.length; offset += 1) {
      const candidate = candidates[(currentIndex + offset) % candidates.length];
      if (candidate.id !== currentId && !isComplete(candidate)) return candidate;
    }
    return null;
  }

  function setSaving(isSaving) {
    state.isSaving = isSaving;
    elements.saveButton.disabled = isSaving;
    elements.skipButton.disabled = isSaving;
    elements.contactPickerButton.disabled = isSaving || state.isPickingContact;
    elements.phoneInput.readOnly = isSaving;
    elements.saveButton.textContent = isSaving ? "Speichert..." : "Speichern & Nächster";
  }

  async function saveSelectedContact() {
    const contact = contacts.find((item) => item.id === state.selectedId);
    if (!contact || state.isSaving) return;

    const phone = elements.phoneInput.value.trim();
    if (phone && !/\d/.test(phone)) {
      elements.phoneInput.setCustomValidity("Bitte eine gültige Telefonnummer eingeben.");
      elements.phoneInput.reportValidity();
      return;
    }
    elements.phoneInput.setCustomValidity("");

    setSaving(true);
    try {
      const payload = await requestJson(`/api/contacts/${encodeURIComponent(contact.id)}`, {
        method: "PUT",
        body: JSON.stringify({ phone, owner: state.draftOwner }),
      });
      const savedRecord = payload.record || {};
      state.phones[contact.id] = String(savedRecord.phone ?? phone);
      state.owners[contact.id] = normalizeOwner(savedRecord.owner ?? state.draftOwner);
      persistState();
      setSyncStatus("online");
      const next = nextPendingContact(contact.id);
      renderAll();

      if (next) {
        selectContact(next.id);
      } else {
        closeEditor();
      }
      showToast(phone ? "Telefonnummer online gespeichert" : "Kontakt online gespeichert");
    } catch (error) {
      setSyncStatus("offline");
      showToast("Nicht gespeichert. Bitte erneut versuchen.");
      console.error(error);
    } finally {
      setSaving(false);
    }
  }

  function showToast(message) {
    elements.toast.textContent = message;
    elements.toast.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => elements.toast.classList.remove("is-visible"), 2200);
  }

  function downloadFile(fileName, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function exportBackup() {
    const records = contacts.map((contact) => ({
      id: contact.id,
      phone: getPhone(contact),
      owner: getOwner(contact),
    }));
    const date = new Date().toISOString().slice(0, 10);
    downloadFile(
      `telefonliste-backup-${date}.json`,
      JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), records }, null, 2),
      "application/json;charset=utf-8",
    );
    showToast("Backup erstellt");
  }

  function csvCell(value) {
    const text = String(value ?? "");
    return /[;"\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }

  function exportCsv() {
    const header = ["KdNr", "Name", "Straße", "PLZ", "Ort", "Telefon", "E-Mail", "Zuständig"];
    const rows = contacts.map((contact) =>
      [
        contact.id,
        contact.name,
        contact.street,
        contact.postalCode,
        contact.city,
        getPhone(contact),
        contact.email,
        ownerLabels[getOwner(contact)],
      ]
        .map(csvCell)
        .join(";"),
    );
    const date = new Date().toISOString().slice(0, 10);
    downloadFile(
      `telefonliste-${date}.csv`,
      `\uFEFF${header.join(";")}\r\n${rows.join("\r\n")}`,
      "text/csv;charset=utf-8",
    );
    showToast("CSV erstellt");
  }

  async function importBackup(file) {
    try {
      const payload = JSON.parse(await file.text());
      if (!Array.isArray(payload.records)) throw new Error("Ungültiges Backup");
      const validIds = new Set(contacts.map((contact) => contact.id));
      const records = [];
      for (const record of payload.records) {
        const id = String(record.id || "");
        if (!validIds.has(id)) continue;
        records.push({
          contactId: id,
          phone: String(record.phone || "").trim(),
          owner: normalizeOwner(record.owner),
        });
      }
      await requestJson("/api/sync", {
        method: "POST",
        body: JSON.stringify({ records, overwrite: true }),
      });
      for (const record of records) {
        state.phones[record.contactId] = record.phone;
        state.owners[record.contactId] = record.owner;
      }
      persistState();
      closeEditor({ render: false });
      renderAll();
      setSyncStatus("online");
      showToast(`${records.length} Kontakte online importiert`);
    } catch (error) {
      setSyncStatus("offline");
      showToast("Import nicht gespeichert");
      console.error(error);
    } finally {
      elements.importInput.value = "";
    }
  }

  for (const tab of elements.ownerTabs) {
    tab.addEventListener("click", () => {
      state.activeOwner = tab.dataset.owner;
      state.city = "all";
      closeEditor({ render: false });
      renderAll();
    });
  }

  elements.searchInput.addEventListener("input", () => {
    state.query = elements.searchInput.value;
    renderList();
    elements.clearSearchButton.hidden = state.query.length === 0;
  });

  elements.clearSearchButton.addEventListener("click", () => {
    state.query = "";
    elements.searchInput.value = "";
    elements.clearSearchButton.hidden = true;
    renderList();
    elements.searchInput.focus();
  });

  elements.cityFilter.addEventListener("change", () => {
    state.city = elements.cityFilter.value;
    closeEditor({ render: false });
    renderList();
  });

  elements.statusFilter.addEventListener("change", () => {
    state.status = elements.statusFilter.value;
    closeEditor({ render: false });
    renderList();
  });

  elements.contactList.addEventListener("click", (event) => {
    const row = event.target.closest("[data-contact-id]");
    if (!row) return;
    const contact = contacts.find((item) => item.id === row.dataset.contactId);
    const openPicker = Boolean(contact && !isComplete(contact) && supportsContactPicker());
    selectContact(row.dataset.contactId, !openPicker);
    if (openPicker) void pickPhoneFromContacts();
  });

  elements.contactPickerButton.addEventListener("click", () => {
    void pickPhoneFromContacts();
  });

  for (const button of elements.ownerButtons) {
    button.addEventListener("click", () => {
      state.draftOwner = normalizeOwner(button.dataset.ownerValue);
      updateOwnerPicker();
    });
  }

  elements.editorForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveSelectedContact();
  });

  elements.skipButton.addEventListener("click", () => {
    const next = nextPendingContact(state.selectedId);
    if (next) selectContact(next.id);
    else closeEditor();
  });

  elements.closeEditorButton.addEventListener("click", () => closeEditor());
  elements.editorBackdrop.addEventListener("click", () => closeEditor());
  elements.backupButton.addEventListener("click", exportBackup);
  elements.csvButton.addEventListener("click", exportCsv);
  elements.importButton.addEventListener("click", () => elements.importInput.click());
  elements.importInput.addEventListener("change", () => {
    const [file] = elements.importInput.files;
    if (file) importBackup(file);
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.selectedId) closeEditor();
  });

  window.addEventListener("resize", () => {
    if (!state.selectedId) return;
    elements.editorBackdrop.hidden = window.matchMedia("(min-width: 861px)").matches;
  });

  window.addEventListener("online", () => {
    void refreshRemoteState({ migrateLocal: true });
  });

  window.addEventListener("offline", () => setSyncStatus("offline"));

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !state.isSaving) void refreshRemoteState({ quiet: true });
  });

  if (contacts.length === 0) {
    elements.emptyList.hidden = false;
    elements.emptyList.textContent = "Kontaktdaten fehlen";
    return;
  }

  renderAll();
  void refreshRemoteState({ migrateLocal: true });
  window.setInterval(() => {
    if (!document.hidden && !state.isSaving) void refreshRemoteState({ quiet: true });
  }, 20000);
})();
