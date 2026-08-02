// The fixture carries the real 63 column names from a genuine Cronometer export, with
// synthetic values. No real intake data is committed to this repo.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseCronometerCsv, datesInCsv, CronometerParseError } from '../cronometer.mjs'
import { NUTRIENT_KEYS } from '../scraper/parse.mjs'

const csv = readFileSync(
  fileURLToPath(new URL('../scraper/fixtures/cronometer-daily.csv', import.meta.url)), 'utf8')

test('reads the requested day', () => {
  const r = parseCronometerCsv(csv, '2026-08-02')
  assert.equal(r.date, '2026-08-02')
  assert.equal(r.nutrients.kcal, 1250)
  assert.equal(r.nutrients.protein_g, 62)
  assert.equal(r.nutrients.sodium_mg, 1800)
})

test('vitamin D converts from IU to mcg', () => {
  // Cronometer reports IU, UT reports mcg. 240 IU = 6 mcg. Unconverted this is 40x wrong.
  assert.equal(parseCronometerCsv(csv, '2026-08-02').nutrients.vitd_mcg, 6)
})

test('output keys line up with the menu nutrient vocabulary', () => {
  const n = parseCronometerCsv(csv, '2026-08-02').nutrients
  assert.deepEqual(Object.keys(n).sort(), [...NUTRIENT_KEYS].sort())
})

test('nutrients UT does not publish are kept separately', () => {
  const r = parseCronometerCsv(csv, '2026-08-02')
  assert.equal(r.extras.zinc_mg, 3)
  assert.ok(!('zinc_mg' in r.nutrients), 'zinc must not leak into the menu-comparable set')
})

test('a missing day is an error, not the nearest row', () => {
  assert.throws(
    () => parseCronometerCsv(csv, '2026-01-01'),
    (e) => e instanceof CronometerParseError && /No row for 2026-01-01/.test(e.message),
  )
})

test('the wrong export type is rejected outright', () => {
  const servings = 'Day,Time,Group,Food Name,Amount\n2026-08-02,08:00,Breakfast,Egg,2 each'
  assert.throws(() => parseCronometerCsv(servings, '2026-08-02'), CronometerParseError)
})

test('quoted fields containing commas survive', () => {
  const text = 'Date,Energy (kcal),Protein (g),Note\n2026-08-02,100,10,"a, b"'
  assert.equal(parseCronometerCsv(text, '2026-08-02').nutrients.kcal, 100)
})

test('lists the days a file covers', () => {
  assert.deepEqual(datesInCsv(csv), ['2026-07-31', '2026-08-01', '2026-08-02'])
})
