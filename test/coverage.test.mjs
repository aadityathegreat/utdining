// Per-hall nutrition coverage, against the real captured JCL and Kins menus.
//
// The scraper has counted skipped dishes since the first build, but only as one number for
// the whole run — which cannot answer "is JCL thin, or is JCL just small". These tests drive
// the same counting the scraper does, over the same fixture pages, without touching UT's
// servers.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseLongMenu, parseLabel, NoNutritionData, ParseError } from '../scraper/parse.mjs'
import { hallCoverage } from '../scraper/coverage.mjs'
import { coverageOf } from '../recommend.mjs'

const fixture = (n) =>
  readFileSync(fileURLToPath(new URL(`../scraper/fixtures/${n}`, import.meta.url)), 'utf8')

const NO_LABEL_PAGE = '<div class="labelrecipe">Halal Chicken Sausage</div>'
  + '<div>Nutritional Information is not available for this recipe.</div>'

/**
 * The scraper's own loop, minus the network: walk each hall's menu rows, resolve a label per
 * dish exactly once across the whole run, and count per hall afterwards.
 *
 * The deduplication is the part worth reproducing. `seen` spans halls — the same recipe
 * number is the same dish everywhere — so a dish first met at Kins is never re-decided at
 * JCL, and per-hall coverage cannot be read off the fetch loop.
 */
function scrapeLike(halls, labelPageFor) {
  const items = Object.create(null)
  const noNutrition = new Set()
  const seen = new Set()
  const out = []

  for (const hall of halls) {
    const hallDishes = new Set()

    for (const row of hall.rows) {
      hallDishes.add(row.itemId)
      if (seen.has(row.itemId)) continue
      seen.add(row.itemId)

      try {
        items[row.itemId] = parseLabel(labelPageFor(row))
      } catch (err) {
        if (err instanceof NoNutritionData) noNutrition.add(row.itemId)
        // Anything else is a label failure: neither counted as published nor as unpublished.
      }
    }

    out.push({ name: hall.name, ...hallCoverage(hallDishes, items, noNutrition) })
  }

  return out
}

const jclRows = parseLongMenu(fixture('longmenu-jcl.html'))
const kinsRows = parseLongMenu(fixture('longmenu-kins.html'))

test('the fixtures still carry the two halls this counting exists for', () => {
  assert.ok(jclRows.length > 50, `JCL menu came back with ${jclRows.length} rows`)
  assert.ok(kinsRows.length > 50, `Kins menu came back with ${kinsRows.length} rows`)
})

test('a hall where UT published every label reports full coverage', () => {
  const [jcl] = scrapeLike(
    [{ name: 'JCL Dining', rows: jclRows }],
    () => fixture('label-jcl-tofu.html'),
  )
  const distinct = new Set(jclRows.map((r) => r.itemId)).size
  assert.equal(jcl.dishes, distinct)
  assert.equal(jcl.dishesWithNutrition, distinct)
  assert.equal(jcl.dishesWithoutNutrition, 0)
  assert.equal(
    coverageOf(jcl).text,
    `${distinct} of ${distinct} dishes this week have published nutrition.`,
  )
})

test('dishes UT publishes no label for are counted, not silently dropped', () => {
  // Every third dish has no published nutrition. Without a per-hall count the app simply
  // looks thin and says nothing about why.
  const rows = jclRows
  const [jcl] = scrapeLike(
    [{ name: 'JCL Dining', rows }],
    (row) => (rows.indexOf(row) % 3 === 0 ? NO_LABEL_PAGE : fixture('label-jcl-tofu.html')),
  )
  assert.ok(jcl.dishesWithoutNutrition > 0)
  assert.equal(jcl.dishesWithNutrition + jcl.dishesWithoutNutrition, jcl.dishes)
  assert.match(coverageOf(jcl).text, /UT publishes no label for \d+\./)
})

test('an unreadable label is not reported as UT publishing nothing', () => {
  // Our failure, not theirs. It falls out of both counts and surfaces as the difference.
  const rows = jclRows.slice(0, 10)
  const [jcl] = scrapeLike(
    [{ name: 'JCL Dining', rows }],
    (row) => {
      if (rows.indexOf(row) === 0) return NO_LABEL_PAGE
      if (rows.indexOf(row) === 1) return '<div>not a label page at all</div>'
      return fixture('label-jcl-tofu.html')
    },
  )
  assert.equal(jcl.dishesWithoutNutrition, 1)
  assert.equal(jcl.dishes - jcl.dishesWithNutrition - jcl.dishesWithoutNutrition, 1)
  assert.equal(coverageOf(jcl).unreadable, 1)
  assert.throws(() => parseLabel('<div>not a label page at all</div>'), ParseError)
})

test('a dish served at two halls counts at both, though its label is fetched once', () => {
  // The label fetch is deduplicated across halls. If coverage were read off that loop, the
  // second hall would report every shared dish as missing.
  const halls = scrapeLike(
    [
      { name: 'Kins Dining', rows: kinsRows },
      { name: 'JCL Dining', rows: jclRows },
    ],
    () => fixture('label-kins-burger.html'),
  )
  for (const hall of halls) {
    assert.equal(hall.dishesWithNutrition, hall.dishes, `${hall.name} lost dishes to the dedupe`)
  }
  assert.equal(halls[1].dishes, new Set(jclRows.map((r) => r.itemId)).size)
})

test('a hall with no rows produces zeroes, which the app refuses to render', () => {
  const [empty] = scrapeLike([{ name: 'Whitis', rows: [] }], () => NO_LABEL_PAGE)
  assert.deepEqual(empty, {
    name: 'Whitis', dishes: 0, dishesWithNutrition: 0, dishesWithoutNutrition: 0,
  })
  // Rule 2, applied to a new field: absent or empty means say nothing, never "0 of 0".
  assert.equal(coverageOf(empty), null)
})

test('the counts are added fields — nothing on the hall entry is renamed or removed', () => {
  const hallOut = { num: '12(a)', name: 'JCL Dining', days: [{ date: '2026-08-24', meals: [] }] }
  Object.assign(hallOut, hallCoverage(new Set(['1*1']), Object.create(null), new Set(['1*1'])))
  assert.equal(hallOut.num, '12(a)')
  assert.equal(hallOut.name, 'JCL Dining')
  assert.equal(hallOut.days.length, 1)
  assert.deepEqual(Object.keys(hallOut), [
    'num', 'name', 'days', 'dishes', 'dishesWithNutrition', 'dishesWithoutNutrition',
  ])
})
