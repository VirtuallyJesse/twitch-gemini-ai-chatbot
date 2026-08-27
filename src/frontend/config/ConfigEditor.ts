import type {
  AllConfig,
  BotSettings,
  CommandsConfig,
  ConfigDomain,
  CustomCommand,
  ErrorMessagesConfig,
  EventAlertConfig,
  MediaCommandConfig,
  StreamActionsSettings,
} from '../lib/types';
import type { ConfigDomainValues, ConfigPersistence } from './persistence';

const DOMAINS: ConfigDomain[] = [
  'bot_settings',
  'stream_actions',
  'system_instructions',
  'commands',
  'event_alerts',
  'error_messages',
];

const AUTOSAVED_BOT_FIELDS = new Set<keyof BotSettings>([
  'model_name',
  'thinking_level',
  'search_grounding',
  'tavily_search_depth',
  'reply_mode',
  'ignore_emote_only_prompts',
  'enable_emote_appending',
  'highlight_bot_responses',
]);

const AUTOSAVED_STREAM_ACTION_FIELDS = new Set<keyof StreamActionsSettings>([
  'enabled',
  'stream_setup_enabled',
  'moderation_enabled',
  'chat_access_enabled',
  'community_enabled',
  'polls_predictions_enabled',
  'viewer_clips_enabled',
]);

type Operation = 'load' | 'defaults' | 'autosave' | 'save';
type WriteKind = 'autosave' | 'save';

export interface ConfigFailure {
  domain: ConfigDomain | null;
  operation: Operation;
  message: string;
  code?: string;
}

export interface ConfigDomainSnapshot<T> {
  value: T | null;
  dirty: boolean;
  saveRequired: boolean;
  pending: boolean;
  saving: boolean;
  resetting: boolean;
  failure: ConfigFailure | null;
}

export interface ConfigEditorSnapshot {
  sessionId: number;
  status: 'idle' | 'loading' | 'ready' | 'load-error';
  failure: ConfigFailure | null;
  domains: { [D in ConfigDomain]: ConfigDomainSnapshot<ConfigDomainValues[D]> };
  anyDirty: boolean;
  anyPending: boolean;
  closeDisposition: 'idle' | 'waiting' | 'close' | 'confirm';
}

export type ConfigIntent =
  | { type: 'persona.changed'; value: string }
  | { type: 'bot-setting.changed'; field: keyof BotSettings; value: BotSettings[keyof BotSettings] }
  | { type: 'stream-action.changed'; field: keyof StreamActionsSettings; value: StreamActionsSettings[keyof StreamActionsSettings] }
  | { type: 'channel.added'; channel: string }
  | { type: 'channel.removed'; channel: string }
  | { type: 'ignored-users.added'; usernames: string[] }
  | { type: 'ignored-user.removed'; username: string }
  | { type: 'media-command.changed'; command: keyof Pick<CommandsConfig['media'], 'image' | 'video' | 'tts' | 'music'>; patch: Partial<MediaCommandConfig> }
  | { type: 'media-access.changed'; value: CommandsConfig['media']['access'] }
  | { type: 'custom-command.added'; value: CustomCommand }
  | { type: 'custom-command.changed'; index: number; patch: Partial<CustomCommand> }
  | { type: 'custom-command.removed'; index: number }
  | { type: 'alert.changed'; alert: string; patch: Partial<EventAlertConfig> }
  | { type: 'error-message.changed'; key: string; value: string }
  | { type: 'domain.save'; domain: ConfigDomain }
  | { type: 'domain.cancel'; domain: ConfigDomain }
  | { type: 'domain.reset'; domain: ConfigDomain }
  | { type: 'session.continue' }
  | { type: 'session.discard-all' };

interface DomainRecord<D extends ConfigDomain = ConfigDomain> {
  baseline: ConfigDomainValues[D] | null;
  draft: ConfigDomainValues[D] | null;
  revision: number;
  committedRevision: number;
  explicitRevision: number;
  failedAutosaveRevision: number;
  failure: ConfigFailure | null;
  resetting: boolean;
  defaultsRequest: number;
  cancelAfterActive: boolean;
}

