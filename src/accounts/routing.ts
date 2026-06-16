import { RoutingConfig, resolveRoutingConfig } from "../config";
import type { SettingsStore } from "../storage/types";

const SETTINGS_KEY = "routing";

/**
 * Owns the live account-selection / load-balancing policy. Merges
 * defaults < config.yaml < persisted (UI) override, and pushes the resolved
 * config into every provider's AccountManager via the `apply` callback.
 * updateConfig() persists the merged result and re-applies live (no restart).
 *
 * Mirrors RequestLogger's config model so the UI editing pattern is uniform.
 */
export class RoutingController {
  private config: RoutingConfig;

  constructor(
    private settings: SettingsStore,
    private apply: (cfg: RoutingConfig) => void,
    private yamlSeed?: Partial<RoutingConfig>,
  ) {
    const persisted = settings.get<Partial<RoutingConfig>>(SETTINGS_KEY);
    this.config = resolveRoutingConfig(yamlSeed, persisted);
    this.apply(this.config);
  }

  getConfig(): RoutingConfig {
    return { ...this.config };
  }

  updateConfig(patch: Partial<RoutingConfig>): RoutingConfig {
    const persisted = this.settings.get<Partial<RoutingConfig>>(SETTINGS_KEY);
    const merged = resolveRoutingConfig(this.yamlSeed, persisted, patch);
    this.settings.set(SETTINGS_KEY, merged);
    this.config = merged;
    this.apply(merged);
    return this.getConfig();
  }
}
