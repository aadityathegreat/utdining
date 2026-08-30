import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  visionCandidates, candidateLines, visionBody, visionHeaders, visionCost,
  readVisionPicks, readVisionMessage, snapToLadder, looksLikeApiKey,
  SERVING_LADDER, MAX_PICKS, VISION_MODEL, VISION_SCHEMA, VisionError,
} from '../vision.mjs'

const portion = (raw, over = {}) => ({ raw, qty: 3, unit: 'oz', unitClass: 'weight', grams: 85, ...over })

const MENU = {
  items: {
    a: { name: 'Beans de Charro', portion: portion('3 oz') },
    b: { name: 'Cheese Pizza', portion: portion('1/12 pizza', { qty: 1, unit: 'pizza', unitClass: 'count', grams: null }) },
    c: { name: 'Tortilla Soup', portion: portion('1 ozL', { qty: 1, unit: 'ozL', unitClass: 'volume', grams: null }) },
  },
  halls: [],
}

const HALL = {
  num: '12',
  days: [{
    date: '2026-08-25',
    meals: [
      { meal: 'Breakfast', stations: [{ name: 'Home Zone', itemIds: ['a'] }] },
      // 'a' repeats across meals on purpose: the candidate list must carry it once.
      { meal: 'Lunch', stations: [
        { name: 'Pizza', itemIds: ['b'] },
        { name: 'Soups', itemIds: ['c', 'a'] },
      ] },
    ],
  }],
}

const cands = () => visionCandidates(MENU, HALL, '2026-08-25')

// ---------------------------------------------------------------------------
// The candidate list
// ---------------------------------------------------------------------------

test('the candidate list is the whole day, not the selected meal', () => {
  const list = cands()
  assert.deepEqual(list.map((c) => c.itemId), ['a', 'b', 'c'])
  assert.equal(list[0].station, 'Home Zone')
})

test('a dish served twice in a day appears once', () => {
  assert.equal(cands().filter((c) => c.itemId === 'a').length, 1)
})

test('a day with no menu produces no candidates', () => {
  assert.deepEqual(visionCandidates(MENU, HALL, '2026-01-01'), [])
})

test('an item id with no item behind it is skipped, not sent as a blank line', () => {
  const hall = { days: [{ date: 'd', meals: [{ meal: 'Lunch', stations: [{ name: 'S', itemIds: ['a', 'gone'] }] }] }] }
  assert.deepEqual(visionCandidates(MENU, hall, 'd').map((c) => c.itemId), ['a'])
})

test('every line names the dish, the station and the published portion', () => {
  const lines = candidateLines(cands()).split('\n')
  assert.equal(lines[0], '1. Beans de Charro — Home Zone — one serving is 3 oz')
  assert.equal(lines[2], '3. Tortilla Soup — Soups — one serving is 1 ozL')
})

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

test('the request puts the image before the text and asks for the schema', () => {
  const body = visionBody(cands(), { mediaType: 'image/jpeg', data: 'AAAA' })
  assert.equal(body.model, VISION_MODEL)
  assert.equal(body.messages[0].content[0].type, 'image')
  assert.equal(body.messages[0].content[1].type, 'text')
  assert.deepEqual(body.output_config.format, { type: 'json_schema', schema: VISION_SCHEMA })
  assert.match(body.messages[0].content[1].text, /Beans de Charro/)
})

test('the request never asks for a mass', () => {
  const body = visionBody(cands(), { mediaType: 'image/jpeg', data: 'AAAA' })
  const sent = JSON.stringify({ system: body.system, messages: body.messages, schema: body.output_config.format })
  // "grams" appears in the system prompt only inside the sentence forbidding it.
  assert.equal(/\bgram\b|\bcalorie\b|\bkcal\b|\bounces\b/.test(JSON.stringify(body.output_config.format)), false)
  assert.match(sent, /Never estimate grams/)
})

test('the schema admits nothing but a line, a ladder rung and a confidence', () => {
  const item = VISION_SCHEMA.properties.picks.items
  assert.equal(item.additionalProperties, false)
  assert.deepEqual(Object.keys(item.properties).sort(), ['confidence', 'line', 'servings'])
  assert.deepEqual(item.properties.servings.enum, SERVING_LADDER)
})

test('an empty menu or a missing image is refused before the key is touched', () => {
  assert.throws(() => visionBody([], { mediaType: 'image/jpeg', data: 'A' }), VisionError)
  assert.throws(() => visionBody(cands(), null), VisionError)
  assert.throws(() => visionBody(cands(), { mediaType: 'image/heic', data: 'A' }), VisionError)
})

test('the browser-access header is sent, and no key means no request', () => {
  const headers = visionHeaders('sk-ant-test')
  assert.equal(headers['anthropic-dangerous-direct-browser-access'], 'true')
  assert.equal(headers['x-api-key'], 'sk-ant-test')
  assert.equal(headers['anthropic-version'], '2023-06-01')
  assert.throws(() => visionHeaders(''), VisionError)
})

test('an obviously wrong paste is caught before it is spent', () => {
  assert.equal(looksLikeApiKey('sk-ant-api03-abcdefghij0123456789xyz'), true)
  assert.equal(looksLikeApiKey('  sk-ant-api03-abcdefghij0123456789xyz  '), true)
  assert.equal(looksLikeApiKey('sk-ant-short'), false)
  assert.equal(looksLikeApiKey('export ANTHROPIC_API_KEY=sk-ant-api03-abcdefghij0123456789'), false)
  assert.equal(looksLikeApiKey(null), false)
})

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

