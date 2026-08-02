// Pure parsers for UT Austin FoodPro pages. No I/O, no dependencies.
// Every function here is covered by test/parse.test.mjs against committed real fixtures.

// The complete nutrient vocabulary. UT publishes these and nothing else.
// Each entry: [key, label as it appears in the label page's detail list, unit suffix]
const NUTRIENT_SPEC = [
  ['kcal', 'Calories', 'kcal'],
  ['fat_g', 'Fat', 'g'],
  ['satfat_g', 'Saturated Fat', 'g'],
  ['transfat_g', 'Trans Fatty Acid', 'g'],
  ['chol_mg', 'Cholesterol', 'mg'],
  ['sodium_mg', 'Sodium', 'mg'],
  ['carb_g', 'Carbohydrates', 'g'],
  ['fiber_g', 'Dietary Fiber', 'g'],
  ['sugar_g', 'Total Sugars', 'g'],
  ['addedsugar_g', 'Added Sugar', 'g'],
  ['protein_g', 'Protein', 'g'],
  ['vitd_mcg', 'Vitamin D - mcg', 'mcg'],
  ['calcium_mg', 'Calcium', 'mg'],
  ['iron_mg', 'Iron', 'mg'],
  ['potassium_mg', 'Potassium', 'mg'],
]

export const NUTRIENT_KEYS = NUTRIENT_SPEC.map(([k]) => k)

// The closed set of diet/allergen icons FoodPro uses. An icon outside this set is a
// scraper error, not something to skip quietly — restriction filtering depends on it.
export const KNOWN_ICONS = new Set([
  'Beef', 'Pork', 'Milk', 'Eggs', 'Fish', 'Shellfish', 'Peanuts',
  'Sesame', 'Soy', 'Wheat', 'Halal', 'Vegan', 'Veggie', 'TreeNuts',
])

export class ParseError extends Error {}

/** UT serves the dish but publishes no figures for it. Expected, not a parser fault —
 *  the scraper skips these without tripping its staleness alarm. */
export class NoNutritionData extends Error {}

// Value fields carry raw unescaped `&` and `"`, so only &nbsp; is a real entity here.
function clean(s) {
  return s.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
}

function firstGroup(html, re) {
  const m = html.match(re)
  return m ? m[1] : null
}

// ---------------------------------------------------------------------------
// Portions
// ---------------------------------------------------------------------------

// FoodPro serving sizes observed across a full 140-item sweep:
//   "1 each" "4 oz" "1 ozL" "1 ozl" "1 slice" "1/12 pizza" "1/2 oz" "1 serving" "2 ozL"
//
// `ozL` is a LADLE — a volume scoop, not an ounce of weight. Converting it to grams
// would produce a confident wrong number, which is worse than no number at all.
const UNIT_CLASS = {
  oz: 'weight',
  ozl: 'volume', cup: 'volume', tbsp: 'volume', tsp: 'volume', 'fl oz': 'volume',
  each: 'count', slice: 'count', piece: 'count', pizza: 'count', serving: 'count',
}

const GRAMS_PER_OZ = 28.3495

