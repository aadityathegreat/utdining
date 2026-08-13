// The Nutrition Facts panel's contents. Only the pure model is tested — drawing needs a
// canvas, and what could actually be wrong here is which rows appear and what they say.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { labelModel } from '../label.mjs'
import { SuspectItemError } from '../recommend.mjs'

const nut = (o) => ({
  kcal: 249.5, fat_g: 4.6, satfat_g: 0.7, transfat_g: 0, chol_mg: 0, sodium_mg: 22.8,
  carb_g: 48, fiber_g: 5, sugar_g: 2.7, addedsugar_g: 0, protein_g: 5.7,
  vitd_mcg: 0, calcium_mg: 34.1, iron_mg: 2.5, potassium_mg: 1213.4, ...o,
})

const item = (nutrients = {}, portion) => ({
  itemId: 'p*1',
  name: 'Baked Potato',
  station: 'Baked Potato Bar',
  portion: portion ?? { raw: '4 oz', qty: 4, unit: 'oz', unitClass: 'weight', grams: 113.4 },
  nutrients: nut(nutrients),
})

const rowFor = (model, key) =>
  [...model.rows, ...model.micros].find((r) => r.key === key)

test('the panel prints every published nutrient in label order', () => {
  const m = labelModel(item())
  assert.deepEqual(m.rows.map((r) => r.key), [
    'fat_g', 'satfat_g', 'transfat_g', 'chol_mg', 'sodium_mg',
    'carb_g', 'fiber_g', 'sugar_g', 'addedsugar_g', 'protein_g',
  ])
  assert.deepEqual(m.micros.map((r) => r.key),
    ['vitd_mcg', 'calcium_mg', 'iron_mg', 'potassium_mg'])
})

test('values are UT figures exactly, not rounded to FDA label rules', () => {
  // The requirement is that every value match the UT per-serving figure. FDA rounding would
  // print fat below 5 g to the nearest half gram, which would make the label pretty and the
  // number wrong.
  const m = labelModel(item())
  assert.equal(m.calories, '249.5')
  assert.equal(rowFor(m, 'fat_g').text, 'Total Fat 4.6g')
  assert.equal(rowFor(m, 'sodium_mg').text, 'Sodium 22.8mg')
  assert.equal(rowFor(m, 'potassium_mg').text, 'Potassium 1213.4mg')
})

test('an unpublished nutrient is omitted, never printed as zero', () => {
  const m = labelModel(item({ addedsugar_g: null, potassium_mg: null }))
  assert.ok(!rowFor(m, 'addedsugar_g'), 'a blank must not become a printed row')
  assert.ok(!rowFor(m, 'potassium_mg'))
  assert.deepEqual(m.omitted, ['Added Sugars', 'Potassium'])
  // A scanner reading "0g" would assert the food contains none of it.
  assert.ok(!m.rows.some((r) => /Added Sugars 0g/.test(r.text)))
})

test('unpublished calories are reported rather than shown as zero', () => {
  const m = labelModel(item({ kcal: null }))
  assert.equal(m.calories, null)
  assert.ok(m.omitted.includes('Calories'))
})

test('% Daily Value uses the FDA figures, and is absent where there is no DV', () => {
  const m = labelModel(item({ sodium_mg: 230, fiber_g: 2.8 }))
  assert.equal(rowFor(m, 'sodium_mg').dv, '10%') // 230 of 2300
  assert.equal(rowFor(m, 'fiber_g').dv, '10%') // 2.8 of 28
  // Total sugars, trans fat and protein carry no %DV on the Updated American label.
  assert.equal(rowFor(m, 'sugar_g').dv, null)
  assert.equal(rowFor(m, 'transfat_g').dv, null)
  assert.equal(rowFor(m, 'protein_g').dv, null)
})

test('added sugars print in the "Includes" form the Updated label uses', () => {
  // Total sugars has to rise with it: added sugar inside a smaller total is a contradiction,
  // and the quarantine refuses to draw a label for one.
  const sweet = item({ sugar_g: 18, addedsugar_g: 12 })
  assert.equal(rowFor(labelModel(sweet), 'addedsugar_g').text, 'Includes 12g Added Sugars')
})

test('serving size carries grams only for a real weight portion', () => {
  assert.equal(labelModel(item()).servingText, '4 oz (113g)')

  const ladle = { raw: '1 ozL', qty: 1, unit: 'ozl', unitClass: 'volume', grams: null }
  assert.equal(labelModel(item({}, ladle)).servingText, '1 ozL',
    'a ladle is a volume scoop — no gram figure may be invented for it')

  const each = { raw: '1 each', qty: 1, unit: 'each', unitClass: 'count', grams: null }
  assert.equal(labelModel(item({}, each)).servingText, '1 each')
})

test('a quarantined dish gets no label at all', () => {
  // A photo of a wrong number is still a wrong number, and it would be believed harder.
  const bad = item({ iron_mg: 251.3 })
  assert.throws(() => labelModel(bad), SuspectItemError)
  assert.throws(() => labelModel(bad), (e) => /251\.3 mg/.test(e.message))
})

test('the dish name rides along, because Cronometer asks for one', () => {
  assert.equal(labelModel(item()).subtitle, 'Baked Potato')
  assert.equal(labelModel(item()).title, 'Nutrition Facts')
})

test('the override reaches the label too, and prints UT figures unrepaired', () => {
  const bad = item({ iron_mg: 251.3 })
  const m = labelModel(bad, { allowSuspect: true })
  assert.equal(rowFor(m, 'iron_mg').text, 'Iron 251.3mg')
})
