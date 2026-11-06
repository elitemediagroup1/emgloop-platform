# TikTok website review resubmission

## Public website change

The signed-out root at `https://app.emgloop.com/` renders the public product website.
Signed-in visitors retain the redirect to `/app`; sign-in preserves safe requested destinations.
`/creator-hub` and `/integrations/tiktok` remain public for signed-in and signed-out visitors.
The footer on every product page exposes `/privacy` and `/terms` without opening a menu.
The existing login page also links to the product explanation and both policies.

The pages read no creator records, Gmail evidence or live business metrics. The homepage
workspace drawing is explicitly an illustration. Real creator images and private dashboards
are not published. No private route, OAuth scope or API authorization has changed.

## Before submitting again

1. Merge the public product website PR, wait for the matching Netlify production commit,
   and verify the root, both detail pages, policies and login without a session.
2. Use `https://app.emgloop.com/` as the Website URL. Keep the registered OAuth callback
   unchanged. A public website URL and an OAuth redirect URI serve different purposes.
3. Supply a dedicated creator reviewer account privately in Apply Reason, as the rejection
   note requests. Do not supply an employee, administrator or real creator account. Create
   the reviewer profile through existing authorized onboarding; do not bypass authentication
   or publish credentials. This website change does not create that account or send invitations.
4. For first-time integration review, configure the existing TikTok sandbox and target account.
   Record the real flow on the app.emgloop.com website: test-account sign-in, Profile → Social
   accounts, Connect TikTok, consent, callback, visible permitted data, and disconnect.
   Show every requested scope. Never label illustrations or fixtures as a successful API read.
5. Submit the explanation, private reviewer credentials and the actual sandbox demonstration
   in the developer portal. Return to Draft/resubmission is Matt's action. No approval is
   guaranteed by deploying the public pages alone.

The current integration reads basic identity, public profile, public counts and up to ten
recent public video details. It does not request avatar/cover images, publish posts, download
video files or run a background social feed. Production TikTok approval and automatic onboarding
media import remain separate outstanding work. The public copy states these limits.

Guidance checked November 6, 2026:
https://developers.tiktok.com/docs/en/app-review-guidelines
