export type UiState =
  | 'starting'
  | 'working'
  | 'waiting_on_you'
  | 'paused_limit'
  | 'stopped'
  | 'done'
  | 'breaker_open'
  | 'handed_off'
  | 'idle';

export interface RoleSpec {
  readonly harness: 'claude' | 'codex' | 'grok' | 'opencode';
  readonly model: string;
  readonly effort?: string;
}

export interface FleetRunWire {
  readonly runId: string;
  readonly goal: string;
  readonly phase: string;
  readonly suspension: string;
  readonly operation: string;
  readonly uiState: UiState;
  readonly repositories: readonly { readonly id: string; readonly path: string }[];
  readonly activeImplementors: number;
  readonly updatedAt: string;
  readonly asOfSequence: number;
}

export interface AssignmentWire {
  readonly id: string;
  readonly repo: string;
  readonly taskScope: string;
  readonly writeScope: readonly string[];
  readonly criteria: readonly string[];
  readonly dependsOn: readonly string[];
  readonly executionMode: 'worktree' | 'in_place';
  readonly implementor?: RoleSpec;
  readonly stage: 'pending' | 'running' | 'delivered' | 'no_deliverable';
  readonly round?: number;
  readonly stopReason?: string;
  readonly diagnostic?: string;
}

export interface CriterionWire {
  readonly id: string;
  readonly description: string;
  readonly commands: readonly (
    | string
    | { readonly command: string; readonly expectedExitCode?: number }
  )[];
  readonly expectedEvidence: string;
  readonly verdict: 'pending' | 'running' | 'passed' | 'failed' | 'unproven';
  readonly evidenceRefs: readonly string[];
  readonly receipts: readonly {
    readonly id: string;
    readonly command: string;
    readonly cwd: string;
    readonly exitCode: number;
    readonly launchFailed?: boolean;
    readonly receiptRef: string;
  }[];
  readonly note?: string;
}

export interface RunWire {
  readonly runId: string;
  readonly asOfSequence: number;
  readonly firstSeenAt: string;
  readonly updatedAt: string;
  readonly goal: string;
  readonly repositories: readonly {
    readonly id: string;
    readonly path: string;
    readonly baseCommit?: string;
  }[];
  readonly phase: string;
  readonly suspension: string;
  readonly suspensionDetail: string | null;
  readonly operation: string;
  readonly uiState: UiState;
  readonly childActive: boolean;
  readonly approval: {
    readonly mode: 'human' | 'auto' | 'unknown' | 'pending';
    readonly specVersionId?: string;
    readonly specHash?: string;
    readonly approvedSpecHash?: string;
  };
  readonly executionMode: 'worktree' | 'in_place';
  readonly spec?: {
    readonly canonicalSpec: string;
    readonly tasks: readonly {
      readonly id: string;
      readonly description: string;
      readonly dependsOn: readonly string[];
    }[];
    readonly assignments: readonly AssignmentWire[];
  };
  readonly assignments: readonly AssignmentWire[];
  readonly models: Readonly<
    Record<
      string,
      {
        readonly effective?: RoleSpec;
        readonly desired?: RoleSpec & {
          readonly requestedAt: string;
          readonly assignmentId?: string;
        };
      }
    >
  >;
  readonly cost: {
    readonly measuredUsd: number;
    readonly estimatedUsd: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly turns: number;
  };
  readonly verification: {
    readonly criteria: readonly CriterionWire[];
    readonly remediationRounds: readonly {
      readonly round: number;
      readonly maxRounds: number;
      readonly at: string;
    }[];
    readonly latestFixRequest?: string;
    readonly mergeReadiness?: {
      readonly ready: boolean;
      readonly verifiedCommit: string;
      readonly baseCommit: string;
      readonly blockers: readonly string[];
      readonly manualIntegrationCommands: readonly string[];
      readonly requiredTestsPassed: boolean;
      readonly destinationClean: boolean;
      readonly worktreeClean: boolean;
      readonly baseDrifted: boolean;
      readonly conflicts: boolean;
      readonly specApprovedBy: string;
      readonly resolvedHarnesses?: {
        readonly implementor: string;
        readonly verifier: string;
      };
    };
    readonly subsetWarning?: string;
  };
  readonly eventCount: number;
}

export interface EventWire {
  readonly sequence: number;
  readonly type: string;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface MetaWire {
  readonly protocolVersion: number;
  readonly version: string;
  readonly features: {
    readonly eventPolling: boolean;
    readonly commands: boolean;
    readonly multiRepository: boolean;
    readonly assignmentModelSwitch: boolean;
  };
}
