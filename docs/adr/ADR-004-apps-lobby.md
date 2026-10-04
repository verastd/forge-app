# ADR-004: The Apps lobby — the operator's cave in plain three.js, presence and voice on LiveKit

Why `/apps` is a port of the operator's own cave prototype, drawn with plain
three.js, and why the people in it (where they stand, and their voices)
travel over one LiveKit room open only to members signed in with GitHub.
Source: FORGE v0.2 Phase 3 (the Apps lobby), decided with the operator on
2026-09-29.

## Status

Accepted (Phase 3). Replaces the fixed-centre lobby design in the
2026-09-28 Phase 3 plan, of which only the pure-logic package was built.

## Context

PRD v0.2 makes `/apps` a lobby: "Everything the community has built, on one
wall", with each app a panel you walk up to and open. The Phase 3 plan of
2026-09-28 designed it as a fixed camera at the centre of a 12 × 7 wall:
dragging or the arrow keys spun you round and scrolled the wall row by row,
and there was no walking. Only its math package was built before the
operator uploaded a working prototype of their own, `Cave.html`: a
free-roam cave (WASD or a touch stick to walk, drag to look, rise and fall),
a 32-column × 90-row holographic grid on a rock cylinder of radius 28 m, one
lit 16:9 screen whose video colours the room's light, an obsidian floor,
dust in the light, four fake people as glowing orbs with name tags and a
"nobody in range" list within 9 m, and a mic button that metered but never
transmitted. It is plain three.js loaded from a CDN import map.

Two things the prototype faked needed real backing: presence (who else is
in the cave, and where) and voice that fades with distance. Both need an
answer to who someone is. FORGE's only identity is GitHub sign-in
([ADR-003](ADR-003-github-app-signin.md)); the practice build has none (its
practice account is nobody on GitHub), and the e2e suite runs on machines
with no GPU. And most of this repo's code is written by community agents
working from an issue, so whatever the lobby is built on has to be
something they can read and change safely.

## Decision

**The operator's cave is the lobby.** `Cave.html` is ported function by
function into `apps/web/src/components/lobby/scene/`, as one plain module,
`createCave(canvas, opts)`, that builds the scene on a canvas it is given,
runs its own frame loop and disposes everything on `dispose()`. Kept: the
rock and obsidian, the grid shader, the lit screen and the lattice of
spotlights it drives, the dust, free roam, the touch stick and lift
buttons, and tap-to-open. Dropped: the drag-and-drop media hook, the fake
people, the logging, the CDN import map and the prototype's exit screen
(the site nav is the way out). Added: a WebGL2 check and context-loss
handling that leave the page's directory working, the `apps_lobby` kill
switch, reduced motion (no drift, flicker or bob), and state attributes on
the lobby's root for e2e. Everything that isn't drawing (the wall's
geometry, the camera's limits and how it's saved, the app registry and its
safety rules, which page chrome a route gets, and the presence packet,
ranges and name rules) lives in `packages/lobby` (`@forge/lobby`): pure
TypeScript with no DOM, no three.js and no runtime dependencies, unit-tested
in Node.

**Plain three.js, not React Three Fiber.** The prototype is plain three.js,
so porting it line for line keeps the port reviewable against the original,
and keeps React out of the frame loop: React mounts one component that owns
a canvas and calls `createCave`, and nothing re-renders per frame. R3F
would have been a second way of writing the same scene for every
contributor, and every contributing agent, to learn, for no feature the
lobby uses. The operator asked for plain three.js; `@react-three/fiber` was
removed from `apps/web`, and `three` and `@types/three` stay. three.js ships
only in the scene's own chunks, loaded lazily on `/apps` (about 150 kB
gzipped), never in any route's first load.

**LiveKit carries both presence and voice.** One room (`lobby`), one
connection per visitor. Positions travel as LiveKit data packets: lossy, on
the topic `pos`, 9 bytes each (a version byte, then centimetres and
milliradians as int16s), at most ten a second while moving and one a second
while still. Voices are WebRTC audio: full volume within 2 m, fading to
silence at 9 m, and not received at all past 14 m. Who someone is comes only
from the token our own server signs (`POST /api/lobby/token`): identity
`gh:<GitHub user id>`, name the GitHub login, one hour, no permission to
change their own metadata, and permission to publish a microphone and no
other source (no camera, screen share or second audio track). A packet
carries a position and nothing else, and one placing its sender where no
camera can go is dropped.

**The voice range is enforced where the audio starts.** Fading and
unsubscribing happen in each listener's own client, which a modified client
simply skips. So while a member's mic is on, their client also tells LiveKit
who may receive it (subscription permissions, every 500 ms): everyone whose
last known position is within 14 m, and nobody whose position hasn't arrived.
The list goes out before the mic goes live and is lifted when it goes off.
LiveKit then refuses the audio to anyone else, whatever their client asks
for. The people panel lists everyone in the room, including those with no
position yet ("<name> · joining"), so nobody who could be listening is
invisible. A reconnect that has to rejoin the room comes back with the mic
off, since LiveKit would otherwise republish it live behind a button that
reads off.

