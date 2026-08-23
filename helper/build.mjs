// Turns helper/fill-cronometer.js into the `javascript:` URL you paste into a bookmark.
//
// No minifier and no dependencies — this repo has none and is not starting now. Comments and
// leading whitespace come out, everything else stays, and the result is percent-encoded so a
// bookmark field cannot mangle it.
//
//   node helper/build.mjs           print the URL
//   node helper/build.mjs --check   verify docs/HELPER.md carries the current build
//
// The readable source is the thing to edit. The URL in the docs is a build artifact.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = (p) => fileURLToPath(new URL(p, import.meta.url))

/**
 * Strips comments and indentation without a parser.
 *
 * Only safe because the source is written for it: no regex literals containing `//`, and no
 * string containing `//` or a block-comment opener outside a comment. A blunt tool that would
 * corrupt arbitrary JavaScript is fine on one file whose output is checked by running it —
 * see the fixture test, which builds the URL and executes it against a real form.
 *
 * Newlines between statements are kept. Collapsing to one line would put automatic semicolon
 * insertion in charge of a file that relies on it.
 */
export function stripped(source) {
  const out = []
  let inBlock = false

  for (const line of source.split('\n')) {
    let text = line.trim()

    if (inBlock) {
      const end = text.indexOf('*/')
      if (end === -1) continue
      text = text.slice(end + 2).trim()
      inBlock = false
    }

    const open = text.indexOf('/*')
    if (open !== -1) {
      const close = text.indexOf('*/', open + 2)
      if (close === -1) {
        text = text.slice(0, open).trim()
        inBlock = true
      } else {
        text = (text.slice(0, open) + text.slice(close + 2)).trim()
      }
    }

    if (text.startsWith('//')) continue
    if (text) out.push(text)
  }

  return out.join('\n')
}

export function bookmarklet(source) {
  return `javascript:${encodeURIComponent(stripped(source))}`
}

export const SOURCE = () => readFileSync(here('./fill-cronometer.js'), 'utf8')

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = bookmarklet(SOURCE())

  if (process.argv.includes('--check')) {
    const docs = readFileSync(here('../docs/HELPER.md'), 'utf8')
    if (docs.includes(url)) {
      console.log(`docs/HELPER.md is current (${url.length} chars)`)
    } else {
      console.error('docs/HELPER.md does not carry the current build. Re-run node helper/build.mjs')
      process.exit(1)
    }
  } else {
    console.log(url)
  }
}
