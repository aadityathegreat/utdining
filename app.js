import { recommend, needVector, unservableGaps, shareForMeal } from './recommend.mjs'
import {
  parseCronometerCsv, datesInCsv, EXTRA_LABELS, CronometerParseError,
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

/** Today's consumed figures, or null if the saved ones are from another day.
 *  Recommending against yesterday's intake is worse than recommending against nothing. */
function consumedToday() {
  return profile.consumed?.date === todayIso() ? profile.consumed.nutrients : null
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
  const consumed = consumedToday() ?? {}
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

  renderUnservable()
  renderFuelLine()
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
  const source = profile.consumed.source === 'csv' ? 'Cronometer' : 'typed in'
  $('#fuelline').textContent =
    `${Math.round(need.kcal ?? 0)} cal and ${Math.round(need.protein_g ?? 0)} g protein left (${source}).`
}

function setConsumed(nutrients, source, extras) {
  profile.consumed = { date: todayIso(), source, nutrients }
  if (extras) profile.extras = extras
  saveProfile()
  renderFuel()
  renderNow()
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
  }
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

$('#savemanual').onclick = () => {
  const nutrients = { ...(consumedToday() ?? {}) }
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
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline cache is a bonus */ })
}

start()
