/**
 * Reading a tray from a photo.
 *
 * What this does and — more importantly — what it refuses to do is settled in the room's
 * PORTION-PLAN, Phase 2. The short version:
 *
 * - The job is CLOSED-SET IDENTIFICATION. Today's menu at one hall is ~98 dishes with
 *   station names attached, not the open world. Matching a plate against that list is the
 *   strong half of the task and it removes the real tedium: a six-dish tray is six searches
 *   in the log box today.
 * - The job is NOT mass estimation. Single-camera volume is scale-ambiguous by physics —
 *   monocular depth carries no metric scale without a reference object in frame — and a
 *   vision model will happily return a confident, uncalibrated gram figure. `CONTEXT.md`'s
 *   first non-negotiable forbids exactly that: never display a gram figure that was not
 *   derived from a published weight portion.
 *
 * So nothing here ever asks for or accepts grams, calories or nutrients. The model answers
 * two questions per dish — WHICH dish, and HOW MANY of UT's own published servings, snapped
 * to a five-rung ladder — and everything downstream is computed from `menu.json` exactly as
 * it is for a dish picked by hand. Five buckets is classification, not regression.
 *
 * The model also never names a dish freely: it answers with an INDEX into the candidate list
 * this module built. An out-of-range integer is rejected here and cannot reach the log, which
 * is a stronger guarantee than asking it to echo an item id back correctly.
 *
 * Everything in this file is pure — no DOM, no fetch, no key. The caller supplies the image
 * bytes and sends the request; `visionBody` and `visionHeaders` only describe it.
 */

/** Sent as-is. The candidate list plus one downscaled photo is a small request; the
 *  identification is the part worth being right about. */
export const VISION_MODEL = 'claude-opus-5'
export const VISION_ENDPOINT = 'https://api.anthropic.com/v1/messages'
export const VISION_API_VERSION = '2023-06-01'

/**
 * The only amounts a photo may return.
 *
 * Deliberately coarser than the log stepper's halves-up-to-twelve. The stepper records what
 * he says he took; this guesses, and a guess should only be allowed the resolution the
 * evidence supports. Honest expected accuracy on an amorphous pile is about ±1 serving, so
 * offering a 4.5 would be dressing up noise. Anything outside the ladder is snapped into it,
 * and the row lands in a stepper he can move afterwards.
 */
export const SERVING_LADDER = [0.5, 1, 1.5, 2, 3]

export const CONFIDENCE_LEVELS = ['high', 'medium', 'low']

/** Long edge, in pixels, the caller should downscale to before sending. Claude bills images
 *  in 28px patches and downscales anything larger itself; sending more pixels than this buys
 *  no accuracy on a tray and costs tokens and upload time on campus WiFi. */
export const MAX_IMAGE_EDGE = 1568

export const IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']

/** How many dishes one photo may claim. A tray is six or seven; twenty is the model having
 *  a bad day, and every extra row is one more thing to check by hand. */
export const MAX_PICKS = 12

export class VisionError extends Error {}

/**
 * The list the photo is matched against: everything this hall serves today, at every meal.
 *
 * Not just the selected meal, for the same reason the log's search box is not: breakfast
 * gets logged at lunchtime more often than not, and a dish the list omits is a dish the
 * model cannot name — it can only leave it out or attach it to the wrong row.
 *
 * The station name rides along because it is genuinely discriminating: two beige piles are
 * hard to tell apart, "Home Zone" versus "Global Kitchen" is not.
 */
export function visionCandidates(menu, hall, date) {
  const day = hall?.days?.find((d) => d.date === date)
  const out = []
  const seen = new Set()

  for (const meal of day?.meals ?? []) {
    for (const station of meal.stations ?? []) {
      for (const id of station.itemIds ?? []) {
        const item = menu?.items?.[id]
        if (!item || seen.has(id)) continue
        seen.add(id)
        out.push({
          itemId: id,
          name: item.name,
          station: station.name,
          portion: item.portion,
        })
      }
    }
  }
  return out
}

