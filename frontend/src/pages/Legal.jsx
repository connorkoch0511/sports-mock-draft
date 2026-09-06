import { Link } from "react-router-dom";
import { usePageTitle } from "../lib/usePageTitle";

/**
 * The privacy policy and terms, as two exports from one file.
 *
 * They exist because Google's OAuth consent screen requires a link to each
 * before an app can leave Testing, and they are public routes for the same
 * reason: Google follows them, and a signed-out visitor must be able to read
 * what happens to their data BEFORE deciding to sign in.
 *
 * Everything below is a plain description of what this app actually does. If
 * the app's behaviour changes, these change with it -- a policy describing a
 * different program is worse than none.
 */

const LAST_UPDATED = "5 September 2026";

function Page({ title, children }) {
  usePageTitle(title);
  return (
    <div className="mx-auto max-w-2xl px-6 py-16">
      <Link to="/" className="text-sm text-cyan-300 hover:text-cyan-200">
        ← PerfectPick
      </Link>
      <h1 className="mt-6 text-3xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 text-sm text-zinc-500">Last updated {LAST_UPDATED}</p>
      <div className="mt-8 space-y-6 text-[15px] leading-relaxed text-zinc-300">
        {children}
      </div>
    </div>
  );
}

function H2({ children }) {
  return (
    <h2 className="pt-2 text-lg font-semibold tracking-tight text-white">
      {children}
    </h2>
  );
}

export function Privacy() {
  return (
    <Page title="Privacy">
      <p>
        PerfectPick is a personal project — a fantasy football draft tool built
        and run by one person. This page describes exactly what it stores and
        what it does with it. It is short because the app does very little.
      </p>

      <H2>What is collected</H2>
      <p>
        You sign in with Google. Google tells the app your email address, your
        first and last name, and an identifier that is unique to you within
        this app. That is the whole of it — signing in grants no access to your
        Gmail, your contacts, your Drive, or anything else in your Google
        account, and none of those are requested.
      </p>
      <p>
        Alongside that, the app stores the things you make in it: your drafts,
        including every pick and the league settings you chose, and your big
        boards, including their names and the order you put players in. Each is
        stored against your user identifier so that it can be shown back to
        you.
      </p>

      <H2>Where it lives</H2>
      <p>
        In Amazon Web Services, in the US East (N. Virginia) region. Sign-in is
        handled by Amazon Cognito; drafts and boards are stored in DynamoDB.
        Your browser keeps your sign-in session in its own local storage so
        that you are not asked to sign in on every page.
      </p>

      <H2>Who can see it</H2>
      <p>
        Your drafts and boards are private to you. The app enforces this on the
        server: a request for a draft you are not part of, or a board you do
        not own, is refused — it does not matter who has the link.
      </p>
      <p>
        Nothing is sold, and nothing is shared with anyone. There is no
        advertising, no analytics, and no third-party tracking of any kind. The
        only outside services involved are Google, for sign-in, and Amazon Web
        Services, which hosts the app.
      </p>

      <H2>Player data</H2>
      <p>
        Player names, teams, rankings and statistics come from public NFL data
        sources and are refreshed automatically. That information is about
        professional athletes, not about you, and it is the same for everyone.
      </p>

      <H2>Deleting things</H2>
      <p>
        You can delete any draft or board from inside the app, and it is
        removed from the database rather than hidden. If you want your account
        and everything attached to it deleted entirely, email the address on
        the sign-in consent screen and it will be done.
      </p>

      <H2>Changes</H2>
      <p>
        If what the app does with data changes, this page changes at the same
        time, and the date at the top will say so.
      </p>
    </Page>
  );
}

export function Terms() {
  return (
    <Page title="Terms of Service">
      <p>
        PerfectPick is a free personal project, offered as-is. These terms are
        deliberately brief and say what you can reasonably expect.
      </p>

      <H2>What this is</H2>
      <p>
        A tool for building fantasy football big boards and running practice
        drafts against them. It is not affiliated with the NFL, with any
        fantasy platform, or with any of the data sources it draws on.
      </p>

      <H2>Your account and your content</H2>
      <p>
        You need a Google account to sign in. The boards and drafts you create
        are yours; the app makes no claim to them and does not use them for
        anything other than showing them back to you.
      </p>
      <p>
        Please do not use the app to attack it — automated abuse, attempts to
        reach other people&apos;s drafts, or anything that degrades it for
        others. Accounts doing that may be removed.
      </p>

      <H2>No guarantees</H2>
      <p>
        This is a side project, not a service with an uptime commitment. It may
        be unavailable, it may change, and it may stop existing. Rankings,
        projections and pick advice are opinions generated from public data and
        are frequently wrong — they are a starting point for your own judgement,
        not a prediction. Nothing here is betting or financial advice.
      </p>
      <p>
        To the extent the law allows, the app is provided without warranty and
        its author is not liable for any loss arising from its use, including
        the loss of a draft or a board.
      </p>

      <H2>Ending it</H2>
      <p>
        You can stop using the app at any time and ask for your data to be
        deleted, as described in the{" "}
        <Link to="/privacy" className="text-cyan-300 hover:text-cyan-200">
          privacy policy
        </Link>
        .
      </p>
    </Page>
  );
}
