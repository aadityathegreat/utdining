# utdining — visual system

The design record. Data model, the recommender's weights, the quarantine rules and every
honesty rule in `../Claude OS/projects/dining/CONTEXT.md` are untouched by anything here —
this file is presentation only.

Method follows `library/design/SKILL.md` in the Claude OS (core + `design/detect` +
`design/palettes` + `design/web`). The sibling app LiftLog went through the same pass; its
record is `~/dev/liftlog/DESIGN.md`, Phase 6.

---

# Phase 1 — "Panel" visual system (specced 2026-08-13)

## What the app is

Someone is standing in the J2 servery holding a tray, on a phone, deciding what to put on it.
The app's whole job is one sentence: **take this much of this, from that station, because you
are short on that.** It is arithmetic against targets, rendered while walking.

Two things follow. The number is the product — not the photo, not the dish name. And it is
read one-handed, in a basement with no signal, in about four seconds.

## Why it changed

Audited against `design/detect` before the rewrite. The decisive tells, all confirmed in the
running app:

- **The neutral ramp is tinted the wrong way.** `--bg #14141a`, `--card #1e1e26`,
  `--line #2e2e3a` all sit at hue ≈ 250 (blue-violet) while the accent sits at hue ≈ 22. The
  neutrals lean *away* from the brand hue — the stock slate-plus-one-warm-accent pairing.
- **The app never shows its brand colour on the device it runs on.** `#bf5700` is declared only
  inside `@media (prefers-color-scheme: light)`; the installed PWA presents dark and uses
  `#ff7a33`, a generic orange. UT burnt orange survives only in `icon.svg`.
- **One hue means seven unrelated things, two of which contradict.** `--accent` fills the
  primary button, the on-state of three tab rows, the portion badge, the rating on-state and
  the log strip — and is *also* `.status.bad`. "Ate it" and "Import failed" are the same colour.
- **Eight containers share one recipe** — `--card` fill, 1px `--line`, `--radius: 14px`. `.pick`,
  `.note`, `.total`, `.logstrip`, `.chip`, `dialog`, `.drop`, `a.download`. Every screen is a
  stack of identical rectangles at 10px intervals.
- **Five type sizes spanning 13→18px; every adjacent ratio is under 1.13.** The largest glyph in
  the entire app is 18px. Headings are *quieter* than body text — `h2` is 15px dim uppercase
  against 16px full-ink body — so hierarchy is inverted, not just flat.
- **The recommender ranks; the UI does not.** `recommend()` returns picks best-first, each scored
  against what the previous left unmet. Nothing in the DOM expresses that order — no ordinal, no
  size step, no fill difference between pick 1 and pick 4.
- **Nine unicode glyphs stand in for icons** — `✕ ♥ ⚠ ✓ ×` in buttons and chip labels, `→` inside
  prose in two places. There is no icon system at all.
- **Five severities render as one `.note` box** — targets-unset, a medical disclaimer, the protein
  shortfall, quarantined dishes, and unservable micronutrients. Same fill, same border, same 14px.
- **Nothing goes full-bleed.** Every element sits in the same 16px gutter. Seven padding values
  (10, 11, 12, 14, 18, 22) on no scale, and two gap values for the whole app.
- **The destructive section is the quietest thing on its screen.** `.danger-h` sets exactly the
  colour `h2` already had, and Reset is a ghost button.
- **Three segmented rows plus a `<select>` stack in the header** before any content, two styled
  identically to each other. The tab bar is at the top, is three text labels, and for a
  home-screen iPhone app should not be either.

Two things the audit found that are *already right* and are preserved: there are **no shadows
anywhere** in the stylesheet, and there is **no motion at all**. The problem was never that the
app was over-decorated — it is that everything sits at one elevation, one weight, one density,
so nothing outranks anything.

## The concept

**The Nutrition Facts panel is the layout grammar.**

