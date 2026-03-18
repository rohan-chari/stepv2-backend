require("dotenv").config();
const { prisma } = require("../src/db");

const challenges = [
  { title: "Sole Survivor", description: "Only one sole survives. Most steps wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
];

const stakes = [
  // Food & Drink
  { name: "Buy Ice Cream", description: "Loser treats the winner to ice cream", category: "food", relationshipTags: ["partner", "friend", "family"], format: "IN_PERSON" },
  { name: "Buy Coffee", description: "Loser buys the winner a coffee", category: "food", relationshipTags: ["partner", "friend", "family"], format: "IN_PERSON" },
  { name: "Buy Lunch", description: "Loser buys the winner lunch", category: "food", relationshipTags: ["friend", "family"], format: "IN_PERSON" },
  { name: "Buy Dinner", description: "Loser takes the winner out to dinner", category: "food", relationshipTags: ["partner", "friend"], format: "IN_PERSON" },
  { name: "Cook a Meal", description: "Loser cooks a meal for the winner", category: "food", relationshipTags: ["partner", "family"], format: "IN_PERSON" },
  { name: "Bake a Treat", description: "Loser bakes something for the winner", category: "food", relationshipTags: ["partner", "friend", "family"], format: "IN_PERSON" },
  { name: "Smoothie Run", description: "Loser makes a smoothie run for the winner", category: "food", relationshipTags: ["partner", "friend", "family"], format: "IN_PERSON" },
  { name: "Breakfast in Bed", description: "Loser serves the winner breakfast in bed", category: "food", relationshipTags: ["partner"], format: "IN_PERSON" },

  // Activity
  { name: "Movie Tickets", description: "Loser buys movie tickets for the winner", category: "activity", relationshipTags: ["friend", "partner"], format: "IN_PERSON" },
  { name: "Mini Golf", description: "Loser pays for a round of mini golf", category: "activity", relationshipTags: ["friend", "family", "partner"], format: "IN_PERSON" },
  { name: "Bowling Night", description: "Loser covers a bowling outing", category: "activity", relationshipTags: ["friend", "family"], format: "IN_PERSON" },
  { name: "Arcade Trip", description: "Loser funds an arcade trip", category: "activity", relationshipTags: ["friend", "family"], format: "IN_PERSON" },

  // Experience
  { name: "Plan a Date Night", description: "Loser plans and pays for a date night", category: "experience", relationshipTags: ["partner"], format: "IN_PERSON" },
  { name: "Plan a Day Trip", description: "Loser plans a day trip for both", category: "experience", relationshipTags: ["partner", "friend"], format: "IN_PERSON" },
  { name: "Spa Day", description: "Loser books a spa treatment for the winner", category: "experience", relationshipTags: ["partner"], format: "IN_PERSON" },

  // Act of Service
  { name: "Do Their Chores", description: "Loser does the winner's chores for a day", category: "act_of_service", relationshipTags: ["partner", "family"], format: "IN_PERSON" },
  { name: "Wash Their Car", description: "Loser washes the winner's car", category: "act_of_service", relationshipTags: ["partner", "friend", "family"], format: "IN_PERSON" },
  { name: "Give a Massage", description: "Loser gives the winner a massage", category: "act_of_service", relationshipTags: ["partner"], format: "IN_PERSON" },
  { name: "Carry Their Bag", description: "Loser carries the winner's bag for a day", category: "act_of_service", relationshipTags: ["friend"], format: "IN_PERSON" },
  { name: "Make the Bed for a Week", description: "Loser makes the bed every morning for a week", category: "act_of_service", relationshipTags: ["partner", "family"], format: "IN_PERSON" },

  // Digital / Virtual
  { name: "DoorDash Gift Card", description: "Loser sends a DoorDash gift card", category: "digital", relationshipTags: ["friend", "family"], format: "VIRTUAL" },
  { name: "Venmo a Treat", description: "Loser Venmos the winner $10 for a treat", category: "digital", relationshipTags: ["friend"], format: "VIRTUAL" },
  { name: "Pick Their Phone Wallpaper", description: "Winner picks the loser's phone wallpaper for a week", category: "digital", relationshipTags: ["friend", "partner"], format: "VIRTUAL" },
  { name: "Social Media Shoutout", description: "Loser posts a shoutout praising the winner", category: "digital", relationshipTags: ["friend"], format: "VIRTUAL" },
  { name: "Spotify Playlist", description: "Loser creates a custom playlist for the winner", category: "digital", relationshipTags: ["partner", "friend"], format: "VIRTUAL" },

  // Fun / Silly
  { name: "Wear a Silly Hat", description: "Loser wears a silly hat for a day", category: "activity", relationshipTags: ["friend", "family"], format: "IN_PERSON" },
  { name: "Bad Accent Day", description: "Loser speaks in a bad accent for an hour", category: "activity", relationshipTags: ["friend", "family", "partner"], format: "EITHER" },
  { name: "Winner's Choice", description: "Winner picks any reasonable dare for the loser", category: "activity", relationshipTags: ["friend", "partner", "family"], format: "EITHER" },
];

async function seed() {
  const activeTitles = new Set(challenges.map((c) => c.title));

  // Deactivate challenges no longer in the seed
  console.log("Deactivating removed challenges...");
  const deactivated = await prisma.challenge.updateMany({
    where: { title: { notIn: [...activeTitles] }, active: true },
    data: { active: false },
  });
  console.log(`Deactivated ${deactivated.count} old challenges`);

  // Re-activate any that were previously deactivated but are back in the seed
  await prisma.challenge.updateMany({
    where: { title: { in: [...activeTitles] }, active: false },
    data: { active: true },
  });

  console.log("Seeding challenges...");
  let created = 0;
  for (const c of challenges) {
    const existing = await prisma.challenge.findFirst({
      where: { title: c.title },
    });
    if (!existing) {
      await prisma.challenge.create({ data: c });
      created++;
    }
  }
  console.log(`Created ${created} challenges (${challenges.length - created} already existed)`);

  console.log("Seeding stakes...");
  let stakesCreated = 0;
  for (const s of stakes) {
    const existing = await prisma.stake.findFirst({
      where: { name: s.name },
    });
    if (!existing) {
      await prisma.stake.create({ data: s });
      stakesCreated++;
    }
  }
  console.log(`Created ${stakesCreated} stakes (${stakes.length - stakesCreated} already existed)`);

  console.log("Seed complete!");
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