function parseQty(s) {
  const frac = s.match(/^(\d+)\/(\d+)$/)
  if (frac) return Number(frac[1]) / Number(frac[2])
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

export function parsePortion(raw) {
  const text = clean(raw)
  const m = text.match(/^(\S+)\s+(.+)$/)
  if (!m) return { raw: text, qty: 1, unit: 'each', unitClass: 'count', grams: null }

  const qty = parseQty(m[1])
  const unit = m[2].toLowerCase() // `ozL` and `ozl` both appear in the wild
  const unitClass = UNIT_CLASS[unit] ?? 'count'

  return {
    raw: text,
    qty: qty ?? 1,
    unit,
    unitClass,
    // Grams only where genuinely derivable. Never estimated.
    grams: unitClass === 'weight' && qty != null
      ? Math.round(qty * GRAMS_PER_OZ * 10) / 10
      : null,
  }
}

// ---------------------------------------------------------------------------
// label.aspx
// ---------------------------------------------------------------------------

// The page states every nutrient twice: an FDA-style grid, then a plainer detail list
// with an extra decimal place and the four micronutrients the grid omits entirely.
//
// Both blocks share the class `nutfactstopnutrient`, so class alone cannot tell them
// apart. What does: in the detail list the label sits immediately after `">`, whereas
// the grid always prefixes it with `<b>` or a four-`&nbsp;` indent. Anchoring on `">`
// therefore matches the detail list and only the detail list.
//
// A blank value ("Added Sugar&nbsp;g") means UT did not publish the figure. It becomes
// null, never 0 — an unknown must not read as a virtue when the recommender scores it.
function parseNutrients(html) {
  const out = {}
  for (const [key, label, unit] of NUTRIENT_SPEC) {
    const re = new RegExp(`">${escapeRe(label)}&nbsp;([0-9.]*)${unit}</span>`)
    const m = html.match(re)
    if (!m) throw new ParseError(`nutrient row not found: ${label}`)
    out[key] = m[1] === '' ? null : Number(m[1])
  }
  return out
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parseIcons(html, { strict = true } = {}) {
  const icons = []
  for (const m of html.matchAll(/LegendImages\/([A-Za-z]+)\.png/g)) {
    const name = m[1]
    if (!KNOWN_ICONS.has(name)) {
      if (strict) throw new ParseError(`unknown diet icon: ${name}`)
      continue
    }
    if (!icons.includes(name)) icons.push(name)
  }
  return icons
}

export function parseLabel(html) {
  const name = firstGroup(html, /<div class="labelrecipe">([^<]*)<\/div>/)
  if (name == null) throw new ParseError('item name not found')

  // A real page variant: the dish is served, the label is empty.
  if (/Nutritional Information is not available/i.test(html)) {
    throw new NoNutritionData(clean(name))
  }

  // Two `nutfactsservsize` divs exist: a static "Serving size" caption, then the value.
  const sizes = [...html.matchAll(/<div class="nutfactsservsize">([^<]*)<\/div>/g)]
    .map((m) => clean(m[1]))
    .filter((s) => s.toLowerCase() !== 'serving size')
  if (sizes.length === 0) throw new ParseError('serving size not found')

  // Allergen text is blank on roughly half of all items, so it is supplementary
  // information only. Restriction filtering reads icons, never this field.
  const allergenRaw = firstGroup(html, /<span class="labelallergensvalue">([^<]*)<\/span>/) ?? ''
  const ingredients = firstGroup(html, /<span class="labelingredientsvalue">([^<]*)<\/span>/) ?? ''

  return {
    name: clean(name),
    portion: parsePortion(sizes[0]),
    // The icon row is absent on a few items; icons from the menu page fill that gap.
    icons: parseIcons(html),
    allergens: clean(allergenRaw).split(',').map((s) => s.trim()).filter(Boolean),
    ingredients: clean(ingredients),
    nutrients: parseNutrients(html),
  }
}

// ---------------------------------------------------------------------------
// longmenu.aspx
// ---------------------------------------------------------------------------

// The page is deeply nested tables, so rather than parse structure we scan forward for
// four marker patterns and run a small state machine. An item is emitted when its
// portion cell arrives, which is always the last marker belonging to that row.
const MENU_TOKEN = new RegExp(
  [
    /<div class='longmenucolmenucat'>([^<]*)<\/div>/.source,
    /<div class='longmenucoldispname'>.*?RecNumAndPort=([^']*)'[^>]*>([^<]*)<\/a>/.source,
    /LegendImages\/([A-Za-z]+)\.png/.source,
    /<div class="longmenucolportions">([^<]*)<\/div>/.source,
  ].map((s) => `(?:${s})`).join('|'),
  'g',
)

export function parseLongMenu(html) {
  const items = []
  let station = null
  let pending = null

  for (const m of html.matchAll(MENU_TOKEN)) {
    const [, category, recNum, itemName, icon, portion] = m

    if (category !== undefined) {
      // Categories arrive as "-- The Texas Grill --".
      station = clean(category).replace(/^-+\s*|\s*-+$/g, '')
      pending = null
    } else if (recNum !== undefined) {
      pending = {
        itemId: decodeURIComponent(recNum),
        name: clean(itemName),
        station: station ?? 'Other',
        icons: [],
        portionRaw: null,
      }
    } else if (icon !== undefined) {
      // The page footer repeats every icon as a legend. `pending` is null by then,
      // because the item was flushed at its portion cell, so the legend is ignored.
      if (pending && KNOWN_ICONS.has(icon) && !pending.icons.includes(icon)) {
        pending.icons.push(icon)
      }
    } else if (portion !== undefined) {
      // Station header rows carry an empty portion cell; guard against flushing on those.
      if (pending) {
        pending.portionRaw = clean(portion)
        items.push(pending)
        pending = null
      }
    }
  }
  return items
}

// ---------------------------------------------------------------------------
// location.aspx
// ---------------------------------------------------------------------------

// Read from the page rather than hardcoded: only J2 is listed over the summer, and
// Kinsolving and JCL should reappear for the semester with no code change.
export function parseLocations(html) {
  const seen = new Map()
  for (const m of html.matchAll(/locationNum=([^&'"]+)&(?:amp;)?locationName=([^&'"]+)/g)) {
    const num = decodeURIComponent(m[1])
    const name = decodeURIComponent(m[2].replace(/\+/g, ' '))
    if (!seen.has(num)) seen.set(num, { num, name })
  }
  return [...seen.values()]
}
