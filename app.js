import {
  recommend, needVector, unservableGaps, shareForMeal, cronometerEntry,
  deliversFor, mergeConsumed, describeServing,
} from './recommend.mjs'
import {
  parseCronometerCsv, datesInCsv, parseHealthPayload, EXTRA_LABELS, CronometerParseError,
} from './cronometer.mjs'

const PROFILE_KEY = 'utdining.profile'

// Energy and macro targets ship at zero on purpose: they are personal, this repo is
// public, and a target of 0 simply means "don't score this nutrient". Set them once in
// Prefs — copy them off your own Cronometer targets page — and they stay on the phone.
//
// The rest are published reference values (RDA / daily-value / upper limit), not anyone's
// personal figures, so they make the app useful out of the box.
const DEFAULT_PROFILE = {
  version: 1,
  targets: {
    kcal: 0,              // set in Prefs
    protein_g: 0,         // set in Prefs
    carb_g: 0,            // set in Prefs
    fat_g: 0,             // set in Prefs
    fiber_g: 38,          // RDA, adult male
    sodium_mg: 2300,      // upper limit — sodium is a budget to spend, not a goal to hit
    satfat_g: 20,         // daily value
    addedsugar_g: 50,     // daily value
    vitd_mcg: 15,         // 600 IU
    calcium_mg: 1300,
    iron_mg: 11,
    potassium_mg: 3000,
  },
  extraTargets: {
    zinc_mg: 11, magnesium_mg: 410, b12_mcg: 2.4, folate_mcg: 400,
    vitc_mg: 75, vita_mcg: 900, vite_mg: 15, vitk_mcg: 75,
    selenium_mcg: 55, phosphorus_mg: 1250, copper_mg: 0.9,
  },
  restrictions: ['Beef', 'Pork'],
  refluxFilter: false,
  ingredientBlocklist: [],
  itemWeights: {},
  penaltyWeightOverrides: {},
  consumed: null,
  extras: null,
  // What was eaten straight from the app, kept separate from the imported baseline so the
  // two can never be confused for each other. See logToday().
  log: null,
}

const NUTRIENT_LABEL = {
  kcal: 'Calories', protein_g: 'Protein (g)', carb_g: 'Carbs (g)', fat_g: 'Fat (g)',
  fiber_g: 'Fibre (g)', sodium_mg: 'Sodium (mg)', satfat_g: 'Sat fat (g)',
  addedsugar_g: 'Added sugar (g)', vitd_mcg: 'Vitamin D (mcg)', calcium_mg: 'Calcium (mg)',
  iron_mg: 'Iron (mg)', potassium_mg: 'Potassium (mg)',
}

const RESTRICTION_ICONS = [
  'Beef', 'Pork', 'Milk', 'Eggs', 'Fish', 'Shellfish', 'Peanuts', 'TreeNuts',
  'Sesame', 'Soy', 'Wheat',
]

const $ = (sel) => document.querySelector(sel)

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let profile = loadProfile()
let menu = null
let ratingItem = null

function loadProfile() {
  try {
    const saved = JSON.parse(localStorage.getItem(PROFILE_KEY))
    if (saved?.version === DEFAULT_PROFILE.version) return { ...DEFAULT_PROFILE, ...saved }
  } catch { /* corrupt storage falls back to defaults */ }
  return structuredClone(DEFAULT_PROFILE)
}

const saveProfile = () => localStorage.setItem(PROFILE_KEY, JSON.stringify(profile))

const todayIso = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date())

function currentMealByClock() {
  const hour = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', hour: 'numeric', hour12: false,
  }).format(new Date()))
  if (hour < 11) return 'Breakfast'
  if (hour < 16) return 'Lunch'
  return 'Dinner'
}

/** How many meals are still ahead today, counting the one being planned. Dinner is 1,
 *  so the last meal of the day legitimately gets the whole remainder. */
