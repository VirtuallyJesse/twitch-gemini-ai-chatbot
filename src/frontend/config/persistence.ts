import type { AllConfig, ConfigDomain } from '../lib/types';

export type ConfigDomainValues = Pick<AllConfig, ConfigDomain>;

export interface ConfigPersistence {
  load(): Promise<AllConfig>;
  save<D extends ConfigDomain>(domain: D, value: ConfigDomainValues[D]): Promise<ConfigDomainValues[D]>;
  loadDefaults<D extends ConfigDomain>(domain: D): Promise<ConfigDomainValues[D]>;
}

