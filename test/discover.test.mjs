// Golden-style tests for the pure parts of the location-discovery probe. No network —
// see scraper/discover.mjs's main() for that half, which this file does not exercise.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as discover from '../scraper/discover.mjs'
import { candidateNums, longMenuUrl, mergeLocations, newlyFound } from '../scraper/discover.mjs'

// The probe must never send a hall name it made up. FoodPro echoes the submitted
// locationName into every self-referencing link on the page, so a non-empty value here
// comes back looking like the hall's real name and would be recorded as one.
test('longMenuUrl: locationName is sent empty', () => {
  const q = new URL(longMenuUrl('12a', '08/08/2026', 'Dinner')).searchParams
  assert.equal(q.get('locationName'), '')
  assert.equal(q.get('locationNum'), '12a')
})

// Regression guard, not a style rule. A previous version parsed the hall name out of the
// longmenu page; that string is only the request's own param echoed back, and loc 12
// fetched under a wrong name contains no "J2" anywhere. Names come from location.aspx.
test('no name-from-longmenu parser exists', () => {
  assert.equal('hallNameFromLongMenu' in discover, false)
})

test('candidateNums: includes plain and lettered forms, no duplicates', () => {
  const nums = candidateNums()
  assert.ok(nums.includes('12'), 'must probe 12')
  assert.ok(nums.includes('12a'), 'must probe 12a — STATE.md\'s unverified JCL guess')
  assert.equal(new Set(nums).size, nums.length, 'no duplicate candidates')
})

test('mergeLocations: a hall seen today updates lastSeen, itemCount, mealNames', () => {
  const prev = {
    12: {
      num: '12', name: 'J2 Dining', firstSeen: '2026-01-01', lastSeen: '2026-08-01',
      itemCount: 40, mealNames: ['Lunch'],
    },
  }
  const found = { 12: { name: 'J2 Dining', itemCount: 67, mealNames: ['Breakfast', 'Lunch', 'Dinner'] } }
  const merged = mergeLocations(prev, found, '2026-08-08')

  assert.equal(merged['12'].firstSeen, '2026-01-01', 'firstSeen must not be overwritten')
  assert.equal(merged['12'].lastSeen, '2026-08-08')
  assert.equal(merged['12'].itemCount, 67)
  assert.deepEqual(merged['12'].mealNames, ['Breakfast', 'Lunch', 'Dinner'])
})

test('mergeLocations: a known hall not seen today survives untouched', () => {
  const prev = {
    9: {
      num: '9', name: 'Kinsolving', firstSeen: '2025-09-01', lastSeen: '2026-05-10',
      itemCount: 55, mealNames: ['Breakfast', 'Dinner'],
    },
  }
  const merged = mergeLocations(prev, {}, '2026-08-08')
  assert.deepEqual(merged['9'], prev[9])
})

test('mergeLocations: a brand-new hall gets firstSeen = today and fills in name', () => {
  const merged = mergeLocations({}, { 12: { name: 'J2 Dining', itemCount: 67, mealNames: ['Lunch'] } }, '2026-08-08')
  assert.deepEqual(merged['12'], {
    num: '12', name: 'J2 Dining', firstSeen: '2026-08-08', lastSeen: '2026-08-08',
    itemCount: 67, mealNames: ['Lunch'],
  })
})

test('mergeLocations: a previously nameless hall gets its name filled in once seen', () => {
  const prev = {
    7: {
      num: '7', name: null, firstSeen: '2026-08-01', lastSeen: '2026-08-01',
      itemCount: 12, mealNames: [],
    },
  }
  const found = { 7: { name: 'JCL Dining', itemCount: 30, mealNames: ['Dinner'] } }
  const merged = mergeLocations(prev, found, '2026-08-08')
  assert.equal(merged['7'].name, 'JCL Dining')
  assert.equal(merged['7'].firstSeen, '2026-08-01', 'firstSeen must not be overwritten')
})

test('newlyFound: only nums absent from prev are reported', () => {
  const prev = { 12: { num: '12' } }
  const merged = { 12: { num: '12' }, 7: { num: '7' } }
  assert.deepEqual(newlyFound(prev, merged), ['7'])
})

test('newlyFound: nothing new when merged has no additional keys', () => {
  const prev = { 12: { num: '12' } }
  const merged = { 12: { num: '12' } }
  assert.deepEqual(newlyFound(prev, merged), [])
})
