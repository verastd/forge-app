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
import { AVATAR_PALETTES, defaultColors, emblemInitials } from '@forge/lobby';
import type { AvatarColors } from '@forge/lobby';
import {
  AVATAR_CHEST_MAX_BYTES,
  AVATAR_CHEST_MAX_PIXELS,
  AVATAR_CHEST_TYPES,
  AVATAR_HEAD_ID,
  AVATAR_HEAD_MAX_BYTES,
  AVATAR_HEAD_NAME_MAX,
} from '@forge/shared';
import type { Avatar, AvatarHead, AvatarHeadFit, AvatarList, AvatarMember } from '@forge/shared';

import {
  AvatarsError,
  deleteHead,
  describeAvatarsError,
  fetchAvatars,
  fetchMembers,
  headIdFrom,
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

const COLOR_FIELDS: { key: keyof AvatarColors; label: string; hint: string }[] = [
  { key: 'shell', label: 'Armour', hint: 'Torso, pod, gauntlets' },
  { key: 'trim', label: 'Trim', hint: 'Hip ring, arms, palms' },
  { key: 'accent', label: 'Accent', hint: 'Chestplate and face rims' },
  { key: 'eye', label: 'Eyes', hint: 'Eyes and thruster' },
];

const FIT_LABEL: Record<AvatarHeadFit, string> = {
  replace: 'Replaces the head',
  accessory: 'Face accessory',
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
}

function draftFor(memberId: string, list: AvatarList): Draft {
  const saved = list.avatars.find((a) => a.memberId === memberId);
  return { colors: saved?.colors ?? defaultColors(memberId), head: saved?.head ?? null };
}

function sameDraft(a: Draft, b: Draft): boolean {
  return a.head === b.head && (Object.keys(a.colors) as (keyof AvatarColors)[]).every((k) => a.colors[k] === b.colors[k]);
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
                      </span>
                      <span className={styles.memberName}>@{member.login}</span>
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

      <HeadLibrary list={list} setList={setList} />
    </div>
  );
}

interface RobotEditorProps {
  member: AvatarMember;
  list: AvatarList;
  setList: (update: (list: AvatarList) => AvatarList) => void;
  onDirty: (dirty: boolean) => void;
}

