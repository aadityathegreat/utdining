// The recommender. Pure functions, no DOM, no I/O — imported by both the app and the
// tests. The weights below are the product decision; everything else is arithmetic.

import { withDerived, suspectOf } from './nutrition.mjs'

// Protein is weighted heaviest because it is the nutrient a dining hall makes hardest
// to hit and the one most likely to be short by dinner.
export const REWARD_WEIGHTS = {
  protein_g: 3.0,
  fiber_g: 1.0,
  calcium_mg: 0.5,
  iron_mg: 0.5,
  potassium_mg: 0.5,
  vitd_mcg: 0.5,
}

export const PENALTY_WEIGHTS = {
  sodium_mg: 1.5,
  satfat_g: 1.0,
  addedsugar_g: 1.0,
}

// Disliked items are down-weighted rather than removed: a hard block would eventually
// leave an empty screen on a bad menu day.
export const PREF_MULTIPLIER = { like: 1.4, neutral: 1.0, dislike: 0.4 }

export const MAX_ITEMS = 4
export const STOP_BELOW_KCAL = 150

// Nobody takes four baked potatoes. Caps are per unit type because "4 servings" of a
// 4 oz scoop is a normal plate and four whole potatoes is not.
export const MAX_SERVINGS = { count: 2, volume: 3, weight: 3 }

// Opt-in only, and off by default: whether to filter on this is the user's call, not
// the app's.
export const REFLUX_TERMS = [
  'tomato', 'marinara', 'salsa', 'citrus', 'orange', 'lemon', 'lime',
  'chili', 'jalapeno', 'chipotle', 'cayenne', 'hot sauce', 'sriracha',
  'garlic', 'onion', 'peppermint', 'chocolate', 'coffee', 'espresso', 'vinegar', 'fried',
]

const GRAMS_PER_OZ = 28.3495

// ---------------------------------------------------------------------------

/**
 * What is left to eat today. Nutrients with no target set are simply not scored.
 *
 * A consumed value of `null` means "logged, but this figure is unavailable" — Apple
 * Health has no added-sugars type at all, for instance. That nutrient drops out of
 * scoring entirely rather than being read as zero consumed, which would invent a full
 * day's budget out of missing data. A key that is simply absent means nothing has been
 * eaten against it yet, which is a real zero.
 */
export function needVector(targets, consumed) {
  const need = {}
  for (const [k, target] of Object.entries(targets ?? {})) {
    if (!(target > 0)) continue
    if (consumed && k in consumed && consumed[k] == null) continue
    need[k] = Math.max(0, target - (consumed?.[k] ?? 0))
  }
  return need
}

/**
 * The figures to reason about: what UT published, plus net carbohydrate derived from it.
 * Every read of `item.nutrients` inside this module goes through here, so a dish and a
 * target can never end up being compared on different definitions of "carbs".
 */
export const nutrientsOf = (item) => withDerived(item?.nutrients ?? {})

/** Hard filters. An excluded item never reaches scoring. */
/**
 * FoodPro's allergen wording, keyed by the diet icon that means the same thing.
 *
 * The room's rule is that restriction filtering reads the menu page's diet icons and never
 * the label's allergen text, because that text is blank on 27-42% of dishes depending on the
 * hall. That rule stands — the text can never be the filter. What a sweep of all 1002 items
 * across the three halls showed on 2026-08-23 is that the icons are not sufficient on their
 * own either: **75 dishes name an allergen in the text while carrying no matching icon**,
 * because 33 dishes publish no icons at all and UT applies the Tree Nuts icon especially
 * loosely (64 of the 75).
 *
 * Two of those leaked past Aadi's own Beef and Pork restrictions: Chopped Brisket at J2
 * dinner and Asado de Puerco at Kins lunch, both with an empty icon list and both naming
 * their meat in the text.
 *
 * So the text is a second net under the icons, never a replacement for them. Union can only
 * ever exclude more, which is the safe direction for a rule that exists to keep food off the
 * plate. Note the vocabularies differ — the Soy icon is "Soybeans" in the text, TreeNuts is
 * "Tree Nuts", Shellfish is "Crustacean Shellfish" — so this map is the translation, not a
 * convenience.
 *
 * Vegan, Halal and Veggie are deliberately absent: 699 dishes carry the Vegan or Halal icon
 * and **not one** names it in the text. Those three are icon-only, exactly as the room said.
 */