Not as decoration — as the actual structural language. The FDA panel is this subject's own
artifact: heavy rules, hairlines, condensed uppercase labels, tabular figures locked to a right
edge, edge-to-edge rows with nothing floating. It is the one visual system that already means
"verified per-serving figures", which is exactly what this app is claiming every time it puts a
number on screen. The app already draws a real one — `label.mjs` renders an Updated American
panel for Cronometer — so the language is in the codebase before it is in the UI.

Everything the old UI did, the panel does not: rounded cards, drop shadows, equal-weight
stacks, gaps as separators, a colored pill for emphasis.

**The one real risk:** dish names set in condensed uppercase, like the card slotted into a
steam-table pan, and the whole app run as a data panel rather than a feed of cards. It could
read cold for a food app. Taken deliberately — this app is not selling food, it is reporting
figures about food, and it should look like it means them. If it reads as cold in use, the fix
is warmth in the *color field*, not a retreat to cards.

## Palette

Source: **rung 1 of the sourcing ladder — Aadi supplied it.** "Obviously in UT colors."
The University of Texas at Austin brand palette is therefore binding: chosen, not improved,
not mixed with a Sanzo Wada row.

> Role map, exact hex values and the contrast audit: see "Palette contract" below.

Burnt orange is a **field**, not a text color, and not a pill. One field per screen carries the
primary answer; everything else is ink on ground with hairlines. This is the 60-30-10 rule and
it is the single most likely thing to drift during implementation.

Neutrals are **warm**, replacing the stock blue-violet grays (`#14141a`, `#1e1e26`, `#2e2e3a`,
which leaned away from the accent — `detect` tell 3). They are not tints of burnt orange: UT
forbids those outright, so the warmth comes from UT's own tertiary family instead. See the
brand rules in the palette contract.

## Type

Body/UI: **Avenir Next**. Display: **Avenir Next Condensed**, uppercase, tight, for dish names
and section labels.

Both ship with iOS and macOS. That is the deciding constraint, not a shortcut: this is an
offline-first PWA whose stated failure case is opening in a basement with no signal, so a
webfont that has to be fetched is a worse product, and a webfont that has been cached is one
more thing the service worker can serve stale. `detect` tell 7 bans retreating to a system
stack as a *default*; choosing a specific pair of faces present on the target device, for a
stated reason, is a decision. Fallbacks: Helvetica Neue Condensed, then Arial Narrow.

**Why not UT's own faces.** UT specifies **Benton Sans** for publications and **GT Sectra** for
the academic wordmark. Both are commercially licensed — UT holds limited desktop licenses for
staff, and web licenses must be bought separately. This is a personal app on a public static
site, so shipping either would be a licensing violation, and the free stand-ins usually named
for them (Libre Franklin, Charis SIL) are webfonts that reintroduce the offline problem without
being UT's typography in any meaningful sense. The palette carries the UT identity; the type
carries the panel.

UT's type rules — no all-caps blocks of three or more lines, no artificially condensing a face
— govern Benton Sans in University publications and do not bind here. Both are respected
anyway: Avenir Next Condensed is a genuine condensed cut rather than a horizontally squeezed
regular, and the uppercase is confined to one- and two-line dish names and short labels.

Roles:
- `.display` — Avenir Next Condensed, uppercase, tight tracking. Dish names, the hero figure.
- `.eyebrow` — 10.5px, 0.2em tracking, uppercase. Station names, section labels.
- `.num` — `tabular-nums`, always. Every figure in the app, so columns line up and a changing
  number does not reflow its row.
- Body — Avenir Next, sentence case, for the disclosure sentences, which are prose and must
  stay readable.

## Layout grammar

**There is deliberately no generic card.** The current `.pick` is one container reused for
every dish, at one density, with one radius — the tell that made every screen a flat stack.
Replacing it with a differently-styled generic card would change nothing.

Primitives:

- **`Field`** — the one loud element per screen. Full-bleed burnt-orange ground carrying the
  primary answer: on Now, the first pick and its portion. Never more than one per screen.
