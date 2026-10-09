/**
 * Playing catch (and waving): who has a ball, which balls are in the air,
 * what everyone's arms are doing, and what to tell the shell. The maths is
 * @forge/lobby's play.ts; the messages are its actions.ts, sent on the
 * presence feed's action channel.
 *
 * How a throw goes:
 * - F gets you a ball (said to everyone, and again every few seconds for
 *   anyone who joins later). F again throws it: at whoever is nearest
 *   straight ahead, or at nobody, to bounce off the floor and come back.
 * - The throw goes out as you let go, naming where the ball comes down and
 *   how long it's in the air. Every client flies it from when the message
 *   arrives, so no clocks need to agree.
 * - The catcher's own client decides: were they still within reach of where
 *   it came down? It says so, and everyone else shows a catch or a miss. A
 *   miss bounces and rolls, and the catcher picks it up once it stops. If
 *   the catcher has gone, the thrower gets it back.
 * - A held ball is drawn in the holder's hand (their robot's palm, or, in
 *   your own first person, low in your view).
 *
 * Everything a peer sends has already been parsed strictly (parseAction);
 * here it's only ever matched against what we know, never trusted further.
 */

import * as THREE from 'three';
import {
  GESTURE,
  HOLD,
  THROW,
  arrivalVelocity,
  ballAt,
  canCatch,
  catchPoint,
  gesturePose,
  landingAhead,
  missPath,
  throwShape,
  throwTarget,
} from '@forge/lobby';
import type { GestureKind, LobbyAction, Vec3 } from '@forge/lobby';

import type { PeerState, PresenceFeed } from '../presence/types';
import { createBall, disposeBall } from './robot/ball';
import { ROBOT_SCALE } from './robot/view';
import type { RobotAct, RobotView } from './robot/view';

/** Where you are in a game of catch, for the dock. */
export type PlayPhase = 'unavailable' | 'none' | 'holding' | 'throwing' | 'in-flight' | 'incoming';

export interface PlayState {
  phase: PlayPhase;
  /** Who a throw now would go to (holding), or is coming from (incoming); null for nobody. */
  other: string | null;
  waving: boolean;
}

/** What the controller needs from the scene each frame. */
export interface PlayFrame {
  dt: number;
  /** Your eye and heading. */
  eye: THREE.Vector3;
  yaw: number;
  selfId: string | null;
  peers: ReadonlyMap<string, PeerState>;
  robotOf(id: string): RobotView | null;
  /** Your own robot, while it's drawn (third person). */
  selfRobot: RobotView | null;
  reducedMotion: boolean;
}

export interface Play {
  /** F: get a ball, or throw the one you have. */
  ball(): void;
  /** G: wave. */
  wave(): void;
  update(frame: PlayFrame): void;
  /** What someone's arms are doing now, for their robot. */
  act(id: string): RobotAct | undefined;
  /** What your own arms are doing now. */
  selfAct(): RobotAct | undefined;
  dispose(): void;
}

export interface PlayEvents {
  onState(state: PlayState): void;
  /** Something to say: "Incoming from …", "You caught it!", a send that failed. */
  onEvent(text: string): void;
}

/** You, among everyone: an id no room hands out. */
const ME = '\u0000me';
/** Say again that you're holding a ball this often (s), for anyone who joined since. */
const HOLD_REPEAT = 3;
/** A hold not heard again for this long (s) has lapsed (they left, or put it down unannounced). */
const HOLD_LAPSE = 8;
/** How long (s) after it comes down everyone else waits for the catcher's word, before calling it a miss. */
const VERDICT_WAIT = 1.5;
/** After a miss stops rolling, this long (s) before it's picked up. */
const PICK_UP = 0.6;

interface Member {
  holding: boolean;
  heardAt: number;
  gesture: { kind: GestureKind; start: number } | null;
}

interface Flight {
  thrower: string;
  /** The catcher (ME for you), or null for a throw at nobody. */
  to: string | null;
  from: Vec3;
  dest: Vec3;
  time: number;
  start: number;
  ball: THREE.Group;
  verdict: 'pending' | 'caught' | 'missed';
  /** Once missed: when it came down, and how fast. */
  missAt: number;
  missVelocity: Vec3;
  /** When it came to rest, once it has. */
  restAt: number;
}

const now = (): number => performance.now() / 1000;
const toVec = (v: THREE.Vector3): Vec3 => ({ x: v.x, y: v.y, z: v.z });