function RobotEditor({ member, list, setList, onDirty }: RobotEditorProps) {
  const saved: Avatar | undefined = list.avatars.find((a) => a.memberId === member.memberId);
  const [draft, setDraft] = useState<Draft>(() => draftFor(member.memberId, list));
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
  const look: RobotLook = useMemo(
    () => ({ id: member.memberId, name: member.login, colors: draft.colors, head, chest: saved?.chest ?? null }),
    [member.memberId, member.login, draft.colors, head, saved?.chest],
  );

  const commit = useCallback(async (): Promise<Avatar> => {
    const result = await saveAvatar(member.memberId, { colors: draft.colors, ...(draft.head ? { head: draft.head } : {}) });
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
        setDraft({ colors: defaultColors(member.memberId), head: null });
        setBusy({ kind: 'idle' });
      },
      (error: unknown) => setBusy({ kind: 'error', message: describeAvatarsError(error), retry: reset }),
    );
  };

  const onChestFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!(AVATAR_CHEST_TYPES as readonly string[]).includes(file.type)) {
      setChestUpload({ kind: 'error', message: 'Use a PNG, JPEG or WebP image.' });
      return;
    }
    if (file.size > AVATAR_CHEST_MAX_BYTES) {
      setChestUpload({ kind: 'error', message: `That image is ${kb(file.size)}. The most is ${kb(AVATAR_CHEST_MAX_BYTES)}.` });
      return;
    }
    setChestUpload({ kind: 'preparing', what: 'Checking the image…' });
    try {
      const { width, height } = await imageSize(file);
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
  const missingHead = saved?.head && !list.heads.some((h) => h.id === saved.head);

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
            {list.heads.map((h) => (
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
                  {h.fit === 'replace' && !h.eyes ? ' · no eyes' : ''}
                </span>
              </button>
            ))}
          </div>
          {list.heads.length === 0 && <p className={styles.hint}>Upload heads and face accessories in the library below.</p>}
          {missingHead && <p className={styles.hint}>The head this robot wore was taken out of the library.</p>}
        </fieldset>

        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>Colours</legend>
          <div className={styles.colors}>
            {COLOR_FIELDS.map(({ key, label, hint }) => (
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
                  <span>{label}</span>
                  <code>{draft.colors[key]}</code>
                  <span className={styles.hint}>{hint}</span>
                </span>
              </label>
            ))}
          </div>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }} aria-label="Palettes">
            {AVATAR_PALETTES.map((palette, i) => (
              <button
                key={i}
                type="button"
                className={styles.swatch}
                style={{ width: 30, height: 22, padding: 0, cursor: 'pointer' }}
                title={`Palette ${i + 1}`}
                aria-label={`Use palette ${i + 1}`}
                onClick={() => setDraft((d) => ({ ...d, colors: { ...palette } }))}
              >
                <i style={{ background: palette.shell }} />
                <i style={{ background: palette.trim }} />
                <i style={{ background: palette.eye }} />
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
                saved?.chest
                  ? { backgroundImage: `url("/bff/avatars/assets/${saved.chest}")` }
                  : { color: draft.colors.eye, borderColor: draft.colors.accent }
              }
              aria-hidden="true"
            >
              {!saved?.chest && emblemInitials(member.login)}
            </span>
            <div className="stack" style={{ gap: 6 }}>
              <span className="muted">{saved?.chest ? 'An uploaded image' : 'Their initials (no image yet)'}</span>
              <div className={styles.actions}>
                <input
                  ref={fileRef}
                  type="file"
                  accept={AVATAR_CHEST_TYPES.join(',')}
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
                  {uploading ? 'Uploading…' : saved?.chest ? 'Replace image' : 'Upload image'}
                </button>
                {saved?.chest && (
                  <button type="button" className="btn btn-sm btn-ghost" onClick={dropChest} disabled={working} aria-busy={removingChest}>
                    {removingChest && <span className="spinner" aria-hidden="true" />}
                    {removingChest ? 'Removing…' : 'Remove image'}
                  </button>
                )}
              </div>
              <span className={styles.hint}>
                PNG, JPEG or WebP, up to {kb(AVATAR_CHEST_MAX_BYTES)} and {AVATAR_CHEST_MAX_PIXELS}px. Square-ish works best: it is
                cropped to fill the plate.
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

interface HeadLibraryProps {
  list: AvatarList;
  setList: (update: (list: AvatarList) => AvatarList) => void;
}

function HeadLibrary({ list, setList }: HeadLibraryProps) {
  const [name, setName] = useState('');
  const [fit, setFit] = useState<AvatarHeadFit>('replace');
  const [file, setFile] = useState<File | null>(null);
  const [replacing, setReplacing] = useState<AvatarHead | null>(null);
  const [upload, setUpload] = useState<Upload>({ kind: 'idle' });
  const [deleting, setDeleting] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const id = replacing ? replacing.id : headIdFrom(name);
  const idValid = new RegExp(AVATAR_HEAD_ID.source).test(id);
  const taken = !replacing && list.heads.some((h) => h.id === id);
  const busy = upload.kind === 'preparing' || upload.kind === 'uploading' || upload.kind === 'processing';
  const ready = name.trim().length > 0 && idValid && !taken && file !== null && !busy;

  const startReplace = (h: AvatarHead): void => {
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
      const head = await uploadHead(id, name.trim(), fit, file, (progress) =>
        setUpload(progress >= 1 ? { kind: 'processing' } : { kind: 'uploading', progress }),
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

  const remove = (h: AvatarHead): void => {
    const wearers = list.avatars.filter((a) => a.head === h.id).length;
    const note = wearers ? ` ${wearers} robot${wearers === 1 ? '' : 's'} wearing it go back to their own head.` : '';
    if (!window.confirm(`Delete “${h.name}” from the library?${note}`)) return;
    setDeleting(h.id);
    setRowError(null);
    deleteHead(h.id).then(
      () => {
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
          Head library
        </h2>
        <p className="muted">
          Heads are .glb files (binary glTF 2.0, self-contained), modelled around the neck: origin where the head meets the neck, +Y
          up, facing +Z, in metres at the robot’s own size (its head is about 0.32 m wide). Materials named <code>shell…</code>,{' '}
          <code>trim…</code>, <code>accent…</code>, <code>joint…</code> or <code>eye…</code> take each robot’s colours.
        </p>
        <ul className={styles.hint} style={{ margin: '8px 0 0', paddingLeft: 18 }}>
          <li>
            <strong>Replaces the head</strong>: the robot’s own head is hidden. Add empties named <code>EyeL</code> and{' '}
            <code>EyeR</code> where the blinking eyes go (their scale sizes the eyes); without them the head has no eyes.
          </li>
          <li>
            <strong>Face accessory</strong>: worn over the robot’s own head (a mask, a visor, a helmet). The face screen and the
            eyes stay put, about 0.12 m in front of the neck and 0.1 m up; whatever the accessory puts in front of them covers
            them, and an eye hole shows them through.
          </li>
        </ul>
      </div>

      {list.heads.length === 0 ? (
        <p className="muted">No heads yet.</p>
      ) : (
        <ul className={styles.libraryRows}>
          {list.heads.map((h) => (
            <li key={h.id} className={styles.libraryRow}>
              <span style={{ flex: 1, minWidth: 140 }}>
                <strong>{h.name}</strong> <span className={styles.headMeta}>· {h.id}</span>
              </span>
              <span className="chip">{FIT_LABEL[h.fit]}</span>
              {h.fit === 'replace' && !h.eyes && <span className="chip chip-warn">No EyeL/EyeR: no eyes</span>}
              <span className={styles.headMeta}>{kb(h.bytes)}</span>
              <span className={styles.headMeta}>{list.avatars.filter((a) => a.head === h.id).length} wearing</span>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => startReplace(h)} disabled={busy || deleting !== null}>
                Replace file
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => remove(h)}
                disabled={busy || deleting !== null}
                aria-busy={deleting === h.id}
              >
                {deleting === h.id && <span className="spinner" aria-hidden="true" />}
                {deleting === h.id ? 'Deleting…' : 'Delete'}
              </button>
            </li>
          ))}
        </ul>
      )}
      {rowError && (
        <p className={styles.error} role="alert">
          {rowError}
        </p>
      )}

      <form className="stack" onSubmit={(event) => void submit(event)} aria-labelledby="head-upload">
        <h3 id="head-upload" className="card-title" style={{ margin: 0 }}>
          {replacing ? `Replace “${replacing.name}”` : 'Add a head'}
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
              disabled={busy}
            />
            <span className={styles.hint}>
              {id ? <>Saved as <code>{id}</code></> : 'Letters or digits, please.'}
              {taken ? ' — already in the library: use Replace file on it, or another name.' : ''}
            </span>
          </label>
          <label className={styles.label}>
            File (.glb, up to {kb(AVATAR_HEAD_MAX_BYTES)})
            <input ref={fileRef} className="text-input" type="file" accept=".glb,model/gltf-binary" onChange={onFile} disabled={busy} />
          </label>
          <div className={styles.radios} role="radiogroup" aria-label="How it fits">
            {(['replace', 'accessory'] as const).map((value) => (
              <label key={value} className={styles.radio}>
                <input type="radio" name="fit" value={value} checked={fit === value} onChange={() => setFit(value)} disabled={busy} />
                <span>
                  {FIT_LABEL[value]}
                  <br />
                  <span className={styles.hint}>
                    {value === 'replace' ? 'The robot’s own head is hidden.' : 'Worn over the robot’s own head; can cover the eyes.'}
                  </span>
                </span>
              </label>
            ))}
          </div>
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
          </div>
        </div>
        <UploadStatus upload={upload} label="the head" />
      </form>
    </section>
  );
}