export const ALLERGEN_TEXT = {
  Beef: 'Beef',
  Pork: 'Pork',
  Milk: 'Milk',
  Eggs: 'Eggs',
  Fish: 'Fish',
  Shellfish: 'Crustacean Shellfish',
  Peanuts: 'Peanuts',
  Sesame: 'Sesame',
  Soy: 'Soybeans',
  Wheat: 'Wheat',
  TreeNuts: 'Tree Nuts',
}

export function isExcluded(item, profile) {
  const restrictions = profile.restrictions ?? []
  if (item.icons?.some((i) => restrictions.includes(i))) return 'restriction'

  // The second net. See ALLERGEN_TEXT: the icons miss 75 dishes that the text catches.
  const allergens = item.allergens ?? []
  if (restrictions.some((r) => ALLERGEN_TEXT[r] && allergens.includes(ALLERGEN_TEXT[r]))) {
    return 'restriction'
  }

  const ingredients = (item.ingredients ?? '').toLowerCase()
  const name = (item.name ?? '').toLowerCase()
  const hit = (term) => ingredients.includes(term) || name.includes(term)

  const blocked = (profile.ingredientBlocklist ?? []).find((t) => hit(t.toLowerCase()))
  if (blocked) return `blocked:${blocked}`

  if (profile.refluxFilter && REFLUX_TERMS.some(hit)) return 'reflux'

  // Last, deliberately. The checks above are the user's own rules and are the more useful
  // thing to hear about a dish; this one is a fault in UT's data. Blocked rather than
  // repaired, and overridable per dish so a false positive is never a dead end.
  if (!(profile.allowSuspect ?? []).includes(item.itemId) && suspectOf(item).length > 0) {
    return 'suspect'
  }

  return null
}

function prefMultiplier(item, profile) {
  const w = profile.itemWeights?.[item.itemId]
  if (w > 0) return PREF_MULTIPLIER.like
  if (w < 0) return PREF_MULTIPLIER.dislike
  return PREF_MULTIPLIER.neutral
}

/**
 * How well one serving closes the remaining gap.
 *
 * A null nutrient means UT did not publish the figure. It scores nothing either way —
 * an unknown must never read as a virtue, and it cannot be penalised honestly either.
 * Items with unknown penalty nutrients are flagged so the UI can say so.
 */
export function scoreItem(item, need, profile) {
  const n = nutrientsOf(item)
  const weights = { ...REWARD_WEIGHTS, ...(profile.nutrientWeightOverrides ?? {}) }

  let reward = 0
  for (const [k, w] of Object.entries(weights)) {
    if (!(need[k] > 0) || n[k] == null) continue
    reward += w * Math.min(n[k] / need[k], 1) // capped so bulk alone cannot win
  }

  let penalty = 0
  const unknown = []
  // "too salty" on a disliked dish raises the sodium penalty for every future dish.
  const penalties = { ...PENALTY_WEIGHTS, ...(profile.penaltyWeightOverrides ?? {}) }
  for (const [k, p] of Object.entries(penalties)) {
    if (!(need[k] > 0)) continue
    if (n[k] == null) { unknown.push(k); continue }
    penalty += p * (n[k] / need[k])
  }

  // Favours the item that closes the gap for fewer calories — grilled over fried.
  const kcalCost = need.kcal > 0 && n.kcal != null ? 1 + n.kcal / need.kcal : 1
  const score = ((reward - penalty) * prefMultiplier(item, profile)) / kcalCost

  return { score, reward, penalty, unknown }
}

// ---------------------------------------------------------------------------
// Portions
// ---------------------------------------------------------------------------

const roundToStep = (x, step) => Math.round(x / step) * step

/**
 * Eating modes. A mode changes three things: how much of the day's remainder the plate is
 * sized against, how many dishes it may span, and which nutrients are rewarded.
 *
 * `preworkout` is the only one that reverses a weight — fibre goes from reward to penalty, and
 * fat is penalised harder. That is a rule of thumb about eating before training, not a health
 * claim, and the UI says so. Everything else stays the arithmetic the room's rules describe.
 */
