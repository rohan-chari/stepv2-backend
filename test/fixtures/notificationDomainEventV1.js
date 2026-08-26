// Literal V1 delivery-key fixtures. These are intentionally independent of
// the producer registry so a source/key change cannot update both sides of a
// parity assertion by accident.
const rows = [
  ["FRIEND_REQUEST_SENT_V1", "FRIEND_REQUEST_SENT", { requesterId: "requester-1", addresseeId: "user-1" }, {}, "visible:FRIEND_REQUEST_SENT:user-1:requester-1:user-1"],
  ["FRIEND_REQUEST_ACCEPTED_V1", "FRIEND_REQUEST_ACCEPTED", { friendshipId: "friendship-1", requesterId: "user-1", accepterId: "accepter-1" }, {}, "visible:FRIEND_REQUEST_ACCEPTED:user-1:friendship-1"],
  ["RACE_INVITE_SENT_V1", "RACE_INVITE_SENT", { raceId: "race-1" }, {}, "visible:RACE_INVITE_SENT:user-1:race-1"],
  ["RACE_INVITE_ACCEPTED_V1", "RACE_INVITE_ACCEPTED", { raceId: "race-1" }, {}, "visible:RACE_INVITE_ACCEPTED:user-1:race-1"],
  ["RACE_BUYIN_CHANGED_V1", "RACE_BUYIN_CHANGED", { changeId: "change-1" }, {}, "visible:RACE_BUYIN_CHANGED:user-1:race-buyin:change-1"],
  ["RACE_SCHEDULED_TEAMS_UNEVEN_V1", "RACE_SCHEDULED_TEAMS_UNEVEN", { raceId: "race-1" }, {}, "visible:TEAM_RACE_SCHEDULED_UNEVEN:user-1:race-1"],
  ["RACE_STARTED_V1", "RACE_STARTED", { raceId: "race-1" }, {}, "visible:RACE_STARTED:user-1:race-1"],
  ["RACE_ENDING_SOON_V1", "RACE_ENDING_SOON", { raceId: "race-1" }, {}, "visible:RACE_ENDING_SOON:user-1:race-1"],
  ["DAILY_REWARD_REMINDER_V1", "DAILY_REWARD_REMINDER", { userId: "user-1", localDate: "2026-08-25", slot: 17 }, {}, "visible:DAILY_REWARD_REMINDER_17:user-1:user-1:2026-08-25:17"],
  ["STEP_MILESTONE_REMINDER_V1", "STEP_MILESTONE_REMINDER", { userId: "user-1", localDate: "2026-08-25" }, {}, "visible:STEP_MILESTONE_REMINDER:user-1:user-1:2026-08-25"],
  ["RACE_COMPLETED_V1", "RACE_COMPLETED", { raceId: "race-1" }, {}, "visible:RACE_COMPLETED:user-1:race-1"],
  ["TEAM_LEAD_CHANGED_V1", "TEAM_LEAD_CHANGED", { transitionId: "team-lead:race-1:A->B:1" }, {}, "visible:TEAM_LEAD_CHANGE:user-1:team-lead:race-1:A->B:1"],
  ["TEAM_FINAL_STRETCH_V1", "TEAM_FINAL_STRETCH", { transitionId: "team-final-stretch:race-1:1" }, {}, "visible:TEAM_FINAL_STRETCH:user-1:team-final-stretch:race-1:1"],
  ["TEAM_SLACKER_NUDGE_V1", "TEAM_SLACKER_NUDGE", { raceId: "race-1" }, {}, "visible:TEAM_SLACKER_NUDGE:user-1:race-1"],
  ["REFERRAL_REWARDED_V1", "REFERRAL_REWARDED", { referrerId: "user-1", refereeId: "referee-1" }, {}, "visible:REFERRAL_REWARDED:user-1:user-1:referee-1"],
  ["RACE_CANCELLED_V1", "RACE_CANCELLED", { raceId: "race-1" }, {}, "visible:RACE_CANCELLED:user-1:race-1"],
  ["GLOBAL_STEP_EVENT_ACTIVATED_V1", "GLOBAL_EVENT_STARTED", { eventId: "event-1" }, {}, "visible:GLOBAL_EVENT_STARTED:user-1:event-1"],
  ["POWERUP_USED_V1", "POWERUP_USED", { powerupId: "powerup-1", targetUserId: "user-1" }, {}, "visible:POWERUP_USED:user-1:powerup:powerup-1:user-1"],
  ["RACE_MESSAGE_SENT_V1", "RACE_MESSAGE_SENT", { messageId: "message-1" }, {}, "visible:race_message:user-1:message-1"],
  ["PLACEMENT_CHANGED_V1", "PLACEMENT_CHANGED", { raceId: "race-1", transitionId: "placement:p1:1:2->3" }, {}, "visible:PLACEMENT_CHANGED:user-1:placement:p1:1:2->3"],
  ["HIGH_MULTIPLIER_ALERT_V1", "HIGH_MULTIPLIER_ALERT", { raceId: "race-1", sourceGeneration: 7, actorUserId: "actor-1", multiplier: 4 }, {}, "visible:HIGH_MULTIPLIER_ALERT:user-1:538aab525f83f10aeafeb0f8370632e0a4cf5dc1e1fed27d305b0f633e22db2f"],
  ["TOURNAMENT_INVITE_SENT_V1", "TOURNAMENT_INVITE_SENT", { tournamentId: "tournament-1" }, {}, "visible:TOURNAMENT_INVITE_SENT:user-1:tournament-1"],
  ["TOURNAMENT_STARTED_V1", "TOURNAMENT_STARTED", { raceId: "race-1" }, {}, "visible:TOURNAMENT_STARTED:user-1:race-1"],
  ["TOURNAMENT_ROUND_STARTED_V1", "TOURNAMENT_ROUND_STARTED", { raceId: "race-1" }, {}, "visible:TOURNAMENT_ROUND_STARTED:user-1:race-1"],
  ["TOURNAMENT_MATCHUP_WON_V1", "TOURNAMENT_MATCHUP_WON", { tournamentId: "tournament-1" }, {}, "visible:TOURNAMENT_MATCHUP_WON:user-1:tournament-1"],
  ["TOURNAMENT_ELIMINATED_V1", "TOURNAMENT_ELIMINATED", { tournamentId: "tournament-1" }, {}, "visible:TOURNAMENT_ELIMINATED:user-1:tournament-1"],
  ["TOURNAMENT_CHAMPION_V1", "TOURNAMENT_CHAMPION", { tournamentId: "tournament-1" }, {}, "visible:TOURNAMENT_CHAMPION:user-1:tournament-1"],
  ["TOURNAMENT_COMPLETED_V1", "TOURNAMENT_COMPLETED", { tournamentId: "tournament-1" }, {}, "visible:TOURNAMENT_COMPLETED:user-1:tournament-1"],
  ["TOURNAMENT_CANCELLED_V1", "TOURNAMENT_CANCELLED", { tournamentId: "tournament-1" }, {}, "visible:TOURNAMENT_CANCELLED:user-1:tournament-1"],
  ["DAILY_MOVER_V1", "DAILY_MOVER", { digestId: "daily-mover:2026-08-25:user-1" }, {}, "visible:DAILY_MOVER:user-1:daily-mover:2026-08-25:user-1"],
  ["SUPPORT_REPLY_CREATED_V1", null, { messageId: "message-1" }, {}, "support-reply:message-1"],
];

