// The fixture carries the real 63 column names from a genuine Cronometer export, with
// synthetic values. No real intake data is committed to this repo.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  parseCronometerCsv, datesInCsv, parseHealthPayload, CronometerParseError, weekLogPayload,
} from '../cronometer.mjs'
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

// --- Apple Health handoff ---------------------------------------------------

const health = (over = {}) => JSON.stringify({
  schema: 1,
  date: '2026-08-02',
  generatedAt: '2026-08-02T12:34:56-05:00',
  nutrients: { kcal: 842.3, protein_g: 51.2, carb_g: 96.4, fat_g: 29.1 },
  missing: [],
  ...over,
})

test('health payload: reads today', () => {
  const r = parseHealthPayload(health(), '2026-08-02')
  assert.equal(r.nutrients.kcal, 842.3)
  assert.deepEqual(r.missing, [])
})

test('health payload: missing nutrients become null, never zero', () => {
  // Apple Health defines no added-sugars type at all. Zero here would hand the
  // recommender a full untouched daily budget it has no evidence for.
  const r = parseHealthPayload(health({ missing: ['addedsugar_g', 'potassium_mg'] }), '2026-08-02')
  assert.equal(r.nutrients.addedsugar_g, null)
  assert.equal(r.nutrients.potassium_mg, null)
  assert.notEqual(r.nutrients.addedsugar_g, 0)
})

test('health payload: a missing nutrient wins over any value sent alongside it', () => {
  const r = parseHealthPayload(
    health({ nutrients: { kcal: 100, addedsugar_g: 0 }, missing: ['addedsugar_g'] }), '2026-08-02')
  assert.equal(r.nutrients.addedsugar_g, null)
})

test('health payload: yesterday is rejected', () => {
  assert.throws(() => parseHealthPayload(health(), '2026-08-03'), CronometerParseError)
})

test('health payload: unknown schema and junk are rejected', () => {
  assert.throws(() => parseHealthPayload(health({ schema: 2 }), '2026-08-02'), CronometerParseError)
  assert.throws(() => parseHealthPayload('not json', '2026-08-02'), CronometerParseError)
  assert.throws(() => parseHealthPayload(health({ nutrients: {} }), '2026-08-02'), CronometerParseError)
  assert.throws(
    () => parseHealthPayload(health({ nutrients: { kcal: -5 } }), '2026-08-02'), CronometerParseError)
})

// ---------------------------------------------------------------------------
// Export for Cronometer transcription
// ---------------------------------------------------------------------------

const entry = (o) => ({
  itemId: '1', name: 'Halal Grilled Chicken', station: 'The Texas Grill', servings: 2,
  portion: '1 each', perServing: { kcal: 146, protein_g: 22.4 },
  nutrients: { kcal: 292, protein_g: 44.8 }, at: '2026-08-08T17:30:00.000Z', ...o,
})

test('the week payload merges today with archived days, oldest first', () => {
  const p = weekLogPayload(
    { date: '2026-08-09', entries: [entry({ name: 'Baked Potato' })] },
    { '2026-08-07': [entry()], '2026-08-08': [entry()] },
    '2026-08-09',
  )
  assert.deepEqual(p.days.map((d) => d.date), ['2026-08-07', '2026-08-08', '2026-08-09'])
  assert.equal(p.days[2].entries[0].name, 'Baked Potato')
})

test('the week payload drops days outside the window', () => {
  const p = weekLogPayload(null, { '2026-07-01': [entry()], '2026-08-08': [entry()] }, '2026-08-09')
  assert.deepEqual(p.days.map((d) => d.date), ['2026-08-08'])
})

test('the week payload carries what a custom food needs', () => {
  const [day] = weekLogPayload({ date: '2026-08-09', entries: [entry()] }, {}, '2026-08-09').days
  const e = day.entries[0]
  assert.equal(e.portion, '1 each')
  assert.equal(e.perServing.protein_g, 22.4, 'per-serving figures create the food once')
  assert.equal(e.servings, 2, 'servings is the only thing that changes per entry')
  assert.equal(e.total.protein_g, 44.8, 'the day total is the cross-check')
  assert.equal(e.station, 'The Texas Grill')
})

test('an entry logged before per-serving figures existed still exports them', () => {
  const old = { name: 'Black Beans', servings: 4, nutrients: { kcal: 208 } }
  const [day] = weekLogPayload({ date: '2026-08-09', entries: [old] }, {}, '2026-08-09').days
  assert.equal(day.entries[0].perServing.kcal, 52)
  assert.equal(day.entries[0].portion, null)
})

test('an unpublished nutrient stays absent from the export, never zero', () => {
  const e = entry({ perServing: { kcal: 146 }, nutrients: { kcal: 292 } })
  const [day] = weekLogPayload({ date: '2026-08-09', entries: [e] }, {}, '2026-08-09').days
  assert.equal('sodium_mg' in day.entries[0].perServing, false)
})

test('empty days are omitted rather than exported as blanks', () => {
  const p = weekLogPayload({ date: '2026-08-09', entries: [] }, { '2026-08-08': [] }, '2026-08-09')
  assert.deepEqual(p.days, [])
})
