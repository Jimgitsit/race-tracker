# race-tracker — Design Doc

**Status:** in build · **Written:** 2026-07-30 · **Revised:** 2026-07-30 (decisions locked)

A dead-simple double-elimination bracket tracker for a Hot Wheels race. No times, no
scores — every heat has exactly one winner and one loser. Three views: racers on their
phones, the race director on a phone, and the full bracket on a big screen.

**Known facts about the event** (these drive most of the decisions below): ~25–30 racers,
so a **32-slot bracket**. Mostly **adults, drinking**, plus a couple of kids. It runs a few
hours on **one track**. It happens **every year**, and past years must be kept.

---

## 1. Scope

**In:**
- Open self-registration: a racer enters a name and is entered in the race. Optional photo
  of their car.
- Double-elimination bracket, generated when the director locks the roster.
- A **16-racer consolation bracket** (single elim) the director can start once people have
  been knocked out, and interleave with the late main-bracket heats.
- Racer view (mobile): who's racing now, the bracket, the roster.
- Director view (mobile, password-gated): who's up, tap the winner, undo.
- Big-screen view: the bracket, auto-updating, driven from a **laptop HDMI'd to the TV**.
- **QR codes everywhere** for joining, because 30 tipsy adults will not type a URL.
- **Yearly archive**: a finished race is frozen and viewable forever at `/history`.

**Out:** times, lane assignments, heats of >2 cars, accounts/passwords for racers,
multiple *concurrent* events, a single/double-elimination format toggle (double, always).

---

## 2. Stack

| Piece | Choice | Why |
|---|---|---|
| Runtime | Bun | House default. |
| Server | single `server.ts` using `Bun.serve` | One file is enough; matches `bandsaw-tensioner`, `or-name`. |
| DB | SQLite via `bun:sqlite`, file `data/race.db`, **WAL** | Single-box, single-event, tiny. **Not Neon** — a shared autosuspending compute is the wrong tool for something this small and this latency-sensitive on race day. |
| Frontend | React 19 + Vite → `dist/`, served static by `server.ts` | Real interactive state across three views. |
| Live updates | SSE (`EventSource`) | One-way server→client, auto-reconnects for free, no polling. |
| Photos | files on disk under `data/photos/<year>/`, resized **client-side** | No server-side image library. Local disk, so a flaky uplink can't break race day. |
| Archive backup | **AWS S3**, written once per year | Offsite copy of an accumulating archive. Off the race-day path entirely. |
| QR | `qrcode` npm, rendered to canvas | Small, standard; not worth hand-rolling an encoder. |
| Port | **58013** | Next free (58000–58012 taken — see `wiki/notes/serving-infra.md`). |
| Route | `https://jimmcgowen.com/race-tracker/` | Path-prefix mount, per house convention. |

