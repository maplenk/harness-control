/**
 * Optional planning-chat seam for the coordinator flow.
 *
 * The application layer deliberately knows nothing about Agent Room's process,
 * filesystem, or HTTP implementation. It only needs a localhost discussion
 * room that can publish the coordinator's messages, long-poll unread messages,
 * and close with a summary. The shipped CLI supplies the Agent Room adapter;
 * tests supply an in-process fake.
 */
import type { RunId } from '../domain/ids.js';

export type PlanningChatMessageKind = 'agent' | 'human' | 'system' | 'summary';

export interface PlanningChatMessage {
  readonly id: number;
  readonly sender: string;
  readonly content: string;
  readonly kind: PlanningChatMessageKind;
  readonly createdAt: string;
  readonly addressedToCoordinator: boolean;
}

export interface PlanningChatParticipant {
  readonly name: string;
  readonly role: 'agent' | 'human';
}

export interface PlanningChatUpdate {
  readonly status: 'open' | 'closed';
  readonly activeAgents: number;
  readonly addressedOnly: boolean;
  readonly shouldRespond: boolean;
  readonly participants: readonly PlanningChatParticipant[];
  readonly messages: readonly PlanningChatMessage[];
}

export interface PlanningChatRoom {
  readonly code: string;
  readonly invitation: string;
  readonly viewerUrl: string;
  readonly coordinatorName: string;

  /** Publish one coordinator contribution to the shared transcript. */
  send(content: string): Promise<void>;
  /** Long-poll unread room messages. The room owns the per-participant cursor. */
  listen(waitSeconds: number): Promise<PlanningChatUpdate>;
  /** Idempotently close the room and retain its transcript + summary. */
  close(summary: string): Promise<void>;
}

export interface PlanningChatFactory {
  create(input: {
    readonly runId: RunId;
    readonly goal: string;
    readonly coordinatorName: string;
  }): Promise<PlanningChatRoom>;
}
