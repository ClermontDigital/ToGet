/* To Get card - the things we need to buy, get or order, and where each one is coming from.
 * Buildless: plain JS custom element, served by the to_get integration.
 *   view: full  - the list: add things, tick them off, change them, see them by place.
 *   view: count - one strip: how many things are to get and the first few, linking to the list.
 * Colours come from the Home Assistant theme; set --to-get-accent to change the accent (or --tg-accent on ha-card,
 * from card-mod). The count strip also takes --tg-glow, --tg-name-size, --tg-name-transform and --tg-name-spacing.
 */
const TG_VERSION = "0.1.0";

const TG_OFFLINE = "Couldn't reach Home Assistant. Check the connection and try again.";
const TG_STARTING = "Waiting for To Get to load in Home Assistant…";
const TG_NONE = "There's no list yet. Add one under Settings, Devices & services, To Get.";
const TG_GONE = "This list isn't there right now. If it was deleted, pick another in the card's settings.";
const TG_READ_ONLY = "Your Home Assistant user can look at this list but not change it.";
const TG_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const tgEsc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const tgClean = (s) => String(s ?? "").split(/\s+/).filter(Boolean).join(" ");
const tgFold = (s) => tgClean(s).toLowerCase();
// Home Assistant's connection rejects with a bare number when the socket is down.
const tgMessage = (err) => (err && typeof err === "object" && err.message ? String(err.message) : TG_OFFLINE);
const tgDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
// When something was got, as a person would say it.
const tgAgo = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const days = Math.round((tgDay(new Date()) - tgDay(d)) / 86400000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : days < 7 ? `${days} days ago` : `${d.getDate()} ${TG_MONTHS[d.getMonth()]}`;
};
const tgThings = (n) => (n === 1 ? "1 thing" : `${n} things`);