**Do not** reach for a bracket library. Both credible options are a poor fit here:
[`brackets-viewer.js`](https://github.com/Drarig29/brackets-viewer.js/) is vanilla-DOM
(awkward inside React) and pulls in the `brackets-manager` data model;
[`react-tournament-brackets`](https://github.com/g-loot/react-tournament-brackets) is
LGPL-2.1 (a wrinkle for a public repo) and you'd override its match card anyway, since car
photos are the whole point of ours. The genuinely hard part is loser-bracket routing, and
§4 specifies that outright.

**S3, not R2.** R2's headline advantage is zero egress, and a backup is written once a year
and read approximately never — so the advantage doesn't apply. AWS creds are already
configured machine-wide (`cli-agent`, account `535836328331`, us-west-2) and inherited by
every project under `~/dev-local`, while R2 would mean a new bucket, its own CORS, and the
wrangler local-vs-remote footgun documented in `wiki/notes/cloudflare-wrangler.md`. Bun
ships `Bun.S3Client`, so this is a few lines and no SDK.

---

## 3. Views

Everything is **mobile-first** except `/display`, which is **big-screen only** (assume
landscape 1080p+, viewed from across the room, driven by a mouse if at all).

`/director` is a phone layout that stays a phone layout on a laptop: capped at a 720px
column and centred above 760px wide. There is no second column of work to put beside it, and
stretched full width it only moves the two tap targets further apart. The director will be
on a phone; the laptop is the backup, and the same layout has to serve both.

Routing is path-based with a catch-all → `index.html` fallback in `server.ts`, so the TV
URL stays typeable (`jimmcgowen.com/race-tracker/display`). All in-app links must be
**relative** — the app is mounted under a prefix (Vite `base: '/race-tracker/'`).

### 3.1 Racer view — `/` (mobile)

**First visit** (no token in `localStorage`):
1. Name entry. Single field, big button. Reject empty and duplicate names (case-insensitive)
   with an inline message. A secondary **"Just watching"** link goes straight to the
   spectator view (§3.1a).
2. "You're in!" → optional "Add a photo of your car" (camera or library). Skippable, and
   addable later from the Racers tab.
3. Store the returned token in `localStorage`. That token is the racer's identity forever
   after — no password.

**Returning visit:** straight to the main screen. Three tabs, sticky bottom nav:

**`Now`** — the default tab, and the one people will actually stare at.
- Big card: **NOW RACING**, the two cars side by side (photo, name), a `VS` between them.
- If the viewer is in this match, the card gets a loud accent border and a "**That's you!**"
  label.
- **When a result lands, the card holds it for 4 seconds before moving on.** The winner's
  photo gets a green ring and **`WINNER!`** scales down onto it from oversized; the loser
  dims and strikes through; then the card fades to the next heat. Everyone in the room is
  looking at their phone, so the moment of winning belongs there too, not only on the TV.
  Green stays **on the photo only** — the card keeps its own border, so "this heat is yours"
  and "this car won" remain two separate statements rather than one ring changing meaning.
  Driven by the same `useResultFlash` the big screen uses, and byes are `state: "bye"`, never
  `"done"`, so a bye cascading off the back of the result can't be mistaken for it.
- Below: **On deck** — the next two matches, compact.
- Below that: **Your status** — one line, always answerable:
  - `Your next race: vs Emma — Winners Round 2`
  - `Your next race: vs TBD — Losers Round 1`
  - `You're up next!`
  - `Knocked out — top 12 of 30` (with the two racers who beat you)
  - `🏆 You won!`
- Before the roster is locked, this tab shows the waiting state instead: racer count,
  "Waiting for the race director to start," and a **Share** button (§3.5).

**`Bracket`** — the mobile bracket. **Do not attempt the classic connector-line tree here**;
it is unreadable on a phone. Instead:
- A `Winners bracket / Losers bracket / Finals / Consolation bracket` segmented toggle at the top.
- Rounds as horizontally scrollable columns, snap-scrolling, round name in a sticky header
  (`Winners Round 2`). Each column is a vertical list of match cards.
- A match card: two rows (photo thumb, name), winner in bold labelled **`Winner`**, loser
  dimmed and struck through. A word rather than a ✓ — a tick needs the legend to decode it,
  and this is not a room where people look things up. Unfilled slots read what fills them,
  in words (`Winner of Ada vs Jim`), never a match code.
- A **"My path"** chip that dims every match the viewer isn't in — this is what makes the
  bracket usable on a phone. Default it **on** for a registered racer.
- The bracket toggle and the "My path" chip **persist across a refresh**, alongside the
  active tab. Someone who has picked Losers and turned their path off has said what they
  want to look at; a reload is not them changing their mind.
- Tapping a match opens a detail sheet: both cars full-size, round, result.

**`Racers`** — grid of cards, 2-up: car photo, name, `2–0` record, and status
(`Racing` / `1 loss` / `Out — top 12`). Tap for a detail sheet with that racer's match
history. The viewer's own card is first and has an `Edit` affordance (change name / add or
replace photo) — name edits only allowed before the roster locks.

### 3.1a Spectator view — `/` with no identity

Most people in the room aren't racing. Anyone who opens `/` without a token gets the **same
four tabs** as a racer, not a cut-down page: they're standing at the same track looking at
the same bracket, and everything except *your* status, *your* photo, *your* alerts and
*your* path through the bracket is equally theirs to read. Internally this is the racer view
with `meId: null`.

- Before the roster locks, `/` is the sign-up form; "Just watching" opts into the spectator
  view and is remembered across a refresh. From there a **"Changed my mind — I'm racing"**
  button goes back to sign-up while registration is still open.
- Once the roster locks there is no sign-up left to show, so `/` **is** the spectator view.
  (It used to be a dead end offering `/display` on a phone, which is the wrong shape for a
  hand.)
- Messages: broadcasts only, and they come from the public state payload rather than
  `/api/me/messages` — a spectator has no token, and direct messages are not theirs.
- A **Big screen** button in the header flips to `/display` and back. It only appears for
  spectators; a racer's header keeps Share alone.

### 3.2 Director view — `/director` (mobile)

Password screen first (§7). One password, hard-coded, no username.

**Registration phase:**
- Live roster list: photo, name, joined-at. Swipe or tap to remove a racer (mis-entries,
  duplicates). Inline rename.
- Racer count, big and obvious. A **Show join QR** button, always reachable.
- **`Lock roster & start race`** — confirm sheet first, stating what's about to happen:
  *"30 racers → 32-slot bracket, 2 byes. Registration closes."* The sheet also carries a
  **review-names nudge**: self-registration plus drinking produces names you may not want
  six feet tall on a TV with kids in the room, and this is the last moment it's actionable.

**Racing phase** — this is the screen that matters. The director is standing at a track
holding a phone, so it has to work with one thumb and no reading.
- Top: round label (`Winners Round 2 · Match 3`).
- The body is **two giant tap targets**, stacked, each ~40% of the viewport: car photo as
  the background, name across it. Tapping one means *this car won*.
- Tap → confirmation sheet (`Maya wins?` / `Cancel` / `Confirm`) — one guard against a
  fat-finger, no more. On confirm: record, advance, auto-select the next ready match.
- **1-second lockout on the tap targets after a confirm.** Two 40%-viewport buttons plus
  impaired motor control means a double-tap will otherwise blow straight through the next
  match's confirm sheet.
- **Multi-level undo**, not one-deep. `results_log` is already an append-only stack and
  undo is the exact inverse of the edge walk, so popping LIFO repeatedly *is* multi-level
  undo — it's nearly free, and the director will not always notice the mistake immediately.
- Below the fold: **Next heat**, which offers the same choice two ways, because they answer
  different questions. **Ready** is a flat list of what can be run right now — short,
  ordered, no thinking — for when a racer has wandered off and you want a different heat.
  **Bracket** is the same columns the racers and the big screen see, for "where are we",
  which is the question that gets asked out loud and which the director, alone in the room,
  has no screen for. Both set the current match; which one was last used is remembered.
  In the bracket only a *ready* heat is tappable, and a match with no action renders as a
  plain card rather than a dead button — there is nothing to press that does nothing. It
  **opens scrolled to the heat that's racing**, so it answers "where are we" before it is
  touched; in a bracket the live heat isn't in, the first pickable heat stands in. Then it
  leaves the scroll alone — a result landing mid-look must not move the view under your
  finger. The columns scroll in their own box rather than scrolling the sheet, so the tabs
  stay put. Once the consolation bracket exists, its matches appear in both — that is the
  whole of "mix it in at the director's discretion."
- **`Start consolation bracket`** appears once ≥8 racers are eliminated (§4.6).
- Tapping a racer anywhere in the director view offers **Re-link** — a QR carrying that
  racer's existing token, for someone who cleared their browser or switched phones (§3.5).
- A collapsed link to the full bracket.

**Complete phase:** podium — 1st, 2nd, 3rd with photos, then two exits:
- **`Archive & start next year`** — the normal path. Freezes this year (§5) and returns to
  registration.
- **`Reset event`** — for a mis-start. Double-confirm, and it **refuses outright while an
  unarchived complete event exists**, so it can't eat a year.

### 3.3 Big screen — `/display`

Landscape, glanceable from 15 feet, and — new — **drivable with a TV remote**. It is not
required to show the whole bracket at once; a 32-slot double elim is 62 matches and forcing
them all on screen makes every one of them unreadable. Culling is what buys back the room
for car photos.

**Phases:**
- **Registration:** a giant **join QR**, the event name, the racer count, and the roster
  filling in live. The TV is idle during registration anyway, and this is what solves
  onboarding for a room of people who won't type a URL. **The roster fits — it never
  scrolls**, because the whole point is that whoever just scanned the QR finds their car on
  the screen, and nobody is going to scroll a TV. Card size follows the roster (the column
  count is chosen so the rows fit the box) between a floor that keeps names readable and a
  ceiling so the first three arrivals aren't billboards. A phone can't always win that and
  falls back to scrolling, which is fine — a phone scrolls.
- **Racing:** banner + bracket + on-deck strip (below).
- **Complete:** podium, then the final bracket.

**Racing layout:**
- **Top band (~22% height).** `ON DECK` in the left corner, the head-to-head in the middle,
  the join QR in the right corner. Both cars cluster toward the centre — the left one is
  `justify-content: flex-end`, the right one `flex-start` — so the outer corners were dead
  screen. Putting the next heats there means what's coming next and what's running now are
  one glance apart rather than at opposite edges of the room. On deck **stacks** rather than
  running along a strip: the corner is tall and narrow, so the band's full height is
  available and almost none of its width. A hairline separates the pairs — with only a gap,
  three of them read as one long sentence of names.
- **NOW RACING**, the middle of that band. Two cars, photos as large as the row allows,
  names in a very large weight, `VS` between. When a result lands the banner runs **the same
  celebration as the racer view** (§3.1): a green ring on the winner's photo, their name in
  green, **WINNER!** landing on the photo oversized-and-transparent then scaling down onto
  it, and the loser dimmed and struck. It holds ~4s, then the banner swaps to the next match.
  This animation is the thing that makes a room look up — and it is the *same* animation on
  the phone in your hand and on the screen across the room, on purpose.
- **Body: the bracket, auto-framed** (below).
- **Foot strip:** the latest director message and nothing else, so it is **not rendered at
  all** when there is no message and the bracket takes the height back. The message carries
  an **×**; dismissal is local to this screen, persisted, and stored as a **high-water mark**
  rather than an exact id — so a message deleted server-side can't resurface one already
  closed, while anything newer still gets through. It neither touches what racers see on
  their phones nor swallows the next message. The × fades in with the toolbar — it is for
  whoever is driving, not the room.

The **heat count** lives in the top-right corner above the join QR, flush to the edge so the
two read as one block against the on-deck list opposite. It is `HEATS RUN 49 / 71` — heats
*already raced*, not which heat is on the track, and worded to stay distinct from the
director's own `heat 50 of 71`, which is the same figure plus one.

On a phone on-deck and the QR go entirely: there is no width to spare beside the two cars,
and neither earns it there — nobody scans the QR on the phone in their hand, and on deck is
one tap away on the racer view they just came from. The heat count is a few characters and
stays; it is the only progress the screen shows now that the footer is message-only.

**Auto-framing.** The display keeps a *focus round* (the one containing the current match)
and renders every round at one of three densities:

| Density | Shown | Applied to |
|---|---|---|
| `full` | photo + name per slot | focus round and its immediate neighbours |
| `compact` | name only, smaller | two rounds out |
| `collapsed` | thin strip: round code + `✓n` | fully-decided rounds further back, and future rounds with no filled slots |

Then measure the composed bracket and scale it to fit
(`transform: scale(min(vw/w, vh/h)); transform-origin: top left`), re-measuring on resize.
Because culling already did most of the work, the scale rarely drops far below 1 — which is
exactly what keeps photos legible.

**Focus is automatic and stays automatic.** It follows the current match, and the arrow keys
can step it while fitted. Clicking a column to focus it was built and removed: with Follow
on, focusing re-flows the layout, which makes Follow re-aim on the live heat — so the click
appeared to do nothing, and in "All rounds" it genuinely did nothing, because that mode
forces every column compact before focus is consulted. Nobody missed it. Don't re-add a
click target here without first making it survive both of those.

**Reset needs an override, and the override is a second ask.** A finished race that hasn't
been archived is refused, because a stray tap would eat a whole year. But reset is *the
documented way out of a false start*, and a false start that reaches `complete` is exactly
what that guard blocks — so without an escape hatch the one case reset exists for is the one
case it cannot do. The guard stays the default; the first refusal arms an override, states
what goes with it (racers, recorded heats, every photo) and relabels the button **"Delete
without archiving"**. `resetEvent(force)` on the server, `{ force }` on the wire, tolerant of
a missing body so a stale cached page reads as *no* override rather than erroring.

**Terminology: always "*X* bracket", never a bare "*X*".** Winners/losers is the most common
naming for double elimination (Wikipedia also lists upper/lower, championship/elimination and
main/repechage), so that is what this uses — but always **qualified**. "Winners" alone names
the people who have won, and at the point anyone is reading the screen nobody has; "Winners
bracket" names the half of the draw. The same for the losers and consolation brackets.
**Finals** is the exception and stays bare: those matches conclude the draw rather than being
a bracket of their own. "Consolation" is never a synonym for the losers bracket here — this
event has a real, separate consolation bracket, and the collision would be genuine.

**Bracket titles.** Each bracket carries a quiet heading — `WINNERS BRACKET`, `LOSERS
BRACKET`, `FINALS`, `CONSOLATION BRACKET` — above its columns, with the hairline separator
that already divided the groups. `GF` and `GFR` are separate brackets internally but share one heading; they are all
"the finals" to anyone reading the screen. Deliberately understated: brighter than the round
labels beneath it and wider-tracked, but no larger, so it names the half of the bracket you
are looking at without competing with the racers' names. The wrapping elements are all
statically positioned, so match boxes still measure their offsets against `.disp-scale` and
the connectors are unaffected.

**Track connectors — the signature.** Connectors are not generic elbows: they are drawn as
**Hot Wheels track**, in orange, with the raised-rail cross-section. Draw each edge as an
SVG path stroked **twice** — a wide stroke in the rail colour, then the same path stroked
narrower in the darker bed colour. The 2px of rail colour left showing on each side reads as
the raised rails, with no path-offsetting maths. Winner edges are full orange; loser edges
are dimmer.

When a result lands, the winner's photo chip **travels along the connector** into their next
match — `offset-path: path(...)` with the same `d`, animating `offset-distance` 0→100%.
Under `prefers-reduced-motion`, the chip appears at the destination instead.

**Driving it.** The big screen is a **laptop in Chrome, fullscreen, HDMI'd to the TV** — the
TV's own browser was tried and is not viable (it is far behind the Vite build target, so the
bundle does not run at all, before any question of layout). That makes a mouse the primary
input and the keyboard a fallback, rather than six D-pad keys being the whole vocabulary.