const COPY = {
  FRIEND_REQUEST_SENT_V1: ["New Friend Request", "Actor sent you a friend request", "FRIEND_REQUEST_SENT", "friends"],
  FRIEND_REQUEST_ACCEPTED_V1: ["Friend Request Accepted", "Actor accepted your friend request", "FRIEND_REQUEST_ACCEPTED", "friends"],
  RACE_INVITE_SENT_V1: ["Race Invite", "Actor invited you to a race: Fixture race", "RACE_INVITE_SENT", "race_detail"],
  RACE_INVITE_ACCEPTED_V1: ["Race Update", "Actor joined your race: Fixture race", "RACE_INVITE_ACCEPTED", "race_detail"],
  RACE_BUYIN_CHANGED_V1: ["Buy-in updated", "Fixture race's buy-in is now free.", "RACE_BUYIN_CHANGED", "race_detail"],
  RACE_SCHEDULED_TEAMS_UNEVEN_V1: ["Teams are uneven", "Your race couldn't start. Teams are uneven. Even them up and it'll start on the next check!", "TEAM_RACE_SCHEDULED_UNEVEN", "race_detail"],
  RACE_STARTED_V1: ["Race Started", "The race \"Fixture race\" has started! Go!", "RACE_STARTED", "race_detail"],
  RACE_ENDING_SOON_V1: ["Race ending soon", "Fixture race ends in about 2 hours. Time for a final push.", "RACE_ENDING_SOON", "race_detail"],
  DAILY_REWARD_REMINDER_V1: ["Your daily box is waiting", "Your mystery box has been sitting here all day. Awkward.", "DAILY_REWARD_REMINDER_17", "daily_reward"],
  STEP_MILESTONE_REMINDER_V1: ["Coins waiting! 🪙", "You crossed a step milestone today. Collect your coins before midnight.", "STEP_MILESTONE_REMINDER", "home"],
  RACE_COMPLETED_V1: ["Race Finished", "Actor won the race!", "RACE_COMPLETED", "race_detail"],
  TEAM_LEAD_CHANGED_V1: ["Team lead change!", "A just took the lead over B in Fixture race!", "TEAM_LEAD_CHANGE", "race_detail"],
  TEAM_FINAL_STRETCH_V1: ["Final stretch!", "30m left in Fixture race and it's dead even. Every step counts!", "TEAM_FINAL_STRETCH", "race_detail"],
  TEAM_SLACKER_NUDGE_V1: ["Your team believes in you!", "Your team could use a few more steps in Fixture race . Even a quick stroll helps. You've got this!", "TEAM_SLACKER_NUDGE", "race_detail"],
  REFERRAL_REWARDED_V1: ["You earned coins!", "Actor finished their first race with friends. You earned 25 coins!", "REFERRAL_REWARDED", "home"],
  RACE_CANCELLED_V1: ["Race Cancelled", "The race \"Fixture race\" was cancelled", "RACE_CANCELLED", "races"],
  GLOBAL_STEP_EVENT_ACTIVATED_V1: ["2x STEPS EVENT", "Double steps are LIVE for 30 minutes. Every step counts 2x in your races! Go!", "GLOBAL_EVENT_STARTED", "home"],
  POWERUP_USED_V1: ["Powerup Attack!", "Actor used Leg Cramp on you! Your steps are frozen for 1 hour. Race: Fixture race.", "POWERUP_USED", "race_detail"],
  RACE_MESSAGE_SENT_V1: ["Fixture race", "Actor: Fixture message", "race_message", "race_detail"],
  PLACEMENT_CHANGED_V1: ["You're in the lead!", "You took 1st in Fixture race.", "PLACEMENT_CHANGED", "race_detail"],
  HIGH_MULTIPLIER_ALERT_V1: ["🔥 Someone's heating up", "Actor's multiplier is stacked at 4x. Slow them down or catch up!", "HIGH_MULTIPLIER_ALERT", "race_detail"],
  TOURNAMENT_INVITE_SENT_V1: ["Tournament invite", "Actor invited you to Fixture tournament. 8 racers, winner takes the crown!", "TOURNAMENT_INVITE_SENT", "tournament_detail"],
  TOURNAMENT_STARTED_V1: ["The bracket is set!", "Round 1: you vs Rival. 1d. Go!", "TOURNAMENT_STARTED", "race_detail"],
  TOURNAMENT_ROUND_STARTED_V1: ["Semifinal!", "You drew Rival. 1d on the clock.", "TOURNAMENT_ROUND_STARTED", "race_detail"],
  TOURNAMENT_MATCHUP_WON_V1: ["You won your matchup!", "Semifinal is next.", "TOURNAMENT_MATCHUP_WON", "tournament_detail"],
  TOURNAMENT_ELIMINATED_V1: ["Knocked out", "Knocked out in the Semifinal by Rival. Follow the bracket to the end!", "TOURNAMENT_ELIMINATED", "tournament_detail"],
  TOURNAMENT_CHAMPION_V1: ["CHAMPION!", "You swept Fixture tournament and took the crown!", "TOURNAMENT_CHAMPION", "tournament_detail"],
  TOURNAMENT_COMPLETED_V1: ["Tournament over", "Actor took the crown in Fixture tournament.", "TOURNAMENT_COMPLETED", "tournament_detail"],
  TOURNAMENT_CANCELLED_V1: ["Tournament cancelled", "Fixture tournament was called off.", "TOURNAMENT_CANCELLED", "tournament_detail"],
  DAILY_MOVER_V1: ["You're climbing!", "You moved up 2 spots in Fixture race today. Now 1st.", "DAILY_MOVER", "race_detail"],
  SUPPORT_REPLY_CREATED_V1: ["BARA SUPPORT", "Fixture support reply", "SUPPORT_REPLY", "support_thread"],
};

