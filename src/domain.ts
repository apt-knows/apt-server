export const MESSAGE_STATUSES = [
  'pending',
  'streaming',
  'completed',
  'failed',
  'cancelled',
] as const;

export const RUN_STATUSES = [
  'queued',
  'running',
  'stopping',
  'completed',
  'failed',
  'cancelled',
] as const;

export type MessageStatus = (typeof MESSAGE_STATUSES)[number];
export type RunStatus = (typeof RUN_STATUSES)[number];

export interface AgentInstance {
  userId: string;
  hermesProfileName: string;
  hermesSessionId: string;
  status: 'ready' | 'disabled';
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  sequence: string;
  role: 'user' | 'assistant';
  content: string;
  status: MessageStatus;
  clientMessageId: string | null;
  replyToMessageId: string | null;
  channel: 'in_app';
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface ChatRun {
  id: string;
  requestMessageId: string;
  responseMessageId: string;
  hermesRunId: string | null;
  status: RunStatus;
  errorCode: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  response?: ChatMessage;
}

export interface ChatPage {
  messages: ChatMessage[];
  olderCursor: string | null;
  activeRun: ChatRun | null;
}

export interface CreatedTurn {
  requestMessage: ChatMessage;
  responseMessage: ChatMessage;
  run: ChatRun;
  duplicate: boolean;
}

export type PublicRunEvent =
  | { type: 'run.snapshot'; run: ChatRun }
  | { type: 'assistant.delta'; runId: string; messageId: string; delta: string }
  | { type: 'run.completed'; run: ChatRun }
  | { type: 'run.failed'; run: ChatRun }
  | { type: 'run.cancelled'; run: ChatRun };

export interface AuthenticatedUser {
  id: string;
}
