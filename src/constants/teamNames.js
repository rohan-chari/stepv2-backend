// Team-race name pool (TR-103). A curated set of playful adjective+animal team
// names matching the app's tone (see the random-username generator in
// ensureAppleUser.js). At creation the server auto-generates TWO DISTINCT names
// from this pool; the creator may override either (validated to <= 24 chars and
// run through race-name sanitization). Every pool name is itself <= 24 chars so
// a generated name is always a legal override.
//
// Kept as a flat curated list (not adjective x animal combinatorics) so the
// names read naturally ("Swift Capys" not "Zesty Wombats" awkwardness) and the
// >= 50 count is explicit and reviewable.
const TEAM_NAME_POOL = [
  "Swift Capys",
  "Turbo Beavers",
  "Mighty Otters",
  "Zippy Corgis",
  "Bouncy Wombats",
  "Sunny Gazelles",
  "Breezy Penguins",
  "Nimble Foxes",
  "Plucky Ibex",
  "Dashing Pumas",
  "Cosmic Yetis",
  "Snappy Ferrets",
  "Merry Marmots",
  "Spry Lemurs",
  "Rapid Racoons",
  "Lively Llamas",
  "Chipper Chipmunks",
  "Peppy Pandas",
  "Zesty Zebras",
  "Brisk Badgers",
  "Jolly Jackrabbits",
  "Feisty Ferns",
  "Gutsy Gophers",
  "Hasty Hedgehogs",
  "Wily Walruses",
  "Perky Platypus",
  "Loyal Lynxes",
  "Frisky Frogs",
  "Gallant Geese",
  "Rowdy Raccoons",
  "Sly Salamanders",
  "Bold Bison",
  "Cheeky Cheetahs",
  "Daring Dingoes",
  "Eager Elk",
  "Fleet Falcons",
  "Groovy Gorillas",
  "Happy Hippos",
  "Jazzy Jaguars",
  "Keen Kangaroos",
  "Lucky Lobsters",
  "Nifty Newts",
  "Perky Puffins",
  "Quick Quokkas",
  "Rugged Rhinos",
  "Sturdy Storks",
  "Trusty Turtles",
  "Valiant Voles",
  "Witty Weasels",
  "Zany Zebus",
  "Ace Antelopes",
  "Bubbly Bunnies",
  "Crafty Crabs",
  "Dapper Ducks",
  "Epic Emus",
];

// Return two case-insensitively DISTINCT names from the pool. `rng` is an
// injectable [0,1) generator (defaults to Math.random) for deterministic tests.
function generateTeamNamePair(rng = Math.random) {
  const pick = () => TEAM_NAME_POOL[Math.floor(rng() * TEAM_NAME_POOL.length)];
  const first = pick();
  let second = pick();
  // Nudge deterministically to the next index until it differs — guarantees two
  // distinct names even when the rng repeats.
  let guard = 0;
  while (
    second.toLowerCase() === first.toLowerCase() &&
    guard < TEAM_NAME_POOL.length
  ) {
    const idx =
      (TEAM_NAME_POOL.indexOf(second) + 1) % TEAM_NAME_POOL.length;
    second = TEAM_NAME_POOL[idx];
    guard += 1;
  }
  return [first, second];
}

module.exports = { TEAM_NAME_POOL, generateTeamNamePair };
