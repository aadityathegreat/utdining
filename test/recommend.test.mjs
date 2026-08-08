import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  recommend, scoreItem, needVector, isExcluded, describeServing, roundServings,
  cronometerEntry, deliversFor, mergeConsumed,
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
  const known = item('k*1', 'Known', { kcal: 200, protein_g: 20, sodium_mg: 400 })
  const unknown = item('u*1', 'Unknown sodium', { kcal: 200, protein_g: 20, sodium_mg: null })
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
  const salsa = item('r*1', 'Chips & Salsa', { kcal: 200 }, { ingredients: 'Tomato, Onion, Lime' })
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
  const dish = item('x*1', 'Mystery Gravy', { kcal: 90, protein_g: 2, satfat_g: null })
  const text = cronometerEntry(dish, 1.5)
  assert.match(text, /Serving size: 4 oz/)
  assert.match(text, /Energy: 90kcal/)
  assert.match(text, /Saturated: \(not published — leave blank\)/)
  assert.doesNotMatch(text, /Saturated: 0g/)
  assert.match(text, /Log 1\.5 × this serving\./)
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
