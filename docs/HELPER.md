# The Cronometer form helper — an unfinished experiment

**Status: unproven.** Roadmap **B1**. This is the last remaining route to the release gate's
"one action fills every field", and nobody has run it against Cronometer yet. Running it once
is the whole point, and either answer ends the question:

- **It fills the form** — do the round trip (**B2**) in the same sitting and Track B closes at
  six of six.
- **It does not** — the gate stays at four of six *permanently*, and the app says so out loud
  instead of leaving the line open forever. That is an acceptable end state. It is not a
  failure to record it.

The one-tap-per-field list in the app is the supported way in, before and after this test.

## What it is

A bookmarklet. You run it on Cronometer's **Create a Custom Food** page and it fills the inputs
from a payload the app put on your clipboard.

Three promises, from `CRONOMETER-HANDOFF-BETA.md` section 4, each pinned by a test in
`test/helper.test.mjs`:

1. **It stores no password and asks for none.** It runs inside a page you are already logged
   into and never sees a credential.
2. **It makes no network request.** No fetch, no XHR, no beacon, no image ping.
3. **It never saves.** It fills boxes and stops. You check, then you save.

And one from the room: a field UT published nothing for is **left untouched**, never set to 0.
The helper says which ones those were and tells you not to type 0 in them.

## Setup, once

iOS Safari has no "add bookmarklet" button, so it is the usual bookmark-editing dance:

1. On this page, tap the address bar and copy the whole `javascript:` line below.
2. Bookmark any page at all (Share, then Add Bookmark). Save it.
3. Open Bookmarks, tap **Edit**, tap the bookmark you just made.
4. Rename it **J2 fill**. Replace its URL with the line you copied. Done.

