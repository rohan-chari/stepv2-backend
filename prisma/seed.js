require("dotenv").config();
const { prisma } = require("../src/db");

const challenges = [
  // HEAD-TO-HEAD — higher total
  { title: "Beat Your Partner", description: "Whoever takes more steps this week wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "Step Showdown", description: "A classic step-count battle. Most steps wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "Walk It Out", description: "Put your feet where your mouth is. Higher total wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "No Excuses", description: "The person who moves more this week takes the W.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "Step for Step", description: "Match your opponent step for step — or beat them.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "The Grind", description: "Every step counts. Outgrind your opponent this week.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "Total Domination", description: "Stack those steps. Highest total at week's end wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "Pace Race", description: "Keep pace or get left behind. Higher steps wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "March Madness", description: "March your way to victory. Most steps wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "Mileage Matters", description: "Every mile adds up. Highest total wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "The Long Walk", description: "It's a marathon, not a sprint. Most steps wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "Endurance Test", description: "Test your endurance. Who can rack up more steps?", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "Path to Victory", description: "Walk the path to victory. Higher total steps wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "Step It Up", description: "Time to step it up. Most steps this week wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "Trailblazer", description: "Blaze the trail with your steps. Most wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "Stepocalypse", description: "The step-pocalypse is here. Survive with more steps.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "Footprint Frenzy", description: "Leave the biggest footprint. Most steps wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "Walk the Walk", description: "Don't just talk the talk. Higher total wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },

  // HEAD-TO-HEAD — daily majority
  { title: "Day by Day", description: "Win more days than your opponent. Majority of daily comparisons wins.", type: "HEAD_TO_HEAD", resolutionRule: "daily_majority" },
  { title: "Daily Duel", description: "Beat your opponent on more days than they beat you.", type: "HEAD_TO_HEAD", resolutionRule: "daily_majority" },
  { title: "Win the Days", description: "Each day is a battle. Win the most days to win the war.", type: "HEAD_TO_HEAD", resolutionRule: "daily_majority" },
  { title: "Seven Day Siege", description: "Seven days, seven battles. Win the majority.", type: "HEAD_TO_HEAD", resolutionRule: "daily_majority" },
  { title: "Day Streak", description: "Stack winning days. Most daily wins takes it.", type: "HEAD_TO_HEAD", resolutionRule: "daily_majority" },
  { title: "Dawn to Dusk", description: "From dawn to dusk, every day matters. Win more days.", type: "HEAD_TO_HEAD", resolutionRule: "daily_majority" },
  { title: "The Daily Grind", description: "Grind it out every single day. Win the most days.", type: "HEAD_TO_HEAD", resolutionRule: "daily_majority" },
  { title: "Sunrise Showdown", description: "Each sunrise starts a new battle. Win the majority.", type: "HEAD_TO_HEAD", resolutionRule: "daily_majority" },

  // THRESHOLD — first to 50k
  { title: "Race to 50K", description: "First to 50,000 steps wins. If neither makes it, higher total wins.", type: "THRESHOLD", resolutionRule: "first_to_threshold", thresholdValue: 50000 },
  { title: "50K Sprint", description: "Sprint to 50,000 steps before your opponent.", type: "THRESHOLD", resolutionRule: "first_to_threshold", thresholdValue: 50000 },
  { title: "The 50K Challenge", description: "Can you hit 50,000 steps first?", type: "THRESHOLD", resolutionRule: "first_to_threshold", thresholdValue: 50000 },
  { title: "Halfway There", description: "50K steps is the goal. First one there wins.", type: "THRESHOLD", resolutionRule: "first_to_threshold", thresholdValue: 50000 },

  // THRESHOLD — first to 75k
  { title: "Race to 75K", description: "First to 75,000 steps wins. Higher total as fallback.", type: "THRESHOLD", resolutionRule: "first_to_threshold", thresholdValue: 75000 },
  { title: "The 75K Push", description: "Push to 75,000 steps before your opponent does.", type: "THRESHOLD", resolutionRule: "first_to_threshold", thresholdValue: 75000 },
  { title: "75K or Bust", description: "Hit 75K first or go home trying.", type: "THRESHOLD", resolutionRule: "first_to_threshold", thresholdValue: 75000 },

  // THRESHOLD — first to 100k
  { title: "Race to 100K", description: "First to 100,000 steps wins. An epic challenge.", type: "THRESHOLD", resolutionRule: "first_to_threshold", thresholdValue: 100000 },
  { title: "The Century", description: "100,000 steps in one week. First to cross wins.", type: "THRESHOLD", resolutionRule: "first_to_threshold", thresholdValue: 100000 },
  { title: "Six Figures", description: "Hit six figures in steps. First there wins.", type: "THRESHOLD", resolutionRule: "first_to_threshold", thresholdValue: 100000 },
  { title: "100K Club", description: "Join the 100K club first and claim victory.", type: "THRESHOLD", resolutionRule: "first_to_threshold", thresholdValue: 100000 },

  // CREATIVE — highest single day
  { title: "Peak Day", description: "Your best single day decides it. Highest single-day count wins.", type: "CREATIVE", resolutionRule: "highest_single_day" },
  { title: "One Big Day", description: "One massive day is all it takes. Best single day wins.", type: "CREATIVE", resolutionRule: "highest_single_day" },
  { title: "Day of Glory", description: "Make one day legendary. Highest single-day steps wins.", type: "CREATIVE", resolutionRule: "highest_single_day" },
  { title: "Max Effort", description: "Give your maximum effort on one day. Best day wins.", type: "CREATIVE", resolutionRule: "highest_single_day" },
  { title: "Big Day Energy", description: "Channel big day energy. Highest single-day total wins.", type: "CREATIVE", resolutionRule: "highest_single_day" },
  { title: "The Surge", description: "One massive surge is all you need. Best day wins.", type: "CREATIVE", resolutionRule: "highest_single_day" },
  { title: "Flash Walk", description: "One epic walking day. Highest single-day count wins.", type: "CREATIVE", resolutionRule: "highest_single_day" },
  { title: "Daily High Score", description: "Set the daily high score. Best single day wins.", type: "CREATIVE", resolutionRule: "highest_single_day" },

  // CREATIVE — lowest variance
  { title: "Mr. Consistent", description: "Consistency is king. Lowest daily step variance wins.", type: "CREATIVE", resolutionRule: "lowest_variance" },
  { title: "Steady Eddie", description: "Stay steady all week. Most consistent daily steps wins.", type: "CREATIVE", resolutionRule: "lowest_variance" },
  { title: "The Metronome", description: "Tick like a metronome. Smallest step variance wins.", type: "CREATIVE", resolutionRule: "lowest_variance" },
  { title: "Even Keel", description: "Keep it even. Most consistent daily step count wins.", type: "CREATIVE", resolutionRule: "lowest_variance" },
  { title: "Clockwork", description: "Walk like clockwork. Lowest variance in daily steps wins.", type: "CREATIVE", resolutionRule: "lowest_variance" },
  { title: "Balance Master", description: "Balance your steps across the week. Least variance wins.", type: "CREATIVE", resolutionRule: "lowest_variance" },
  { title: "No Peaks No Valleys", description: "Avoid peaks and valleys. Most consistent wins.", type: "CREATIVE", resolutionRule: "lowest_variance" },
  { title: "Steady State", description: "Maintain a steady state. Lowest daily variance wins.", type: "CREATIVE", resolutionRule: "lowest_variance" },

  // CREATIVE — weekend warrior
  { title: "Weekend Warrior", description: "Most steps on Saturday + Sunday combined wins.", type: "CREATIVE", resolutionRule: "weekend_warrior" },
  { title: "Saturday + Sunday", description: "The weekend is your battlefield. Highest Sat+Sun total wins.", type: "CREATIVE", resolutionRule: "weekend_warrior" },
  { title: "Weekend Walkathon", description: "Save your energy for the weekend. Sat+Sun steps decide it.", type: "CREATIVE", resolutionRule: "weekend_warrior" },
  { title: "Weekend Warrior II", description: "Double down on the weekend. Most Sat+Sun steps wins.", type: "CREATIVE", resolutionRule: "weekend_warrior" },
  { title: "Weekend Blitz", description: "Blitz the weekend. Highest Saturday + Sunday total wins.", type: "CREATIVE", resolutionRule: "weekend_warrior" },
  { title: "The Weekend Push", description: "Push hard on the weekend. Sat+Sun combined wins.", type: "CREATIVE", resolutionRule: "weekend_warrior" },
  { title: "Two Day Sprint", description: "Two days to sprint. Highest weekend step total wins.", type: "CREATIVE", resolutionRule: "weekend_warrior" },
  { title: "Weekend Grind", description: "Grind it out Sat and Sun. Highest weekend total wins.", type: "CREATIVE", resolutionRule: "weekend_warrior" },

  // Extra head-to-head to reach 104+
  { title: "Stride & Thrive", description: "Stride and thrive. Most steps this week wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "Walk Warriors", description: "Warriors of the walk. Highest total wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "One Foot Forward", description: "One foot in front of the other. Most steps wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "Keep Moving", description: "Never stop moving. Highest total steps wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "Step Supreme", description: "Prove your step supremacy. Most steps this week.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "Go the Distance", description: "Go the extra distance. Highest step count wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "Unstoppable", description: "Be unstoppable this week. Most steps takes the crown.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "The Wanderer", description: "Wander far and wide. Most steps this week wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "Stomp It Out", description: "Stomp your way to victory. Highest total wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "March On", description: "March on and never quit. Most steps wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "Hit the Ground Running", description: "Hit the ground running Monday. Most steps wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "Born to Walk", description: "You were born to walk. Prove it. Most steps wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "Every Step Counts", description: "Literally every step counts. Highest total wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "Step Machine", description: "Become a step machine. Most steps this week wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "Lace Up", description: "Lace up and get going. Most steps this week wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "Walking Tall", description: "Walk tall this week. Highest total wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "Step Into It", description: "Step into the challenge. Most steps wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "Peak Performance", description: "Perform at your peak. Highest total steps wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "Move More", description: "Simple: move more than your opponent.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "All Out", description: "Go all out this week. Most steps wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "Full Send", description: "Full send on steps. Highest total wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "Trail Blazers", description: "Blaze the trail together — but only one wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "Sole Survivor", description: "Only one sole survives. Most steps wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "The Last Step", description: "It all comes down to the last step. Most steps wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },

  // Extra daily majority
  { title: "Day Tripper", description: "Trip through the days. Win the most daily comparisons.", type: "HEAD_TO_HEAD", resolutionRule: "daily_majority" },
  { title: "Rule the Week", description: "Rule more days than your opponent to win.", type: "HEAD_TO_HEAD", resolutionRule: "daily_majority" },

  // Extra threshold
  { title: "First to 60K", description: "Race to 60,000 steps. First there wins.", type: "THRESHOLD", resolutionRule: "first_to_threshold", thresholdValue: 60000 },
  { title: "The 40K Dash", description: "Dash to 40,000 steps first.", type: "THRESHOLD", resolutionRule: "first_to_threshold", thresholdValue: 40000 },

  // Extra creative
  { title: "Midweek Monster", description: "Wed+Thu steps decide it. Highest midweek total wins.", type: "CREATIVE", resolutionRule: "highest_single_day" },
  { title: "Zero Rest Days", description: "Hit 5,000+ every day. Most qualifying days wins.", type: "CREATIVE", resolutionRule: "daily_majority" },

  // Additional to hit 104+
  { title: "Morning Glory", description: "Get your steps in early. Most total steps wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "Night Owl Walk", description: "Walk into the night. Most steps this week wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "Double Down", description: "Double down on your step game. Most steps wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "The Comeback", description: "Comebacks are real. Most steps by Sunday wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "No Days Off", description: "No days off this week. Most total steps wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "Outpace", description: "Outpace your opponent from Monday to Sunday.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "The Final Push", description: "One final push. Most steps this week wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "Walk It Off", description: "Walk it off. Whoever walks more wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "Rise & Grind", description: "Rise and grind all week. Most steps wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "Finish Strong", description: "Start however you want — just finish strong. Most steps wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "The Extra Mile", description: "Go the extra mile. Literally. Most steps wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "Weekday Warrior", description: "Mon through Fri steps only. Highest weekday total wins.", type: "CREATIVE", resolutionRule: "highest_single_day" },
  { title: "First to 35K", description: "Race to 35,000 steps. First there wins.", type: "THRESHOLD", resolutionRule: "first_to_threshold", thresholdValue: 35000 },
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
