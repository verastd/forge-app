import { describe, expect, it } from 'vitest';
import * as shared from './index.js';
import {
  AVATAR_PLACEMENT_AS_IS,
  AVATAR_PLACEMENT_ANGLE,
  AVATAR_PLACEMENT_EYE_ANGLE,
  AVATAR_PLACEMENT_EYE_SCALE_MAX,
  AVATAR_PLACEMENT_EYE_SCALE_MIN,
  AVATAR_PLACEMENT_SCREEN_MAX,
  AvatarHeadOwnerSchema,
  AVATAR_PLACEMENT_REACH,
  AVATAR_PLACEMENT_SCALE_MAX,
  AVATAR_PLACEMENT_SCALE_MIN,
  ActionCodesSchema,
  AvatarHeadPlacementSchema,
  AvatarHeadRefitSchema,
  AvatarHeadUploadSchema,
  ActionDistributionEntrySchema,
  ActiveAccountSchema,
  AuthorizeCheckSchema,
  AuthorizeDecisionSchema,
  AuthorizeErrorSchema,
  AuthorizeParamsSchema,
  BRIDGE_EVENT_KINDS,
  BRIDGE_EVENT_SOURCES,
  BRIDGE_STAGES,
  BridgeEventKindSchema,
  BridgeEventSchema,
  BridgeEventSourceSchema,
  BridgeStatusSchema,
  CHECK_RUN_STATUSES,
  CHECK_STATES,
  CREDENTIAL_KINDS,
  ChainInfoSchema,
  CheckResultsSchema,
  CheckRunSchema,
  CheckRunStatusSchema,
  CheckStateSchema,
  ClaimRequestSchema,
  ClaimResponseSchema,
  ConnectedAgentListSchema,
  ConnectedAgentSchema,
  ContributorProfileSchema,
  CopyResultSchema,
  CredentialKindSchema,
  CredentialSchema,
  DispatchRequestSchema,
  DispatchResultSchema,
  FLAG_NAMES,
  FeedbackResponseSchema,
  FlagConfigSchema,
  ForkStatusSchema,
  GcsStatusSchema,
  GcsSyncResultSchema,
  OPEN_RAILS,
  PROGRESS_STAGES,
  PriceDistributionBucketSchema,
  ProgressStageSchema,
  RAILS,
  RAIL_MODES,
  REWARD_CLASSES,
  RailInfoSchema,
  RailListSchema,
  RailMetaSchema,
  RailModeSchema,
  RailSchema,
  REPO_ACTION_ERRORS,
  RepoActionRequestSchema,
  RepoCopySchema,
  ReviewResultSchema,
  SIZES,
  START_RAILS,
  SalesVolumeDaySchema,
  SavedCredentialListSchema,
  SavedCredentialSchema,
  ScrapeRequestSchema,
  ScrapeStatusSchema,
  SubmitRequestSchema,
  TIERS,
  TIER_FLOORS,
  TaskCardSchema,
  TaskDetailSchema,
  TaskListSchema,
  TimeSeriesPointSchema,
  UPLAND_EXPORT_TYPES,
  UPLAND_INTERVALS,
  UPLAND_PROPERTY_SORTS,
  UplandActionListSchema,
  UplandActionSchema,
  UplandEstimateSchema,
  UplandHealthSchema,
  UplandPropertyListSchema,
  UplandPropertySchema,
  UplandStatsOverviewSchema,
} from './index.js';

describe('History (removed in v0.2)', () => {
  it('is gone from the contract, as it is from apps/api/src/forge_api/models.py', () => {
    const leftovers = Object.keys(shared).filter(
      (name) => name.startsWith('History') || name === 'EXPORT_COLUMNS',
    );
    expect(leftovers).toEqual([]);
  });
});

