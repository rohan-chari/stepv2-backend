<script setup>
import SiteHeader from "@/components/SiteHeader.vue";
import SiteFooter from "@/components/SiteFooter.vue";

// Billing disclosure is updated alongside the real purchase integration.
// Effective date changes when the policy changes.
const EFFECTIVE_DATE = "September 10, 2026";

const collected = [
  {
    term: "Account identifier (Apple / Google)",
    def: "Account creation and sign-in via Sign in with Apple or Google Sign-In on iOS, and Google Sign-In on Android. We receive only the opaque user identifier the provider supplies. We do not access your Apple ID or Google password.",
  },
  {
    term: "Display name",
    def: "A race name you choose for your profile, races, and challenges. Visible to other Bara users.",
  },
  {
    term: "Discoverable name",
    def: "The first name and optional last name you review and submit so friends can find you in Bara. It becomes searchable by other Bara users only after you confirm setup. We store a normalized search-only copy, which is never returned to clients.",
  },
  {
    term: "Email address",
    def: "Received from Sign in with Apple or Google Sign-In if you choose to share it (Apple's “Hide My Email” relay addresses are supported). Used for account support and never shown to other users.",
  },
  {
    term: "Feedback and reply email (optional)",
    def: "When you send feedback in Bara, your message and any optional reply email are emailed to Bara Support through Google Workspace. A valid account email may be used as the reply address when you do not enter one. Support email may remain in the support mailbox until it is manually deleted.",
  },
  {
    term: "Profile photo (optional)",
    def: "A photo you can choose to add to your profile. Visible to other Bara users, such as friends and race participants. You can remove it at any time.",
  },
  {
    term: "Daily step count",
    def: "Read from HealthKit (iOS) or Health Connect (Android) to show progress and calculate challenge results. Stored on our server with a date stamp.",
  },
  {
    term: "Step goal",
    def: "An optional daily goal you set to track personal progress.",
  },
  {
    term: "Friends list & requests",
    def: "To enable friend discovery, challenge matchups, and showing friends' step progress.",
  },
  {
    term: "Challenge & stake data",
    def: "Records of your weekly challenges, matchups, and negotiated stakes with friends.",
  },
  {
    term: "Push notification token (APNs / FCM)",
    def: "Registered with our server to deliver push notifications about race and challenge updates. We use Apple Push Notification service on iOS and Firebase Cloud Messaging on Android. Stored only while notifications are enabled.",
  },
];
</script>