export function createPlay(scene: THREE.Scene, camera: THREE.Camera, feed: () => PresenceFeed | null, events: PlayEvents): Play {
  const members = new Map<string, Member>();
  const flights: Flight[] = [];
  /** Balls drawn in someone's hand: the holder's id → its ball. */
  const held = new Map<string, THREE.Group>();
  let pendingThrow: { start: number } | null = null;
  let lastAnnounce = -Infinity;
  let shown = '';
  let frame: PlayFrame | null = null;
  let subscribed: PresenceFeed | null = null;
  let unsubscribe: (() => void) | null = null;
  const handAt = new THREE.Vector3();
  const reach = new THREE.Vector3();

  const member = (id: string): Member => {
    let found = members.get(id);
    if (!found) {
      found = { holding: false, heardAt: 0, gesture: null };
      members.set(id, found);
    }
    return found;
  };
  const me = member(ME);
  const nameOf = (id: string | null): string =>
    id === null || id === ME ? 'you' : (frame?.peers.get(id)?.name ?? 'someone');
  /** Their id as this client knows them: you are ME. */
  const local = (id: string | null): string | null => (id !== null && id === frame?.selfId ? ME : id);

  const send = (action: LobbyAction): boolean => {
    const current = feed();
    if (current?.sendAction(action)) return true;
    events.onEvent('Couldn’t send that: check your connection');
    return false;
  };
  const announce = (holding: boolean): void => {
    lastAnnounce = now();
    send({ kind: 'ball', holding });
  };

  // ---------- what others do ----------

  const hear = (from: string, action: LobbyAction): void => {
    const at = now();
    const who = member(from);
    switch (action.kind) {
      case 'wave':
        who.gesture = { kind: 'wave', start: at };
        return;
      case 'ball':
        who.holding = action.holding;
        who.heardAt = at;
        return;
      case 'throw': {
        who.holding = false;
        // They let go as they sent it: their arm is already through the throw.
        who.gesture = { kind: 'throw', start: at - GESTURE.release };
        const to = local(action.to);
        flights.push(newFlight(from, to, action.from, action.dest, action.time, at));
        if (to === ME) events.onEvent(`Incoming from ${nameOf(from)}!`);
        return;
      }
      case 'catch': {
        const thrower = local(action.thrower);
        // Their word counts even if it's late and we'd already shown a miss: until the ball's picked up, it's theirs to call.
        const flight = flights.find((f) => f.thrower === thrower && f.to === from && f.verdict !== 'caught');
        if (!flight) return;
        if (action.caught) {
          who.holding = true;
          who.heardAt = at;
          finish(flight);
        } else if (flight.verdict === 'pending') {
          miss(flight, at);
        }
        if (thrower === ME) events.onEvent(action.caught ? `${nameOf(from)} caught it!` : `${nameOf(from)} missed it`);
        return;
      }
    }
  };

  // ---------- flights ----------

  function newFlight(thrower: string, to: string | null, from: Vec3, dest: Vec3, time: number, start: number): Flight {
    const ball = createBall();
    scene.add(ball);
    return { thrower, to, from, dest, time, start, ball, verdict: 'pending', missAt: 0, missVelocity: { x: 0, y: 0, z: 0 }, restAt: 0 };
  }

  function miss(flight: Flight, at: number): void {
    flight.verdict = 'missed';
    flight.missAt = at;
    flight.missVelocity = arrivalVelocity(flight.from, flight.dest, flight.time);
  }

  function finish(flight: Flight): void {
    disposeBall(flight.ball);
    flights.splice(flights.indexOf(flight), 1);
  }

  /** Where your hand is: your robot's palm when it's drawn, else low and to the right of your eye. */
  const myHand = (f: PlayFrame): Vec3 => {
    if (f.selfRobot) return toVec(f.selfRobot.hand.getWorldPosition(handAt));
    return { x: f.eye.x + Math.cos(f.yaw) * 0.25, y: f.eye.y - 0.3, z: f.eye.z + Math.sin(f.yaw) * 0.25 };
  };

  /** Lets go of the ball you're winding up to throw: at whoever is ahead, or at nobody. */
  const release = (f: PlayFrame): void => {
    const others = new Map<string, Vec3>();
    for (const [id, peer] of f.peers) others.set(id, peer);
    const target = throwTarget(f.eye, f.yaw, others);
    const from = myHand(f);
    const peer = target === null ? undefined : f.peers.get(target);
    const dest = peer ? catchPoint(from, peer) : landingAhead(from, f.yaw);
    const { time } = throwShape(Math.hypot(dest.x - from.x, dest.y - from.y, dest.z - from.z));
    if (!send({ kind: 'throw', to: target, from, dest, time })) return;
    me.holding = false;
    flights.push(newFlight(ME, target, from, dest, time, now()));
  };

  const stepFlight = (flight: Flight, f: PlayFrame, at: number): void => {
    const t = at - flight.start;
    if (flight.verdict === 'pending') {
      // The catcher's arms go out to meet it.
      if (flight.to !== null && t >= flight.time - THROW.ready) {
        const catcher = member(flight.to);
        if (catcher.gesture?.kind !== 'catch') catcher.gesture = { kind: 'catch', start: at };
      }
      if (t < flight.time) {
        const p = ballAt(flight.from, flight.dest, flight.time, t);
        flight.ball.position.set(p.x, p.y, p.z);
        flight.ball.rotation.set(Math.PI / 2 - 0.4, 0, t * 9);
        return;
      }
      flight.ball.position.set(flight.dest.x, flight.dest.y, flight.dest.z);
      if (flight.to === ME) {
        // Your own call: were you still in reach of where it came down?
        const caught = canCatch(f.eye, flight.dest);
        send({ kind: 'catch', thrower: flight.thrower === ME ? (f.selfId ?? '') : flight.thrower, caught });
        if (caught) {
          me.holding = true;
          lastAnnounce = at;
          events.onEvent('You caught it!');
          finish(flight);
        } else {
          events.onEvent('You missed it');
          miss(flight, at);
        }
        return;
      }
      // At nobody, at someone who's gone, or no word in time: a miss.
      const gone = flight.to !== null && !f.peers.has(flight.to);
      if (flight.to === null || gone || t >= flight.time + VERDICT_WAIT) miss(flight, at);
      return;
    }
    // A miss: bouncing and rolling, then picked up.
    const path = missPath(flight.dest, flight.missVelocity, at - flight.missAt);
    flight.ball.position.set(path.at.x, path.at.y, path.at.z);
    if (!path.rest) {
      flight.ball.rotation.x += f.dt * 6;
      return;
    }
    if (flight.restAt === 0) flight.restAt = at;
    if (at - flight.restAt < PICK_UP) return;
    // Whoever it was for picks it up; a throw at nobody (or at someone who's gone) comes back to the thrower.
    const catcherHere = flight.to !== null && (flight.to === ME || f.peers.has(flight.to));
    const picker = catcherHere ? flight.to : flight.thrower;
    if (picker === ME) {
      me.holding = true;
      announce(true);
      events.onEvent('You picked it up');
    }
    finish(flight);
  };

  // ---------- held balls ----------

  /** Draws a ball in each holder's hand: their robot's palm, or your view's corner in first person. */
  const drawHeld = (f: PlayFrame): void => {
    const wanted = new Set<string>();
    for (const [id, who] of members) {
      if (!who.holding) continue;
      const robot = id === ME ? f.selfRobot : f.robotOf(id);
      const parent: THREE.Object3D | null = robot ? robot.hand : id === ME ? camera : null;
      if (!parent) continue;
      wanted.add(id);
      let ball = held.get(id);
      if (!ball) {
        ball = createBall();
        held.set(id, ball);
      }
      if (ball.parent !== parent) {
        parent.add(ball);
        if (robot) {
          // Out in front of the palm, not inside the fist.
          ball.position.set(0, 0.03, 0.09);
          ball.rotation.set(Math.PI / 2, 0, 0);
          ball.scale.setScalar(1 / ROBOT_SCALE);
        } else {
          ball.position.set(0.32, -0.3, -0.7);
          ball.rotation.set(0.3, 0.5, 0.9);
          ball.scale.setScalar(1);
        }
      }
    }
    for (const [id, ball] of held) {
      if (!wanted.has(id)) {
        disposeBall(ball);
        held.delete(id);
      }
    }
  };

  // ---------- the shell's view ----------

  const state = (f: PlayFrame, at: number): PlayState => {
    const waving = me.gesture?.kind === 'wave' && at - me.gesture.start <= GESTURE.wave;
    const available = feed()?.actionsAvailable() ?? false;
    if (!available) return { phase: 'unavailable', other: null, waving: false };
    const incoming = flights.find((flight) => flight.to === ME && flight.verdict === 'pending');
    if (incoming) return { phase: 'incoming', other: nameOf(incoming.thrower), waving };
    if (pendingThrow) return { phase: 'throwing', other: null, waving };
    if (flights.some((flight) => flight.thrower === ME)) return { phase: 'in-flight', other: null, waving };
    if (me.holding) {
      const others = new Map<string, Vec3>();
      for (const [id, peer] of f.peers) others.set(id, peer);
      const target = throwTarget(f.eye, f.yaw, others);
      return { phase: 'holding', other: target === null ? null : nameOf(target), waving };
    }
    return { phase: 'none', other: null, waving };
  };

  const armsOf = (who: Member, at: number, reducedMotion: boolean): RobotAct | undefined => {
    const gesture = who.gesture;
    if (gesture) {
      const arms = gesturePose(gesture.kind, at - gesture.start, who.holding, reducedMotion);
      if (arms) return { arms, reach: null };
      who.gesture = null;
    }
    return who.holding ? { arms: { right: HOLD, left: null, weight: 1 }, reach: null } : undefined;
  };

  return {
    ball() {
      const f = frame;
      if (!f) return;
      if (!(feed()?.actionsAvailable() ?? false)) {
        events.onEvent('Join the room to play catch');
        return;
      }
      if (pendingThrow || flights.some((flight) => flight.to === ME && flight.verdict === 'pending')) return;
      if (me.holding) {
        pendingThrow = { start: now() };
        me.gesture = { kind: 'throw', start: now() };
        return;
      }
      if (flights.some((flight) => flight.thrower === ME)) return;
      if (!send({ kind: 'ball', holding: true })) return;
      lastAnnounce = now();
      me.holding = true;
      events.onEvent('Got a ball: F to throw it');
    },

    wave() {
      const at = now();
      if (me.gesture?.kind === 'wave' && at - me.gesture.start <= GESTURE.wave) return;
      if (!(feed()?.actionsAvailable() ?? false)) {
        events.onEvent('Join the room to wave');
        return;
      }
      if (!send({ kind: 'wave' })) return;
      me.gesture = { kind: 'wave', start: at };
    },

    update(f) {
      frame = f;
      const at = now();
      // The feed this frame: hear its actions (a new feed, a new subscription).
      const current = feed();
      if (current !== subscribed) {
        unsubscribe?.();
        subscribed = current;
        unsubscribe = current ? current.onAction(hear) : null;
      }
      // Anyone gone is forgotten; a hold not heard again has lapsed.
      for (const [id, who] of members) {
        if (id === ME) continue;
        if (!f.peers.has(id)) members.delete(id);
        else if (who.holding && at - who.heardAt > HOLD_LAPSE) who.holding = false;
      }
      if (pendingThrow && at - pendingThrow.start >= GESTURE.release) {
        pendingThrow = null;
        release(f);
      }
      for (const flight of [...flights]) stepFlight(flight, f, at);
      if (me.holding && at - lastAnnounce >= HOLD_REPEAT) announce(true);
      drawHeld(f);

      const next = state(f, at);
      const key = `${next.phase}|${next.other ?? ''}|${next.waving}`;
      if (key !== shown) {
        shown = key;
        events.onState(next);
      }
    },

    act(id) {
      const who = members.get(id);
      if (!who) return undefined;
      const act = armsOf(who, now(), frame?.reducedMotion ?? false);
      // A catch reaches for the ball itself.
      const coming = flights.find((flight) => flight.to === id && flight.verdict === 'pending');
      if (act && coming && who.gesture?.kind === 'catch') return { ...act, reach: reach.copy(coming.ball.position) };
      return act;
    },

    selfAct() {
      const act = armsOf(me, now(), frame?.reducedMotion ?? false);
      const coming = flights.find((flight) => flight.to === ME && flight.verdict === 'pending');
      if (act && coming && me.gesture?.kind === 'catch') return { ...act, reach: reach.copy(coming.ball.position) };
      return act;
    },

    dispose() {
      unsubscribe?.();
      for (const flight of flights) disposeBall(flight.ball);
      flights.length = 0;
      for (const ball of held.values()) disposeBall(ball);
      held.clear();
    },
  };
}
