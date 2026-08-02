// Parses a Cronometer "Daily Nutrition" CSV export.
// Runs in the browser via FileReader. The file is never uploaded anywhere.

// Column names come from a real export (63 columns, 2026-08-02). Anything not listed
// here is ignored rather than guessed at.
const COLUMNS = {
  kcal: 'Energy (kcal)',
  protein_g: 'Protein (g)',
  carb_g: 'Carbs (g)',
  fat_g: 'Fat (g)',
  satfat_g: 'Saturated (g)',
  transfat_g: 'Trans-Fats (g)',
  chol_mg: 'Cholesterol (mg)',
  sodium_mg: 'Sodium (mg)',
  fiber_g: 'Fiber (g)',
  sugar_g: 'Sugars (g)',
  addedsugar_g: 'Added Sugars (g)',
  calcium_mg: 'Calcium (mg)',
  iron_mg: 'Iron (mg)',
  potassium_mg: 'Potassium (mg)',
  vitd_mcg: 'Vitamin D (IU)', // unit conversion below — see VITAMIN_D_IU_PER_MCG
}

// Cronometer reports vitamin D in IU; UT's labels report it in mcg. Left unconverted
// this is a 40x error feeding straight into the scoring.
const VITAMIN_D_IU_PER_MCG = 40

// Nutrients Cronometer tracks that UT does not publish. Carried separately so the app can
// say "you are short on zinc, and the dining hall data cannot help you with it"
// instead of silently dropping the gap.
const EXTRA_COLUMNS = {
  zinc_mg: 'Zinc (mg)',
  magnesium_mg: 'Magnesium (mg)',
  b12_mcg: 'B12 (Cobalamin) (µg)',
  folate_mcg: 'Folate (µg)',
  vitc_mg: 'Vitamin C (mg)',
  vita_mcg: 'Vitamin A (µg)',
  vite_mg: 'Vitamin E (mg)',
  vitk_mcg: 'Vitamin K (µg)',
  selenium_mcg: 'Selenium (µg)',
  phosphorus_mg: 'Phosphorus (mg)',
  copper_mg: 'Copper (mg)',
  omega3_g: 'Omega-3 (g)',
}

export const EXTRA_LABELS = {
  zinc_mg: 'zinc', magnesium_mg: 'magnesium', b12_mcg: 'vitamin B12',
  folate_mcg: 'folate', vitc_mg: 'vitamin C', vita_mcg: 'vitamin A',
  vite_mg: 'vitamin E', vitk_mcg: 'vitamin K', selenium_mcg: 'selenium',
  phosphorus_mg: 'phosphorus', copper_mg: 'copper', omega3_g: 'omega-3',
}

export class CronometerParseError extends Error {}

function splitCsvLine(line) {
  const out = []
  let field = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { field += '"'; i++ }
      else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') { out.push(field); field = '' }
    else field += c
  }
  out.push(field)
  return out
}

const num = (s) => {
  const n = Number((s ?? '').trim())
  return Number.isFinite(n) ? n : null
}

/**
 * @param {string} text  raw CSV file contents
 * @param {string} isoDate  the day to read, "YYYY-MM-DD"
 * @returns {{date, nutrients, extras}}
 * @throws {CronometerParseError} on a wrong file, or when the requested day is absent
 */
export function parseCronometerCsv(text, isoDate) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
  if (lines.length < 2) throw new CronometerParseError('That file has no rows in it.')

  const header = splitCsvLine(lines[0]).map((h) => h.trim())
  const at = (name) => header.indexOf(name)

  if (at('Date') !== 0) {
    throw new CronometerParseError(
      'That does not look like a Daily Nutrition export. Export "Daily Nutrition", not Servings.',
    )
  }
  // A wrong export type parses to nothing useful, and a half-filled profile is worse
  // than no import at all.
  for (const required of ['Energy (kcal)', 'Protein (g)']) {
    if (at(required) === -1) {
      throw new CronometerParseError(`Column "${required}" is missing — wrong export type?`)
    }
  }

  const rows = lines.slice(1).map(splitCsvLine)
  const row = rows.find((r) => r[0]?.trim() === isoDate)
  if (!row) {
    const days = rows.map((r) => r[0]?.trim()).filter(Boolean)
    throw new CronometerParseError(
      `No row for ${isoDate}. This file covers ${days[0]} to ${days[days.length - 1]}.`,
    )
  }

  const nutrients = {}
  for (const [key, col] of Object.entries(COLUMNS)) {
    const i = at(col)
    const v = i === -1 ? null : num(row[i])
    nutrients[key] = v != null && key === 'vitd_mcg' ? v / VITAMIN_D_IU_PER_MCG : v
  }

  const extras = {}
  for (const [key, col] of Object.entries(EXTRA_COLUMNS)) {
    const i = at(col)
    if (i !== -1) extras[key] = num(row[i])
  }

  return { date: isoDate, nutrients, extras }
}

/** The days present in a file, newest last — used to report what was actually exported. */
export function datesInCsv(text) {
  return text.split(/\r?\n/).slice(1)
    .map((l) => splitCsvLine(l)[0]?.trim())
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d ?? ''))
}
