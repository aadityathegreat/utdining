// The Cronometer Custom Food form helper — roadmap B1, and a SPIKE, not a shipped feature.
//
// Run as a bookmarklet on Cronometer's "Create a Custom Food" page. It reads the JSON payload
// that utdining put on the clipboard and fills the form's inputs.
//
// Three rules it does not break, from `projects/dining/CRONOMETER-HANDOFF-BETA.md` section 4:
//
//   1. **It stores no password and asks for none.** It runs inside an already-logged-in page
//      and never sees a credential.
//   2. **It makes no network request.** No fetch, no XHR, no beacon, no script injection, no
//      image ping. Everything it does is DOM reads and writes on the page you ran it on.
//   3. **It never submits.** It fills boxes and stops. Saving is the user's action, after
//      checking, because a wrong Custom Food saved quickly is worse than a right one typed
//      slowly.
//
// And one rule from the room itself: a field whose value is null was never published by UT.
// The helper leaves that box exactly as it found it. It must never write 0, "0" or "" into a
// blank, because that asserts the food contains none of it and skews every later total.
//
// It is deliberately loud about failure. It reports every field it filled, every field it
// left blank on purpose, and every field it could not find at all — because a form that is
// 12/15 filled looks identical to a form that is 15/15 filled, and the difference is a wrong
// diary. If it cannot find the form at all it says so and changes nothing.
//
// Build the `javascript:` URL with `node helper/build.mjs`.