describe('FlagConfigSchema', () => {
  const ALL_ON = {
    csv_export: true,
    contribute_bridge: true,
    upland_data: true,
    github_signin: true,
    apps_lobby: true,
    mcp_connector: true,
    agent_start: true,
    proposals: true,
    house_spec: true,
    lobby_avatars: true,
  };

  /** ALL_ON without `name`: a config written before that flag existed. */
  function without(name: keyof typeof ALL_ON): Record<string, boolean> {
    const config: Record<string, boolean> = { ...ALL_ON };
    delete config[name];
    return config;
  }

  it('accepts a fully specified boolean config', () => {
    const result = FlagConfigSchema.safeParse({
      csv_export: true,
      contribute_bridge: false,
      upland_data: true,
      github_signin: false,
      apps_lobby: true,
      mcp_connector: true,
      agent_start: false,
      proposals: true,
      house_spec: false,
      lobby_avatars: false,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a config missing a required key', () => {
    const result = FlagConfigSchema.safeParse({ csv_export: true, contribute_bridge: false });
    expect(result.success).toBe(false);
  });

  it.each(['github_signin', 'apps_lobby', 'mcp_connector', 'agent_start', 'proposals', 'house_spec', 'lobby_avatars'] as const)(
    'requires %s: a config written before the flag existed is incomplete',
    (name) => {
      expect(FlagConfigSchema.safeParse(ALL_ON).success).toBe(true);
      expect(FlagConfigSchema.safeParse(without(name)).success).toBe(false);
    },
  );

  it('rejects non-boolean values', () => {
    const result = FlagConfigSchema.safeParse({
      csv_export: 'true',
      contribute_bridge: false,
      upland_data: false,
      github_signin: false,
      apps_lobby: false,
      mcp_connector: false,
      agent_start: false,
      proposals: false,
      house_spec: false,
      lobby_avatars: false,
    });
    expect(result.success).toBe(false);
  });

  it.each(['apps_lobby', 'mcp_connector', 'agent_start', 'proposals', 'house_spec', 'lobby_avatars'] as const)(
    'rejects a non-boolean %s',
    (name) => {
      expect(FlagConfigSchema.safeParse({ ...ALL_ON, [name]: 'true' }).success).toBe(false);
    },
  );

  it('exposes the flag names as a const tuple', () => {
    expect(FLAG_NAMES).toEqual([
      'csv_export',
      'contribute_bridge',
      'upland_data',
      'github_signin',
      'apps_lobby',
      'mcp_connector',
      'agent_start',
      'proposals',
      'house_spec',
      'lobby_avatars',
    ]);
    expect(Object.keys(FlagConfigSchema.shape)).toEqual([...FLAG_NAMES]);
  });
});

describe('TaskCardSchema', () => {
  it('accepts a full valid open task card', () => {
    const result = TaskCardSchema.safeParse({
      id: 42,
      title: 'Make the history page load faster on mobile',
      civilianSummary: 'Speed up a slow page on phones.',
      size: 'S',
      rewardClass: 'R1',
      tierFloor: 'T0',
      status: 'open',
      url: 'https://github.com/verastd/forge-app/issues/42',
      labels: ['agent-ready', 'status:open'],
    });
    expect(result.success).toBe(true);
  });

  it('carries no dollar amount: a stray rewardUsd is dropped, never passed on', () => {
    const parsed = TaskCardSchema.parse({
      id: 42,
      title: 'Make the history page load faster on mobile',
      civilianSummary: 'Speed up a slow page on phones.',
      size: 'S',
      rewardClass: 'R1',
      rewardUsd: 25,
      tierFloor: 'T0',
      status: 'open',
      url: 'https://github.com/verastd/forge-app/issues/42',
      labels: [],
    });
    expect(parsed).not.toHaveProperty('rewardUsd');
  });

  it('accepts a claimed card with the optional claim fields', () => {
    const result = TaskCardSchema.safeParse({
      id: 43,
      title: 'Fix flaky export test',
      civilianSummary: 'Make a test stop failing randomly.',
      size: 'XS',
      rewardClass: 'none',
      tierFloor: 'T1',
      status: 'claimed',
      url: 'https://github.com/verastd/forge-app/issues/43',
      labels: [],
      claimedBy: 'maya',
      leaseEndsAt: '2026-08-12T00:00:00Z',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a size outside XS/S/M', () => {
    const result = TaskCardSchema.safeParse({
      id: 44,
      title: 'x',
      civilianSummary: 'x',
      size: 'L',
      rewardClass: 'R1',
      tierFloor: 'T0',
      status: 'open',
      url: 'https://example.com',
      labels: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a tierFloor of T3 (only T0/T1/T2 are valid floors)', () => {
    const result = TaskCardSchema.safeParse({
      id: 45,
      title: 'x',
      civilianSummary: 'x',
      size: 'M',
      rewardClass: 'R1',
      tierFloor: 'T3',
      status: 'open',
      url: 'https://example.com',
      labels: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown status', () => {
    const result = TaskCardSchema.safeParse({
      id: 46,
      title: 'x',
      civilianSummary: 'x',
      size: 'M',
      rewardClass: 'R1',
      tierFloor: 'T0',
      status: 'merged',
      url: 'https://example.com',
      labels: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-integer id', () => {
    const result = TaskCardSchema.safeParse({
      id: 46.5,
      title: 'x',
      civilianSummary: 'x',
      size: 'M',
      rewardClass: 'R1',
      tierFloor: 'T0',
      status: 'open',
      url: 'https://example.com',
      labels: [],
    });
    expect(result.success).toBe(false);
  });
});

describe('SIZES / REWARD_CLASSES / TIERS / TIER_FLOORS', () => {
  it('are the frozen const tuples', () => {
    expect(SIZES).toEqual(['XS', 'S', 'M']);
    expect(REWARD_CLASSES).toEqual(['none', 'R1', 'R2', 'R3', 'R4']);
    expect(TIERS).toEqual(['T0', 'T1', 'T2', 'T3']);
    expect(TIER_FLOORS).toEqual(['T0', 'T1', 'T2']);
  });

  it('a task card takes exactly the tier floors', () => {
    expect(TaskCardSchema.shape.tierFloor.options).toEqual([...TIER_FLOORS]);
  });
});

describe('RailSchema / RAILS', () => {
  it('lists the start rails, then the open rails, in display order', () => {
    expect(START_RAILS).toEqual(['copilot', 'jules', 'cursor', 'devin', 'openhands', 'claude-routine']);
    expect(OPEN_RAILS).toEqual(['claude-code', 'claude-cli', 'codex', 'vscode', 'cursor-app', 'antigravity']);
    expect(RAILS).toEqual([...START_RAILS, ...OPEN_RAILS]);
    expect(RailSchema.options).toEqual([...RAILS]);
  });

  it('accepts every declared rail', () => {
    for (const rail of RAILS) {
      expect(RailSchema.safeParse(rail).success).toBe(true);
    }
  });

  it('rejects an unknown rail, including the retired Gemini CLI', () => {
    expect(RailSchema.safeParse('chatgpt-desktop').success).toBe(false);
    expect(RailSchema.safeParse('gemini-cli').success).toBe(false);
  });

  it('has two modes and four credential kinds', () => {
    expect(RAIL_MODES).toEqual(['start', 'open']);
    expect(RailModeSchema.safeParse('api').success).toBe(false);
    expect(CREDENTIAL_KINDS).toEqual(['github', 'api_key', 'devin', 'routine']);
    expect(CredentialKindSchema.safeParse('password').success).toBe(false);
  });
});

const JULES_META = {
  id: 'jules',
  mode: 'start',
  label: 'Google Jules',
  vendor: 'Google',
  blurb: "Google's Gemini agent works in your copy and opens a pull request.",
  setup: ['Press Get started on the task page, and FORGE makes your copy of its code.'],
  credential: 'api_key',
  keyUrl: 'https://jules.google.com/settings',
  plan: 'Free for 15 tasks a day.',
};

describe('RailMetaSchema / RailInfoSchema / RailListSchema', () => {
  it('accepts a start rail and an open rail without the start-only fields', () => {
    expect(RailMetaSchema.safeParse(JULES_META).success).toBe(true);
    const open = { id: 'codex', mode: 'open', label: 'Codex app', vendor: 'OpenAI', blurb: 'b', setup: [] };
    expect(RailMetaSchema.safeParse(open).success).toBe(true);
  });

  it('a RailInfo is a RailMeta plus enabled, and savedCredential only when known', () => {
    expect(RailInfoSchema.safeParse(JULES_META).success).toBe(false);
    expect(RailInfoSchema.safeParse({ ...JULES_META, enabled: false }).success).toBe(true);
    expect(RailInfoSchema.safeParse({ ...JULES_META, enabled: true, savedCredential: true }).success).toBe(true);
    expect(Object.keys(RailInfoSchema.shape)).toEqual([...Object.keys(RailMetaSchema.shape), 'enabled', 'savedCredential']);
  });

  it('rejects null for an optional field: the wire leaves it out instead', () => {
    expect(RailMetaSchema.safeParse({ ...JULES_META, keyUrl: null }).success).toBe(false);
    expect(RailInfoSchema.safeParse({ ...JULES_META, enabled: true, savedCredential: null }).success).toBe(false);
  });

  it('a RailList carries the vault switch', () => {
    expect(RailListSchema.safeParse({ rails: [{ ...JULES_META, enabled: true }], vault: false }).success).toBe(true);
    expect(RailListSchema.safeParse({ rails: [] }).success).toBe(false);
  });
});

const CARD = {
  id: 7,
  title: 'Build the feature-flags admin page',
  civilianSummary: 'Give the team a simple screen to switch app features on and off.',
  size: 'M',
  rewardClass: 'R1',
  tierFloor: 'T1',
  status: 'claimed',
  url: 'https://github.com/verastd/forge-app/issues/7',
  labels: ['agent-ready'],
  claimedBy: 'maya',
};

describe('TaskListSchema / TaskDetailSchema / ForkStatusSchema', () => {
  it('a task list wraps cards', () => {
    expect(TaskListSchema.safeParse({ tasks: [CARD] }).success).toBe(true);
    expect(TaskListSchema.safeParse([CARD]).success).toBe(false);
  });

  it('a task detail carries the card, criteria, branch and brief', () => {
    const detail = { task: CARD, acceptanceCriteria: ['It works'], branch: 'task/7-x', brief: 'FORGE task #7: x' };
    expect(TaskDetailSchema.safeParse(detail).success).toBe(true);
    expect(TaskDetailSchema.safeParse({ ...detail, brief: undefined }).success).toBe(false);
  });

  it('a task detail may carry the holder\'s copy and whether there is something to send for review', () => {
    const detail = { task: CARD, acceptanceCriteria: [], branch: 'task/7-x', brief: 'FORGE task #7: x' };
    const copy = { fullName: 'maya/forge-app-1', syncedAt: '2026-10-05T12:00:00Z' };
    expect(TaskDetailSchema.safeParse({ ...detail, copy, canSendForReview: true }).success).toBe(true);
    expect(TaskDetailSchema.safeParse({ ...detail, copy: null }).success).toBe(false);
    expect(TaskDetailSchema.safeParse({ ...detail, canSendForReview: null }).success).toBe(false);
    expect(TaskDetailSchema.safeParse({ ...detail, copy: { fullName: 'maya/forge-app' } }).success).toBe(false);
    expect(RepoCopySchema.safeParse(copy).success).toBe(true);
  });

  it('a fork status has an optional url', () => {
    expect(ForkStatusSchema.safeParse({ exists: false }).success).toBe(true);
    expect(ForkStatusSchema.safeParse({ exists: true, url: 'https://github.com/maya/forge-app' }).success).toBe(true);
    expect(ForkStatusSchema.safeParse({ exists: false, url: null }).success).toBe(false);
  });
});

describe('CredentialSchema / DispatchRequestSchema', () => {
  it('accepts a dispatch with nothing but the task and rail', () => {
    expect(DispatchRequestSchema.safeParse({ taskId: 42, rail: 'claude-code' }).success).toBe(true);
  });

  it('accepts a pasted credential and the save switch', () => {
    const result = DispatchRequestSchema.safeParse({
      taskId: 42,
      rail: 'devin',
      credential: { key: 'test-only-key', orgId: 'org-1' },
      saveCredential: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid rail', () => {
    expect(DispatchRequestSchema.safeParse({ taskId: 42, rail: 'not-a-rail' }).success).toBe(false);
  });

  it('bounds every credential field', () => {
    expect(CredentialSchema.safeParse({ key: '' }).success).toBe(false);
    expect(CredentialSchema.safeParse({ key: 'k'.repeat(4096) }).success).toBe(true);
    expect(CredentialSchema.safeParse({ key: 'k'.repeat(4097) }).success).toBe(false);
    expect(CredentialSchema.safeParse({ key: 'k', orgId: 'o'.repeat(200) }).success).toBe(true);
    expect(CredentialSchema.safeParse({ key: 'k', orgId: 'o'.repeat(201) }).success).toBe(false);
    expect(CredentialSchema.safeParse({ key: 'k', routineUrl: 'u'.repeat(500) }).success).toBe(true);
    expect(CredentialSchema.safeParse({ key: 'k', routineUrl: 'u'.repeat(501) }).success).toBe(false);
  });

  it('counts characters as the API does: an astral character is one, not two UTF-16 units', () => {
    const astral = '\u{1F511}';
    expect(CredentialSchema.safeParse({ key: astral.repeat(4096) }).success).toBe(true);
    expect(CredentialSchema.safeParse({ key: astral.repeat(4097) }).success).toBe(false);
    expect(CredentialSchema.safeParse({ key: 'k', orgId: astral.repeat(200) }).success).toBe(true);
    expect(CredentialSchema.safeParse({ key: 'k', orgId: astral.repeat(201) }).success).toBe(false);
    expect(CredentialSchema.safeParse({ key: 'k', orgId: '' }).success).toBe(true);
  });

  it('explains a limit in plain words', () => {
    const tooLong = CredentialSchema.safeParse({ key: 'k', orgId: 'o'.repeat(201) });
    expect(tooLong.success ? [] : tooLong.error.issues.map((issue) => issue.message)).toEqual([
      'Use at most 200 characters.',
    ]);
    const empty = CredentialSchema.safeParse({ key: '' });
    expect(empty.success ? [] : empty.error.issues.map((issue) => issue.message)).toEqual([
      'Use 1 to 4096 characters.',
    ]);
  });
});

describe('DispatchResultSchema', () => {
  it('accepts an open-rail result with only the required fields', () => {
    const result = DispatchResultSchema.safeParse({
      mode: 'open',
      rail: 'claude-code',
      brief: 'FORGE task #1: ...',
      startedAt: '2026-10-01T09:00:00Z',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a start-rail result with the session and the saved switch', () => {
    const result = DispatchResultSchema.safeParse({
      mode: 'start',
      rail: 'jules',
      brief: 'FORGE task #1: ...',
      startedAt: '2026-10-01T09:00:00Z',
      sessionUrl: 'https://jules.google.com/session/abc',
      sessionRef: 'sessions/abc',
      credentialSaved: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects the retired api/handoff modes and the old fields alone', () => {
    const result = DispatchResultSchema.safeParse({ mode: 'handoff', compiledPrompt: 'x', instructions: [] });
    expect(result.success).toBe(false);
  });
});

describe('ClaimRequestSchema / ClaimResponseSchema', () => {
  it('accepts a valid claim request', () => {
    expect(ClaimRequestSchema.safeParse({ taskId: 42 }).success).toBe(true);
  });

  it('rejects a claim request with a string taskId', () => {
    expect(ClaimRequestSchema.safeParse({ taskId: '42' }).success).toBe(false);
  });

  it('accepts a valid claim response', () => {
    const result = ClaimResponseSchema.safeParse({
      taskId: 42,
      claimedBy: 'maya',
      leaseEndsAt: '2026-08-12T00:00:00Z',
      leaseHours: 48,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a claim response missing leaseHours', () => {
    const result = ClaimResponseSchema.safeParse({
      taskId: 42,
      claimedBy: 'maya',
      leaseEndsAt: '2026-08-12T00:00:00Z',
    });
    expect(result.success).toBe(false);
  });
});

const EVENT = {
  at: '2026-10-01T09:00:00Z',
  kind: 'progress',
  source: 'agent',
  message: 'Pushed the first change.',
  rail: 'claude-code',
  stage: 'pushed',
};

describe('BridgeStatusSchema / BridgeEventSchema', () => {
  it('accepts every declared bridge stage', () => {
    for (const stage of BRIDGE_STAGES) {
      const result = BridgeStatusSchema.safeParse({ taskId: 1, stage, detail: 'x', events: [] });
      expect(result.success).toBe(true);
    }
  });

  it('requires the events list', () => {
    expect(BridgeStatusSchema.safeParse({ taskId: 1, stage: 'claimed', detail: 'x' }).success).toBe(false);
  });

  it('accepts every optional field when present', () => {
    const result = BridgeStatusSchema.safeParse({
      taskId: 1,
      stage: 'in_checks',
      detail: '2 of 5 checks need another pass',
      events: [EVENT, { at: EVENT.at, kind: 'claimed', source: 'forge', message: 'Claimed.' }],
      holder: 'maya',
      leaseEndsAt: '2026-10-03T09:00:00Z',
      rail: 'jules',
      sessionUrl: 'https://jules.google.com/session/abc',
      prUrl: 'https://github.com/verastd/forge-app/pull/12',
      compareUrl: 'https://github.com/verastd/forge-app/compare/main...maya:task/1-x',
      checksPassed: 2,
      checksTotal: 5,
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown stage, event kind, source or progress stage', () => {
    expect(BridgeStatusSchema.safeParse({ taskId: 1, stage: 'done', detail: 'x', events: [] }).success).toBe(false);
    expect(BridgeEventSchema.safeParse({ ...EVENT, kind: 'deleted' }).success).toBe(false);
    expect(BridgeEventSchema.safeParse({ ...EVENT, source: 'user' }).success).toBe(false);
    expect(BridgeEventSchema.safeParse({ ...EVENT, stage: 'finished' }).success).toBe(false);
  });

  it('declares the progress stages, event kinds and sources', () => {
    expect(PROGRESS_STAGES).toEqual(['started', 'working', 'pushed', 'pr_opened', 'blocked', 'done']);
    expect(ProgressStageSchema.options).toEqual([...PROGRESS_STAGES]);
    expect(BRIDGE_EVENT_KINDS).toEqual([
      'claimed',
      'dispatched',
      'opened',
      'progress',
      'submitted',
      'released',
      'relayed',
      'copy_ready',
      'review_sent',
    ]);
    expect(BridgeEventKindSchema.options).toEqual([...BRIDGE_EVENT_KINDS]);
    expect(BRIDGE_EVENT_SOURCES).toEqual(['forge', 'agent']);
    expect(BridgeEventSourceSchema.options).toEqual([...BRIDGE_EVENT_SOURCES]);
  });
});

describe('CheckResultsSchema / FeedbackResponseSchema / SubmitRequestSchema', () => {
  it('accepts no pull request yet, and a failed run with its checks', () => {
    expect(CheckResultsSchema.safeParse({ taskId: 1, state: 'no_pr', checks: [], notes: '' }).success).toBe(true);
    const failed = CheckResultsSchema.safeParse({
      taskId: 1,
      state: 'failed',
      checks: [
        { name: 'tests', status: 'completed', conclusion: 'failure', summary: '1 failed', url: 'https://x.test' },
        { name: 'lint', status: 'in_progress' },
      ],
      notes: 'gauntlet: FAIL G2.3',
      prUrl: 'https://github.com/verastd/forge-app/pull/12',
      headSha: 'abc123',
    });
    expect(failed.success).toBe(true);
  });

  it('rejects unknown check states and statuses', () => {
    expect(CHECK_STATES).toEqual(['no_pr', 'pending', 'passed', 'failed']);
    expect(CHECK_RUN_STATUSES).toEqual(['queued', 'in_progress', 'completed']);
    expect(CheckStateSchema.safeParse('ok').success).toBe(false);
    expect(CheckRunStatusSchema.safeParse('done').success).toBe(false);
    expect(CheckRunSchema.safeParse({ name: 'lint', status: 'queued', conclusion: null }).success).toBe(false);
  });

  it('feedback carries notes and, when relayed, the rail it went to', () => {
    expect(FeedbackResponseSchema.safeParse({ relayed: false, notes: 'Fix the test.' }).success).toBe(true);
    expect(FeedbackResponseSchema.safeParse({ relayed: true, notes: 'n', relayedTo: 'jules' }).success).toBe(true);
    expect(FeedbackResponseSchema.safeParse({ relayed: true, prompt: 'the old shape' }).success).toBe(false);
  });

  it('submit takes a pull request link', () => {
    expect(SubmitRequestSchema.safeParse({ prUrl: 'https://github.com/verastd/forge-app/pull/12' }).success).toBe(true);
    expect(SubmitRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe('saved keys and connected agents', () => {
  it('a saved key is a hint, never the key', () => {
    const saved = { rail: 'jules', hint: '…a1b2', savedAt: '2026-10-01T09:00:00Z' };
    expect(SavedCredentialSchema.safeParse(saved).success).toBe(true);
    expect(Object.keys(SavedCredentialSchema.shape)).not.toContain('key');
    expect(SavedCredentialListSchema.safeParse({ credentials: [saved], vault: true }).success).toBe(true);
    expect(SavedCredentialListSchema.safeParse({ credentials: [] }).success).toBe(false);
  });

  it('a connected agent names its client and where it sends you back', () => {
    const agent = { id: 'g1', clientName: 'Claude', redirectHost: 'claude.ai', connectedAt: '2026-10-01T09:00:00Z' };
    expect(ConnectedAgentSchema.safeParse(agent).success).toBe(true);
    expect(ConnectedAgentListSchema.safeParse({ agents: [{ ...agent, lastUsedAt: agent.connectedAt }] }).success).toBe(true);
    expect(ConnectedAgentSchema.safeParse({ ...agent, lastUsedAt: null }).success).toBe(false);
  });
});

describe('OAuth consent schemas', () => {
  const params = {
    responseType: 'code',
    clientId: 'client-1',
    redirectUri: 'https://claude.ai/api/mcp/auth_callback',
    codeChallenge: 'test-only-code-challenge',
    codeChallengeMethod: 'S256',
  };

  it('authorize params need the five OAuth fields; state, scope and resource are optional', () => {
    expect(AuthorizeParamsSchema.safeParse(params).success).toBe(true);
    expect(AuthorizeParamsSchema.safeParse({ ...params, state: 's', scope: 'forge.tasks', resource: 'https://x.test/mcp' }).success).toBe(true);
    const missing: Record<string, string> = { ...params };
    delete missing.codeChallenge;
    expect(AuthorizeParamsSchema.safeParse(missing).success).toBe(false);
  });

  it('check, error and decision shapes', () => {
    expect(AuthorizeCheckSchema.safeParse({ clientName: 'Claude', redirectHost: 'claude.ai', scopes: ['forge.tasks'] }).success).toBe(true);
    expect(AuthorizeErrorSchema.safeParse({ error: 'invalid_request' }).success).toBe(true);
    expect(AuthorizeErrorSchema.safeParse({ error: 'access_denied', errorDescription: 'd', redirectTo: 'https://claude.ai/cb?error=access_denied' }).success).toBe(true);
    expect(AuthorizeDecisionSchema.safeParse({ redirectTo: 'https://claude.ai/cb?code=c&state=s' }).success).toBe(true);
    expect(AuthorizeDecisionSchema.safeParse({}).success).toBe(false);
  });
});

describe('ContributorProfileSchema', () => {
  it('accepts a full valid profile with nested arrays', () => {
    const result = ContributorProfileSchema.safeParse({
      login: 'maya',
      tier: 'T1',
      merged: 7,
      survivalRate: 0.92,
      pendingRewards: [
        { pr: 101, rewardClass: 'R2', survivalEndsAt: '2026-08-24T00:00:00Z' },
      ],
      ledger: [{ kind: 'merge', refPr: 101, points: 10, at: '2026-08-10T00:00:00Z' }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts empty pendingRewards/ledger arrays', () => {
    const result = ContributorProfileSchema.safeParse({
      login: 'maya',
      tier: 'T0',
      merged: 0,
      survivalRate: 0,
      pendingRewards: [],
      ledger: [],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a tier outside T0-T3', () => {
    const result = ContributorProfileSchema.safeParse({
      login: 'maya',
      tier: 'T4',
      merged: 0,
      survivalRate: 0,
      pendingRewards: [],
      ledger: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a malformed pendingRewards entry', () => {
    const result = ContributorProfileSchema.safeParse({
      login: 'maya',
      tier: 'T0',
      merged: 0,
      survivalRate: 0,
      pendingRewards: [{ pr: 101, rewardClass: 'R9', survivalEndsAt: 'x' }],
      ledger: [],
    });
    expect(result.success).toBe(false);
  });
});

/* --- Upland data app -------------------------------------------------------- */

/** A fully decoded secondary-market sale, exactly as the API serializes it. */
const SALE_ACTION = {
  globalSequence: 123456789,
  ts: '2026-09-18T12:34:56.000',
  blockNum: 400000123,
  trxId: 'abc123',
  contract: 'playuplandme',
  actionName: 'n5',
  actionMeaning: 'buy_property_secondary',
  category: 'market',
  actor: 'alice',
  propertyId: '1234567890123',
  priceUpx: 15000,
  fromAccount: 'seller',
  toAccount: 'buyer',
};

describe('UplandActionSchema', () => {
  it('accepts a fully decoded sale action', () => {
    expect(UplandActionSchema.safeParse(SALE_ACTION).success).toBe(true);
  });

  it('accepts explicit nulls for undecoded fields (the Upland wire uses null, not absence)', () => {
    const result = UplandActionSchema.safeParse({
      ...SALE_ACTION,
      actionMeaning: null,
      category: null,
      actor: null,
      propertyId: null,
      priceUpx: null,
      fromAccount: null,
      toAccount: null,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a missing nullable key — the field must still be present', () => {
    const withoutPrice: Record<string, unknown> = { ...SALE_ACTION };
    delete withoutPrice.priceUpx;
    expect(UplandActionSchema.safeParse(withoutPrice).success).toBe(false);
  });

  it('accepts Hyperion timestamps without a timezone suffix', () => {
    const result = UplandActionSchema.safeParse({ ...SALE_ACTION, ts: '2026-09-18T12:34:56.000' });
    expect(result.success).toBe(true);
  });

  it('rejects a non-integer globalSequence', () => {
    expect(UplandActionSchema.safeParse({ ...SALE_ACTION, globalSequence: 1.5 }).success).toBe(
      false,
    );
  });
});

describe('UplandActionListSchema', () => {
  it('accepts a page with hasMore', () => {
    const result = UplandActionListSchema.safeParse({
      items: [SALE_ACTION],
      total: 1400000,
      hasMore: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a list missing hasMore', () => {
    expect(UplandActionListSchema.safeParse({ items: [], total: 0 }).success).toBe(false);
  });
});

const PROPERTY = {
  propertyId: '1234567890123',
  address: '111 VENICE BLVD',
  city: 'Los Angeles',
  firstSeenBlock: 399000000,
  firstSeenTs: '2026-08-01T00:00:00.000',
  mintPriceUpx: 8000,
  lastSalePriceUpx: 15000,
  lastSaleTs: '2026-09-18T12:34:56.000',
  totalSales: 3,
  totalListings: 5,
};

describe('UplandPropertySchema', () => {
  it('accepts a fully known property', () => {
    expect(UplandPropertySchema.safeParse(PROPERTY).success).toBe(true);
  });

  it('accepts a property first seen through a bare listing (everything null but counts)', () => {
    const result = UplandPropertySchema.safeParse({
      propertyId: '999',
      address: null,
      city: null,
      firstSeenBlock: null,
      firstSeenTs: null,
      mintPriceUpx: null,
      lastSalePriceUpx: null,
      lastSaleTs: null,
      totalSales: 0,
      totalListings: 1,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-integer totalSales', () => {
    expect(UplandPropertySchema.safeParse({ ...PROPERTY, totalSales: 1.5 }).success).toBe(false);
  });
});

describe('UplandPropertyListSchema', () => {
  it('accepts a list with a total', () => {
    const result = UplandPropertyListSchema.safeParse({ items: [PROPERTY], total: 42 });
    expect(result.success).toBe(true);
  });
});

describe('stats schemas', () => {
  it('SalesVolumeDaySchema accepts a daily volume row', () => {
    const result = SalesVolumeDaySchema.safeParse({
      date: '2026-09-18',
      count: 120,
      volumeUpx: 1500000.5,
      avgPrice: 12504.2,
      minPrice: 900,
      maxPrice: 250000,
    });
    expect(result.success).toBe(true);
  });

  it('TimeSeriesPointSchema accepts a bucket', () => {
    const result = TimeSeriesPointSchema.safeParse({
      bucket: '2026-09-18',
      count: 42,
      volume: 100000,
    });
    expect(result.success).toBe(true);
  });

  it('PriceDistributionBucketSchema accepts a histogram bucket', () => {
    const result = PriceDistributionBucketSchema.safeParse({
      range: '10K–25K',
      count: 400,
      avgPrice: 16000,
    });
    expect(result.success).toBe(true);
  });

  it('ActionDistributionEntrySchema accepts an unmapped code with null meaning/category', () => {
    const result = ActionDistributionEntrySchema.safeParse({
      actionName: 'n999',
      actionMeaning: null,
      category: null,
      count: 7,
    });
    expect(result.success).toBe(true);
  });

  it('ActiveAccountSchema accepts an account row', () => {
    const result = ActiveAccountSchema.safeParse({ actor: 'alice', txCount: 900, volumeUpx: 1e6 });
    expect(result.success).toBe(true);
  });

  it('UplandStatsOverviewSchema accepts the overview shape', () => {
    const result = UplandStatsOverviewSchema.safeParse({
      totalActions: 1400000,
      dateRange: { min: '2026-06-01T00:00:00.000', max: '2026-09-18T12:34:56.000' },
      byCategory: { market: 800000, mint: 100000 },
      byType: [{ actionName: 'n5', actionMeaning: 'buy_property_secondary', category: 'market', count: 500000 }],
      totalProperties: 250000,
    });
    expect(result.success).toBe(true);
  });

  it('UplandStatsOverviewSchema accepts an empty data set (null date range)', () => {
    const result = UplandStatsOverviewSchema.safeParse({
      totalActions: 0,
      dateRange: { min: null, max: null },
      byCategory: {},
      byType: [],
      totalProperties: 0,
    });
    expect(result.success).toBe(true);
  });
});

describe('ChainInfoSchema / UplandHealthSchema / UplandEstimateSchema', () => {
  it('ChainInfoSchema accepts the live chain head', () => {
    const result = ChainInfoSchema.safeParse({
      headBlockNum: 400123456,
      headBlockTime: '2026-09-19T00:00:00.000',
      chainId: 'abcd',
      blocksPerDay: 172800,
    });
    expect(result.success).toBe(true);
  });

  it('UplandHealthSchema accepts an empty database (null latestBlock)', () => {
    const result = UplandHealthSchema.safeParse({
      status: 'ok',
      actions: 0,
      properties: 0,
      latestBlock: null,
      gcsConfigured: false,
    });
    expect(result.success).toBe(true);
  });

  it('UplandHealthSchema rejects a status other than ok', () => {
    const result = UplandHealthSchema.safeParse({
      status: 'down',
      actions: 0,
      properties: 0,
      latestBlock: null,
      gcsConfigured: false,
    });
    expect(result.success).toBe(false);
  });

  it('UplandEstimateSchema accepts a capped (gte) estimate and rejects other relations', () => {
    const estimate = {
      estimatedActions: 10000,
      relation: 'gte',
      startBlock: 1,
      endBlock: 15500000,
      days: 90,
    };
    expect(UplandEstimateSchema.safeParse(estimate).success).toBe(true);
    expect(UplandEstimateSchema.safeParse({ ...estimate, relation: 'approx' }).success).toBe(false);
  });
});

describe('scraper control schemas', () => {
  it('ScrapeRequestSchema accepts an empty body (all fields optional)', () => {
    expect(ScrapeRequestSchema.safeParse({}).success).toBe(true);
  });

  it('ScrapeRequestSchema accepts a days-based request and rejects out-of-range days', () => {
    expect(ScrapeRequestSchema.safeParse({ days: 90, chunkBlocks: 100000 }).success).toBe(true);
    expect(ScrapeRequestSchema.safeParse({ days: 0 }).success).toBe(false);
    expect(ScrapeRequestSchema.safeParse({ days: 366 }).success).toBe(false);
  });

  it('ScrapeStatusSchema accepts an idle status', () => {
    const result = ScrapeStatusSchema.safeParse({
      running: false,
      phase: 'idle',
      currentBlock: null,
      fetched: 0,
      totalActions: 0,
      startBlock: null,
      endBlock: null,
      error: null,
      lastResult: null,
    });
    expect(result.success).toBe(true);
  });

  it('ScrapeStatusSchema accepts a finished run with a numeric lastResult', () => {
    const result = ScrapeStatusSchema.safeParse({
      running: false,
      phase: 'complete',
      currentBlock: 15500000,
      fetched: 1400000,
      totalActions: 1400000,
      startBlock: 1,
      endBlock: 15500000,
      error: null,
      lastResult: { stored: 1400000, skipped: 12 },
    });
    expect(result.success).toBe(true);
  });

  it('GcsSyncResultSchema / GcsStatusSchema accept the sync shapes', () => {
    const sync = { synced: true, uploadedFiles: ['actions/2026/09/18/part-0.jsonl'], errors: [] };
    expect(GcsSyncResultSchema.safeParse(sync).success).toBe(true);
    expect(
      GcsStatusSchema.safeParse({ configured: true, running: false, lastResult: sync }).success,
    ).toBe(true);
    expect(
      GcsStatusSchema.safeParse({ configured: false, running: false, lastResult: null }).success,
    ).toBe(true);
  });
});

describe('ActionCodesSchema', () => {
  it('accepts the decoder-ring record', () => {
    const result = ActionCodesSchema.safeParse({
      n5: { meaning: 'buy_property_secondary', confidence: 0.95, category: 'market' },
      a4: { meaning: 'mint_property', confidence: 0.9, category: 'mint' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an entry missing its category', () => {
    const result = ActionCodesSchema.safeParse({
      n5: { meaning: 'buy_property_secondary', confidence: 0.95 },
    });
    expect(result.success).toBe(false);
  });
});

describe('UPLAND const tuples', () => {
  it('are the frozen interval/sort/export vocabularies', () => {
    expect(UPLAND_INTERVALS).toEqual(['hour', 'day', 'week']);
    expect(UPLAND_PROPERTY_SORTS).toEqual(['sales', 'price']);
    expect(UPLAND_EXPORT_TYPES).toEqual(['actions', 'sales']);
  });
});

describe('Phase 7: RepoActionRequestSchema / CopyResultSchema / ReviewResultSchema', () => {
  it('takes a task and a one-time token of 1 to 4096 characters', () => {
    expect(RepoActionRequestSchema.safeParse({ taskId: 7, token: 't' }).success).toBe(true);
    expect(RepoActionRequestSchema.safeParse({ taskId: 7, token: 't'.repeat(4096) }).success).toBe(true);
    expect(RepoActionRequestSchema.safeParse({ taskId: 7, token: '' }).success).toBe(false);
    expect(RepoActionRequestSchema.safeParse({ taskId: 7, token: 't'.repeat(4097) }).success).toBe(false);
    expect(RepoActionRequestSchema.safeParse({ taskId: 7.5, token: 't' }).success).toBe(false);
    expect(RepoActionRequestSchema.safeParse({ token: 't' }).success).toBe(false);
  });

  it('a copy result says what FORGE did', () => {
    const result = {
      fullName: 'maya/forge-app',
      branch: 'task/7-x',
      synced: true,
      branchCreated: true,
      branchFromLatest: true,
    };
    expect(CopyResultSchema.safeParse(result).success).toBe(true);
    expect(CopyResultSchema.safeParse({ ...result, synced: undefined }).success).toBe(false);
  });

  it('a review result carries the pull request and whether FORGE opened it now', () => {
    const pullRequest = { number: 12, url: 'https://github.com/verastd/forge-app/pull/12' };
    expect(ReviewResultSchema.safeParse({ pullRequest, created: true }).success).toBe(true);
    expect(ReviewResultSchema.safeParse({ pullRequest, created: false }).success).toBe(true);
    expect(ReviewResultSchema.safeParse({ pullRequest: { number: 12 }, created: true }).success).toBe(false);
  });

  it('lists the error codes the API answers with, in apps/api models.py order', () => {
    expect(REPO_ACTION_ERRORS).toEqual([
      'not_holder',
      'already_shipped',
      'rate_limited',
      'wrong_account',
      'copy_not_ready',
      'copy_mismatch',
      'no_copy',
      'branch_missing',
      'no_changes',
      'too_large',
      'tests_modified',
      'protected_paths',
      'checks_unavailable',
      'head_taken',
      'github_failed',
    ]);
  });
});

describe('AvatarHeadPlacementSchema', () => {
  const fitted = {
    scale: 0.5,
    offset: [-0.01, 0, -0.015],
    eyes: [[-0.052, 0.106, 0.135], [0.052, 0.106, 0.135]],
    eyeAngles: [0.2, 0.15, -0.05],
    angles: [0.1, -0.2, 0.05],
    eyeScale: 1.3,
    screen: { center: [0, 0.1, 0.09], size: [0.25, 0.13] },
  };

  it('takes a fit, with or without eyes of its own', () => {
    expect(AvatarHeadPlacementSchema.parse(fitted)).toEqual(fitted);
    expect(AvatarHeadPlacementSchema.parse({ scale: 1, offset: [0, 0, 0] })).toEqual({ scale: 1, offset: [0, 0, 0] });
    expect(AvatarHeadPlacementSchema.parse({ ...fitted, eyes: null }).eyes).toBeNull();
  });

  it.each([
    { ...fitted, scale: AVATAR_PLACEMENT_SCALE_MIN / 2 },
    { ...fitted, scale: AVATAR_PLACEMENT_SCALE_MAX * 2 },
    { ...fitted, offset: [0, AVATAR_PLACEMENT_REACH + 0.1, 0] },
    { ...fitted, offset: [0, 0] },
    { ...fitted, eyes: [[0, 0, 0]] },
    { ...fitted, scale: Number.NaN },
    { ...fitted, eyeAngles: [0, 0] },
    { ...fitted, eyeScale: AVATAR_PLACEMENT_EYE_SCALE_MIN / 2 },
    { ...fitted, eyeScale: AVATAR_PLACEMENT_EYE_SCALE_MAX * 2 },
    { ...fitted, screen: { center: [0, 0.1, 0.09], size: [0.25] } },
    { ...fitted, screen: { center: [0, 0.1, 0.09], size: [AVATAR_PLACEMENT_SCREEN_MAX + 0.1, 0.1] } },
    { ...fitted, eyeAngles: [0, AVATAR_PLACEMENT_EYE_ANGLE + 0.1, 0] },
    { ...fitted, angles: [0, 0] },
    { ...fitted, angles: [-AVATAR_PLACEMENT_ANGLE - 0.1, 0, 0] },
  ])('refuses %j', (bad) => {
    expect(AvatarHeadPlacementSchema.safeParse(bad).success).toBe(false);
  });

  it('gives a head to one member, or to nobody', () => {
    expect(AvatarHeadOwnerSchema.parse({ owner: 'gh:1001' })).toEqual({ owner: 'gh:1001' });
    expect(AvatarHeadOwnerSchema.parse({ owner: null })).toEqual({ owner: null });
    expect(AvatarHeadOwnerSchema.safeParse({ owner: 'octocat' }).success).toBe(false);
    expect(AvatarHeadOwnerSchema.safeParse({}).success).toBe(false);
    const head = { id: 'bolt', name: 'Bolt', sha256: 'a'.repeat(64), bytes: 1, fit: 'replace', eyes: true, updatedAt: 'now' };
    expect(shared.AvatarHeadSchema.parse({ ...head, owner: 'gh:1001' }).owner).toBe('gh:1001');
    expect(shared.AvatarHeadSchema.safeParse({ ...head, owner: 'nobody' }).success).toBe(false);
  });

  it('wears a head from an API older than fitting as its file is', () => {
    const head = { id: 'bolt', name: 'Bolt', sha256: 'a'.repeat(64), bytes: 1, fit: 'replace', eyes: true, updatedAt: 'now' };
    expect(shared.AvatarHeadSchema.parse(head).placement).toEqual(AVATAR_PLACEMENT_AS_IS);
  });

  it('starts every head as its file is, and a refit carries one placement', () => {
    expect(AVATAR_PLACEMENT_AS_IS).toEqual({ scale: 1, offset: [0, 0, 0] });
    expect(Object.isFrozen(AVATAR_PLACEMENT_AS_IS)).toBe(true);
    expect(AvatarHeadRefitSchema.safeParse({ placement: fitted }).success).toBe(true);
    expect(AvatarHeadUploadSchema.safeParse({ name: 'Bolt', fit: 'replace', data: 'AA==', placement: fitted }).success).toBe(true);
  });
});
