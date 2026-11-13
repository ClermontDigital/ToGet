// Drive the To Get card in headless Chrome against the integration's real WebSocket handlers (see server.py):
// check how it behaves, and retake the made-up-data README screenshots in images/.
//
//   pip install -r requirements_test.txt && npm install --no-save puppeteer-core
//   node tests/card/drive.cjs            (starts tests/card/server.py itself)
//
// Environment: CHROME = path to Chrome or Chromium, PYTHON = the Python that has Home Assistant installed,
// PUPPETEER = where to load puppeteer-core from, PORT = the harness port (8799), SHOTS=0 to leave the
// screenshots in images/ alone.
const { spawn } = require("node:child_process");
const path = require("node:path");

const puppeteer = require(process.env.PUPPETEER || "puppeteer-core");
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PYTHON = process.env.PYTHON || "python3";
const PORT = process.env.PORT || "8799";
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(__dirname, "..", "..");
const IMAGES = path.join(ROOT, "images");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : "  — " + detail}`); };
const get = async (p) => (await fetch(`${BASE}${p}`)).json();
const openItems = async () => (await get("/store"))[0]?.items.filter((i) => i.status === "needs_action") || [];

async function main() {
  const server = spawn(PYTHON, [path.join(__dirname, "server.py")], { stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, PORT } });
  let browser;
  try {
    for (let i = 0; ; i++) {
      try { await fetch(`${BASE}/reset`); break; } catch (err) { if (i > 80) throw new Error("the harness server didn't start"); await sleep(250); }
    }
    browser = await puppeteer.launch({ executablePath: CHROME, headless: "new" });
    const p = await browser.newPage();
    const errors = [];
    p.on("pageerror", (e) => errors.push(e.message));
    await p.evaluateOnNewDocument(() => {
      window.R = () => window.card?.shadowRoot;
      window.rgbOf = (css) => { const c = document.createElement("canvas"); c.width = c.height = 1; const x = c.getContext("2d"); x.fillStyle = css; x.fillRect(0, 0, 1, 1); return [...x.getImageData(0, 0, 1, 1).data].slice(0, 3); };
      window.contrastOf = (el) => {
        const lum = (rgb) => rgb.map((c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
        const cs = getComputedStyle(el); const a = lum(window.rgbOf(cs.color)); const b = lum(window.rgbOf(cs.backgroundColor));
        return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
      };
    });

    const open = async (qs = "theme=dark", w = 560, h = 1000, data = "demo") => {
      await fetch(`${BASE}/reset?data=${data}`);
      await p.setViewport({ width: w, height: h, deviceScaleFactor: 2 });
      await p.goto(`${BASE}/?${qs}`, { waitUntil: "networkidle0" });
      await sleep(300);
    };
    const text = (sel) => p.evaluate((s) => window.R()?.querySelector(s)?.textContent.trim().replace(/\s+/g, " ") ?? null, sel);
    const texts = (sel) => p.evaluate((s) => [...(window.R()?.querySelectorAll(s) || [])].map((e) => e.textContent.trim().replace(/\s+/g, " ")), sel);
    const has = (sel) => p.evaluate((s) => !!window.R()?.querySelector(s), sel);
    const attr = (sel, a) => p.evaluate((s, a) => window.R()?.querySelector(s)?.getAttribute(a) ?? null, sel, a);
    const tap = async (sel, wait = 300) => { await p.evaluate((s) => window.R().querySelector(s).click(), sel); await sleep(wait); };
    const uidOf = async (name) => (await get("/store"))[0].items.find((i) => i.summary === name)?.uid;
    const type = async (sel, value) => {
      await p.evaluate((s) => { const el = window.R().querySelector(s); el.focus(); el.value = ""; }, sel);
      await p.keyboard.type(value);
    };
    const groups = () => texts(".group h3 > span:first-child");
    const names = () => texts(".list:not(.gotlist) .item .name");
    const shot = async (file) => { if (process.env.SHOTS !== "0") { const card = await p.$("to-get-card"); await card.screenshot({ path: path.join(IMAGES, file) }); } };

    // The list --------------------------------------------------------------------------------
    await open("theme=dark");
    check("title and count", (await text(".title")) === "To get" && (await text(".count > [aria-hidden]")) === "7" && (await text(".count .vh")) === "7 things to get");
    check("grouped by place, A to Z, with no place last", JSON.stringify(await groups()) === JSON.stringify(["Bunnings", "Online", "Woolies", "Anywhere"]), JSON.stringify(await groups()));
    check("notes shown under the name", (await text('[data-uid] .notes')) === "clear, for the shower");
    check("place chips with counts", JSON.stringify(await texts(".chip")) === JSON.stringify(["All 7", "Bunnings 2", "Online 1", "Woolies 2", "Anywhere 2"]), JSON.stringify(await texts(".chip")));
    check("got is folded away", (await text(".toggle")) === "Got 3" && !(await has(".gotlist")));

    // Adding
    await type('[data-field="summary"]', "Sandpaper");
    await type('[data-field="place"]', "Bunnings");
    await p.keyboard.press("Enter");
    await sleep(350);
    let items = await openItems();
    check("Enter adds it, with the place typed", items.some((i) => i.summary === "Sandpaper" && i.place === "Bunnings"));
    check("added under its place", (await texts('.group[data-key="g:bunnings"] .name')).includes("Sandpaper"));
    check("the boxes empty and the name box keeps focus", await p.evaluate(() => {
      const r = window.R(); return r.querySelector('[data-field="summary"]').value === "" && r.querySelector('[data-field="place"]').value === ""
        && r.activeElement === r.querySelector('[data-field="summary"]');
    }));
    check("count goes up", (await text(".count > [aria-hidden]")) === "8");

    await type('[data-field="summary"]', "dog food");
    await p.evaluate(() => window.R().querySelector('[data-field="summary"]').dispatchEvent(new Event("input", { bubbles: true })));
    check("a thing got before shows where it came from last", (await attr('[data-field="place"]', "placeholder")) === "Produce store (last time)");
    await p.keyboard.press("Enter");
    await sleep(350);
    items = await openItems();
    check("... and takes that place", items.some((i) => i.summary === "dog food" && i.place === "Produce store"));

    await type('[data-field="summary"]', "  MILK ");
    await p.keyboard.press("Enter");
    await sleep(250);
    check("the same thing again isn't added twice", (await openItems()).filter((i) => i.summary.toLowerCase() === "milk").length === 1);
    check("... it's pointed out instead", await has(".item.flash"));

    await tap(".addbtn");
    check("Add with nothing typed sends nothing", (await openItems()).length === 9 && (await p.evaluate(() => window.R().activeElement?.dataset.field)) === "summary");

    // Ticking off
    const milk = await uidOf("Milk");
    await tap(`.tick[data-uid="${milk}"]`, 400);
    check("ticking off moves it to got", (await get("/store"))[0].items.find((i) => i.uid === milk).status === "completed" && !(await names()).includes("Milk"));
    check("... with an undo", (await text(".undo span")) === "Got Milk.");
    await tap('[data-act="undo"]', 400);
    check("undo puts it back", (await get("/store"))[0].items.find((i) => i.uid === milk).status === "needs_action" && (await names()).includes("Milk"));

    // Changing one
    const bread = await uidOf("Bread");
    await tap(`.label[data-uid="${bread}"]`);
    check("tapping a thing opens it", (await has(".editor")) && (await p.evaluate(() => window.R().activeElement?.dataset.field)) === "e-summary");
    await p.evaluate(() => { const r = window.R(); const set = (f, v) => { const el = r.querySelector(`[data-field="${f}"]`); el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); }; set("e-place", "IGA"); set("e-notes", "sourdough"); });
    await tap('.editor [type="submit"]', 350);
    let b = (await get("/store"))[0].items.find((i) => i.uid === bread);
    check("saving changes its place and notes", b.place === "IGA" && b.notes === "sourdough" && !(await has(".editor")));
    check("... and it moves to its new place", (await groups()).includes("IGA"));
    await tap(`.label[data-uid="${bread}"]`);
    await p.evaluate(() => { const el = window.R().querySelector('[data-field="e-summary"]'); el.value = "Nothing"; el.dispatchEvent(new Event("input", { bubbles: true })); });
    await p.keyboard.press("Escape");
    await sleep(200);
    check("Escape leaves it as it was", (await get("/store"))[0].items.find((i) => i.uid === bread).summary === "Bread" && !(await has(".editor")));
    check("... and puts focus back on it", await p.evaluate((u) => window.R().activeElement?.dataset.uid === u, bread));

    // Removing one: two taps
    await tap(`.label[data-uid="${bread}"]`);
    await tap('.editor [data-act="delete"]');
    check("one tap on Remove asks again", (await text('.editor [data-act="delete"]')) === "Tap again to remove" && !!(await uidOf("Bread")));
    await tap('.editor [data-act="delete"]', 350);
    check("the second removes it", !(await uidOf("Bread")) && !(await names()).includes("Bread"));

    // Looking at one place
    await tap('.chip[data-key="woolies"]');
    check("a place chip shows only that place", JSON.stringify(await names()) === JSON.stringify(["Milk"]) && !(await has(".group")));
    check("... and new things default to it", (await attr('[data-field="place"]', "placeholder")) === "Woolies");
    await type('[data-field="summary"]', "Eggs");
    await p.keyboard.press("Enter");
    await sleep(350);
    check("... and go there", (await openItems()).some((i) => i.summary === "Eggs" && i.place === "Woolies") && (await names()).includes("Eggs"));
    await type('[data-field="summary"]', "Fuel filter");
    await type('[data-field="place"]', "Repco");
    await p.keyboard.press("Enter");
    await sleep(350);
    check("something for another place shows everything again", (await attr('.chip[data-key="*"]', "aria-pressed")) === "true" && (await names()).includes("Fuel filter"));

    // Got
    await tap('[data-act="toggle-got"]');
    // (Dog food went back on the list when it was added again above.)
    check("got opens, newest first", JSON.stringify(await texts(".gotlist .name")) === JSON.stringify(["Coffee", "Cable ties"]), JSON.stringify(await texts(".gotlist .name")));
    check("... saying where from and when", (await text(".gotlist .item .notes")) === "Woolies · got today · by Steve", await text(".gotlist .item .notes"));
    const coffee = await uidOf("Coffee");
    await tap(`.tick[data-uid="${coffee}"]`, 400);
    check("ticking a got thing puts it back", (await get("/store"))[0].items.find((i) => i.uid === coffee).status === "needs_action");
    await tap('[data-act="clear"]');
    check("Clear asks again", (await text('[data-act="clear"]')) === "Tap again to clear" && (await get("/store"))[0].items.some((i) => i.status === "completed"));
    await tap('[data-act="clear"]', 400);
    check("the second tap clears what's been got", !(await get("/store"))[0].items.some((i) => i.status === "completed") && !(await has(".got")));

    // Someone else changes the list while a name is half typed
    await type('[data-field="summary"]', "Half ty");
    await p.evaluate(() => window.elsewhere({ type: "to_get/add", entry_id: "demo", summary: "Rope", place: "Bunnings" }));
    await sleep(250);
    check("another device's change shows up", (await names()).includes("Rope"));
    check("... without losing what's being typed, or the focus", await p.evaluate(() => {
      const r = window.R(); const box = r.querySelector('[data-field="summary"]'); return box.value === "Half ty" && r.activeElement === box;
    }));
    check("no page errors so far", !errors.length, errors.join(" | "));

    // Typing, editing and other people ---------------------------------------------------------
    await open("theme=dark");
    await type('[data-field="summary"]', "Eggs");
    await p.evaluate(() => window.R().querySelector('[data-field="place"]').focus());
    await p.evaluate(() => window.elsewhere({ type: "to_get/add", entry_id: "demo", summary: "Rope" }));
    await sleep(250);
    check("a name typed, then the place box: another device's change keeps the name", (await p.evaluate(() => window.R().querySelector('[data-field="summary"]').value)) === "Eggs");
    const batteries = await uidOf("Batteries AA");
    await tap(`.tick[data-uid="${batteries}"]`, 300);
    await type('[data-field="summary"]', "Tape");
    await p.evaluate(() => window.R().querySelector('[data-field="place"]').focus());
    await sleep(6300);   // the undo goes after 6 s, and the card redraws
    check("... and so does the undo going away", !(await has(".undo")) && (await p.evaluate(() => window.R().querySelector('[data-field="summary"]').value)) === "Tape");

    await open("theme=dark");
    const screws = await uidOf("Screws 40 mm");
    await tap(`.label[data-uid="${screws}"]`);
    await p.evaluate(() => window.R().querySelector('[data-field="e-notes"]').focus());
    await p.evaluate(() => window.elsewhere({ type: "to_get/update", entry_id: "demo", uid: window.R().querySelector('.label[data-act="edit"]').dataset.uid, done: true }));
    await sleep(250);
    check("the editor keeps focus when something above it is ticked elsewhere", await p.evaluate(() => window.R().activeElement?.dataset.field === "e-notes"));
    await p.evaluate((u) => window.elsewhere({ type: "to_get/update", entry_id: "demo", uid: u, place: "Mitre 10" }), screws);
    await p.evaluate(() => { const el = window.R().querySelector('[data-field="e-notes"]'); el.value = "galvanised\nfor the deck"; el.dispatchEvent(new Event("input", { bubbles: true })); });
    await tap('.editor [type="submit"]', 350);
    let s = (await get("/store"))[0].items.find((i) => i.uid === screws);
    check("saving only sends what was changed: someone else's new place stays", s.place === "Mitre 10" && s.notes === "galvanised\nfor the deck", JSON.stringify(s));
    check("notes keep their lines", (await p.evaluate((u) => getComputedStyle(window.R().querySelector(`.label[data-uid="${u}"] .notes`)).whiteSpace, screws)) === "pre-line");

    await open("theme=dark");
    await tap('.chip[data-key="woolies"]');
    await type('[data-field="summary"]', "silicone");
    await p.evaluate(() => window.R().querySelector('[data-field="summary"]').dispatchEvent(new Event("input", { bubbles: true })));
    check("picking a place doesn't claim things already on the list", (await attr('[data-field="place"]', "placeholder")) === "Where from?");
    await p.keyboard.press("Enter");
    await sleep(350);
    check("... so adding one of those doesn't move it", (await openItems()).find((i) => i.summary === "Silicone").place === "Bunnings");
    await tap('.chip[data-key=""]');
    check("Anywhere picked: new things go to no place", (await attr('[data-field="place"]', "placeholder")) === "Anywhere");
    await type('[data-field="summary"]', "Dog food");
    await p.keyboard.press("Enter");
    await sleep(350);
    check("... even one that came from somewhere last time", (await openItems()).find((i) => i.summary === "Dog food").place === "");

    await fetch(`${BASE}/fail?n=1`);
    await type('[data-field="summary"]', "Sandpaper");
    await type('[data-field="place"]', "Bunnings");
    await p.keyboard.press("Enter");
    await sleep(350);
    check("a failed add gives back what was typed", await p.evaluate(() => {
      const r = window.R(); return r.querySelector('[data-field="summary"]').value === "Sandpaper" && r.querySelector('[data-field="place"]').value === "Bunnings";
    }));

    await open("theme=dark");
    const first = await p.evaluate(() => window.R().querySelectorAll('.tick[data-act="tick"]')[0].dataset.uid);
    const second = await p.evaluate(() => window.R().querySelectorAll('.tick[data-act="tick"]')[1].dataset.uid);
    await p.evaluate((u) => window.R().querySelector(`.tick[data-uid="${u}"]`).focus(), first);
    await p.keyboard.press("Enter");
    await sleep(400);
    check("ticking from the keyboard moves focus to the next thing", await p.evaluate((u) => window.R().activeElement?.dataset.uid === u, second));
    await p.evaluate(() => { window.card.remove(); });
    await p.evaluate(() => document.getElementById("wrap").appendChild(window.card));
    await sleep(300);
    check("the undo doesn't outlive the card leaving the page", !(await has(".undo")));

    await open("theme=dark&hide_got=1");
    check("hide_got leaves out what's been got", !(await has(".got")));

    // Failures and states -----------------------------------------------------------------------
    await open("theme=dark");
    await fetch(`${BASE}/fail?n=1`);
    const matches = await uidOf("Matches");
    await tap(`.tick[data-uid="${matches}"]`, 400);
    check("a failed change says so", ((await text("div.err span")) || "").startsWith("Saving to Home Assistant failed"));
    check("... and goes back to how it was", (await names()).includes("Matches"));
    await tap('[data-act="dismiss"]');
    check("the message can be put away", !(await has("div.err")));

    await p.evaluate(() => { window.offline = true; });
    await tap(`.tick[data-uid="${matches}"]`, 300);
    check("offline says to check the connection", (await text("div.err span")) === "Couldn't reach Home Assistant. Check the connection and try again.");
    await p.evaluate(() => { window.offline = false; });

    await open("theme=dark");
    await fetch(`${BASE}/readonly?on=1`);
    await p.reload({ waitUntil: "networkidle0" });
    await sleep(300);
    check("a read-only user sees the list", (await names()).length === 7 && (await text(".note")) === "Your Home Assistant user can look at this list but not change it.");
    check("... with nothing to change it with", !(await has("form.add")) && (await p.evaluate(() => [...window.R().querySelectorAll(".tick")].every((b) => b.disabled))) && !(await has('[data-act="edit"]')));

    await open("theme=dark", 560, 900, "none");
    check("no list yet says where to add one", ((await text(".note")) || "").startsWith("There's no list yet"));

    await fetch(`${BASE}/reset`);
    await fetch(`${BASE}/unload?on=1`);
    await p.reload({ waitUntil: "networkidle0" });
    await sleep(300);
    check("while To Get is loading it says so", (await text(".note")) === "Waiting for To Get to load in Home Assistant…");
    await fetch(`${BASE}/unload?on=0`);
    await sleep(2600);
    check("... and shows the list once it's there", (await names()).length === 7);

    await p.evaluate(() => window.reconnect());
    await sleep(300);
    await p.evaluate(() => window.elsewhere({ type: "to_get/add", entry_id: "demo", summary: "Tape", place: "Bunnings" }));
    await sleep(250);
    check("after a reconnect it subscribes again and keeps up", (await names()).includes("Tape") && (await p.evaluate(() => window.subs.length)) === 1);

    await open("theme=dark", 560, 900, "empty");
    check("an empty list says so", (await text(".empty")) === "Nothing to get. Add what you need above." && !(await has(".chips")));
    await type('[data-field="summary"]', "Milk");
    await p.keyboard.press("Enter");
    await sleep(350);
    check("one thing with no place: no groups or chips", JSON.stringify(await names()) === JSON.stringify(["Milk"]) && !(await has(".group")) && !(await has(".chips")));

    // Looks -------------------------------------------------------------------------------------------
    await open("theme=navy", 560, 1000);
    check("the Add button's text reads on the accent", (await p.evaluate(() => window.contrastOf(window.R().querySelector(".addbtn")))) >= 4.5);
    check("the count's text reads on the accent", (await p.evaluate(() => window.contrastOf(window.R().querySelector(".count")))) >= 4.5);
    check("card-mod's element survives drawing", await has("#from-card-mod"));
    check("tick targets are 44 px", await p.evaluate(() => [...window.R().querySelectorAll(".tick")].every((b) => { const r = b.getBoundingClientRect(); return r.width >= 44 && r.height >= 44; })));
    await shot("list.png");
    await tap('[data-act="toggle-got"]');
    const silicone = await uidOf("Silicone");
    await tap(`.label[data-uid="${silicone}"]`);
    await shot("editing.png");

    await open("theme=navy&w=340", 390, 900);
    check("at phone width nothing runs off the side", await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth && [...window.R().querySelectorAll("input, button")].every((e) => e.getBoundingClientRect().right <= innerWidth)));
    check("... and the name box gets its own row", await p.evaluate(() => {
      const r = window.R(); const a = r.querySelector('[data-field="summary"]').getBoundingClientRect(); const b = r.querySelector('[data-field="place"]').getBoundingClientRect();
      return b.top >= a.bottom;
    }));
    await shot("phone.png");

    await open("theme=light", 560, 1000);
    check("light theme: the accent text reads", (await p.evaluate(() => window.contrastOf(window.R().querySelector(".addbtn")))) >= 3);

    // The count strip ---------------------------------------------------------------------------------
    await open("theme=navy&view=count&w=380&navigation_path=/lovelace/lists", 440, 200);
    check("the strip counts and names the first few", (await text(".value")) === "7 things" && (await text(".sub")) === "Silicone, Screws 40 mm, Milk +4");
    check("... and is a link", (await attr(".strip", "role")) === "link" && (await attr(".strip", "tabindex")) === "0");
    await shot("strip.png");
    await p.evaluate(() => window.elsewhere({ type: "to_get/add", entry_id: "demo", summary: "Rope" }));
    await sleep(250);
    check("the strip keeps up", (await text(".value")) === "8 things");
    await tap(".strip");
    check("tapping it goes to the list", await p.evaluate(() => location.pathname === "/lovelace/lists"));
    await p.evaluate(() => window.R().querySelector(".strip").focus());
    await p.evaluate(() => history.replaceState(null, "", "/"));
    await p.keyboard.press("Enter");
    check("... and so does Enter", await p.evaluate(() => location.pathname === "/lovelace/lists"));

    await open("theme=navy&view=count&w=172&navigation_path=/lovelace/lists", 260, 200, "empty");
    check("a narrow strip drops the arrow and fits what it says", !(await p.evaluate(() => !!window.R().querySelector(".chev")?.offsetWidth))
      && (await p.evaluate(() => { const v = window.R().querySelector(".value"); return v.scrollWidth <= v.clientWidth && v.textContent === "Nothing to get"; })));
    check("... and is still a link", (await attr(".strip", "role")) === "link");

    await open("theme=dark&view=count", 440, 200, "empty");
    check("nothing to get says so, with no link", (await text(".value")) === "Nothing to get" && !(await has(".chev")) && (await attr(".strip", "role")) === null);
    check("no page errors", !errors.length, errors.join(" | "));
  } finally {
    await browser?.close();
    server.kill();
  }
  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