// Text on the accent: dark or light, whichever reads better on it (WCAG contrast).
const tgRgb = (css) => {
  const n = String(css).match(/-?[\d.]+/g)?.map(Number);
  if (!n || n.length < 3) return null;
  return /^color\(/.test(css) ? n.slice(0, 3).map((c) => c * 255) : n.slice(0, 3);
};
const tgLum = (rgb) => rgb.map((c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; })
  .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
const tgContrast = (a, b) => { const x = tgLum(a); const y = tgLum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const TG_DARK = [8, 28, 22];

// Bring what's on screen (`from`) into line with what was just drawn (`to`), keeping every element that is still
// the same thing, matched by what it is (a thing on the list by its uid) rather than where it is. So a redraw never
// takes focus, the caret or a half-typed value out of a box (and a phone's keyboard stays up), even when something
// above it comes or goes, and never swaps out a button under a finger.
const tgKey = (n) => (n.nodeType === 1 ? `${n.tagName}|${n.dataset.act || ""}|${n.dataset.uid || ""}|${n.dataset.field || ""}|${n.dataset.key || ""}|${n.id || ""}` : `#${n.nodeType}`);
function tgMorph(from, to) {
  // First take out what's gone, so what stays is neither moved nor replaced.
  const want = new Map();
  for (const n of to.childNodes) want.set(tgKey(n), (want.get(tgKey(n)) || 0) + 1);
  const kept = new Map();
  for (const o of [...from.childNodes]) {
    const k = tgKey(o);
    kept.set(k, (kept.get(k) || 0) + 1);
    if (kept.get(k) > (want.get(k) || 0)) o.remove();
  }
  let cursor = from.firstChild;
  for (const n of [...to.childNodes]) {
    const k = tgKey(n);
    let o = cursor;
    while (o && tgKey(o) !== k) o = o.nextSibling;
    if (!o) { from.insertBefore(n, cursor); continue; }
    if (o === cursor) cursor = cursor.nextSibling;
    else from.insertBefore(o, cursor);   // something moved up past others
    if (o.nodeType !== 1) { if (o.data !== n.data) o.data = n.data; continue; }
    for (const { name } of [...o.attributes]) if (!n.hasAttribute(name)) o.removeAttribute(name);
    for (const { name, value } of [...n.attributes]) if (o.getAttribute(name) !== value) o.setAttribute(name, value);
    // A box's text is the person's: only a box drawn with a value (the editor's, from its draft) is set, and never
    // the one being typed in.
    const typing = o === o.getRootNode().activeElement;
    if (o.tagName === "INPUT") { if (n.hasAttribute("value") && !typing && o.value !== n.value) o.value = n.value; continue; }
    if (o.tagName === "TEXTAREA") { if (!typing && o.value !== n.value) o.value = n.value; continue; }
    if (!o.tagName.includes("-")) tgMorph(o, n);   // a custom element (ha-icon) draws its own inside
  }
  while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
}

class ToGetCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = { view: "full" };
    this._data = null;        // the list as Home Assistant last sent it (full view)
    this._summary = null;     // how many there are to get (count view)
    this._local = null;       // what's on screen while changes are on their way: _data with them laid over it
    this._pending = 0;
    this._editing = null;     // the thing open in the editor
    this._draft = {};         // ... and what's been typed into it
    this._filter = null;      // the place being looked at: null = everything, "" = things with no place
    this._showGot = false;
    this._armed = null;       // "delete:<uid>" or "clear": tapped once, waiting for the second tap
    this._undo = null;        // the thing just ticked off, for a moment
    this._seq = 0;
    const root = this.shadowRoot;
    // The frame is built once, here, and only its inside is ever redrawn. card-mod and themes put their styling
    // next to it or on it, so nothing else in the shadow root is touched after this.
    root.innerHTML = `<style>${ToGetCard.styles}</style><ha-card><div class="sr" aria-live="polite" aria-atomic="true"></div>`
      + `<span class="probe" aria-hidden="true"></span><div class="body"></div></ha-card>`;
    this._main = root.querySelector(".body");
    this._live = root.querySelector(".sr");
    this._probe = root.querySelector(".probe");
    root.addEventListener("click", (ev) => this._onClick(ev));
    root.addEventListener("submit", (ev) => { ev.preventDefault(); if (ev.target.dataset.act === "add-form") this._addFromForm(); else this._save(); });
    root.addEventListener("input", (ev) => this._onInput(ev));
    root.addEventListener("keydown", (ev) => this._onKey(ev));
    // Redrawing while a finger is down on a button would swallow the tap, so a redraw waits for the release.
    root.addEventListener("pointerdown", () => { this._pressing = true; });
    this._release = () => {
      this._pressing = false;
      if (this._renderQueued) setTimeout(() => this._render(), 0);
    };
    this._ready = () => { this._dropSubscription(); this._retries = 0; this._retryAt = 0; this._subscribe(); };
    this._down = () => { this._unsub = null; };   // the subscription went with the connection
  }

  setConfig(config) {
    const view = config?.view || "full";
    if (!["full", "count"].includes(view)) throw new Error("To Get: view must be full or count");
    const changed = (config?.entry_id || null) !== (this._config.entry_id || null) || view !== this._config.view;
    this._config = { ...config, view };
    if (changed) {
      this._dropSubscription();
      this._entryId = null;
      this._data = null;
      this._summary = null;
      this._local = null;
      this._editing = null;
      this._filter = null;
      this._retries = 0;
      this._retryAt = 0;
      if (this._hass) this._subscribe();
    }
    this._render();
  }

  static getStubConfig() { return {}; }

  static getConfigForm() {
    const labels = { entry_id: "List", view: "Layout", title: "Title", hide_title: "Hide the title",
      navigation_path: "Tapping the strip opens", hide_got: "Hide what's been got" };
    const helpers = {
      entry_id: "Leave empty to use the first list (the strip then counts every list).",
      title: "Leave empty to use the list's name.",
      hide_title: "For when the card sits under a heading of its own.",
      navigation_path: "For the strip: usually the dashboard the list is on.",
    };
    return {
      schema: [
        { name: "entry_id", selector: { config_entry: { integration: "to_get" } } },
        { name: "view", selector: { select: { mode: "dropdown", options: [
          { value: "full", label: "Full: the list" },
          { value: "count", label: "Count: a strip saying how many things are to get" },
        ] } } },
        { name: "title", selector: { text: {} } },
        { name: "hide_title", selector: { boolean: {} } },
        { name: "navigation_path", selector: { navigation: {} } },
        { name: "hide_got", selector: { boolean: {} } },
      ],
      computeLabel: (schema) => labels[schema.name],
      computeHelper: (schema) => helpers[schema.name],
    };
  }

  getCardSize() { return this._config.view === "count" ? 1 : 3 + Math.min(10, this._view()?.items.length || 0); }
  getGridOptions() { return this._config.view === "count" ? { columns: 12, rows: "auto", min_columns: 3 } : { columns: 12, rows: "auto", min_columns: 6 }; }

  set hass(hass) {
    const first = !this._hass;
    const before = this._hass?.connection;
    this._hass = hass;
    if (before !== hass.connection) this._watch(before, hass.connection);
    if (first) { this._subscribe(); return; }
    // Not subscribed (Home Assistant was starting, or the connection dropped): try again when it's time.
    if (!this._unsub && !this._subscribing && hass.connected !== false && Date.now() >= (this._retryAt || 0)) this._subscribe();
    // card-mod can apply its accent after the first draw: look again now and then, and redraw if it changed.
    if (performance.now() - (this._inkAt || 0) > 2000 && this._ink()) this._render();
  }

  // After a reconnect the old subscription is gone (and resubscribing may fail while To Get is still loading), so
  // this card subscribes again itself, retrying until To Get answers.
  _watch(before, now) {
    before?.removeEventListener?.("ready", this._ready);
    before?.removeEventListener?.("disconnected", this._down);
    if (!this.isConnected) return;
    now?.addEventListener?.("ready", this._ready);
    now?.addEventListener?.("disconnected", this._down);
  }

  connectedCallback() {
    window.addEventListener("pointerup", this._release, true);
    window.addEventListener("pointercancel", this._release, true);
    if (this._hass) { this._watch(null, this._hass.connection); this._subscribe(); }
    this._render();
  }

  disconnectedCallback() {
    window.removeEventListener("pointerup", this._release, true);
    window.removeEventListener("pointercancel", this._release, true);
    this._watch(this._hass?.connection, null);
    clearTimeout(this._retryTimer);
    clearTimeout(this._undoTimer);
    clearTimeout(this._armTimer);
    this._undo = null;    // their timers are gone, so they'd stay up for good
    this._armed = null;
    this._pressing = false;
    this._dropSubscription();
  }

  // Text on the accent is dark or light to suit it, whether it's the default, a theme's or card-mod's.
  _ink() {
    this._inkAt = performance.now();
    const color = getComputedStyle(this._probe).color;
    if (color === this._inkFor) return false;
    this._inkFor = color;
    const rgb = tgRgb(color);
    this._main.style.setProperty("--tg-on-accent", rgb && tgContrast(rgb, [255, 255, 255]) > tgContrast(rgb, TG_DARK) ? "#FFFFFF" : "#081C16");
    return true;
  }

  // Subscribing ----------------------------------------------------------------------------------

  async _subscribe() {
    if (this._unsub || this._subscribing || !this._hass || !this.isConnected) return;
    const conn = this._hass.connection;
    const token = (this._seq += 1);
    this._subscribing = true;
    try {
      let unsub;
      if (this._config.view === "count") {
        const msg = { type: "to_get/subscribe_summary" };
        if (this._config.entry_id) msg.entry_id = this._config.entry_id;
        // Each callback only listens while its own subscription is the card's (not one on its way out).
        unsub = await conn.subscribeMessage((m) => { if (token === this._seq) this._onSummary(m); }, msg, { resubscribe: false });
      } else {
        if (!this._entryId) {
          if (this._config.entry_id) this._entryId = this._config.entry_id;
          else {
            const lists = await this._hass.callWS({ type: "to_get/lists" });
            if (token !== this._seq) return;
            if (!lists.length) { this._none = true; this._loadError = null; this._render(); this._retryLater(); return; }
            this._entryId = lists[0].entry_id;
          }
        }
        unsub = await conn.subscribeMessage((m) => { if (token === this._seq) this._onList(m); },
          { type: "to_get/subscribe", entry_id: this._entryId }, { resubscribe: false });
      }
      if (token !== this._seq || !this.isConnected) { this._quietly(unsub); return; }
      this._unsub = unsub;
      this._none = false;
      this._loadError = null;
      this._retries = 0;
      this._retryAt = 0;
    } catch (err) {
      if (token !== this._seq) return;
      if (err?.code === "not_found" && !this._config.entry_id) this._entryId = null;   // the first list went: find the new first
      this._loadError = err?.code === "unknown_command" ? TG_STARTING : err?.code === "not_found" ? TG_GONE : tgMessage(err);
      this._retryLater();
    } finally {
      if (token === this._seq) this._subscribing = false;
    }
    this._render();
  }

  _retryLater() {
    clearTimeout(this._retryTimer);
    const wait = Math.min(30000, 1000 * 2 ** Math.min(this._retries || 0, 5));
    this._retries = (this._retries || 0) + 1;
    this._retryAt = Date.now() + wait;
    this._retryTimer = setTimeout(() => { if (this._hass?.connected !== false) this._subscribe(); }, wait);
  }

  _quietly(unsub) {
    // After a restart the old subscription can't be cancelled: Home Assistant answers with an error, which is fine.
    if (unsub) { try { Promise.resolve(unsub()).catch(() => {}); } catch (_) { /* connection already gone */ } }
  }

  _dropSubscription() {
    this._seq += 1;   // anything on its way for the old subscription is ignored
    this._subscribing = false;
    const unsub = this._unsub;
    this._unsub = null;
    this._quietly(unsub);
  }

  _onList(msg) {
    if (msg.gone) {
      // Being reloaded (the subscription carries on when it's back), or deleted: a card showing "the first list"
      // goes and finds whichever is first now.
      this._gone = true;
      if (!this._config.entry_id) { this._dropSubscription(); this._entryId = null; this._retryLater(); }
      this._render();
      return;
    }
    this._gone = false;
    this._data = msg;
    if (!this._pending) this._local = null;
    if (this._editing && !this._view().items.some((i) => i.uid === this._editing)) this._editing = null;
    this._render();
  }

  _onSummary(msg) {
    this._summary = msg;
    this._render();
  }

  // What's on screen: the last list from Home Assistant, or that with the changes still on their way.
  _view() { return this._local || this._data; }

  // Changing ---------------------------------------------------------------------------------------

  // Shows a change straight away, sends it, and goes back to what Home Assistant says once nothing is on its way.
  async _write(msg, apply) {
    if (!this._data?.can_change || !this._entryId) return null;
    if (!this._local) this._local = JSON.parse(JSON.stringify(this._data));
    apply?.(this._local);
    this._pending += 1;
    this._error = null;
    this._render();
    try {
      return await this._hass.callWS({ ...msg, entry_id: this._entryId });
    } catch (err) {
      this._error = err?.code === "not_found" && msg.type !== "to_get/add" ? "That isn't on the list any more." : tgMessage(err);
      this._say(this._error);
      return null;
    } finally {
      this._pending -= 1;
      if (!this._pending) this._local = null;
      this._render();
    }
  }

  // The place a new thing would get if no place is typed: the one being looked at (Anywhere is none), or where it
  // came from last time. Something already on the list keeps its own.
  _placeFor(summary) {
    const v = this._view();
    if (v?.items.some((i) => tgFold(i.summary) === tgFold(summary))) return { place: null, from: "already" };
    if (this._filter === "") return { place: "", from: "filter" };
    if (this._filter) return { place: v?.places.find((p) => tgFold(p) === this._filter) || "", from: "filter" };
    const known = (v?.names || []).find((n) => tgFold(n.name) === tgFold(summary));
    return { place: known?.place || "", from: "known" };
  }

  _placeHint() {
    const box = this.shadowRoot.querySelector('[data-field="summary"]');
    const { place, from } = this._placeFor(box?.value || "");
    if (from === "filter") return place || "Anywhere";
    return place ? `${place} (last time)` : "Where from?";
  }

  async _addFromForm() {
    const root = this.shadowRoot;
    const nameBox = root.querySelector('[data-field="summary"]');
    const placeBox = root.querySelector('[data-field="place"]');
    const summary = tgClean(nameBox?.value);
    if (!summary) { nameBox?.focus(); this._say("Type what's needed first."); return; }
    const typed = tgClean(placeBox?.value);
    const msg = { type: "to_get/add", summary };
    const { place, from } = this._placeFor(summary);
    if (typed) msg.place = typed;
    else if (from === "filter") msg.place = place;
    const before = { name: nameBox.value, place: placeBox.value };
    nameBox.value = "";
    placeBox.value = "";
    placeBox.placeholder = this._placeHint();
    nameBox.focus();
    const key = tgFold(summary);
    let flash = null;
    const result = await this._write(msg, (v) => {
      const open = v.items.find((i) => tgFold(i.summary) === key);
      if (open) { if (msg.place) open.place = msg.place; flash = open.uid; return; }
      const gi = v.got.findIndex((i) => tgFold(i.summary) === key);
      if (gi >= 0) {
        const [back] = v.got.splice(gi, 1);
        Object.assign(back, { summary, status: "needs_action", done: null }, "place" in msg ? { place: msg.place } : {});
        v.items.push(back);
        return;
      }
      v.items.push({ uid: `new-${Date.now()}`, summary, place: "place" in msg ? msg.place : this._placeFor(summary).place,
        notes: "", status: "needs_action", added: new Date().toISOString() });
    });
    if (!result) {
      // Not saved: give back what was typed, unless something new has been typed since.
      if (!nameBox.value && !placeBox.value) { nameBox.value = before.name; placeBox.value = before.place; placeBox.placeholder = this._placeHint(); }
      return;
    }
    const { item, how } = result;
    if (how === "already") { this._flash(item.uid); this._say(`${item.summary} is already on the list.`); }
    else this._say(`${item.summary} added${item.place ? `, from ${item.place}` : ""}.`);
    // Looking at one place and the new thing is from another: show everything, so it can be seen.
    if (this._filter !== null && tgFold(item.place) !== this._filter) { this._filter = null; this._render(); }
    if (flash) this._flash(flash);
  }

  _flash(uid) {
    this._flashing = uid;
    this._render();
    setTimeout(() => { if (this._flashing === uid) { this._flashing = null; this._render(); } }, 1400);
  }

  _tick(uid, done) {
    const v = this._view();
    const item = (done ? v.items : v.got).find((i) => i.uid === uid);
    if (!item || uid.startsWith("new-")) return;
    if (this._editing === uid) this._editing = null;
    const root = this.shadowRoot;
    const ticks = [...root.querySelectorAll(`.tick[data-act="${done ? "tick" : "untick"}"]`)];
    const at = ticks.findIndex((b) => b.dataset.uid === uid);
    const hadFocus = root.activeElement === ticks[at];
    window.dispatchEvent(new CustomEvent("haptic", { detail: done ? "success" : "light" }));
    if (done) {
      clearTimeout(this._undoTimer);
      this._undo = { uid, name: item.summary };
      this._undoTimer = setTimeout(() => { this._undo = null; this._render(); }, 6000);
    } else if (this._undo?.uid === uid) this._undo = null;
    this._write({ type: "to_get/update", uid, done }, (l) => {
      const from = done ? l.items : l.got;
      const i = from.findIndex((x) => x.uid === uid);
      if (i < 0) return;
      const [moved] = from.splice(i, 1);
      Object.assign(moved, done ? { status: "completed", done: new Date().toISOString() } : { status: "needs_action", done: null });
      if (done) l.got.unshift(moved); else l.items.push(moved);
    });
    if (hadFocus) {
      // The circle that was tapped has gone: focus the next thing's (or the one before), so a keyboard isn't lost.
      const next = ticks[at + 1] || ticks[at - 1];
      (next?.isConnected ? next : root.querySelector('[data-field="summary"]'))?.focus();
    }
    this._say(done ? `Got ${item.summary}.` : `${item.summary} is back on the list.`);
  }

  _openEditor(uid) {
    const item = this._view()?.items.find((i) => i.uid === uid);
    if (!item || !this._data?.can_change || uid.startsWith("new-")) return;
    this._editing = uid;
    this._draft = { summary: item.summary, place: item.place || "", notes: item.notes || "" };
    this._opened = { ...this._draft };   // as it was when opened: what someone else changes meanwhile is left alone
    this._armed = null;
    this._render();
    this.shadowRoot.querySelector('[data-field="e-summary"]')?.focus();
  }

  _closeEditor() {
    const uid = this._editing;
    this._editing = null;
    this._armed = null;
    this._render();
    this.shadowRoot.querySelector(`[data-act="edit"][data-uid="${CSS.escape(uid || "")}"]`)?.focus();
  }

  _save() {
    const uid = this._editing;
    const item = this._view()?.items.find((i) => i.uid === uid);
    if (!item) { this._closeEditor(); return; }
    const d = { summary: tgClean(this._draft.summary), place: tgClean(this._draft.place), notes: String(this._draft.notes || "").trim() };
    if (!d.summary) { this._say("Type what's needed first."); this.shadowRoot.querySelector('[data-field="e-summary"]')?.focus(); return; }
    const was = this._opened || {};
    const changes = {};
    for (const k of ["summary", "place", "notes"]) if (d[k] !== (k === "notes" ? String(was[k] || "").trim() : tgClean(was[k]))) changes[k] = d[k];
    this._closeEditor();
    if (!Object.keys(changes).length) return;
    this._write({ type: "to_get/update", uid, ...changes }, (l) => { Object.assign(l.items.find((i) => i.uid === uid) || {}, changes); });
  }

  _arm(what) {
    this._armed = what;
    clearTimeout(this._armTimer);
    this._armTimer = setTimeout(() => { this._armed = null; this._render(); }, 4000);
    this._render();
  }

  _delete(uid) {
    if (this._armed !== `delete:${uid}`) { this._arm(`delete:${uid}`); return; }
    const item = this._view()?.items.find((i) => i.uid === uid);
    this._armed = null;
    this._editing = null;
    this._write({ type: "to_get/remove", uids: [uid] }, (l) => { l.items = l.items.filter((i) => i.uid !== uid); });
    if (item) this._say(`${item.summary} taken off the list.`);
  }

  _clear() {
    if (this._armed !== "clear") { this._arm("clear"); return; }
    this._armed = null;
    this._write({ type: "to_get/clear" }, (l) => { l.got = []; });
    this._say("Cleared what's been got.");
  }

  _go() {
    const path = this._config.navigation_path;
    if (!path) return;
    history.pushState(null, "", path);
    window.dispatchEvent(new CustomEvent("location-changed", { detail: { replace: false } }));
  }

  _say(text) { this._live.textContent = ""; setTimeout(() => { this._live.textContent = text; }, 30); }

  // Events -----------------------------------------------------------------------------------------

  _onClick(ev) {
    const el = ev.target.closest?.("[data-act]");
    if (!el || el.disabled) return;
    const { act, uid, key } = el.dataset;
    if (act === "go") this._go();
    else if (act === "tick") this._tick(uid, true);
    else if (act === "untick") this._tick(uid, false);
    else if (act === "edit") this._openEditor(uid);
    else if (act === "cancel") this._closeEditor();
    else if (act === "delete") this._delete(uid);
    else if (act === "filter") {
      this._filter = key === "*" ? null : key;
      this._render();
      const box = this.shadowRoot.querySelector('[data-field="place"]');
      if (box) box.placeholder = this._placeHint();
    } else if (act === "toggle-got") { this._showGot = !this._showGot; this._render(); }
    else if (act === "clear") this._clear();
    else if (act === "undo" && this._undo) { const { uid: u } = this._undo; this._undo = null; this._tick(u, false); }
    else if (act === "dismiss") { this._error = null; this._render(); }
  }

  _onInput(ev) {
    const field = ev.target.dataset?.field;
    if (field === "summary") {
      const box = this.shadowRoot.querySelector('[data-field="place"]');
      if (box) box.placeholder = this._placeHint();
    } else if (field?.startsWith("e-")) this._draft[field.slice(2)] = ev.target.value;
  }

  _onKey(ev) {
    if (ev.key === "Escape" && this._editing && ev.target.closest?.(".editor")) { ev.preventDefault(); this._closeEditor(); }
    else if ((ev.key === "Enter" || ev.key === " ") && ev.target.dataset?.act === "go") { ev.preventDefault(); this._go(); }
  }

  // Drawing ----------------------------------------------------------------------------------------

  _render() {
    if (this._pressing) { this._renderQueued = true; return; }
    this._renderQueued = false;
    if (!this._inkFor) this._ink();
    const html = this._config.view === "count" ? this._countHtml() : this._fullHtml();
    const next = document.createElement("div");
    next.innerHTML = html;
    this._main.classList.toggle("count-view", this._config.view === "count");
    tgMorph(this._main, next);
  }

  _status(text, kind = "note") { return `<p class="${kind}" ${kind === "err" ? 'role="alert"' : ""}>${tgEsc(text)}</p>`; }

  _countHtml() {
    const s = this._summary;
    const nav = !!this._config.navigation_path;
    const first = s?.lists?.[0];
    const name = this._config.title || (s?.lists?.length === 1 ? first.name : "To get");
    const icon = this._config.icon || (s?.lists?.length === 1 ? first.icon : "mdi:cart-outline");
    let value; let sub = "";
    if (!s) value = this._loadError ? "—" : "…";
    else if (!s.lists.length) { value = "—"; sub = "No list yet"; }
    else if (!s.total) value = "Nothing to get";
    else {
      value = tgThings(s.total);
      const names = s.lists.flatMap((l) => l.first);
      const shown = names.slice(0, 3);
      sub = shown.join(", ") + (s.total > shown.length ? ` +${s.total - shown.length}` : "");
    }
    if (this._loadError && !s) sub = this._loadError;
    const label = `${name}: ${value}${sub ? `. ${sub}` : ""}`;
    return `<div class="strip${nav ? " nav" : ""}" data-act="${nav ? "go" : ""}" ${nav ? `role="link" tabindex="0" aria-label="${tgEsc(label)}"` : ""}>`
      + `<ha-icon class="main" icon="${tgEsc(icon)}"></ha-icon>`
      + `<div class="text"><div class="name">${tgEsc(name)}</div><div class="value${s?.total ? "" : " quiet"}">${tgEsc(value)}</div>`
      + (sub ? `<div class="sub">${tgEsc(sub)}</div>` : "") + `</div>`
      + (nav ? `<ha-icon class="chev" icon="mdi:chevron-right"></ha-icon>` : "") + `</div>`;
  }

  _fullHtml() {
    const v = this._view();
    if (!v) {
      const text = this._none ? TG_NONE : this._gone ? TG_GONE : this._loadError || "Loading…";
      return this._status(text, this._loadError && this._loadError !== TG_STARTING ? "err" : "note");
    }
    const c = this._config;
    const canChange = v.can_change;
    const items = v.items;
    const placed = items.some((i) => i.place);
    if (this._filter !== null && !items.some((i) => tgFold(i.place) === this._filter)) this._filter = null;
    const shown = this._filter === null ? items : items.filter((i) => tgFold(i.place) === this._filter);
    let html = "";
    if (!c.hide_title) {
      html += `<div class="head"><ha-icon icon="${tgEsc(c.icon || v.list.icon)}"></ha-icon><h2 class="title">${tgEsc(c.title || v.list.name)}</h2>`
        + `<span class="count"><span aria-hidden="true">${items.length}</span><span class="vh">${tgEsc(tgThings(items.length))} to get</span></span></div>`;
    }
    if (this._gone) html += this._status(TG_GONE, "err");
    if (canChange) {
      const names = v.names.map((n) => `<option value="${tgEsc(n.name)}"></option>`).join("");
      const places = v.places.map((p) => `<option value="${tgEsc(p)}"></option>`).join("");
      html += `<form class="add" data-act="add-form" autocomplete="off">`
        + `<input class="f-summary" data-field="summary" list="tg-names" placeholder="What do we need?" aria-label="What do we need?" enterkeyhint="done" maxlength="120" autocapitalize="sentences">`
        + `<input class="f-place" data-field="place" list="tg-places" placeholder="${tgEsc(this._placeHint())}" aria-label="Where it's coming from (optional)" enterkeyhint="done" maxlength="60" autocapitalize="words">`
        + `<button class="addbtn" type="submit" data-key="add">Add</button>`
        + `<datalist id="tg-names">${names}</datalist><datalist id="tg-places">${places}</datalist></form>`;
    } else html += this._status(TG_READ_ONLY);
    if (placed && items.length > 1) html += this._chipsHtml(items);
    if (!items.length) html += `<p class="empty">Nothing to get.${canChange ? " Add what you need above." : ""}</p>`;
    else html += this._groupsHtml(shown, placed && this._filter === null);
    if (this._undo) {
      html += `<div class="undo" data-key="undo"><span>Got ${tgEsc(this._undo.name)}.</span>`
        + `<button class="link" data-act="undo">Undo</button></div>`;
    }
    if (this._error) {
      html += `<div class="err" role="alert" data-key="error"><span>${tgEsc(this._error)}</span>`
        + `<button class="link" data-act="dismiss" aria-label="Dismiss">OK</button></div>`;
    }
    if (!c.hide_got && v.got.length) html += this._gotHtml(v.got, canChange);
    return html;
  }

  _chipsHtml(items) {
    const groups = new Map();
    for (const i of items) {
      const k = tgFold(i.place);
      if (!groups.has(k)) groups.set(k, { name: i.place || "", n: 0 });
      groups.get(k).n += 1;
    }
    const keys = [...groups.keys()].filter((k) => k).sort((a, b) => a.localeCompare(b));
    if (groups.has("")) keys.push("");
    const chip = (key, label, n) => `<button class="chip" data-act="filter" data-key="${tgEsc(key)}" aria-pressed="${(key === "*" ? this._filter === null : this._filter === key)}">`
      + `${tgEsc(label)} <span class="n">${n}</span></button>`;
    return `<div class="chips" role="group" aria-label="Show things from">${chip("*", "All", items.length)}`
      + keys.map((k) => chip(k, k ? groups.get(k).name : "Anywhere", groups.get(k).n)).join("") + `</div>`;
  }

  _groupsHtml(items, grouped) {
    if (!grouped) return `<div class="groups"><ul class="list" data-key="flat">${items.map((i) => this._itemHtml(i, this._filter === null)).join("")}</ul></div>`;
    const groups = new Map();
    for (const i of items) {
      const k = tgFold(i.place);
      if (!groups.has(k)) groups.set(k, { name: i.place, items: [] });
      groups.get(k).items.push(i);
    }
    const keys = [...groups.keys()].filter((k) => k).sort((a, b) => a.localeCompare(b));
    if (groups.has("")) keys.push("");
    return `<div class="groups">` + keys.map((k) => {
      const g = groups.get(k);
      return `<section class="group" data-key="g:${tgEsc(k)}"><h3><span>${tgEsc(k ? g.name : "Anywhere")}</span><span class="n">${g.items.length}</span></h3>`
        + `<ul class="list">${g.items.map((i) => this._itemHtml(i, false)).join("")}</ul></section>`;
    }).join("") + `</div>`;
  }

  _itemHtml(i, showPlace) {
    const canChange = this._data?.can_change;
    const pending = i.uid.startsWith("new-");
    if (this._editing === i.uid) return this._editorHtml(i);
    const label = `<span class="name">${tgEsc(i.summary)}</span>`
      + (showPlace && i.place ? `<span class="place">${tgEsc(i.place)}</span>` : "")
      + (i.notes ? `<span class="notes">${tgEsc(i.notes)}</span>` : "");
    return `<li class="item${this._flashing === i.uid ? " flash" : ""}${pending ? " pending" : ""}" data-uid="${tgEsc(i.uid)}">`
      + `<button class="tick" data-act="tick" data-uid="${tgEsc(i.uid)}" role="checkbox" aria-checked="false" aria-label="Got ${tgEsc(i.summary)}"${canChange && !pending ? "" : " disabled"}><span class="box"></span></button>`
      + (canChange ? `<button class="label" data-act="edit" data-uid="${tgEsc(i.uid)}" aria-label="${tgEsc(`Change ${i.summary}${i.place ? `, from ${i.place}` : ""}${i.notes ? `, ${i.notes}` : ""}`)}"${pending ? " disabled" : ""}>${label}</button>`
        : `<div class="label">${label}</div>`)
      + `</li>`;
  }

  _editorHtml(i) {
    const d = this._draft;
    const armed = this._armed === `delete:${i.uid}`;
    const meta = [i.added ? `Added ${tgAgo(i.added)}` : "", i.added_by ? `by ${i.added_by}` : ""].filter(Boolean).join(" ");
    return `<li class="item editing" data-uid="${tgEsc(i.uid)}" data-key="editor"><form class="editor" data-act="edit-form" autocomplete="off">`
      + `<label>What<input data-field="e-summary" value="${tgEsc(d.summary)}" maxlength="120" enterkeyhint="done"></label>`
      + `<label>From<input data-field="e-place" list="tg-places" value="${tgEsc(d.place)}" placeholder="Anywhere" maxlength="60" enterkeyhint="done"></label>`
      + `<label>Notes<textarea data-field="e-notes" rows="2" placeholder="Size, brand, how many" maxlength="500">${tgEsc(d.notes)}</textarea></label>`
      + (meta ? `<p class="meta">${tgEsc(meta)}</p>` : "")
      + `<div class="row"><button type="button" class="danger${armed ? " armed" : ""}" data-act="delete" data-uid="${tgEsc(i.uid)}">${armed ? "Tap again to remove" : "Remove"}</button>`
      + `<span class="grow"></span><button type="button" class="plain" data-act="cancel">Cancel</button>`
      + `<button type="submit" class="primary" data-key="save">Save</button></div></form></li>`;
  }

  _gotHtml(got, canChange) {
    const open = this._showGot;
    const armed = this._armed === "clear";
    let html = `<div class="got"><div class="gothead"><button class="toggle" data-act="toggle-got" aria-expanded="${open}">`
      + `<ha-icon icon="${open ? "mdi:chevron-down" : "mdi:chevron-right"}"></ha-icon>Got <span class="n">${got.length}</span></button>`;
    if (open && canChange) html += `<button class="link${armed ? " armed" : ""}" data-act="clear">${armed ? "Tap again to clear" : "Clear"}</button>`;
    html += `</div>`;
    if (open) {
      html += `<ul class="list gotlist">` + got.map((i) => {
        const meta = [i.place, i.done ? `got ${tgAgo(i.done)}` : "", i.done_by ? `by ${i.done_by}` : ""].filter(Boolean).join(" · ");
        return `<li class="item done" data-uid="${tgEsc(i.uid)}">`
          + `<button class="tick" data-act="untick" data-uid="${tgEsc(i.uid)}" role="checkbox" aria-checked="true" aria-label="Put ${tgEsc(i.summary)} back on the list"${canChange ? "" : " disabled"}><span class="box"></span></button>`
          + `<div class="label"><span class="name">${tgEsc(i.summary)}</span>${meta ? `<span class="notes">${tgEsc(meta)}</span>` : ""}</div></li>`;
      }).join("") + `</ul>`;
    }
    return html + `</div>`;
  }

  static get styles() {
    return `
      :host { display: block; }
      ha-card { height: 100%; overflow: hidden; }
      .sr, .vh { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
      .probe { position: absolute; width: 0; height: 0; overflow: hidden; color: var(--tg-accent, var(--to-get-accent, var(--primary-color, #03a9f4))); }
      .body {
        --accent: var(--tg-accent, var(--to-get-accent, var(--primary-color, #03a9f4)));
        --muted: var(--secondary-text-color, #8a8a8a);
        --line: var(--divider-color, rgba(127, 127, 127, .22));
        --field: rgba(127, 127, 127, .10);
        container-type: inline-size;
        padding: 14px 16px 12px;
        color: var(--primary-text-color);
        font-size: 15px;
      }
      .body.count-view { padding: 0; }
      button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; -webkit-tap-highlight-color: transparent; }
      button:disabled { cursor: default; }
      :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 6px; }

      .head { display: flex; align-items: center; gap: 10px; margin: 0 0 12px; }
      .head ha-icon { color: var(--accent); --mdc-icon-size: 22px; flex: none; }
      .title { flex: 1; min-width: 0; margin: 0; font-size: 17px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .count { min-width: 28px; height: 26px; padding: 0 9px; box-sizing: border-box; border-radius: 13px; background: var(--accent);
        color: var(--tg-on-accent, #081C16); font-size: 14px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center;
        font-variant-numeric: tabular-nums; }

      input { box-sizing: border-box; width: 100%; min-width: 0; height: 44px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--line);
        background: var(--field); color: var(--primary-text-color); font: inherit; font-size: 16px; }
      textarea { box-sizing: border-box; width: 100%; min-height: 64px; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--line);
        background: var(--field); color: var(--primary-text-color); font: inherit; font-size: 16px; resize: vertical; }
      input::placeholder, textarea::placeholder { color: var(--muted); opacity: 1; }
      input:focus, textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
      form.add { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 36%) auto; gap: 8px; margin-bottom: 12px; }
      .addbtn, .primary { height: 44px; padding: 0 18px; border-radius: 8px; background: var(--accent); color: var(--tg-on-accent, #081C16); font-weight: 600; }
      @container (max-width: 420px) {
        form.add { grid-template-columns: minmax(0, 1fr) auto; }
        .f-summary { grid-column: 1 / -1; }
      }

      .chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 6px; }
      .chip { min-height: 34px; padding: 0 12px; border-radius: 17px; border: 1px solid var(--line); font-size: 13px; display: inline-flex; align-items: center; gap: 6px; }
      .chip .n { color: var(--muted); font-variant-numeric: tabular-nums; }
      .chip[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--tg-on-accent, #081C16); }
      .chip[aria-pressed="true"] .n { color: inherit; opacity: .75; }

      .groups { margin-top: 2px; }
      @container (min-width: 720px) {
        .groups { columns: 2; column-gap: 32px; }
        .group { break-inside: avoid; }
      }
      .group h3 { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin: 12px 0 0; padding: 0 0 4px 44px;
        font-size: 13px; font-weight: 600; color: var(--accent); border-bottom: 1px solid var(--line); }
      .group:first-child h3 { margin-top: 6px; }
      .n { color: var(--muted); font-weight: 400; font-variant-numeric: tabular-nums; }
      .list { list-style: none; margin: 0; padding: 0; }
      .item { display: grid; grid-template-columns: 44px minmax(0, 1fr); align-items: center; min-height: 44px; border-bottom: 1px solid var(--line); break-inside: avoid; }
      .item:last-child { border-bottom: 0; }
      .item.pending { opacity: .6; }
      .item.flash { animation: tg-flash 1.4s ease-out; }
      @keyframes tg-flash { from { background: color-mix(in srgb, var(--accent) 28%, transparent); } to { background: transparent; } }
      .tick { width: 44px; height: 44px; display: grid; place-items: center; }
      .box { width: 22px; height: 22px; box-sizing: border-box; border-radius: 50%; border: 2px solid var(--accent); position: relative; transition: background .15s; }
      .tick:hover:not(:disabled) .box { background: color-mix(in srgb, var(--accent) 18%, transparent); }
      .tick:disabled .box { opacity: .45; }
      .done .box { background: var(--accent); }
      .done .box::after { content: ""; position: absolute; left: 6px; top: 2.5px; width: 5px; height: 10px; border: solid var(--tg-on-accent, #081C16);
        border-width: 0 2px 2px 0; transform: rotate(45deg); }
      .label { display: block; width: 100%; text-align: left; padding: 10px 4px 10px 2px; min-height: 44px; box-sizing: border-box; line-height: 1.3; }
      .name { overflow-wrap: anywhere; }
      .place { display: inline-block; margin-left: 8px; padding: 1px 8px; border-radius: 10px; border: 1px solid var(--line); color: var(--muted); font-size: 12px; vertical-align: 1px; }
      .notes { display: block; color: var(--muted); font-size: 13px; margin-top: 2px; overflow-wrap: anywhere; white-space: pre-line; }
      .done .name { text-decoration: line-through; color: var(--muted); }

      .editing { display: block; border-bottom: 1px solid var(--line); }
      .editor { display: grid; gap: 8px; margin: 6px 0 10px; padding: 12px; border-radius: 10px; background: var(--field); }
      .editor label { display: grid; gap: 4px; font-size: 12px; color: var(--muted); }
      .editor .meta { margin: 0; font-size: 12px; color: var(--muted); }
      .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .grow { flex: 1; }
      .plain, .danger { height: 44px; padding: 0 14px; border-radius: 8px; }
      .plain { border: 1px solid var(--line); }
      .danger { color: var(--error-color, #db4437); }
      .danger.armed { background: var(--error-color, #db4437); color: #fff; }

      .empty { margin: 14px 0 6px; color: var(--muted); text-align: center; }
      .note { margin: 4px 0 12px; color: var(--muted); font-size: 14px; }
      p.err { margin: 4px 0 12px; color: var(--error-color, #db4437); font-size: 14px; }
      .undo, div.err { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 10px; padding: 0 4px 0 12px;
        min-height: 44px; border-radius: 8px; background: var(--field); font-size: 14px; }
      div.err { color: var(--error-color, #db4437); }
      .link { min-height: 44px; padding: 0 10px; color: var(--accent); font-weight: 600; font-size: 14px; }
      .link.armed { color: var(--error-color, #db4437); }

      .got { margin-top: 10px; }
      .gothead { display: flex; align-items: center; justify-content: space-between; }
      .toggle { display: inline-flex; align-items: center; gap: 6px; min-height: 44px; padding-right: 8px; color: var(--muted); font-size: 14px; }
      .toggle ha-icon { --mdc-icon-size: 20px; width: 44px; display: inline-flex; justify-content: center; margin-right: -6px; }

      .strip { display: grid; grid-template-columns: 34px minmax(0, 1fr) auto; align-items: center; column-gap: 8px; padding: 12px; min-height: 66px; box-sizing: border-box; }
      .strip.nav { cursor: pointer; }
      .strip .main { color: var(--accent); --mdc-icon-size: 22px; justify-self: center; }
      .strip .name { font-size: var(--tg-name-size, 12px); color: var(--muted); text-transform: var(--tg-name-transform, none); letter-spacing: var(--tg-name-spacing, normal);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .strip .value { font-size: 15px; font-weight: 700; color: var(--accent); text-shadow: var(--tg-glow, none); white-space: nowrap; }
      .strip .value.quiet { color: var(--muted); font-weight: 500; text-shadow: none; }
      .strip .sub { font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
      .strip .chev { color: var(--muted); --mdc-icon-size: 20px; }
      @media (prefers-reduced-motion: reduce) { .item.flash { animation: none; } .box { transition: none; } }
    `;
  }
}

if (!customElements.get("to-get-card")) customElements.define("to-get-card", ToGetCard);
window.customCards = window.customCards || [];
if (!window.customCards.find((c) => c.type === "to-get-card")) {
  window.customCards.push({ type: "to-get-card", name: "To Get", description: "Things to buy, get or order, and where each one is coming from.", preview: false, documentationURL: "https://github.com/ClermontDigital/ToGet" });
}
console.info(`%c TO-GET-CARD %c ${TG_VERSION} `, "color:#081C16;background:#3DDC97;font-weight:700", "color:#3DDC97;background:#081C16");