- **`Item`** — a dish as a panel line: station eyebrow, name in condensed caps, portion figure
  locked right, reason beneath, actions on a hairline below. Full-bleed, hairline-separated,
  no box.
- **`Ledger`** — full-bleed rows of label-left / figure-right split by hairlines. Replaces the
  Fuel tables and the "left today" grid. This is the panel's own row, used literally.
- **`Rule`** — the heavy separator (the panel's thick bar) between major regions. Structural,
  not decorative: a rule means "different kind of thing below".
- **`Note`** — the disclosure block. Its own quiet ground, body type, never a colored border.
  Every honesty rule in the room renders through this and none of them may be dropped.
- **`Chip`** — the only pill-shaped thing left, for filters and multipliers.

Rules: no shadows, no radius above 2px except chips, no gaps as separators — surfaces run edge
to edge and hairlines do the dividing. Density varies by screen: Now is loose and glanceable,
Fuel is dense and tabular.

## Motion

Frequency gate first (`design/motion`). This app is opened for four seconds while walking; the
budget is near zero. Allowed: the log-strip total counting up, and the `Ate it` confirmation.
Nothing else animates. Resting states must be correct on first paint. Never animate layout
properties. `prefers-reduced-motion` respected.

## Preserved — a visual refresh is not permission to rewrite the product

Per `design/web`'s redesign gate, this is an **approved overhaul of appearance only**. These do
not change: the three tab names (Now / Fuel / Prefs), the meal and hall pickers, every form
field name and order in Prefs, the Cronometer sheet's field order, and every disclosure string
whose job is honesty — unpublished nutrients, quarantined dishes and their exact UT figures,
the portion wording that never invents grams, the protein-shortfall note, and the
targets-not-set banner.

## Palette contract

Palette source: **user-supplied — University of Texas at Austin brand palette**, verified
against UT's own brand center (`umac.utexas.edu/brand-center/visual-identity/colors/`;
`brand.utexas.edu` and `identity.utexas.edu` now redirect there). Chosen, therefore binding.

This app is a personal project. It uses UT's colors as homage and does not claim to be, or
imply, an official University product.

**Raw values.** Primary: Burnt Orange `#bf5700` (PMS 159) and White. The widely-circulated
`#cc5500` is the generic web "burnt orange" and is **not** UT's — do not use it.
Supportive: `#333f48`, `#f8971f`, `#d6d2c4`, `#9cadb7`. Accent: `#005f86`, `#00a9b7`,
`#579d42`, `#a6cd57`, `#ffd600`. UT publishes these as unnamed swatches; any English names for
them in circulation are third-party inventions, so this file does not use them.

Warm neutrals below (`#f1f0eb`, `#f9f8f5`, `#d5d2c8`, `#6b6657`) come from UT's own published
web tokens rather than being invented.

### Three brand rules that constrain the design

1. **"Never use tints of burnt orange."** UT states this outright. So the standard fix for
   `detect` tell 3 — tint the neutrals toward the brand hue — is not available here. UT's own
   web team solves it the legitimate way and this design follows them: warm neutrals from the
   tertiary family, and *shades* of burnt orange (darker, hue intact) where an orange text
   color is genuinely needed. `#9f4700` is the safe one.
2. **"Avoid using shades of red or purple, especially in combination with burnt orange."**
   This removes the obvious color for the blocked/suspect and shortfall states. They are
   therefore carried by **typography and a heavy rule, not by color** — which suits the panel
   grammar better anyway. No red anywhere in this app.
3. **The secondary orange `#f8971f` may never be more prominent than burnt orange.** It appears
   only as small-text orange in dark mode, where burnt orange cannot pass contrast; the filled
   field stays `#bf5700` in both themes.

### Contrast audit — computed, not assumed

Burnt orange is 4.59:1 on white and 4.58:1 on black. It clears AA normal text on both by under
2%, which means any opacity, rounding or antialiasing drops it below. **It is a field color and
a large-figure color, never body text.** That constraint is what produced the "orange is a
field, not a pill" rule above; the numbers arrived at the same place independently.

