# utdining

What to eat at UT dining, sized to what Cronometer says you have left for the day.

A static web app plus a scheduled scraper. No server, no database, no accounts, no cost.
Everything personal stays in the phone's `localStorage`; the Cronometer CSV is read in the
browser and never uploaded.

## How it fits together

```
scraper/scrape.mjs   runs daily on GitHub Actions, writes data/menu.json
data/menu.json       one file, whole week, every hall
index.html + app.js  the phone app — filters, scores and portions entirely client-side
```

`data/labels.json` is a cache keyed by FoodPro's recipe id. Nutrition per recipe is stable,
so the first run fetches a few hundred labels and every run after fetches only new dishes.

## Running it

```bash
node --test 'test/*.test.mjs'    # 210 tests, all against real committed FoodPro pages
node scraper/scrape.mjs          # refresh data/menu.json
python3 -m http.server 8777      # then open http://localhost:8777
```

## Deploying (one-time)

1. Create an empty GitHub repo and push this directory to it.
2. Settings → Pages → Source: *Deploy from a branch*, branch `main`, folder `/ (root)`.
3. Settings → Actions → General → Workflow permissions: *Read and write*, so the daily
   scrape can commit `data/`.
4. Open the Pages URL on the phone → Share → Add to Home Screen.
5. In **Prefs**, set calorie / protein / carb / fat targets. They ship at zero because this
   repo is public and those figures are personal; a zero target means "don't score it". The
   micronutrient defaults are published reference values and need no editing. Everything you
   enter stays in that phone's `localStorage`.

The workflow also runs on demand from the Actions tab.

## The two things this app refuses to fake

**Micronutrients.** UT publishes exactly four per dish — vitamin D, calcium, iron, potassium
— plus sodium, fibre, sugars and cholesterol. It does not publish zinc, B12, magnesium or
folate. Those are read from the Cronometer export and reported as *"you are short, and the
dining hall data cannot be searched for this"*, never as a menu recommendation.

**Grams.** FoodPro gives serving sizes as `1 each`, `4 oz`, `1 ozL`, `1/12 pizza`. Ounces
convert to grams. `ozL` is a *ladle* — a volume scoop — and never becomes grams. Counted
items are shown as pieces or slices. A gram figure appears only where one is genuinely
derivable, and there is a test asserting it.

This is also why the tray photo (below) answers in servings and not in grams.

## The tray photo

Optional, off by default, and the only thing in this app that makes a network call anywhere
but this repo. One photo of a tray is matched against **what that hall is serving today** —
about 140 dishes with station names, a closed list, not the open world — and each dish it
recognises appears as a row you confirm. Confirming logs it exactly as tapping the dish by
hand would: the nutrition comes from `menu.json`, never from the photo.

It answers in **servings, not grams**, and that is not a limitation to be engineered away.
A single camera cannot measure mass — monocular depth carries no metric scale without a
reference object in frame — so a gram figure from a photo would be a confident invention, and
this app already refuses two of those. The model returns one of `{0.5, 1, 1.5, 2, 3}` servings
of a published portion, which is a five-way classification rather than a measurement, and the
row lands in the same stepper as everything else. Expect it to be reliable about *which* dish
and roughly right about *how much*.

- **The key is yours.** Paste an Anthropic API key under *Photo key* in Prefs. It lives in its
  own `localStorage` entry — never in the profile, so *Copy my settings* cannot leak it, and
  never in this repo, because a public repo cannot hold a secret. No key, no camera.
- **The model never names a dish freely.** It answers with a line number from the list this app
  built, and `readVisionPicks` rebuilds every row from `menu.json`. A `grams` or `kcal` field in
  the response has nowhere to land even if the schema is one day loosened.
- **Cost is shown per shot** (about 2¢ on `claude-opus-5`), because it is your bill.
- `connect-src` in the CSP names `api.anthropic.com` and nothing else.

## Gotchas worth knowing before editing

- Diet icons (`Beef`, `Pork`, `Vegan`, `Halal`) come from the **menu page images**, not the
  label's allergen text, which is empty on about half of all dishes. Restriction filtering
  reads `icons`. Merging the two fields would silently break the no-beef filter.
- An unpublished nutrient is `null`, not `0`. Reading it as `0` makes a dish look cleaner
  than it is.
- Cronometer reports vitamin D in **IU**; UT reports **mcg**. The parser divides by 40.
- Some dishes return "Nutritional Information is not available" — expected, skipped, and
  deliberately not counted toward the scraper's staleness alarm.
- The recommender sizes a plate for **one meal**, dividing what is left of the day by the
  meals still ahead. Without that it serves the entire day's food at lunch.

## Layout

| Path | What it is |
|---|---|
| `scraper/parse.mjs` | pure FoodPro parsers, no I/O |
| `scraper/scrape.mjs` | the scheduled job |
| `scraper/fixtures/` | real captured pages — the golden tests run against these |
| `recommend.mjs` | scoring, portioning, filters. Shared by app and tests |
| `cronometer.mjs` | Daily Nutrition CSV parser |
| `vision.mjs` | the tray photo: candidate list, request, and the whitelist that reads the answer |
| `app.js` | UI only |
| `tools/make-icons.mjs` | one-shot icon generator (no image libraries needed) |