function mealsLeftToday() {
  const day = currentHall()?.days.find((d) => d.date === todayIso())
  const meals = day?.meals.map((m) => m.meal) ?? ['Breakfast', 'Lunch', 'Dinner']
  const i = meals.indexOf($('#meal').value)
  return i === -1 ? 1 : meals.length - i
}

/** The imported figures for today (Health, CSV or typed), or null if they are from another
 *  day. Recommending against yesterday's intake is worse than recommending against
 *  nothing. This is the BASELINE only — it excludes anything logged in the app. */
function baselineToday() {
  return profile.consumed?.date === todayIso() ? profile.consumed.nutrients : null
}

/** Dishes logged in the app today. A log from another day is not today's intake. */
function logToday() {
  return profile.log?.date === todayIso() ? profile.log.entries : []
}

function loggedTotals() {
  const total = {}
  for (const entry of logToday()) {
    for (const [k, v] of Object.entries(entry.nutrients)) total[k] = (total[k] ?? 0) + v
  }
  return total
}

/** What the recommender scores against: the imported baseline plus what the app logged. */
function consumedToday() {
  const baseline = baselineToday()
  if (!baseline && logToday().length === 0) return null
  return mergeConsumed(baseline, loggedTotals())
}

/**
 * Records a dish as eaten. Servings are stored as taken, unrounded — half a burger is a
 * real thing to have eaten even though the recommender would never advise "0.5 pieces".
 *
 * The nutrient figures are snapshotted rather than recomputed from menu.json later: the
 * scrape rolls the menu window forward daily and an item can drop out of it while still
 * sitting in today's log.
 */
function logAte(itemId, servings) {
  const item = menu?.items[itemId]
  if (!item || !(servings > 0)) return
  if (profile.log?.date !== todayIso()) profile.log = { date: todayIso(), entries: [] }

  profile.log.entries.push({
    itemId,
    name: item.name,
    servings,
    display: describeServing(servings, item.portion),
    nutrients: deliversFor(item.nutrients, servings),
    at: new Date().toISOString(),
  })
  saveProfile()

  // Deliberately not re-rendering the picks: logging one dish changes what is left, and a
  // list that reshuffles under your thumb while you are logging the rest of the tray is
  // worse than a list that is one dish stale. It refreshes on tab or meal change.
  renderFuel()
  renderLogStrip()
}

function removeLogEntry(index) {
  const entries = logToday()
  if (!entries[index]) return
  entries.splice(index, 1)
  saveProfile()
  renderFuel()
  renderLogStrip()
}