Light theme is the primary target: the servery is brightly lit, and UT's palette is built for
light grounds — burnt orange fails as text on UT's own dark gray (2.35:1).

| Pair | Ratio | AA normal |
|---|---|---|
| ink `#333f48` on ground `#f1f0eb` | 9.46 | pass |
| mute `#5c656d` on ground | 5.20 | pass |
| faint `#6b6657` on ground | 5.02 | pass |
| orange text `#9f4700` on ground | 5.45 | pass |
| white on field `#bf5700` | 4.59 | pass |
| **dark** ink `#f1f0eb` on ground `#1e262b` | 13.46 | pass |
| **dark** mute `#9cadb7` on ground | 6.64 | pass |
| **dark** orange text `#f8971f` on ground | 6.90 | pass |
| ~~dark: burnt `#bf5700` as text on dark ground~~ | 3.35 | **fail — do not** |
| ~~green `#579d42` as text on light ground~~ | 2.92 | **fail — field/dot only** |

**One documented exception to `detect` tell 2 (no pure white).** Text on the burnt-orange field
is `#ffffff`, not a warm off-white: warm white measures 4.41:1 and fails. White is also UT's
own second primary color, so this is the palette's choice rather than a retreat to a default.
Pure white is used *nowhere else*.

UT requires WCAG 2.1 AA on university sites; the brand center publishes no contrast guidance of
its own, so the audit above is the governing document for this app.

| Token | Light | Dark | Role |
|---|---|---|---|
| `--ground` | `#f1f0eb` | `#1e262b` | page background — warm paper / UT dark |
| `--surface` | `#f9f8f5` | `#262f35` | the raised region inside a panel |
| `--sunken` | `#e2dfd5` | `#171d21` | recessed: inputs, wells |
| `--rule` | `#333f48` | `#f1f0eb` | the heavy structural bar |
| `--hairline` | `#d5d2c8` | `#3a444b` | the row separator |
| `--ink` | `#333f48` | `#f1f0eb` | primary text |
| `--mute` | `#5c656d` | `#9cadb7` | secondary text, the reason line |
| `--faint` | `#6b6657` | `#7d8890` | eyebrow labels, disabled |
| `--field` | `#bf5700` | `#bf5700` | **burnt orange, filled region only** — one per screen |
| `--on-field` | `#ffffff` | `#ffffff` | text on that field (the documented exception) |
| `--accent-text` | `#9f4700` | `#f8971f` | the rare orange *word*; a shade in light, UT's secondary in dark |
| `--good` | `#579d42` | `#a6cd57` | met-target dot or fill — **never text on light** |

There is no `--flag` token. Blocked dishes, the protein shortfall and every other disclosure
state are carried by the `Note` primitive — heavy rule, eyebrow label, body copy — because UT's
palette forbids red and because a colored border on a callout is `design/web` tell 1 anyway.

Dark mode re-declares the tokens only. Components never carry a dark-mode variant — the same
rule LiftLog landed on, and the reason its component layer stayed readable.

Colors are authored in **OKLCH** (`design/web`), so lightness can be moved for contrast without
dragging the hue, and chroma can be pulled back as lightness approaches either end
(`detect` 5). Every color in the stylesheet must be one of these tokens; a hex literal outside
the token block is a bug (`detect` 6, web tell 14).

## Type scale

Fixed `rem` scale, not `clamp()` — this is product UI, not a marketing page (`design/web`).
Ratio held at or above 1.25 between adjacent steps so hierarchy is real (`detect` 10).

| Step | Size | Use |
|---|---|---|
| `--t-hero` | 2.5rem | the portion figure on the field — the thing you act on |
| `--t-title` | 1.5rem | dish name, condensed caps |
| `--t-body` | 1rem | disclosure sentences, prose |
| `--t-small` | 0.8125rem | the reason line |
| `--t-eyebrow` | 0.656rem | station and section labels, 0.2em tracking |