interface WriteJob<D extends ConfigDomain = ConfigDomain> {
  domain: D;
  value: ConfigDomainValues[D];
  revision: number;
  kind: WriteKind;
  token: number;
}

interface ConfigEditorOptions {
  persistence: ConfigPersistence;
  onCommitted?: (change: { domain: ConfigDomain; value: ConfigDomainValues[ConfigDomain] }) => void;
}

let nextSessionId = 1;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function applyChanges<T>(base: T, previous: T, next: T): T {
  if (equal(previous, next)) return clone(base);
  if (!isRecord(base) || !isRecord(previous) || !isRecord(next)) return clone(next);
  const result = clone(base) as Record<string, unknown>;
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (equal(previous[key], next[key])) continue;
    result[key] = applyChanges(result[key], previous[key], next[key]);
  }
  return result as T;
}

function failure(domain: ConfigDomain | null, operation: Operation, error: unknown): ConfigFailure {
  const candidate = error as { message?: unknown; code?: unknown } | null;
  return {
    domain,
    operation,
    message: candidate?.message ? String(candidate.message) : `Configuration ${operation} failed`,
    ...(candidate?.code ? { code: String(candidate.code) } : {}),
  };
}

function emptyDomain(): DomainRecord {
  return {
    baseline: null,
    draft: null,
    revision: 0,
    committedRevision: 0,
    explicitRevision: 0,
    failedAutosaveRevision: 0,
    failure: null,
    resetting: false,
    defaultsRequest: 0,
    cancelAfterActive: false,
  };
}

export class ConfigEditor {
  readonly sessionId = nextSessionId++;
  private readonly persistence: ConfigPersistence;
  private readonly onCommitted?: ConfigEditorOptions['onCommitted'];
  private readonly listeners = new Set<() => void>();
  private readonly records: { [D in ConfigDomain]: DomainRecord<D> } = {
    bot_settings: emptyDomain() as DomainRecord<'bot_settings'>,
    stream_actions: emptyDomain() as DomainRecord<'stream_actions'>,
    system_instructions: emptyDomain() as DomainRecord<'system_instructions'>,
    commands: emptyDomain() as DomainRecord<'commands'>,
    event_alerts: emptyDomain() as DomainRecord<'event_alerts'>,
    error_messages: emptyDomain() as DomainRecord<'error_messages'>,
  };
  private status: ConfigEditorSnapshot['status'] = 'idle';
  private globalFailure: ConfigFailure | null = null;
  private closeDisposition: ConfigEditorSnapshot['closeDisposition'] = 'idle';
  private token = 0;
  private active = true;
  private queue: WriteJob[] = [];
  private activeWrite: WriteJob | null = null;
  private snapshot: ConfigEditorSnapshot;

  constructor({ persistence, onCommitted }: ConfigEditorOptions) {
    this.persistence = persistence;
    this.onCommitted = onCommitted;
    this.snapshot = this.buildSnapshot();
  }

  getSnapshot = (): ConfigEditorSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async start(): Promise<void> {
    const token = ++this.token;
    this.active = true;
    this.status = 'loading';
    this.globalFailure = null;
    this.closeDisposition = 'idle';
    this.publish();
    try {
      const config = await this.persistence.load();
      if (!this.isCurrent(token)) return;
      for (const domain of DOMAINS) this.loadDomain(domain, config[domain]);
      this.status = 'ready';
    } catch (error) {
      if (!this.isCurrent(token)) return;
      this.status = 'load-error';
      this.globalFailure = failure(null, 'load', error);
    }
    this.publish();
  }

  terminate(): void {
    this.active = false;
    this.token += 1;
    this.queue = [];
    this.listeners.clear();
  }

