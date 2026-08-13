import {
  recommend, needVector, unservableGaps, shareForMeal, cronometerEntry, cronometerFields,
  deliversFor, mergeConsumed, describeServing, MODES, profileForMode, shareForKcal,
  nutrientsOf, SuspectItemError,
} from './recommend.mjs'
import {
  parseCronometerCsv, datesInCsv, parseHealthPayload, EXTRA_LABELS, CronometerParseError,
} from './cronometer.mjs'
import { suspectOf } from './nutrition.mjs'
import { labelModel, labelBlob } from './label.mjs'

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
    // Exactly one of these carries a number; see carbBasis. Cronometer shows a single
    // carbohydrate goal that the account configures as total OR net, so the app stores it
    // the same way. Keeping both keys and leaving one at 0 is what makes it impossible to
    // score a dish's total carbohydrate against a net-carb target.
    carb_g: 0,            // set in Prefs — total carbohydrate
    netcarb_g: 0,         // set in Prefs — total carbohydrate less fibre
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
  // Which carbohydrate figure the target above is. 'total' by default because that is what
  // Cronometer shows unless the account turns net carbs on.
  carbBasis: 'total',
  restrictions: ['Beef', 'Pork'],
  refluxFilter: false,
  ingredientBlocklist: [],
  itemWeights: {},
  penaltyWeightOverrides: {},
  // Dishes whose implausible UT figures were overridden by hand, so a false positive in the
  // plausibility checks is never a dead end.
  allowSuspect: [],
  consumed: null,
  extras: null,
  // What was eaten straight from the app, kept separate from the imported baseline so the
  // two can never be confused for each other. See logToday().
  log: null,
}

// How far under its protein budget a plate has to fall before the summary says so.
//
// This fires on six of seven real breakfasts, which looks like a badly tuned threshold and is
// not. Breakfast attainment measured across a real week is a median 59% and a floor of 17%;
// the plates really do miss, and the miss rolls into the rest of the day. Lunch runs 90–110%
// and never trips it. Raising the bar until the note went quiet would hide a true fact about
// the servery rather than fix anything.
const PROTEIN_SHORTFALL_RATIO = 0.7

const NUTRIENT_LABEL = {
  kcal: 'Calories', protein_g: 'Protein (g)', carb_g: 'Total carbs (g)',
  netcarb_g: 'Net carbs (g)', fat_g: 'Fat (g)',
  fiber_g: 'Fibre (g)', sodium_mg: 'Sodium (mg)', satfat_g: 'Sat fat (g)',
  addedsugar_g: 'Added sugar (g)', vitd_mcg: 'Vitamin D (mcg)', calcium_mg: 'Calcium (mg)',
  iron_mg: 'Iron (mg)', potassium_mg: 'Potassium (mg)',
}

/** The carb key the profile is actually keeping a target in. */
const carbKey = () => (profile.carbBasis === 'net' ? 'netcarb_g' : 'carb_g')

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
// Which hall's tab is selected, and whether this is a meal, a snack or pre-workout food.
// Neither belongs in the saved profile: both are about right now, not about preferences.
let hallNum = null
let mode = 'meal'

