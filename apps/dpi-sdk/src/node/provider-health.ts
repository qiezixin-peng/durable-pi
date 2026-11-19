import { DatabaseSync } from "node:sqlite";

export type ProviderCircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

type HealthRow = {
  provider: string;
  model: string;
  state: ProviderCircuitState;
  consecutive_failures: number;
  open_count: number;
  open_until: number | null;
  probe_owner: string | null;
  probe_until: number | null;
  last_error_code: string | null;
  last_error_message: string | null;
  last_failure_at: number | null;
  last_success_at: number | null;
  updated_at: number;
  generation: number;
};

export interface ProviderHealthRecord {
  provider: string;
  model: string;
  state: ProviderCircuitState;
  consecutiveFailures: number;
  openCount: number;
  openUntil?: number;
  probeOwner?: string;
  probeUntil?: number;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  lastFailureAt?: number;
  lastSuccessAt?: number;
  updatedAt: number;
  generation: number;
}

const required = (value: string, label: string, max: number) => {
  const clean = value.trim();
  if (!clean) throw Error(`${label} is required`);
  if (clean.length > max) throw Error(`${label} must be at most ${max} characters`);
  return clean;
};

const redactSecrets = (value: string) => value
  .replace(/\b(Bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
  .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, "[REDACTED_API_KEY]")
  .replace(/([?&](?:api[_-]?key|token|access[_-]?token)=)[^&\s]+/gi, "$1[REDACTED]")
  .replace(/\b((?:api[_-]?key|token|authorization)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");

export class ProviderHealthStore {
  readonly db: DatabaseSync;

  constructor(
    databasePath: string,
    readonly failureThreshold = 3,
    readonly baseOpenMs = 30_000,
    readonly probeLeaseMs = 60_000,
  ) {
    for (const [name, value] of [
      ["failureThreshold", failureThreshold],
      ["baseOpenMs", baseOpenMs],
      ["probeLeaseMs", probeLeaseMs],
    ] as const)
      if (!Number.isSafeInteger(value) || value < 1) throw Error(`${name} must be a positive integer`);
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS provider_health(
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'CLOSED',
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        open_count INTEGER NOT NULL DEFAULT 0,
        open_until INTEGER,
        probe_owner TEXT,
        probe_until INTEGER,
        last_error_code TEXT,
        last_error_message TEXT,
        last_failure_at INTEGER,
        last_success_at INTEGER,
        updated_at INTEGER NOT NULL,
        generation INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(provider,model));`);
    const columns = this.db.prepare("PRAGMA table_info(provider_health)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "generation"))
      this.db.exec("ALTER TABLE provider_health ADD COLUMN generation INTEGER NOT NULL DEFAULT 0");
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private row(provider: string, model: string) {
    return this.db.prepare("SELECT * FROM provider_health WHERE provider=? AND model=?").get(provider, model) as HealthRow | undefined;
  }

  private record(row: HealthRow): ProviderHealthRecord {
    return {
      provider: row.provider,
      model: row.model,
      state: row.state,
      consecutiveFailures: row.consecutive_failures,
      openCount: row.open_count,
      ...(row.open_until === null ? {} : { openUntil: row.open_until }),
      ...(row.probe_owner === null ? {} : { probeOwner: row.probe_owner }),
      ...(row.probe_until === null ? {} : { probeUntil: row.probe_until }),
      ...(row.last_error_code === null ? {} : { lastErrorCode: row.last_error_code }),
      ...(row.last_error_message === null ? {} : { lastErrorMessage: row.last_error_message }),
      ...(row.last_failure_at === null ? {} : { lastFailureAt: row.last_failure_at }),
      ...(row.last_success_at === null ? {} : { lastSuccessAt: row.last_success_at }),
      updatedAt: row.updated_at,
      generation: row.generation,
    };
  }

  get(provider: string, model: string) {
    const row = this.row(required(provider, "Provider", 100), required(model, "Model", 200));
    return row ? this.record(row) : undefined;
  }

  list() {
    return (this.db.prepare("SELECT * FROM provider_health ORDER BY updated_at DESC,provider,model").all() as HealthRow[])
      .map((row) => this.record(row));
  }

  beforeRequest(providerInput: string, modelInput: string, ownerInput: string, now = Date.now()) {
    const provider = required(providerInput, "Provider", 100);
    const model = required(modelInput, "Model", 200);
    const owner = required(ownerInput, "Probe owner", 200);
    return this.transaction(() => {
      const row = this.row(provider, model);
      if (!row || row.state === "CLOSED")
        return { allowed: true as const, probe: false as const, generation: row?.generation ?? 0 };
      if (row.state === "OPEN" && (row.open_until ?? 0) > now)
        return { allowed: false as const, retryAt: row.open_until!, state: row.state, generation: row.generation };
      if (row.state === "HALF_OPEN" && row.probe_owner === owner && (row.probe_until ?? 0) > now)
        return { allowed: true as const, probe: true as const, generation: row.generation };
      if (row.state === "HALF_OPEN" && (row.probe_until ?? 0) > now)
        return { allowed: false as const, retryAt: row.probe_until!, state: row.state, generation: row.generation };
      const probeUntil = now + this.probeLeaseMs;
      const generation = row.generation + 1;
      this.db.prepare(
        `UPDATE provider_health SET state='HALF_OPEN',probe_owner=?,probe_until=?,open_until=NULL,generation=?,updated_at=?
         WHERE provider=? AND model=?`,
      ).run(owner, probeUntil, generation, now, provider, model);
      return { allowed: true as const, probe: true as const, generation };
    });
  }

  recordSuccess(providerInput: string, modelInput: string, generation: number, now = Date.now()) {
    const provider = required(providerInput, "Provider", 100);
    const model = required(modelInput, "Model", 200);
    if (!Number.isSafeInteger(generation) || generation < 0) throw Error("Provider generation must be a non-negative integer");
    return this.transaction(() => {
      const prior = this.row(provider, model);
      if (prior && prior.generation !== generation) return { applied: false as const, record: this.record(prior) };
      this.db.prepare(
        `INSERT INTO provider_health(provider,model,state,consecutive_failures,open_count,last_success_at,updated_at,generation)
         VALUES(?,?,'CLOSED',0,0,?,?,?)
         ON CONFLICT(provider,model) DO UPDATE SET state='CLOSED',consecutive_failures=0,open_count=0,
           open_until=NULL,probe_owner=NULL,probe_until=NULL,last_error_code=NULL,last_error_message=NULL,
           last_success_at=excluded.last_success_at,updated_at=excluded.updated_at`,
      ).run(provider, model, now, now, generation);
      return { applied: true as const, record: this.record(this.row(provider, model)!) };
    });
  }

  recordFailure(
    providerInput: string,
    modelInput: string,
    error: { code: string; message: string },
    generation: number,
    now = Date.now(),
  ) {
    const provider = required(providerInput, "Provider", 100);
    const model = required(modelInput, "Model", 200);
    const code = required(error.code, "Error code", 100);
    const message = redactSecrets(error.message).slice(0, 2_000);
    if (!Number.isSafeInteger(generation) || generation < 0) throw Error("Provider generation must be a non-negative integer");
    return this.transaction(() => {
      const prior = this.row(provider, model);
      if (prior && prior.generation !== generation) return { applied: false as const, record: this.record(prior) };
      const failures = (prior?.consecutive_failures ?? 0) + 1;
      const shouldOpen = prior?.state === "HALF_OPEN" || failures >= this.failureThreshold;
      const openCount = shouldOpen ? Math.min(10, (prior?.open_count ?? 0) + 1) : (prior?.open_count ?? 0);
      const duration = shouldOpen
        ? Math.min(30 * 60_000, this.baseOpenMs * (2 ** Math.max(0, openCount - 1)))
        : 0;
      const state: ProviderCircuitState = shouldOpen ? "OPEN" : "CLOSED";
      const openUntil = shouldOpen ? now + duration : null;
      const nextGeneration = shouldOpen ? generation + 1 : generation;
      this.db.prepare(
        `INSERT INTO provider_health(
           provider,model,state,consecutive_failures,open_count,open_until,last_error_code,last_error_message,last_failure_at,updated_at,generation)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(provider,model) DO UPDATE SET state=excluded.state,
           consecutive_failures=excluded.consecutive_failures,open_count=excluded.open_count,
           open_until=excluded.open_until,probe_owner=NULL,probe_until=NULL,
           last_error_code=excluded.last_error_code,last_error_message=excluded.last_error_message,
           last_failure_at=excluded.last_failure_at,updated_at=excluded.updated_at,generation=excluded.generation`,
      ).run(provider, model, state, failures, openCount, openUntil, code, message, now, now, nextGeneration);
      return { applied: true as const, record: this.record(this.row(provider, model)!) };
    });
  }

  close() {
    this.db.close();
  }
}
