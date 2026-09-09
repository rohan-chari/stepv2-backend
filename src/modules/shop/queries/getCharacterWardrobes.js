const cosmetics = require("../../cosmetics");
function buildGetCharacters(dependencies = {}) {
  return (opts) =>
    (dependencies.getCharacters || cosmetics.getCharacters)(
      opts,
      dependencies.wardrobePrisma,
    );
}
function buildGetCharacterWardrobe(dependencies = {}) {
  return (opts) =>
    (dependencies.getCharacterWardrobe || cosmetics.getCharacterWardrobe)(
      opts,
      dependencies.wardrobePrisma,
    );
}
module.exports = {
  buildGetCharacters,
  buildGetCharacterWardrobe,
  getCharacters: buildGetCharacters(),
  getCharacterWardrobe: buildGetCharacterWardrobe(),
};
