// School lunch choices on the Arbor parent portal (arbor.sc) — unofficial, uses the same JSON endpoints as the web app.
// Usage: node scripts/arbor.mjs <command> [options]
//   week    [--child NAME|all] [--weeks N]                current choices per school day (default 3 weeks)
//   options --child NAME --date YYYY-MM-DD                meal options + prices for one day
//   balance [--child NAME]                                meals account balance
//   basket                                                what is in the Arbor basket
//   book    --child NAME --date D[,D...] --meal MEAL [--confirm]
//           MEAL: hot | baguette | packed | absent, or any text that matches exactly one option label
//           without --confirm: dry run (prints what would change, books nothing)
//           with --confirm: saves the choices; paid meals are checked out ONLY if the
//           meals balance covers the whole basket (amount to pay £0.00) — never a card payment.
// Config: $ARBOR_CONFIG_DIR/env (default ~/.config/arbor/env):
//   ARBOR_BASE_URL=https://your-school.uk.arbor.sc
//   ARBOR_CHILDREN=alice=123,bob=456        (name=student id, see README)
//   ARBOR_EMAIL=...   ARBOR_PASSWORD=...
//   ARBOR_MAX_LOGINS_PER_DAY=4              (optional)
// The session cookie is cached in session.json next to it; logs in only when the session has expired.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CONF = process.env.ARBOR_CONFIG_DIR || path.join(os.homedir(), '.config/arbor');
const SESSION = path.join(CONF, 'session.json');
const LOGINS = path.join(CONF, 'logins.log');
const ALIASES = { hot: /hot/i, baguette: /baguette/i, packed: /packed/i, absent: /absent/i };
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