test('every returned amount lands on the ladder', () => {
  assert.equal(snapToLadder(0.1), 0.5)
  assert.equal(snapToLadder(1.2), 1)
  assert.equal(snapToLadder(1.25), 1.5) // ties go up
  assert.equal(snapToLadder(2.4), 2)
  assert.equal(snapToLadder(97), 3)
  assert.equal(snapToLadder('2'), 2)
  assert.equal(snapToLadder('lots'), null)
})

test('a line number outside the list is dropped', () => {
  const picks = readVisionPicks({ picks: [{ line: 0 }, { line: 9 }, { line: 1.5 }, { line: 'a' }] }, cands())
  assert.deepEqual(picks, [])
})

test('a pick is rebuilt from the menu, so an invented gram figure has nowhere to land', () => {
  const picks = readVisionPicks({
    picks: [{ line: 1, servings: 2, confidence: 'high', grams: 340, kcal: 500, name: 'Steak' }],
  }, cands())
  assert.equal(picks.length, 1)
  assert.deepEqual(Object.keys(picks[0]).sort(),
    ['confidence', 'itemId', 'name', 'portion', 'servings', 'station'])
  assert.equal(picks[0].name, 'Beans de Charro')
  assert.equal(picks[0].itemId, 'a')
  assert.equal(picks[0].grams, undefined)
  assert.equal(picks[0].kcal, undefined)
})

test('an unrecognised confidence is the lowest one, never the highest', () => {
  const picks = readVisionPicks({ picks: [{ line: 1, servings: 1, confidence: 'certain' }] }, cands())
  assert.equal(picks[0].confidence, 'low')
})

test('the same dish twice is logged once — a duplicate is a mistake, not a second helping', () => {
  const picks = readVisionPicks({
    picks: [{ line: 1, servings: 1, confidence: 'high' }, { line: 1, servings: 2, confidence: 'low' }],
  }, cands())
  assert.equal(picks.length, 1)
  assert.equal(picks[0].servings, 1)
})

test('an off-ladder amount is snapped rather than dropped', () => {
  const picks = readVisionPicks({ picks: [{ line: 2, servings: 2.6, confidence: 'high' }] }, cands())
  assert.equal(picks[0].servings, 3)
})

test('nothing recognised is a valid answer', () => {
  assert.deepEqual(readVisionPicks({ picks: [] }, cands()), [])
  assert.deepEqual(readVisionPicks({}, cands()), [])
  assert.deepEqual(readVisionPicks(null, cands()), [])
})

test('a runaway answer is capped', () => {
  const many = Array.from({ length: 40 }, () => ({ line: 1, servings: 1, confidence: 'high' }))
  // All the same line, so dedup catches it first; distinct lines hit the cap.
  const wide = { items: {}, halls: [] }
  const stations = []
  for (let i = 0; i < 40; i++) {
    wide.items[`i${i}`] = { name: `Dish ${i}`, portion: portion('3 oz') }
    stations.push(`i${i}`)
  }
  const hall = { days: [{ date: 'd', meals: [{ meal: 'Lunch', stations: [{ name: 'S', itemIds: stations }] }] }] }
  const list = visionCandidates(wide, hall, 'd')
  const picks = readVisionPicks(
    { picks: list.map((_, i) => ({ line: i + 1, servings: 1, confidence: 'high' })) }, list)
  assert.equal(picks.length, MAX_PICKS)
  assert.equal(readVisionPicks({ picks: many }, cands()).length, 1)
})

// ---------------------------------------------------------------------------
// The message around the answer
// ---------------------------------------------------------------------------

const message = (text, over = {}) => ({
  type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text }], ...over,
})

test('the JSON is read out of the content block', () => {
  const picks = readVisionMessage(
    message('{"picks":[{"line":3,"servings":1.5,"confidence":"medium"}]}'), cands())
  assert.equal(picks[0].name, 'Tortilla Soup')
  assert.equal(picks[0].servings, 1.5)
})

test('a thinking block before the answer does not confuse the parse', () => {
  const msg = message('{"picks":[]}', {
    content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"picks":[]}' }],
  })
  assert.deepEqual(readVisionMessage(msg, cands()), [])
})

test('an error, a refusal and a cut-off answer each say what happened', () => {
  assert.throws(() => readVisionMessage({ type: 'error', error: { message: 'invalid x-api-key' } }, cands()),
    /invalid x-api-key/)
  assert.throws(() => readVisionMessage(message('{}', { stop_reason: 'refusal' }), cands()), /declined/)
  assert.throws(() => readVisionMessage(message('{"pic', { stop_reason: 'max_tokens' }), cands()), /cut off/)
  assert.throws(() => readVisionMessage(message(''), cands()), /empty/)
  assert.throws(() => readVisionMessage(message('sorry, no'), cands()), /not the expected answer/)
})

test('the cost of a shot is reported from what the API charged, not guessed', () => {
  assert.equal(visionCost({ input_tokens: 2000, output_tokens: 200 }).toFixed(4), '0.0150')
  assert.equal(visionCost(null), null)
})
