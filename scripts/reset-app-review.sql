-- Reset the App Review demo state.
-- Wipes activity owned by the reviewer + every flagged supporting cast user.
-- The reviewer's own user row is preserved (so the email/apple_id binding
-- the App Store login depends on stays stable); only their activity is cleared.
-- Run from the wrapper script, which re-seeds canonical state afterward.

BEGIN;

CREATE TEMP TABLE review_user_ids ON COMMIT DROP AS
SELECT id
FROM users
WHERE is_review_account = true
   OR apple_id = 'review-account-v1';

-- Fence raw source writes just like HTTP intake. The preserved reviewer must
-- not keep a current revision stamp after their step history is cleared.
INSERT INTO user_scoring_input_versions (user_id, generation, updated_at)
SELECT id, 1, CURRENT_TIMESTAMP FROM review_user_ids ORDER BY id
ON CONFLICT (user_id) DO UPDATE SET
  generation = user_scoring_input_versions.generation + 1,
  updated_at = CURRENT_TIMESTAMP;

-- Races created by review-affiliated users (cascade clears their
-- participants, powerups, active effects, powerup events, messages).
DELETE FROM races
WHERE creator_id IN (SELECT id FROM review_user_ids);

-- Race participations in races NOT created by reviewers (cascade
-- clears nested powerups + active effects targeting them).
DELETE FROM race_participants
WHERE user_id IN (SELECT id FROM review_user_ids);

-- User-owned data without ON DELETE CASCADE from users.
DELETE FROM steps WHERE user_id IN (SELECT id FROM review_user_ids);
DELETE FROM step_samples WHERE user_id IN (SELECT id FROM review_user_ids);
DELETE FROM friendships
WHERE requester_id IN (SELECT id FROM review_user_ids)
   OR addressee_id IN (SELECT id FROM review_user_ids);
DELETE FROM coin_transactions WHERE user_id IN (SELECT id FROM review_user_ids);
DELETE FROM challenge_instances
WHERE user_a_id IN (SELECT id FROM review_user_ids)
   OR user_b_id IN (SELECT id FROM review_user_ids);
DELETE FROM user_shop_items WHERE user_id IN (SELECT id FROM review_user_ids);
DELETE FROM user_equipped_accessories WHERE user_id IN (SELECT id FROM review_user_ids);
DELETE FROM device_tokens WHERE user_id IN (SELECT id FROM review_user_ids);
DELETE FROM daily_reward_claims WHERE user_id IN (SELECT id FROM review_user_ids);
DELETE FROM shop_purchase_requests WHERE user_id IN (SELECT id FROM review_user_ids);
DELETE FROM race_messages WHERE sender_id IN (SELECT id FROM review_user_ids);

-- Drop the flagged supporting cast (re-created by the seed). Reviewer stays.
DELETE FROM users WHERE is_review_account = true;

COMMIT;