/** One line per dish, numbered from 1. The number is the whole protocol: it is what comes
 *  back, and it is checked against this list's length before anything is logged. */
export function candidateLines(candidates) {
  return candidates
    .map((c, i) => `${i + 1}. ${c.name} — ${c.station} — one serving is ${c.portion?.raw ?? 'unknown'}`)
    .join('\n')
}

export const VISION_SYSTEM = [
  'You identify dining-hall dishes in a photo of a tray or plate, against a fixed list of',
  'what that hall is serving today. You answer with two things per dish: which line of the',
  'list it is, and how many of that line\'s published servings are on the plate.',
  '',
  'Rules:',
  '- Only answer with numbers from the list. If something on the plate is not on the list,',
  '  leave it out entirely. Never invent a dish.',
  '- Never estimate grams, ounces, calories or nutrients, and never mention them. The',
  '  serving count is the only quantity you give; the app computes everything else from the',
  '  hall\'s own published figures.',
  '- The serving count must be one of 0.5, 1, 1.5, 2 or 3. Round to the nearest.',
  '- For a dish served in pieces or slices, count the pieces. For a bowl or ladled dish,',
  '  judge how many ladles it holds. For a loose pile with no reference for scale, say so by',
  '  marking the pick low confidence rather than by picking a more precise-looking number.',
  '- confidence "high" means you are sure of both the dish and the amount. If either half is',
  '  a guess, it is not high.',
  '- An empty list is a valid answer. Guessing to fill the plate is worse than returning',
  '  nothing.',
].join('\n')

export const VISION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['picks'],
  properties: {
    picks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['line', 'servings', 'confidence'],
        properties: {
          line: {
            type: 'integer',
            description: 'The number of the dish in the list you were given.',
          },
          servings: {
            type: 'number',
            enum: SERVING_LADDER,
            description: "How many of that dish's published servings are on the plate.",
          },
          confidence: { type: 'string', enum: CONFIDENCE_LEVELS },
        },
      },
    },
  },
}

/**
 * The request body. The image goes before the text: Claude reads an image-then-text turn
 * better than the other way round, and the candidate list is long.
 *
 * `output_config.format` replaces the old trick of prefilling an assistant turn with `{` \u2014
 * prefills are rejected outright on this model family, and a schema is a stronger guarantee
 * than an instruction to emit JSON anyway.
 */
export function visionBody(candidates, image) {
  if (!candidates?.length) throw new VisionError('No menu for today to match the photo against.')
  if (!image?.data) throw new VisionError('No image to send.')
  if (!IMAGE_MEDIA_TYPES.includes(image.mediaType)) {
    throw new VisionError(`${image.mediaType} is not an image Claude can read.`)
  }

  return {
    model: VISION_MODEL,
    max_tokens: 2000,
    // Medium rather than the default high: this is a bounded classification against a list
    // that is already in front of it, and the request is paid for out of his own key.
    output_config: {
      effort: 'medium',
      format: { type: 'json_schema', schema: VISION_SCHEMA },
    },
    system: VISION_SYSTEM,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: image.mediaType, data: image.data },
        },
        {
          type: 'text',
          text: `Today's menu at this hall:\n\n${candidateLines(candidates)}\n\n` +
            'Which of these are on the plate, and how many servings of each?',
        },
      ],
    }],
  }
}

/**
 * Headers for calling the API straight from the phone.
 *
 * `anthropic-dangerous-direct-browser-access` is what makes the API answer a browser at all;
 * without it the request never gets past CORS. The name is a warning and it is the right
 * warning — the key is in this browser, which is why it lives in its own localStorage entry,
 * is never written into the settings backup, and is pasted by hand rather than shipped.
 */