export const MODES = {
  meal: {
    label: 'Meal',
    kcalCap: null, // sized by shareForMeal instead — a meal is a share of what is left
    maxItems: MAX_ITEMS,
    rewards: {},
    penalties: {},
  },
  snack: {
    label: 'Snack',
    kcalCap: 300,
    maxItems: 2,
    rewards: {},
    penalties: {},
  },
  preworkout: {
    label: 'Pre-workout',
    kcalCap: 400,
    // One dish, not two. The recommender picks each later item against what the earlier ones
    // left unmet, so a second slot reliably filled itself with the highest-fibre thing on the
    // line once the carbs were covered — beans behind pasta. One dish before training is also
    // the realistic ask.
    maxItems: 1,
    // Both carb keys are rewarded because only one of them can carry a target: Prefs stores
    // the carbohydrate goal as total OR net, never both, and needVector ignores a zero.
    rewards: { carb_g: 3.0, netcarb_g: 3.0, protein_g: 1.5, fiber_g: 0 },
    // Fibre is penalised hard rather than merely un-rewarded. At 1.5 the first build still
    // ranked kidney beans second behind pasta, because the carb reward outweighed it — which
    // is the one food shape this mode exists to avoid.
    penalties: { fiber_g: 3.0, fat_g: 2.0 },
  },
}

/**
 * The profile a mode implies. Returned as a copy so the stored profile is never mutated —
 * a mode is a view of the same preferences, not a change to them.
 */
export function profileForMode(profile, modeKey) {
  const mode = MODES[modeKey] ?? MODES.meal
  return {
    ...profile,
    nutrientWeightOverrides: { ...(profile.nutrientWeightOverrides ?? {}), ...mode.rewards },
    penaltyWeightOverrides: { ...(profile.penaltyWeightOverrides ?? {}), ...mode.penalties },
  }
}

/**
 * Scales a need vector down to a calorie ceiling, keeping every nutrient in proportion.
 *
 * Used for snacks and pre-workout food, where the honest question is not "what is left today"
 * but "what fits in 300 calories of it". With no energy target set there is nothing to scale
 * against, so the vector is returned untouched rather than guessed at.
 */
export function shareForKcal(need, kcalCap) {
  if (!(need.kcal > 0) || !(kcalCap > 0)) return { ...need }
  const factor = Math.min(1, kcalCap / need.kcal)
  return Object.fromEntries(Object.entries(need).map(([k, v]) => [k, v * factor]))
}

/** Rounds servings to something actually servable at a buffet line. */
export function roundServings(servings, portion) {
  if (portion.unitClass === 'count') return Math.max(1, Math.round(servings))
  return Math.max(0.5, roundToStep(servings, 0.5))
}

/**
 * How far one nudge of a log stepper moves, and the range it may move inside.
 *
 * Deliberately not `roundServings` and not `MAX_SERVINGS`. Those two answer "what is worth
 * advising at a buffet line" — never half a piece, never more than two or three servings.
 * The log answers a different question: what was actually taken. Half a burger and a fourth
 * ladle of soup are both real, and a stepper that refuses to record them does not remove the
 * error, it just moves it somewhere nobody can see.
 *
 * Halves for every unit class, count included. `describeServing` renders the result in the
 * dish's own noun, so half of a `1 each` reads "0.5 pieces" and never becomes a gram figure.
 *
 * The ceiling is a stuck-thumb guard, not a nutritional judgement: twelve servings is past
 * anything plausible, and without a ceiling a held button walks the log into the hundreds.
 */
export const LOG_STEP = 0.5
export const MIN_LOG_SERVINGS = 0.5
export const MAX_LOG_SERVINGS = 12

export function stepServings(current, delta, step = LOG_STEP) {
  const from = Number(current)
  const base = Number.isFinite(from) ? from : MIN_LOG_SERVINGS
  // Snap before stepping, not after. A pick arrives on whatever `roundServings` produced —
  // an integer for count dishes — and a rescaled entry can be anything at all. Stepping off
  // an unsnapped value would carry the offset through every later nudge.
  const next = roundToStep(base, step) + delta * step
  return Math.min(MAX_LOG_SERVINGS, Math.max(MIN_LOG_SERVINGS, roundToStep(next, step)))
}

// What the thing is actually called on the line, so the number means something while
// holding a tray.
const COUNT_NOUN = {
  each: ['piece', 'pieces'],
  piece: ['piece', 'pieces'],
  slice: ['slice', 'slices'],
  pizza: ['slice', 'slices'],
  serving: ['serving', 'servings'],
}

