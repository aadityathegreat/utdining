import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  recommend, scoreItem, needVector, isExcluded, describeServing, roundServings,
  stepServings, LOG_STEP, MIN_LOG_SERVINGS, MAX_LOG_SERVINGS, mealNamesFor, mealsLeft,
  cronometerEntry, cronometerFields, deliversFor, mergeConsumed, MODES, profileForMode,
  shareForKcal, shareForMeal, nutrientsOf, SuspectItemError, ALLERGEN_TEXT,
  compareHalls, hallAvailability, itemsForMeal, plateDelivers, coverageOf, mealRepertoire,
  listWords, cronometerPayload, PAYLOAD_VERSION,
} from '../recommend.mjs'

const nut = (o) => ({
  kcal: 0, fat_g: 0, satfat_g: 0, transfat_g: 0, chol_mg: 0, sodium_mg: 0,
  carb_g: 0, fiber_g: 0, sugar_g: 0, addedsugar_g: 0, protein_g: 0,
  vitd_mcg: 0, calcium_mg: 0, iron_mg: 0, potassium_mg: 0, ...o,
})

const item = (id, name, nutrients, extra = {}) => ({
  itemId: id,
  name,
  station: 'Test',
  icons: [],
  ingredients: '',
  portion: { raw: '4 oz', qty: 4, unit: 'oz', unitClass: 'weight', grams: 113.4 },
  nutrients: nut(nutrients),
  ...extra,
})

const GRILLED = item('g*1', 'Grilled Chicken', { kcal: 190, protein_g: 36, sodium_mg: 300 })
const FRIED = item('f*1', 'Fried Chicken', { kcal: 520, protein_g: 36, sodium_mg: 900, satfat_g: 9 })
const BEEF = item('b*1', 'Salisbury Steak', { kcal: 320, protein_g: 18 }, { icons: ['Beef'] })
const CAKE = item('c*1', 'Tres Leches Cake', { kcal: 400, addedsugar_g: 30, protein_g: 4 })

const TARGETS = { kcal: 2400, protein_g: 160, fiber_g: 30, sodium_mg: 2300 }
const PROFILE = { restrictions: ['Beef', 'Pork'], ingredientBlocklist: [], itemWeights: {} }

test('need vector: untargeted nutrients are not scored', () => {
  const need = needVector({ kcal: 2000, protein_g: 0 }, { kcal: 500 })
  assert.equal(need.kcal, 1500)
  assert.ok(!('protein_g' in need), 'a zero target must not become a goal')
})

test('restriction: a restricted item is never recommended', () => {
  assert.equal(isExcluded(BEEF, PROFILE), 'restriction')
  const picks = recommend([BEEF, GRILLED], needVector(TARGETS, {}), PROFILE)
  assert.ok(picks.every((p) => p.itemId !== 'b*1'), 'beef reached the plate')
})

test('restriction beats preference: a liked restricted item stays excluded', () => {
  const profile = { ...PROFILE, itemWeights: { 'b*1': 1 } }
  const picks = recommend([BEEF, GRILLED], needVector(TARGETS, {}), profile)
  assert.ok(picks.every((p) => p.itemId !== 'b*1'))
})

test('calorie efficiency: grilled beats fried at equal protein', () => {
  const need = needVector(TARGETS, {})
  assert.ok(scoreItem(GRILLED, need, PROFILE).score > scoreItem(FRIED, need, PROFILE).score)
})

test('dislike down-weights but does not remove', () => {
  const disliked = { ...PROFILE, itemWeights: { 'g*1': -1 } }
  assert.equal(isExcluded(GRILLED, disliked), null)
  const picks = recommend([GRILLED], needVector(TARGETS, {}), disliked)
  assert.equal(picks.length > 0, true, 'a disliked item must still surface when it is all there is')
})

test('unknown nutrients score nothing and are reported', () => {
  // Macros that actually add up to the stated calories: a dish whose figures cannot
  // produce its own energy is quarantined now, and that is a different test.
  const macros = { kcal: 200, protein_g: 20, fat_g: 6, carb_g: 10 }
  const known = item('k*1', 'Known', { ...macros, sodium_mg: 400 })
  const unknown = item('u*1', 'Unknown sodium', { ...macros, sodium_mg: null })
  const need = needVector(TARGETS, {})

  // The unpublished figure must not make the item look cleaner than the known one.
  const s = scoreItem(unknown, need, PROFILE)
  assert.deepEqual(s.unknown, ['sodium_mg'])
  assert.ok(s.score > scoreItem(known, need, PROFILE).score,
    'unknown is unpenalised, so it does score higher — the UI must disclose it')
  assert.ok(recommend([unknown], need, PROFILE)[0].unknownNutrients.includes('sodium_mg'))
})

test('a null nutrient is not read as zero', () => {
  const noFibre = item('n*1', 'No fibre data', { kcal: 100, protein_g: 5, fiber_g: null })
  const zeroFibre = item('z*1', 'Zero fibre', { kcal: 100, protein_g: 5, fiber_g: 0 })
  const need = needVector(TARGETS, {})
  assert.equal(scoreItem(noFibre, need, PROFILE).reward, scoreItem(zeroFibre, need, PROFILE).reward)
})

