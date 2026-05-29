# AGENTS.md — steps-tracker backend

## Always ask before deploying to prod

**Never deploy to production without explicit, in-the-moment confirmation.**
"Build it" / "yes" / "do it" authorizes writing and committing the change — it
does **not** authorize a prod deploy (git pull + restart, `prisma migrate
deploy`, or any DB write against the prod database). Prod serves real users;
deploys and prod data changes are the high-risk, hard-to-reverse step.

- Make the change, commit/push, run tests — then **stop and ask** before
  touching prod ("Ready to deploy to prod? It will run migration X + restart").
- Earlier approval to deploy does **not** roll forward to later changes — ask
  each time.
- Staging is fine to deploy to without asking; **prod is not**.
- This also covers one-off prod DB scripts/`UPDATE`s and running seeds on prod.

## Core principle: never break users on older app versions

This backend serves the **live iOS app**, whose binary is frozen per release.
After an App Store update, rollout is **phased over ~a week**, and some users
**never update**. So at any moment, prod is talking to a mix of app versions —
current *and* several releases old. **Every backend change must keep working
for clients on previous app versions.** This is the first thing to check for
any change, before correctness or style.

Concretely, before shipping a backend change ask: *"What does the oldest
in-the-wild app version do when it hits this?"*

### Rules that follow from this
- **Additive over destructive.** Add new fields/endpoints; don't remove or
  rename ones older clients still read/call.
- **Removing a feature → leave a compat shim.** Keep the old endpoint/field
  responding with a safe default so old clients don't 404 or render null. Only
  truly delete once the old app versions have aged out. (Example: when step
  goals were removed in 1.1.5, `PUT /auth/me/step-goal` stayed as a no-op and
  `stepGoal` kept being returned as `5000` for old clients.)
- **New request params must be optional** with sensible defaults — an old
  client won't send them.
- **Migrations must be backward-compatible** with both the currently-deployed
  old code (during the deploy window) and old clients: prefer nullable columns
  and additive tables; defer destructive drops.
- **Deploy ordering:** backend goes to prod *before* the new app reaches users,
  so the new app's endpoints exist — but the old app is still hitting the same
  prod backend the whole time, so the backend must satisfy both.

See `DEPLOYMENT.md` and `DEPLOY_RUNBOOK.md` for the deploy procedure and
incident playbook.
