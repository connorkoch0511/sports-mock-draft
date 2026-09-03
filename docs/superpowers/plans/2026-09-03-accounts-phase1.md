# Accounts Phase 1 — Identity

**Goal:** Sign in with Google and see who you are. Nothing is owned or
enforced yet.

**Architecture:** Cognito user pool with Google as the only identity provider,
hosted sign-in, Authorization Code + PKCE in the browser via `oidc-client-ts`.
Tokens are attached to every API call and ignored by every endpoint, so this
phase changes no behaviour and can ship on its own.

## Global Constraints

- The Google client secret is a `NoEcho` template parameter sourced from SSM.
  It never enters git, the template, or any log line.
- No auth behaviour changes in this phase: no route gains an authorizer, no
  handler reads a claim. Attaching a token must be inert.
- PKCE and state handling come from `oidc-client-ts`, not from code here.
- The app must remain fully usable signed out, exactly as today.

---

### Task 1: Cognito in the template

**Files:** `backend/template.yaml`

- Parameters `GoogleClientId` and `GoogleClientSecret` (`NoEcho: true`), plus
  `AuthCallbackUrl` and `AuthLogoutUrl` defaulting to the CloudFront origin.
- `AWS::Cognito::UserPool` — email as the sign-in alias, no password policy
  worth tuning because no password is ever set here.
- `AWS::Cognito::UserPoolIdentityProvider` of type `Google`, mapping
  `email`, `given_name`, `family_name`, and `sub`.
- `AWS::Cognito::UserPoolClient` — authorization code flow, `openid email
  profile` scopes, `SupportedIdentityProviders: [Google]`, no client secret
  (public SPA client), callback and logout URLs from the parameters.
- `AWS::Cognito::UserPoolDomain` — a prefix domain.
- Outputs: `UserPoolId`, `UserPoolClientId`, `AuthDomain`.

**Verify:** `sam validate`, and `aws cloudformation describe-stacks` shows the
three outputs after deploy.

### Task 2: The auth module

**Files:** create `frontend/src/lib/auth.js`, `frontend/src/lib/AuthContext.jsx`

- `oidc-client-ts` `UserManager` configured from `VITE_*` env vars, using
  `WebStorageStateStore` on `localStorage` so a refresh survives a reload.
- `AuthProvider` exposing `{ user, signIn, signOut, isLoading }`; `user` is
  null when signed out.
- `getIdToken()` returns the current id token or null — the single place
  `api.js` reads from, so token plumbing has one home.
- Silent renew enabled, so an expired token refreshes without a redirect.

**Verify:** unit tests for the pure parts — a null user yields a null token,
an expired user is treated as signed out.

### Task 3: The callback route

**Files:** create `frontend/src/pages/AuthCallback.jsx`; modify
`frontend/src/App.jsx`

- `/auth/callback` completes the redirect, then navigates to where the user
  started (or `/`).
- A failed callback shows the error rather than a blank screen, and offers a
  link home. Auth failures are the ones people cannot debug themselves.

### Task 4: Sign in / sign out in the nav

**Files:** modify `frontend/src/components/NavBar.jsx`

- Signed out: a "Sign in" button.
- Signed in: the user's email (truncated) and "Sign out".
- Neither blocks anything yet — every page still works signed out.

### Task 5: Attach the token

**Files:** modify `frontend/src/lib/api.js`

- `req()` adds `Authorization: Bearer <idToken>` when a token exists.
- It must be genuinely optional: no token means the header is absent, not
  empty, so today's endpoints see exactly what they see now.

**Verify:** an e2e test asserts a signed-out request carries no
`Authorization` header, and a signed-in one carries a bearer token.

### Task 6: Document the manual step

**Files:** modify `README.md`

The Google Cloud project, OAuth client, consent screen, authorized redirect
URI, and putting the secret in SSM. Written so the account owner can follow it
without reading this plan.
