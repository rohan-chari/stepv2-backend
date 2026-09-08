<script setup>
import SiteHeader from "@/components/SiteHeader.vue";
import SiteFooter from "@/components/SiteFooter.vue";
</script>

<template>
  <SiteHeader />
  <main class="paper">
    <div class="mx-auto max-w-3xl px-5 py-16 sm:px-8 sm:py-20">
      <p class="eyebrow mb-4 text-[var(--paper-muted)]">Effective September 7, 2026</p>
      <h1 class="mb-12 font-display text-[clamp(2.25rem,6vw,3.5rem)] leading-[1.02] font-extrabold tracking-[-0.03em] text-[var(--paper-foreground)]">
        Bara Purchase Terms
      </h1>
      <div class="prose-bara">
        <h2>Purchases in Bara</h2>
        <p>
          Coin packs and Bara+ are optional purchases made through Apple's App Store
          or Google Play. Sign in to Bara before purchasing. The store checkout
          displays the applicable currency, price, taxes and billing period before
          you confirm. Store payment terms also apply.
        </p>
        <h2>Coin packs</h2>
        <p>
          Each coin pack supplies the quantity shown in Bara and at checkout.
          Purchased coins can be used wherever Bara accepts coins, including shop
          items, eligible rerolls and race buy-ins. Coins are in-app items, not
          cash, and have no cash-out value. Buying a pack again is a new purchase.
        </p>
        <h2>Bara+ membership</h2>
        <p>
          Bara+ includes a 15% discount on eligible cosmetic and powerup shop
          purchases, member styling and a shared monthly cosmetic while paid
          membership is eligible. Whole-coin prices are rounded up. Other costs,
          including powerup upgrades, race buy-ins and rerolls, are not shop discounts.
        </p>
        <p>
          A paid monthly billing period grants 500 coins and 10 reroll credits.
          Grants arrive after payment is verified. Subscription access and periodic payment grants
          are separate: restoring access does not issue the same grants again.
        </p>
        <p>
          Shared cosmetic rewards follow UTC calendar months. Your first verified
          payment qualifies for the current month's cosmetic, followed by each
          calendar month with qualifying paid access. Each month's reward is granted once; an
          already-owned cosmetic has no substitute reward. Free-trial access
          alone does not qualify for a permanent cosmetic.
        </p>
        <h2>Permanent Bara+</h2>
        <p>
          Permanent Bara+ is a one-time payment for permanent membership benefits,
          including 500 coins and 10 reroll credits every month. It does not renew
          and has no free trial. The store shows the localized one-time price.
          Rewards begin after the purchase is verified and repeat on the monthly anniversary.
          Dates use UTC; if a month has fewer days, that month's reward uses its
          last day, returning to the original day in longer months.
        </p>
        <p>
          If you already have a verified paid subscription period when you buy
          permanent access, your first permanent coin and credit bundle arrives
          when that paid period ends. Future bundles follow that date's monthly
          anniversary. Permanent discounts, styling and cosmetic eligibility begin
          immediately. Trial access does not delay the first permanent bundle.
          Missed months remain owed and are credited automatically when verification
          and processing complete; you do not need to play each month to qualify.
        </p>
        <p>
          Buying permanent access does not cancel an existing subscription.
          Use Manage subscription to cancel its future renewal with the store.
          Any separate subscription payment still receives its paid bundle.
          Restoring permanent access or purchasing it through another store does
          not start a second permanent reward schedule or stack shop discounts.
        </p>
        <p>
          A refund or revocation of permanent access stops its future rewards.
          Refund recovery includes all coin grants and unused reroll credits
          attributable to that purchase, subject to the bounded recovery policy
          below. Another valid purchase may continue to provide access. If the
          store reverses a refund, eligibility is restored for the original
          period, missed eligible rewards are caught up, and only amounts actually
          recovered are returned. Restores and reversals never duplicate grants.
        </p>
        <h2>Trials and renewal</h2>
        <p>
          Eligible monthly subscribers may receive a seven-day free trial. The store decides
          trial eligibility and shows any applicable offer at checkout. During the
          trial, member discounts and styling are active and three trial reroll
          credits are available. Unused trial credits expire when the trial ends or when a verified permanent purchase begins paid access.
          Coin gifts, permanent cosmetic gifts and the full paid reroll allowance
          begin only after the first successful payment.
        </p>
        <p>
          Subscriptions automatically renew for the selected billing period unless
          you cancel through the store. At the end of a trial, the store charges
          the displayed subscription price unless you cancel in time. Follow the
          cancellation deadline shown by Apple or Google. Uninstalling Bara or
          deleting your Bara account does not cancel a store subscription.
        </p>
        <h2>Historical annual purchases</h2>
        <p>
          Annual plans are no longer offered for new purchases. Previously verified
          annual payments retain their original 6,000 coins and 120 reroll credits
          upfront and paid coverage. That coverage may overlap 13 calendar months
          of cosmetic eligibility. Existing monthly and annual plan changes follow
          the store-confirmed effective date, normally the next renewal. Confirm the effective date in the store. Requesting a change
          does not immediately grant another coin or reroll-credit allowance;
          the next allowance follows the next verified payment.
        </p>
        <h2>Rerolls</h2>
        <p>
          An eligible paid reroll costs 50 coins or one reroll credit per action,
          including Reroll All. Confirm the funding choice before proceeding. The
          replacement can be worse than the original; one reroll is allowed per
          item. The displayed box odds and existing eligibility rules apply.
          Unused paid reroll credits carry over and remain usable after normal
          membership expiry. Expiring trial credits are used before paid credits.
        </p>
        <h2>Manage, restore and get help</h2>
        <p>
          Use Manage subscription in Bara+ to open the appropriate store settings.
          Restore purchases checks the signed-in account's purchase status; it
          does not duplicate coins or rewards already granted. If a completed
          purchase is still pending in Bara, reopen the app or use Restore purchases
          before buying again. Contact
          <a href="mailto:support@barastep.com">support@barastep.com</a> if it remains unresolved.
        </p>
        <p>
          Purchases remain bound to the original Bara account. They do not
          automatically transfer to another account, including a new account
          created after deletion. Apple and Google sign-ins remain separate
          Bara accounts. Use the original account for purchase recovery.
        </p>
        <p>
          Refund requests are handled by the store that processed the payment.
          Any approved adjustment follows the verified store record. We recover
          refunded coin grants from your current balance, including earned coins,
          up to the refunded grant, and remove unused reroll credits attributable
          to that purchase. Spent shortfalls do not create a debt or deductions
          from future earnings. Awarded cosmetics remain yours, while membership
          access follows the verified store status. Your statutory
          consumer rights are not limited by these purchase terms.
        </p>
        <h2>Privacy and contact</h2>
        <p>
          Read our <a href="/privacy">Privacy Policy</a> for how billing data is
          processed. For purchase help, visit <a href="/support">Bara Support</a>.
        </p>
      </div>
    </div>
  </main>
  <SiteFooter />
</template>