Default behaviour is still **auto-pilot** — zero interaction, follows the action. The
toolbar and the mouse cursor both fade in on pointer movement and back out after 2.5s idle,
because this is a display first and an operator surface second.

Two settings, deliberately **orthogonal**, replacing the old five-way `AUTO → WINNERS →
LOSERS → CONSOLATION → EVERYTHING` cycle in which `AUTO` and `EVERYTHING` showed the same
brackets and differed only in density — the part that made the control unlearnable:

| Control | Values | What it changes |
|---|---|---|
| **Bracket** | All · Winners bracket · Losers bracket · Consolation bracket | which brackets are on screen (Consolation only appears once one exists) |
| **All rounds** | off / on | off = collapse what's settled (the density table above); on = draw every round the same size |
| **Follow** | off / on | size the live heat to ~11.6% of the frame's *height*, centre it with the rounds either side readable, re-aim as the race moves |

| Gesture | Action |
|---|---|
| Pinch | zoom, anchored on the pointer — the thing you're looking at stays put |
| Drag | pan, only once the bracket outgrows the frame |
| Double-click | back to fit |
| ↑ / ↓ / `+` / `-` | zoom in / out |
| ← / → | pan when zoomed; step the focus round when fitted |
| Enter | cycle the bracket filter · `d` all-rounds · `a` follow · `s` sound · `f` fit · Esc reset |

