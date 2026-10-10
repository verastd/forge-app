'use client';

/**
 * The avatar editor. Left, every member (search, and a swatch of how each
 * looks); right, the chosen member's robot: a live preview, its head, its
 * four colours and its chestplate, saved together; below, the head library.
 *
 * Every action says what it is doing: the page loads behind a spinner (or
 * says why it can't, with a way to try again), Save goes Saving… → Saved ✓
 * or an error with Try again, uploads show their progress then "Processing…",
 * removals and deletions spin on their own button, and the preview shows its
 * own loading. Unsaved changes are marked, and leaving them (another member,
 * or the page) asks first.
 */

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { AVATAR_FINISHES, AVATAR_PALETTES, CHEST_VIDEO, chestVideoProblem, defaultColors, emblemInitials } from '@forge/lobby';
import type { AvatarColors, AvatarFinish } from '@forge/lobby';
import {
  AVATAR_CAPE_DEFAULT,
  AVATAR_CHEST_MAX_BYTES,
  AVATAR_CHEST_MAX_PIXELS,
  AVATAR_CHEST_TYPES,
  AVATAR_CHEST_VIDEO_MAX_BYTES,
  AVATAR_CHEST_VIDEO_TYPES,
  AVATAR_HEAD_ID,
  AVATAR_HEAD_MAX_BYTES,
  AVATAR_HEAD_NAME_MAX,
} from '@forge/shared';
import type { Avatar, AvatarCape, AvatarHead, AvatarHeadFit, AvatarHeadPlacement, AvatarList, AvatarMember } from '@forge/shared';

import {
  AvatarsError,
  deleteHead,
  describeAvatarsError,
  fetchAvatars,
  fetchMembers,
  giveHead,
  headIdFrom,
  refitHead,
  removeChest,
  resetAvatar,
  saveAvatar,
  uploadChest,
  uploadHead,
} from '../../../lib/avatars';
import type { RobotLook } from '../../../components/lobby/scene/robot/view';
import styles from './avatars.module.css';

const Preview = dynamic(() => import('./Preview'), {
  ssr: false,
  loading: () => (
    <div className={styles.stage}>
      <div className={styles.stageOverlay} role="status">
        <span className="loading-line">
          <span className="spinner spinner-lg" aria-hidden="true" />
          Loading the preview…
        </span>
      </div>
    </div>
  ),
});

const HeadFitter = dynamic(() => import('./HeadFitter'), {
  ssr: false,
  loading: () => (
    <div className={`${styles.stage} ${styles.fitStage}`}>
      <div className={styles.stageOverlay} role="status">
        <span className="loading-line">
          <span className="spinner spinner-lg" aria-hidden="true" />
          Loading the fitting tool…
        </span>
      </div>
    </div>
  ),
});

const COLOR_FIELDS: { key: keyof AvatarColors; label: string; hint: string }[] = [
  { key: 'shell', label: 'Armour', hint: 'Torso, pod, gauntlets' },
  { key: 'trim', label: 'Trim', hint: 'Hip ring, arms, palms' },
  { key: 'accent', label: 'Accent', hint: 'Chestplate and face rims' },
  { key: 'eye', label: 'Eyes', hint: 'Eyes and thruster' },
];

/** What each finish is called, and what it looks like. */
const FINISH_CHOICES: Record<AvatarFinish, { label: string; hint: string }> = {
  paint: { label: 'Paint', hint: 'Painted armour, as it comes' },
  chrome: { label: 'Chrome', hint: 'Mirror-bright metal, tinted by the Armour colour' },
  ice: { label: 'Ice', hint: 'See-through, glossy, lit at the edges; tinted by the Armour colour' },
};

const FIT_LABEL: Record<AvatarHeadFit, string> = {
  replace: 'Replaces the head',
  accessory: 'Face accessory',
  back: 'Worn on the back',
};

const kb = (bytes: number): string => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

type Load = { kind: 'loading' } | { kind: 'error'; error: unknown } | { kind: 'ready'; members: AvatarMember[]; list: AvatarList };

type Busy =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'resetting' }
  | { kind: 'error'; message: string; retry: () => void };

type Upload =
  | { kind: 'idle' }
  | { kind: 'preparing'; what: string }
  | { kind: 'uploading'; progress: number }
  | { kind: 'processing' }
  | { kind: 'error'; message: string };

interface Draft {
  colors: AvatarColors;
  head: string | null;
  /** A face accessory worn over the head. */
  accessory: string | null;
  /** What the armour is made of. */
  finish: AvatarFinish;
  /** On its back: a library model, or the cape (never both). */
  back: string | null;
  cape: AvatarCape | null;
}

function draftFor(memberId: string, list: AvatarList): Draft {
  const saved = list.avatars.find((a) => a.memberId === memberId);
  return {
    colors: saved?.colors ?? defaultColors(memberId),
    head: saved?.head ?? null,
    accessory: saved?.accessory ?? null,
    finish: saved?.finish ?? 'paint',
    back: saved?.back ?? null,
    cape: saved?.cape ?? null,
  };
}

/** Every key, by name: a right eye on only one side is a change too. */
function sameDraft(a: Draft, b: Draft): boolean {
  const colours = (['shell', 'trim', 'accent', 'eye'] as const).every((k) => a.colors[k] === b.colors[k]);
  const capes = a.cape === null || b.cape === null ? a.cape === b.cape : a.cape.outer === b.cape.outer && a.cape.lining === b.cape.lining;
  return colours && (a.colors.eyeRight ?? null) === (b.colors.eyeRight ?? null) && a.head === b.head && a.accessory === b.accessory && a.finish === b.finish && a.back === b.back && capes;
}

/**
 * Reads a clip's size and length in the browser (which must be able to play it), to refuse
 * one the lobby couldn't show before uploading it.
 */
function videoFacts(file: File): Promise<{ width: number; height: number; duration: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    const done = (): void => {
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error('timeout'));
    }, 15_000);
    video.preload = 'metadata';
    video.muted = true;
    video.addEventListener(
      'loadedmetadata',
      () => {
        const facts = { width: video.videoWidth, height: video.videoHeight, duration: video.duration };
        done();
        resolve(facts);
      },
      { once: true },
    );
    video.addEventListener(
      'error',
      () => {
        done();
        reject(new Error('unplayable'));
      },
      { once: true },
    );
    video.src = url;
  });
}

/**
 * A saved chestplate clip, playing in its thumbnail: fetched whole and played from memory (the
 * asset route sends no byte ranges, which Safari's <video> needs to stream), still for anyone
 * who'd rather nothing moved, a spinner while it comes, a mark if it can't.
 */