test('plate closes the protein gap without exceeding calories', () => {
  const menu = [GRILLED, CAKE, item('s*1', 'Black Beans', { kcal: 120, protein_g: 8, fiber_g: 7 })]
  const need = needVector(TARGETS, { kcal: 1200, protein_g: 90 })
  const picks = recommend(menu, need, PROFILE)

  const kcal = picks.reduce((a, p) => a + p.delivers.kcal, 0)
  const protein = picks.reduce((a, p) => a + p.delivers.protein_g, 0)

  assert.ok(picks.length > 0 && picks.length <= 4)
  assert.ok(kcal <= need.kcal, `plate is ${kcal} cal against ${need.kcal} available`)
  assert.ok(protein >= need.protein_g * 0.9, `plate delivers ${protein}g of ${need.protein_g}g`)
})

test('no item is recommended twice', () => {
  const picks = recommend([GRILLED, CAKE], needVector(TARGETS, {}), PROFILE)
  assert.equal(new Set(picks.map((p) => p.itemId)).size, picks.length)
})

test('gram honesty: no gram figure without a real weight portion', () => {
  const ladle = { raw: '4 ozL', qty: 4, unit: 'ozl', unitClass: 'volume', grams: null }
  const each = { raw: '1 each', qty: 1, unit: 'each', unitClass: 'count', grams: null }
  const pizza = { raw: '1/12 pizza', qty: 1 / 12, unit: 'pizza', unitClass: 'count', grams: null }

  for (const p of [ladle, each, pizza]) {
    for (const s of [1, 2, 2.5]) {
      assert.doesNotMatch(describeServing(s, p), /\d\s*g\b/, `${p.raw} @ ${s} leaked grams`)
    }
  }
})

test('gram honesty: weight portions do give grams', () => {
  const oz = { raw: '4 oz', qty: 4, unit: 'oz', unitClass: 'weight', grams: 113.4 }
  assert.equal(describeServing(1.5, oz), '1.5 servings · 6 oz (~170 g)')
})

test('servings round to something servable', () => {
  const count = { unitClass: 'count' }
  const weight = { unitClass: 'weight' }
  assert.equal(roundServings(1.4, count), 1)
  assert.equal(roundServings(0.2, count), 1, 'never recommend less than one piece')
  assert.equal(roundServings(1.3, weight), 1.5)
  assert.equal(roundServings(0.1, weight), 0.5)
})

test('ingredient blocklist catches unseen dishes', () => {
  const dish = item('m*1', 'Mystery Pasta', { kcal: 300, protein_g: 10 },
    { ingredients: 'Pasta, Cream, Sliced Mushrooms, Salt' })
  const profile = { ...PROFILE, ingredientBlocklist: ['mushroom'] }
  assert.equal(isExcluded(dish, profile), 'blocked:mushroom')
})

test('reflux filter is off unless switched on', () => {
  const salsa = item('r*1', 'Chips & Salsa', { kcal: 200, carb_g: 30, fat_g: 8 },
    { ingredients: 'Tomato, Onion, Lime' })
  assert.equal(isExcluded(salsa, PROFILE), null)
  assert.equal(isExcluded(salsa, { ...PROFILE, refluxFilter: true }), 'reflux')
})

test('serving display leads with the count, then the weight', () => {
  const oz = { raw: '3 oz', qty: 3, unit: 'oz', unitClass: 'weight', grams: 85.0 }
  assert.equal(describeServing(2, oz), '2 servings · 6 oz (~170 g)')
  assert.equal(describeServing(1, oz), '1 serving · 3 oz (~85 g)')
})

test('serving display never claims a specific utensil', () => {
  const oz = { raw: '3 oz', qty: 3, unit: 'oz', unitClass: 'weight', grams: 85.0 }
  // UT publishes portion sizes, not which scoop is in which pan.
  assert.doesNotMatch(describeServing(2, oz), /scoop/i)
})

test('cronometer entry marks unpublished nutrients instead of zeroing them', () => {
  const dish = item('x*1', 'Mystery Gravy', { kcal: 90, protein_g: 2, fat_g: 6, carb_g: 6, satfat_g: null })
  const text = cronometerEntry(dish, 1.5)
  assert.match(text, /Serving Name: 4 oz/)
  assert.match(text, /Energy: 90kcal/)
  assert.match(text, /Saturated: \(not published — leave blank\)/)
  assert.doesNotMatch(text, /Saturated: 0g/)
  assert.match(text, /Then log 1\.5 × this serving\./)
})

test('an unknown consumed value drops the nutrient instead of assuming zero eaten', () => {
  // null means "logged today, but this figure is unavailable" — not "ate none of it".
  const need = needVector({ kcal: 2000, addedsugar_g: 50 }, { kcal: 500, addedsugar_g: null })
  assert.equal(need.kcal, 1500)
  assert.ok(!('addedsugar_g' in need), 'unknown intake must not become a full budget')
})

test('an absent consumed key is still a real zero', () => {
  const need = needVector({ kcal: 2000, fiber_g: 38 }, { kcal: 500 })
  assert.equal(need.fiber_g, 38)
})

test('shareForKcal scales the whole vector to the calorie ceiling', () => {
  const scaled = shareForKcal({ kcal: 1200, protein_g: 60 }, 300)
  assert.equal(scaled.kcal, 300)
  assert.equal(scaled.protein_g, 15)
})

test('shareForKcal leaves the vector alone with no energy target', () => {
  // targets.kcal of 0 means "do not score energy", so there is nothing to scale against and
  // inventing a factor would silently shrink every other nutrient.
  assert.deepEqual(shareForKcal({ protein_g: 60 }, 300), { protein_g: 60 })
})

test('shareForKcal never scales up when little is left', () => {
  const scaled = shareForKcal({ kcal: 120, protein_g: 10 }, 300)
  assert.equal(scaled.kcal, 120)
  assert.equal(scaled.protein_g, 10)
})