/**
 * How to physically take it. Grams appear only when the portion is a true weight;
 * ladles are volume scoops and never produce a gram figure.
 */
export function describeServing(servings, portion) {
  // Leading with the serving count is what you can act on while holding a tray; the
  // weight follows as a cross-check and for logging. Deliberately "servings", not
  // "scoops" — UT publishes the portion size but not which utensil is in which pan, so
  // one-scoop-equals-one-serving is an assumption, not something the data supports.
  if (portion.unitClass === 'weight' && portion.grams != null) {
    const oz = servings * portion.qty
    const count = `${trim(servings)} ${servings === 1 ? 'serving' : 'servings'}`
    return `${count} · ${trim(oz)} oz (~${roundToStep(oz * GRAMS_PER_OZ, 5)} g)`
  }

  if (portion.unitClass === 'volume') {
    const scoops = trim(servings)
    return servings === 1 ? `1 ladle (${portion.raw})` : `${scoops} ladles (${portion.raw} each)`
  }

  // "1/12 pizza" x 4 servings is four slices, not "4 x 1/12 pizza".
  const units = portion.unit === 'pizza' ? servings : servings * portion.qty
  const [one, many] = COUNT_NOUN[portion.unit] ?? ['serving', 'servings']
  return `${trim(units)} ${units === 1 ? one : many}`
}

/**
 * What a given number of servings actually delivers.
 *
 * Unpublished nutrients are dropped rather than zeroed, and the distinction survives into
 * the day's running total: a dish with no published sodium must not make the day's sodium
 * look lower than it is.
 */
export function deliversFor(nutrients, servings) {
  return Object.fromEntries(
    Object.entries(nutrients ?? {})
      .filter(([, v]) => v != null)
      .map(([k, v]) => [k, v * servings]),
  )
}

/**
 * The day's intake as the recommender should see it: an imported baseline plus whatever
 * was logged in the app since.
 *
 * A baseline nutrient of `null` means "logged today, figure unavailable" — Apple Health
 * publishes no added-sugars type at all. It STAYS null even when a logged dish would add
 * to it, because a partial figure read as a total invents budget out of missing data.
 * `needVector` then drops that nutrient from scoring, which is the honest outcome.
 *
 * A nutrient absent from the baseline but present in the log is a real number: nothing was
 * eaten against it before, and now something was.
 */
export function mergeConsumed(baseline, logged) {
  if (!baseline) return { ...(logged ?? {}) }
  const out = { ...baseline }
  for (const [k, v] of Object.entries(logged ?? {})) {
    if (k in out && out[k] == null) continue
    out[k] = (out[k] ?? 0) + v
  }
  return out
}

// The nutrient inputs on Cronometer's Create a Custom Food form, in the order the form
// presents them. Deliberately TOTAL carbohydrate: this is a nutrition label, and Cronometer
// computes net carbs itself from the fibre it is given. Handing it a net figure in the
// carbohydrate box would subtract fibre twice.
const CRONOMETER_ROWS = [
  ['Energy', 'kcal', 'kcal'], ['Protein', 'protein_g', 'g'], ['Carbs', 'carb_g', 'g'],
  ['Fat', 'fat_g', 'g'], ['Saturated', 'satfat_g', 'g'], ['Trans-Fats', 'transfat_g', 'g'],
  ['Cholesterol', 'chol_mg', 'mg'], ['Sodium', 'sodium_mg', 'mg'], ['Fiber', 'fiber_g', 'g'],
  ['Sugars', 'sugar_g', 'g'], ['Added Sugars', 'addedsugar_g', 'g'],
  ['Vitamin D', 'vitd_mcg', 'mcg'], ['Calcium', 'calcium_mg', 'mg'], ['Iron', 'iron_mg', 'mg'],
  ['Potassium', 'potassium_mg', 'mg'],
]

/** Raised instead of returning a payload, so a blocked dish cannot be copied by accident. */
export class SuspectItemError extends Error {}

