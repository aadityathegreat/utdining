// Derivations and source-data checks shared by the scraper and the app.
//
// This module exists because both ends need the same rules and neither should own them:
// the scraper stamps the results into menu.json at scrape time, and the app re-derives them
// at read time so a menu.json scraped before these rules existed is still protected.
// Everything here is pure and unit-agnostic — it reasons about the numbers UT published.

// ---------------------------------------------------------------------------
// Net carbs
// ---------------------------------------------------------------------------

/**
 * Net carbohydrates for one serving: total carbohydrate less fibre.
 *
 * DERIVED, not published. UT publishes total carbohydrate and dietary fibre and nothing
 * else, so this is the same subtraction Cronometer itself performs — minus sugar alcohols,
 * which UT does not publish at all and which buffet food rarely contains. It is therefore
 * an estimate, and every surface that shows it says so.
 *
 * Returns null unless BOTH inputs were published. Deriving from a blank would invent a
 * number, and an invented carb figure scored against a net-carb target is exactly the bug
 * this function was added to end.
 */
export function netCarbs(nutrients) {
  const carb = nutrients?.carb_g
  const fiber = nutrients?.fiber_g
  if (carb == null || fiber == null) return null
  return Math.round(Math.max(0, carb - fiber) * 10) / 10
}

/** The nutrients as the app should read them: what UT published, plus what follows from it. */
export function withDerived(nutrients) {
  return { ...nutrients, netcarb_g: netCarbs(nutrients) }
}

// ---------------------------------------------------------------------------
// Source-data quarantine
// ---------------------------------------------------------------------------

// FoodPro publishes some figures that cannot be true of a single serving — a 4 oz side of
// stir-fry vegetables listed at 1,475 kcal and 163.6 g of fat, a 4 oz portion of chicken
// fried steak listed at 251.3 mg of iron. Both were verified live against UT's own pages on
// 2026-08-13. Copying them faithfully into Cronometer produces a wrong diary; recommending
// them produces a wrong plate. They are blocked here and the raw value is kept for display,
// because a silently repaired number is a worse lie than a blocked one.

// Nutrients that are a mass of the food itself. Their sum cannot exceed what the food weighs,
// and none of them individually can either.
const GRAM_NUTRIENTS = ['fat_g', 'carb_g', 'protein_g']

// Ceilings for one serving, set far above any real one. These are a backstop for figures the
// structural checks below cannot see — a portion with no weight, or a micronutrient that has
// no relationship to the food's mass. Deliberately loose: a false block hides real food.
const CEILING = {
  kcal: 1500,
  sodium_mg: 8000,
  chol_mg: 1500,
  iron_mg: 45, // the adult tolerable upper limit; fortified cereal tops out near 18 mg
  calcium_mg: 2500,
  potassium_mg: 6000,
  vitd_mcg: 250,
}

const LABEL = {
  kcal: 'calories', fat_g: 'fat', satfat_g: 'saturated fat', transfat_g: 'trans fat',
  chol_mg: 'cholesterol', sodium_mg: 'sodium', carb_g: 'carbohydrate', fiber_g: 'fibre',
  sugar_g: 'sugars', addedsugar_g: 'added sugar', protein_g: 'protein',
  vitd_mcg: 'vitamin D', calcium_mg: 'calcium', iron_mg: 'iron', potassium_mg: 'potassium',
}

const UNIT = {
  kcal: 'kcal', vitd_mcg: 'mcg',
  fat_g: 'g', satfat_g: 'g', transfat_g: 'g', carb_g: 'g', fiber_g: 'g',
  sugar_g: 'g', addedsugar_g: 'g', protein_g: 'g',
  chol_mg: 'mg', sodium_mg: 'mg', calcium_mg: 'mg', iron_mg: 'mg', potassium_mg: 'mg',
}

const fmt = (key, value) => `${Math.round(value * 10) / 10} ${UNIT[key] ?? ''}`.trim()

// A component cannot exceed the whole it is part of. These catch a mistyped decimal place
// without needing to know anything about the food.
const SUBSET = [
  ['satfat_g', 'fat_g'],
  ['transfat_g', 'fat_g'],
  ['fiber_g', 'carb_g'],
  ['sugar_g', 'carb_g'],
  ['addedsugar_g', 'sugar_g'],
]

// How far published calories may sit from what the macros imply before it counts as a
// disagreement rather than rounding. Wide on purpose: Atwater factors are approximations,
// fibre contributes less than 4 kcal/g, and UT rounds.
//
// The floor is what governs small dishes, where a percentage is worth almost nothing. It was
// set to 100 rather than 80 after a real case: Roasted Chicken Bayou publishes 219 kcal
// against macros worth 133, and at 80 it was blocked. A cake claiming 164 kcal with 22.7 g
// of fat in it is still caught at 100, and blocking a good protein source over 6 kcal of
// slack is the more expensive mistake — a false block hides real food.
const KCAL_TOLERANCE_FRACTION = 0.4
const KCAL_TOLERANCE_FLOOR = 100