test('pre-workout mode turns fibre from a reward into a penalty', () => {
  const p = profileForMode({ targets: {} }, 'preworkout')
  assert.equal(p.nutrientWeightOverrides.fiber_g, 0)
  // Penalised, and penalised harder than the carb reward can shrug off: at 1.5 the ranking
  // still put kidney beans behind pasta, which is the food shape this mode exists to avoid.
  assert.ok(p.penaltyWeightOverrides.fiber_g >= p.nutrientWeightOverrides.carb_g)
  assert.equal(p.nutrientWeightOverrides.carb_g, 3)
})

test('a mode never mutates the stored profile', () => {
  const original = { targets: {}, penaltyWeightOverrides: { sodium_mg: 2.25 } }
  const p = profileForMode(original, 'preworkout')
  assert.equal(original.penaltyWeightOverrides.fiber_g, undefined)
  assert.equal(p.penaltyWeightOverrides.sodium_mg, 2.25, 'a learned dislike survives the mode')
})

test('meal mode is sized by share, not a calorie cap', () => {
  assert.equal(MODES.meal.kcalCap, null)
  assert.ok(MODES.snack.kcalCap > 0)
})

test('deliversFor scales published nutrients and drops unpublished ones', () => {
  const delivered = deliversFor({ kcal: 200, protein_g: 12, sodium_mg: null }, 1.5)
  assert.equal(delivered.kcal, 300)
  assert.equal(delivered.protein_g, 18)
  assert.equal('sodium_mg' in delivered, false, 'an unpublished nutrient must not become 0')
})

test('mergeConsumed adds a logged dish to the imported baseline', () => {
  const merged = mergeConsumed({ kcal: 800, protein_g: 50 }, { kcal: 300, protein_g: 18 })
  assert.deepEqual(merged, { kcal: 1100, protein_g: 68 })
})

test('mergeConsumed keeps an unavailable baseline figure unavailable', () => {
  // Apple Health has no added-sugars type at all. A logged dish adding to it would turn
  // "unknown" into a number, and needVector would then hand out a budget for it.
  const merged = mergeConsumed({ kcal: 800, addedsugar_g: null }, { kcal: 300, addedsugar_g: 9 })
  assert.equal(merged.addedsugar_g, null)
  assert.equal(needVector({ addedsugar_g: 50 }, merged).addedsugar_g, undefined)
})

test('mergeConsumed counts a nutrient the baseline never mentioned', () => {
  const merged = mergeConsumed({ kcal: 800 }, { fiber_g: 6 })
  assert.equal(merged.fiber_g, 6)
})

test('mergeConsumed with no baseline is the log alone', () => {
  assert.deepEqual(mergeConsumed(null, { kcal: 300 }), { kcal: 300 })
})

// ---------------------------------------------------------------------------
// The Cronometer handoff: what the Custom Food form is actually given
// ---------------------------------------------------------------------------

test('the handoff carries the form metadata Cronometer asks for', () => {
  // Missing before: the form has a Nutrition Displayed Per and a Label Type control, and
  // a reference block that omitted them left two fields to guess at every time.
  const fields = cronometerFields(GRILLED, 1)
  const at = (label) => fields.find((f) => f.label === label)
  assert.equal(at('Nutrition Displayed Per').value, '1 serving')
  assert.equal(at('Nutrition Label Type').value, 'Updated American')
  assert.equal(at('Food Name').value, 'Grilled Chicken (UT Test)')
})

test('the handoff hands Cronometer TOTAL carbohydrate, never net', () => {
  // Cronometer derives net carbs from the carbohydrate and fibre it is given. A net figure
  // in the carbohydrate box subtracts fibre twice, every serving, forever.
  const dish = item('nc*1', 'Black Beans', { kcal: 130, carb_g: 24, fiber_g: 9, protein_g: 8 })
  const fields = cronometerFields(dish, 1)
  assert.equal(fields.find((f) => f.label === 'Carbs').value, 24)
  assert.ok(!fields.some((f) => /net/i.test(f.label)), 'net carbs are not a Cronometer input')
})

test('a weight portion contributes a serving weight; a ladle does not', () => {
  const ladle = item('l*1', 'Gravy', { kcal: 60 },
    { portion: { raw: '1 ozL', qty: 1, unit: 'ozl', unitClass: 'volume', grams: null } })
  assert.ok(cronometerFields(GRILLED, 1).some((f) => f.label === 'Serving Weight'))
  assert.ok(!cronometerFields(ladle, 1).some((f) => f.label === 'Serving Weight'),
    'a ladle is a volume scoop — no gram figure may be invented for it')
})

test('an unpublished nutrient is a blank field, never a zero', () => {
  const dish = item('u*1', 'Mystery Gravy', { kcal: 90, protein_g: 2, fat_g: 6, carb_g: 6, potassium_mg: null })
  assert.equal(cronometerFields(dish, 1).find((f) => f.label === 'Potassium').value, null)
})

// ---------------------------------------------------------------------------
// Source-data quarantine
// ---------------------------------------------------------------------------

// Verified against UT's live pages on 2026-08-13: 251.3 mg of iron in a 4 oz serving.
const BAD_IRON = item('bad*1', 'Chicken Fried Steak Strips', { kcal: 300, protein_g: 20, iron_mg: 251.3 })

test('a dish with implausible UT figures is excluded from the plate', () => {
  assert.equal(isExcluded(BAD_IRON, PROFILE), 'suspect')
  const picks = recommend([BAD_IRON, GRILLED], needVector(TARGETS, {}), PROFILE)
  assert.ok(picks.every((p) => p.itemId !== 'bad*1'), 'a quarantined dish reached the plate')
})

