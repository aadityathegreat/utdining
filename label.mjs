// An Updated American Nutrition Facts panel, drawn from UT's published per-serving figures.
//
// WHY THIS EXISTS: Cronometer has no API and no diary import, and its mobile Custom Food
// screen is separate numeric inputs that no single paste can fill. Its label-photo scanner is
// the one route left that could fill every field from one action. This module produces the
// photo. Whether Cronometer's scanner actually reads it is the open question — that is what
// makes this a spike, and the UI says so rather than promising the round trip works.
//
// The model is pure and tested; only drawNutritionLabel touches a canvas.

import { suspectOf } from './nutrition.mjs'
import { SuspectItemError } from './recommend.mjs'

// FDA Daily Values, 2016 label rule, adults and children 4+. Published reference figures —
// not anyone's targets, and deliberately unrelated to the profile. A label shows the general
// population's %DV or it is not a label.
const DAILY_VALUE = {
  fat_g: 78,
  satfat_g: 20,
  chol_mg: 300,
  sodium_mg: 2300,
  carb_g: 275,
  fiber_g: 28,
  addedsugar_g: 50,
  vitd_mcg: 20,
  calcium_mg: 1300,
  iron_mg: 18,
  potassium_mg: 4700,
}

// Panel order, exactly as the Updated American label prints it.
// [key, printed label, unit, indent level, bold]
const BODY = [
  ['fat_g', 'Total Fat', 'g', 0, true],
  ['satfat_g', 'Saturated Fat', 'g', 1, false],
  ['transfat_g', 'Trans Fat', 'g', 1, false],
  ['chol_mg', 'Cholesterol', 'mg', 0, true],
  ['sodium_mg', 'Sodium', 'mg', 0, true],
  ['carb_g', 'Total Carbohydrate', 'g', 0, true],
  ['fiber_g', 'Dietary Fiber', 'g', 1, false],
  ['sugar_g', 'Total Sugars', 'g', 1, false],
  ['addedsugar_g', 'Added Sugars', 'g', 2, false],
  ['protein_g', 'Protein', 'g', 0, true],
]

const MICROS = [
  ['vitd_mcg', 'Vitamin D', 'mcg'],
  ['calcium_mg', 'Calcium', 'mg'],
  ['iron_mg', 'Iron', 'mg'],
  ['potassium_mg', 'Potassium', 'mg'],
]

const LABEL_FOR = Object.fromEntries(
  [...BODY, ...MICROS].map(([key, label]) => [key, label]))

// UT's figure, printed as published. FDA rounding rules would round fat below 5 g to the
// nearest half gram and calories to the nearest 5 or 10, and applying them would put a number
// on the label that is not the number in menu.json. The requirement is that every value match
// the UT per-serving figure exactly, so exactness wins over label compliance.
const amount = (value, unit) => `${Math.round(value * 10) / 10}${unit}`

const percentDv = (key, value) =>
  DAILY_VALUE[key] == null ? null : `${Math.round((value / DAILY_VALUE[key]) * 100)}%`

/**
 * Everything the panel prints, as data.
 *
 * Rows for nutrients UT did not publish are OMITTED rather than printed as zero. A scanner
 * that does not see a row leaves that field empty, which is the honest outcome; a printed
 * "0g" would assert the food contains none of it and skew every daily total afterwards.
 * The omissions come back in `omitted` so the UI can name them next to the image.
 *
 * @param {object} item  a menu item, with `nutrients` and `portion`
 * @returns {{title, subtitle, servingText, calories, rows, micros, omitted}}
 * @throws {SuspectItemError} for a dish whose UT figures failed the plausibility checks —
 *   a photo of a wrong number is still a wrong number.
 */
