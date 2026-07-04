-- CHARACTER accessory slot (base body, e.g. the corgi). ADDITIVE ONLY.
--
-- Back-compat: single additive enum value; nothing dropped or renamed.
-- CHARACTER-slot items are never emitted into the accessories /
-- equippedAccessories arrays that old app binaries render, and are filtered
-- out of the shop catalog unless the client declares `characters` support
-- (X-Client-Features header), so old versions never encounter the unknown
-- slot value — they just keep showing the default capybara.
ALTER TYPE "AccessorySlot" ADD VALUE IF NOT EXISTS 'CHARACTER';