test('a quarantined dish cannot be copied into Cronometer', () => {
  // Matching Cronometer perfectly against a wrong UT number is still a wrong diary.
  assert.throws(() => cronometerFields(BAD_IRON, 1), SuspectItemError)
  assert.throws(() => cronometerEntry(BAD_IRON, 1), (e) => /251\.3 mg/.test(e.message))
})

test('an explicit override lets a quarantined dish through', () => {
  // A false positive must never be a dead end, and the override is per dish, not global.
  const allowed = { ...PROFILE, allowSuspect: ['bad*1'] }
  assert.equal(isExcluded(BAD_IRON, allowed), null)
  assert.equal(isExcluded(item('other*1', 'Also Bad', { iron_mg: 300 }), allowed), 'suspect')
})

test('the quarantine reads a stamp from menu.json as well as deriving it', () => {
  const stamped = item('st*1', 'Flagged Upstream', { kcal: 200, protein_g: 10 },
    { suspect: [{ code: 'denylist', message: 'checked against the live page by hand' }] })
  assert.equal(isExcluded(stamped, PROFILE), 'suspect')
})

// ---------------------------------------------------------------------------
// Total carbs and net carbs are different quantities
// ---------------------------------------------------------------------------

const BEANS = item('bn*1', 'Black Beans', { kcal: 130, carb_g: 24, fiber_g: 9, protein_g: 8 })

test('a dish carries both carb figures, and they differ', () => {
  const n = nutrientsOf(BEANS)
  assert.equal(n.carb_g, 24)
  assert.equal(n.netcarb_g, 15)
})

test('a net-carb target is scored against net carbs, not total', () => {
  // The bug this replaces: one carb_g value answered a Cronometer net-carb goal, so 24 g of
  // black beans counted as 24 g against a target measured in a quantity worth 15.
  const need = needVector({ netcarb_g: 100 }, {})
  const scored = scoreItem(BEANS, need, { ...PROFILE, nutrientWeightOverrides: { netcarb_g: 1 } })
  assert.ok(Math.abs(scored.reward - 15 / 100) < 1e-9, 'net carbs must drive a net-carb target')
})

test('a target in the other carb basis is simply not scored', () => {
  // Prefs keeps exactly one of the two at a nonzero value, which is what makes it
  // impossible to compare a dish's total carbohydrate with a net-carb goal.
  const need = needVector({ netcarb_g: 100, carb_g: 0 }, {})
  assert.ok(!('carb_g' in need))
})

test('net carbs stay unknown when UT published no fibre', () => {
  const noFibre = item('nf*1', 'Mystery Rice', { kcal: 200, carb_g: 40, fiber_g: null })
  assert.equal(nutrientsOf(noFibre).netcarb_g, null)
  const need = needVector({ netcarb_g: 100 }, {})
  const scored = scoreItem(noFibre, need, { ...PROFILE, nutrientWeightOverrides: { netcarb_g: 1 } })
  assert.equal(scored.reward, 0, 'an unknown must never score as a virtue')
})

test('what a logged dish delivers includes its net carbs', () => {
  const delivered = deliversFor(nutrientsOf(BEANS), 2)
  assert.equal(delivered.carb_g, 48)
  assert.equal(delivered.netcarb_g, 30)
})

test('the override reaches the Cronometer copy, not just the plate', () => {
  // Without this, "Use it anyway" returned a dish to the picks and then refused to hand over
  // its numbers — a dead end in the middle of the flow rather than a safeguard.
  const fields = cronometerFields(BAD_IRON, 1, { allowSuspect: true })
  assert.equal(fields.find((f) => f.label === 'Iron').value, 251.3,
    "UT's figure is handed over as published, not repaired")
  assert.match(cronometerEntry(BAD_IRON, 1, { allowSuspect: true }), /Iron: 251\.3mg/)
})


// --- The log stepper -------------------------------------------------------
//
// The stepper replaced x0.5 / x1.5 / x2 multipliers of the recommendation. These tests pin
// the two properties that made the swap worth doing: it moves in UT's own portion unit, and
// it is not bound by what the recommender is willing to advise.

test('stepServings moves in halves of a serving', () => {
  assert.equal(LOG_STEP, 0.5)
  assert.equal(stepServings(2, 1), 2.5)
  assert.equal(stepServings(2, -1), 1.5)
  assert.equal(stepServings(1, 1), 1.5)
})

test('stepServings snaps an off-step value before moving', () => {
  // A count pick arrives as a whole number, a rescaled entry can be anything. Stepping off
  // an unsnapped value would carry the offset through every later nudge.
  assert.equal(stepServings(1.3, 1), 2)
  assert.equal(stepServings(1.3, -1), 1)
  assert.equal(stepServings(0.9, -1), 0.5)
})

test('stepServings clamps to a servable floor and a stuck-thumb ceiling', () => {
  assert.equal(stepServings(MIN_LOG_SERVINGS, -1), MIN_LOG_SERVINGS)
  assert.equal(stepServings(MAX_LOG_SERVINGS, 1), MAX_LOG_SERVINGS)
  assert.equal(stepServings(0, -1), MIN_LOG_SERVINGS)
  assert.equal(stepServings(NaN, 1), 1)
})

