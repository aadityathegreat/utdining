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

/**
 * How many photos of one tray may go in a single request.
 *
 * A second view is the only accuracy lever available that costs nothing but a shutter tap:
 * a photo from above flattens a pile into a disc, and the same pile seen at eye level has a
 * height. It does not make the answer metric — nothing in the frame is of known size — but it
 * moves an amorphous pile from a guess to a comparison, which is exactly the rung of accuracy
 * the five-serving ladder was chosen for.
 *
 * Three, because each extra image is another ~1.5k input tokens and another upload on basement
 * WiFi, and because the marginal view after the third settles nothing a stepper cannot.
 */
export const MAX_IMAGES = 3

/**
 * The views the model may ask for. An enum, not free text, for the same reason the dish comes
 * back as a line number: what the screen says is written here, and the model only chooses
 * which of these sentences is shown. A model that could type its own instruction could type
 * a gram figure into it.
 */
export const ANGLE_SHOTS = ['none', 'side', 'closer', 'angled', 'top']

/** What the app says when each is asked for. `none` has no copy because nothing is shown. */
export const ANGLE_COPY = {
  side: {
    button: 'Add a side-on photo',
    why: 'From above a pile is a disc. From the side, at eye level, it has a height.',
  },
  closer: {
    button: 'Add a close-up photo',
    why: 'One dish filling the frame is easier to read than the same dish in a corner of the tray.',
  },
  angled: {
    button: 'Add an angled photo',
    why: 'About 45\u00b0 across the tray shows both the surface and the depth of what is on it.',
  },
  top: {
    button: 'Add a top-down photo',
    why: 'Straight down over the tray shows how much of each plate is covered.',
  },
}

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
  '- If a different view of the same tray would settle an amount you could not judge, ask for',
  '  one in "another": "side" for eye level from the side, "closer" for one dish filling the',
  '  frame, "angled" for about 45 degrees across the tray, "top" for straight down. Name the',
  '  list numbers it would settle. Answer "none" when what you have is enough \u2014 asking costs',
  '  another photo and another request, so ask only when the extra view would change an answer.',
  '- When you are given several photos they are the SAME tray from different angles. A dish',
  '  visible in more than one of them is one dish and is listed once.',
].join('\n')

export const VISION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['picks', 'another'],
  properties: {
    another: {
      type: 'object',
      additionalProperties: false,
      required: ['shot', 'lines'],
      properties: {
        shot: {
          type: 'string',
          enum: ANGLE_SHOTS,
          description: 'A further view of the same tray that would settle an amount you were '
            + 'unsure of, or "none" if what you were given was enough.',
        },
        lines: {
          type: 'array',
          items: { type: 'integer' },
          description: 'The list numbers that further view would settle.',
        },
      },
    },
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
 * The request body.
 *
 * `image` is one image or an array of them: the same tray, photographed from different
 * angles, which is the one accuracy lever a single camera has. Each is labelled in a text
 * block before it, and the closing text says outright that they are one tray, because the
 * failure mode of several photos is double-counting \u2014 a dish seen twice logged twice is a
 * worse answer than the single photo would have given.
 *
 * The image goes before the text: Claude reads an image-then-text turn better than the other
 * way round, and the candidate list is long.
 *
 * `output_config.format` replaces the old trick of prefilling an assistant turn with `{` \u2014
 * prefills are rejected outright on this model family, and a schema is a stronger guarantee
 * than an instruction to emit JSON anyway.
 */
export function visionBody(candidates, image) {
  if (!candidates?.length) throw new VisionError('No menu for today to match the photo against.')

  const images = (Array.isArray(image) ? image : [image]).filter(Boolean)
  if (!images.length) throw new VisionError('No image to send.')
  if (images.length > MAX_IMAGES) {
    throw new VisionError(`One tray is at most ${MAX_IMAGES} photos.`)
  }
  for (const img of images) {
    if (!img?.data) throw new VisionError('No image to send.')
    if (!IMAGE_MEDIA_TYPES.includes(img.mediaType)) {
      throw new VisionError(`${img.mediaType} is not an image Claude can read.`)
    }
  }

  const content = []
  for (const [i, img] of images.entries()) {
    // Unlabelled when there is only one: a lone "Photo 1 of 1:" is noise, and the single-image
    // request is still the common one.
    if (images.length > 1) content.push({ type: 'text', text: `Photo ${i + 1} of ${images.length}:` })
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.data },
    })
  }
  content.push({
    type: 'text',
    text: `Today's menu at this hall:\n\n${candidateLines(candidates)}\n\n`
      + (images.length > 1
        ? `The ${images.length} photos above are the same tray from different angles. A dish `
          + 'that appears in more than one of them is one dish and is listed once. Use the '
          + 'extra views to settle amounts a single angle could not.\n\n'
        : '')
      + 'Which of these are on the plate, and how many servings of each?',
  })

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
    messages: [{ role: 'user', content }],
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
 * The request for another angle, if there was one and if another photo is still allowed.
 *
 * Whitelisted the same way the picks are: the shot kind has to be one of the five this app
 * has copy for, and the dishes it would settle are rebuilt from the candidate list rather
 * than read out of the answer. So the screen never shows a sentence the model wrote, only a
 * sentence the model chose.
 *
 * `sent` is how many photos this tray has already cost. At the ceiling the ask is dropped
 * rather than shown and refused \u2014 an offer that cannot be taken is worse than no offer.
 */
export function readAngleRequest(data, candidates, sent = 1) {
  const shot = data?.another?.shot
  if (!ANGLE_SHOTS.includes(shot) || shot === 'none') return null
  if (sent >= MAX_IMAGES) return null

  const dishes = []
  const seen = new Set()
  for (const n of Array.isArray(data?.another?.lines) ? data.another.lines : []) {
    const line = Number(n)
    if (!Number.isInteger(line) || line < 1 || line > candidates.length) continue
    const candidate = candidates[line - 1]
    if (seen.has(candidate.itemId)) continue
    seen.add(candidate.itemId)
    dishes.push({ itemId: candidate.itemId, name: candidate.name })
    if (dishes.length >= MAX_PICKS) break
  }
  return { shot, dishes }
}

/**
 * The message from the API down to validated rows, plus any request for another angle.
 *
 * Returns `{ picks, another }`: `picks` is what to show, `another` is `null` or a view the
 * model would like before it commits to an amount.
 *
 * Structured output still arrives as text in a content block, so it is parsed rather than
 * read off a field — and parsed with `JSON.parse`, never matched with a regular expression:
 * this model family varies its string escaping.
 */
export function readVisionMessage(message, candidates, sent = 1) {
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
  return {
    picks: readVisionPicks(data, candidates),
    another: readAngleRequest(data, candidates, sent),
  }
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
