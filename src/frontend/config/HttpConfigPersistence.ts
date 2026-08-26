import type { ConfigDomain } from '../lib/types';
import { api } from '../lib/api';
import type { ConfigDomainValues, ConfigPersistence } from './persistence';

export class HttpConfigPersistence implements ConfigPersistence {
  load() {
    return api.getConfig();
  }

  async save<D extends ConfigDomain>(domain: D, value: ConfigDomainValues[D]): Promise<ConfigDomainValues[D]> {
    const response = await api.saveConfig<ConfigDomainValues[D]>(domain, value);
    return response.value;
  }

  async loadDefaults<D extends ConfigDomain>(domain: D): Promise<ConfigDomainValues[D]> {
    const response = await api.getDefaults<ConfigDomainValues[D]>(domain);
    return response.value;
  }
}