/**
 * Every field of Cronometer's "Create a Custom Food" form, in form order, as separate
 * values — because Cronometer's mobile form is separate inputs and one paste has never
 * filled them. Each entry is one tap to copy and one field to fill.
 *
 * `value` is null where UT published nothing. That field is left blank in Cronometer:
 * typing 0 would assert the food contains none of it and quietly skew every later total.
 *
 * @throws {SuspectItemError} when the dish's published figures failed the plausibility
 *   checks. Matching Cronometer perfectly to a wrong UT number is still a wrong diary.
 */
export function cronometerFields(item, servings, { allowSuspect = false } = {}) {
  const suspect = suspectOf(item)
  // `allowSuspect` is the same per-dish override that lets it back into the plate. Without it
  // here, "Use it anyway" would return a dish to the picks and then refuse to hand over its
  // numbers, which is a dead end in the middle of the flow rather than a safeguard.
  if (suspect.length > 0 && !allowSuspect) {
    throw new SuspectItemError(
      `UT's figures for ${item.name} do not look right: ${suspect.map((s) => s.message).join('; ')}.`,
    )
  }

  const n = item.nutrients ?? {}
  return [
    { label: 'Food Name', value: `${item.name} (UT ${item.station ?? 'dining'})`, unit: '' },
    { label: 'Serving Name', value: item.portion.raw, unit: '' },
    // Only ever a real weight. A ladle is a volume scoop and UT publishes no gram figure
    // for one, so the field is left out rather than estimated.
    ...(item.portion.unitClass === 'weight' && item.portion.grams != null
      ? [{ label: 'Serving Weight', value: item.portion.grams, unit: 'g' }]
      : []),
    { label: 'Nutrition Displayed Per', value: '1 serving', unit: '' },
    { label: 'Nutrition Label Type', value: 'Updated American', unit: '' },
    ...CRONOMETER_ROWS.map(([label, key, unit]) => ({ label, value: n[key] ?? null, unit })),
  ]
}

/**
 * The same fields as one block of text, for reference while typing them in.
 *
 * Cronometer has no public API, accepts no diary import, and its mobile Custom Food screen
 * is a set of separate numeric inputs — so nothing can be pushed into it and no single
 * paste can fill it. This block is a reference for manual entry and says so. The values are
 * PER SERVING so the custom food is created once and only the quantity changes after that.
 *
 * @throws {SuspectItemError} see cronometerFields.
 */
export function cronometerEntry(item, servings, options) {
  const lines = cronometerFields(item, servings, options).map(({ label, value, unit }) =>
    `${label}: ${value == null ? '(not published — leave blank)' : `${value}${unit}`}`)

  return [
    'Cronometer → Create a Custom Food. Type these in; there is no paste that fills them.',
    '',
    ...lines,
    '',
    `Then log ${trim(servings)} × this serving.`,
  ].join('\n')
}

/** Bumped only when the shape below changes in a way the helper must notice. */
export const PAYLOAD_VERSION = 1

/**
 * The same fields again, as JSON, for the form helper to read off the clipboard.
 *
 * This is the **spike** the release gate has been waiting on since 2026-08-14 (roadmap B1) and
 * it is unproven: nobody has yet filled a real Cronometer Custom Food form from it. The
 * one-tap-per-field list stays the supported path until that test is run. See `docs/HELPER.md`.
 *
 * Deliberately built on `cronometerFields` rather than beside it. Two payload builders would
 * be two definitions of "what a dish is worth", and the day they disagreed the wrong one would
 * be the one nobody was reading. The helper therefore fills the fields in the order Cronometer
 * presents them, from the same source as the printed list and the copy buttons.
 *
 * `null` survives JSON as `null` and the helper leaves that box untouched. It must never
 * become `0` or an empty string on the way through — the whole point of the field being blank
 * is that UT published nothing, and a 0 asserts the food contains none of it.
 *
 * @throws {SuspectItemError} via cronometerFields. A dish whose figures cannot be true must
 *   not get a faster route into the diary than a slower one.
 */
export function cronometerPayload(item, servings, options) {
  return JSON.stringify({
    utdining: PAYLOAD_VERSION,
    fields: cronometerFields(item, servings, options).map(({ label, value }) => ({ label, value })),
  })
}

/**
 * Splits what is left of the day across the meals still to come. Without this the
 * recommender sizes a single lunch to cover everything not yet eaten that day.
 */