<template>
  <SiteHeader current="privacy" />

  <main class="paper">
    <div class="mx-auto max-w-3xl px-5 py-16 sm:px-8 sm:py-20">
      <p class="eyebrow mb-4 text-[var(--paper-muted)]">
        Effective {{ EFFECTIVE_DATE }}
      </p>
      <h1
        class="mb-12 font-display text-[clamp(2.25rem,6vw,3.5rem)] leading-[1.02] font-extrabold tracking-[-0.03em] text-[var(--paper-foreground)]"
      >
        Privacy Policy
      </h1>

      <div class="prose-bara">
        <h2>Overview</h2>
        <p>
          Bara ("we," "our," or "the app") is a step-tracking challenge app for
          iOS and Android. This policy explains what data we collect, how we use
          it, and your rights. We limit collection to operating the app and the
          advertising and app measurement described below.
        </p>

        <h2>Health Data</h2>
        <p>
          Bara reads your <strong>daily step count</strong> with your explicit
          permission. It comes from <strong>Apple HealthKit</strong> on iOS and from
          <strong>Android Health Connect</strong> on Android. We request
          read-only access. We do not write to or modify your health data in
          any way. Your step count is synced to our server solely to display
          your daily progress and power step races and head-to-head challenges.
        </p>
        <p class="callout">
          Your health data (from HealthKit or Health Connect) is never used for
          advertising, is never sold to third parties, and is never shared with
          third parties for marketing or data-brokering purposes.
        </p>
        <p>
          To keep your races current even when the app is closed, Bara may also
          read your step count <strong>in the background</strong>: on iOS via
          periodic background app refresh, and on Android via Health Connect's
          background-read permission, which you grant separately and can revoke
          at any time. Background reads collect the same single data type and
          nothing else. That single type is your daily step count.
        </p>
        <p>
          You can revoke health access at any time: on <strong>iOS</strong> in
          Settings → Privacy &amp; Security → Health → Bara; on
          <strong>Android</strong> in the Health Connect app (or Settings →
          Security &amp; privacy → Health Connect) under app permissions → Bara.
          If you revoke access, the app will no longer read your step count.
        </p>

        <h2>Information We Collect</h2>
        <dl>
          <div v-for="item in collected" :key="item.term" class="pair">
            <dt>{{ item.term }}</dt>
            <dd>{{ item.def }}</dd>
          </div>
        </dl>

        <h2>Sign in with Apple / Google</h2>
        <p>
          Authentication is via Sign in with Apple or Google Sign-In on iOS, and
          Google Sign-In on Android. When you sign in, the provider gives us an
          opaque user identifier and, if you choose to share it, an email
          address. With Apple's "Hide My Email," we receive only Apple's relay
          address. We never see your real email. We do not access your Apple ID
          or Google password. The two providers are independent identities; an
          Apple account and a Google account are not automatically linked, even
          if they use the same email address.
        </p>

        <h2>How We Use Your Data</h2>
        <p>
          We use data to operate the app: to show your daily
          step count and goal progress, to run weekly challenges and display
          head-to-head results, to let friends find and challenge you by the
          discoverable name and race name you submit, and to
          send you notifications about challenge activity when you've opted in.
          We also use limited app and device information for advertising and to
          understand app engagement and advertising effectiveness, as described
          in "Advertising" and "App Measurement on iOS" below. We do not use
          health data or step counts for these purposes.
        </p>

        <h2>Data Sharing</h2>
        <p>
          Your submitted discoverable name can appear in Friends search results
          to other Bara users after you confirm setup. Your step count, race
          name, and profile photo (if you add one) are visible to friends you've
          accepted in the app and to participants in races you join. This is
          necessary for the challenge feature. If
          you're in a head-to-head challenge, your opponent can see your step
          progress for that week. We do not sell or rent your personal data, and
          outside of the partners described in "Advertising" and "App Measurement
          on iOS" below, RevenueCat processing billing as described below, and
          Google Workspace processing feedback email for Bara Support, we do not
          share your personal data with any third parties for their own use.
        </p>

        <h2>Purchases and Subscriptions</h2>
        <p>
          Apple or Google processes payments for coin packs, Bara+ subscriptions and permanent Bara+ purchases.
          We use RevenueCat to verify purchases and subscription status. We share an
          opaque billing account identifier, purchase and receipt identifiers,
          purchased products, subscription and permanent access status, and technical app and device
          information needed to process and restore purchases. Bara does not receive
          your full payment-card details. We do not send your health data or step counts to RevenueCat.
        </p>
        <p>
          We retain limited billing records, including transaction identifiers,
          benefit grants and refund adjustments, after account deletion to prevent
          duplicate grants, reconcile purchases and refunds, and handle billing
          support. For designated sandbox/test accounts, we also retain hashed
          sign-in identifiers after deletion to keep test purchases isolated from
          ordinary players. These records do not include health data. See
          <a href="/billing-terms">Bara Purchase Terms</a> and
          <a href="https://www.revenuecat.com/privacy">RevenueCat's privacy policy</a>.
        </p>

        <h2>Advertising</h2>
        <p>
          The iOS app shows <strong>clearly labeled ads</strong> (small banners
          and opt-in "watch an ad for a reward" offers) served by
          <strong>Google AdMob</strong>. On iOS we ask for App Tracking
          Transparency permission first; if you allow it, AdMob may use your
          device's advertising identifier to show more relevant ads and to
          measure ad performance across apps. If you decline, ads are
          non-personalized and every reward flow works exactly the same. AdMob
          may collect device identifiers (such as the advertising identifier),
          ad interaction data, and diagnostic data to serve and measure ads, as
          described in
          <a href="https://policies.google.com/technologies/ads"
            >Google's advertising policy</a
          >. When you choose to watch a rewarded ad, we also pass your Bara
          account identifier to Google so the reward can be securely credited to
          the correct account. The Android app currently shows no ads.
        </p>
        <p class="callout">
          Your health data, step counts, friends list, race names and race
          identifiers are not shared with advertising or measurement partners.
          Meta may receive a generic event indicating that you joined a race,
          as described below.
        </p>

        <h2>App Measurement on iOS</h2>
        <p>
          Supported versions of Bara for iOS use <strong>Meta App Events</strong>
          to understand app engagement and the effectiveness of ads for Bara.
          This is separate from the ads displayed inside the app. Meta may
          receive installs, app activation and session information, along with
          events for completing onboarding, joining a race, viewing the Shop,
          viewing Bara+ membership details, viewing coin offers and starting a purchase.
          An event for starting a purchase does not mean a purchase was completed.
          We do not send completed purchases, purchase amounts, receipts,
          subscription status or renewals to Meta through this integration.
        </p>
        <p>
          The action events Bara supplies contain only the action name. We do
          not include your Bara account identifier, email, username, profile,
          health data, step counts, friends list, race names or race identifiers.
          The Meta SDK may add technical app and device information and permitted
          identifiers, so this measurement is not anonymous. See
          <a href="https://www.facebook.com/privacy/policy">Meta's privacy policy</a>.
        </p>
        <p>
          Bara waits until it has successfully updated your privacy choices for
          the current app session before enabling Meta measurement. Where
          consent is required, measurement requires consent for Meta. Where a
          consent message is not required, we still honor applicable opt-outs,
          including US state privacy choices. Allowing an ad to load does not
          by itself authorize Meta measurement.
        </p>
        <p>
          Apple's App Tracking Transparency permission is separate from those
          privacy choices. Meta may collect the advertising identifier only when
          both your Meta privacy choices and Apple's tracking permission allow
          it. Declining Apple's tracking permission prevents advertising-identifier
          collection; it does not by itself disable all app measurement.
        </p>
        <p>
          You can review the available privacy choices in Bara's Settings and
          change Apple's tracking permission in iOS Settings. If you withdraw
          permission for Meta measurement, we stop sending new Bara action events
          and disable advertising-identifier collection and ordinary automatic
          event sending. This does not erase events already sent or cancel a
          transfer already in progress. The Meta SDK may retain queued data or
          continue some SDK-managed activity after it has been initialized.
        </p>

        <h2>Storage &amp; Security</h2>
        <p>
          Your data is stored on our server infrastructure. We use HTTPS for all
          data in transit. Session tokens are used for authentication and are
          refreshed regularly. Locally on your device, the app caches session
          credentials, health-authorization state, notification preferences, and
          your display name and step goal using the device's local storage (iOS
          and Android).
        </p>
        <p>
          Feedback submitted in the app is transferred to Google Workspace for
          delivery to Bara Support. Feedback, replies, general support messages,
          and account-deletion requests may remain in the support mailbox until
          a support operator manually deletes them. Access is limited to support
          operators.
        </p>

        <h2>Data Deletion</h2>
        <p>
          You can sign out at any time from the Settings tab, which clears your
          local session data and unregisters your device from push
          notifications. To request deletion of your account and its data from
          our app servers, including your discoverable-name fields and their
          private normalized search value, email
          <a href="mailto:support@barastep.com">support@barastep.com</a>. We
          will process deletion requests within 30 days. Account deletion cannot
          recall support email already sent to Google Workspace; those copies
          may remain in the support mailbox until manually deleted.
        </p>

        <h2>Children's Privacy</h2>
        <p>
          Bara is not directed at children under 13. We do not knowingly collect
          personal information from children under 13. If you believe a child
          under 13 has provided us with personal information, please contact us
          and we will delete it.
        </p>

        <h2>Changes &amp; Contact</h2>
        <p>
          If we make material changes to this policy, we will update this page
          with a new effective date. Continued use of Bara after changes take
          effect constitutes acceptance of the updated policy. Questions or
          concerns? Reach us at
          <a href="mailto:support@barastep.com">support@barastep.com</a>.
        </p>
      </div>
    </div>
  </main>

  <SiteFooter />
</template>