export function labelModel(item, { allowSuspect = false } = {}) {
  const suspect = suspectOf(item)
  // Same per-dish override as everywhere else. An image is the most believable form these
  // numbers can take, so the caller has to ask for it explicitly and the UI has to say why.
  if (suspect.length > 0 && !allowSuspect) {
    throw new SuspectItemError(
      `UT's figures for ${item.name} do not look right: ${suspect.map((s) => s.message).join('; ')}.`,
    )
  }

  const n = item.nutrients ?? {}
  const omitted = []
  const at = (key) => {
    const v = n[key]
    if (typeof v === 'number' && Number.isFinite(v)) return v
    omitted.push(LABEL_FOR[key] ?? key)
    return null
  }

  const rows = []
  for (const [key, label, unit, indent, bold] of BODY) {
    const v = at(key)
    if (v == null) continue
    rows.push({
      key,
      // "Includes Xg Added Sugars" is how the Updated label prints that one line.
      text: key === 'addedsugar_g' ? `Includes ${amount(v, unit)} Added Sugars` : `${label} ${amount(v, unit)}`,
      dv: percentDv(key, v),
      indent,
      bold,
    })
  }

  const micros = []
  for (const [key, label, unit] of MICROS) {
    const v = at(key)
    if (v == null) continue
    micros.push({ key, text: `${label} ${amount(v, unit)}`, dv: percentDv(key, v) })
  }

  const kcal = n.kcal
  const calories = typeof kcal === 'number' && Number.isFinite(kcal)
    ? String(Math.round(kcal * 10) / 10)
    : null
  if (calories == null) omitted.push('Calories')

  // The portion string exactly as UT publishes it, plus grams ONLY for a true weight portion.
  // A ladle is a volume scoop and gets no gram figure, here or anywhere else.
  const grams = item.portion?.unitClass === 'weight' ? item.portion.grams : null
  const servingText = grams != null
    ? `${item.portion.raw} (${Math.round(grams)}g)`
    : (item.portion?.raw ?? '1 serving')

  return {
    title: 'Nutrition Facts',
    subtitle: item.name,
    servingText,
    calories,
    rows,
    micros,
    omitted,
  }
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

// Rendered large on purpose. This image exists to be read by an OCR scanner on a phone, and
// a bigger panel with heavier strokes survives that better than a screen-sized one.
const W = 760
const PAD = 28
const SCALE = 2

const FONT = (size, weight = '') =>
  `${weight} ${size}px Helvetica, "Helvetica Neue", Arial, sans-serif`.trim()

/**
 * Draws the panel and returns the canvas. Browser only.
 *
 * Deliberately black on solid white with no rounded corners or theme colours: this is not UI,
 * it is an image meant to survive a photo scanner, and contrast is the whole job.
 */
export function drawNutritionLabel(model, doc = document) {
  const canvas = doc.createElement('canvas')
  const ctx = canvas.getContext('2d')

  // Two passes: measure the height the rows actually need, then draw at that height.
  const height = measure(model)
  canvas.width = W * SCALE
  canvas.height = height * SCALE
  ctx.scale(SCALE, SCALE)

  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, W, height)
  ctx.fillStyle = '#000'
  ctx.textBaseline = 'alphabetic'

  const right = W - PAD
  let y = PAD

  const rule = (weight) => {
    y += 6
    ctx.fillRect(PAD, y, W - PAD * 2, weight)
    y += weight + 10
  }

  const line = (text, dv, { size = 20, weight = '', indent = 0 } = {}) => {
    ctx.font = FONT(size, weight)
    y += size
    ctx.textAlign = 'left'
    ctx.fillText(text, PAD + indent * 22, y)
    if (dv) {
      ctx.textAlign = 'right'
      ctx.font = FONT(size, 'bold')
      ctx.fillText(dv, right, y)
    }
    y += 8
  }

  ctx.textAlign = 'left'
  ctx.font = FONT(48, 'bold')
  y += 48
  ctx.fillText(model.title, PAD, y)
  y += 10

  // The dish name is not part of the FDA panel, but the scanner has to get a food name from
  // somewhere and Cronometer asks for one.
  line(model.subtitle, null, { size: 22 })
  rule(3)
  line(`Serving size  ${model.servingText}`, null, { size: 22, weight: 'bold' })
  rule(12)

  line('Amount per serving', null, { size: 16 })
  if (model.calories != null) {
    ctx.font = FONT(34, 'bold')
    y += 34
    ctx.textAlign = 'left'
    ctx.fillText('Calories', PAD, y)
    ctx.textAlign = 'right'
    ctx.font = FONT(44, 'bold')
    ctx.fillText(model.calories, right, y)
    y += 8
  }
  rule(6)

  ctx.font = FONT(18, 'bold')
  y += 18
  ctx.textAlign = 'right'
  ctx.fillText('% Daily Value*', right, y)
  y += 8
  ctx.textAlign = 'left'
  rule(1)

  for (const row of model.rows) {
    line(row.text, row.dv, { size: 20, weight: row.bold ? 'bold' : '', indent: row.indent })
    rule(1)
  }

  rule(12)
  for (const micro of model.micros) {
    line(micro.text, micro.dv, { size: 20 })
    rule(1)
  }

  rule(6)
  ctx.font = FONT(14)
  y += 14
  ctx.textAlign = 'left'
  ctx.fillText('* Percent Daily Values are based on a 2,000 calorie diet.', PAD, y)
  y += 20
  ctx.fillText('Source: UT Austin University Housing and Dining, per serving.', PAD, y)

  return canvas
}

/** Height the panel needs. Kept beside the drawing code because it mirrors it line for line. */
function measure(model) {
  let h = PAD + 48 + 10 // title
  h += 22 + 8 // subtitle
  h += 6 + 3 + 10 // rule 3
  h += 22 + 8 // serving
  h += 6 + 12 + 10 // rule 12
  h += 16 + 8 // amount per serving
  if (model.calories != null) h += 34 + 8
  h += 6 + 6 + 10 // rule 6
  h += 18 + 8 // %DV header
  h += 6 + 1 + 10 // rule 1
  for (const _ of model.rows) h += 20 + 8 + 6 + 1 + 10
  h += 6 + 12 + 10
  for (const _ of model.micros) h += 20 + 8 + 6 + 1 + 10
  h += 6 + 6 + 10
  h += 14 + 20 + PAD
  return h
}

/** The PNG, as a Blob, ready for the share sheet or a download. Browser only. */
export function labelBlob(model, doc = document) {
  const canvas = drawNutritionLabel(model, doc)
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('canvas produced no image'))), 'image/png')
  })
}