const BASE_PAYLOAD = {
  requesterId: "requester-1",
  addresseeId: "user-1",
  friendshipId: "friendship-1",
  accepterId: "actor-1",
  raceId: "race-1",
  raceName: "Fixture race",
  creatorId: "actor-1",
  creatorUserId: "actor-1",
  userId: "actor-1",
  senderId: "actor-1",
  senderName: "Actor",
  previousPlacement: 2,
  placement: 1,
  paidPlaces: 1,
  teamATotal: 5_000,
  teamBTotal: 5_000,
  leadingTeamName: "A",
  trailingTeamName: "B",
  teamName: null,
  winnerUserId: "actor-1",
  winnerTeam: null,
  tie: false,
  referrerId: "user-1",
  refereeId: "actor-1",
  coins: 25,
  eventId: "event-1",
  multiplier: 2,
  powerupId: "powerup-1",
  powerupType: "LEG_CRAMP",
  targetUserId: "user-1",
  upgradeLevel: 0,
  actorUserId: "actor-1",
  actorName: "Actor",
  tournamentName: "Fixture tournament",
  bracketSize: 8,
  potCoins: 0,
  opponentName: "Rival",
  days: 1,
  label: "Semifinal",
  nextLabel: "Semifinal",
  championName: "Actor",
  prizeCoins: 0,
  buyInAmount: 0,
  digestId: "daily-mover:2026-08-25:user-1",
  movement: 2,
  localDate: "2026-08-25",
  slot: 17,
};

