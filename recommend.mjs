// The recommender. Pure functions, no DOM, no I/O — imported by both the app and the
// tests. The weights below are the product decision; everything else is arithmetic.

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

/** What is left to eat today. Nutrients with no target set are simply not scored. */
export function needVector(targets, consumed) {
  const need = {}
  for (const [k, target] of Object.entries(targets ?? {})) {
    if (!(target > 0)) continue
    need[k] = Math.max(0, target - (consumed?.[k] ?? 0))
  }
  return need
}

/** Hard filters. An excluded item never reaches scoring. */
export function isExcluded(item, profile) {
  const restrictions = profile.restrictions ?? []
  if (item.icons?.some((i) => restrictions.includes(i))) return 'restriction'

  const ingredients = (item.ingredients ?? '').toLowerCase()
  const name = (item.name ?? '').toLowerCase()
  const hit = (term) => ingredients.includes(term) || name.includes(term)

  const blocked = (profile.ingredientBlocklist ?? []).find((t) => hit(t.toLowerCase()))
  if (blocked) return `blocked:${blocked}`

  if (profile.refluxFilter && REFLUX_TERMS.some(hit)) return 'reflux'
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
  const n = item.nutrients ?? {}
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

/** Rounds servings to something actually servable at a buffet line. */
export function roundServings(servings, portion) {
  if (portion.unitClass === 'count') return Math.max(1, Math.round(servings))
  return Math.max(0.5, roundToStep(servings, 0.5))
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
  if (portion.unitClass === 'weight' && portion.grams != null) {
    const oz = servings * portion.qty
    return `${trim(oz)} oz (~${roundToStep(oz * GRAMS_PER_OZ, 5)} g)`
  }

  if (portion.unitClass === 'volume') {
    const scoops = trim(servings)
    return servings === 1 ? `1 scoop (${portion.raw})` : `${scoops} scoops (${portion.raw} each)`
  }

  // "1/12 pizza" x 4 servings is four slices, not "4 x 1/12 pizza".
  const units = portion.unit === 'pizza' ? servings : servings * portion.qty
  const [one, many] = COUNT_NOUN[portion.unit] ?? ['serving', 'servings']
  return `${trim(units)} ${units === 1 ? one : many}`
}

/**
 * Splits what is left of the day across the meals still to come. Without this the
 * recommender sizes a single lunch to cover everything not yet eaten that day.
 */
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
  const n = item.nutrients
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
    const n = item.nutrients

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
      delivers: Object.fromEntries(
        Object.entries(n).filter(([, v]) => v != null).map(([k, v]) => [k, v * servings]),
      ),
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