// Dishes whose published figures are wrong in a way no general rule catches. Keyed by the
// FoodPro recipe id so a renamed dish stays blocked. Empty until a verified case needs it —
// an entry here is a claim about UT's data, not a taste preference, and it must be checked
// against the live page first.
export const DENYLIST = Object.freeze(Object.create(null))

/**
 * Reasons this item's published nutrition cannot be trusted. Empty array means it is fine.
 *
 * @param {object} nutrients  the published per-serving figures; null means unpublished
 * @param {object} portion    the parsed portion, for its weight where there is one
 * @param {string} [itemId]   the FoodPro id, checked against DENYLIST
 * @returns {{code: string, message: string}[]}
 */
export function suspectReasons(nutrients, portion, itemId = null) {
  const out = []
  const n = nutrients ?? {}
  const at = (k) => (typeof n[k] === 'number' && Number.isFinite(n[k]) ? n[k] : null)

  if (itemId != null && DENYLIST[itemId]) {
    out.push({ code: 'denylist', message: DENYLIST[itemId] })
  }

  for (const [key, value] of Object.entries(n)) {
    if (typeof value === 'number' && value < 0) {
      out.push({ code: `negative:${key}`, message: `${LABEL[key] ?? key} is negative (${fmt(key, value)})` })
    }
  }

  // A weight portion is the one case where UT tells us what the serving physically weighs,
  // which turns every gram figure into something checkable.
  const grams = portion?.unitClass === 'weight' ? portion.grams : null
  if (grams > 0) {
    for (const key of GRAM_NUTRIENTS) {
      const v = at(key)
      // The slack is what stops pure sugar from being flagged: an ounce of powdered sugar is
      // 28.4 g of carbohydrate in a 28.3 g serving, which is rounding, not a bad figure.
      if (v != null && v > grams * 1.05 + 0.5) {
        out.push({
          code: `mass:${key}`,
          message: `${fmt(key, v)} of ${LABEL[key] ?? key} in a ${Math.round(grams)} g serving`,
        })
      }
    }
    const macros = GRAM_NUTRIENTS.reduce((a, k) => a + (at(k) ?? 0), 0)
    // 1.15 rather than 1.0: UT rounds each figure independently, and water and ash are not
    // published, so a dish that is almost entirely macronutrient can round slightly over.
    if (macros > grams * 1.15) {
      out.push({
        code: 'mass:total',
        message: `${Math.round(macros)} g of fat, carbohydrate and protein in a ${Math.round(grams)} g serving`,
      })
    }
  }

  for (const [part, whole] of SUBSET) {
    const a = at(part)
    const b = at(whole)
    if (a != null && b != null && a > b + 0.5) {
      out.push({
        code: `subset:${part}`,
        message: `${fmt(part, a)} of ${LABEL[part]} in ${fmt(whole, b)} of ${LABEL[whole]}`,
      })
    }
  }

  for (const [key, cap] of Object.entries(CEILING)) {
    const v = at(key)
    if (v != null && v > cap) {
      out.push({
        code: `ceiling:${key}`,
        message: `${fmt(key, v)} of ${LABEL[key] ?? key} in one serving (over ${fmt(key, cap)})`,
      })
    }
  }

  // Calories against the macros that are supposed to produce them. Only meaningful when all
  // three macros were published — a missing one would make every dish look wrong.
  const kcal = at('kcal')
  const p = at('protein_g')
  const c = at('carb_g')
  const f = at('fat_g')
  if (kcal != null && p != null && c != null && f != null) {
    const implied = 4 * p + 4 * c + 9 * f
    const slack = Math.max(KCAL_TOLERANCE_FLOOR, implied * KCAL_TOLERANCE_FRACTION)
    if (Math.abs(kcal - implied) > slack) {
      out.push({
        code: 'energy',
        message: `${Math.round(kcal)} kcal published, but the macros come to ${Math.round(implied)} kcal`,
      })
    }
  }

  return out
}

/** Convenience for the scraper: the item with a `suspect` array attached when it has one. */
export function withSuspect(item) {
  const reasons = suspectReasons(item.nutrients, item.portion)
  return reasons.length > 0 ? { ...item, suspect: reasons } : item
}

/**
 * What the app should treat as suspect: whatever the scraper stamped, or — for a menu.json
 * scraped before these checks existed — whatever the rules find right now.
 */
export function suspectOf(item) {
  if (Array.isArray(item?.suspect)) return item.suspect
  return suspectReasons(item?.nutrients, item?.portion, item?.itemId)
}