/**
 * Which meals a hall serves on a given date.
 *
 * Falls back to the hall's own repertoire — every meal name it publishes anywhere in the
 * scraped window, in the order it first publishes them — and never to a hardcoded
 * Breakfast/Lunch/Dinner. That fallback was written when J2 was the only hall and every
 * hall served three meals. JCL Dining serves lunch and dinner only, so the old default
 * offered a breakfast that does not exist and, worse, told `shareForMeal` that two more
 * meals were still coming — sizing a single plate against a third of the day.
 *
 * An empty array is a real answer: a hall with nothing scraped serves nothing we know of,
 * and inventing meals for it is what caused the bug.
 */
export function mealNamesFor(hall, date) {
  const day = hall?.days?.find((d) => d.date === date)
  if (day) return day.meals.map((m) => m.meal)
  return mealRepertoire(hall)
}

/**
 * Every meal a hall publishes anywhere in the scraped window, in the order it first
 * publishes them. This is the hall's standing repertoire rather than one day's menu, so it
 * survives a closure: JCL Dining's repertoire is Lunch and Dinner whether or not it is open
 * today. Split out of `mealNamesFor` because the compare view needs both answers about the
 * same hall at once — what it serves at all, and what it serves today.
 */
export function mealRepertoire(hall) {
  const seen = []
  for (const d of hall?.days ?? []) {
    for (const m of d.meals) if (!seen.includes(m.meal)) seen.push(m.meal)
  }
  return seen
}

/** "lunch and dinner", "breakfast, lunch and dinner" — an Oxford-comma-free list. */
export const listWords = (words) => words.length < 2
  ? (words[0] ?? '')
  : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`

/**
 * The dishes on one hall's menu for one meal on one date, each stamped with the station it
 * is served at.
 *
 * Pulled out of the app so the compare view asks the question exactly the way the Now tab
 * does. Two ways of reading the same menu would eventually disagree, and the one that
 * disagreed would be the one nobody was looking at.
 */
export function itemsForMeal(menu, hall, date, mealName) {
  const day = hall?.days?.find((d) => d.date === date)
  const meal = day?.meals?.find((m) => m.meal === mealName)
  if (!meal) return []

  // The station wins over anything on the item itself: it is a property of where the dish is
  // being served today, not of the recipe, and the same recipe turns up at different stations
  // and different halls.
  return meal.stations.flatMap((station) =>
    station.itemIds
      .map((id) => (menu?.items?.[id]
        ? { itemId: id, ...menu.items[id], station: station.name }
        : null))
      .filter(Boolean))
}

/**
 * Whether a hall can answer the question being asked of it, and if not, what to say instead.
 *
 * Four silences, and saying the wrong one is the bug this app already shipped once — it
 * offered JCL a breakfast that hall has never served. They are genuinely different facts:
 *
 * - `unlisted` — nothing scraped for this hall at all. We know of no meals it serves.
 * - `closed` — it serves meals, but publishes no menu for this date.
 * - `notserved` — it is open today and this meal is not in its repertoire. JCL at breakfast.
 * - `notoday` — the meal is in its repertoire but absent from today's menu.
 *
 * `text` is null only for `open`. Every other kind carries the sentence to render in that
 * hall's slot, because an empty slot is the one thing a comparison must never show.
 */
export function hallAvailability(hall, date, mealName) {
  const name = hall?.name ?? 'This hall'
  const serves = mealRepertoire(hall)
  const spoken = listWords(serves.map((m) => m.toLowerCase()))
  const meal = String(mealName ?? '').toLowerCase()

  if (serves.length === 0) {
    return { kind: 'unlisted', serves, text: `No menu published for ${name} at the moment.` }
  }
  if (!hall.days.some((d) => d.date === date)) {
    return {
      kind: 'closed',
      serves,
      text: `${name} publishes no menu for today. It serves ${spoken} on the days it is open.`,
    }
  }
  if (!serves.includes(mealName)) {
    return { kind: 'notserved', serves, text: `${name} does not serve ${meal}. It serves ${spoken}.` }
  }
  if (!mealNamesFor(hall, date).includes(mealName)) {
    return { kind: 'notoday', serves, text: `No ${meal} menu for today at ${name}.` }
  }
  return { kind: 'open', serves, text: null }
}

/** What a whole plate delivers. Unpublished nutrients were dropped by `deliversFor` on the
 *  way in and stay absent here — a blank must never total as a zero. */
export function plateDelivers(picks) {
  const total = {}
  for (const p of picks ?? []) {
    for (const [k, v] of Object.entries(p.delivers ?? {})) total[k] = (total[k] ?? 0) + v
  }
  return total
}

/**
 * The best plate at every hall for one meal, against one shared need vector.
 *
 * The question this answers is the one actually being asked walking out of Jester: J2 or
 * Kins or JCL. The hall tabs answer it only by making you tap through them one at a time
 * and hold three plates in your head.
 *
 * Every hall is scored against the SAME need vector, so the plates are comparable. That
 * vector is sized against the selected hall's meal sequence — see `mealsLeft` — because one
 * of them has to be chosen and a per-hall divisor would mean three plates measured against
 * three different budgets, which is not a comparison.
 *
 * Ratings and restrictions are global: items are keyed by FoodPro's `RecNumAndPort`, so the
 * same recipe is the same dish at every hall and a thumbs-down follows it around.
 *
 * A hall that cannot answer still gets an entry with `picks: []` and a sentence. Dropping it
 * would quietly turn "JCL does not serve breakfast" into "JCL does not exist".
 */
export function compareHalls(menu, { date, mealName, need, profile, maxItems } = {}) {
  return (menu?.halls ?? []).map((hall) => {
    const availability = hallAvailability(hall, date, mealName)
    const base = {
      num: hall.num,
      name: hall.name,
      coverage: coverageOf(hall),
      ...availability,
      items: [],
      picks: [],
      delivers: {},
    }
    if (availability.kind !== 'open') return base

    const items = itemsForMeal(menu, hall, date, mealName)
    const picks = recommend(items, need, profile, { maxItems })
    if (picks.length === 0) {
      return {
        ...base,
        kind: 'nofit',
        items,
        text: `Nothing on ${hall.name}'s ${String(mealName).toLowerCase()} line fits what you have left.`,
      }
    }
    return { ...base, items, picks, delivers: plateDelivers(picks) }
  })
}

