import type { AllConfig, ConfigDomain } from '../lib/types';
import type { ConfigDomainValues, ConfigPersistence } from './persistence';

function clone<T>(value: T): T {
  return structuredClone(value);
}

export interface InMemorySaveCall<D extends ConfigDomain = ConfigDomain> {
  domain: D;
  value: ConfigDomainValues[D];
}

interface Options {
  defaults?: Partial<ConfigDomainValues>;
  load?: () => Promise<AllConfig>;
  save?: <D extends ConfigDomain>(call: InMemorySaveCall<D>) => Promise<ConfigDomainValues[D]>;
  loadDefaults?: <D extends ConfigDomain>(domain: D) => Promise<ConfigDomainValues[D]>;
}

/** Test adapter for exercising ConfigEditor through its real persistence port. */
export class InMemoryConfigPersistence implements ConfigPersistence {
  private current: AllConfig;
  private readonly defaults: Partial<ConfigDomainValues>;
  private readonly options: Options;
  readonly saves: InMemorySaveCall[] = [];

  constructor(initial: AllConfig, options: Options = {}) {
    this.current = clone(initial);
    this.defaults = clone(options.defaults ?? initial);
    this.options = options;
  }

  async load(): Promise<AllConfig> {
    if (this.options.load) return clone(await this.options.load());
    return clone(this.current);
  }

  async save<D extends ConfigDomain>(
    domain: D,
    value: ConfigDomainValues[D]
  ): Promise<ConfigDomainValues[D]> {
    const call = { domain, value: clone(value) } as InMemorySaveCall<D>;
    this.saves.push(call as InMemorySaveCall);
    const canonical = this.options.save ? await this.options.save(call) : value;
    this.current = { ...this.current, [domain]: clone(canonical) };
    return clone(canonical);
  }

  async loadDefaults<D extends ConfigDomain>(domain: D): Promise<ConfigDomainValues[D]> {
    if (this.options.loadDefaults) return clone(await this.options.loadDefaults(domain));
    const value = this.defaults[domain];
    if (value === undefined) throw new Error(`No defaults configured for ${domain}`);
    return clone(value) as ConfigDomainValues[D];
  }

  replace(config: AllConfig): void {
    this.current = clone(config);
  }
}

