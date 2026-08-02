// Golden tests against real FoodPro pages committed under scraper/fixtures/.
// These exist to fail loudly the day UT changes its HTML — the most likely way this
// app dies quietly.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  parseLabel, parseLongMenu, parsePortion, parseLocations, NUTRIENT_KEYS,
} from '../scraper/parse.mjs'

const fixture = (n) =>
  readFileSync(fileURLToPath(new URL(`../scraper/fixtures/${n}`, import.meta.url)), 'utf8')

test('label: fully populated item', () => {
  const r = parseLabel(fixture('label-full.html'))
  assert.equal(r.name, 'Salisbury Steak w/ Mushroom Gravy')
  assert.deepEqual(r.portion, {
    raw: '1 each', qty: 1, unit: 'each', unitClass: 'count', grams: null,
  })
  assert.equal(r.nutrients.kcal, 321.8)
  assert.equal(r.nutrients.protein_g, 18)
  assert.equal(r.nutrients.sodium_mg, 1383.6)
  assert.equal(r.nutrients.potassium_mg, 400.9)
  assert.ok(r.icons.includes('Beef'), 'beef icon must be detected')
  assert.ok(r.ingredients.length > 50)
})

test('label: every nutrient key is always present', () => {
  for (const f of ['label-full.html', 'label-missing.html', 'label-pizza.html', 'label-vegan.html']) {
    const n = parseLabel(fixture(f)).nutrients
    assert.deepEqual(Object.keys(n).sort(), [...NUTRIENT_KEYS].sort(), f)
  }
})

test('label: unpublished nutrients are null, never zero', () => {
  // Pancake Syrup: UT leaves several rows blank. Reading those as 0 would make the
  // item look artificially clean to the recommender.
  const n = parseLabel(fixture('label-missing.html')).nutrients
  assert.equal(n.satfat_g, null)
  assert.equal(n.transfat_g, null)
  assert.equal(n.chol_mg, null)
  assert.equal(typeof n.kcal, 'number', 'calories are always published')
})

test('label: genuine zeros stay zero', () => {
  const n = parseLabel(fixture('label-vegan.html')).nutrients
  assert.equal(n.chol_mg, 0)
  assert.notEqual(n.chol_mg, null)
})

test('label: vegan icon detected, allergen text may be empty', () => {
  const r = parseLabel(fixture('label-vegan.html'))
  assert.ok(r.icons.includes('Vegan'))
  assert.deepEqual(r.allergens, [])
})

test('portion: ladles are volume, never converted to grams', () => {
  for (const raw of ['1 ozL', '1 ozl', '4 ozL']) {
    const p = parsePortion(raw)
    assert.equal(p.unitClass, 'volume', raw)
    assert.equal(p.grams, null, `${raw} must not produce a gram figure`)
  }
})

test('portion: weight units convert, count units do not', () => {
  assert.equal(parsePortion('4 oz').grams, 113.4)
  assert.equal(parsePortion('1/2 oz').grams, 14.2)
  assert.equal(parsePortion('1 each').grams, null)
  assert.equal(parsePortion('1 serving').grams, null)
  assert.equal(parsePortion('1 slice').grams, null)
})

test('portion: fractional pizza slice', () => {
  const p = parsePortion('1/12 pizza')
  assert.equal(p.qty, 1 / 12)
  assert.equal(p.unitClass, 'count')
  assert.equal(p.grams, null)
})

test('longmenu: items carry station, id, portion', () => {
  const items = parseLongMenu(fixture('longmenu.html'))
  assert.ok(items.length > 50, `expected a full menu, got ${items.length}`)

  for (const it of items) {
    assert.ok(it.itemId.includes('*'), `bad id: ${it.itemId}`)
    assert.ok(it.name.length > 0)
    assert.ok(it.station.length > 0)
    assert.ok(it.portionRaw, `missing portion for ${it.name}`)
    assert.ok(!/^-|-$/.test(it.station), `station dashes not stripped: ${it.station}`)
  }

  const ids = items.map((i) => i.itemId)
  assert.equal(new Set(ids).size > 40, true)
})

test('longmenu: stations are real names', () => {
  const stations = new Set(parseLongMenu(fixture('longmenu.html')).map((i) => i.station))
  assert.ok(stations.has('The Texas Grill'), [...stations].join(' | '))
  assert.ok(stations.has('Pizza Station'))
})

test('locations: parsed from the page, not hardcoded', () => {
  const html = `<a href="shortmenu.aspx?sName=x&locationNum=12&locationName=J2+Dining&naFlag=1">J2</a>`
  assert.deepEqual(parseLocations(html), [{ num: '12', name: 'J2 Dining' }])
})

test('label: "nutrition not available" is a distinct, expected outcome', async () => {
  const { NoNutritionData, parseLabel: pl } = await import('../scraper/parse.mjs')
  const html = '<div class="labelrecipe">Halal Chicken Sausage</div>' +
    '<div>Nutritional Information is not available for this recipe.</div>'
  assert.throws(() => pl(html), NoNutritionData)
})