export function visionHeaders(apiKey) {
  if (!apiKey) throw new VisionError('No API key set. Add one in Prefs to use the camera.')
  return {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': VISION_API_VERSION,
    'anthropic-dangerous-direct-browser-access': 'true',
  }
}

/** An API key, as far as this app can tell without spending a request on it. Catches the
 *  usual paste accidents — a whole shell line, a truncated copy — not a revoked key. */
export const looksLikeApiKey = (key) => /^sk-ant-[\w-]{20,}$/.test(String(key ?? '').trim())

/** The nearest rung. Ties go up: a plate the model reads as halfway between one and two
 *  servings is more often two, since the ladder's lower rungs are closer together. */
export function snapToLadder(servings) {
  const n = Number(servings)
  if (!Number.isFinite(n)) return null
  return SERVING_LADDER.reduce((best, rung) =>
    Math.abs(rung - n) <= Math.abs(best - n) ? rung : best)
}

/**
 * What actually gets shown, out of what the model said.
 *
 * This is a whitelist, not a clean-up. Every field of every returned row is rebuilt here
 * from the candidate list and the ladder, so a stray `grams`, `kcal` or `name` in the
 * response cannot survive into the app even if the schema is one day loosened. That is the
 * point: the never-invent-grams rule should hold because a gram figure has nowhere to go,
 * not because the prompt asked nicely.
 *
 * A repeated line is dropped rather than summed. Two helpings of one dish do happen, but a
 * duplicated row is far more often the model listing the same pile twice, and summing turns
 * that mistake into an amount he never took. The first row stands and the stepper is right
 * there.
 */
export function readVisionPicks(data, candidates) {
  const rows = Array.isArray(data?.picks) ? data.picks : []
  const out = []
  const taken = new Set()

  for (const row of rows) {
    const line = Number(row?.line)
    if (!Number.isInteger(line) || line < 1 || line > candidates.length) continue
    const candidate = candidates[line - 1]
    if (taken.has(candidate.itemId)) continue

    const servings = snapToLadder(row?.servings)
    if (servings == null) continue

    taken.add(candidate.itemId)
    out.push({
      itemId: candidate.itemId,
      name: candidate.name,
      station: candidate.station,
      portion: candidate.portion,
      servings,
      // Anything unrecognised is the least confident thing it could have been. An unknown
      // string must not read as "sure".
      confidence: CONFIDENCE_LEVELS.includes(row?.confidence) ? row.confidence : 'low',
    })
    if (out.length >= MAX_PICKS) break
  }
  return out
}

/**
 * The message from the API down to validated rows.
 *
 * Structured output still arrives as text in a content block, so it is parsed rather than
 * read off a field — and parsed with `JSON.parse`, never matched with a regular expression:
 * this model family varies its string escaping.
 */
export function readVisionMessage(message, candidates) {
  if (message?.type === 'error') {
    throw new VisionError(message.error?.message ?? 'The API refused the request.')
  }
  // A refusal is a 200 with nothing usable in it, so it has to be checked before the content.
  if (message?.stop_reason === 'refusal') {
    throw new VisionError('Claude declined to read this photo.')
  }
  if (message?.stop_reason === 'max_tokens') {
    throw new VisionError('The answer was cut off. Try a photo with fewer dishes in it.')
  }

  const text = (message?.content ?? [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim()
  if (!text) throw new VisionError('The API sent an empty answer.')

  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new VisionError('The API sent something that was not the expected answer.')
  }
  return readVisionPicks(data, candidates)
}

/** What one photo cost, in dollars, if the response says. Shown rather than hidden: it is
 *  his key and his bill, and a per-shot figure is the only way the habit stays visible. */
export function visionCost(usage) {
  const inTok = Number(usage?.input_tokens ?? 0)
  const outTok = Number(usage?.output_tokens ?? 0)
  if (!inTok && !outTok) return null
  // Claude Opus 5 list price, 2026-08: $5 per million in, $25 per million out.
  return (inTok * 5 + outTok * 25) / 1e6
}