**A plain wheel deliberately does nothing; a pinch zooms.** Scroll-to-zoom was tried and
removed — on a trackpad it fires constantly by accident, and this screen is in front of a
room. A pinch is never accidental, so it survives the same objection, and the two can be told
apart cleanly: macOS and Windows both report a trackpad pinch as a **wheel event with
`ctrlKey` set**. So the handler ignores every wheel that doesn't carry it.

Two-finger touch is handled separately, by tracking pointers: a second pointer converts an
in-progress drag into a pinch, and lifting back to one pointer ends it *without* resuming the
drag — that finger has moved since it went down, so resuming would make the bracket jump.
Both paths anchor off the scale and offset the gesture **started** at rather than the live
ones, so a long pinch can't accumulate rounding drift and slide out from under the fingers.

`touch-action: none` sits on `.disp-canvas` unconditionally, not only when the bracket is
pannable: at fit there is nothing to pan, but a pinch still has to reach the app rather than
zooming the whole page. Nothing is lost — `.disp` is a fixed-height, overflow-hidden screen
with no page scroll behind it.

**Sound.** One sound, on the big screen only: a real dragster launching as the winner's car
runs up its connector.

The clip is a 1.7s cut from a **CC0 / public-domain** recording — "auto performance dragster
take off", [freesound.org sound 637195](https://freesound.org/s/637195/) by *kyles*. CC0
imposes no attribution obligation; the provenance is recorded because knowing where an asset
came from is worth more than the licence demands. The source is 12.5s and its power builds
to a peak around 4.5s, so the cut is **3.0–4.7s** — the launch itself, not the quiet approach
that precedes it. Gained, limited, faded at both ends so it neither clicks nor outlasts the
animation. **24 KB**, bundled by Vite with a content hash.

A synthesised engine (two detuned sawtooths through an opening lowpass, plus a band-passed
noise burst) remains as a **fallback** if the clip ever fails to decode. It is markedly worse
— which is why the clip exists — but a screen that makes a noise beats one that has silently
failed. Anything ripped from a streaming site is not an option here regardless of how private
the event is, and CC0 gets the same result with none of the problem.

Two things follow from browser autoplay rules. The `AudioContext` is created **lazily**, on
the first real gesture, so an unattended screen never logs a blocked-autoplay warning; and a
gesture means a click or a keypress, **not** the mouse move that reveals the toolbar — so the
window listens for `pointerdown` and `keydown` and unlocks on either. Until then `playLaunch`
is a silent no-op, and callers never have to check. Decoding happens **at unlock**, not on
first use, so the first result of the evening isn't the one that waits for it.

The **Sound** toggle is on by default and persisted, and the trigger is latched on the match
id, so an unrelated push mid-celebration — or toggling the sound on part way through one —
can't retrigger it. Never on the racer view: thirty phones in one room all launching at once
is a different product.

**Settings survive a refresh.** Bracket, All rounds, Follow and the dismissed-message mark
all persist to `localStorage` — the screen runs unattended for hours and a stray reload
shouldn't drop it to defaults mid-race. They are written from effects rather than from each
handler, so *every* path that changes a setting persists it, Esc included: reset routes
through the same setters and writes the defaults back, rather than leaving a stale value to
reappear on the next refresh.

Zoom and pan are deliberately **not** kept. A pan is only meaningful against the layout it
was made in, and that changes with the window, the round and the bracket — restoring one
lands the view on empty space. Follow is the reason to be zoomed in, and it *is* persisted,
so the case worth restoring restores itself.

A stored bracket filter can name a bracket that no longer exists (Consolation, saved last
year), so it falls back to All rather than leaving no button lit while the bracket quietly
shows something else. Esc resets the *view* only — it does not un-dismiss a message or unmute
the sound, because closing one and muting the other are deliberate acts, not
a view setting.

Zoom is bounded **relative to fit**, never absolutely: fit for the full 62-match bracket is
around a third of life size, so an absolute floor would mean pressing zoom-out made the
bracket bigger. Floor is fit itself (there is nothing below it to see) and zooming back out
through it returns to fit proper, which recentres.

**Follow mode** centres the live heat, so the round that fed it and the round it feeds are
both on screen either side — where these two racers came from and where the winner goes are
the two questions the bracket is there to answer.

Centring alone doesn't deliver that, and this is the trap: **density is decided on playing
order, but the layout is grouped by bracket.** Playing order interleaves W and L, so the next
winners round is two or three steps away *in time* while being the very next column *on
screen* — and it gets collapsed to a stub as "untouched" while sitting right beside the live
heat. So in follow mode, a collapsed column immediately adjacent to the focus **in the
laid-out order** is promoted back to `compact`. Only in follow mode: when fitting the whole
bracket a settled round is the biggest waste of space on the screen (winners round 1 is
sixteen matches tall) and collapsing it is what lets everything else be drawn large. Follow
doesn't pay that cost, because its zoom comes from the card rather than from fit.

Its zoom is chosen so the live heat's **card is ~9.3% of the frame's height** — a request,
floored at `fit`, and at this setting the floor is what usually wins on a 1080p+ screen. That
is deliberate: once the whole bracket is readable there is nothing below fit worth showing,
so follow settles into centring the live heat and expanding the rounds either side rather
than magnifying anything. Note the feedback loop if you tune this further — turning follow on
promotes the neighbouring collapsed rounds to `compact`, which enlarges the tree and so
*lowers* fit, meaning a smaller share can produce a slightly larger card. The zoom is
explicitly *not* a multiple of fit. Fit is a moving target: it rises as rounds settle and
collapse, as a filter narrows to one bracket, as the window changes shape. A multiple of it
meant the heat kept growing through the evening — legible in winners round 1 and far too
close by the losers rounds. Only the whole bracket's laid-out size moves, which is exactly
what makes fit move; the frame and the card are stable, so anchoring between those two holds
the apparent size steady for the entire race and scales with the screen rather than against
it. No extra container is needed: `.disp-canvas` is already a fixed frame.