Light-on-dark gets +0.05 line-height over the light-mode value (`design/web`).

## Space scale

4pt scale, semantic names, `gap` never sibling margins:
`--s-1: 4px`, `--s-2: 8px`, `--s-3: 12px`, `--s-4: 16px`, `--s-6: 24px`, `--s-8: 32px`,
`--s-12: 48px`.

Radius: `--r-hairline: 2px` for the few things that need it, `--r-pill: 999px` for chips.
There is no `--radius: 14px` any more; that one value applied everywhere is what made every
container the same container.

Touch targets stay at or above 44px (`design/web` tell 13) — this is used one-handed while
walking, so that is a floor, not a guideline.

## Hierarchy — the ranked list is the whole opportunity

`recommend()` already returns picks best-first, each scored against what the earlier ones left
unmet. The old UI threw that away. The new one spends it:

- **Pick 1 is the `Field`** — full-bleed burnt orange, the portion figure at `--t-hero`. It is
  the answer to "what do I get right now".
- **Picks 2..n are `Item`s** — hairline-separated panel lines, quieter, in order.

That is the one loud element per screen, and it comes from the data rather than from a
decorative choice.

## The five note severities

The old `.note` carried five different jobs at one weight. They separate into three, and none
of them uses colour (UT forbids red; `design/web` tell 1 forbids the coloured side-border):

| Kind | Rendering | Cases |
|---|---|---|
| **Blocking** | heavy `--rule` above, eyebrow label, body copy | quarantined dishes; the Cronometer refusal |
| **Shortfall** | hairline above, eyebrow label | protein shortfall; targets unset; unservable micros |
| **Aside** | body copy, `--mute`, no rule | the pre-workout rule-of-thumb disclaimer |

## Icons

One family, drawn in the repo: 24px grid, 1.8 stroke, square caps, mitre joins. Replaces all
nine unicode stand-ins. No emoji anywhere. The arrows inside prose (`Profile → Your Account`,
`Cronometer → Add Food`) become plain words — they were never icons, just punctuation pretending.

## Screen inventory and the disclosure floor

The audit produced a complete element inventory across Now / Fuel / Prefs and both dialogs.
Rather than restate it, the rule it produced:

**Every element below is load-bearing disclosure and must survive the redesign intact.** Losing
any of them turns an honesty rule into a silent lie, which is the one failure this project has
consistently refused.

- `#fuelline` naming **both** intake sources — they can double-count, and the attribution is
  what makes that visible.
- The portion string (`describeServing`) — grams only for a true weight portion; ladles and
  counts must never be normalized into invented grams.
- `.caveat` per pick — "UT doesn't publish {names} for this — scored without it."
- `.why` per pick — the only way to notice the recommender is wrong.
- The plate summary carrying the **protein budget**, not just the delivered figure.
- The protein-shortfall note, and its deliberate noisiness at breakfast.
- `#blocked` — quarantined dishes quoting UT's **exact** failure message, never a count, each
  with its own override.
- The `⚠` confirm in log search, quoting the reasons before a suspect dish can be logged.
- Health-import status naming the `missing` nutrients.
- `#unservable` — micronutrients Cronometer tracks that UT does not publish per dish.
- `#manual` prefilled from the baseline only, never the merged total.
- The carb-basis hints, and that switching zeroes the target rather than relabelling it.
- The Backup hint about iOS evicting storage and Safari keeping a separate copy.
- In the Cronometer sheet: the "manual entry, not an import" line, the override warning that
  still shows UT's failure messages, the quarantine refusal that renders **no fields at all**,
  and `.cronoblank` — `"UT publishes nothing — leave blank"`, which must never become `0` or an
  em-dash.
- In the rating dialog: the hint distinguishing a named food (global blocklist) from a named
  taste (reweights the scorer), and the 4-second confirmation of which durable rule was written.