function loadProfile() {
  try {
    const saved = JSON.parse(localStorage.getItem(PROFILE_KEY))
    if (saved?.version === DEFAULT_PROFILE.version) {
      // `targets` is merged key by key rather than replaced wholesale. A flat spread would
      // drop any target added since the profile was saved, and the version number is
      // deliberately not bumped for an added key — bumping it wipes the phone, and retyping
      // targets is the exact misery this app already had to fix once.
      return {
        ...DEFAULT_PROFILE,
        ...saved,
        targets: { ...DEFAULT_PROFILE.targets, ...(saved.targets ?? {}) },
        extraTargets: { ...DEFAULT_PROFILE.extraTargets, ...(saved.extraTargets ?? {}) },
      }
    }
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
    nutrients: deliversFor(nutrientsOf(item), servings),
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

const currentHall = () => menu.halls.find((h) => h.num === hallNum) ?? menu.halls[0]

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
  // Rendered before the early returns: a dish blocked as suspect is exactly the thing to
  // say out loud when the list comes back short, or empty.
  renderBlocked(items)

  if (items.length === 0) {
    emptyEl.textContent = `No ${$('#meal').value.toLowerCase()} menu for today at this hall.`
    emptyEl.classList.remove('hidden')
    return
  }

  // What is left of the day, divided across the meals still ahead — this plate is one
  // meal, not the rest of the day in a single sitting. A snack or pre-workout plate is
  // sized to a calorie ceiling instead, because "a share of what is left" is the wrong
  // question for something eaten between meals.
  const dayNeed = needVector(profile.targets, consumedToday())
  const modeSpec = MODES[mode]
  const need = modeSpec.kcalCap == null
    ? shareForMeal(dayNeed, mealsLeftToday())
    : shareForKcal(dayNeed, modeSpec.kcalCap)
  const picks = recommend(items, need, profileForMode(profile, mode), { maxItems: modeSpec.maxItems })

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

  // Pre-workout reverses fibre from a reward to a penalty and marks fat down. That is a rule
  // of thumb about eating before training, not a health claim, and it should read as one.
  if (mode === 'preworkout') {
    const note = document.createElement('div')
    note.className = 'note'
    note.textContent = 'Ranking carbs up, fat and fibre down — the usual rule of thumb for '
      + 'eating before training, not medical advice. Everything else scores as normal.'
    picksEl.append(note)
  }

  for (const p of picks) picksEl.append(renderPick(p))

  const kcal = Math.round(picks.reduce((a, p) => a + (p.delivers.kcal ?? 0), 0))
  const protein = Math.round(picks.reduce((a, p) => a + (p.delivers.protein_g ?? 0), 0))
  const total = document.createElement('div')
  total.className = 'total'
  // The protein budget is named alongside the calorie one. Without it the summary reported a
  // number with nothing to judge it against, and a plate that reached 8 g of an intended 45
  // read exactly like one that hit its mark.
  const proteinBudget = need.protein_g > 0 ? `, ${Math.round(need.protein_g)} g protein` : ''
  total.textContent =
    `This ${mode === 'meal' ? 'plate' : MODES[mode].label.toLowerCase()}: ${kcal} cal, ` +
    `${protein} g protein. Budget was ${Math.round(need.kcal ?? 0)} cal${proteinBudget}, ` +
    `${Math.round(dayNeed.kcal ?? 0)} left for the whole day.`
  picksEl.append(total)

  // Saying the gap out loud rather than reweighting the scorer. Measured across a week of real
  // breakfasts, a plate reaches a median 59% of its protein budget and as little as 17% on days
  // the Yogurt Bar has no Greek yogurt — the line's only large protein source is often salty
  // enough that the sodium penalty outranks it, and fruit wins on calorie cost instead. That is
  // the weights doing what they were told; what was actually wrong is that nothing said so.
  if (mode === 'meal' && need.protein_g > 0 && protein < need.protein_g * PROTEIN_SHORTFALL_RATIO) {
    const short = document.createElement('div')
    short.className = 'note'
    short.textContent =
      `Protein is short here: ${protein} g against the ${Math.round(need.protein_g)} g this meal `
      + 'was aiming at. Nothing on this line closes the gap without spending more of another '
      + 'budget, so it carries into your later meals.'
    picksEl.append(short)
  }
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

  // Cronometer cannot be written to: no public API, no diary import, and a mobile Custom
  // Food screen made of separate numeric inputs that one paste has never filled. So the
  // button opens the fields in form order, one tap each, and says exactly that. Naming it
  // "Copy for Cronometer" claimed more than the clipboard can do.
  const copy = document.createElement('button')
  copy.className = 'copy'
  copy.textContent = 'Copy nutrition reference'
  copy.onclick = () => openCronometerSheet({ ...menu.items[p.itemId], itemId: p.itemId, name: p.name, station: p.station }, p.servings)
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
// Cronometer handoff
// ---------------------------------------------------------------------------

/**
 * The Custom Food form, field by field, in the order Cronometer presents them.
 *
 * This is the honest shape of the handoff. Cronometer exposes no API, accepts no diary
 * import, and its mobile Custom Food screen is a set of separate inputs — pasting one block
 * into any of them fills that one input with the whole block. So this is a copy button per
 * field, and the sheet says plainly that it is manual entry rather than an import.
 *
 * A dish whose UT figures failed the plausibility checks never gets here: matching
 * Cronometer perfectly against a wrong number still produces a wrong diary.
 */
function openCronometerSheet(item, servings) {
  const dlg = $('#cronodlg')
  const box = $('#cronofields')
  const status = $('#cronostatus')
  box.innerHTML = ''
  status.textContent = ''
  status.className = 'status'
  $('#crononame').textContent = item.name
  $('#cronoservings').textContent = `Create it once, then log ${Math.round(servings * 100) / 100} × this serving.`

  // Overridden dishes reach this sheet, so the override has to travel with them. It is
  // honoured and disclosed rather than silently obeyed: the numbers are still UT's bad ones.
  const allowSuspect = profile.allowSuspect.includes(item.itemId)
  const suspect = suspectOf(item)
  if (allowSuspect && suspect.length > 0) {
    status.textContent = `You overrode this dish. UT still publishes ${suspect.map((s) => s.message).join('; ')} — `
      + 'check these against the real food before saving them in Cronometer.'
    status.className = 'status bad'
  }

  wireLabelSpike(item, allowSuspect)

  let fields
  try {
    fields = cronometerFields(item, servings, { allowSuspect })
  } catch (err) {
    $('#labelspike').classList.add('hidden')
    if (!(err instanceof SuspectItemError)) throw err
    status.textContent = `${err.message} Copying it would put a wrong number in your diary.`
    status.className = 'status bad'
    dlg.showModal()
    return
  }

  for (const { label, value, unit } of fields) {
    const row = document.createElement('div')
    row.className = 'cronorow'

    const name = document.createElement('span')
    name.className = 'cronolabel'
    name.textContent = label

    if (value == null) {
      // Blank, never 0. Entering a zero tells Cronometer the food contains none of it and
      // skews every daily total from then on.
      const blank = document.createElement('span')
      blank.className = 'cronoblank'
      blank.textContent = 'UT publishes nothing — leave blank'
      row.append(name, blank)
    } else {
      const text = `${value}${unit}`
      const b = document.createElement('button')
      // Explicitly not a submit button: this sheet lives inside a `method="dialog"` form,
      // where the default type would close the dialog on the first field copied.
      b.type = 'button'
      b.className = 'chip'
      b.textContent = text
      b.setAttribute('aria-label', `Copy ${label}: ${text}`)
      b.onclick = async () => {
        // The unit is stripped for the numeric fields: Cronometer's nutrient inputs take a
        // number, and "12.4g" pasted into one of them is rejected or truncated.
        try {
          await navigator.clipboard.writeText(String(value))
          flash(b, 'Copied ✓')
        } catch {
          status.textContent = 'Clipboard blocked — copy the reference block below by hand.'
          status.className = 'status bad'
        }
      }
      row.append(name, b)
    }
    box.append(row)
  }

  $('#cronoall').onclick = async () => {
    try {
      await navigator.clipboard.writeText(cronometerEntry(item, servings, { allowSuspect }))
      status.textContent = 'Copied the whole block. It is a reference to type from, not an import.'
      status.className = 'status ok'
    } catch {
      $('#cronotext').value = cronometerEntry(item, servings, { allowSuspect })
      $('#cronofallback').open = true
      status.textContent = 'Clipboard blocked — select the text below instead.'
      status.className = 'status bad'
    }
  }

  dlg.showModal()
}

// The label-photo spike. Cronometer's scanner is the only route left that could fill every
// field from one action, so this draws an Updated American panel from UT's figures and hands
// it to the iOS share sheet. Nobody has yet confirmed Cronometer accepts an image made this
// way — the UI calls it an experiment for that reason, and the field list above stays the
// supported path until the round trip is proven.
let labelUrl = null

function wireLabelSpike(item, allowSuspect = false) {
  const make = $('#labelmake')
  const out = $('#labelout')
  const status = $('#labelstatus')

  // A previous dish's image would otherwise sit there looking like this one's.
  releaseLabel()
  out.innerHTML = ''
  status.textContent = ''
  status.className = 'status'
  $('#labelspike').open = false
  // Shown by default and hidden again by the caller for a quarantined dish, which has no
  // honest label to draw.
  $('#labelspike').classList.remove('hidden')

  make.onclick = async () => {
    out.innerHTML = ''
    status.className = 'status'
    let model
    try {
      model = labelModel(item, { allowSuspect })
    } catch (err) {
      status.textContent = err.message
      status.className = 'status bad'
      return
    }

    let blob
    try {
      blob = await labelBlob(model)
    } catch (err) {
      status.textContent = `Could not draw the label: ${err.message}`
      status.className = 'status bad'
      return
    }

    releaseLabel()
    labelUrl = URL.createObjectURL(blob)

    const img = document.createElement('img')
    img.className = 'labelimg'
    img.src = labelUrl
    img.alt = `Nutrition Facts label for ${item.name}`
    out.append(img)

    const file = new File([blob], `${slug(item.name)}-nutrition.png`, { type: 'image/png' })

    // Share sheet first: on iOS that is the route to Save Image, and from Photos the
    // Cronometer scanner can pick it up. canShare is checked with the actual file because
    // Safari advertises navigator.share while refusing file payloads.
    if (navigator.canShare?.({ files: [file] })) {
      const share = document.createElement('button')
      share.type = 'button'
      share.className = 'primary'
      share.textContent = 'Save or share the image'
      share.onclick = async () => {
        try {
          await navigator.share({ files: [file] })
        } catch (err) {
          // A cancelled share sheet is not a failure and must not read as one.
          if (err?.name === 'AbortError') return
          status.textContent = 'Sharing was refused — long-press the image and Save to Photos.'
          status.className = 'status bad'
        }
      }
      out.append(share)
    } else {
      const link = document.createElement('a')
      link.className = 'ghost download'
      link.href = labelUrl
      link.download = file.name
      link.textContent = 'Download the image'
      out.append(link)
      status.textContent = 'This browser will not share files. Download it, or long-press the image.'
    }

    // Naming the omissions beside the image matters more here than anywhere else: a scanner
    // silently leaves a missing field empty, and without this there is nothing to tell you
    // whether the blank came from UT or from the scan.
    if (model.omitted.length > 0) {
      const note = document.createElement('p')
      note.className = 'hint'
      note.textContent = `UT publishes no ${model.omitted.join(', ')} for this dish, so those `
        + 'rows are absent from the label rather than printed as zero. Leave them blank in '
        + 'Cronometer too.'
      out.append(note)
    }

    const ask = document.createElement('p')
    ask.className = 'hint'
    ask.textContent = 'Now try it: Cronometer → Add Food → the camera / scan-a-label option → '
      + 'pick this image from Photos. If it fills the form, check every value against the '
      + 'fields above before saving.'
    out.append(ask)
  }
}

function releaseLabel() {
  if (labelUrl) URL.revokeObjectURL(labelUrl)
  labelUrl = null
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'dish'

/** Dishes on today's menu that the plausibility checks blocked, with UT's exact figures. */
function renderBlocked(items) {
  const box = $('#blocked')
  box.innerHTML = ''

  const blocked = items
    .map((it) => ({ item: it, reasons: suspectOf(it) }))
    .filter((b) => b.reasons.length > 0 && !profile.allowSuspect.includes(b.item.itemId))
  if (blocked.length === 0) return

  const note = document.createElement('div')
  note.className = 'note'
  note.textContent = blocked.length === 1
    ? 'One dish is off the list because UT\'s published figures for it cannot be right:'
    : `${blocked.length} dishes are off the list because UT's published figures for them cannot be right:`
  box.append(note)

  for (const { item, reasons } of blocked) {
    const row = document.createElement('div')
    row.className = 'blockedrow'
    const text = document.createElement('span')
    // UT's exact value, quoted rather than corrected — the app has no way to know the
    // right number and inventing one would be worse than leaving the dish out.
    text.textContent = `${item.name} — ${reasons.map((r) => r.message).join('; ')}`
    const allow = document.createElement('button')
    allow.className = 'ghost'
    allow.textContent = 'Use it anyway'
    allow.onclick = () => {
      profile.allowSuspect.push(item.itemId)
      saveProfile()
      renderNow()
    }
    row.append(text, allow)
    box.append(row)
  }
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
  // The carb box asks for whichever figure the targets are in, so what is typed and what it
  // is measured against are the same quantity.
  for (const key of ['kcal', 'protein_g', carbKey(), 'fat_g']) {
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
    const reasons = suspectOf(item)
    // Searching for it by name is a deliberate act, so this warns rather than refuses — but
    // it does not log a figure UT cannot be right about without saying so first.
    if (reasons.length > 0 && !profile.allowSuspect.includes(item.itemId)) {
      b.textContent = `⚠ ${item.name} (${item.portion.raw})`
      b.onclick = () => {
        if (!confirm(`UT's figures for ${item.name} do not look right: ${reasons.map((r) => r.message).join('; ')}.\n\nLog it anyway?`)) return
        profile.allowSuspect.push(item.itemId)
        logAte(item.itemId, 1)
        flash(b, 'Logged ✓')
      }
    } else {
      b.textContent = `${item.name} (${item.portion.raw})`
      b.onclick = () => { logAte(item.itemId, 1); flash(b, 'Logged ✓') }
    }
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

  // Cronometer shows one carbohydrate goal, configured per account as total or net. The
  // app mirrors that: one input, and a switch saying which figure it is. Two inputs would
  // invite one number in both boxes and a day's worth of double-counted fibre.
  const basis = $('#carbbasis')
  basis.innerHTML = ''
  for (const [value, label] of [['total', 'Total carbs'], ['net', 'Net carbs']]) {
    basis.append(chip(label, profile.carbBasis === value, () => {
      if (profile.carbBasis === value) return
      // The number moves with the switch rather than being reinterpreted in place: 243 g of
      // net carbs is not 243 g of total carbs, and silently relabelling it is the bug.
      profile.targets[carbKey()] = 0
      profile.carbBasis = value
      saveProfile(); renderPrefs(); renderFuel(); renderNow()
    }))
  }

  const targets = $('#targets')
  targets.innerHTML = ''
  const skip = profile.carbBasis === 'net' ? 'carb_g' : 'netcarb_g'
  for (const key of Object.keys(DEFAULT_PROFILE.targets)) {
    if (key === skip) continue
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

// ---------------------------------------------------------------------------
// Settings backup
// ---------------------------------------------------------------------------

// Everything worth keeping, and nothing about a particular day. Intake and the food log are
// deliberately excluded: they are tomorrow's noise, and a backup that carries what he ate is
// a more personal thing to paste into Notes than a list of targets.
const SETTINGS_KEYS = [
  'targets', 'extraTargets', 'carbBasis', 'restrictions', 'refluxFilter',
  'ingredientBlocklist', 'itemWeights', 'penaltyWeightOverrides', 'allowSuspect',
]

function settingsBlob() {
  const out = { version: DEFAULT_PROFILE.version }
  for (const key of SETTINGS_KEYS) out[key] = profile[key]
  return JSON.stringify(out)
}

/** @throws {Error} with a message fit to show the user */
function restoreSettings(text) {
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('That is not a settings backup — paste the whole thing, braces included.')
  }
  if (data?.version !== DEFAULT_PROFILE.version) {
    throw new Error('That backup came from a different version of the app.')
  }

  // Only known keys are copied, and each is type-checked against its default. A backup is
  // pasted text: a stray key would otherwise land straight in the profile.
  let restored = 0
  for (const key of SETTINGS_KEYS) {
    const value = data[key]
    if (value == null) continue
    if (Array.isArray(DEFAULT_PROFILE[key]) !== Array.isArray(value)) continue
    if (typeof DEFAULT_PROFILE[key] !== typeof value) continue
    profile[key] = value
    restored++
  }
  if (restored === 0) throw new Error('Nothing in that backup was recognisable.')

  // A backup is pasted text, and this one value decides which carb figure everything is
  // measured against. Anything but the two known settings falls back to total carbs.
  if (profile.carbBasis !== 'net') profile.carbBasis = 'total'
  profile.allowSuspect = (profile.allowSuspect ?? []).filter((id) => typeof id === 'string')

  saveProfile()
  renderPrefs()
  renderFuel()
  renderNow()
  return restored
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
  for (const key of ['kcal', 'protein_g', carbKey(), 'fat_g']) {
    const v = Number($(`#m_${key}`).value)
    nutrients[key] = Number.isFinite(v) && v > 0 ? v : 0
  }
  setConsumed(nutrients, 'manual')
  $('#csvstatus').textContent = 'Saved.'
  $('#csvstatus').className = 'status ok'
}

$('#savetargets').onclick = () => {
  for (const key of Object.keys(DEFAULT_PROFILE.targets)) {
    const field = $(`#t_${key}`)
    // The carb key that is not the current basis has no input on screen. It stays at 0,
    // which is what keeps a total-carb dish figure from ever meeting a net-carb target.
    if (!field) { profile.targets[key] = 0; continue }
    const v = Number(field.value)
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

$('#copysettings').onclick = async () => {
  const status = $('#backupstatus')
  try {
    await navigator.clipboard.writeText(settingsBlob())
    status.textContent = 'Copied. Paste it into Notes — that is your restore point.'
    status.className = 'status ok'
  } catch {
    // Same clipboard restriction as the Shortcut import: show the text so it can be
    // selected by hand rather than pretending the copy worked.
    $('#restorebox').open = true
    $('#restoretext').value = settingsBlob()
    status.textContent = 'Clipboard blocked — select the text below and copy it manually.'
    status.className = 'status bad'
  }
}

$('#restorego').onclick = () => {
  const status = $('#backupstatus')
  try {
    const restored = restoreSettings($('#restoretext').value)
    status.textContent = `Restored ${restored} setting group(s).`
    status.className = 'status ok'
  } catch (err) {
    status.textContent = err.message
    status.className = 'status bad'
  }
}

$('#reset').onclick = () => {
  if (!confirm('Clear targets, ratings and blocked ingredients on this phone?')) return
  localStorage.removeItem(PROFILE_KEY)
  profile = loadProfile()
  renderPrefs(); renderFuel(); renderNow()
}

// A blob URL is held alive by the document until it is revoked, and a full-size PNG per dish
// adds up over a tray's worth of picks.
$('#cronodlg').onclose = releaseLabel

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

// Tabs rather than a dropdown: with two halls open the question is "J2 or JCL", and that
// should be one tap. Hidden entirely while only one hall is listed — a tab strip with a single
// tab is furniture. It appears on its own the day the scrape finds a second hall.
function populateHalls() {
  const box = $('#halltabs')
  box.innerHTML = ''
  if (!menu.halls.some((h) => h.num === hallNum)) hallNum = menu.halls[0]?.num ?? null

  for (const hall of menu.halls) {
    const b = document.createElement('button')
    b.setAttribute('role', 'tab')
    b.setAttribute('aria-selected', String(hall.num === hallNum))
    b.className = hall.num === hallNum ? 'on' : ''
    b.textContent = hall.name
    b.onclick = () => {
      hallNum = hall.num
      populateHalls()
      populateMeals()
      renderNow()
    }
    box.append(b)
  }
  box.classList.toggle('hidden', menu.halls.length < 2)
}

function populateModes() {
  const box = $('#modetabs')
  box.innerHTML = ''
  for (const [key, m] of Object.entries(MODES)) {
    const b = document.createElement('button')
    b.setAttribute('role', 'tab')
    b.setAttribute('aria-selected', String(key === mode))
    b.className = key === mode ? 'on' : ''
    b.textContent = m.label
    b.onclick = () => { mode = key; populateModes(); renderNow() }
    box.append(b)
  }
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
  populateModes()
  populateMeals()
  renderPrefs()
  renderNow()
  renderLogStrip()
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline cache is a bonus */ })
}

// Asks the browser not to evict this app's storage. iOS prunes script-writable storage for
// sites it has not seen in about a week, which reads as "the app forgot my targets again".
// Safari grants this to installed home-screen apps and quietly declines elsewhere; either
// way the Backup section in Prefs is the real safety net.
navigator.storage?.persist?.().catch(() => { /* declined is fine, nothing depends on it */ })

start()