test('stepServings is not bound by what the recommender will advise', () => {
  // MAX_SERVINGS caps advice at 2 for count and 3 for weight, and roundServings refuses a
  // half piece. Neither constrains the log: a fourth helping and half a burger are both
  // things that happen, and refusing to record them hides the error rather than removing it.
  assert.equal(stepServings(3, 1), 3.5)
  assert.equal(stepServings(1, -1), 0.5)
  assert.equal(describeServing(0.5, { raw: '1 each', qty: 1, unit: 'each', unitClass: 'count' }), '0.5 pieces')
})

test('a stepped weight portion still refuses to invent grams', () => {
  // The gram figure is derived from the oz weight UT published, scaled. A volume portion has
  // no weight to scale, so stepping it must not produce one.
  const weight = { raw: '4 oz', qty: 4, unit: 'oz', unitClass: 'weight', grams: 113 }
  assert.equal(describeServing(stepServings(1, 1), weight), '1.5 servings · 6 oz (~170 g)')

  const ladle = { raw: '4 ozL', qty: 4, unit: 'ozL', unitClass: 'volume' }
  const stepped = describeServing(stepServings(1, 1), ladle)
  assert.equal(stepped, '1.5 ladles (4 ozL each)')
  assert.ok(!/\bg\b/.test(stepped), 'a ladle count must never carry a gram figure')
})


// --- Halls that do not serve three meals ------------------------------------
//
// The old fallback was a hardcoded ['Breakfast','Lunch','Dinner'], written when J2 was the
// only hall. JCL Dining serves lunch and dinner, so it offered a breakfast that does not
// exist and told shareForMeal two more meals were coming.

const jcl = {
  num: '12(a)',
  name: 'JCL Dining',
  days: [
    { date: '2026-08-24', meals: [{ meal: 'Lunch', stations: [] }, { meal: 'Dinner', stations: [] }] },
    { date: '2026-08-25', meals: [{ meal: 'Lunch', stations: [] }, { meal: 'Dinner', stations: [] }] },
  ],
}

test('a hall serving lunch and dinner is never given a breakfast', () => {
  assert.deepEqual(mealNamesFor(jcl, '2026-08-24'), ['Lunch', 'Dinner'])
  // The day before it opens: the repertoire, not an invented three.
  assert.deepEqual(mealNamesFor(jcl, '2026-08-23'), ['Lunch', 'Dinner'])
})

test('a hall with nothing scraped serves nothing we know of', () => {
  // An empty list is the honest answer. Inventing meals here is what caused the bug.
  assert.deepEqual(mealNamesFor({ num: '12(a)', days: [] }, '2026-08-23'), [])
  assert.deepEqual(mealNamesFor(undefined, '2026-08-23'), [])
})

test('the repertoire keeps the order the hall publishes in', () => {
  const hall = {
    days: [
      { date: '2026-08-24', meals: [{ meal: 'Lunch' }, { meal: 'Dinner' }] },
      { date: '2026-08-25', meals: [{ meal: 'Breakfast' }, { meal: 'Lunch' }] },
    ],
  }
  assert.deepEqual(mealNamesFor(hall, '2026-08-26'), ['Lunch', 'Dinner', 'Breakfast'])
})

test('meals left is counted against what the hall actually serves', () => {
  // Lunch at JCL leaves two meals, not three. With the old fallback this returned 3 and
  // shareForMeal sized the plate at a third of the day.
  assert.equal(mealsLeft(['Lunch', 'Dinner'], 'Lunch'), 2)
  assert.equal(mealsLeft(['Lunch', 'Dinner'], 'Dinner'), 1)
  assert.equal(mealsLeft(['Breakfast', 'Lunch', 'Dinner'], 'Lunch'), 2)
})

test('an unknown meal spends the whole remainder rather than a fraction of it', () => {
  assert.equal(mealsLeft(['Lunch', 'Dinner'], 'Breakfast'), 1)
  assert.equal(mealsLeft([], 'Lunch'), 1)
})

test('the plate a JCL lunch is sized against is half the day, not a third', () => {
  const need = { kcal: 1800, protein_g: 120 }
  const jclLunch = shareForMeal(need, mealsLeft(['Lunch', 'Dinner'], 'Lunch'))
  assert.equal(jclLunch.kcal, 900)
  const wouldHaveBeen = shareForMeal(need, 3)
  assert.equal(wouldHaveBeen.kcal, 600)
})


// --- Restrictions: icons first, allergen text as the net under them ---------
//
// Re-verified against real Kins and JCL rows on 2026-08-23, which is when the icons turned
// out not to be sufficient on their own. See ALLERGEN_TEXT for the sweep.

const dish = (o) => ({ itemId: '1*1', name: 'X', icons: [], allergens: [], nutrients: nut({}), portion: { raw: '1 each', qty: 1, unit: 'each', unitClass: 'count' }, ...o })

test('an icon still excludes, as it always did', () => {
  assert.equal(isExcluded(dish({ icons: ['Beef'] }), { restrictions: ['Beef'] }), 'restriction')
  assert.equal(isExcluded(dish({ icons: ['Vegan'] }), { restrictions: ['Beef'] }), null)
})

test('a dish with no icons at all is caught by its allergen text', () => {
  // Chopped Brisket, 010013*4, J2 dinner: icons [], allergens ['Beef']. Before this it was
  // recommendable to someone who restricts beef.
  const brisket = dish({ name: 'Chopped Brisket', icons: [], allergens: ['Beef'] })
  assert.equal(isExcluded(brisket, { restrictions: ['Beef'] }), 'restriction')

  // Asado de Puerco, 081329*4, Kins lunch: leaked past both of Aadi's restrictions.
  const asado = dish({ name: 'Asado de Puerco', icons: [], allergens: ['Soybeans', 'Pork', 'Beef'] })
  assert.equal(isExcluded(asado, { restrictions: ['Beef', 'Pork'] }), 'restriction')
  assert.equal(isExcluded(asado, { restrictions: ['Pork'] }), 'restriction')
})

