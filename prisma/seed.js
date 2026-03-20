require("dotenv").config();
const { prisma } = require("../src/db");

const challenges = [
  { title: "Sole Survivor", description: "Only one sole survives. Most steps wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
];

const stakes = [
  { name: "Coffee Run", description: "Loser makes a coffee run for the winner", category: "food", relationshipTags: ["partner", "friend", "family", "coworker"], format: "IN_PERSON" },
  { name: "Plan a Date Night", description: "Loser plans and pays for a date night", category: "experience", relationshipTags: ["partner"], format: "IN_PERSON" },
  { name: "Cook Dinner", description: "Loser cooks the winner's favorite meal", category: "food", relationshipTags: ["partner", "family", "sibling"], format: "IN_PERSON" },
  { name: "Lunch Treat", description: "Loser buys the winner lunch", category: "food", relationshipTags: ["friend", "coworker"], format: "IN_PERSON" },
  { name: "Desk Cleanup", description: "Loser tidies the winner's desk for a week", category: "act_of_service", relationshipTags: ["coworker"], format: "IN_PERSON" },
  { name: "Presentation Duty", description: "Loser presents at the next team standup", category: "act_of_service", relationshipTags: ["coworker"], format: "IN_PERSON" },
  { name: "Movie Pick", description: "Winner picks the next movie night film", category: "experience", relationshipTags: ["partner", "friend", "family", "sibling"], format: "IN_PERSON" },
  { name: "Car Wash", description: "Loser washes the winner's car", category: "act_of_service", relationshipTags: ["friend", "family", "sibling", "parent"], format: "IN_PERSON" },
  { name: "Spotify Playlist", description: "Loser curates a custom playlist for the winner", category: "digital", relationshipTags: ["friend", "partner", "sibling"], format: "REMOTE" },
  { name: "Social Media Shoutout", description: "Loser posts a shoutout praising the winner", category: "digital", relationshipTags: ["friend", "sibling", "coworker"], format: "REMOTE" },
  { name: "Lawn Mowing", description: "Loser mows the winner's lawn", category: "act_of_service", relationshipTags: ["family", "sibling", "parent"], format: "IN_PERSON" },
  { name: "Breakfast in Bed", description: "Loser serves the winner breakfast in bed", category: "food", relationshipTags: ["partner", "parent"], format: "IN_PERSON" },
  { name: "Arcade Showdown", description: "Loser pays for an arcade session", category: "experience", relationshipTags: ["friend", "sibling"], format: "IN_PERSON" },
  { name: "Ice Cream Run", description: "Loser treats the winner to ice cream", category: "food", relationshipTags: ["friend", "family", "sibling", "parent"], format: "IN_PERSON" },
  { name: "Chore Swap", description: "Loser takes over one of the winner's chores for a week", category: "act_of_service", relationshipTags: ["partner", "family", "sibling", "parent"], format: "IN_PERSON" },
  { name: "Game Night Host", description: "Loser hosts and organizes the next game night", category: "experience", relationshipTags: ["friend", "coworker"], format: "IN_PERSON" },
  { name: "Dog Walking Duty", description: "Loser walks the winner's dog for a week", category: "act_of_service", relationshipTags: ["partner", "family", "sibling"], format: "IN_PERSON" },
  { name: "Venmo $5", description: "Loser sends the winner $5", category: "digital", relationshipTags: ["friend", "coworker", "sibling"], format: "REMOTE" },
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