function expectedPayload(eventType, publicType, route) {
  const payload = { type: publicType, route };
  if (route === "race_detail") payload.params = { raceId: "race-1" };
  if (route === "tournament_detail") payload.params = { tournamentId: "tournament-1" };
  if (["DAILY_REWARD_REMINDER_V1", "STEP_MILESTONE_REMINDER_V1"].includes(eventType)) {
    payload.params = {};
  }
  if (eventType === "GLOBAL_STEP_EVENT_ACTIVATED_V1") {
    payload.eventId = "event-1";
    payload.multiplier = 2;
  }
  if (eventType === "RACE_MESSAGE_SENT_V1") {
    Object.assign(payload, {
      raceId: "race-1",
      messageId: "message-1",
      collapseId: "race_chat_race-1",
      threadId: "race_chat_race-1",
    });
  }
  if (eventType === "PLACEMENT_CHANGED_V1") {
    Object.assign(payload, { placement: 1, collapseId: "placement_race-1" });
  }
  if (eventType === "HIGH_MULTIPLIER_ALERT_V1") {
    Object.assign(payload, { multiplier: 4, collapseId: "himult_race-1_actor-1" });
  }
  if (["TOURNAMENT_STARTED_V1", "TOURNAMENT_ROUND_STARTED_V1"].includes(eventType)) {
    payload.params.tournamentId = "tournament-1";
  }
  if (eventType === "DAILY_MOVER_V1") {
    Object.assign(payload, { placement: 1, collapseId: "daily_mover_race-1" });
  }
  return payload;
}

module.exports = rows.map(([eventType, legacyHandler, payload, facts, deliveryKey]) => {
  const [title, body, publicType, route] = COPY[eventType];
  const completePayload = {
    ...BASE_PAYLOAD,
    ...(eventType.startsWith("TOURNAMENT_") ? { tournamentId: "tournament-1" } : {}),
    ...(eventType === "RACE_MESSAGE_SENT_V1" ? { body: "Fixture message" } : {}),
    ...(eventType === "SUPPORT_REPLY_CREATED_V1" ? { body: "Fixture support reply" } : {}),
    ...payload,
  };
  return {
  eventType,
  legacyHandler,
  payload: completePayload,
  audience: { recipientId: "user-1", facts: { memberTeam: null, ...facts } },
  deliveryKey,
    expected: {
      title,
      body,
      destination: route === "race_detail"
        ? { route: "raceDetail", raceId: "race-1" }
        : route === "tournament_detail"
          ? { route: "tournamentDetail", tournamentId: "tournament-1" }
          : route === "friends"
            ? { route: "friends" }
            : route === "daily_reward"
              ? { route: "dailyReward" }
              : route === "races"
                ? { route: "races" }
              : route === "support_thread"
                ? { route: "supportThread", threadId: "thread-1" }
                : { route: "home" },
      providerPayload: expectedPayload(eventType, publicType, route),
      audience: ["user-1"],
      suppression: { eligible: "DELIVER", missingRecipient: "RECIPIENT_DELETED" },
    },
  };
});
