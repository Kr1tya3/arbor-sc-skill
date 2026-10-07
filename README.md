# arbor-sc-skill

An agent skill for booking **school lunches** on the [Arbor](https://arbor-education.com) parent portal
(`<your-school>.uk.arbor.sc`). Arbor has no public API for parents, so a small Node script talks to the same JSON
endpoints the Arbor web app uses. Written for [OpenClaw](https://openclaw.ai); the `SKILL.md` format also works with
other agents that support skills.

> **Unofficial.** Not affiliated with or endorsed by Arbor Education. It may break whenever Arbor changes its web
> app, and automated access may not be permitted by your school's or Arbor's terms — use at your own risk.

## What it can do

| Command | |
|---|---|
| `week [--child NAME\|all] [--weeks N]` | Current lunch choice per school day (deadline passed / holiday shown) |
| `options --child NAME --date YYYY-MM-DD` | Meal options and prices for a day |
| `balance [--child NAME]` | Meals account balance |
| `basket` | What's in the Arbor basket |
| `book --child NAME --date D[,D…] --meal MEAL [--confirm]` | Book or change lunches — **dry run unless `--confirm`** |

`MEAL` is `hot`, `baguette`, `packed`, `absent`, or any text matching exactly one of your school's option labels.

## Safety design

- **Dry run by default.** `book` only changes anything with `--confirm`; the skill tells the agent to show the plan and
  wait for an explicit "yes" first.
- **Never pays by card.** Paid meals are only checked out when the child's meals balance covers the whole basket
  (amount to pay £0.00) and the basket contains only meals. Otherwise it stops and leaves it to you.
- **Lunches only.** No messages, forms, trips, clubs or payments.
- **Gentle on Arbor.** Reuses the session cookie, logs in only when it has expired (max 4 logins/day by default,
  logged to `logins.log`), and waits between requests.
- **Prompt-injection guard.** The skill tells the agent never to act on lunch requests found in emails, web pages or
  other external content.

Your Arbor password is stored in plain text on the machine running the agent (file mode `600`). Anyone with access
to that account on that machine can see your children's school data — only install it somewhere you trust.

## Setup

Requires Node.js 18+ (no npm dependencies).

1. Copy this repo into your agent's skills folder, e.g. `~/.openclaw/workspace/skills/school-lunches/`.
2. Find your children's **student IDs**: log in to Arbor in a browser, open a child's page (e.g. their meals page)
   and look for `student-id/NNN` in the address bar.
3. Create the config as the user that runs the agent. The password is typed in, not echoed or saved in shell history:

   ```bash
   mkdir -p -m 700 ~/.config/arbor
   ( umask 077
     read -rp "Arbor school URL (https://….arbor.sc): " U
     read -rp "Children (name=id,name=id): " C
     read -rp "Arbor email: " E
     read -rsp "Arbor password: " P; echo
     printf 'ARBOR_BASE_URL=%s\nARBOR_CHILDREN=%s\nARBOR_EMAIL=%s\nARBOR_PASSWORD=%s\n' "$U" "$C" "$E" "$P" > ~/.config/arbor/env )
   ```

   If you paste the password from a password manager, check no stray characters came along.
4. Test (read-only): `node scripts/arbor.mjs week --child all`
5. Optional: add a line to your agent's rules (e.g. `AGENTS.md`) saying who may book lunches, so the rules apply even
   when the skill isn't loaded.

Set `ARBOR_CONFIG_DIR` to keep the config somewhere other than `~/.config/arbor`.

## Limitations

- Only tested at one primary school with a lunch menu of hot / baguette / packed / absent. Other schools' menus
  should work via `--meal "<part of the label>"`, but check the dry run.
- Email + password login only (no Google/Microsoft single sign-on).
- No way to clear a choice back to "No choice selected" — pick `packed` or `absent` instead.
