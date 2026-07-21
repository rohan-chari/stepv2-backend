const Filter = require("bad-words");

const filter = new Filter();

function censor(text) {
  if (!text || typeof text !== "string") return text;
  try {
    return filter.clean(text);
  } catch {
    return text;
  }
}

module.exports = { censor };