  dispatch(intent: ConfigIntent): void {
    if (!this.active || this.status !== 'ready') return;
    switch (intent.type) {
      case 'persona.changed':
        this.edit('system_instructions', () => intent.value, false);
        break;
      case 'bot-setting.changed':
        this.edit('bot_settings', (draft) => ({ ...draft, [intent.field]: intent.value }), AUTOSAVED_BOT_FIELDS.has(intent.field));
        break;
      case 'stream-action.changed':
        this.edit('stream_actions', (draft) => ({ ...draft, [intent.field]: intent.value }), AUTOSAVED_STREAM_ACTION_FIELDS.has(intent.field));
        break;
      case 'channel.added':
        this.edit('bot_settings', (draft) => ({ ...draft, channels: [...draft.channels, intent.channel] }), true);
        break;
      case 'channel.removed':
        this.edit('bot_settings', (draft) => ({ ...draft, channels: draft.channels.filter((channel) => channel !== intent.channel) }), true);
        break;
      case 'ignored-users.added':
        this.edit('bot_settings', (draft) => ({ ...draft, ignored_usernames: [...(draft.ignored_usernames || []), ...intent.usernames] }), true);
        break;
      case 'ignored-user.removed':
        this.edit('bot_settings', (draft) => ({ ...draft, ignored_usernames: (draft.ignored_usernames || []).filter((username) => username !== intent.username) }), true);
        break;
      case 'media-command.changed': {
        const autosave = !Object.keys(intent.patch).some((key) => key === 'command' || key === 'aliases');
        this.edit('commands', (draft) => ({
          ...draft,
          media: {
            ...draft.media,
            [intent.command]: { ...draft.media[intent.command], ...intent.patch },
          },
        }), autosave);
        break;
      }
      case 'media-access.changed':
        this.edit('commands', (draft) => ({ ...draft, media: { ...draft.media, access: intent.value } }), true);
        break;
      case 'custom-command.added':
        this.edit('commands', (draft) => ({ ...draft, custom: [...draft.custom, intent.value] }), false);
        break;
      case 'custom-command.changed':
        this.edit('commands', (draft) => ({
          ...draft,
          custom: draft.custom.map((command, index) => index === intent.index ? { ...command, ...intent.patch } : command),
        }), false);
        break;
      case 'custom-command.removed':
        this.edit('commands', (draft) => ({ ...draft, custom: draft.custom.filter((_, index) => index !== intent.index) }), true);
        break;
      case 'alert.changed': {
        const autosave = Object.keys(intent.patch).every((key) => key === 'enabled' || key === 'ai_enabled');
        this.edit('event_alerts', (draft) => ({
          ...draft,
          [intent.alert]: { ...draft[intent.alert], ...intent.patch },
        }), autosave);
        break;
      }
      case 'error-message.changed':
        this.edit('error_messages', (draft) => ({ ...draft, [intent.key]: intent.value }), false);
        break;
      case 'domain.save':
        this.save(intent.domain);
        break;
      case 'domain.cancel':
        this.cancel(intent.domain);
        break;
      case 'domain.reset':
        void this.reset(intent.domain);
        break;
      case 'session.continue':
        this.closeDisposition = 'idle';
        this.publish();
        break;
      case 'session.discard-all':
        this.discardAll();
        break;
    }
  }

  requestClose(): ConfigEditorSnapshot['closeDisposition'] {
    this.closeDisposition = this.hasOutstandingWrites() ? 'waiting' : this.isAnyDirty() ? 'confirm' : 'close';
    this.publish();
    return this.closeDisposition;
  }

  private loadDomain<D extends ConfigDomain>(domain: D, value: ConfigDomainValues[D]): void {
    const record = this.records[domain];
    record.baseline = clone(value);
    record.draft = clone(value);
    record.revision = 0;
    record.committedRevision = 0;
    record.explicitRevision = 0;
    record.failedAutosaveRevision = 0;
    record.failure = null;
  }

