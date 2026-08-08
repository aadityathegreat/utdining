// Probes FoodPro for dining halls we don't know the locationNum of yet (specifically
// JCL), by brute-forcing candidate numbers rather than waiting for location.aspx to
// list them. Purely informational: never blocks or corrupts the real scrape, and never
// touches menu.json or labels.json. Runs on a schedule (see .github/workflows/scrape.yml).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseLongMenu, parseLocations } from './parse.mjs'

const BASE = 'https://hf-foodpro.austin.utexas.edu/foodpro'
const SITE = 'University Housing and Dining'
const MEALS = ['Breakfast', 'Lunch', 'Dinner']
const DAYS = 7
const MAX_NUM = 20
const POLITE_DELAY_MS = 200

const dataDir = fileURLToPath(new URL('../data/', import.meta.url))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'utdining-personal-scraper' } })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.text()
}

// FoodPro wants MM/DD/YYYY, and the menu it serves is Central-time based. Same
// convention as scrape.mjs, parameterized by day count since discovery only needs
// today for triage but a full week for detail.
function menuDates(days) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  })
  const out = []
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() + i * 86400000)
    const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]))
    out.push({ foodpro: `${p.month}/${p.day}/${p.year}`, iso: `${p.year}-${p.month}-${p.day}` })
  }
  return out
}

// locationName and sName are ignored server-side — only locationNum selects the hall
// (verified live: locationNum=12&locationName=WRONG still returns J2's menu).
//
// locationName is sent EMPTY on purpose. The page echoes whatever name is submitted back
// into all 74 of its own self-referencing links, and prints the hall's real name nowhere
// else (verified live 2026-08-08: locationNum=12 with a wrong name contains no "J2"
// anywhere in the response). Sending a name would therefore poison the probe with a name
// we invented. See detail() — names come from location.aspx only.
export function longMenuUrl(num, date, meal) {
  const q = new URLSearchParams({
    sName: SITE,
    locationNum: num,
    locationName: '',
    naFlag: '1',
    WeeksMenus: "This Week's Menus",
    dtdate: date,
    mealName: meal,
  })
  return `${BASE}/longmenu.aspx?${q}`
}

// ---------------------------------------------------------------------------
// Pure functions — unit tested against no network in test/discover.test.mjs.
// ---------------------------------------------------------------------------

// The probe list. STATE.md recorded JCL as locationNum "12a", but that was never
// verified against a live page, hence both plain and lettered variants up to 20.
export function candidateNums() {
  const nums = []
  for (let i = 1; i <= MAX_NUM; i++) nums.push(String(i))
  for (let i = 1; i <= MAX_NUM; i++) nums.push(String(i).padStart(2, '0'))
  for (const suffix of ['a', 'b']) {
    for (let i = 1; i <= MAX_NUM; i++) nums.push(`${i}${suffix}`)
    for (let i = 1; i <= MAX_NUM; i++) nums.push(`${String(i).padStart(2, '0')}${suffix}`)
  }
  // Padded and unpadded ranges overlap for 10-20 (and again once suffixed), so this is
  // not a no-op: it's what keeps the list from probing the same hall twice.
  return [...new Set(nums)]
}

// Do not add a name-from-longmenu parser here. It looks possible — the page is full of
// `locationName=J2+Dining` links — but that string is only the request's own param echoed
// back, and the hall's name appears nowhere else in the response. A probe-discovered hall
// is therefore nameless until location.aspx lists it, which mergeLocations backfills.

// Merges today's probe results into the running record. A hall never gets deleted —
// closing for the summer is not evidence it stopped existing — so an entry absent from
// `found` keeps every field it already had. Object.create(null) for the same
// prototype-pollution reason as readCache() in scrape.mjs: a candidate num or hall name
// is never trusted as a bare object key otherwise.
export function mergeLocations(prev, found, todayIso) {
  const merged = Object.create(null)
  for (const num of Object.keys(prev)) merged[num] = { ...prev[num] }

  for (const num of Object.keys(found)) {
    const f = found[num]
    const existing = merged[num]
    if (existing) {
      merged[num] = {
        ...existing,
        name: existing.name ?? f.name ?? null,
        lastSeen: todayIso,
        itemCount: f.itemCount,
        mealNames: f.mealNames,
      }
    } else {
      merged[num] = {
        num,
        name: f.name ?? null,
        firstSeen: todayIso,
        lastSeen: todayIso,
        itemCount: f.itemCount,
        mealNames: f.mealNames,
      }
    }
  }
  return merged
}

export function newlyFound(prev, merged) {
  return Object.keys(merged).filter((num) => !Object.prototype.hasOwnProperty.call(prev, num))
}

// ---------------------------------------------------------------------------
// Network — only runs when this file is the entry point.
// ---------------------------------------------------------------------------