function ChestClipThumb({ sha }: { sha: string }) {
  const [state, setState] = useState<{ kind: 'loading' } | { kind: 'ready'; url: string } | { kind: 'error' }>({ kind: 'loading' });
  const [still, setStill] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setStill(query.matches);
    const changed = (event: MediaQueryListEvent): void => setStill(event.matches);
    query.addEventListener('change', changed);
    return () => query.removeEventListener('change', changed);
  }, []);
  useEffect(() => {
    let url: string | null = null;
    let gone = false;
    setState({ kind: 'loading' });
    fetch(`/bff/avatars/assets/${sha}`)
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.blob();
      })
      .then(
        (blob) => {
          if (gone) return;
          url = URL.createObjectURL(blob);
          setState({ kind: 'ready', url });
        },
        () => {
          if (!gone) setState({ kind: 'error' });
        },
      );
    return () => {
      gone = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [sha]);
  if (state.kind === 'loading') return <span className="spinner" aria-hidden="true" />;
  if (state.kind === 'error') return <span title="The clip couldn’t load">!</span>;
  return <video key={String(still)} className={styles.chestClip} src={state.url} muted loop playsInline autoPlay={!still} preload="auto" />;
}

/** What's wrong with a clip, in words; null when nothing is. */
function clipProblemText(problem: ReturnType<typeof chestVideoProblem>): string | null {
  if (!problem) return null;
  switch (problem.reason) {
    case 'type':
      return 'Use an MP4 or WebM clip.';
    case 'too_big':
      return `That clip is ${kb(problem.bytes)}. The most is ${kb(problem.max)}.`;
    case 'too_long':
      return `That clip is ${Math.round(problem.seconds * 10) / 10} s. The most is ${problem.max} s (it loops).`;
    case 'too_many_pixels':
      return `That clip is ${problem.width}×${problem.height}. The most is ${problem.max} pixels each way.`;
    case 'unreadable':
      return 'That clip couldn’t be read. Try an MP4 (H.264) or a WebM.';
  }
}

/** Reads an image's size in the browser, to refuse one the API would before uploading it. */
function imageSize(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      reject(new Error('unreadable'));
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });
}

function UploadStatus({ upload, label }: { upload: Upload; label: string }) {
  if (upload.kind === 'idle') return null;
  if (upload.kind === 'error') {
    return (
      <p className={styles.error} role="alert">
        {upload.message}
      </p>
    );
  }
  const percent = upload.kind === 'uploading' ? Math.round(upload.progress * 100) : null;
  const text =
    upload.kind === 'preparing' ? upload.what : upload.kind === 'uploading' ? `Uploading ${label}… ${percent}%` : 'Processing…';
  return (
    <div className="stack" role="status" aria-live="polite">
      <span className={styles.status}>
        <span className="spinner" aria-hidden="true" />
        {text}
      </span>
      <div
        className={`${styles.progress} ${percent === null ? styles.progressIndeterminate : ''}`}
        role="progressbar"
        aria-label={`${label} upload`}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(percent === null ? {} : { 'aria-valuenow': percent })}
      >
        <i style={{ width: `${percent ?? 35}%` }} />
      </div>
    </div>
  );
}