```
javascript:(function%20utdiningFillCronometer()%20%7B%0Aconst%20TAG%20%3D%20'utdining-helper'%0Aconst%20previous%20%3D%20document.getElementById(TAG)%0Aif%20(previous)%20previous.remove()%0Aconst%20panel%20%3D%20document.createElement('div')%0Apanel.id%20%3D%20TAG%0AObject.assign(panel.style%2C%20%7B%0Aposition%3A%20'fixed'%2C%20zIndex%3A%20'2147483647'%2C%20insetInlineStart%3A%20'0'%2C%20insetBlockEnd%3A%20'0'%2C%0AinsetInlineEnd%3A%20'0'%2C%20maxHeight%3A%20'60vh'%2C%20overflowY%3A%20'auto'%2C%20background%3A%20'%23fbf9f4'%2C%0Acolor%3A%20'%23333f48'%2C%20font%3A%20'14px%2F1.45%20-apple-system%2C%20Helvetica%2C%20Arial%2C%20sans-serif'%2C%0AborderTop%3A%20'3px%20solid%20%23333f48'%2C%20padding%3A%20'12px%2016px'%2C%20boxSizing%3A%20'border-box'%2C%0A%7D)%0Adocument.body.appendChild(panel)%0Aconst%20say%20%3D%20(text%2C%20weight)%20%3D%3E%20%7B%0Aconst%20p%20%3D%20document.createElement('p')%0Ap.textContent%20%3D%20text%0AObject.assign(p.style%2C%20%7B%20margin%3A%20'0%200%206px'%2C%20fontWeight%3A%20weight%20%3F%20'700'%20%3A%20'400'%20%7D)%0Apanel.appendChild(p)%0Areturn%20p%0A%7D%0Aconst%20close%20%3D%20()%20%3D%3E%20%7B%0Aconst%20b%20%3D%20document.createElement('button')%0Ab.textContent%20%3D%20'Close'%0AObject.assign(b.style%2C%20%7B%0AminHeight%3A%20'44px'%2C%20padding%3A%20'8px%2016px'%2C%20marginTop%3A%20'8px'%2C%20background%3A%20'%23bf5700'%2C%0Acolor%3A%20'%23ffffff'%2C%20border%3A%20'0'%2C%20borderRadius%3A%20'2px'%2C%20font%3A%20'inherit'%2C%20fontWeight%3A%20'600'%2C%0A%7D)%0Ab.addEventListener('click'%2C%20()%20%3D%3E%20panel.remove())%0Apanel.appendChild(b)%0A%7D%0Aconst%20norm%20%3D%20(s)%20%3D%3E%20(s%20%7C%7C%20'').replace(%2F%5Cs%2B%2Fg%2C%20'%20').trim().toLowerCase().replace(%2F%5B%3A*%5D%2B%24%2F%2C%20'')%0Aconst%20isFillable%20%3D%20(el)%20%3D%3E%0Ael%20%26%26%20(el.tagName%20%3D%3D%3D%20'INPUT'%20%7C%7C%20el.tagName%20%3D%3D%3D%20'TEXTAREA')%0A%26%26%20!el.disabled%20%26%26%20!el.readOnly%0A%26%26%20!%5B'hidden'%2C%20'checkbox'%2C%20'radio'%2C%20'submit'%2C%20'button'%2C%20'file'%5D.includes(el.type)%0Afunction%20findInput(labelText%2C%20used)%20%7B%0Aconst%20want%20%3D%20norm(labelText)%0Afor%20(const%20label%20of%20document.querySelectorAll('label'))%20%7B%0Aif%20(norm(label.textContent)%20!%3D%3D%20want)%20continue%0Aconst%20byFor%20%3D%20label.htmlFor%20%26%26%20document.getElementById(label.htmlFor)%0Aif%20(isFillable(byFor)%20%26%26%20!used.has(byFor))%20return%20byFor%0Aconst%20inside%20%3D%20label.querySelector('input%2C%20textarea')%0Aif%20(isFillable(inside)%20%26%26%20!used.has(inside))%20return%20inside%0A%7D%0Afor%20(const%20el%20of%20document.querySelectorAll('label%2C%20span%2C%20div%2C%20td%2C%20th%2C%20p'))%20%7B%0Aif%20(norm(el.textContent)%20!%3D%3D%20want)%20continue%0Alet%20node%20%3D%20el%0Afor%20(let%20up%20%3D%200%3B%20up%20%3C%204%20%26%26%20node%3B%20up%2B%2B)%20%7B%0Aconst%20candidates%20%3D%20%5B...node.querySelectorAll('input%2C%20textarea')%5D%0A.filter((i)%20%3D%3E%20isFillable(i)%20%26%26%20!used.has(i))%0Aif%20(candidates.length%20%3D%3D%3D%201)%20return%20candidates%5B0%5D%0Aif%20(candidates.length%20%3E%201)%20break%20%2F%2F%20ambiguous%3A%20refuse%20rather%20than%20pick%20one%0Anode%20%3D%20node.parentElement%0A%7D%0A%7D%0Areturn%20null%0A%7D%0Afunction%20setValue(el%2C%20value)%20%7B%0Aconst%20proto%20%3D%20el.tagName%20%3D%3D%3D%20'TEXTAREA'%20%3F%20HTMLTextAreaElement.prototype%20%3A%20HTMLInputElement.prototype%0Aconst%20setter%20%3D%20Object.getOwnPropertyDescriptor(proto%2C%20'value').set%0Asetter.call(el%2C%20String(value))%0Ael.dispatchEvent(new%20Event('input'%2C%20%7B%20bubbles%3A%20true%20%7D))%0Ael.dispatchEvent(new%20Event('change'%2C%20%7B%20bubbles%3A%20true%20%7D))%0A%7D%0Afunction%20fill(payload)%20%7B%0Alet%20parsed%0Atry%20%7B%0Aparsed%20%3D%20JSON.parse(payload)%0A%7D%20catch%20%7B%0Asay('That%20clipboard%20text%20is%20not%20a%20utdining%20payload.%20In%20the%20app%2C%20open%20a%20dish%2C%20tap%20'%0A%2B%20'Nutrition%2C%20then%20%22Copy%20payload%20for%20the%20helper%22.'%2C%20true)%0Aclose()%0Areturn%0A%7D%0Aif%20(!parsed%20%7C%7C%20!parsed.utdining%20%7C%7C%20!Array.isArray(parsed.fields))%20%7B%0Asay('That%20JSON%20is%20not%20a%20utdining%20payload%20%E2%80%94%20no%20%22utdining%22%20version%20and%20no%20field%20list.'%2C%20true)%0Aclose()%0Areturn%0A%7D%0Aif%20(parsed.utdining%20!%3D%3D%201)%20%7B%0Asay(%60This%20payload%20is%20version%20%24%7Bparsed.utdining%7D%20and%20this%20helper%20only%20knows%20version%201.%20%60%0A%2B%20'Rebuild%20the%20bookmarklet%20from%20helper%2Ffill-cronometer.js.'%2C%20true)%0Aclose()%0Areturn%0A%7D%0Aconst%20used%20%3D%20new%20Set()%0Aconst%20filled%20%3D%20%5B%5D%0Aconst%20blank%20%3D%20%5B%5D%0Aconst%20missing%20%3D%20%5B%5D%0Afor%20(const%20field%20of%20parsed.fields)%20%7B%0Aconst%20input%20%3D%20findInput(field.label%2C%20used)%0Aif%20(!input)%20%7B%20missing.push(field.label)%3B%20continue%20%7D%0Aused.add(input)%0Aif%20(field.value%20%3D%3D%20null)%20%7B%20blank.push(field.label)%3B%20continue%20%7D%0AsetValue(input%2C%20field.value)%0Afilled.push(%60%24%7Bfield.label%7D%20%3D%20%24%7Bfield.value%7D%60)%0A%7D%0Aif%20(filled.length%20%3D%3D%3D%200%20%26%26%20blank.length%20%3D%3D%3D%200)%20%7B%0Asay('Found%20none%20of%20the%20Custom%20Food%20fields%20on%20this%20page.%20Are%20you%20on%20Cronometer%5C's%20'%0A%2B%20'%22Create%20a%20Custom%20Food%22%20screen%3F'%2C%20true)%0Asay(%60Looked%20for%3A%20%24%7Bparsed.fields.map((f)%20%3D%3E%20f.label).join('%2C%20')%7D%60)%0Aclose()%0Areturn%0A%7D%0Asay(%60Filled%20%24%7Bfilled.length%7D%20of%20%24%7Bparsed.fields.length%7D%20fields.%20%60%0A%2B%20'Check%20every%20one%20against%20the%20list%20in%20the%20app%20before%20you%20save.'%2C%20true)%0Afor%20(const%20line%20of%20filled)%20say(%60%20%20%24%7Bline%7D%60)%0Aif%20(blank.length%20%3E%200)%20%7B%0Asay(%60Left%20blank%20on%20purpose%20%E2%80%94%20UT%20publishes%20no%20figure%20for%20these%3A%20%24%7Bblank.join('%2C%20')%7D.%20%60%0A%2B%20'Do%20not%20type%200%20in%20them.'%2C%20true)%0A%7D%0Aif%20(missing.length%20%3E%200)%20%7B%0Asay(%60COULD%20NOT%20FIND%20%24%7Bmissing.length%7D%20field(s)%3A%20%24%7Bmissing.join('%2C%20')%7D.%20%60%0A%2B%20'Type%20these%20in%20by%20hand%20from%20the%20app%2C%20or%20the%20saved%20food%20will%20be%20wrong.'%2C%20true)%0A%7D%0Asay('This%20helper%20does%20not%20save.%20Review%2C%20then%20save%20it%20yourself.')%0Aclose()%0A%7D%0Afunction%20askForPaste(why)%20%7B%0Asay(why%2C%20true)%0Aconst%20box%20%3D%20document.createElement('textarea')%0Abox.rows%20%3D%203%0Abox.placeholder%20%3D%20'Paste%20the%20payload%20here'%0AObject.assign(box.style%2C%20%7B%0Awidth%3A%20'100%25'%2C%20font%3A%20'inherit'%2C%20padding%3A%20'8px'%2C%20boxSizing%3A%20'border-box'%2C%0Aborder%3A%20'1px%20solid%20%23d8d3c6'%2C%20borderRadius%3A%20'2px'%2C%0A%7D)%0Aconst%20go%20%3D%20document.createElement('button')%0Ago.textContent%20%3D%20'Fill%20from%20this'%0AObject.assign(go.style%2C%20%7B%0AminHeight%3A%20'44px'%2C%20padding%3A%20'8px%2016px'%2C%20marginTop%3A%20'8px'%2C%20background%3A%20'%23bf5700'%2C%0Acolor%3A%20'%23ffffff'%2C%20border%3A%20'0'%2C%20borderRadius%3A%20'2px'%2C%20font%3A%20'inherit'%2C%20fontWeight%3A%20'600'%2C%0A%7D)%0Ago.addEventListener('click'%2C%20()%20%3D%3E%20%7B%0Aconst%20text%20%3D%20box.value%0Apanel.replaceChildren()%0Afill(text)%0A%7D)%0Apanel.appendChild(box)%0Apanel.appendChild(go)%0A%7D%0Aif%20(!navigator.clipboard%20%7C%7C%20!navigator.clipboard.readText)%20%7B%0AaskForPaste('This%20browser%20will%20not%20hand%20a%20script%20the%20clipboard.%20Paste%20the%20payload%20instead%3A')%0Areturn%0A%7D%0Anavigator.clipboard.readText().then(%0A(text)%20%3D%3E%20fill(text)%2C%0A()%20%3D%3E%20askForPaste('The%20browser%20would%20not%20let%20the%20script%20read%20the%20clipboard.%20Paste%20it%20here%3A')%2C%0A)%0A%7D)()
```