const die = (msg, code = 1) => { console.log(JSON.stringify({ ok: false, error: msg })); process.exit(code); };
const out = (o) => console.log(JSON.stringify(o, null, 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- config ----------
const env = {};
try {
  for (const l of fs.readFileSync(path.join(CONF, 'env'), 'utf8').split('\n')) {
    const m = l.match(/^\s*(?:export\s+)?(\w+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
} catch {}
const BASE = (env.ARBOR_BASE_URL || '').replace(/\/+$/, '');
if (!/^https:\/\/[\w.-]+\.arbor\.sc$/.test(BASE)) die(`ARBOR_BASE_URL missing or not an https://….arbor.sc address in ${CONF}/env`, 3);
const CHILDREN = Object.fromEntries((env.ARBOR_CHILDREN || '').split(',').map((s) => s.split('=').map((x) => x.trim()))
  .filter(([n, id]) => n && /^\d+$/.test(id || '')).map(([n, id]) => [n.toLowerCase(), Number(id)]));
if (!Object.keys(CHILDREN).length) die(`ARBOR_CHILDREN missing in ${CONF}/env (e.g. ARBOR_CHILDREN=alice=123,bob=456)`, 3);
const MAX_LOGINS_PER_DAY = Number(env.ARBOR_MAX_LOGINS_PER_DAY) || 4;

// ---------- args ----------
const [cmd, ...rest] = process.argv.slice(2);
const opt = {};
for (let i = 0; i < rest.length; i++) {
  if (!rest[i].startsWith('--')) continue;
  const k = rest[i].slice(2);
  opt[k] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
}
const childId = (name) => {
  const id = CHILDREN[String(name || '').toLowerCase()];
  if (!id) die(`--child must be one of: ${Object.keys(CHILDREN).join(', ')}`, 2);
  return id;
};

// ---------- session / http ----------
let jar = {};
try { jar = JSON.parse(fs.readFileSync(SESSION, 'utf8')); } catch {}
const saveJar = () => { fs.mkdirSync(CONF, { recursive: true, mode: 0o700 }); fs.writeFileSync(SESSION, JSON.stringify(jar), { mode: 0o600 }); };
const cookieHeader = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
const absorb = (res) => { for (const c of res.headers.getSetCookie?.() ?? []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim(); } };

async function raw(method, url, body) {
  await sleep(400); // be gentle
  const res = await fetch(BASE + url, {
    method, redirect: 'manual',
    headers: { 'User-Agent': UA, 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json, text/javascript, */*', Cookie: cookieHeader(),
      ...(body ? { 'Content-Type': 'application/json', Origin: BASE } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  absorb(res);
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}
const unauth = (r) => r.status === 401 || r.status === 403 || (r.status >= 300 && r.status < 400) ||
  (r.json && r.json.success === false && /not allowed|log ?in/i.test(r.json.message || ''));

async function login() {
  const today = new Date().toISOString().slice(0, 10);
  let log = []; try { log = fs.readFileSync(LOGINS, 'utf8').split('\n').filter(Boolean); } catch {}
  if (log.filter((l) => l.startsWith(today)).length >= MAX_LOGINS_PER_DAY) die(`login limit reached (${MAX_LOGINS_PER_DAY}/day) — ask a parent to check`, 4);
  if (!env.ARBOR_EMAIL || !env.ARBOR_PASSWORD) die(`credentials missing in ${CONF}/env`, 3);
  jar = {};
  await raw('GET', '/');
  const r = await raw('POST', '/auth/login?lang=en', { items: [{ username: env.ARBOR_EMAIL, password: env.ARBOR_PASSWORD }] });
  const ok = r.json?.items?.[0]?.logged_in === true || r.json?.success === true;
  fs.mkdirSync(CONF, { recursive: true, mode: 0o700 });
  fs.appendFileSync(LOGINS, `${new Date().toISOString()} ${ok ? 'OK' : 'FAIL'}\n`, { mode: 0o600 });
  if (!ok) die(`login failed: ${r.json?.items?.[0]?.message || r.json?.message || 'HTTP ' + r.status}`, 4);
  saveJar();
}

async function call(method, url, body) {
  let r = Object.keys(jar).length ? await raw(method, url, body) : { status: 401 };
  if (unauth(r)) { await login(); r = await raw(method, url, body); }
  if (unauth(r)) die(`not authorised for ${url} after login`, 4);
  if (r.status !== 200 || !r.json) die(`unexpected HTTP ${r.status} from ${url}`);
  saveJar();
  return r.json;
}

// ---------- page parsing ----------
function walk(node, fn) {
  if (Array.isArray(node)) node.forEach((n) => walk(n, fn));
  else if (node && typeof node === 'object') { fn(node); Object.values(node).forEach((v) => walk(v, fn)); }
}
const clean = (s) => String(s ?? '').replace(/<[^>]+>/g, '').replace(/ /g, ' ').trim();
const londonDate = (ts) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date(ts * 1000));
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

async function menuId(sid) {
  const page = await call('GET', `/guardians/meal-ui/meal-choices/student-id/${sid}?format=javascript`);
  const m = JSON.stringify(page).match(/meal-rotation-menu-id\\?\/(\d+)/);
  if (!m) die('no lunch menu available for this child');
  return m[1];
}

async function week(sid, weeks) {
  const mid = await menuId(sid);
  const page = await call('GET', `/guardians/meal-ui/setup-meal-choices/meal-rotation-menu-id/${mid}/student-id/${sid}?format=javascript`);
  const res = [];
  walk(page, (n) => {
    if (n.componentName !== 'Arbor.container.Section' || !/^Week beginning/.test(clean(n.props?.title))) return;
    if (res.length >= weeks) return;
    const [, d, mon, y] = clean(n.props.title).match(/(\d+)\s+(\w{3})\s+(\d{4})/);
    const days = [];
    walk(n.content, (r) => {
      if (r.componentName !== 'Arbor.container.PropertyRow') return;
      const p = r.props, i = DAYS.indexOf(clean(p.fieldLabel));
      const date = p.url?.match(/date\/(\d{4}-\d{2}-\d{2})/)?.[1] ??
        (i >= 0 ? new Date(Date.UTC(+y, MONTHS[mon], +d + i)).toISOString().slice(0, 10) : null);
      days.push({ date, day: clean(p.fieldLabel), choice: clean(p.value), note: clean(p.description) || undefined, editable: !!p.url });
    });
    res.push({ week: `${y}-${String(MONTHS[mon] + 1).padStart(2, '0')}-${d.padStart(2, '0')}`, days });
  });
  return { menu: mid, weeks: res };
}

// The "setup-meal-choice" slideover for a date holds one field per school day from that date to the end of its week.
async function slideover(sid, mid, date) {
  const page = await call('GET', `/guardians/meal-ui/setup-meal-choice/meal-rotation-menu-id/${mid}/student-id/${sid}/date/${date}?format=javascript`);
  const fields = {}, days = [];
  let actionUrl = null;
  walk(page, (n) => {
    const p = n.props || {};
    if (n.componentName === 'Arbor.ExtNative.Hidden' && ['student', 'is_mobile_app'].includes(p.name)) fields[p.name] = { value: p.value };
    if (n.componentName === 'Arbor.formfield.TagField' && /^meal_provision_\d+$/.test(p.name)) {
      const opts = (p.options || []).map((o) => ({ value: o.fields.value.value, label: clean(o.fields.label.value), selected: !!o.fields.selected.value }));
      const cur = opts.find((o) => o.selected && o.value);
      fields[p.name] = { value: cur ? cur.value : null };
      days.push({ field: p.name, date: londonDate(+p.name.split('_').pop()), current: cur?.label ?? 'No choice selected', options: opts.filter((o) => o.value) });
    }
    if (p.currentAction?.actionUrl?.includes('process-meal-provisions')) actionUrl = p.currentAction.actionUrl;
  });
  if (!actionUrl || !days.length) die(`no editable meal choice for ${date} (deadline passed or holiday?)`);
  return { fields, days, actionUrl };
}

// Pick the option for --meal: an alias (hot/baguette/packed/absent) or text matching exactly one option label.
function pickOption(options, meal, date) {
  const re = ALIASES[meal.toLowerCase()];
  const hits = options.filter((o) => (re ? re.test(o.label) : o.label.toLowerCase().includes(meal.toLowerCase())));
  if (hits.length === 1) return hits[0];
  die(`${hits.length ? 'more than one' : 'no'} option matches "${meal}" on ${date}: ${options.map((o) => o.label).join(' | ')}`);
}

async function basket() {
  const page = await call('GET', '/guardians/my-mis-ui/my-basket?format=javascript');
  const rows = [];
  let payment = null, total = null, banner = null;
  walk(page, (n) => {
    const p = n.props || {};
    if (n.componentName === 'Arbor.container.PropertyRow') rows.push({ item: clean(p.value), amount: clean(p.description) });
    if (n.componentName === 'Arbor.ExtNative.Hidden' && p.name === 'payment') payment = String(p.value);
    if (n.componentName === 'Arbor.container.SimpleText' && typeof n.content === 'string' && !banner) banner = clean(n.content);
    if (p.columnTitle?.title) total = clean(p.columnTitle.title);
  });
  const items = rows.filter((r) => r.item);
  return { total, banner, items, payment, empty: items.length === 0 };
}

async function balance(sid) {
  const k = await call('GET', `/guardians/customer-account/meals-balance-kpi/student-id/${sid}`);
  return k?.[0]?.mainValue ?? null;
}

// ---------- commands ----------
const children = (c) => (!c || c === 'all' ? Object.entries(CHILDREN) : [[String(c).toLowerCase(), childId(c)]]);

if (cmd === 'week') {
  const r = {};
  for (const [name, sid] of children(opt.child)) r[name] = (await week(sid, Number(opt.weeks) || 3)).weeks;
  out(r);
} else if (cmd === 'options') {
  if (!opt.date) die('--date required', 2);
  const sid = childId(opt.child);
  const s = await slideover(sid, await menuId(sid), opt.date);
  out(s.days.find((d) => d.date === opt.date) ?? die(`${opt.date} not editable`));
} else if (cmd === 'balance') {
  const r = {};
  for (const [name, sid] of children(opt.child)) r[name] = await balance(sid);
  out(r);
} else if (cmd === 'basket') {
  out(await basket());
} else if (cmd === 'book') {
  const sid = childId(opt.child);
  if (!opt.meal || opt.meal === true) die(`--meal required (${Object.keys(ALIASES).join(', ')} or part of an option label)`, 2);
  const dates = String(opt.date || '').split(',').map((s) => s.trim()).filter(Boolean).sort();
  if (!dates.length || dates.some((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d))) die('--date YYYY-MM-DD[,YYYY-MM-DD...] required', 2);
  const mid = await menuId(sid);
  const changes = [], posts = [];
  const todo = new Set(dates);
  for (const d of dates) {
    if (!todo.has(d)) continue; // already covered by an earlier slideover in the same week
    const s = await slideover(sid, mid, d);
    for (const day of s.days) {
      if (!todo.has(day.date)) continue;
      todo.delete(day.date);
      const o = pickOption(day.options, String(opt.meal), day.date);
      changes.push({ date: day.date, from: day.current, to: o.label });
      s.fields[day.field] = { value: o.value };
    }
    posts.push(s);
  }
  if (todo.size) die(`not editable (deadline passed, holiday or out of range): ${[...todo].join(', ')}`);
  if (!opt.confirm) { out({ ok: true, dryRun: true, child: opt.child, changes, balance: await balance(sid) }); process.exit(0); }

  const messages = [];
  for (const s of posts) {
    const r = await call('POST', `${s.actionUrl}/?format=json`, { fields: s.fields });
    if (!r.success) die(`Arbor rejected the meal choices: ${clean(JSON.stringify(r.notifications || r.message))}`);
    messages.push(...(r.notifications || []).map((n) => clean(n.message)));
  }
  const b = await basket();
  let checkout = 'not needed (nothing in basket — e.g. free school meals)';
  if (!b.empty) {
    const onlyMeals = b.items.every((i) => /\(Meals\)/.test(i.item));
    if (b.payment !== '0' || !onlyMeals) {
      out({ ok: false, child: opt.child, changes, messages, basket: b,
        error: 'Choices are in the basket but NOT confirmed: checkout needs a card payment or the basket has non-meal items. A parent must top up / check out in Arbor.' });
      process.exit(5);
    }
    const r = await call('POST', '/guardians/basket/checkout-meals/?format=json', { fields: { payment: { value: '0' } } });
    if (!r.success) die('checkout from meals balance failed — choices left in basket');
    checkout = 'confirmed, paid from meals balance';
  }
  // verify
  const after = (await week(sid, 12)).weeks.flatMap((w) => w.days);
  const verified = changes.map((c) => ({ ...c, now: after.find((d) => d.date === c.date)?.choice ?? '?' }));
  out({ ok: true, child: opt.child, checkout, verified, messages, balance: await balance(sid) });
} else {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).join('\n'));
  process.exit(cmd ? 2 : 0);
}