**Height, not width — this matters and is not obvious.** A card's *width* is set by the
longest label anywhere in its column, because `.disp-col-body` is a flex stack and every card
stretches to the widest one. Losers columns carry source labels ("Loser of Wheelsy
McWheelerson Jr. vs Emma"), so a losers card lays out 370px wide against a winners card's
249px **for the very same two names**. Anchoring on width therefore held the card's screen
width constant and shrank the *text* by a third the moment the race reached the losers
bracket — every losers heat, in every view. Height is immune: names are single-line `nowrap`
and the avatar is a fixed size, so the card is 87px tall in both brackets. Holding height
steady holds the text steady, which is the thing anybody is actually reading.

A consequence worth expecting: **the zoom readout drifts while following**, because it reads
as a percentage of fit and fit is the thing that moves. The apparent size is the constant,
not the number. If the live heat isn't rendered at all — filtered out, or in a collapsed
round — follow has nothing to aim at and does nothing. It re-aims on layout, not on a timer, so a collapsing round or a
resized window moves it too. Any hand on the controls (a drag, a zoom, a filter) drops it:
auto-framing that fights the person driving is worse than none.

**It holds through a result, and only through a result.** What follow aims at *lags* the
live heat by `FLASH_MS` — `currentMatch` advances the instant the director saves, which is
the start of the celebration and not the end, so aiming straight at it panned the screen out
from under the winner's chip while that chip was still travelling its connector. Lagging
keeps the finished heat framed for the whole animation and lands the move on the same beat
as the banner swapping, so the screen turns its attention once rather than twice.

The test for "is there anything to wait for" is **whether the heat we are framed on has
reached `done`**, not merely that `currentMatch` moved. When the director swaps the matchup
by hand the old heat is still `ready`, nothing is animating, and pausing on a heat they have
deliberately moved off is only slow.

The lag lives in the *target*, not in a guard that reads the flash. Effects run
child-before-parent, and the flash is set in an effect up in `Racing`: on the render where
the result lands, the canvas still sees the previous value and would re-aim before any guard
could fire. Anything downstream of the flash has this ordering problem — move the delay into
the state being watched, never into the reaction.

The pan clamp carries **a third of a frame of slack** past each edge. Without it the clamp
refuses to show any background at all, so a heat in the first or last round cannot be
centred — the live heat would drift between the middle and hard against the edge depending
on which round it is in, destroying the one thing follow mode is for.

**Measure the tree, never the wrapper.** The fit maths reads `.disp-tree`, because
`.disp-scale` also contains the connector SVG — which is sized *from that measurement*. Read
the wrapper and the size becomes its own input: it ratchets, the SVG props up the wrapper's
`scrollHeight`, and the measured height can never shrink again. Fit then stays pinned at
whatever the tallest layout ever needed, so collapsing a round buys space that fit never
spends. This shipped for a while; "All rounds" was 25% smaller than it should have been and
a single-bracket filter nearly half.

- Completed matches: winner bold, loser dimmed and struck. The current match pulses.
- Request a `navigator.wakeLock` so the TV doesn't sleep, and re-request it on
  `visibilitychange` (browsers drop the lock when the tab is backgrounded).
- No auth. Anyone who can reach the URL can watch — that's the point.

**On a phone.** A spectator can flip here from `/` (§3.1a), so the layout has to survive a
viewport it was not drawn for. It stays one 16:9-shaped screen, scaled down — it does not
reflow into a phone layout, because the phone layout already exists one tap away.

- Sizes clamp against **`vmin`, not `vh`**. On any landscape viewport the two are identical,
  so the TV is untouched; in portrait, `vh` sizes the banner off a dimension the screen
  doesn't have and shoves the far car off-screen.
- Grid tracks are `minmax(0, …)`, never a bare `1fr`: a `1fr` track floors at its content's
  min-content width, which is the same bug from the other direction.
- Below TV size the size floors come off (they exist so nothing shrinks on a 65" screen),
  the banner row takes only the height it uses instead of a fixed share, and the footer QR
  goes — nobody scans the phone they're holding.
- A **Back** control appears *only* when a phone navigated here in-app, never on a TV opened
  straight at the URL. In portrait it also carries a "turn your phone sideways" hint and the
  banner gets a lane so the two don't overlap.

### 3.4 Messages and alerts

**Director messages.** The director can send a line to **everyone** or to **one racer**, from
either phase, with one-tap presets for the things they'll actually send ("You're up — get to
the track!", "Where are you? You're holding up the race."). 140 characters, because this is a
tannoy, not a chat.

Broadcasts are public and ride along in the state payload; **direct messages never do**.
`/api/state` is served without auth, so a direct message must not appear in it — not even as
metadata about who was messaged. Instead the payload carries a `messageEpoch` that bumps on
*any* message, and a client holding a racer token refetches `/api/me/messages` when it moves.
One extra round trip, only when there's actually something new. A spectator has no token, so
their messages are `state.announcements` — the broadcasts, and nothing else.

**Where a message shows up.** One message at a time, never a thread, but never a dead end:

- **Now tab:** a card with the newest unread message, an `×` to dismiss it, and the whole
  card tapping through to the full list. Once nothing is unread the card becomes a quiet
  **All messages (n) →** link in the same slot, so messages are always in one place.
- **Any other tab:** the same message **slides down from the top** over whatever you're
  looking at, with its own `×`. The chime says *something* was said; it doesn't say what, and
  a message you can't read until you find the right tab is a message that didn't arrive.
- **The list** is a sheet: every message, newest first, clock time *and* relative time,
  labelled `For you` / `Everyone`.

Read state is **one high-water-mark id in `localStorage`**, not a per-message set: messages
arrive in order and get read in order, so an id is the whole of the state and it survives a
refresh. Dismissing and opening the list both mark everything read — after either, there is
nothing left to interrupt anyone with.

**Alerts — what the platform actually allows.** Verified, not assumed:

| Channel | Android | iPhone |
|---|---|---|
| `navigator.vibrate` | works | **never** — unsupported in every Safari version, desktop and iOS |
| Web push | works in-browser | only if the site was added to the Home Screen first |
| Audio | works after one user gesture | works after one user gesture |

So **sound is the only channel that reaches everyone's phone**, and it's what this leans on:
a synthesised chime (no asset to fetch on bad wifi), fired when a racer goes on deck, when
they're up, and when a message arrives. Vibration and notifications are layered on where they
exist. Opting in has to happen inside a real tap, because that gesture is what unlocks the
`AudioContext` for the rest of the session.

**Say what each phone will really do.** The opt-in card reads the platform and adjusts:
Android is promised a buzz, iPhone is told plainly that a web page can't vibrate it. None of
this survives a locked phone in a pocket, so the big screen and a human shouting remain the
real backstop — which is exactly why the director got a message button rather than the app
pretending push works.

### 3.5 QR codes

Two QR types with **very different exposure rules**, and collapsing them into one component
that takes a URL is how they'd get confused later:

- **Join QR** — the bare app URL, no identity in it. Safe anywhere, and should be
  *everywhere*: huge on the display during registration, small in the display's foot strip
  during racing, behind a `Share` button in the racer view so anyone already in can flash it
  at a friend, and always available in the director view.
- **Re-link QR** — `?t=<token>`, which **is** a racer's identity. Only ever rendered on the
  director's phone and shown to one person. Anyone who scans it becomes that racer, so it
  must never appear on the big screen.

Scanning the join QR after the roster locks lands on a "registration closed" screen that
still shows the bracket — spectators are a legitimate audience.

---

## 4. Double-elimination logic

This is the only part with real complexity. Specified concretely so it doesn't have to be
rediscovered.

### 4.1 Shape

Let `N` = racer count, `B` = 2^⌈log₂ N⌉ (bracket size), `R` = log₂ B (winners rounds).

- **Winners round `k`** (k = 1..R) has `B / 2^k` matches.
- **Losers bracket has `2R − 2` rounds**, alternating:
  - **Minor** round `L(2j−1)` — losers-vs-losers, survivors of the previous LB round.
  - **Major** round `L(2j)` — LB survivors vs. fresh droppers from winners round `W(j+1)`.
  - Both `L(2j−1)` and `L(2j)` have `B / 2^(j+1)` matches.
  - `L1` takes the losers of `W1`.
- **Grand final:** winners champion (0 losses) vs. losers champion (1 loss).
  - WB champion wins → done.
  - LB champion wins → both have one loss → play **`GFR`, the bracket reset**, and its
    winner takes it.
- Total matches: `2B − 2`, plus 1 if the reset is played.

Worked example, `B = 32` (`R = 5`) — the actual event: WB `16, 8, 4, 2, 1` = 31;
LB `L1:8, L2:8, L3:4, L4:4, L5:2, L6:2, L7:1, L8:1` = 30; `L2←W2`, `L4←W3`, `L6←W4`,
`L8←W5`. 31 + 30 + GF = 62 = 2·32 − 2. ✓

### 4.2 Seeding and byes

There are no qualifying times, so **seeding is a shuffle**. Shuffle the racers, assign seeds
`1..N`, and fill seeds `N+1..B` with a `BYE` participant.

Place seeds into WB round 1 using the **standard bracket seeding order** (for B=8:
`1,8,4,5,2,7,3,6`) — built recursively: `order(2) = [1,2]`,
`order(2n) = interleave(order(n), (2n+1) − order(n))`. This spreads the byes out, since byes
are always the highest seed numbers.

**Resolve byes as a fixpoint:** after building the bracket, repeatedly scan for any pending
match with at least one `BYE` side and resolve it (real racer advances; if both sides are
`BYE`, the match resolves to `BYE`), propagating winners *and* losers along the edges, until
a full pass changes nothing. This handles byes in the losers bracket for free — a `BYE`
dropping down just hands its LB opponent a free pass — and needs no special cases anywhere
else. Bye-resolved matches are flagged and never appear in the race queue or on screen.

### 4.3 Advancement — use explicit edges, not recomputation

Build the routing **once**, at lock time, as rows in an `edges` table:

```
edges(from_match_id, outcome /* 'W' | 'L' */, to_match_id, to_slot /* 'a' | 'b' */)
```

Recording a result is then: write `winner_id`, follow the two outgoing edges, write the
racer into each target slot, mark newly-full matches `ready`. Undo is the exact inverse.
Deriving routing on the fly at every result is where double-elim implementations go wrong;
edges make the whole thing a graph walk and make undo trivially correct.

**Rematch avoidance:** when feeding a major round `L(2j)`, reverse the order of the incoming
WB losers relative to the LB slot order. This is a heuristic, not a guarantee — real
tournaments do fancier cross-placement. For a Hot Wheels race it's plenty; don't gold-plate it.

### 4.4 Race order

Matches get an `order_index` at build time, by round, in this sequence:

```
W1, L1, then for j = 2..R:  W(j), L(2j−2), and L(2j−1) if 2j−1 ≤ 2R−2
finally: GF (and GFR if needed)
```

For `B=32`: `W1, L1, W2, L2, L3, W3, L4, L5, W4, L6, L7, W5, L8, GF`. Within a round, order
by slot. Every dependency is satisfied by construction. The director can override the
current match at any time, so this is a default, not a constraint.

### 4.5 Placements

- 1st: grand final winner.
- 2nd: grand final loser.
- 3rd: loser of the final losers-bracket round (`L(2R−2)`) — eliminated by the LB champion.

Below the podium, report a **placement band** rather than a bare `Out`. In double
elimination everyone knocked out in the same losers round ties for the same range, so the
band falls straight out of counting how many racers are still alive when that round
resolves: `Out — top 12 of 30`. Derive it from the live alive-count rather than a static
table and byes handle themselves. At 8 racers this genuinely wouldn't be worth computing;
at 30, with a third of the field out early, it's the cheapest thing that gives an eliminated
racer something to look at.

### 4.6 Consolation bracket

A **single-elimination** side bracket for people already knocked out — a third chance, on
top of the second chance the losers bracket already is. It exists because a 62-heat double
elim leaves ~28 people idle during its sparse final stretch.

- **Single elim, always.** 16 racers is 15 heats; double elim for a side event would be 30,
  on top of an event already at its time budget.
- **Director-triggered, auto-proposed, editable.** The button appears once ≥8 racers are
  eliminated. The app proposes eliminated racers (most-recently-out first, capped at 16) and
  the director toggles people in or out before locking it. A rigid "top 16 losers" rule
  fights reality: people go home, and other people wander up wanting in.
- Built with the **same machinery** — `bracket = 'C'` rows in `matches`, the same seeding
  order, the same bye fixpoint, the same `edges`. Only the loser edges are omitted.
- **Scheduling is free.** Consolation matches land in the same ready-queue the director
  already picks from, which is the entirety of "mix it into the last part of the race."
- Its champion is shown alongside the podium, clearly labelled as the consolation winner.

---

## 5. Data model

```sql
CREATE TABLE event (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  name           TEXT    NOT NULL DEFAULT 'Hot Wheels Race',
  year           INTEGER NOT NULL,
  phase          TEXT    NOT NULL DEFAULT 'registration',  -- registration | racing | complete
  bracket_size   INTEGER,
  current_match  INTEGER REFERENCES matches(id),
  consolation    INTEGER NOT NULL DEFAULT 0   -- 1 once the consolation bracket is built
);

CREATE TABLE racers (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  name_key    TEXT    NOT NULL UNIQUE,   -- lower(trim(name)), for dupe rejection
  token       TEXT    NOT NULL UNIQUE,   -- crypto.randomUUID(), lives in localStorage
  photo       TEXT,                      -- 'data/photos/<year>/<id>.jpg', nullable
  thumb       TEXT,                      -- 'data/photos/<year>/<id>-t.jpg', nullable
  seed        INTEGER,                   -- assigned at lock
  created_at  INTEGER NOT NULL
);

CREATE TABLE matches (
  id           INTEGER PRIMARY KEY,
  bracket      TEXT    NOT NULL,         -- 'W' | 'L' | 'GF' | 'GFR' | 'C'
  round        INTEGER NOT NULL,
  slot         INTEGER NOT NULL,         -- 0-based within round
  a_racer      INTEGER REFERENCES racers(id),
  b_racer      INTEGER REFERENCES racers(id),
  a_source     TEXT,                     -- display label when empty: 'Winner of W1M3'
  b_source     TEXT,
  winner       INTEGER REFERENCES racers(id),
  state        TEXT    NOT NULL,         -- pending | ready | done | bye
  order_index  INTEGER NOT NULL,
  UNIQUE (bracket, round, slot)
);

CREATE TABLE edges (
  from_match  INTEGER NOT NULL REFERENCES matches(id),
  outcome     TEXT    NOT NULL,          -- 'W' | 'L'
  to_match    INTEGER NOT NULL REFERENCES matches(id),
  to_slot     TEXT    NOT NULL,          -- 'a' | 'b'
  PRIMARY KEY (from_match, outcome)
);

CREATE TABLE results_log (              -- the undo stack; pop LIFO for multi-level undo
  id          INTEGER PRIMARY KEY,
  match_id    INTEGER NOT NULL REFERENCES matches(id),
  winner      INTEGER NOT NULL REFERENCES racers(id),
  created_at  INTEGER NOT NULL
);

CREATE TABLE sessions (                 -- director sessions; in SQLite so a mid-event
  token       TEXT PRIMARY KEY,         -- server restart doesn't lock the director out
  created_at  INTEGER NOT NULL
);

CREATE TABLE messages (                 -- director → racers
  id          INTEGER PRIMARY KEY,
  racer       INTEGER REFERENCES racers(id),  -- NULL = broadcast to everyone
  body        TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE archives (                 -- one row per finished year
  year           INTEGER PRIMARY KEY,
  name           TEXT    NOT NULL,
  archived_at    INTEGER NOT NULL,
  racer_count    INTEGER NOT NULL,
  champion       TEXT,                  -- denormalised so the index page needs no blob
  runner_up      TEXT,
  third          TEXT,
  consolation_champion TEXT,
  schema_version INTEGER NOT NULL,
  state          TEXT    NOT NULL       -- the frozen /api/state JSON
);
```

`BYE` is represented as `racer_id = 0` (a reserved sentinel row), not `NULL` — `NULL` means
"not yet determined," and conflating the two is a bug factory.

**Why archive as a frozen blob rather than a full multi-event schema.** The client's only
input is a `{ event, racers, matches, edges }` payload — it's what `/api/state` returns and
what SSE pushes. So an archived year *is* that payload, and the same React bracket
components render it with zero duplicate code, while the live race-day path — the code that
must not break in front of a room of people — stays exactly as simple as it is today.
Archives are immutable, so a live bug can't corrupt last year and vice versa. `schema_version`
is what lets a future reader handle an old archive instead of rendering garbage.

The trigger to revisit this and go to a real `event_id`-everywhere schema is **cross-year
queries** — "every match Emma has ever raced," lifetime standings. A JSON scan is the wrong
tool for that. Until someone asks, this is the cheaper correct answer.

Racer identity deliberately does **not** persist across years. Kids' names are stable enough
to match on for a hall-of-fame line; their cars aren't, and accounts are out of scope.

---

## 6. API

```
GET   /api/state                     → { event, racers, matches, edges }  (full snapshot)
GET   /api/stream                    → SSE; pushes the same payload on every change

GET   /api/me                                      → { id, name }           (token header)
GET   /api/me/messages                             → broadcasts + own DMs   (token header)

POST  /api/register        {name}                  → { token, racer }
POST  /api/me/photo        multipart: full, thumb  → { photo, thumb }     (token header)
PATCH /api/me              {name}                  → { racer }            (token header)

POST  /api/director/login  {password}              → sets HttpOnly cookie
POST  /api/director/lock                           → shuffle, build bracket, phase=racing
POST  /api/director/result {matchId, winnerId}
POST  /api/director/undo                           → pops results_log, LIFO
POST  /api/director/message {body, racerId|null}   → null racerId broadcasts
POST  /api/director/current {matchId}
DELETE /api/director/racer/:id                     → registration phase only
POST  /api/director/consolation {racerIds}         → build the 'C' bracket
POST  /api/director/archive                        → freeze year, back to registration
POST  /api/director/reset                          → wipe; refuses if unarchived+complete

GET   /api/archives                                → list, without the state blob
GET   /api/archives/:year                          → the frozen state payload
```

Racer identity is the token, sent as an `X-Racer-Token` header. Director auth is a
`HttpOnly; SameSite=Strict` cookie holding a random session token, with a **12-hour TTL** —
an event runs a few hours and getting logged out at heat 40 is infuriating.

**`/api/director/result` must reject a match already in state `done`.** Multiple director
devices are supported and useful (one person at the track tapping winners, another
marshalling racers), and without this guard two people tapping the same heat double-advances
the bracket. This is the desync failure mode that matters.

**SSE:** one global channel. Push the whole state payload on every mutation rather than a
delta plus a refetch — 30 racers and 62 matches is a few KB, and it removes an entire class
of "client got a nudge but raced the refetch" bugs. Send a heartbeat comment every 20s so
proxies don't reap the connection, and make sure the nginx route sets
`proxy_buffering off;` — buffered SSE just silently doesn't arrive.

---

## 7. Director password

```ts
// src/config.ts
export const DIRECTOR_PASSWORD = "hotwheels";  // ← change me
```

One `const`, top of a tiny config file, no env var, no hashing. This gates *entering race
results at a backyard race*; treating it as a real credential would be theater. It is worth
saying plainly what this is not: anyone who reads the public repo can read the password.
That is an accepted tradeoff for this event — but **don't reuse a real password here**, and
if the event ever matters more than this one does, move it to an env var.

Compare with a timing-safe equality check anyway (`crypto.timingSafeEqual`) — it's one line.

---

## 8. Photos

- Capture with `<input type="file" accept="image/*" capture="environment">`.
- **Resize client-side** before upload, via canvas: a `full` at max 800px on the long edge
  and a `thumb` at max 200px, both JPEG q0.82. Upload both blobs in one multipart POST.
  A raw phone photo is 3–5 MB; this makes it ~80 KB and ~10 KB, which matters when a big
  screen is loading 30 of them and when 30 people are on the same wifi.
- Server writes **`data/photos/<year>/<racerId>.jpg`** and `<racerId>-t.jpg`, serves them
  under `/race-tracker/photos/`, and appends `?v=<mtime>` to bust caches on re-upload.
- **The year in that path is not optional.** Racer ids restart at 1 each year, so a flat
  `data/photos/` means next year's registration silently overwrites this year's cars. With
  the year in the path each archive is also self-contained — one directory plus one row.
- No photo → render a generated placeholder (first initial on a colour derived from the
  racer id). The bracket must never have a ragged hole where a photo isn't.
- Cap the upload at 2 MB server-side and reject non-image content types.
- **Served from local disk, never from object storage.** ~30 racers × ~90 KB is ~2.7 MB for
  the whole event, so there's no bandwidth case to weigh against the cost — and the cost is
  a second origin on the public internet in the critical path, which turns a flaky uplink
  into a bracket full of broken images. S3 is for the archive (§9), not for race day.

---

## 9. Archive and backup

On **`Archive & start next year`**: build the current `/api/state` payload, write it to
`archives` with the denormalised podium, then clear `racers` / `matches` / `edges` /
`results_log` and return `event` to `registration` with `year + 1`.

Then, **off the critical path**, push `data/photos/<year>/` and the archive JSON to S3 under
`race-tracker/<year>/`. If it fails, the event is unaffected and it can be retried — this
runs after the race is over, by definition.

`data/` is gitignored and lives on one Mac's disk. Under a single-event design losing it
cost an afternoon; now it costs every year ever run, and the SQLite data matters more than
the photos do.

---

## 10. Visual design

Ground the identity in the **actual object** — a Hot Wheels track set — rather than the
brand logo or the default "dark sports app with a neon accent."

- **Palette** is taken from the physical materials: track orange with its lighter raised
  rails, a warm dark garage-floor ground (a neutral biased toward the accent, not a pure
  near-black), and a cold blue reserved for the losers bracket so the two halves of the
  bracket are distinguishable at 15 feet.
- **One colour per bracket, all the way through.** Orange = winners, blue = losers, **yellow
  = consolation**. Each is applied in every place the others are: the card's left border on
  all three views, the track connectors, and the legend on the Rules tab. Consolation
  inherited the winners orange until it was given `--sun` — the `trk-consolation` class had
  been referenced in the canvas for as long as the bracket existed but never had a rule, so
  a third bracket was drawn in the first one's colour. Yellow sits at hue ~46°, clear of the
  track's ~19°, and deliberately duller and greener than `--gold` (~40°): gold means first
  place on the podium and must not read as "this heat is in the consolation bracket".
- **The live heat outranks its bracket colour.** `.dm-current` sets all four borders to the
  track rail, so the current match glows orange whichever bracket it is in. That is
  deliberate — from across a room "this one is running now" has to win over "this one is in
  the losers bracket".
- **Type does functional work.** A heavy condensed display face (Big Shoulders Display)
  fits long names into narrow bracket cards; a sturdy grotesque (Archivo) carries UI text;
  a technical mono (IBM Plex Mono) sets round codes, records, seeds, and counts. Self-hosted
  woff2 — no CDN, so nothing silently falls back on race day when the wifi is bad.
- **Committed dark, single theme.** The TV demands it, it's an evening event, and all three
  views are in the same room at the same time — consistency across them *is* the design.
  Contrast is set high enough that the director's phone still works in daylight.
- **Ground→surface is ~12 ΔL\*.** A card has to visibly sit *on* the floor; the first cut was
  4.6 and read as one flat sheet. WCAG ratio is the wrong ruler at this end of the scale —
  its `+0.05` flare term crushes every near-black pairing into 1.0–1.5 — so the ramp is sized
  in CIELAB and calibrated against Tailwind 950→800, Radix 1→4 and Material's 8dp step. The
  ground can only give up ~2 L\* before it is black, so the separation comes from lifting the
  surfaces, and `--ink-dim` / `--ink-faint` are lifted *in step* to hold their old ratios —
  raising a surface without raising the muted inks on it is how a contrast pass quietly makes
  secondary text worse.
- **Tint over a surface, never a gradient that replaces it.** `background: linear-gradient(…,
  var(--surface) 60%)` is the shorthand, so it resets `background-color` and the tinted end
  composites onto the *page*, not the card — the card loses its edge exactly where it was
  meant to be loudest. Write it as `linear-gradient(…, transparent 60%), var(--surface)`.
  This has now been the bug in four separate rules.
- **The signature is the track** (§3.3): bracket connectors drawn as orange track with
  raised rails, and the winner's photo travelling along one when a result lands. Boldness
  is spent there; everything around it stays quiet.

---

## 11. Build order

1. `server.ts` skeleton + SQLite schema + `/api/state` + SSE. Vite scaffold, three routes.
2. Registration: racer view name entry, token, roster. Director login + roster management.
3. **Bracket generation** (§4) with a standalone test script — verify at N = 4, 5, 8, 11, 16,
   26, 30, 32 that match counts equal `2B − 2`, that every non-bye racer appears, that byes
   resolve to a valid ready state, and that a random playthrough terminates with exactly one
   champion. Get this right before building any UI on top of it.
4. Director racing screen: tap-to-win, advance, undo.
5. Racer `Now` tab, then `Bracket`, then `Racers`.
6. `/display` big screen + auto-framing + remote control.
7. Photos and QR end to end.
8. Consolation bracket (§4.6) — **last**, because it is strictly additive and the main
   bracket is the part that cannot fail.
9. Archive + `/history` + S3 backup.
10. Deploy: launchd user agent `com.jim.race-tracker` on **58013** (`bun` lives at
    `/Users/doug/.bun/bin/bun`, *not* Homebrew's), nginx route
    `/race-tracker/` → `127.0.0.1:58013` with `proxy_buffering off`, apple-touch-icon via
    `tools/gen-icon.ts`.

**Test the whole thing with two phones and a TV before race day.** A double-elim bracket
that desyncs mid-event in front of a room of people is the failure mode that matters, and it
won't show up on localhost.

---

## 12. Open questions

- **Can `cli-agent` write to S3?** Its identity and `s3 ls` are confirmed; `PutObject` and
  bucket creation are **not** yet verified. If denied, that's an IAM policy limit, not a
  creds problem. Blocks §9's backup step only — the archive itself is local and unaffected.
- **Is the race director also racing?** If so, they need both views open — works fine, just
  worth knowing. Multiple director devices are supported either way.

---

## References

- [Double-elimination tournament — Wikipedia](https://en.wikipedia.org/wiki/Double-elimination_tournament) — bracket structure, minor/major rounds, bracket reset.
- [DerbyNet](https://derbynet.org/) — the closest prior art: a pinewood-derby race-management web server with separate check-in, on-deck, big-screen, and race-crew views. Its multi-display-from-one-tablet model is the shape being copied here.
- [brackets-viewer.js](https://github.com/Drarig29/brackets-viewer.js/) (MIT) and [brackets-manager.js](https://github.com/Drarig29/brackets-manager.js/) — considered and rejected; see §2.
- [react-tournament-brackets](https://github.com/g-loot/react-tournament-brackets) (LGPL-2.1) — considered and rejected; see §2.
