# ADR-004: The Apps lobby — the operator's cave in plain three.js, presence and voice on LiveKit

Why `/apps` is a port of the operator's own cave prototype, drawn with plain
three.js, and why the people in it (where they stand, and their voices)
travel over one LiveKit room open only to members signed in with GitHub.
Source: FORGE v0.2 Phase 3 (the Apps lobby), decided with the operator on
2026-09-29.

## Status

Accepted (Phase 3). Replaces the fixed-centre lobby design in the
2026-09-28 Phase 3 plan, of which only the pure-logic package was built.
Amended 2026-10-04 by [Voice v2](#addendum-voice-v2-2026-10-04), which
replaces the voice: its ranges, its audio path, the mic and the people
panel; and the same day by [its review fixes](#addendum-voice-v2-review-fixes-2026-10-04),
which cap the voices and harden the engine. The rest stands.

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

## Addendum: Voice v2, 2026-10-04

The operator, on the first voice: "Proximity chat is trash. Rework it." It
was. A voice played at full volume within 2 m and faded linearly to nothing
at 9 m, in a cave 51 m across, so two steps apart you lost someone. iOS
ignores an `<audio>` element's volume, so there voices switched on and off
at the edge instead of fading. Sound waited for a `pointerdown` or a key,
and a phone's `pointerdown` isn't a user activation, so phones heard nothing
until the mic button, and nothing said sound was blocked. Gains and the
position heartbeat ran on the scene's animation frame, which stops in a
hidden tab, so someone who joined while your tab was hidden never got your
position and couldn't hear you. Every remote mic was auto-subscribed and
dropped by hand, and nothing said who you could hear, how loud, or why not.
"Mic off" muted without stopping the capture, so the browser's recording
indicator stayed on; a reconnect forced the mic off mid-sentence; the panel
said "Voice unavailable" without saying why, with no deafen and no
per-person mute; and the voices were dry, in a cave.

**Decision.** Port Fable's proximity voice engine (its second drop, which
adds cave acoustics) into the lobby as a close port, so later drops apply
as diffs: the class, its methods, its peer shapes and its config names are
Fable's, and every FORGE change is marked in the code and logged. Its
attenuation and acoustics maths live in `@forge/lobby`, pure and
unit-tested; the cave's numbers are in one place there (`voice.ts`).

- **Range.** Full volume within 5 m, then Unreal's natural-sound curve down
  to −40 dB at 35 m, silent past it. A listener receives a voice from 40 m
  and keeps it until 45 m (hysteresis, so someone on the edge doesn't
  flicker), and the sender's own check lets nobody past 50 m receive it.
- **Audio.** Selective subscription (LiveKit's `autoSubscribe` off, and the
  engine subscribes by distance), and every voice through Web Audio:
  source → HRTF panner (positioned in the listener's own frame, since the
  cave has a heading) → lowpass → dry gain, plus a send to one shared
  convolver. The gains are Web Audio's, so iOS fades too.
- **The cave's sound.** The convolver's impulse response is synthesized,
  not downloaded, and deterministic, so every client hears the same cave:
  3.4 s to −60 dB, 28 ms pre-delay, early reflections, a tail that darkens.
  The send is 0.3 (Fable's 0.4 is thick for speech at 8 to 12 m), and it
  fades slower than the direct path, so a far voice is mostly echo; the
  lowpass closes from 18 kHz to 1.8 kHz with distance.
- **The mic.** Nobody's mic is on at join: members join to listen, and the
  first press of "Mic" asks the browser for it (the press is the gesture
  the permission prompt needs). Off stops the capture
  (`stopMicTrackOnMute`), so the recording indicator goes out. A reconnect
  leaves the mic as the room has it, and the panel says "Reconnecting…".
- **Sound unlock.** The first tap, click or key anywhere (`pointerup`,
  `touchend`, `click`, `keydown`) starts sound, and while the browser holds
  it back the panel shows "Turn on sound".
- **Hidden tabs.** The engine runs on its own 10 Hz timer, not the scene's
  frames, and a member's position never goes stale while they're in the
  room, so a hidden tab keeps its heartbeat and its voices.
- **The panel** says whether voice is on and, if not, why (signed out, the
  practice account, not set up, the server out of reach, disconnected);
  has "Mic", "Deafen" and a per-person "Mute"; and lists everyone nearest
  first with their distance and what they can't be heard for ("mic off",
  "out of range", "too many voices nearby", "muted by you"). The technical
  detail of what you hear
  (direct and reverb levels, the lowpass) stays behind a tooltip on each
  row's level bar, the operator's standing preference for technical
  numbers.

**The sender's range check, and its limit.** While a member is in the room,
their client tells LiveKit who may receive their mic: everyone whose last
known position is within 50 m, and nobody whose position hasn't arrived;
set to nobody before the client connects (so LiveKit's own first word on it
is "nobody", not its default of everyone), then sent as that set changes:
a list that takes someone off at once, one that adds someone at most every
500 ms (see [the review fixes](#addendum-voice-v2-review-fixes-2026-10-04)). LiveKit
refuses the audio to anyone else, whatever
their client asks. This holds against a client that skips its own fading
and subscription, but not against one that lies about where it is:
positions are peer to peer, so a modified client that fakes a nearby
position still gets in. Closing that needs positions on a server (below).

**Occlusion.** The engine can muffle a voice that something stands in front
of (`setPeerOcclusion`), but nothing in the cave can: the walking disk sits
inside a convex rock cylinder, and every screen stands on the wall's ring,
2.5 m beyond the disk, so a line between two members never meets anything.
It is left unwired. When interior geometry arrives (the planned GLB bake),
it hooks in from the scene: one raycast from the listener to each speaker
every 4 frames, smoothed over 150 ms so a doorway doesn't strobe, handed to
the engine through the feed.

**Not now.**

- Server-authoritative subscriptions (Fable's reconcile route): they need
  positions on a server, and the lobby's are peer to peer.
- Moderation (server mute, kick) and voice reports: they need an admin
  surface and a queue; FORGE's admins are GitHub ids on the API side.
- Fable's settings sliders, environment select, custom impulse responses
  and test arena: the lobby is a cave, tuned in one place.
- A crossfade between two convolvers: the lobby never swaps presets while
  connected, so the click Fable warns of never happens.

**Consequences.**

- One convolver for the room and one HRTF panner per voice received, and
  at most 8 voices on a phone or a tablet, 16 elsewhere, plus anyone being
  heard speaking (see the review fixes).
- `livekit-client` and the engine ship in two lazy chunks of their own
  (135 kB and 6 kB gzipped), loaded by `import()` only after the token route
  grants a room, so the practice build, a signed-out visitor and a refused
  member never download them, and neither is in the `/apps` first load,
  which the people panel took from 132 kB to 134.5 kB gzipped.
- The engine has a debug view (`window.__forgeVoice`: each voice's graph,
  the output's level, `updateConfig`, `setPeerOcclusion` and `rebuild`) in development
  builds only, and the practice feed a fixture of the panel's fullest state
  (`?voice-fixture=full`) for the layout e2e; production builds compile both
  out.
- iOS can't be tested here: the voice path on an iPhone (Web Audio fades,
  the sound unlock, the mic indicator, the ringer switch) is checked by hand.
- Proved end to end on 2026-10-04 against a local LiveKit server, with keys
  made for the proof, in real browsers with Chromium's fake mic: two
  members, and a third joining late. They listed each other within half a
  second. Sound stayed blocked until a click. The cave's response rendered
  at 2 channels × 151,174 frames at 44.1 kHz. The listener tuned in 0.5 s
  after the speaker's mic went on. The audio graph matched the pure maths
  at 3 m (dry 1.00, send 0.30, 18 kHz), 15 m (0.21, 0.24, 8.2 kHz) and 30 m
  (0.02, 0.12, 2.6 kHz). At 30 m the reverb carried 78% of the output's
  energy, and switching it off dropped the output by 11 dB. Mute and deafen
  silenced the voice completely (0.000000 RMS, against −21.4 dBFS at 3 m).
  The voice moved to the other ear when the listener turned round. The
  listener let go at 45.4 m, and the sender withdrew permission at 50.1 m.
  Mic off ended the capture. A member whose tab had stopped drawing was
  still found by the newcomer 0.5 s after it joined. A refused mic showed
  the line about it. The sender's first permission frame said nobody.

## Addendum: Voice v2 review fixes, 2026-10-04

A review of Voice v2 before it shipped found it sound for two or three
people and fragile past that, and every fix it asked for was adopted:

- **Chrome kept every voice's audio source.** A `MediaStreamAudioSourceNode`
  lives as long as its AudioContext runs, so each take and let-go of a
  voice left one behind, and a long visit's audio graph grew without end.
- **Nothing capped the voices.** A phone in a crowd decoded, panned and
  filtered every voice within 40 m.
- **The edges churned.** Someone pacing on the 40 m line, or a client
  sending positions that flip, made listeners subscribe and unsubscribe
  tick after tick.
- **Sessions mixed.** The same member back from a new tab took the old
  session's place on everyone's permission list before saying where it
  stood; taking someone off a list waited on the same 500 ms as adding
  them; and a reconnect resent whatever list was current.
- **"Speaking" was the SFU's word**, which is room-wide, so it lit the row
  of someone you couldn't hear.
- **A NaN reached the gains**, from a position or a setting.
- **The panel** had no height cap, ran under the touch controls on short
  screens, dropped focus when a control vanished, and said little to a
  screen reader.

**Decision.**

- **A cap on voices.** A listener receives the nearest 8 voices on a touch
  screen (`(pointer: coarse)`: phones and tablets) and 16 elsewhere, plus
  anyone it already hears speaking, so a conversation isn't cut off when
  someone else walks nearer. The cap is applied before subscribing, and the
  rest are listed as "too many voices nearby". Each voice costs a decoder,
  an HRTF panner and a lowpass, and a phone's audio thread runs out first.
  A panner is re-aimed only once its speaker has turned more than 3° around
  the listener or come more than 0.25 m nearer or farther, since every move
  costs the browser an HRTF cross-fade.
- **A dwell, and steps a camera could take.** Once the engine has taken or
  let go of a voice it holds that for 2 s, either way. A position packet
  that moves its sender faster than a camera can go (16 m/s across the
  floor, 24 m/s up or down: `CAMERA_SPEED` in `@forge/lobby`, which the
  scene's controls now hold the camera to) plus 3 m of slack is dropped; a
  session's first packet is exempt. A subscription the SFU refuses is asked
  for again after 1 s, doubling to 30 s, and the wait starts over when its
  speaker publishes again.
- **Speaking is what this client hears.** An analyser on each voice's
  chain, after its dry gain and its reverb send, is read on every 10 Hz
  tick with hysteresis (speaking above 0.01 RMS, quiet after 600 ms under
  0.005), and your own speaking comes from your mic's meter. So a row says
  someone is speaking only when you hear them, and nobody you can't hear
  can claim the cap's exception for speakers. The SFU's own active-speaker
  updates aren't read. The review took them for room-wide metadata, a
  known limitation; measured against livekit-server 1.9.4, they aren't:
  the server sends a participant speaker updates only about those it is
  subscribed to, and about itself. In the proof, a talker 60 m away was
  speaking 30 times out of 30 by its own client's account, and 0 times by
  the listener's. So they tell a client no more than the audio its
  permissions already let it receive. LiveKit Cloud runs the same server
  but wasn't tested.
- **One audio source per received track.** The engine caches each track's
  `<audio>` element, stream and source (a `WeakMap` keyed by the receiver's
  `MediaStreamTrack`). A let-go disconnects only what follows the source and
  pauses the element, and taking the voice back reuses all three. LiveKit
  reuses receiver tracks from one session to the next, so the cache levels
  off at the most voices received at once (3 in the proof, over 12
  sessions). New tracks, after reconnects in a long visit, add to it, and
  past 32 idle cached sources the engine starts a new AudioContext, and
  renders the impulse response again, at a quiet moment (nobody heard
  speaking). Closing the old context stops its sources. Chrome keeps the
  closed context's objects while the tracks live: the proof still saw them
  listed two minutes on, no longer pulling audio.
- **LiveKit's own AudioContext stays.** `livekit-client` opens a context of
  its own when it connects (`acquireAudioContext`), even with its Web Audio
  mix off (`webAudioMix: false`, since the engine plays every voice
  itself), for the local mic track's processing and to judge whether the
  page may play sound. So a member in the room has two, and LiveKit's
  mostly sits idle. Handing LiveKit the engine's context
  (`webAudioMix: { audioContext }`) would switch its mix on and tie it to a
  context the engine closes and rebuilds (above). Two contexts are the
  smaller cost; whether iOS minds the second is on the list checked by
  hand.
- **Sessions, by participant sid.** The engine keeps each peer's LiveKit
  session id. A new one (a member back from another tab before the old
  session timed out) clears their position, tears their audio down, marks
  them out of range and forgets the list last sent, so the new session
  receives nothing until it says where it is. A list that takes someone off
  goes out at once, in the same task as the packet that took them out of
  range or the news that they left; only a list that adds someone waits
  out the 500 ms. On a full reconnect the engine sets the list to nobody,
  so what LiveKit resends as it reconnects is nobody. **Known limitation:**
  LiveKit keeps permissions per identity, not per session, so someone
  who comes back as a new session (a reload, say) inherits the old one's
  place on everyone's list until those clients hear of the new session.
  In the proof, a session back at once got the speaker's mic about 50 ms
  after it joined, and lost it 0.7 to 0.95 s later, once the speaker's
  client had heard of it. Within that window they hear whoever let them
  hear a moment before. Closing it would need the session in the
  identity, which the one-seat rule (above) forbids.
- **One Room per engine.** A leave and a later join reuse the engine's Room
  once its last connect has settled, and every listener comes off it on
  disconnect. `livekit-client`'s Room constructor adds a `devicechange`
  listener it never removes, so every Room ever made stays reachable;
  reusing one bounds that.
- **Guards.** NaN counts as 0 in the attenuation and acoustics maths;
  `updateConfig` refuses a change that isn't a finite number, makes a
  distance, the margin or the rate negative, puts the falloff before full
  volume, or the reverb outside 0..1; and every tick updates permissions
  before anything that could throw, and carries on past a throw in the
  evaluation.
- **The panel**, as `architecture.md` sets out: capped in height on every
  screen with only the list scrolling, its own place on a short touch
  screen, "and N more" on a phone, focus handed on when a control goes
  away, live regions always in the page, an order that holds still under
  the pointer and in focus, and the wording the review asked for.

**Proved** on 2026-10-05 against the same local LiveKit server
(livekit-server 1.9.4), with keys made for the proof, on the code merged
with the `/apps` batch, in real browsers with Chromium's fake mic. V's
checks passed again. Two members listed each other 1.1 s after load,
sound stayed blocked until a click, the listener tuned in 0.2 s after the
speaker's mic went on, and the graph matched the pure maths at 3, 15.5
and 30 m. At 30 m the reverb carried 79% of the energy. Mute and deafen
gave 0.000000 RMS. The voice moved to the other ear on a turn. The
listener let go at 45.4 m, and the speaker withdrew permission at 50.1 m.
Mic off ended the capture, a tab that had stopped drawing was still
found, and a refused mic showed its line.

Then the fixes, with a phone-sized listener and a page of scripted peers:

- **Sources.** 12 sessions joining and leaving, and 12 takes and
  let-goes of one voice, left 3 native MediaStreamAudioSource nodes; the
  count had stopped growing by the fourth session.
- **The rebuild.** It was asked for through the debug view, since 32
  idle sources are never reached here. It ran 0.3 s later at a quiet tick, and
  the new context and IR came up. The voice was heard again 4.5 s after it
  was unmuted. The closed context still listed its 3 sources, no longer
  pulling audio, so that check, which counted every source, failed as
  written.
- **Removals.** The list without someone went out with the packet that
  took them past 50 m, 136 ms after it left their client, and at once on
  the news that someone left.
- **The dwell.** A peer flipping between 30 m and 47 m every 1.2 s was
  asked for or let go 4 times in 14 s, never within 2.19 s of the last.
  Ten flips a second were dropped as steps no camera could take (37
  packets), and nothing churned.
- **The cap.** A phone received the nearest 8 of 11 voices, and the other
  3 read "too many voices nearby". A walker who came nearest took a
  place.
- **Speaking.** It read as speaking 9 times in 12 reads while the voice
  was heard, and 0 while it was muted or deafened. A talker 60 m away was
  never speaking here.
- **Guards and Rooms.** Every bad config was refused whole, and a NaN
  occlusion counted as none. Two evictions and two rejoins kept one Room.
- **Page errors:** none.

The one failure the fixes can't remove is the same-identity rejoin
(above).

**Consequences.**

- The engine's lazy chunk is 7.1 kB gzipped (6 kB before the fixes) and
  LiveKit's is unchanged at 135 kB; the `/apps` first load is 136.5 kB
  gzipped (134.5 kB before), for the panel's new states and the rules in
  `@forge/lobby`. Neither LiveKit nor the engine is in it, and production
  builds still carry neither the debug view nor the fixture.
- A crowd past the cap is heard nearest first, eight or sixteen at a time,
  and the panel says so.
- A member back as a new session can hear, for under a second, whoever
  could hear their old session (above).
- iOS can't be tested here: a rebuilt AudioContext may come back
  suspended, behind "Turn on sound" again, and LiveKit's second context is
  one more for the audio session and the ringer switch to govern. Both
  are on the list checked by hand.