**One seat per member.** The identity is the member's (`gh:<id>`), so the
room holds each member once, and a second tab or device evicts the first
(LiveKit's `DUPLICATE_IDENTITY`). The evicted lobby says so ("You're in the
lobby in another tab or device.") and offers "Rejoin here", which evicts the
other in turn. A per-connection identity would let one member be in the room
twice, with two orbs and two voices, for no use the lobby has.

The alternative weighed was Multisynq for presence (Croquet's replicated
model, relaunched in 2024 on a token-paid network of volunteer relay
nodes) plus Cloudflare RealtimeKit for voice:

| | LiveKit for both | Multisynq presence + RealtimeKit voice |
|---|---|---|
| Who someone is | Identity and name come from a token our server signs, so they can't be forged | Every browser runs the shared model, so a modified page can teleport, take another's name, or flood everyone |
| Moderation | Server APIs mute and remove people | No server in the loop, so nobody can mute or remove |
| Distance falloff for voice | Per-participant volume built in, plus selective subscription, so far voices aren't even downloaded | RealtimeKit has no per-participant volume: every remote track through Web Audio by hand, iOS included |
| Connections per visitor | One | Two services, two tokens, two connections |
| Server code | One token route on the existing sign-in | None for presence |
| Shared world state | None; shared objects later would need a server | Built in (the deterministic replicated model) |
| Limits | Data packets up to about 1.3 KB, at any rate | RealtimeKit's messaging is capped at 5 a second per participant, too few to carry presence |
| Vendor | Open source, with a hosted cloud: the same code can run on our own server | Multisynq's rates are unpublished, paid through a burn-and-mint token, with no stated SLA; a second vendor for voice |

The cost, for the pilot's test pattern (10 testers, 2 hours a day, 30 days:
36,000 participant-minutes a month), at the prices published when this was
decided (2026-09-29; check them again before relying on them):

- **LiveKit Cloud.** The free plan covers 5,000 participant-minutes a month
  (100 concurrent, 50 GB). Everyone in the lobby is a participant, talking
  or not, so presence spends minutes too: 10 testers × 120 minutes is 1,200
  minutes a day, which uses up the free plan in about four days. The next
  plan (Ship) is $50 a month for 150,000 minutes: **$50 a month**.
- **Multisynq + RealtimeKit.** RealtimeKit bills audio-only participants at
  $0.0005 a minute, with no free allowance listed: 36,000 × $0.0005 =
  **$18 a month** if everyone stays on voice the whole time, plus Multisynq
  at rates it doesn't publish (a free API key today).

The difference is tens of dollars a month. What decided it is trust: for a
project whose pitch is that nobody has to trust anybody, presence built on
Multisynq would have had to trust every browser, with no way to verify a
name or remove anyone, and no volume control for voice without building it.

**Only members signed in with GitHub are in the room.** The token route
gives a token only to a real GitHub session: signed out is `401`, the
practice account `403 practice_session`. Practice accounts and signed-out
visitors see the cave, alone, and nobody sees them. Names come from the
signed token, pass through `sanitizeName` (no control or bidi characters, at
most 39 code points, GitHub's login limit) and reach the page only as
`textContent`. The route is a protected path (`CODEOWNERS` cold-account
approval, `.github/forge-protocol.json`'s `protectedPaths`, `SECURITY.md`),
like the sign-in routes and the BFF, because it decides whose name and
voice everyone else sees.

**The practice build has a local feed instead.** A demo build
(`NEXT_PUBLIC_FORGE_DEMO=1`) has no GitHub identity to put in a room and
isn't given LiveKit, so its presence is a `BroadcastChannel('forge.lobby')`
between tabs of one browser: the same packet, send rate, rate limit and
name rules as the LiveKit feed, with no server and no voice. It lets anyone
see presence working in the practice app, and lets e2e test presence end to
end with no service at all. A channel never crosses origins or browsers, so
it trusts nothing a same-origin tab couldn't already do; its messages are
parsed as untrusted input all the same.

## Consequences

- **A monthly bill once testing starts.** At the pilot's scale that is the
  $50 Ship plan, and presence spends minutes even when nobody speaks. The
  operator has to create a LiveKit project and set `LIVEKIT_URL`,
  `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` server-side (see
  [`architecture.md`](../architecture.md#the-apps-lobby)). Without them the
  route answers `503 voice_unavailable`, and the lobby works alone: the
  cave, the directory and the panels, with no one else in it.
- **No shared world state.** LiveKit relays; it doesn't keep a model
  everyone agrees on. Objects people move together would need a small
  server, or a tool like Multisynq alongside for just that.
- **The relay is broadcast.** Every member receives every position packet.
  Past about 100 people in one cave, a server-side filter by distance would
  be needed.
- **The live path isn't exercised in CI.** e2e proves the token (decoded
  claims included), that a member's lobby tries the room, that it carries on
  alone when the room can't be reached, and, against a stand-in for the
  room's signal socket, the evicted-tab state and "Rejoin here". Two members
  seeing and hearing each other needs a real LiveKit project and two GitHub
  sessions, and is checked by hand.
- **Software rendering in e2e.** CI has no GPU, so Chromium draws the cave
  with SwiftShader at about a frame a second. The specs read the page's own
  state attributes and poll for movement, never pixels or fixed waits, and
  give each 3D test a long timeout.
- **Weight on the page.** `/apps` loads the scene's chunk and the screen's
  H.264 video: 5.1 MB at 1280×720, or 1.3 MB at 640×360 on phones, machines
  with four cores or fewer, and Save-Data connections. Nothing loads until
  the screen is within 40 m or in view, and from farther away only its
  metadata does. Media must be same-origin: the scene samples its pixels for
  the room's light, so media on a CDN would need `crossOrigin` and CORS
  first. Build time behind the entry veil and the video codec both still
  need checking on real phones.
- **Permission traffic while talking.** A member with an open mic sends
  LiveKit a new subscription list whenever someone crosses the 14 m line,
  checked every 500 ms. Cheap at the pilot's scale; a crowded cave would
  want it done server-side, alongside the position filter above.
- **Voice needs HTTPS.** Browsers only open the microphone on a secure
  origin. The site's `connect-src` Content-Security-Policy (added with the
  agent hand-off, ADR-005; `connectSources` in `apps/web/next.config.mjs`)
  allows the LiveKit host from `LIVEKIT_URL`, read at build time, so that
  variable must be set when the app is built.