/** Briefly confirms on the button itself — a toast is easy to miss one-handed. */
function flash(button, text) {
  const original = button.textContent
  button.textContent = text
  button.disabled = true
  setTimeout(() => { button.textContent = original; button.disabled = false }, 1200)
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

async function loadMenu() {
  const res = await fetch('data/menu.json', { cache: 'no-cache' })
  if (!res.ok) throw new Error(`menu.json ${res.status}`)
  return res.json()
}

const currentHall = () => menu.halls.find((h) => h.num === $('#hall').value) ?? menu.halls[0]

function itemsForSelection() {
  const hall = currentHall()
  const day = hall?.days.find((d) => d.date === todayIso())
  const meal = day?.meals.find((m) => m.meal === $('#meal').value)
  if (!meal) return []

  return meal.stations.flatMap((station) =>
    station.itemIds
      .map((id) => (menu.items[id] ? { itemId: id, station: station.name, ...menu.items[id] } : null))
      .filter(Boolean))
}

// ---------------------------------------------------------------------------
// Render — Now
// ---------------------------------------------------------------------------

function renderNow() {
  const picksEl = $('#picks')
  const emptyEl = $('#nowempty')
  picksEl.innerHTML = ''

  const items = itemsForSelection()
  if (items.length === 0) {
    emptyEl.textContent = `No ${$('#meal').value.toLowerCase()} menu for today at this hall.`
    emptyEl.classList.remove('hidden')
    return
  }

  // What is left of the day, divided across the meals still ahead — this plate is one
  // meal, not the rest of the day in a single sitting.
  const dayNeed = needVector(profile.targets, consumedToday())
  const need = shareForMeal(dayNeed, mealsLeftToday())
  const picks = recommend(items, need, profile)

  if (picks.length === 0) {
    if (!(profile.targets.kcal > 0)) {
      emptyEl.textContent = 'Set your calorie and protein targets in Prefs first — copy them '
        + 'off your Cronometer targets page. Then log today in Fuel.'
    } else if (consumedToday()) {
      emptyEl.textContent = "Nothing on today's menu fits what you have left. Check your filters in Prefs."
    } else {
      emptyEl.textContent = 'Add what you have eaten today in Fuel, and this fills in.'
    }
    emptyEl.classList.remove('hidden')
    return
  }
  emptyEl.classList.add('hidden')

  // With no energy target set, nothing divides by calories and protein is not scored at
  // all — the picks are real but they are answering a much narrower question. Say so
  // rather than letting them read as a full recommendation.
  if (!(profile.targets.kcal > 0) || !(profile.targets.protein_g > 0)) {
    const warn = document.createElement('div')
    warn.className = 'note'
    warn.textContent = 'Calorie and protein targets are not set, so these picks ignore both. '
      + 'Set them in Prefs (copy from your Cronometer targets page).'
    picksEl.append(warn)
  }

  for (const p of picks) picksEl.append(renderPick(p))

  const kcal = Math.round(picks.reduce((a, p) => a + (p.delivers.kcal ?? 0), 0))
  const protein = Math.round(picks.reduce((a, p) => a + (p.delivers.protein_g ?? 0), 0))
  const total = document.createElement('div')
  total.className = 'total'
  total.textContent =
    `This plate: ${kcal} cal, ${protein} g protein. ` +
    `Budget for this meal was ${Math.round(need.kcal ?? 0)} cal, ` +
    `${Math.round(dayNeed.kcal ?? 0)} left for the whole day.`
  picksEl.append(total)
}

/** Running total for the Now tab, so logging a tray gives feedback without a tab switch. */
function renderLogStrip() {
  const strip = $('#logstrip')
  const entries = logToday()
  if (entries.length === 0) {
    strip.classList.add('hidden')
    strip.innerHTML = ''
    return
  }

  const totals = loggedTotals()
  const text = document.createElement('span')
  text.textContent =
    `Logged here today: ${entries.length} ${entries.length === 1 ? 'dish' : 'dishes'} · ` +
    `${Math.round(totals.kcal ?? 0)} cal · ${Math.round(totals.protein_g ?? 0)} g protein`

  const undo = document.createElement('button')
  undo.className = 'ghost'
  undo.textContent = `Undo ${entries[entries.length - 1].name}`
  undo.onclick = () => removeLogEntry(entries.length - 1)

  strip.innerHTML = ''
  strip.append(text, undo)
  strip.classList.remove('hidden')
}

function renderPick(p) {
  const el = document.createElement('div')
  el.className = 'pick'

  const h = document.createElement('h3')
  h.textContent = p.name
  const station = document.createElement('p')
  station.className = 'station'
  station.textContent = p.station
  const amount = document.createElement('span')
  amount.className = 'amount'
  amount.textContent = p.display
  const why = document.createElement('p')
  why.className = 'why'
  why.textContent = p.why

  el.append(h, station, amount, why)

  // An unpublished nutrient is not the same as a clean one, and the plate should say so.
  if (p.unknownNutrients.length > 0) {
    const caveat = document.createElement('p')
    caveat.className = 'caveat'
    const names = p.unknownNutrients.map((k) => NUTRIENT_LABEL[k] ?? k).join(', ')
    caveat.textContent = `UT doesn't publish ${names} for this — scored without it.`
    el.append(caveat)
  }

  // Cronometer cannot be written to, so the best available move is handing over exactly
  // what its custom-food form asks for. Created once per dish, reused forever after.
  const copy = document.createElement('button')
  copy.className = 'copy'
  copy.textContent = 'Copy for Cronometer'
  copy.onclick = async () => {
    const item = { ...menu.items[p.itemId], name: p.name, station: p.station }
    try {
      await navigator.clipboard.writeText(cronometerEntry(item, p.servings))
      copy.textContent = 'Copied — paste into Custom Food'
    } catch {
      copy.textContent = 'Clipboard blocked — open Prefs to copy manually'
    }
    setTimeout(() => { copy.textContent = 'Copy for Cronometer' }, 3000)
  }
  el.append(copy)

  // One tap for the ordinary case, one more for a different amount. Multipliers rather
  // than a number field because at a buffet line you know "about half that", not grams.
  const ateRow = document.createElement('div')
  ateRow.className = 'ate'
  const ate = document.createElement('button')
  ate.className = 'primary'
  ate.textContent = 'Ate it'
  ate.onclick = () => { logAte(p.itemId, p.servings); flash(ate, 'Logged ✓') }
  ateRow.append(ate)
  for (const [mult, label] of [[0.5, '½'], [1.5, '1½'], [2, '2']]) {
    const b = document.createElement('button')
    b.className = 'chip'
    b.textContent = `×${label}`
    b.setAttribute('aria-label', `Ate ${label} times the suggested amount`)
    b.onclick = () => { logAte(p.itemId, p.servings * mult); flash(b, '✓') }
    ateRow.append(b)
  }
  el.append(ateRow)

  const rateRow = document.createElement('div')
  rateRow.className = 'rate'
  const weight = profile.itemWeights[p.itemId]
  for (const [value, label] of [[1, 'Good'], [-1, 'Nope']]) {
    const b = document.createElement('button')
    b.textContent = label
    if (weight === value) b.classList.add('on')
    b.onclick = () => rate(p, value)
    rateRow.append(b)
  }
  el.append(rateRow)
  return el
}

// ---------------------------------------------------------------------------
// Rating and note-to-rule
// ---------------------------------------------------------------------------

function rate(pick, value) {
  if (profile.itemWeights[pick.itemId] === value) delete profile.itemWeights[pick.itemId]
  else profile.itemWeights[pick.itemId] = value
  saveProfile()

  ratingItem = pick
  $('#noteitem').textContent = pick.name
  $('#noteinput').value = ''
  $('#notedlg').showModal()
}

// Taste words map to a stronger penalty on the nutrient responsible, so the complaint
// carries over to every future dish rather than only this one.
const TASTE_RULES = [
  [/salt|salty|sodium/, 'sodium_mg', 0.75],
  [/sweet|sugary|too much sugar/, 'addedsugar_g', 0.5],
  [/greasy|oily|fatty|heavy/, 'satfat_g', 0.5],
]

const STOPWORDS = new Set([
  'water', 'salt', 'sugar', 'spice', 'spices', 'flavor', 'flavors', 'natural', 'artificial',
  'less', 'than', 'contains', 'with', 'from', 'that', 'this', 'each', 'made', 'blend',
  'acid', 'extract', 'concentrate', 'color', 'colour', 'enriched', 'bleached', 'preservative',
])

/** Turns a free-text note into a durable rule. Named foods become blocklist entries;
 *  named tastes become penalty weights. Plain string matching, no model involved. */
function applyNote(item, note, disliked) {
  const text = note.toLowerCase().trim()
  if (!text) return null
  const applied = []

  for (const [pattern, key, bump] of TASTE_RULES) {
    if (!pattern.test(text)) continue
    const base = profile.penaltyWeightOverrides[key] ?? { sodium_mg: 1.5, satfat_g: 1, addedsugar_g: 1 }[key]
    profile.penaltyWeightOverrides[key] = Math.min(base + bump, 5)
    applied.push(`ranking ${NUTRIENT_LABEL[key].toLowerCase()} harder everywhere`)
  }

  if (disliked) {
    const source = `${item.name} ${menu.items[item.itemId]?.ingredients ?? ''}`.toLowerCase()
    const terms = new Set(
      source.split(/[^a-z]+/).filter((w) => w.length >= 4 && !STOPWORDS.has(w)))

    for (const term of terms) {
      if (!text.includes(term)) continue
      if (profile.ingredientBlocklist.includes(term)) continue
      profile.ingredientBlocklist.push(term)
      applied.push(`hiding anything with ${term}`)
    }
  }

  saveProfile()
  return applied.length > 0 ? applied.join(', ') : null
}

// ---------------------------------------------------------------------------
// Render — Fuel
// ---------------------------------------------------------------------------

function renderFuel() {
  const manual = $('#manual')
  // Prefilled from the baseline alone, never the merged total. These inputs write back into
  // the baseline, so showing app-logged dishes here would fold them in and count them twice.
  const consumed = baselineToday() ?? {}
  manual.innerHTML = ''
  for (const key of ['kcal', 'protein_g', 'carb_g', 'fat_g']) {
    const label = document.createElement('label')
    label.textContent = NUTRIENT_LABEL[key]
    const input = document.createElement('input')
    Object.assign(input, { type: 'number', inputMode: 'decimal', id: `m_${key}`, min: '0' })
    input.value = consumed[key] ?? ''
    manual.append(label, input)
  }

  const need = needVector(profile.targets, consumedToday())
  const table = $('#remaining')
  table.innerHTML = ''
  for (const [key, left] of Object.entries(need)) {
    const tr = table.insertRow()
    tr.insertCell().textContent = NUTRIENT_LABEL[key] ?? key
    tr.insertCell().textContent = Math.round(left * 10) / 10
  }

  renderLog()
  renderLogSearch()
  renderUnservable()
  renderFuelLine()
}

function renderLog() {
  const box = $('#loglist')
  const entries = logToday()
  box.innerHTML = ''

  if (entries.length === 0) {
    box.innerHTML = '<p class="hint">Nothing logged in the app today.</p>'
    $('#clearlog').classList.add('hidden')
    return
  }

  for (const [i, entry] of entries.entries()) {
    const row = document.createElement('div')
    row.className = 'logrow'
    const text = document.createElement('span')
    text.textContent =
      `${entry.name} — ${entry.display} · ${Math.round(entry.nutrients.kcal ?? 0)} cal, ` +
      `${Math.round(entry.nutrients.protein_g ?? 0)} g protein`
    const remove = document.createElement('button')
    remove.className = 'ghost'
    remove.textContent = '✕'
    remove.setAttribute('aria-label', `Remove ${entry.name}`)
    remove.onclick = () => removeLogEntry(i)
    row.append(text, remove)
    box.append(row)
  }

  const totals = loggedTotals()
  const sum = document.createElement('p')
  sum.className = 'total'
  sum.textContent =
    `${Math.round(totals.kcal ?? 0)} cal, ${Math.round(totals.protein_g ?? 0)} g protein ` +
    'logged here, on top of whatever was imported.'
  box.append(sum)
  $('#clearlog').classList.remove('hidden')
}

/** Logging something the recommender never suggested — a second helping, or dessert. */
function renderLogSearch() {
  const box = $('#logresults')
  box.innerHTML = ''
  const term = $('#logsearch').value.trim().toLowerCase()
  if (term.length < 2 || !menu) return

  // Everything on today's menu at this hall, not just the selected meal: breakfast gets
  // logged at lunchtime more often than not.
  const day = currentHall()?.days.find((d) => d.date === todayIso())
  const ids = new Set((day?.meals ?? []).flatMap((m) => m.stations.flatMap((s) => s.itemIds)))

  const matches = [...ids]
    .map((id) => (menu.items[id] ? { itemId: id, ...menu.items[id] } : null))
    .filter((it) => it?.name.toLowerCase().includes(term))
    .slice(0, 8)

  if (matches.length === 0) {
    box.innerHTML = '<p class="hint">Nothing on today\'s menu matches.</p>'
    return
  }

  for (const item of matches) {
    const b = document.createElement('button')
    b.className = 'chip'
    b.textContent = `${item.name} (${item.portion.raw})`
    b.onclick = () => { logAte(item.itemId, 1); flash(b, 'Logged ✓') }
    box.append(b)
  }
}

// The honest half of the micronutrient promise: Cronometer knows about these, and the
// dining hall data cannot be searched for them.
function renderUnservable() {
  const box = $('#unservable')
  box.innerHTML = ''
  const gaps = unservableGaps(profile.extraTargets, profile.extras)
  if (gaps.length === 0) return

  const h = document.createElement('h2')
  h.textContent = "Short on — but J2 doesn't publish these"
  const note = document.createElement('div')
  note.className = 'note'
  note.textContent =
    gaps.slice(0, 5).map((g) => `${EXTRA_LABELS[g.key] ?? g.key} (${g.shortBy}% short)`).join(', ') +
    '. UT publishes only vitamin D, calcium, iron and potassium per dish, so the menu ' +
    'cannot be ranked for these. Supplement or eat off campus.'
  box.append(h, note)
}

function renderFuelLine() {
  const consumed = consumedToday()
  if (!consumed) {
    $('#fuelline').textContent = 'No intake logged for today — add it in Fuel.'
    return
  }
  const need = needVector(profile.targets, consumed)

  // Both sources are named because they can double-count: if a logged dish is later typed
  // into Cronometer by hand, the next import contains it too. Naming them makes that
  // visible instead of silently inflating the day.
  const parts = []
  if (baselineToday()) {
    parts.push({ csv: 'Cronometer CSV', health: 'Apple Health', manual: 'typed in' }[profile.consumed.source]
      ?? profile.consumed.source)
  }
  const logged = logToday().length
  if (logged > 0) parts.push(`${logged} logged here`)

  $('#fuelline').textContent =
    `${Math.round(need.kcal ?? 0)} cal and ${Math.round(need.protein_g ?? 0)} g protein left ` +
    `(${parts.join(' + ')}).`
}

// An import replaces the baseline and deliberately LEAVES the app's own log alone. The
// tempting rule — "a newer import supersedes what we logged" — is wrong here: Cronometer
// only contains what was typed into Cronometer, so a dish logged in this app is absent from
// every later Health import. Clearing on import would delete real intake. Emptying the log
// is a manual choice, and the button that does it says why.
function setConsumed(nutrients, source, extras, missing = []) {
  profile.consumed = { date: todayIso(), source, nutrients, missing, at: new Date().toISOString() }
  if (extras) profile.extras = extras
  saveProfile()
  renderFuel()
  renderNow()
  renderLogStrip()
}

// ---------------------------------------------------------------------------
// Render — Prefs
// ---------------------------------------------------------------------------

function renderPrefs() {
  const box = $('#restrictions')
  box.innerHTML = ''
  for (const icon of RESTRICTION_ICONS) {
    box.append(chip(icon === 'TreeNuts' ? 'Tree nuts' : icon, profile.restrictions.includes(icon), () => {
      const i = profile.restrictions.indexOf(icon)
      if (i === -1) profile.restrictions.push(icon)
      else profile.restrictions.splice(i, 1)
      saveProfile(); renderPrefs(); renderNow()
    }))
  }
  box.append(chip('Reflux-friendly', profile.refluxFilter, () => {
    profile.refluxFilter = !profile.refluxFilter
    saveProfile(); renderPrefs(); renderNow()
  }))

  const block = $('#blocklist')
  block.innerHTML = ''
  if (profile.ingredientBlocklist.length === 0) {
    block.innerHTML = '<p class="hint">Nothing blocked yet.</p>'
  }
  for (const term of profile.ingredientBlocklist) {
    block.append(chip(`${term} ✕`, true, () => {
      profile.ingredientBlocklist = profile.ingredientBlocklist.filter((t) => t !== term)
      saveProfile(); renderPrefs(); renderNow()
    }))
  }

  const targets = $('#targets')
  targets.innerHTML = ''
  for (const key of Object.keys(DEFAULT_PROFILE.targets)) {
    const label = document.createElement('label')
    label.textContent = NUTRIENT_LABEL[key] ?? key
    const input = document.createElement('input')
    Object.assign(input, { type: 'number', inputMode: 'decimal', id: `t_${key}`, min: '0' })
    input.value = profile.targets[key] ?? 0
    targets.append(label, input)
  }

  const rated = $('#rated')
  rated.innerHTML = ''
  const entries = Object.entries(profile.itemWeights)
  if (entries.length === 0) {
    rated.innerHTML = '<p class="hint">Nothing rated yet.</p>'
  }
  for (const [id, weight] of entries) {
    const name = menu?.items[id]?.name ?? id
    rated.append(chip(`${weight > 0 ? '♥' : '✕'} ${name}`, weight > 0, () => {
      delete profile.itemWeights[id]
      saveProfile(); renderPrefs(); renderNow()
    }))
  }
}

function chip(text, on, onclick) {
  const b = document.createElement('button')
  b.className = on ? 'chip on' : 'chip'
  b.textContent = text
  b.onclick = onclick
  return b
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

for (const tab of document.querySelectorAll('.tabs button')) {
  tab.onclick = () => {
    for (const t of document.querySelectorAll('.tabs button')) t.classList.toggle('on', t === tab)
    for (const p of document.querySelectorAll('.tabpanel')) {
      p.classList.toggle('on', p.id === tab.dataset.tab)
    }
    // Logging leaves the picks one dish stale on purpose (see logAte); coming back to the
    // tab is the natural moment to catch them up.
    if (tab.dataset.tab === 'now' && menu) renderNow()
  }
}

$('#logsearch').oninput = renderLogSearch

$('#clearlog').onclick = () => {
  if (!confirm('Clear what you logged in the app today? Do this once it is in Cronometer.')) return
  profile.log = null
  saveProfile()
  renderFuel()
  renderLogStrip()
  renderNow()
}

$('#hall').onchange = () => { populateMeals(); renderNow() }
$('#meal').onchange = renderNow

$('#csv').onchange = async (e) => {
  const file = e.target.files?.[0]
  const status = $('#csvstatus')
  if (!file) return
  try {
    const text = await file.text()
    const { nutrients, extras } = parseCronometerCsv(text, todayIso())
    setConsumed(nutrients, 'csv', extras)
    status.textContent = `Loaded ${todayIso()} from Cronometer.`
    status.className = 'status ok'
  } catch (err) {
    // A rejected file changes nothing; a half-applied import would be worse.
    status.textContent = err instanceof CronometerParseError
      ? err.message
      : `Could not read that file: ${err.message}`
    status.className = 'status bad'
    if (err instanceof CronometerParseError) {
      const days = datesInCsv(await file.text())
      if (days.length > 0) status.textContent += ` (file covers ${days.join(', ')})`
    }
  }
  e.target.value = ''
}

// Apple Health import. The Shortcut does the reading and summing; this only validates
// and stores. Clipboard access must happen inside the click handler — browsers require
// the user gesture, and a silent read on page load is deliberately impossible.
async function importFromText(text) {
  const status = $('#csvstatus')
  try {
    const { nutrients, missing, generatedAt } = parseHealthPayload(text, todayIso())
    setConsumed(nutrients, 'health', null, missing)

    const when = generatedAt ? new Date(generatedAt) : new Date()
    const time = Number.isNaN(when.valueOf())
      ? ''
      : ` at ${when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    status.textContent = missing.length > 0
      // Naming what is absent stops a silent Health sync failure from reading as
      // "ate none of that today".
      ? `Imported${time}. Not available from Health: ${missing.map((k) => NUTRIENT_LABEL[k] ?? k).join(', ')}.`
      : `Imported${time}.`
    status.className = 'status ok'
    $('#pastefallback').open = false
  } catch (err) {
    status.textContent = err instanceof CronometerParseError ? err.message : `Import failed: ${err.message}`
    status.className = 'status bad'
  }
}

$('#health').onclick = async () => {
  if (!navigator.clipboard?.readText) {
    $('#pastefallback').open = true
    $('#csvstatus').textContent = 'This browser will not let a page read the clipboard. Paste below.'
    $('#csvstatus').className = 'status bad'
    return
  }
  try {
    await importFromText(await navigator.clipboard.readText())
  } catch {
    $('#pastefallback').open = true
    $('#csvstatus').textContent = 'Clipboard read was refused. Paste below instead.'
    $('#csvstatus').className = 'status bad'
  }
}

$('#pastego').onclick = () => importFromText($('#pastebox').value)

$('#savemanual').onclick = () => {
  // Baseline, not the merged total — see renderFuel(). Typing over a merged figure would
  // bake the app's own log into the baseline and then count it a second time.
  const nutrients = { ...(baselineToday() ?? {}) }
  for (const key of ['kcal', 'protein_g', 'carb_g', 'fat_g']) {
    const v = Number($(`#m_${key}`).value)
    nutrients[key] = Number.isFinite(v) && v > 0 ? v : 0
  }
  setConsumed(nutrients, 'manual')
  $('#csvstatus').textContent = 'Saved.'
  $('#csvstatus').className = 'status ok'
}

$('#savetargets').onclick = () => {
  for (const key of Object.keys(DEFAULT_PROFILE.targets)) {
    const v = Number($(`#t_${key}`).value)
    profile.targets[key] = Number.isFinite(v) && v > 0 ? v : 0
  }
  saveProfile(); renderFuel(); renderNow()
}

$('#addblock').onsubmit = (e) => {
  e.preventDefault()
  const term = $('#blockinput').value.trim().toLowerCase()
  if (term && !profile.ingredientBlocklist.includes(term)) profile.ingredientBlocklist.push(term)
  $('#blockinput').value = ''
  saveProfile(); renderPrefs(); renderNow()
}

$('#reset').onclick = () => {
  if (!confirm('Clear targets, ratings and blocked ingredients on this phone?')) return
  localStorage.removeItem(PROFILE_KEY)
  profile = loadProfile()
  renderPrefs(); renderFuel(); renderNow()
}

$('#notedlg').onclose = () => {
  const dlg = $('#notedlg')
  if (dlg.returnValue === 'save' && ratingItem) {
    const applied = applyNote(ratingItem, $('#noteinput').value,
      profile.itemWeights[ratingItem.itemId] === -1)
    if (applied) {
      $('#fuelline').textContent = `Got it — ${applied}.`
      setTimeout(renderFuelLine, 4000)
    }
  }
  ratingItem = null
  renderNow()
  renderPrefs()
}

function populateHalls() {
  const sel = $('#hall')
  sel.innerHTML = ''
  for (const hall of menu.halls) {
    const opt = document.createElement('option')
    opt.value = hall.num
    opt.textContent = hall.name
    sel.append(opt)
  }
  sel.parentElement.classList.toggle('hidden', false)
}

function populateMeals() {
  const sel = $('#meal')
  const day = currentHall()?.days.find((d) => d.date === todayIso())
  const meals = day?.meals.map((m) => m.meal) ?? ['Breakfast', 'Lunch', 'Dinner']
  const preferred = currentMealByClock()

  sel.innerHTML = ''
  for (const meal of meals) {
    const opt = document.createElement('option')
    opt.value = opt.textContent = meal
    sel.append(opt)
  }
  sel.value = meals.includes(preferred) ? preferred : meals[0]
}

async function start() {
  renderPrefs()
  renderFuel()
  try {
    menu = await loadMenu()
  } catch (err) {
    $('#nowempty').textContent = `Could not load the menu (${err.message}). Pull to refresh once you have signal.`
    $('#nowempty').classList.remove('hidden')
    return
  }
  populateHalls()
  populateMeals()
  renderPrefs()
  renderNow()
  renderLogStrip()
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline cache is a bonus */ })
}

start()
