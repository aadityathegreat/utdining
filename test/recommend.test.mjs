import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  recommend, scoreItem, needVector, isExcluded, describeServing, roundServings,
  cronometerEntry, cronometerFields, deliversFor, mergeConsumed, MODES, profileForMode,
  shareForKcal, nutrientsOf, SuspectItemError,
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
