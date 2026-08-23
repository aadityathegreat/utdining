// The form helper's safety invariants (roadmap B1).
//
// There is no DOM here and no jsdom in this repo, so these do not test that the helper fills a
// form — that was done by loading `helper/fixture-form.html` in a browser, and the real proof
// is the one run against Cronometer itself, which needs a login. What these pin are the four
// promises the helper makes that a future edit could quietly break, plus the fact that the
// build in `docs/HELPER.md` is the build in the repo.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { stripped, bookmarklet, SOURCE } from '../helper/build.mjs'

const source = SOURCE()
const url = bookmarklet(source)
const code = decodeURIComponent(url.slice('javascript:'.length))

test('the built bookmarklet is valid JavaScript', () => {
  // The stripper is a blunt line-based tool. If it ever eats something it should not, this is
  // where that shows up rather than on the phone with the form already open.
  assert.doesNotThrow(() => new Function(code))
})

test('the build strips comments and keeps the newlines', () => {
  assert.ok(!/\/\*/.test(code), 'block comment survived')
  assert.ok(!/^\s*\/\//m.test(code), 'line comment survived')
  // Collapsing to one line would hand this file to automatic semicolon insertion.
  assert.ok(code.split('\n').length > 50)
})

test('the helper makes no network request of any kind', () => {
  // Rule 2 of the handoff spec. A helper that phones home would be a different feature with a
  // different conversation attached to it.
  for (const forbidden of [/\bfetch\s*\(/, /XMLHttpRequest/, /sendBeacon/, /WebSocket/,
    /EventSource/, /\bimport\s*\(/, /new\s+Image/, /navigator\.connection/]) {
    assert.ok(!forbidden.test(code), `helper contains ${forbidden}`)
  }
})

test('the helper never submits the form', () => {
  // Saving is the user's action, after checking. A wrong Custom Food saved fast is worse than
  // a right one typed slowly.
  assert.ok(!/\.submit\s*\(/.test(code))
  assert.ok(!/requestSubmit/.test(code))
  assert.ok(!/\.click\s*\(\)/.test(code.replace(/addEventListener\('click'/g, '')))
})

test('the helper asks for no credential and stores nothing', () => {
  assert.ok(!/password|localStorage|sessionStorage|document\.cookie|indexedDB/i.test(code))
})

test('a null value is never turned into a zero on the way in', () => {
  // The one line that carries the room's oldest rule into this file. It has to keep reading
  // as "leave the box alone", not "write something harmless".
  assert.match(source, /if \(field\.value == null\) \{ blank\.push\(field\.label\); continue \}/)
})

test('docs/HELPER.md carries the current build', () => {
  // The URL in the docs is a build artifact of a file that is edited by hand. Without this,
  // fixing the helper and forgetting to rebuild ships the old one to the phone.
  const docs = readFileSync(fileURLToPath(new URL('../docs/HELPER.md', import.meta.url)), 'utf8')
  assert.ok(docs.includes(url), 'run `node helper/build.mjs` and paste the result into docs/HELPER.md')
})

test('stripped() leaves code that mentions a comment marker inside a string alone', () => {
  // Documenting the stripper's one real limitation as a test rather than as a hope.
  assert.equal(stripped("const a = 1 // trailing\nconst b = 2"), 'const a = 1 // trailing\nconst b = 2')
  assert.equal(stripped('// gone\nconst c = 3'), 'const c = 3')
})