  private edit<D extends ConfigDomain>(
    domain: D,
    update: (draft: ConfigDomainValues[D]) => ConfigDomainValues[D],
    autosave: boolean
  ): void {
    const record = this.records[domain];
    if (record.draft === null) return;
    const previousDraft = clone(record.draft);
    record.draft = clone(update(clone(record.draft)));
    record.revision += 1;
    record.failure = null;
    if (this.globalFailure?.domain === domain) this.globalFailure = null;
    if (autosave) {
      const queuedBase = [...this.queue].reverse().find((job) => job.domain === domain)?.value;
      const activeBase = this.activeWrite?.domain === domain ? this.activeWrite.value : null;
      const persistenceBase = (queuedBase ?? activeBase ?? record.baseline ?? record.draft) as ConfigDomainValues[D];
      this.enqueue({
        domain,
        value: applyChanges(persistenceBase, previousDraft, record.draft),
        revision: record.revision,
        kind: 'autosave',
        token: this.token,
      });
    } else {
      record.explicitRevision = record.revision;
    }
    this.publish();
  }

  private save<D extends ConfigDomain>(domain: D): void {
    const record = this.records[domain];
    if (record.draft === null) return;
    record.failure = null;
    this.enqueue({
      domain,
      value: clone(record.draft),
      revision: record.revision,
      kind: 'save',
      token: this.token,
    });
    this.publish();
  }

  private cancel(domain: ConfigDomain): void {
    const record = this.records[domain];
    this.queue = this.queue.filter((job) => job.domain !== domain);
    record.failure = null;
    if (this.activeWrite?.domain === domain) {
      record.cancelAfterActive = true;
    } else {
      this.restoreCommitted(domain);
    }
    this.publish();
  }

  private discardAll(): void {
    this.queue = [];
    for (const domain of DOMAINS) {
      if (this.activeWrite?.domain === domain) this.records[domain].cancelAfterActive = true;
      else this.restoreCommitted(domain);
    }
    this.closeDisposition = this.activeWrite ? 'waiting' : 'close';
    this.publish();
  }

  private restoreCommitted(domain: ConfigDomain): void {
    const record = this.records[domain];
    if (record.baseline !== null) record.draft = clone(record.baseline);
    record.revision += 1;
    record.explicitRevision = 0;
    record.failedAutosaveRevision = 0;
    record.cancelAfterActive = false;
  }

  private async reset<D extends ConfigDomain>(domain: D): Promise<void> {
    const record = this.records[domain];
    const request = ++record.defaultsRequest;
    const startingRevision = record.revision;
    const token = this.token;
    record.resetting = true;
    record.failure = null;
    if (this.globalFailure?.domain === domain) this.globalFailure = null;
    this.publish();
    try {
      let defaults = await this.persistence.loadDefaults(domain);
      if (!this.isCurrent(token) || record.defaultsRequest !== request || record.revision !== startingRevision) return;
      if (domain === 'bot_settings') {
        const current = record.draft as ConfigDomainValues['bot_settings'] | null;
        const botDefaults = clone(defaults as ConfigDomainValues['bot_settings']);
        if ((!botDefaults.channels || botDefaults.channels.length === 0) && current?.channels.length) {
          botDefaults.channels = clone(current.channels);
        }
        defaults = botDefaults as ConfigDomainValues[D];
      }
      record.draft = clone(defaults);
      record.revision += 1;
      record.explicitRevision = record.revision;
    } catch (error) {
      if (!this.isCurrent(token) || record.defaultsRequest !== request) return;
      const nextFailure = failure(domain, 'defaults', error);
      record.failure = nextFailure;
      this.globalFailure = nextFailure;
    } finally {
      if (this.isCurrent(token) && record.defaultsRequest === request) {
        record.resetting = false;
        this.publish();
      }
    }
  }