Rebuild it after editing `helper/fill-cronometer.js`:

```bash
node helper/build.mjs
```

`node helper/build.mjs --check` fails if this file has fallen behind the source, and a test
checks the same thing.

## The test to run

1. In the app, pick **Breakfast Topping Bar** — the dish the release gate names — tap
   **Nutrition**, open **Form helper**, tap **Copy payload for the helper**.
2. In Safari, go to Cronometer, then **Foods**, then **Create Food**.
3. Type `J2 fill` in the address bar and tap the bookmark when it appears.
4. If Safari asks whether to allow pasting, allow it. If it refuses, the helper shows a box —
   paste into that instead.

## What to report back

The helper prints its own report. Worth writing down:

- **How many of N fields it filled**, and any it says it **COULD NOT FIND**. A form filled
  12 of 15 looks exactly like one filled 15 of 15, which is why it counts out loud.
- Whether the values **stuck after tapping into another field**. This is the one that catches a
  framework input that took the text visually and kept its old value underneath. If a box
  reverts, say so — that is a real result, not a fluke.
- Whether anything **refused to run at all**. A page whose Content-Security-Policy blocks
  `javascript:` URLs will simply do nothing when you tap the bookmark. That is also a real
  result and it closes the route.

Then, if it filled: **save it, close it, reopen the saved Custom Food, and compare every field
against the list in the app.** That is B2, and it is what the gate has been waiting for since
2026-08-14.

## Testing it without Cronometer

`helper/fixture-form.html` is a stand-in for the Custom Food screen — a mock, not a copy, since
the real form is behind a login. It deliberately mixes the three form shapes the helper knows
how to read, and deliberately **omits Trans-Fats** so the missing-field report has something to
report. Serve the repo and open it to watch the helper work before trusting it with a real
diary.

What it cannot tell you is whether Cronometer's own DOM looks anything like it. Only the run
above answers that.
