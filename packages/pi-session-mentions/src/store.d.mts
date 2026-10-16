import type { SearchOptions, SessionExport, SessionSummary, StoreOptions } from './model.mjs';

export type { Provider, SearchOptions, SessionExport, SessionSummary, StoreOptions } from './model.mjs';

export class SessionStore {
  constructor(options: StoreOptions);
  start(): void;
  search(query: string, options: SearchOptions): Promise<{ sessions: SessionSummary[]; loading: boolean }>;
  exportSession(key: string, options?: { signal?: AbortSignal }): Promise<SessionExport>;
  close(): Promise<void>;
}
