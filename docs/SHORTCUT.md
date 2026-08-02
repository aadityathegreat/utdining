# Getting today's intake in without a password

Cronometer has no public API and accepts no diary import, so nothing can be pushed into
it or pulled out of it programmatically. What it *does* do is write your logged nutrition
to **Apple Health**. From there an iOS Shortcut can read it, and the app can take it off
the clipboard.

No password, no server, nothing leaves the phone.

## Why the clipboard and not a URL

A Shortcut can open `https://…/utdining/#data=…`, but that opens **Safari**, and an
installed home-screen web app has its own `localStorage` separate from Safari's. The data
would land in storage the installed app cannot see. The clipboard is the only route that
reaches the app you actually use.

## Step 1 — check what Cronometer actually writes

Do this before building anything. Cronometer's docs say it exports "13 nutrients" but
never name them, and the list has changed over time.

1. Cronometer → **More** → **Connect Apps & Devices** → **Apple Health** → **Connect Apple
   Health**. Enable every nutrition category under *Allow "Cronometer" to Write*.
2. Health app → profile picture → **Apps and Services** → **Cronometer**. Read the list
   under *Allow Cronometer to Write*. **That list is the ground truth.**
3. Log one distinctive food. Wait a few minutes. Health → **Browse** → **Nutrition** →
   Dietary Energy → *Show All Data*, and confirm a row whose source is Cronometer.

Build the Shortcut for the nutrients you actually saw. Well-attested: energy, protein,
carbohydrates, total fat, fibre, sodium, saturated fat, vitamin D, calcium, zinc, B12.
Unconfirmed and worth checking yourself: iron, potassium, magnesium, folate.

**Added sugars can never work.** HealthKit defines total dietary sugar and has no
added-sugars type at all. It goes in `missing` permanently.

## Step 2 — build the Shortcut

Name it **Cronometer Today**. For each nutrient:

```
Find Health Samples
    Type is <Dietary Energy>
    Start Date is Today
    Source is Cronometer

Get Details of Health Samples → Value

Calculate Statistics → Sum
```

Cronometer writes **one sample per diary entry**, not a daily total, so the Sum is
required — do not look for a single total sample.

Health types map to the app's keys like this:

| App key | Health type |
|---|---|
| `kcal` | Dietary Energy |
| `protein_g` | Dietary Protein |
| `carb_g` | Dietary Carbohydrates |
| `fat_g` | Total Fat |
| `satfat_g` | Saturated Fat |
| `chol_mg` | Dietary Cholesterol |
| `sodium_mg` | Dietary Sodium |
| `fiber_g` | Dietary Fiber |
| `sugar_g` | Dietary Sugar |
| `vitd_mcg` | Dietary Vitamin D |
| `calcium_mg` | Dietary Calcium |
| `iron_mg` | Dietary Iron |
| `potassium_mg` | Dietary Potassium |
| `addedsugar_g` | **none — always list in `missing`** |

Finish with a **Text** action containing this, then **Copy to Clipboard**:

```json
{
  "schema": 1,
  "date": "2026-08-02",
  "generatedAt": "2026-08-02T17:41:00-05:00",
  "nutrients": {
    "kcal": 842.3,
    "protein_g": 51.2,
    "carb_g": 96.4,
    "fat_g": 29.1,
    "fiber_g": 14.8,
    "sodium_mg": 1220
  },
  "missing": ["addedsugar_g", "potassium_mg"]
}
```

Use Shortcuts' *Current Date* formatted as `yyyy-MM-dd` for `date`, and drop the summed
variables into the numbers.

**`missing` is the important field.** Put a nutrient there when Health has no type for it,
when Cronometer is not writing it, or when the query returned no samples at all. The app
stores those as unknown and takes them out of scoring. If you send `0` instead, the app
reads it as "ate none of that today" and hands you a full day's budget for it.

Check the units the sums come back in — Health can report energy in kJ depending on
locale, and micrograms versus milligrams matter for vitamin D.

## Step 3 — use it

1. Run **Cronometer Today**.
2. Open the app → **Fuel** → **Import from Shortcut**.
3. Approve Safari's paste prompt if it appears.

Roughly three taps. A **Time of Day** automation (Shortcuts → Automation → Run
Immediately) at, say, 11:15 and 17:00 refreshes the clipboard in advance and removes step
1 — but it cannot go further than that. A web page can only read the clipboard inside a
real user gesture, by design, so the Import tap always stays.

If the clipboard read is refused, open **Clipboard blocked?** under the import button and
paste there instead.

## What breaks it

- **Cronometer changes its Health export list.** Nothing announces this. The app names
  what came through as missing on every import — read that line occasionally.
- **Permissions get reset** by a reinstall, a restore, or an app update. Cronometer has a
  *Backfill* button on the Apple Health page for repopulating.
- **Sync lag.** No documented guarantee; observed anywhere from instant to several
  minutes. If you log food and immediately run the Shortcut you may get stale numbers,
  which is why the payload carries `generatedAt` and the app shows the time.
- **Edits and deletions may not propagate.** There are reports of stale samples surviving
  a recipe edit and inflating totals. If the Shortcut's calorie sum disagrees with what
  Cronometer shows on screen, trust Cronometer and type the numbers in manually.
- **Another nutrition app writing to Health** would be double-counted. The `Source is
  Cronometer` filter prevents that — keep it, and check the exact source name on one of
  your own samples, since it can appear as "Cronometer" or "Cronometer Inc."