test('the text is translated, not matched literally', () => {
  // The icon says Soy, the label says Soybeans. A literal comparison would catch neither
  // this nor Tree Nuts nor Crustacean Shellfish.
  assert.equal(isExcluded(dish({ allergens: ['Soybeans'] }), { restrictions: ['Soy'] }), 'restriction')
  assert.equal(isExcluded(dish({ allergens: ['Tree Nuts'] }), { restrictions: ['TreeNuts'] }), 'restriction')
  assert.equal(isExcluded(dish({ allergens: ['Crustacean Shellfish'] }), { restrictions: ['Shellfish'] }), 'restriction')
})

test('Vegan and Halal stay icon-only, because the text never carries them', () => {
  // 699 dishes carry one of these icons and not one names it in the text. Inventing a text
  // term for them would match nothing and imply a fallback that does not exist.
  assert.equal(ALLERGEN_TEXT.Vegan, undefined)
  assert.equal(ALLERGEN_TEXT.Halal, undefined)
  assert.equal(ALLERGEN_TEXT.Veggie, undefined)
  assert.equal(isExcluded(dish({ icons: ['Vegan'] }), { restrictions: ['Vegan'] }), 'restriction')
  assert.equal(isExcluded(dish({ allergens: ['Vegan'] }), { restrictions: ['Vegan'] }), null)
})

test('every allergen term UT publishes is one the map knows', () => {
  // The loud failure this repo wants: the day UT adds a term — Mustard, say — it lands here
  // rather than silently failing to exclude anything. Read from the committed menu.json,
  // which is real scraped data rather than a fixture of it.
  const menu = JSON.parse(readFileSync(
    fileURLToPath(new URL('../data/menu.json', import.meta.url)), 'utf8'))
  const known = new Set(Object.values(ALLERGEN_TEXT))
  const unknown = new Set()
  for (const item of Object.values(menu.items)) {
    for (const a of item.allergens ?? []) if (!known.has(a)) unknown.add(a)
  }
  assert.deepEqual([...unknown], [], 'unmapped allergen wording in menu.json')
})


// --- The compare view: three halls, one need vector -------------------------
//
// The question walking out of Jester is "J2 or Kins or JCL". The hall tabs answer it only by
// making you tap through them, and the thing that must not happen is a hall quietly missing
// from the answer — JCL at breakfast is the case that gets this wrong.

const stationOf = (...ids) => [{ name: 'Line', itemIds: ids }]

const COMPARE_MENU = {
  items: {
    'g*1': GRILLED,
    'f*1': FRIED,
    'b*1': BEEF,
    'bn*1': BEANS,
  },
  halls: [
    {
      num: '12',
      name: 'J2 Dining',
      days: [{
        date: '2026-08-23',
        meals: [
          { meal: 'Breakfast', stations: stationOf('f*1') },
          { meal: 'Lunch', stations: stationOf('g*1', 'f*1', 'bn*1') },
          { meal: 'Dinner', stations: stationOf('g*1') },
        ],
      }],
    },
    {
      num: '03',
      name: 'Kins Dining',
      days: [{
        date: '2026-08-23',
        meals: [
          { meal: 'Breakfast', stations: stationOf('g*1') },
          { meal: 'Lunch', stations: stationOf('f*1') },
        ],
      }],
    },
    {
      // Lunch and dinner only, and shut today: both silences at once.
      num: '12(a)',
      name: 'JCL Dining',
      days: [{
        date: '2026-08-24',
        meals: [
          { meal: 'Lunch', stations: stationOf('g*1') },
          { meal: 'Dinner', stations: stationOf('g*1') },
        ],
      }],
    },
  ],
}

const compareOn = (date, mealName) => compareHalls(COMPARE_MENU, {
  date,
  mealName,
  need: needVector(TARGETS, {}),
  profile: PROFILE,
})

test('compare: every hall gets a slot, in menu order', () => {
  const halls = compareOn('2026-08-23', 'Lunch')
  assert.deepEqual(halls.map((h) => h.name), ['J2 Dining', 'Kins Dining', 'JCL Dining'])
})

test('compare: an open hall returns a real plate with a reason', () => {
  const [j2] = compareOn('2026-08-23', 'Lunch')
  assert.equal(j2.kind, 'open')
  assert.equal(j2.picks[0].itemId, 'g*1')
  assert.ok(j2.picks[0].why.length > 0, 'a pick with no reason cannot be judged')
  assert.ok(j2.delivers.kcal > 0)
})

test('compare: the plate total is every pick, not just the one shown', () => {
  const [j2] = compareOn('2026-08-23', 'Lunch')
  const summed = j2.picks.reduce((a, p) => a + p.delivers.kcal, 0)
  assert.equal(j2.delivers.kcal, summed)
  assert.ok(j2.picks.length > 1, 'this menu should produce more than one pick')
})

test('compare: a hall that never serves the meal says so, and is not dropped', () => {
  // JCL at breakfast, on a day it is open, so "shut today" cannot be the answer. Silently
  // omitting it turns "does not serve breakfast" into "does not exist", and an empty box
  // says neither.
  const jcl = compareOn('2026-08-24', 'Breakfast').find((h) => h.num === '12(a)')
  assert.equal(jcl.kind, 'notserved')
  assert.deepEqual(jcl.picks, [])
  assert.equal(jcl.text, 'JCL Dining does not serve breakfast. It serves lunch and dinner.')
})