  private enqueue(job: WriteJob): void {
    if (job.kind === 'autosave') {
      const last = this.queue.at(-1);
      if (last?.kind === 'autosave' && last.domain === job.domain) {
        this.queue[this.queue.length - 1] = job;
        void this.processQueue();
        return;
      }
    }
    this.queue.push(job);
    void this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.activeWrite || !this.active) return;
    const job = this.queue.shift();
    if (!job) {
      this.updateCloseAfterWrites();
      return;
    }
    this.activeWrite = job;
    this.publish();
    try {
      const canonical = await this.persistence.save(job.domain, clone(job.value) as never);
      if (this.isCurrent(job.token)) this.accept(job, canonical);
    } catch (error) {
      if (this.isCurrent(job.token)) this.reject(job, error);
    } finally {
      if (this.activeWrite === job) this.activeWrite = null;
      if (this.isCurrent(job.token)) {
        this.publish();
        void this.processQueue();
      }
    }
  }

  private accept(job: WriteJob, canonical: ConfigDomainValues[ConfigDomain]): void {
    const record = this.records[job.domain] as DomainRecord;
    record.baseline = clone(canonical);
    record.committedRevision = Math.max(record.committedRevision, job.revision);
    if (job.kind === 'save' && record.explicitRevision <= job.revision) record.explicitRevision = 0;
    record.failure = null;
    if (record.failedAutosaveRevision <= job.revision) record.failedAutosaveRevision = 0;
    if (record.cancelAfterActive) {
      record.draft = clone(canonical);
      record.revision += 1;
      record.explicitRevision = 0;
      record.cancelAfterActive = false;
    } else {
      record.draft = applyChanges(canonical, job.value, record.draft);
    }
    try {
      this.onCommitted?.({ domain: job.domain, value: clone(canonical) });
    } catch {
      // Dashboard projection failures do not change persistence truth.
    }
  }

  private reject(job: WriteJob, error: unknown): void {
    const record = this.records[job.domain] as DomainRecord;
    const nextFailure = failure(job.domain, job.kind, error);
    record.failure = nextFailure;
    if (job.kind === 'autosave') record.failedAutosaveRevision = Math.max(record.failedAutosaveRevision, job.revision);
    record.cancelAfterActive = false;
  }

  private updateCloseAfterWrites(): void {
    if (this.closeDisposition !== 'waiting' || this.hasOutstandingWrites()) return;
    this.closeDisposition = this.isAnyDirty() ? 'confirm' : 'close';
    this.publish();
  }

  private hasOutstandingWrites(domain?: ConfigDomain): boolean {
    return Boolean(
      (!domain || this.activeWrite?.domain === domain) && this.activeWrite
      || this.queue.some((job) => !domain || job.domain === domain)
    );
  }

  private isDomainDirty(domain: ConfigDomain): boolean {
    const record = this.records[domain] as DomainRecord;
    return record.draft !== null && (
      !equal(record.draft, record.baseline)
      || this.hasOutstandingWrites(domain)
      || record.failedAutosaveRevision > 0
    );
  }

  private isAnyDirty(): boolean {
    return DOMAINS.some((domain) => this.isDomainDirty(domain));
  }

  private isCurrent(token: number): boolean {
    return this.active && token === this.token;
  }

  private buildSnapshot(): ConfigEditorSnapshot {
    const domains = {} as ConfigEditorSnapshot['domains'];
    for (const domain of DOMAINS) {
      const record = this.records[domain] as DomainRecord;
      domains[domain] = {
        value: record.draft === null ? null : clone(record.draft),
        dirty: this.isDomainDirty(domain),
        saveRequired: record.explicitRevision > 0 || record.failedAutosaveRevision > 0,
        pending: this.hasOutstandingWrites(domain),
        saving: this.activeWrite?.domain === domain,
        resetting: record.resetting,
        failure: record.failure,
      } as never;
    }
    return {
      sessionId: this.sessionId,
      status: this.status,
      failure: this.globalFailure,
      domains,
      anyDirty: DOMAINS.some((domain) => domains[domain].dirty),
      anyPending: this.hasOutstandingWrites(),
      closeDisposition: this.closeDisposition,
    };
  }

  private publish(): void {
    this.snapshot = this.buildSnapshot();
    for (const listener of this.listeners) listener();
  }
}
