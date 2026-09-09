const cosmetics = require("../../cosmetics");
function buildSaveCharacterOutfit(dependencies = {}) {
  return (opts) =>
    (dependencies.saveCharacterOutfit || cosmetics.saveCharacterOutfit)(opts);
}
function buildActivateCharacter(dependencies = {}) {
  return (opts) =>
    (dependencies.activateCharacter || cosmetics.activateCharacter)(opts);
}
module.exports = {
  buildSaveCharacterOutfit,
  buildActivateCharacter,
  saveCharacterOutfit: buildSaveCharacterOutfit(),
  activateCharacter: buildActivateCharacter(),
};
