# Hotfix: One-Time Neon Database Setup

> **STATUS: TEMPORARY. This endpoint MUST be removed in an immediate follow-up hotfix.**

## Why this exists

Migrations and the seed for Sprint 4 (Real Data Layer) cannot be run locally for
this project, and the Netlify build only runs `prisma generate` + `next build`
(it does **not** run `prisma migrate deploy` or the seed). As a result the live
Neon database starts empty and the app shows the "Database is not configured"
fallback.

To bootstrap the live database **from the deployed environment**, this branch
adds a temporary, token-protected endpoint:

    POST /api/admin/setup-database

    It runs, in order:

    1. `prisma migrate deploy` (applies the schema using a DIRECT, non-pooled URL)
    2. `prisma db seed` (idempotent demo data via the repository layer)

    ## Security model

    - The endpoint is **disabled** unless the `SETUP_SECRET` environment variable is
      set. If it is unset the route returns `404`.
      - Every request must present the secret via the `x-setup-token` header (or a JSON
        body `{ "token": "..." }`). The value is compared to `SETUP_SECRET` with a
          constant-time comparison. Wrong/missing token returns `401`.
          - The response never contains database credentials or connection strings. Only
            Prisma CLI status text is returned.
            - Only `POST` is accepted; `GET` returns `405`.

            ## How to run it (operator steps)

            1. In Netlify, set an environment variable `SETUP_SECRET` to a long random value.
               (Do **not** commit it; set it only in Netlify project settings.) Ensure
                  `DIRECT_DATABASE_URL` (Neon direct connection) is also set.
                  2. Trigger a redeploy so the function picks up the env vars.
                  3. Call the endpoint once:

                         curl -X POST https://app.emgloop.com/api/admin/setup-database \
                                  -H "x-setup-token: <the SETUP_SECRET value>"

                                  4. Expect `{ "ok": true, "migrate": "ok", "seed": "ok", ... }`.
                                  5. Verify data in the app: `/dashboard`, `/demo/timeline`, `/demo/intake`.

                                  ## REQUIRED cleanup (do this immediately after success)

                                  Once setup succeeds, open a follow-up hotfix that:

                                  - Deletes `apps/web/src/app/api/admin/setup-database/route.ts`.
                                  - Removes any `included_files` entries added to `netlify.toml` for this route.
                                  - Deletes the `SETUP_SECRET` environment variable in Netlify.
                                  - Deletes this document.

                                  Leaving a migrate/seed endpoint deployed is a standing security risk and is not a
                                  product feature. It exists only to perform a one-time bootstrap.

                                  ## Out of scope

                                  No business features, no real provider integrations, and no ServicesInMyCity
                                  production traffic are introduced by this hotfix.
                                  


## Browser-based alternative: /admin/setup-database

Because curl/CLI is not available locally, there is also an internal browser
page at `/admin/setup-database` that runs the same `runDatabaseSetup()` logic
server-side, without exposing `SETUP_SECRET` to the browser or chat:

- The page 404s unless `SETUP_SECRET` is set.
- - The operator types the confirmation phrase `RUN DATABASE SETUP` and clicks Run.
  - - A server action reads `SETUP_SECRET` from `process.env` only to gate execution; the secret is never sent to the client, rendered, logged, or returned.
    - - The result (migrate/seed status or error log) is shown on the page.
     
      - Files for this page (ALL temporary, remove in cleanup):
      - - `apps/web/src/lib/setup-database.ts` (shared `runDatabaseSetup()`)
        - - `apps/web/src/app/admin/setup-database/page.tsx`
          - - `apps/web/src/app/admin/setup-database/actions.ts`
            - - `apps/web/src/app/admin/setup-database/setup-form.tsx`
             
              - Updated cleanup checklist (do all of this in the follow-up hotfix):
              - - Delete `apps/web/src/app/admin/setup-database/` (page, actions, form).
                - - Delete `apps/web/src/app/api/admin/setup-database/route.ts`.
                  - - Delete `apps/web/src/lib/setup-database.ts`.
                    - - Remove the temporary `[functions] included_files` block from `netlify.toml`.
                      - - Delete the `SETUP_SECRET` environment variable in Netlify.
                        - - Delete this document.
                          - 