/**
 * How much of a hall's week UT published nutrition for, or null if the question cannot be
 * answered from this `menu.json`.
 *
 * The fields are OPTIONAL by contract. The scraper started writing them on 2026-08-23 and
 * every `menu.json` committed before that has none, so an app that assumed them would report
 * a coverage of zero for a hall that publishes everything. Absent means say nothing — the
 * same rule as an unpublished nutrient, applied to a field about unpublished nutrients.
 * There is deliberately no "0 of 0" and no percentage derived from a missing count.
 */
export function coverageOf(hall) {
  const dishes = hall?.dishes
  const withNutrition = hall?.dishesWithNutrition
  const withoutNutrition = hall?.dishesWithoutNutrition
  const known = [dishes, withNutrition, withoutNutrition].every((n) => Number.isFinite(n) && n >= 0)
  if (!known || dishes === 0) return null

  // Neither published nor readable: UT served a label and the parser could not read it.
  // Counting those as "UT publishes nothing" would blame UT for our own failure.
  const unreadable = Math.max(0, dishes - withNutrition - withoutNutrition)
  const text = `${withNutrition} of ${dishes} dishes this week have published nutrition`
    + (withoutNutrition > 0 ? `; UT publishes no label for ${withoutNutrition}` : '')
    + (unreadable > 0 ? `; ${unreadable} could not be read` : '')
    + '.'

  return { dishes, withNutrition, withoutNutrition, unreadable, text }
}

/**
 * How many of the day's meals are still ahead, this one included.
 *
 * Counted against the meals the hall actually serves, so a hall that skips breakfast does
 * not get its lunch plate sized as though breakfast were still to come. An unknown meal
 * counts as the last one: spending the whole remainder on a plate is the safe direction to
 * be wrong in, since the alternative is advising a fraction of what is left and calling the
 * day done.
 */
export function mealsLeft(mealNames, selected) {
  const i = mealNames.indexOf(selected)
  return i === -1 ? 1 : mealNames.length - i
}

export function shareForMeal(need, mealsLeft) {
  const n = Math.max(1, mealsLeft)
  return Object.fromEntries(Object.entries(need).map(([k, v]) => [k, v / n]))
}

const trim = (x) => String(Math.round(x * 100) / 100)