test('compare: a hall shut today says that instead, and still names its repertoire', () => {
  const jcl = compareOn('2026-08-23', 'Lunch').find((h) => h.num === '12(a)')
  assert.equal(jcl.kind, 'closed')
  assert.deepEqual(jcl.picks, [])
  assert.equal(
    jcl.text,
    'JCL Dining publishes no menu for today. It serves lunch and dinner on the days it is open.',
  )
})

test('compare: a meal missing from today but in the repertoire is its own silence', () => {
  const kins = compareOn('2026-08-23', 'Dinner').find((h) => h.num === '03')
  // Kins serves dinner nowhere in this window, so it is 'notserved'; J2 is the control.
  assert.equal(kins.kind, 'notserved')

  const hall = {
    name: 'Kins Dining',
    days: [
      { date: '2026-08-23', meals: [{ meal: 'Lunch', stations: [] }] },
      { date: '2026-08-24', meals: [{ meal: 'Dinner', stations: [] }] },
    ],
  }
  const availability = hallAvailability(hall, '2026-08-23', 'Dinner')
  assert.equal(availability.kind, 'notoday')
  assert.equal(availability.text, 'No dinner menu for today at Kins Dining.')
})

test('compare: a hall with nothing scraped is not described as shut', () => {
  const availability = hallAvailability({ name: 'Whitis', days: [] }, '2026-08-23', 'Lunch')
  assert.equal(availability.kind, 'unlisted')
  assert.equal(availability.text, 'No menu published for Whitis at the moment.')
})

test('compare: a hall whose whole line is filtered out says so rather than showing nothing', () => {
  const beefOnly = {
    items: { 'b*1': BEEF },
    halls: [{
      name: 'Kins Dining',
      num: '03',
      days: [{ date: '2026-08-23', meals: [{ meal: 'Lunch', stations: stationOf('b*1') }] }],
    }],
  }
  const [kins] = compareHalls(beefOnly, {
    date: '2026-08-23', mealName: 'Lunch', need: needVector(TARGETS, {}), profile: PROFILE,
  })
  assert.equal(kins.kind, 'nofit')
  assert.deepEqual(kins.picks, [])
  assert.equal(kins.text, "Nothing on Kins Dining's lunch line fits what you have left.")
})

test('compare: restrictions and ratings apply at every hall alike', () => {
  // Items are keyed by RecNumAndPort, so the same recipe is the same dish everywhere and a
  // restriction cannot hold at one hall and leak at another.
  const halls = compareOn('2026-08-23', 'Lunch')
  for (const hall of halls) {
    assert.ok(hall.picks.every((p) => p.itemId !== 'b*1'), `beef reached ${hall.name}`)
  }
})

test('compare: the same need vector reaches every hall', () => {
  // Two halls serving the identical dish must advise the identical portion. A per-hall
  // divisor would mean three plates measured against three budgets, which is not a
  // comparison.
  const menu = {
    items: { 'g*1': GRILLED },
    halls: ['A', 'B'].map((name) => ({
      num: name,
      name,
      days: [{ date: '2026-08-23', meals: [{ meal: 'Lunch', stations: stationOf('g*1') }] }],
    })),
  }
  const [a, b] = compareHalls(menu, {
    date: '2026-08-23', mealName: 'Lunch', need: needVector(TARGETS, {}), profile: PROFILE,
  })
  assert.equal(a.picks[0].servings, b.picks[0].servings)
  assert.equal(a.picks[0].display, b.picks[0].display)
})

test('compare: the portion string is the one describeServing produced, never a rewrite', () => {
  const [j2] = compareOn('2026-08-23', 'Lunch')
  const pick = j2.picks[0]
  assert.equal(pick.display, describeServing(pick.servings, GRILLED.portion))
})

test('compare: an empty menu answers with no halls rather than throwing', () => {
  assert.deepEqual(compareHalls({ halls: [] }, { date: '2026-08-23', mealName: 'Lunch' }), [])
  assert.deepEqual(compareHalls(undefined, { date: '2026-08-23', mealName: 'Lunch' }), [])
})

test('itemsForMeal stamps the station and skips ids the menu has no item for', () => {
  const menu = {
    items: { 'g*1': GRILLED },
    halls: [],
  }
  const hall = {
    days: [{ date: '2026-08-23', meals: [{ meal: 'Lunch', stations: [{ name: 'Grill', itemIds: ['g*1', 'gone*1'] }] }] }],
  }
  const items = itemsForMeal(menu, hall, '2026-08-23', 'Lunch')
  assert.equal(items.length, 1)
  assert.equal(items[0].station, 'Grill')
  assert.deepEqual(itemsForMeal(menu, hall, '2026-08-23', 'Breakfast'), [])
})

test('plateDelivers keeps an unpublished nutrient absent rather than totalling it as zero', () => {
  const picks = [
    { delivers: { kcal: 100, protein_g: 10 } },
    { delivers: { kcal: 50 } }, // UT published no protein for this one
  ]
  const total = plateDelivers(picks)
  assert.equal(total.kcal, 150)
  assert.equal(total.protein_g, 10)
  assert.ok(!('sodium_mg' in total), 'a nutrient nobody published must not appear as 0')
})


// --- Per-hall nutrition coverage --------------------------------------------
//
// The fields are OPTIONAL. Every menu.json committed before 2026-08-23 has none of them, so
// the app must disclose nothing at all rather than reporting a hall as 0% covered.