(function utdiningFillCronometer() {
  const TAG = 'utdining-helper'

  // ---------------------------------------------------------------------------
  // Reporting. Built before anything is touched, so a failure still has a voice.
  // ---------------------------------------------------------------------------

  const previous = document.getElementById(TAG)
  if (previous) previous.remove()

  const panel = document.createElement('div')
  panel.id = TAG
  // Set through CSSOM rather than a style attribute: a page with a strict style-src would
  // drop the attribute, and a report nobody can read is the same as no report.
  Object.assign(panel.style, {
    position: 'fixed', zIndex: '2147483647', insetInlineStart: '0', insetBlockEnd: '0',
    insetInlineEnd: '0', maxHeight: '60vh', overflowY: 'auto', background: '#fbf9f4',
    color: '#333f48', font: '14px/1.45 -apple-system, Helvetica, Arial, sans-serif',
    borderTop: '3px solid #333f48', padding: '12px 16px', boxSizing: 'border-box',
  })
  document.body.appendChild(panel)

  const say = (text, weight) => {
    const p = document.createElement('p')
    p.textContent = text
    Object.assign(p.style, { margin: '0 0 6px', fontWeight: weight ? '700' : '400' })
    panel.appendChild(p)
    return p
  }

  const close = () => {
    const b = document.createElement('button')
    b.textContent = 'Close'
    Object.assign(b.style, {
      minHeight: '44px', padding: '8px 16px', marginTop: '8px', background: '#bf5700',
      color: '#ffffff', border: '0', borderRadius: '2px', font: 'inherit', fontWeight: '600',
    })
    b.addEventListener('click', () => panel.remove())
    panel.appendChild(b)
  }

  // ---------------------------------------------------------------------------
  // Finding the inputs
  // ---------------------------------------------------------------------------

  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/[:*]+$/, '')

  const isFillable = (el) =>
    el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
    && !el.disabled && !el.readOnly
    && !['hidden', 'checkbox', 'radio', 'submit', 'button', 'file'].includes(el.type)

  /**
   * The input belonging to a labelled field.
   *
   * Cronometer's form is behind a login, so this was written without ever seeing its DOM. It
   * therefore tries the three shapes a form can take, cheapest and most reliable first, rather
   * than guessing at one and failing silently:
   *
   *   1. a real <label for=...>, which is the accessible and most likely case
   *   2. a <label> wrapping its own input
   *   3. any element whose own text is the label, then the nearest input within a few
   *      ancestors — the shape a div-based form lands in
   *
   * `used` stops two labels resolving to the same box, which is how a form gets filled with
   * the last value repeated and still looks complete.
   */
  function findInput(labelText, used) {
    const want = norm(labelText)

    for (const label of document.querySelectorAll('label')) {
      if (norm(label.textContent) !== want) continue
      const byFor = label.htmlFor && document.getElementById(label.htmlFor)
      if (isFillable(byFor) && !used.has(byFor)) return byFor
      const inside = label.querySelector('input, textarea')
      if (isFillable(inside) && !used.has(inside)) return inside
    }

    for (const el of document.querySelectorAll('label, span, div, td, th, p')) {
      if (norm(el.textContent) !== want) continue
      let node = el
      for (let up = 0; up < 4 && node; up++) {
        const candidates = [...node.querySelectorAll('input, textarea')]
          .filter((i) => isFillable(i) && !used.has(i))
        if (candidates.length === 1) return candidates[0]
        if (candidates.length > 1) break // ambiguous: refuse rather than pick one
        node = node.parentElement
      }
    }

    return null
  }

  /**
   * Writes a value the way a framework-managed input will actually notice.
   *
   * Assigning `.value` directly is invisible to React and to anything else holding its own
   * copy of the state: the box shows the text, the model still holds the old value, and Save
   * writes what you did not see. Going through the native prototype setter and then firing
   * input and change is the standard way round that, and it is also harmless on a plain form.
   */
  function setValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
    setter.call(el, String(value))
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }

  // ---------------------------------------------------------------------------
  // Filling
  // ---------------------------------------------------------------------------

  function fill(payload) {
    let parsed
    try {
      parsed = JSON.parse(payload)
    } catch {
      say('That clipboard text is not a utdining payload. In the app, open a dish, tap '
        + 'Nutrition, then "Copy payload for the helper".', true)
      close()
      return
    }

    if (!parsed || !parsed.utdining || !Array.isArray(parsed.fields)) {
      say('That JSON is not a utdining payload — no "utdining" version and no field list.', true)
      close()
      return
    }
    if (parsed.utdining !== 1) {
      say(`This payload is version ${parsed.utdining} and this helper only knows version 1. `
        + 'Rebuild the bookmarklet from helper/fill-cronometer.js.', true)
      close()
      return
    }

    const used = new Set()
    const filled = []
    const blank = []
    const missing = []

    for (const field of parsed.fields) {
      const input = findInput(field.label, used)
      if (!input) { missing.push(field.label); continue }
      used.add(input)

      // Null is "UT published nothing". Leave the box alone — writing 0 here is the one
      // thing this whole project refuses to do.
      if (field.value == null) { blank.push(field.label); continue }

      setValue(input, field.value)
      filled.push(`${field.label} = ${field.value}`)
    }

    if (filled.length === 0 && blank.length === 0) {
      say('Found none of the Custom Food fields on this page. Are you on Cronometer\'s '
        + '"Create a Custom Food" screen?', true)
      say(`Looked for: ${parsed.fields.map((f) => f.label).join(', ')}`)
      close()
      return
    }

    say(`Filled ${filled.length} of ${parsed.fields.length} fields. `
      + 'Check every one against the list in the app before you save.', true)
    for (const line of filled) say(`  ${line}`)

    if (blank.length > 0) {
      say(`Left blank on purpose — UT publishes no figure for these: ${blank.join(', ')}. `
        + 'Do not type 0 in them.', true)
    }

    // The loud case. A partly-filled form looks exactly like a filled one.
    if (missing.length > 0) {
      say(`COULD NOT FIND ${missing.length} field(s): ${missing.join(', ')}. `
        + 'Type these in by hand from the app, or the saved food will be wrong.', true)
    }

    say('This helper does not save. Review, then save it yourself.')
    close()
  }

  // ---------------------------------------------------------------------------
  // Getting the payload. Clipboard first, a paste box when the browser refuses.
  // ---------------------------------------------------------------------------

  function askForPaste(why) {
    say(why, true)
    const box = document.createElement('textarea')
    box.rows = 3
    box.placeholder = 'Paste the payload here'
    Object.assign(box.style, {
      width: '100%', font: 'inherit', padding: '8px', boxSizing: 'border-box',
      border: '1px solid #d8d3c6', borderRadius: '2px',
    })
    const go = document.createElement('button')
    go.textContent = 'Fill from this'
    Object.assign(go.style, {
      minHeight: '44px', padding: '8px 16px', marginTop: '8px', background: '#bf5700',
      color: '#ffffff', border: '0', borderRadius: '2px', font: 'inherit', fontWeight: '600',
    })
    go.addEventListener('click', () => {
      const text = box.value
      panel.replaceChildren()
      fill(text)
    })
    panel.appendChild(box)
    panel.appendChild(go)
  }

  if (!navigator.clipboard || !navigator.clipboard.readText) {
    askForPaste('This browser will not hand a script the clipboard. Paste the payload instead:')
    return
  }

  navigator.clipboard.readText().then(
    (text) => fill(text),
    // Safari in particular shows its own Paste confirmation and rejects if it is dismissed.
    // That is a refusal, not a fault, and the paste box is the honest way through it.
    () => askForPaste('The browser would not let the script read the clipboard. Paste it here:'),
  )
})()