const NUTRIENT_LABEL = {
  protein_g: ['g protein', 1], fiber_g: ['g fibre', 1], kcal: ['cal', 0],
  calcium_mg: ['mg calcium', 0], iron_mg: ['mg iron', 1],
  potassium_mg: ['mg potassium', 0], vitd_mcg: ['mcg vitamin D', 1],
}

/** One line saying why this was picked. Without a visible reason there is no way to
 *  tell when the recommender is wrong. */
function explain(item, servings, need) {
  const n = nutrientsOf(item)
  const ranked = Object.keys(REWARD_WEIGHTS)
    .filter((k) => need[k] > 0 && n[k] != null && n[k] > 0)
    .sort((a, b) =>
      (REWARD_WEIGHTS[b] * Math.min(n[b] / need[b], 1)) -
      (REWARD_WEIGHTS[a] * Math.min(n[a] / need[a], 1)))
    .slice(0, 2)

  const parts = ranked.map((k) => {
    const [label, dp] = NUTRIENT_LABEL[k] ?? [k, 1]
    return `+${(n[k] * servings).toFixed(dp)} ${label}`
  })
  if (n.kcal != null) parts.push(`${Math.round(n.kcal * servings)} cal`)
  return parts.join(', ')
}

// ---------------------------------------------------------------------------

/**
 * Builds a plate: repeatedly take the best-scoring item, work out how much of it to
 * take, subtract that from what is still needed, and score again against the smaller
 * gap. Stops at MAX_ITEMS so the result stays a meal and not a spreadsheet.
 */
export function recommend(items, need, profile, options = {}) {
  const maxItems = options.maxItems ?? MAX_ITEMS
  const remaining = { ...need }
  const picks = []

  const pool = items.filter((it) => !isExcluded(it, profile))

  while (picks.length < maxItems) {
    if (remaining.kcal != null && remaining.kcal < STOP_BELOW_KCAL) break

    const ranked = pool
      .filter((it) => !picks.some((p) => p.itemId === it.itemId))
      .map((it) => ({ item: it, ...scoreItem(it, remaining, profile) }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score)

    if (ranked.length === 0) break

    const { item, unknown } = ranked[0]
    const n = nutrientsOf(item)

    // Enough to close the gap in whichever nutrient this item runs out of first —
    // sizing everything off protein alone lands four baked potatoes on the plate.
    let servings = Infinity
    for (const k of Object.keys(REWARD_WEIGHTS)) {
      if (remaining[k] > 0 && n[k] > 0) servings = Math.min(servings, remaining[k] / n[k])
    }
    if (!Number.isFinite(servings)) servings = 1
    if (remaining.kcal > 0 && n.kcal > 0) servings = Math.min(servings, remaining.kcal / n.kcal)
    servings = Math.min(servings, MAX_SERVINGS[item.portion.unitClass] ?? 2)
    servings = roundServings(servings, item.portion)

    // Rounding up must not blow the calorie budget.
    if (remaining.kcal > 0 && n.kcal > 0 && servings * n.kcal > remaining.kcal) {
      const step = item.portion.unitClass === 'count' ? 1 : 0.5
      const reduced = servings - step
      if (reduced * n.kcal <= remaining.kcal && reduced > 0) servings = reduced
      else if (picks.length > 0) break // a first pick may exceed; a fourth may not
    }

    picks.push({
      itemId: item.itemId,
      name: item.name,
      station: item.station,
      servings,
      display: describeServing(servings, item.portion),
      why: explain(item, servings, remaining),
      unknownNutrients: unknown,
      delivers: deliversFor(n, servings),
    })

    for (const k of Object.keys(remaining)) {
      if (n[k] != null) remaining[k] = Math.max(0, remaining[k] - n[k] * servings)
    }
  }

  return picks
}

/**
 * Nutrients the user is short on that UT does not publish for any dish — zinc, B12,
 * magnesium and the rest. The app reports these as information, never as a menu
 * recommendation, because there is no data to rank food by.
 */
export function unservableGaps(extraTargets, extras) {
  const gaps = []
  for (const [key, target] of Object.entries(extraTargets ?? {})) {
    if (!(target > 0)) continue
    const have = extras?.[key]
    if (have == null) continue
    if (have < target * 0.8) {
      gaps.push({ key, have, target, shortBy: Math.round((1 - have / target) * 100) })
    }
  }
  return gaps.sort((a, b) => b.shortBy - a.shortBy)
}