test('coverage: absent fields disclose nothing at all', () => {
  assert.equal(coverageOf({ num: '12', name: 'J2 Dining', days: [] }), null)
  assert.equal(coverageOf(undefined), null)
})

test('coverage: a partial set of fields is still nothing, not a guess', () => {
  assert.equal(coverageOf({ dishes: 94, dishesWithNutrition: 94 }), null)
  assert.equal(coverageOf({ dishes: 94, dishesWithoutNutrition: 0 }), null)
})

test('coverage: zero dishes is never reported as "0 of 0"', () => {
  assert.equal(coverageOf({ dishes: 0, dishesWithNutrition: 0, dishesWithoutNutrition: 0 }), null)
})

test('coverage: a fully published hall reads as good news, with no caveat clause', () => {
  const c = coverageOf({ dishes: 94, dishesWithNutrition: 94, dishesWithoutNutrition: 0 })
  assert.equal(c.text, '94 of 94 dishes this week have published nutrition.')
  assert.equal(c.unreadable, 0)
})

test('coverage: a thin hall names how many UT published no label for', () => {
  const c = coverageOf({ dishes: 100, dishesWithNutrition: 60, dishesWithoutNutrition: 40 })
  assert.equal(c.text, '60 of 100 dishes this week have published nutrition; UT publishes no label for 40.')
})

test('coverage: an unreadable label is our failure, counted apart from UT publishing nothing', () => {
  const c = coverageOf({ dishes: 100, dishesWithNutrition: 60, dishesWithoutNutrition: 38 })
  assert.equal(c.unreadable, 2)
  assert.equal(
    c.text,
    '60 of 100 dishes this week have published nutrition; UT publishes no label for 38; 2 could not be read.',
  )
})

test('coverage: no percentage is ever derived, so no figure can be invented', () => {
  const c = coverageOf({ dishes: 94, dishesWithNutrition: 94, dishesWithoutNutrition: 0 })
  assert.ok(!/%/.test(c.text), 'a percentage of a count this small overstates its precision')
})

test('coverage: a compared hall carries its own coverage, or null', () => {
  const withFields = structuredClone(COMPARE_MENU)
  Object.assign(withFields.halls[0], {
    dishes: 2, dishesWithNutrition: 2, dishesWithoutNutrition: 0,
  })
  const halls = compareHalls(withFields, {
    date: '2026-08-23', mealName: 'Lunch', need: needVector(TARGETS, {}), profile: PROFILE,
  })
  assert.equal(halls[0].coverage.text, '2 of 2 dishes this week have published nutrition.')
  assert.equal(halls[1].coverage, null)
})


// --- The form-helper payload (roadmap B1) -----------------------------------
//
// Same fields, same source, as JSON. The point of these tests is that the faster route into
// Cronometer cannot be a laxer one.

const LADLE = item('l*1', 'Chicken Noodle Soup', { kcal: 120, protein_g: 8 }, {
  portion: { raw: '1 ozL', qty: 1, unit: 'ozL', unitClass: 'volume', grams: null },
})

test('payload: carries a version and the fields in Cronometer form order', () => {
  const parsed = JSON.parse(cronometerPayload(GRILLED, 1))
  assert.equal(parsed.utdining, PAYLOAD_VERSION)
  assert.deepEqual(
    parsed.fields.map((f) => f.label),
    cronometerFields(GRILLED, 1).map((f) => f.label),
    'the helper fills in form order, and it must be the same order the sheet lists',
  )
})

test('payload: an unpublished nutrient survives as null, never 0 and never ""', () => {
  const blank = item('n*1', 'Pancake Syrup', {}, {
    nutrients: { kcal: 210, protein_g: 0, potassium_mg: null, addedsugar_g: null },
  })
  const byLabel = Object.fromEntries(
    JSON.parse(cronometerPayload(blank, 1)).fields.map((f) => [f.label, f.value]),
  )
  assert.equal(byLabel.Potassium, null)
  assert.equal(byLabel['Added Sugars'], null)
  // The distinction the whole project turns on: a blank is not a zero.
  assert.notEqual(byLabel.Potassium, 0)
  assert.notEqual(byLabel.Potassium, '')
})

test('payload: a quarantined dish is refused, exactly as the copy buttons refuse it', () => {
  const bad = item('s*1', 'Crispy Chopped Bacon', {}, {
    nutrients: nut({ kcal: 100, fat_g: 112, carb_g: 112, protein_g: 112 }),
    portion: { raw: '3 oz', qty: 3, unit: 'oz', unitClass: 'weight', grams: 85 },
  })
  assert.throws(() => cronometerPayload(bad, 1), SuspectItemError)
  // And the override lets it through here on the same terms as everywhere else.
  assert.ok(JSON.parse(cronometerPayload(bad, 1, { allowSuspect: true })).fields.length > 0)
})

test('payload: a ladle carries no Serving Weight, because there are no grams to give', () => {
  const labels = JSON.parse(cronometerPayload(LADLE, 1)).fields.map((f) => f.label)
  assert.ok(!labels.includes('Serving Weight'), 'a volume scoop must not produce a gram figure')
  const weighed = JSON.parse(cronometerPayload(GRILLED, 1)).fields.map((f) => f.label)
  assert.ok(weighed.includes('Serving Weight'))
})

test('payload: values are per serving, matching the printed list exactly', () => {
  // The custom food is created once and the quantity changes after, so the payload must not
  // be scaled by servings even when the pick advises three of them.
  const one = JSON.parse(cronometerPayload(GRILLED, 1))
  const three = JSON.parse(cronometerPayload(GRILLED, 3))
  assert.deepEqual(one.fields, three.fields)
})