export function AvatarEditor() {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoad({ kind: 'loading' });
    Promise.all([fetchMembers(), fetchAvatars()]).then(
      ([members, list]) => {
        if (cancelled) return;
        setLoad({ kind: 'ready', members: members.members, list });
        setSelected((current) => current ?? members.members[0]?.memberId ?? null);
      },
      (error: unknown) => {
        if (!cancelled) setLoad({ kind: 'error', error });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const setList = useCallback((update: (list: AvatarList) => AvatarList) => {
    setLoad((current) => (current.kind === 'ready' ? { ...current, list: update(current.list) } : current));
  }, []);

  const dirtyRef = useRef(false);
  const [drafted, setDrafted] = useState<DraftedLook | null>(null);

  if (load.kind === 'loading') {
    return (
      <section className="card" aria-busy="true">
        <span className="loading-line" role="status">
          <span className="spinner spinner-lg" aria-hidden="true" />
          Loading members and the head library…
        </span>
      </section>
    );
  }

  if (load.kind === 'error') {
    const code = load.error instanceof AvatarsError ? load.error.code : '';
    const final = code === 'admin_only' || code === 'avatars-disabled' || code === 'practice_session';
    return (
      <section className="card stack" role="alert">
        <p className="card-title">{final ? 'The editor isn’t available' : 'The editor couldn’t load'}</p>
        <p className="muted">{describeAvatarsError(load.error)}</p>
        {!final && (
          <div>
            <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          </div>
        )}
      </section>
    );
  }

  const { members, list } = load;
  const visible = members.filter((m) => m.login.toLowerCase().includes(query.trim().toLowerCase()));
  const choose = (memberId: string): void => {
    if (memberId === selected) return;
    if (dirtyRef.current && !window.confirm('This robot has unsaved changes. Leave them?')) return;
    setSelected(memberId);
  };

  return (
    <div className="stack-lg">
      <div className={styles.layout}>
        <section className={`card ${styles.members}`} aria-labelledby="avatar-members">
          <h2 id="avatar-members" className="section-title">
            Members
          </h2>
          <label className={styles.label}>
            <span className={styles.visuallyHidden}>Find a member</span>
            <input
              className="text-input"
              type="search"
              placeholder="Find a member"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          {members.length === 0 ? (
            <p className="muted">Nobody has signed in yet. Members appear here once they have.</p>
          ) : visible.length === 0 ? (
            <p className="muted">No member matches “{query}”.</p>
          ) : (
            <ul className={styles.memberList}>
              {visible.map((member) => {
                const saved = list.avatars.find((a) => a.memberId === member.memberId);
                const colors = saved?.colors ?? defaultColors(member.memberId);
                return (
                  <li key={member.memberId}>
                    <button
                      type="button"
                      className={styles.member}
                      aria-current={member.memberId === selected}
                      onClick={() => choose(member.memberId)}
                    >
                      <span className={styles.swatch} aria-hidden="true">
                        <i style={{ background: colors.shell }} />
                        <i style={{ background: colors.trim }} />
                        <i style={{ background: colors.eye }} />
                        {colors.eyeRight && <i style={{ background: colors.eyeRight }} />}
                      </span>
                      <span className={styles.memberName}>@{member.login}</span>
                      {saved?.finish && saved.finish !== 'paint' && <span className="chip">{FINISH_CHOICES[saved.finish].label}</span>}
                      {saved?.cape && <span className="chip">Cape</span>}
                      {saved?.back && <span className="chip">{list.heads.find((h) => h.id === saved.back)?.name ?? 'On its back'}</span>}
                      {saved && (
                        <span className={styles.customDot} title="Customised">
                          <span className={styles.visuallyHidden}>(customised)</span>
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {selected ? (
          <RobotEditor
            key={selected}
            onDraft={setDrafted}
            member={members.find((m) => m.memberId === selected) ?? { memberId: selected, login: selected }}
            list={list}
            setList={setList}
            onDirty={(dirty) => {
              dirtyRef.current = dirty;
            }}
          />
        ) : (
          <section className="card">
            <p className="muted">Choose a member to dress their robot.</p>
          </section>
        )}
      </div>

      <HeadLibrary
        key={selected ?? 'nobody'}
        drafted={drafted && drafted.memberId === selected ? drafted : null}
        member={selected ? (members.find((m) => m.memberId === selected) ?? { memberId: selected, login: selected }) : null}
        list={list}
        setList={setList}
      />
    </div>
  );
}

/** The robot as the editor shows it now (saved or not): what a face accessory is fitted over. */
interface DraftedLook {
  memberId: string;
  colors: AvatarColors;
  head: string | null;
  finish: AvatarFinish;
}

interface RobotEditorProps {
  /** Told the robot's look whenever it changes, so the head library fits on the same robot. */
  onDraft: (look: DraftedLook) => void;
  member: AvatarMember;
  list: AvatarList;
  setList: (update: (list: AvatarList) => AvatarList) => void;
  onDirty: (dirty: boolean) => void;
}

function RobotEditor({ member, list, setList, onDirty, onDraft }: RobotEditorProps) {
  const saved: Avatar | undefined = list.avatars.find((a) => a.memberId === member.memberId);
  const [draft, setDraft] = useState<Draft>(() => draftFor(member.memberId, list));
  useEffect(() => {
    onDraft({ memberId: member.memberId, colors: draft.colors, head: draft.head, finish: draft.finish });
  }, [onDraft, member.memberId, draft.colors, draft.head, draft.finish]);
  const [busy, setBusy] = useState<Busy>({ kind: 'idle' });
  const [chestUpload, setChestUpload] = useState<Upload>({ kind: 'idle' });
  const [removingChest, setRemovingChest] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const baseline = useMemo(() => draftFor(member.memberId, list), [member.memberId, list]);
  const dirty = !saved || !sameDraft(draft, baseline);
  const changed = !sameDraft(draft, baseline);

  useEffect(() => {
    onDirty(changed);
    if (!changed) return undefined;
    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [changed, onDirty]);

  useEffect(() => () => clearTimeout(savedTimer.current), []);

  const head = draft.head ? (list.heads.find((h) => h.id === draft.head) ?? null) : null;
  const accessory = draft.accessory ? (list.heads.find((h) => h.id === draft.accessory) ?? null) : null;
  const back = draft.back ? (list.heads.find((h) => h.id === draft.back) ?? null) : null;
  const look: RobotLook = useMemo(
    () => ({
      id: member.memberId,
      name: member.login,
      colors: draft.colors,
      head,
      accessory,
      chest: saved?.chest ?? null,
      chestType: saved?.chestType ?? null,
      finish: draft.finish,
      back,
      cape: draft.cape,
    }),
    [member.memberId, member.login, draft.colors, head, accessory, saved?.chest, saved?.chestType, draft.finish, back, draft.cape],
  );

  const commit = useCallback(async (): Promise<Avatar> => {
    // A right eye and a finish are sent only when set: a robot without them saves as it always did.
    const { eyeRight, ...colors } = draft.colors;
    const result = await saveAvatar(member.memberId, {
      colors: eyeRight ? { ...colors, eyeRight } : colors,
      ...(draft.head ? { head: draft.head } : {}),
      ...(draft.accessory ? { accessory: draft.accessory } : {}),
      ...(draft.finish !== 'paint' ? { finish: draft.finish } : {}),
      // On its back, one or the other (or neither): a model, or the cape.
      ...(draft.back ? { back: draft.back } : draft.cape ? { cape: draft.cape } : {}),
    });
    setList((current) => ({ ...current, avatars: [...current.avatars.filter((a) => a.memberId !== result.memberId), result] }));
    return result;
  }, [member.memberId, draft, setList]);

  const save = useCallback((): void => {
    clearTimeout(savedTimer.current);
    setBusy({ kind: 'saving' });
    commit().then(
      () => {
        setBusy({ kind: 'saved' });
        savedTimer.current = setTimeout(() => setBusy({ kind: 'idle' }), 2000);
      },
      (error: unknown) => setBusy({ kind: 'error', message: describeAvatarsError(error), retry: save }),
    );
  }, [commit]);

  const reset = (): void => {
    if (!window.confirm(`Put @${member.login}'s robot back to its default look? Its chestplate image goes too.`)) return;
    setBusy({ kind: 'resetting' });
    resetAvatar(member.memberId).then(
      () => {
        setList((current) => ({ ...current, avatars: current.avatars.filter((a) => a.memberId !== member.memberId) }));
        setDraft({ colors: defaultColors(member.memberId), head: null, accessory: null, finish: 'paint', back: null, cape: null });
        setBusy({ kind: 'idle' });
      },
      (error: unknown) => setBusy({ kind: 'error', message: describeAvatarsError(error), retry: reset }),
    );
  };

  const onChestFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const isClip = (AVATAR_CHEST_VIDEO_TYPES as readonly string[]).includes(file.type);
    if (!isClip && !(AVATAR_CHEST_TYPES as readonly string[]).includes(file.type)) {
      setChestUpload({ kind: 'error', message: 'Use a PNG, JPEG or WebP image. (Or a short MP4 or WebM clip.)' });
      return;
    }
    if (isClip) {
      if (file.size > AVATAR_CHEST_VIDEO_MAX_BYTES) {
        setChestUpload({ kind: 'error', message: `That clip is ${kb(file.size)}. The most is ${kb(AVATAR_CHEST_VIDEO_MAX_BYTES)}.` });
        return;
      }
      setChestUpload({ kind: 'preparing', what: 'Checking the clip…' });
      let problem: string | null;
      try {
        const facts = await videoFacts(file);
        problem = clipProblemText(chestVideoProblem({ type: file.type, bytes: file.size, ...facts }));
      } catch (error) {
        problem =
          error instanceof Error && error.message === 'timeout'
            ? 'That clip took too long to read. Try again, or a smaller file.'
            : 'This browser couldn’t play that clip. Try an MP4 (H.264) or a WebM.';
      }
      if (problem) {
        setChestUpload({ kind: 'error', message: problem });
        return;
      }
    } else if (file.size > AVATAR_CHEST_MAX_BYTES) {
      setChestUpload({ kind: 'error', message: `That image is ${kb(file.size)}. The most is ${kb(AVATAR_CHEST_MAX_BYTES)}.` });
      return;
    }
    if (!isClip) setChestUpload({ kind: 'preparing', what: 'Checking the image…' });
    try {
      const { width, height } = isClip ? { width: 0, height: 0 } : await imageSize(file);
      if (width > AVATAR_CHEST_MAX_PIXELS || height > AVATAR_CHEST_MAX_PIXELS) {
        setChestUpload({
          kind: 'error',
          message: `That image is ${width}×${height}. The most is ${AVATAR_CHEST_MAX_PIXELS} pixels each way.`,
        });
        return;
      }
    } catch {
      setChestUpload({ kind: 'error', message: 'That image couldn’t be read.' });
      return;
    }
    try {
      // The chestplate goes on a saved robot: save the colours first if they aren't.
      if (dirty) {
        setChestUpload({ kind: 'preparing', what: 'Saving the colours first…' });
        await commit();
      }
      setChestUpload({ kind: 'uploading', progress: 0 });
      const result = await uploadChest(member.memberId, file, (progress) =>
        setChestUpload(progress >= 1 ? { kind: 'processing' } : { kind: 'uploading', progress }),
      );
      setList((current) => ({ ...current, avatars: [...current.avatars.filter((a) => a.memberId !== result.memberId), result] }));
      setChestUpload({ kind: 'idle' });
    } catch (error) {
      setChestUpload({ kind: 'error', message: describeAvatarsError(error) });
    }
  };

  const dropChest = (): void => {
    setRemovingChest(true);
    removeChest(member.memberId).then(
      (result) => {
        setList((current) => ({ ...current, avatars: [...current.avatars.filter((a) => a.memberId !== result.memberId), result] }));
        setRemovingChest(false);
      },
      (error: unknown) => {
        setRemovingChest(false);
        setChestUpload({ kind: 'error', message: describeAvatarsError(error) });
      },
    );
  };

  const uploading = chestUpload.kind === 'preparing' || chestUpload.kind === 'uploading' || chestUpload.kind === 'processing';
  const working = busy.kind === 'saving' || busy.kind === 'resetting' || uploading || removingChest;
  const chestIsClip = Boolean(saved?.chestType?.startsWith('video/'));
  const missingHead = saved?.head && !list.heads.some((h) => h.id === saved.head);
  // A head is made for one member: only theirs are offered.
  const ownHeads = list.heads.filter((h) => h.owner === member.memberId);

  return (
    <section className={`card ${styles.editor}`} aria-labelledby="avatar-editor">
      <Preview look={look} chestUploading={uploading} />

      <div className={styles.fields}>
        <div className="row" style={{ justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <h2 id="avatar-editor" className="card-title" style={{ margin: 0 }}>
            @{member.login}
          </h2>
          {saved ? <span className="chip chip-accent">Custom</span> : <span className="chip">Default look</span>}
        </div>

        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>Head</legend>
          <div className={styles.heads}>
            <button
              type="button"
              className={styles.headChoice}
              aria-pressed={draft.head === null}
              onClick={() => setDraft((d) => ({ ...d, head: null }))}
            >
              <span>Its own head</span>
              <span className={styles.headMeta}>With the face screen</span>
            </button>
            {ownHeads
              .filter((h) => h.fit === 'replace' || h.id === draft.head)
              .map((h) => (
                <button
                  key={h.id}
                  type="button"
                  className={styles.headChoice}
                  aria-pressed={draft.head === h.id}
                  onClick={() => setDraft((d) => ({ ...d, head: h.id }))}
                >
                  <span>{h.name}</span>
                  <span className={styles.headMeta}>
                    {FIT_LABEL[h.fit]}
                    {h.fit === 'replace' && !h.eyes && !h.placement.eyes ? ' · no eyes' : ''}
                  </span>
                </button>
              ))}
          </div>
          {!ownHeads.some((h) => h.fit === 'replace') && (
            <p className={styles.hint}>No heads made for @{member.login} yet: add one in “Heads for @{member.login}” below.</p>
          )}
          {missingHead && <p className={styles.hint}>The head this robot wore was taken out of the library.</p>}
        </fieldset>

        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>Face accessory</legend>
          <div className={styles.heads}>
            <button
              type="button"
              className={styles.headChoice}
              aria-pressed={draft.accessory === null}
              onClick={() => setDraft((d) => ({ ...d, accessory: null }))}
            >
              <span>None</span>
              <span className={styles.headMeta}>Just the head</span>
            </button>
            {ownHeads
              .filter((h) => h.fit === 'accessory')
              .map((h) => (
                <button
                  key={h.id}
                  type="button"
                  className={styles.headChoice}
                  aria-pressed={draft.accessory === h.id}
                  onClick={() => setDraft((d) => ({ ...d, accessory: h.id }))}
                >
                  <span>{h.name}</span>
                  <span className={styles.headMeta}>Worn over the head</span>
                </button>
              ))}
          </div>
          {!ownHeads.some((h) => h.fit === 'accessory') && (
            <p className={styles.hint}>No face accessories made for @{member.login} yet (a mask, a visor): add one below as a Face accessory.</p>
          )}
        </fieldset>

        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>Back</legend>
          <div className={styles.heads} role="group" aria-label="Back">
            <button
              type="button"
              className={styles.headChoice}
              aria-pressed={draft.back === null && draft.cape === null}
              onClick={() => setDraft((d) => ({ ...d, back: null, cape: null }))}
            >
              <span>None</span>
              <span className={styles.headMeta}>Nothing on its back</span>
            </button>
            <button
              type="button"
              className={styles.headChoice}
              aria-pressed={draft.cape !== null}
              onClick={() => setDraft((d) => ({ ...d, back: null, cape: d.cape ?? { ...AVATAR_CAPE_DEFAULT } }))}
            >
              <span>Cape</span>
              <span className={styles.headMeta}>Cloth that billows as it flies</span>
            </button>
            {ownHeads
              .filter((h) => h.fit === 'back')
              .map((h) => (
                <button
                  key={h.id}
                  type="button"
                  className={styles.headChoice}
                  aria-pressed={draft.back === h.id}
                  onClick={() => setDraft((d) => ({ ...d, back: h.id, cape: null }))}
                >
                  <span>{h.name}</span>
                  <span className={styles.headMeta}>Worn on the back</span>
                </button>
              ))}
          </div>
          {draft.cape && (
            <div className={styles.colors}>
              {(
                [
                  ['outer', 'Outside', 'What everyone behind it sees'],
                  ['lining', 'Lining', 'Inside, showing as it billows'],
                ] as const
              ).map(([key, label, hint]) => (
                <label key={key} className={styles.color}>
                  <input
                    type="color"
                    value={draft.cape![key]}
                    onChange={(event) => {
                      const value = event.target.value.toLowerCase();
                      setDraft((d) => (d.cape ? { ...d, cape: { ...d.cape, [key]: value } } : d));
                    }}
                  />
                  <span className={styles.colorText}>
                    <span>Cape {label.toLowerCase()}</span>
                    <code>{draft.cape![key]}</code>
                    <span className={styles.hint}>{hint}</span>
                  </span>
                </label>
              ))}
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => setDraft((d) => ({ ...d, cape: { ...AVATAR_CAPE_DEFAULT } }))}
                disabled={draft.cape.outer === AVATAR_CAPE_DEFAULT.outer && draft.cape.lining === AVATAR_CAPE_DEFAULT.lining}
              >
                Opera classic (black, crimson lining)
              </button>
            </div>
          )}
          {!ownHeads.some((h) => h.fit === 'back') && (
            <p className={styles.hint}>
              Or something of their own (wings, a jetpack, a sword): add a model below as Worn on the back.
            </p>
          )}
        </fieldset>

        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>Colours</legend>
          <div className={styles.colors}>
            {COLOR_FIELDS.map(({ key, label, hint }) => {
              // Two-tone: the Eyes colour is the left eye (as you look at the robot), the right its own.
              const twoTone = key === 'eye' && Boolean(draft.colors.eyeRight);
              return (
                <label key={key} className={styles.color}>
                  <input
                    type="color"
                    value={draft.colors[key]}
                    onChange={(event) => {
                      const value = event.target.value.toLowerCase();
                      setDraft((d) => ({ ...d, colors: { ...d.colors, [key]: value } }));
                    }}
                  />
                  <span className={styles.colorText}>
                    <span>{twoTone ? 'Left eye' : label}</span>
                    <code>{draft.colors[key]}</code>
                    <span className={styles.hint}>{twoTone ? 'As you look at the robot; and the thruster' : hint}</span>
                  </span>
                </label>
              );
            })}
            {draft.colors.eyeRight && (
              <label className={styles.color}>
                <input
                  type="color"
                  value={draft.colors.eyeRight}
                  onChange={(event) => {
                    const value = event.target.value.toLowerCase();
                    setDraft((d) => ({ ...d, colors: { ...d.colors, eyeRight: value } }));
                  }}
                />
                <span className={styles.colorText}>
                  <span>Right eye</span>
                  <code>{draft.colors.eyeRight}</code>
                  <span className={styles.hint}>As you look at the robot</span>
                </span>
              </label>
            )}
          </div>
          <label className={styles.twoTone}>
            <input
              type="checkbox"
              checked={Boolean(draft.colors.eyeRight)}
              onChange={(event) => {
                const on = event.target.checked;
                setDraft((d) => {
                  const rest: AvatarColors = { shell: d.colors.shell, trim: d.colors.trim, accent: d.colors.accent, eye: d.colors.eye };
                  // Switched on, the right eye starts as the left's colour, ready to change.
                  return { ...d, colors: on ? { ...rest, eyeRight: d.colors.eye } : rest };
                });
              }}
            />
            <span>Different right eye</span>
          </label>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }} aria-label="Palettes">
            {AVATAR_PALETTES.map((palette, i) => (
              <button
                key={i}
                type="button"
                className={styles.swatch}
                style={{ width: 30, height: 22, padding: 0, cursor: 'pointer' }}
                title={`Palette ${i + 1}`}
                aria-label={`Use palette ${i + 1}`}
                onClick={() => setDraft((d) => ({ ...d, colors: d.colors.eyeRight ? { ...palette, eyeRight: d.colors.eyeRight } : { ...palette } }))}
              >
                <i style={{ background: palette.shell }} />
                <i style={{ background: palette.trim }} />
                <i style={{ background: palette.eye }} />
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>Finish</legend>
          <div className={styles.heads} role="group" aria-label="Finish">
            {AVATAR_FINISHES.map((kind) => (
              <button
                key={kind}
                type="button"
                className={styles.headChoice}
                aria-pressed={draft.finish === kind}
                onClick={() => setDraft((d) => ({ ...d, finish: kind }))}
              >
                <span>{FINISH_CHOICES[kind].label}</span>
                <span className={styles.headMeta}>{FINISH_CHOICES[kind].hint}</span>
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>Chestplate</legend>
          <div className={styles.chest}>
            <span
              className={styles.chestThumb}
              style={
                saved?.chest && !chestIsClip
                  ? { backgroundImage: `url("/bff/avatars/assets/${saved.chest}")` }
                  : saved?.chest
                    ? {}
                    : { color: draft.colors.eye, borderColor: draft.colors.accent }
              }
              aria-hidden="true"
            >
              {chestIsClip && saved?.chest && <ChestClipThumb sha={saved.chest} />}
              {!saved?.chest && emblemInitials(member.login)}
            </span>
            <div className="stack" style={{ gap: 6 }}>
              <span className="muted">
                {saved?.chest ? (chestIsClip ? 'An uploaded clip (it loops, silently)' : 'An uploaded image') : 'Their initials (no image yet)'}
              </span>
              <div className={styles.actions}>
                <input
                  ref={fileRef}
                  type="file"
                  accept={[...AVATAR_CHEST_TYPES, ...AVATAR_CHEST_VIDEO_TYPES].join(',')}
                  className={styles.visuallyHidden}
                  onChange={(event) => void onChestFile(event)}
                  tabIndex={-1}
                  aria-hidden="true"
                />
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => fileRef.current?.click()}
                  disabled={working}
                  aria-busy={uploading}
                >
                  {uploading && <span className="spinner" aria-hidden="true" />}
                  {uploading ? 'Uploading…' : saved?.chest ? (chestIsClip ? 'Replace clip' : 'Replace image') : 'Upload image or clip'}
                </button>
                {saved?.chest && (
                  <button type="button" className="btn btn-sm btn-ghost" onClick={dropChest} disabled={working} aria-busy={removingChest}>
                    {removingChest && <span className="spinner" aria-hidden="true" />}
                    {removingChest ? 'Removing…' : chestIsClip ? 'Remove clip' : 'Remove image'}
                  </button>
                )}
              </div>
              <span className={styles.hint}>
                PNG, JPEG or WebP, up to {kb(AVATAR_CHEST_MAX_BYTES)} and {AVATAR_CHEST_MAX_PIXELS}px; or a short clip that loops
                silently: MP4 (H.264) or WebM, up to {kb(AVATAR_CHEST_VIDEO_MAX_BYTES)}, {CHEST_VIDEO.maxSeconds} s and{' '}
                {CHEST_VIDEO.maxPixels}px (a GIF or APNG: convert it to MP4 first). Square-ish works best: it is cropped to fill the
                plate. In the lobby a clip plays when you’re near.
              </span>
            </div>
          </div>
          <UploadStatus upload={chestUpload} label="the chestplate" />
        </fieldset>

        {busy.kind === 'error' && (
          <div className={styles.error} role="alert">
            <span>{busy.message}</span>
            <button type="button" className="btn btn-sm" onClick={busy.retry}>
              Try again
            </button>
          </div>
        )}

        <div className={styles.actions}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={save}
            disabled={working || (!dirty && busy.kind !== 'error')}
            aria-busy={busy.kind === 'saving'}
          >
            {busy.kind === 'saving' && <span className="spinner" aria-hidden="true" />}
            {busy.kind === 'saving' ? 'Saving…' : 'Save'}
          </button>
          {busy.kind === 'saved' && (
            <span className={`${styles.status} ${styles.ok}`} role="status">
              ✓ Saved. Everyone in the lobby sees it within a minute.
            </span>
          )}
          {changed && busy.kind !== 'saving' && <span className={styles.dirty}>Unsaved changes</span>}
          {changed && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDraft(baseline)} disabled={working}>
              Undo changes
            </button>
          )}
          <span className="spacer" />
          {saved && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={reset} disabled={working} aria-busy={busy.kind === 'resetting'}>
              {busy.kind === 'resetting' && <span className="spinner" aria-hidden="true" />}
              {busy.kind === 'resetting' ? 'Resetting…' : 'Reset to default'}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

/** The "Fitted over" value for the robot's own head: empty, which no head id can be. */
const OWN_HEAD = '';

interface HeadLibraryProps {
  /** Whose heads: uploads are made for them, and only theirs are listed. Null: nobody chosen yet. */
  member: AvatarMember | null;
  /** Their robot as the editor above shows it now, saved or not. */
  drafted: DraftedLook | null;
  list: AvatarList;
  setList: (update: (list: AvatarList) => AvatarList) => void;
}

function HeadLibrary({ member, drafted, list, setList }: HeadLibraryProps) {
  const [giving, setGiving] = useState<string | null>(null);
  const theirs = member ? list.heads.filter((h) => h.owner === member.memberId) : [];
  const ownHeads = theirs.filter((h) => h.fit === 'replace');
  /**
   * Which head a face accessory is fitted over: a head's id, OWN_HEAD (the robot's own), or null
   * (the default below). OWN_HEAD is empty, which no head id can be.
   */
  const [overChoice, setOverChoice] = useState<string | null>(null);
  const saved = member ? list.avatars.find((a) => a.memberId === member.memberId) : undefined;
  // By default the head the robot above wears now (saved or not), else one it has saved, else its first custom head.
  const draftedHead = drafted ? drafted.head : (saved?.head ?? null);
  const defaultOver =
    ownHeads.find((h) => h.id === draftedHead)?.id ?? ownHeads.find((h) => h.id === saved?.head)?.id ?? ownHeads[0]?.id ?? OWN_HEAD;
  const over = overChoice !== null && (overChoice === OWN_HEAD || ownHeads.some((h) => h.id === overChoice)) ? overChoice : defaultOver;
  const overHead = over === OWN_HEAD ? null : (ownHeads.find((h) => h.id === over) ?? null);
  const wearerColors = drafted?.colors ?? saved?.colors ?? (member ? defaultColors(member.memberId) : null);
  // Whose robot fittings are shown on: its colours as the editor shows them, and the head chosen to fit over.
  const wearerFinish = drafted?.finish ?? saved?.finish ?? 'paint';
  const wearer = useMemo(
    () => (member && wearerColors ? { colors: wearerColors, head: overHead, finish: wearerFinish } : null),
    [member, wearerColors, overHead, wearerFinish],
  );
  const unassigned = list.heads.filter((h) => !h.owner);
  const [name, setName] = useState('');
  const [fit, setFit] = useState<AvatarHeadFit>('replace');
  const [file, setFile] = useState<File | null>(null);
  const [replacing, setReplacing] = useState<AvatarHead | null>(null);
  const [upload, setUpload] = useState<Upload>({ kind: 'idle' });
  const [deleting, setDeleting] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  /** How the chosen file (or the head being adjusted) is worn, from the fitting tool; null until it has read it. */
  const [placement, setPlacement] = useState<AvatarHeadPlacement | null>(null);
  const [adjusting, setAdjusting] = useState<AvatarHead | null>(null);
  const [refit, setRefit] = useState<Busy>({ kind: 'idle' });
  const fileRef = useRef<HTMLInputElement>(null);

  const id = replacing ? replacing.id : headIdFrom(name);
  const idValid = new RegExp(AVATAR_HEAD_ID.source).test(id);
  const taken = !replacing && list.heads.some((h) => h.id === id);
  const busy = upload.kind === 'preparing' || upload.kind === 'uploading' || upload.kind === 'processing';
  const refitting = refit.kind === 'saving';

  const overPicker = (
    <label className={styles.label}>
      Fitted over
      <select className="text-input" value={over} onChange={(event) => setOverChoice(event.target.value)} disabled={busy || refitting}>
        {ownHeads.map((h) => (
          <option key={h.id} value={h.id}>
            {h.name}
          </option>
        ))}
        <option value={OWN_HEAD}>The robot’s own head</option>
      </select>
    </label>
  );
  const ready = member !== null && name.trim().length > 0 && idValid && !taken && file !== null && placement !== null && !busy;
  // Why the add button can't be pressed yet, first thing to do first: it never sits disabled unexplained.
  const takenBy = taken ? list.heads.find((h) => h.id === id) : undefined;
  const blocker = busy
    ? null
    : !member
      ? 'Choose a member first: a head is made for one member.'
      : file === null
        ? 'Choose a .glb file.'
        : name.trim().length === 0
          ? 'Give it a name.'
          : !idValid
            ? 'Use letters or digits in the name.'
            : takenBy
              ? `“${takenBy.name}” already uses the id ${id}${takenBy.owner && takenBy.owner !== member.memberId ? ' (another member’s head)' : ''}: change the name, or use Replace file on that head.`
              : placement === null
                ? 'Waiting for the fitting tool: it is reading the file, or it couldn’t open it (see the preview above).'
                : null;
  const fitSource = useMemo(
    () => (file ? { kind: 'file' as const, file } : adjusting ? { kind: 'library' as const, head: adjusting } : null),
    [file, adjusting],
  );

  const startAdjust = (h: AvatarHead): void => {
    setReplacing(null);
    setFile(null);
    setName('');
    if (fileRef.current) fileRef.current.value = '';
    setUpload({ kind: 'idle' });
    setRefit({ kind: 'idle' });
    setAdjusting(h);
  };

  const saveFit = (): void => {
    if (!adjusting || !placement) return;
    const target = adjusting;
    const fitted = placement;
    setRefit({ kind: 'saving' });
    refitHead(target.id, fitted).then(
      (head) => {
        setList((current) => ({ ...current, heads: current.heads.map((h) => (h.id === head.id ? head : h)) }));
        setAdjusting(head);
        setRefit({ kind: 'saved' });
      },
      (error: unknown) => setRefit({ kind: 'error', message: describeAvatarsError(error), retry: saveFit }),
    );
  };

  const startReplace = (h: AvatarHead): void => {
    setAdjusting(null);
    setReplacing(h);
    setName(h.name);
    setFit(h.fit);
    setFile(null);
    setUpload({ kind: 'idle' });
    fileRef.current?.focus();
  };

  const cancelReplace = (): void => {
    setReplacing(null);
    setName('');
    setFit('replace');
    setFile(null);
  };

  const onFile = (event: ChangeEvent<HTMLInputElement>): void => {
    const chosen = event.target.files?.[0] ?? null;
    setUpload({ kind: 'idle' });
    setAdjusting(null);
    if (chosen && chosen.size > AVATAR_HEAD_MAX_BYTES) {
      setFile(null);
      event.target.value = '';
      setUpload({ kind: 'error', message: `That file is ${kb(chosen.size)}. The most is ${kb(AVATAR_HEAD_MAX_BYTES)}.` });
      return;
    }
    if (chosen && !chosen.name.toLowerCase().endsWith('.glb')) {
      setFile(null);
      event.target.value = '';
      setUpload({ kind: 'error', message: 'Choose a .glb file (binary glTF 2.0).' });
      return;
    }
    setFile(chosen);
    if (chosen && !name.trim()) setName(chosen.name.replace(/\.glb$/i, '').slice(0, AVATAR_HEAD_NAME_MAX));
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!ready || !file) return;
    setUpload({ kind: 'preparing', what: 'Reading the file…' });
    try {
      const head = await uploadHead(
        id,
        name.trim(),
        fit,
        file,
        (progress) => setUpload(progress >= 1 ? { kind: 'processing' } : { kind: 'uploading', progress }),
        placement ?? undefined,
        member?.memberId,
      );
      setList((current) => ({
        ...current,
        heads: [...current.heads.filter((h) => h.id !== head.id), head].sort((a, b) => a.name.localeCompare(b.name)),
      }));
      setUpload({ kind: 'idle' });
      setReplacing(null);
      setName('');
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
    } catch (error) {
      setUpload({ kind: 'error', message: describeAvatarsError(error) });
    }
  };

  const give = (h: AvatarHead): void => {
    if (!member) return;
    setGiving(h.id);
    setRowError(null);
    giveHead(h.id, member.memberId).then(
      (head) => {
        setList((current) => ({ ...current, heads: current.heads.map((x) => (x.id === head.id ? head : x)) }));
        setGiving(null);
      },
      (error: unknown) => {
        setGiving(null);
        setRowError(describeAvatarsError(error));
      },
    );
  };

  const remove = (h: AvatarHead): void => {
    const wearers = list.avatars.filter((a) => a.head === h.id).length;
    const note = wearers ? ` ${wearers} robot${wearers === 1 ? '' : 's'} wearing it go back to their own head.` : '';
    if (!window.confirm(`Delete “${h.name}” from the library?${note}`)) return;
    setDeleting(h.id);
    setRowError(null);
    deleteHead(h.id).then(
      () => {
        if (adjusting?.id === h.id) setAdjusting(null);
        setList((current) => ({
          heads: current.heads.filter((x) => x.id !== h.id),
          avatars: current.avatars.map((a) => (a.head === h.id ? { ...a, head: undefined } : a)),
        }));
        setDeleting(null);
      },
      (error: unknown) => {
        setDeleting(null);
        setRowError(describeAvatarsError(error));
      },
    );
  };

  return (
    <section className={`card ${styles.library}`} aria-labelledby="head-library">
      <div>
        <h2 id="head-library" className="section-title">
          {member ? `Heads for @${member.login}` : 'Heads'}
        </h2>
        <p className="muted">
          Each head is made for one member: only they can wear it, and it is only offered on their robot.{' '}
          {member ? '' : 'Choose a member above to see and add theirs.'}
        </p>
        <p className="muted">
          Heads are .glb files (binary glTF 2.0, self-contained), straight from Tripo or any modeller, facing +Z. Pick one and the
          fitting tool sizes it and sets it on a robot; nudge it there, then add it. <strong>Adjust fit</strong> changes a head
          already in the library without uploading it again. Materials named <code>shell…</code>, <code>trim…</code>,{' '}
          <code>accent…</code>, <code>joint…</code> or <code>eye…</code> take each robot’s colours.
        </p>
        <ul className={styles.hint} style={{ margin: '8px 0 0', paddingLeft: 18 }}>
          <li>
            <strong>Replaces the head</strong>: the robot’s own head is hidden. Click the head to place each blinking eye (or
            keep the file’s own <code>EyeL</code> and <code>EyeR</code> empties, if it has them).
          </li>
          <li>
            <strong>Face accessory</strong>: worn over the robot’s own head (a mask, a visor, a helmet). The eyes stay on the face
            screen; whatever covers them hides them, and an eye hole shows them through: click the hole to line it up with an eye.
          </li>
          <li>
            <strong>Worn on the back</strong>: between the shoulder blades, following the body (wings, a jetpack, a sword). Its
            front goes against the robot’s back. (A cape needs no model: pick Cape under Back.)
          </li>
        </ul>
      </div>

      {!member ? null : theirs.length === 0 ? (
        <p className="muted">No heads made for @{member.login} yet.</p>
      ) : (
        <ul className={styles.libraryRows} aria-label={`Heads for @${member.login}`}>
          {theirs.map((h) => (
            <li key={h.id} className={styles.libraryRow}>
              <span style={{ flex: 1, minWidth: 140 }}>
                <strong>{h.name}</strong> <span className={styles.headMeta}>· {h.id}</span>
              </span>
              <span className="chip">{FIT_LABEL[h.fit]}</span>
              {h.fit === 'replace' && !h.eyes && <span className="chip chip-warn">No EyeL/EyeR: no eyes</span>}
              {h.placement.flyer === 'helicopter' && <span className="chip">Helicopter</span>}
              {h.placement.emitter === 'bricks' && <span className="chip">Makes bricks</span>}
              <span className={styles.headMeta}>{kb(h.bytes)}</span>
              <span className={styles.headMeta}>{list.avatars.filter((a) => a.head === h.id).length} wearing</span>
              <button
                type="button"
                className={`btn btn-sm ${adjusting?.id === h.id ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => startAdjust(h)}
                disabled={busy || refitting || deleting !== null}
                aria-pressed={adjusting?.id === h.id}
              >
                Adjust fit
              </button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => startReplace(h)} disabled={busy || refitting || deleting !== null}>
                Replace file
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => remove(h)}
                disabled={busy || refitting || deleting !== null}
                aria-busy={deleting === h.id}
              >
                {deleting === h.id && <span className="spinner" aria-hidden="true" />}
                {deleting === h.id ? 'Deleting…' : 'Delete'}
              </button>
            </li>
          ))}
        </ul>
      )}
      {unassigned.length > 0 && (
        <div className="stack">
          <h3 className="card-title" style={{ margin: 0 }}>
            Not given to anyone yet
          </h3>
          <ul className={styles.libraryRows} aria-label="Heads not given to anyone">
            {unassigned.map((h) => (
              <li key={h.id} className={styles.libraryRow}>
                <span style={{ flex: 1, minWidth: 140 }}>
                  <strong>{h.name}</strong> <span className={styles.headMeta}>· {h.id}</span>
                </span>
                <span className="chip">{FIT_LABEL[h.fit]}</span>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => give(h)}
                  disabled={!member || giving !== null || deleting !== null || busy}
                  aria-busy={giving === h.id}
                >
                  {giving === h.id && <span className="spinner" aria-hidden="true" />}
                  {giving === h.id ? 'Giving…' : member ? `Give to @${member.login}` : 'Choose a member first'}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => remove(h)}
                  disabled={giving !== null || deleting !== null || busy}
                  aria-busy={deleting === h.id}
                >
                  {deleting === h.id && <span className="spinner" aria-hidden="true" />}
                  {deleting === h.id ? 'Deleting…' : 'Delete'}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {rowError && (
        <p className={styles.error} role="alert">
          {rowError}
        </p>
      )}

      {adjusting && fitSource?.kind === 'library' && (
        <div className="stack" aria-labelledby="head-refit">
          <h3 id="head-refit" className="card-title" style={{ margin: 0 }}>
            Fitting “{adjusting.name}”
          </h3>
          {adjusting.fit === 'accessory' && overPicker}
          <HeadFitter
            source={fitSource}
            fit={adjusting.fit}
            initial={adjusting.placement}
            onChange={(next) => {
              setPlacement(next);
              setRefit((current) => (current.kind === 'saved' || current.kind === 'error' ? { kind: 'idle' } : current));
            }}
            disabled={refitting}
            wearer={wearer}
          />
          <div className={styles.actions}>
            <button type="button" className="btn btn-primary" onClick={saveFit} disabled={placement === null || refitting} aria-busy={refitting}>
              {refitting && <span className="spinner" aria-hidden="true" />}
              {refitting ? 'Saving…' : 'Save fit'}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setAdjusting(null)} disabled={refitting}>
              Close
            </button>
            {refit.kind === 'saved' && (
              <span className={styles.status} role="status">
                Saved ✓ Every robot wearing it now wears it this way.
              </span>
            )}
          </div>
          {refit.kind === 'error' && (
            <div className={styles.error} role="alert">
              {refit.message}{' '}
              <button type="button" className="btn btn-sm" onClick={refit.retry}>
                Try again
              </button>
            </div>
          )}
        </div>
      )}

      <form className="stack" onSubmit={(event) => void submit(event)} aria-labelledby="head-upload">
        <h3 id="head-upload" className="card-title" style={{ margin: 0 }}>
          {replacing ? `Replace “${replacing.name}”` : member ? `Add a head for @${member.login}` : 'Add a head (choose a member first)'}
        </h3>
        <div className={styles.uploadForm}>
          <label className={styles.label}>
            Name
            <input
              className="text-input"
              value={name}
              maxLength={AVATAR_HEAD_NAME_MAX}
              onChange={(event) => setName(event.target.value)}
              placeholder="Phantom mask"
              disabled={busy || !member}
            />
            <span className={styles.hint}>
              {id ? <>Saved as <code>{id}</code></> : 'Letters or digits, please.'}
              {taken ? ' — another head already has this name: pick another.' : ''}
            </span>
          </label>
          <label className={styles.label}>
            File (.glb, up to {kb(AVATAR_HEAD_MAX_BYTES)})
            <input ref={fileRef} className="text-input" type="file" accept=".glb,model/gltf-binary" onChange={onFile} disabled={busy || !member} />
          </label>
          <div className={styles.radios} role="radiogroup" aria-label="How it fits">
            {(['replace', 'accessory', 'back'] as const).map((value) => (
              <label key={value} className={styles.radio}>
                <input type="radio" name="fit" value={value} checked={fit === value} onChange={() => setFit(value)} disabled={busy} />
                <span>
                  {FIT_LABEL[value]}
                  <br />
                  <span className={styles.hint}>
                    {value === 'replace'
                      ? 'The robot’s own head is hidden.'
                      : value === 'accessory'
                        ? 'Worn over the robot’s own head; can cover the eyes.'
                        : 'Between the shoulder blades: wings, a jetpack, a sword.'}
                  </span>
                </span>
              </label>
            ))}
          </div>
          {fitSource?.kind === 'file' && (
            <div className={styles.fitWide}>
              {fit === 'accessory' && overPicker}
              <HeadFitter source={fitSource} fit={fit} initial={null} onChange={setPlacement} disabled={busy} wearer={wearer} />
            </div>
          )}
          <div className={styles.actions}>
            <button type="submit" className="btn btn-primary" disabled={!ready} aria-busy={busy}>
              {busy && <span className="spinner" aria-hidden="true" />}
              {busy ? 'Uploading…' : replacing ? 'Upload replacement' : 'Add to library'}
            </button>
            {replacing && (
              <button type="button" className="btn btn-ghost" onClick={cancelReplace} disabled={busy}>
                Cancel
              </button>
            )}
            {blocker && (
              <span className={styles.hint} role="status" data-testid="add-head-blocker">
                Can’t add yet: {blocker}
              </span>
            )}
          </div>
        </div>

        <UploadStatus upload={upload} label="the head" />
      </form>
    </section>
  );
}
