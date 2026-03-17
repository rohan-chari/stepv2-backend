require("dotenv").config();
const { prisma } = require("../src/db");

const challenges = [
  // ============================================================
  // HEAD-TO-HEAD — higher_total  (12 challenges)
  // ============================================================
  { title: "Beat Your Partner", description: "Whoever takes more steps this week wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "Step Showdown", description: "A classic step-count battle. Most steps wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "Walk the Walk", description: "Don't just talk the talk. Higher total wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "The Grind", description: "Every step counts. Outgrind your opponent this week.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "Total Domination", description: "Stack those steps. Highest total at week's end wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "Sole Survivor", description: "Only one sole survives. Most steps wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "Go the Distance", description: "Go the extra distance. Highest step count wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "Unstoppable", description: "Be unstoppable this week. Most steps takes the crown.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "Full Send", description: "Full send on steps. Highest total wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "No Excuses", description: "The person who moves more this week takes the W.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "Lace Up", description: "Lace up and get going. Most steps this week wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
  { title: "The Extra Mile", description: "Go the extra mile. Literally. Most steps wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },

  // ============================================================
  // HEAD-TO-HEAD — daily_majority  (10 challenges)
  // ============================================================
  { title: "Day by Day", description: "Win more days than your opponent. Majority of daily comparisons wins.", type: "HEAD_TO_HEAD", resolutionRule: "daily_majority" },
  { title: "Daily Duel", description: "Beat your opponent on more days than they beat you.", type: "HEAD_TO_HEAD", resolutionRule: "daily_majority" },
  { title: "Seven Day Siege", description: "Seven days, seven battles. Win the majority.", type: "HEAD_TO_HEAD", resolutionRule: "daily_majority" },
  { title: "Win the Days", description: "Each day is a battle. Win the most days to win the war.", type: "HEAD_TO_HEAD", resolutionRule: "daily_majority" },
  { title: "Dawn to Dusk", description: "From dawn to dusk, every day matters. Win more days.", type: "HEAD_TO_HEAD", resolutionRule: "daily_majority" },
  { title: "Sunrise Showdown", description: "Each sunrise starts a new battle. Win the majority.", type: "HEAD_TO_HEAD", resolutionRule: "daily_majority" },
  { title: "Day Tripper", description: "Trip through the days. Win the most daily matchups.", type: "HEAD_TO_HEAD", resolutionRule: "daily_majority" },
  { title: "Rule the Week", description: "Rule more days than your opponent to win.", type: "HEAD_TO_HEAD", resolutionRule: "daily_majority" },
  { title: "The Daily Grind", description: "Grind it out every single day. Win the most days.", type: "HEAD_TO_HEAD", resolutionRule: "daily_majority" },
  { title: "Day Streak", description: "Stack winning days. Most daily wins takes it.", type: "HEAD_TO_HEAD", resolutionRule: "daily_majority" },

  // ============================================================
  // THRESHOLD — first_to_threshold  (12 challenges)
  // ============================================================
  { title: "The 40K Dash", description: "Dash to 40,000 steps first. A quick-fire race.", type: "THRESHOLD", resolutionRule: "first_to_threshold", thresholdValue: 40000 },
  { title: "First to 35K", description: "Race to 35,000 steps. First there wins.", type: "THRESHOLD", resolutionRule: "first_to_threshold", thresholdValue: 35000 },
  { title: "Race to 50K", description: "First to 50,000 steps wins. If neither makes it, higher total wins.", type: "THRESHOLD", resolutionRule: "first_to_threshold", thresholdValue: 50000 },
  { title: "50K Sprint", description: "Sprint to 50,000 steps before your opponent.", type: "THRESHOLD", resolutionRule: "first_to_threshold", thresholdValue: 50000 },
  { title: "The 50K Challenge", description: "Can you hit 50,000 steps first?", type: "THRESHOLD", resolutionRule: "first_to_threshold", thresholdValue: 50000 },
  { title: "First to 60K", description: "Race to 60,000 steps. First there wins.", type: "THRESHOLD", resolutionRule: "first_to_threshold", thresholdValue: 60000 },
  { title: "Race to 75K", description: "First to 75,000 steps wins. Higher total as fallback.", type: "THRESHOLD", resolutionRule: "first_to_threshold", thresholdValue: 75000 },
  { title: "75K or Bust", description: "Hit 75K first or go home trying.", type: "THRESHOLD", resolutionRule: "first_to_threshold", thresholdValue: 75000 },
  { title: "Race to 100K", description: "First to 100,000 steps wins. An epic challenge.", type: "THRESHOLD", resolutionRule: "first_to_threshold", thresholdValue: 100000 },
  { title: "The Century", description: "100,000 steps in one week. First to cross wins.", type: "THRESHOLD", resolutionRule: "first_to_threshold", thresholdValue: 100000 },
  { title: "Six Figures", description: "Hit six figures in steps. First there wins.", type: "THRESHOLD", resolutionRule: "first_to_threshold", thresholdValue: 100000 },
  { title: "Halfway There", description: "50K steps is the goal. First one there wins.", type: "THRESHOLD", resolutionRule: "first_to_threshold", thresholdValue: 50000 },

  // ============================================================
  // CREATIVE — highest_single_day  (8 challenges)
  // ============================================================
  { title: "Peak Day", description: "Your best single day decides it. Highest single-day count wins.", type: "CREATIVE", resolutionRule: "highest_single_day" },
  { title: "One Big Day", description: "One massive day is all it takes. Best single day wins.", type: "CREATIVE", resolutionRule: "highest_single_day" },
  { title: "Day of Glory", description: "Make one day legendary. Highest single-day steps wins.", type: "CREATIVE", resolutionRule: "highest_single_day" },
  { title: "Max Effort", description: "Give your maximum effort on one day. Best day wins.", type: "CREATIVE", resolutionRule: "highest_single_day" },
  { title: "Big Day Energy", description: "Channel big day energy. Highest single-day total wins.", type: "CREATIVE", resolutionRule: "highest_single_day" },
  { title: "The Surge", description: "One massive surge is all you need. Best day wins.", type: "CREATIVE", resolutionRule: "highest_single_day" },
  { title: "Flash Walk", description: "One epic walking day. Highest single-day count wins.", type: "CREATIVE", resolutionRule: "highest_single_day" },
  { title: "Daily High Score", description: "Set the daily high score. Best single day wins.", type: "CREATIVE", resolutionRule: "highest_single_day" },

  // ============================================================
  // CREATIVE — lowest_variance  (6 challenges)
  // ============================================================
  { title: "Mr. Consistent", description: "Consistency is king. Lowest daily step variance wins.", type: "CREATIVE", resolutionRule: "lowest_variance" },
  { title: "Steady Eddie", description: "Stay steady all week. Most consistent daily steps wins.", type: "CREATIVE", resolutionRule: "lowest_variance" },
  { title: "The Metronome", description: "Tick like a metronome. Smallest step variance wins.", type: "CREATIVE", resolutionRule: "lowest_variance" },
  { title: "Clockwork", description: "Walk like clockwork. Lowest variance in daily steps wins.", type: "CREATIVE", resolutionRule: "lowest_variance" },
  { title: "No Peaks No Valleys", description: "Avoid peaks and valleys. Most consistent wins.", type: "CREATIVE", resolutionRule: "lowest_variance" },
  { title: "Even Keel", description: "Keep it even. Most consistent daily step count wins.", type: "CREATIVE", resolutionRule: "lowest_variance" },

  // ============================================================
  // CREATIVE — weekend_warrior  (6 challenges)
  // ============================================================
  { title: "Weekend Warrior", description: "Most steps on Saturday + Sunday combined wins.", type: "CREATIVE", resolutionRule: "weekend_warrior" },
  { title: "Saturday + Sunday", description: "The weekend is your battlefield. Highest Sat+Sun total wins.", type: "CREATIVE", resolutionRule: "weekend_warrior" },
  { title: "Weekend Walkathon", description: "Save your energy for the weekend. Sat+Sun steps decide it.", type: "CREATIVE", resolutionRule: "weekend_warrior" },
  { title: "Weekend Blitz", description: "Blitz the weekend. Highest Saturday + Sunday total wins.", type: "CREATIVE", resolutionRule: "weekend_warrior" },
  { title: "Two Day Sprint", description: "Two days to sprint. Highest weekend step total wins.", type: "CREATIVE", resolutionRule: "weekend_warrior" },
  { title: "The Weekend Push", description: "Push hard on the weekend. Sat+Sun combined wins.", type: "CREATIVE", resolutionRule: "weekend_warrior" },

  // ============================================================
  // CREATIVE — improvement_over_baseline  (8 challenges)
  // ============================================================
  { title: "Level Up", description: "Biggest improvement over your own 4-week average wins. Beat yourself first.", type: "CREATIVE", resolutionRule: "improvement_over_baseline" },
  { title: "Personal Best", description: "Improve the most vs. your recent average. Your only real competition is you.", type: "CREATIVE", resolutionRule: "improvement_over_baseline" },
  { title: "Growth Mindset", description: "Who can grow the most? Biggest % gain over your baseline wins.", type: "CREATIVE", resolutionRule: "improvement_over_baseline" },
  { title: "New You", description: "Outdo your old self. Largest improvement over your average wins.", type: "CREATIVE", resolutionRule: "improvement_over_baseline" },
  { title: "Break the Mold", description: "Shatter your usual routine. Biggest % improvement wins.", type: "CREATIVE", resolutionRule: "improvement_over_baseline" },
  { title: "Glow Up", description: "Step glow-up time. Most improved over your own baseline wins.", type: "CREATIVE", resolutionRule: "improvement_over_baseline" },
  { title: "Beat Yesterday", description: "Not about beating them — beat the old you. Biggest improvement wins.", type: "CREATIVE", resolutionRule: "improvement_over_baseline" },
  { title: "The Climb", description: "Climb above your comfort zone. Highest % gain over baseline wins.", type: "CREATIVE", resolutionRule: "improvement_over_baseline" },

  // ============================================================
  // CREATIVE — streak_days  (8 challenges)
  // ============================================================
  { title: "8K Every Day", description: "Hit 8,000 steps as many days as you can. Most qualifying days wins.", type: "CREATIVE", resolutionRule: "streak_days", thresholdValue: 8000 },
  { title: "10K Streak", description: "Hit 10,000 steps per day. Most days at or above wins.", type: "CREATIVE", resolutionRule: "streak_days", thresholdValue: 10000 },
  { title: "5K Floor", description: "5,000 steps minimum every day. Most qualifying days wins.", type: "CREATIVE", resolutionRule: "streak_days", thresholdValue: 5000 },
  { title: "12K Club", description: "12,000 steps is the bar. How many days can you clear it?", type: "CREATIVE", resolutionRule: "streak_days", thresholdValue: 12000 },
  { title: "Zero Rest Days", description: "Hit 5,000+ every single day. Most qualifying days wins.", type: "CREATIVE", resolutionRule: "streak_days", thresholdValue: 5000 },
  { title: "Daily Quota", description: "Meet the 7,500 step quota more days than your opponent.", type: "CREATIVE", resolutionRule: "streak_days", thresholdValue: 7500 },
  { title: "Perfect Week", description: "Hit 10K all 7 days for the perfect week. Most days wins.", type: "CREATIVE", resolutionRule: "streak_days", thresholdValue: 10000 },
  { title: "15K or Nothing", description: "15,000 is the target. A tough daily bar — how many days?", type: "CREATIVE", resolutionRule: "streak_days", thresholdValue: 15000 },

  // ============================================================
  // CREATIVE — comeback_king  (6 challenges)
  // ============================================================
  { title: "The Comeback", description: "Be losing at halftime, win by Sunday. If neither comes back, higher total wins.", type: "CREATIVE", resolutionRule: "comeback_king" },
  { title: "Second Wind", description: "Find your second wind. Trail at Wednesday midnight, lead by Sunday.", type: "CREATIVE", resolutionRule: "comeback_king" },
  { title: "Never Count Me Out", description: "Down at the half? Good. Win from behind for the real glory.", type: "CREATIVE", resolutionRule: "comeback_king" },
  { title: "Reverse Sweep", description: "Reverse sweep the week. Behind by midweek, ahead by end.", type: "CREATIVE", resolutionRule: "comeback_king" },
  { title: "Plot Twist", description: "Write the plot twist. Trail Wednesday, triumph Sunday.", type: "CREATIVE", resolutionRule: "comeback_king" },
  { title: "Clutch Factor", description: "Be clutch. The only way to win is from behind.", type: "CREATIVE", resolutionRule: "comeback_king" },

  // ============================================================
  // CREATIVE — close_the_rings  (6 challenges)
  // ============================================================
  { title: "Close the Rings", description: "Hit your own step goal every day. Most days at-goal wins.", type: "CREATIVE", resolutionRule: "close_the_rings" },
  { title: "Own Your Goal", description: "You set the goal — now hit it. Most days at your target wins.", type: "CREATIVE", resolutionRule: "close_the_rings" },
  { title: "Walk Your Talk", description: "Live up to the goal you set. Most days meeting it wins.", type: "CREATIVE", resolutionRule: "close_the_rings" },
  { title: "Promise Keeper", description: "Keep your promise to yourself. Hit your daily goal more days.", type: "CREATIVE", resolutionRule: "close_the_rings" },
  { title: "Goal Getter", description: "Who's the real goal-getter? Most days hitting your own target wins.", type: "CREATIVE", resolutionRule: "close_the_rings" },
  { title: "Ring the Bell", description: "Ring the bell every day you hit your goal. Most bells wins.", type: "CREATIVE", resolutionRule: "close_the_rings" },

  // ============================================================
  // CREATIVE — progressive_target  (6 challenges)
  // ============================================================
  { title: "The Escalator", description: "Target goes up each day: 5K Mon, 6K Tue, 7K Wed... Most days cleared wins.", type: "CREATIVE", resolutionRule: "progressive_target", thresholdValue: 5000 },
  { title: "Staircase Challenge", description: "Each day the bar rises by 1,000 steps. How high can you climb?", type: "CREATIVE", resolutionRule: "progressive_target", thresholdValue: 5000 },
  { title: "Rising Tide", description: "The tide rises daily. Starting at 6K, up 1K each day. Most days met wins.", type: "CREATIVE", resolutionRule: "progressive_target", thresholdValue: 6000 },
  { title: "The Ramp", description: "Ramp it up: 4K Mon, 5K Tue, 6K Wed... Can you keep up?", type: "CREATIVE", resolutionRule: "progressive_target", thresholdValue: 4000 },
  { title: "Boss Mode", description: "Each day is a harder boss. Start at 7K, add 1K daily. Survive the most days.", type: "CREATIVE", resolutionRule: "progressive_target", thresholdValue: 7000 },
  { title: "Harder Every Day", description: "It literally gets harder every day. Starting at 5K, +1K per day. Good luck.", type: "CREATIVE", resolutionRule: "progressive_target", thresholdValue: 5000 },

  // ============================================================
  // CREATIVE — rest_day_penalty  (6 challenges)
  // ============================================================
  { title: "No Weak Links", description: "Your worst day gets subtracted from your total. No weak links allowed.", type: "CREATIVE", resolutionRule: "rest_day_penalty" },
  { title: "Drop the Dead Weight", description: "Worst day = dead weight. It gets cut from your total. Highest adjusted wins.", type: "CREATIVE", resolutionRule: "rest_day_penalty" },
  { title: "Consistency Tax", description: "A tax on laziness: your lowest day is deducted. Adjusted total wins.", type: "CREATIVE", resolutionRule: "rest_day_penalty" },
  { title: "Every Day Matters", description: "One bad day costs you. Worst day subtracted, highest remaining total wins.", type: "CREATIVE", resolutionRule: "rest_day_penalty" },
  { title: "Survive the Cut", description: "Your worst day gets the axe. What's left is your real score.", type: "CREATIVE", resolutionRule: "rest_day_penalty" },
  { title: "Floor Is Lava", description: "The floor is lava — your lowest day burns off your total. Stay up.", type: "CREATIVE", resolutionRule: "rest_day_penalty" },

  // ============================================================
  // CREATIVE — hot_start  (4 challenges)
  // ============================================================
  { title: "Hot Start", description: "Mon + Tue + Wed steps only. Start fast or lose.", type: "CREATIVE", resolutionRule: "hot_start" },
  { title: "Fast Out the Gate", description: "The first three days decide everything. Hit the ground running.", type: "CREATIVE", resolutionRule: "hot_start" },
  { title: "Front-Loaded", description: "It's all about Mon–Wed. Highest first-half total wins.", type: "CREATIVE", resolutionRule: "hot_start" },
  { title: "Early Bird", description: "The early bird wins the challenge. Mon–Wed steps only.", type: "CREATIVE", resolutionRule: "hot_start" },

  // ============================================================
  // CREATIVE — strong_finish  (4 challenges)
  // ============================================================
  { title: "Strong Finish", description: "Thu through Sun steps only. Finish the week strong.", type: "CREATIVE", resolutionRule: "strong_finish" },
  { title: "Late Bloomer", description: "The back half of the week is all that counts. Thu–Sun total wins.", type: "CREATIVE", resolutionRule: "strong_finish" },
  { title: "Closing Kick", description: "Save your kick for the end. Thu–Sun steps decide it.", type: "CREATIVE", resolutionRule: "strong_finish" },
  { title: "The Home Stretch", description: "The home stretch is Thu–Sun. Highest total in those 4 days wins.", type: "CREATIVE", resolutionRule: "strong_finish" },

  // ============================================================
  // CREATIVE — daily_minimum  (4 challenges)
  // ============================================================
  { title: "3K or Zero", description: "Hit 3,000 steps or the day counts as zero. Highest adjusted total wins.", type: "CREATIVE", resolutionRule: "daily_minimum", thresholdValue: 3000 },
  { title: "Use It or Lose It", description: "Under 5,000 steps? That day is wiped. Highest surviving total wins.", type: "CREATIVE", resolutionRule: "daily_minimum", thresholdValue: 5000 },
  { title: "The Floor", description: "4,000 is the floor. Miss it and that day's steps vanish.", type: "CREATIVE", resolutionRule: "daily_minimum", thresholdValue: 4000 },
  { title: "All or Nothing", description: "Hit 6K each day or get nothing for it. Adjusted total wins.", type: "CREATIVE", resolutionRule: "daily_minimum", thresholdValue: 6000 },
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
