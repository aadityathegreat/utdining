// Per-hall nutrition coverage. Pure counting, no I/O, so the scraper's one piece of
// arithmetic can be tested without hitting UT's servers.

/**
 * How many of a hall's dishes UT published nutrition for.
 *
 * Counted per hall rather than per run because the run-level counter answers the wrong
 * question: a hall that publishes menus with no labels looks thin in the app, and without
 * this the app has no way to tell that apart from a hall with a short menu.
 *
 * Three outcomes, deliberately not two:
 *
 * - in `items` — UT published a label and it parsed.
 * - in `noNutrition` — UT's label page says there is no nutrition information for this dish.
 * - neither — the label could not be fetched or parsed. That is our failure, not UT's, so it
 *   is left out of both counts rather than reported as "UT publishes nothing". It shows up
 *   as the difference between `dishes` and the two counts, and the app says so separately.
 *
 * `dishIds` is the set of DISTINCT dishes this hall serves anywhere in the scraped window.
 * The scraper's label fetch is deduplicated across halls — the same recipe number is the
 * same dish everywhere — so this cannot be derived from the fetch loop and has to be
 * collected per hall.
 */
export function hallCoverage(dishIds, items, noNutrition) {
  let dishesWithNutrition = 0
  let dishesWithoutNutrition = 0
  let dishes = 0

  for (const id of dishIds ?? []) {
    dishes++
    if (items?.[id]) dishesWithNutrition++
    else if (noNutrition?.has(id)) dishesWithoutNutrition++
  }

  return { dishes, dishesWithNutrition, dishesWithoutNutrition }
}