function countRecNumAndPort(html) {
  const m = html.match(/RecNumAndPort/g)
  return m ? m.length : 0
}

function readLocations() {
  let raw
  try {
    raw = JSON.parse(readFileSync(`${dataDir}locations.json`, 'utf8'))
  } catch {
    raw = {}
  }
  const locations = Object.create(null)
  for (const key of Object.keys(raw)) locations[key] = raw[key]
  return locations
}

// Stable key order so diffs stay readable; numeric collation so "2" sorts before "10".
function sortedForWrite(map) {
  const collator = new Intl.Collator('en', { numeric: true })
  const out = Object.create(null)
  for (const num of Object.keys(map).sort((a, b) => collator.compare(a, b))) out[num] = map[num]
  return out
}

// Stage 1: cheap triage. Every candidate, today only, 3 meals, just counting hits.
// Stops at the first hit per candidate — the goal here is only "does this num exist
// at all", not the full detail that stage 2 collects.
async function triage(today) {
  const hits = []
  for (const num of candidateNums()) {
    let hit = false
    for (const meal of MEALS) {
      let html
      try {
        html = await get(longMenuUrl(num, today.foodpro, meal))
      } catch (err) {
        console.warn(`  stage1 fetch failed num=${num} meal=${meal}: ${err.message}`)
        continue
      } finally {
        await sleep(POLITE_DELAY_MS)
      }
      if (countRecNumAndPort(html) > 0) {
        hit = true
        break
      }
    }
    if (hit) hits.push(num)
  }
  return hits
}

// Stage 2: only for candidates that triaged positive. Full week x 3 meals, to find
// every meal the hall actually publishes, the largest item count seen, and its name.
async function detail(num, dates) {
  const mealNames = new Set()
  let itemCount = 0
  // Always null: the menu page cannot name its own hall. location.aspx backfills it in
  // main() once UT lists the hall, and mergeLocations keeps the null until then.
  const name = null

  for (const date of dates) {
    for (const meal of MEALS) {
      let html
      try {
        html = await get(longMenuUrl(num, date.foodpro, meal))
      } catch (err) {
        console.warn(`  stage2 fetch failed num=${num} ${date.iso} ${meal}: ${err.message}`)
        continue
      } finally {
        await sleep(POLITE_DELAY_MS)
      }

      let rows
      try {
        rows = parseLongMenu(html)
      } catch {
        // No menu published for this hall/day/meal combo — normal, not an error.
        continue
      }
      if (rows.length === 0) continue
      mealNames.add(meal)
      if (rows.length > itemCount) itemCount = rows.length
    }
  }

  return { name, itemCount, mealNames: [...mealNames] }
}

async function main() {
  mkdirSync(dataDir, { recursive: true })

  const prev = readLocations()
  const [today] = menuDates(1)
  const week = menuDates(DAYS)

  let halls = []
  try {
    halls = parseLocations(await get(`${BASE}/location.aspx`))
  } catch (err) {
    // location.aspx is only used to backfill names; a failure here shouldn't stop the
    // probe sweep from running.
    console.warn(`location.aspx fetch failed: ${err.message}`)
  }

  const hits = await triage(today)

  const found = Object.create(null)
  for (const num of hits) {
    found[num] = await detail(num, week)
  }

  // location.aspx is authoritative for names even though it's incomplete (only lists
  // halls currently open), so it overrides whatever name the probe itself found.
  for (const hall of halls) {
    if (found[hall.num]) {
      found[hall.num].name = hall.name
    } else {
      found[hall.num] = { name: hall.name, itemCount: 0, mealNames: [] }
    }
  }

  const merged = mergeLocations(prev, found, today.iso)
  const fresh = newlyFound(prev, merged)

  writeFileSync(`${dataDir}locations.json`, JSON.stringify(sortedForWrite(merged), null, 2))

  console.log(
    `discover: probed ${candidateNums().length} candidate(s), ${hits.length} responded, ` +
    `${Object.keys(merged).length} known location(s) total, ${fresh.length} new`,
  )
  for (const num of fresh) {
    const loc = merged[num]
    console.log(
      `NEW LOCATION: ${num} ${loc.name ?? '(unnamed)'} ` +
      `(${loc.itemCount} items, meals: ${loc.mealNames.join(', ') || 'none'})`,
    )
  }
}

// This probe is informational only — it must never fail the workflow it runs in.
// pathToFileURL rather than a `file://` template: the latter fails to match whenever the
// checkout path needs percent-encoding, and the failure mode is the script silently doing
// nothing at all.
const isMain = import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main()
    .catch((err) => console.error(`discover failed (non-fatal): ${err.message}`))
    .finally(() => process.exit(0))
}
