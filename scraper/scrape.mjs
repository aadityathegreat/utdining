// Scrapes a week of UT dining menus into data/menu.json.
// Runs on a schedule (see .github/workflows/scrape.yml), never on the phone.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseLabel, parseLongMenu, parseLocations, NoNutritionData } from './parse.mjs'

const BASE = 'https://hf-foodpro.austin.utexas.edu/foodpro'
const SITE = 'University Housing and Dining'
const MEALS = ['Breakfast', 'Lunch', 'Dinner']
const DAYS = 7
const POLITE_DELAY_MS = 200

const dataDir = fileURLToPath(new URL('../data/', import.meta.url))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'utdining-personal-scraper' } })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.text()
}

// FoodPro wants MM/DD/YYYY, and the menu it serves is Central-time based.
function menuDates() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  })
  const out = []
  for (let i = 0; i < DAYS; i++) {
    const d = new Date(Date.now() + i * 86400000)
    const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]))
    out.push({ foodpro: `${p.month}/${p.day}/${p.year}`, iso: `${p.year}-${p.month}-${p.day}` })
  }
  return out
}

function longMenuUrl(hall, date, meal) {
  const q = new URLSearchParams({
    sName: SITE,
    locationNum: hall.num,
    locationName: hall.name,
    naFlag: '1',
    WeeksMenus: "This Week's Menus",
    dtdate: date,
    mealName: meal,
  })
  return `${BASE}/longmenu.aspx?${q}`
}

function labelUrl(hall, date, itemId) {
  const q = new URLSearchParams({
    locationNum: hall.num, locationName: hall.name, dtdate: date, RecNumAndPort: itemId,
  })
  return `${BASE}/label.aspx?${q}`
}

function readCache() {
  try {
    return JSON.parse(readFileSync(`${dataDir}labels.json`, 'utf8'))
  } catch {
    return {}
  }
}

async function main() {
  mkdirSync(dataDir, { recursive: true })

  // Nutrition per recipe number is stable, so labels are fetched once and reused.
  // First run pulls a few hundred; later runs pull only genuinely new dishes.
  const labels = readCache()
  const cacheSizeAtStart = Object.keys(labels).length

  const halls = parseLocations(await get(`${BASE}/location.aspx`))
  if (halls.length === 0) throw new Error('no dining halls found — location.aspx layout changed?')
  console.log(`halls: ${halls.map((h) => h.name).join(', ')}`)

  const dates = menuDates()
  const out = { generatedAt: new Date().toISOString(), halls: [], items: {} }
  const seen = new Set()
  let labelFailures = 0
  let unpublished = 0

  for (const hall of halls) {
    const hallOut = { num: hall.num, name: hall.name, days: [] }

    for (const date of dates) {
      const dayOut = { date: date.iso, meals: [] }

      for (const meal of MEALS) {
        let rows
        try {
          rows = parseLongMenu(await get(longMenuUrl(hall, date.foodpro, meal)))
        } catch (err) {
          // A closed hall or an unserved meal is normal, not a failure.
          console.warn(`  skip ${hall.name} ${date.iso} ${meal}: ${err.message}`)
          continue
        }
        await sleep(POLITE_DELAY_MS)
        if (rows.length === 0) continue

        const stations = []
        for (const row of rows) {
          let station = stations.find((s) => s.name === row.station)
          if (!station) stations.push((station = { name: row.station, itemIds: [] }))
          if (!station.itemIds.includes(row.itemId)) station.itemIds.push(row.itemId)

          if (seen.has(row.itemId)) continue
          seen.add(row.itemId)

          if (!labels[row.itemId]) {
            try {
              labels[row.itemId] = parseLabel(await get(labelUrl(hall, date.foodpro, row.itemId)))
              await sleep(POLITE_DELAY_MS)
            } catch (err) {
              if (err instanceof NoNutritionData) {
                // UT publishes nothing for this dish. It cannot be recommended, but it
                // is not evidence the parser has gone stale.
                unpublished++
                continue
              }
              // One unreadable label costs one dish, not the whole run.
              console.warn(`  label failed ${row.itemId} (${row.name}): ${err.message}`)
              labelFailures++
              continue
            }
          }

          const label = labels[row.itemId]
          out.items[row.itemId] = {
            ...label,
            // The label's icon row is missing on a few items; the menu page still shows
            // them, so the union of both is the trustworthy set.
            icons: [...new Set([...label.icons, ...row.icons])],
          }
        }

        dayOut.meals.push({ meal, stations })
      }

      if (dayOut.meals.length > 0) hallOut.days.push(dayOut)
    }

    if (hallOut.days.length > 0) out.halls.push(hallOut)
  }

  const itemCount = Object.keys(out.items).length
  if (itemCount === 0) throw new Error('scraped zero items — refusing to overwrite good data')

  // A handful of bad labels is normal. A landslide means the page changed.
  if (labelFailures > itemCount * 0.1) {
    throw new Error(`${labelFailures} label failures against ${itemCount} items — parser likely stale`)
  }

  writeFileSync(`${dataDir}labels.json`, JSON.stringify(labels))
  writeFileSync(`${dataDir}menu.json`, JSON.stringify(out))

  console.log(
    `wrote ${itemCount} items across ${out.halls.length} hall(s); ` +
    `label cache ${cacheSizeAtStart} -> ${Object.keys(labels).length}; ` +
    `${labelFailures} label failure(s); ${unpublished} dish(es) with no published nutrition`,
  )
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
