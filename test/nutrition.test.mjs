// The derivations and the source-data quarantine. The two outlier cases below were verified
// against UT's live FoodPro pages on 2026-08-13 and are the reason this module exists.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { netCarbs, withDerived, suspectReasons, suspectOf } from '../nutrition.mjs'

const WEIGHT = { raw: '4 oz', qty: 4, unit: 'oz', unitClass: 'weight', grams: 113.4 }
const LADLE = { raw: '1 ozL', qty: 1, unit: 'ozl', unitClass: 'volume', grams: null }
const COUNT = { raw: '1 each', qty: 1, unit: 'each', unitClass: 'count', grams: null }

const ok = (o = {}) => ({
  kcal: 200, fat_g: 8, satfat_g: 2, transfat_g: 0, chol_mg: 40, sodium_mg: 300,
  carb_g: 10, fiber_g: 2, sugar_g: 3, addedsugar_g: 0, protein_g: 22,
  vitd_mcg: 1, calcium_mg: 40, iron_mg: 1.5, potassium_mg: 300, ...o,
})

// ---------------------------------------------------------------------------
// Net carbs
// ---------------------------------------------------------------------------

test('net carbs are total carbohydrate less fibre', () => {
  assert.equal(netCarbs({ carb_g: 30, fiber_g: 7 }), 23)
})

test('net carbs stay unknown when either half is unpublished', () => {
  assert.equal(netCarbs({ carb_g: 30, fiber_g: null }), null)
  assert.equal(netCarbs({ carb_g: null, fiber_g: 7 }), null)
  // Blank must never become zero: a dish with no published fibre is not a dish with none.
  assert.equal(netCarbs({}), null)
})

test('net carbs never go below zero', () => {
  // UT rounds each figure separately, so fibre can just exceed carbohydrate.
  assert.equal(netCarbs({ carb_g: 4, fiber_g: 4.4 }), 0)
})

test('withDerived leaves the published figures untouched', () => {
  const n = withDerived(ok({ carb_g: 40, fiber_g: 5 }))
  assert.equal(n.netcarb_g, 35)
  assert.equal(n.carb_g, 40, 'total carbohydrate must survive derivation')
})

// ---------------------------------------------------------------------------
// Quarantine — the two verified FoodPro outliers
// ---------------------------------------------------------------------------

test('verified outlier: 163.6 g of fat in a 4 oz serving is blocked', () => {
  const reasons = suspectReasons(ok({ kcal: 1475, fat_g: 163.6, protein_g: 3, carb_g: 4 }), WEIGHT)
  assert.ok(reasons.some((r) => r.code === 'mass:fat_g'), 'fat exceeding the serving mass')
  assert.match(reasons.find((r) => r.code === 'mass:fat_g').message, /163\.6 g/,
    "UT's exact figure must survive into the message rather than being repaired")
})

test('verified outlier: 251.3 mg of iron in one serving is blocked', () => {
  const reasons = suspectReasons(ok({ iron_mg: 251.3 }), WEIGHT)
  assert.ok(reasons.some((r) => r.code === 'ceiling:iron_mg'))
})

// ---------------------------------------------------------------------------
// Quarantine — the rules, and what they must not catch
// ---------------------------------------------------------------------------

test('an ordinary dish is not quarantined', () => {
  assert.deepEqual(suspectReasons(ok(), WEIGHT), [])
})

test('pure sugar is not quarantined: rounding is not a bad figure', () => {
  // 1 oz of powdered sugar really is 28.4 g of carbohydrate in a 28.3 g serving. A rule
  // that flags this hides real food, which is the expensive kind of false positive.
  const oz = { raw: '1 oz', qty: 1, unit: 'oz', unitClass: 'weight', grams: 28.3 }
  const sugar = ok({
    kcal: 110, carb_g: 28.4, sugar_g: 28.4, fiber_g: 0,
    fat_g: 0, satfat_g: 0, protein_g: 0,
  })
  assert.deepEqual(suspectReasons(sugar, oz), [])
})

test('a component cannot exceed the whole it belongs to', () => {
  assert.ok(suspectReasons(ok({ fat_g: 4, satfat_g: 9 }), WEIGHT).some((r) => r.code === 'subset:satfat_g'))
  assert.ok(suspectReasons(ok({ carb_g: 3.5, sugar_g: 6 }), WEIGHT).some((r) => r.code === 'subset:sugar_g'))
})

test('published calories that the macros cannot produce are flagged', () => {
  // Chow Mein Noodle: 0 kcal published against macros worth 422.
  const reasons = suspectReasons(ok({ kcal: 0, carb_g: 60, protein_g: 8, fat_g: 20 }), WEIGHT)
  assert.ok(reasons.some((r) => r.code === 'energy'))
})

test('the energy check stays quiet when a macro is unpublished', () => {
  // Otherwise every dish with a blank would look wrong, and a blank is normal here.
  const reasons = suspectReasons(ok({ kcal: 400, fat_g: null }), WEIGHT)
  assert.ok(!reasons.some((r) => r.code === 'energy'))
})

test('a negative figure is never treated as real', () => {
  assert.ok(suspectReasons(ok({ sodium_mg: -50 }), WEIGHT).some((r) => r.code === 'negative:sodium_mg'))
})

test('mass rules do not fire on portions with no weight', () => {
  // A ladle is a volume scoop and a piece is a count. Neither publishes a gram figure, so
  // there is nothing to check a gram figure against — and inventing one is forbidden.
  assert.deepEqual(suspectReasons(ok({ fat_g: 200 }), LADLE).filter((r) => r.code.startsWith('mass:')), [])
  assert.deepEqual(suspectReasons(ok({ fat_g: 200 }), COUNT).filter((r) => r.code.startsWith('mass:')), [])
})

test('suspectOf prefers what the scraper stamped, and derives it otherwise', () => {
  const stamped = { nutrients: ok(), portion: WEIGHT, suspect: [{ code: 'denylist', message: 'checked by hand' }] }
  assert.equal(suspectOf(stamped)[0].code, 'denylist')

  // A menu.json scraped before these checks existed carries no `suspect` key at all. The
  // app must still block the dish rather than trusting the absence.
  const old = { nutrients: ok({ iron_mg: 251.3 }), portion: WEIGHT }
  assert.ok(suspectOf(old).some((r) => r.code === 'ceiling:iron_mg'))
})

// ---------------------------------------------------------------------------
// Against the committed menu, which is real UT data
// ---------------------------------------------------------------------------

test('the quarantine stays a rare event on real UT data', () => {
  const menu = JSON.parse(readFileSync(
    fileURLToPath(new URL('../data/menu.json', import.meta.url)), 'utf8'))

  const items = Object.entries(menu.items)
  const flagged = items.filter(([id, it]) => suspectReasons(it.nutrients, it.portion, id).length > 0)

  assert.ok(items.length > 100, 'the committed menu should have real breadth')
  // A rule set that blocks a tenth of the servery is broken, whatever it is catching.
  assert.ok(flagged.length / items.length < 0.05,
    `${flagged.length} of ${items.length} dishes quarantined — the rules are too tight`)
  assert.ok(flagged.length > 0, 'UT really does publish bad figures; catching none means the wiring broke')
})
