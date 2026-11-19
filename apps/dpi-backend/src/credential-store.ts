import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";

const aborted = (options?: AuthOperationOptions) => options?.signal?.throwIfAborted();

const credential = (value: unknown): Credential | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<Credential>;
  if (candidate.type !== "api_key" && candidate.type !== "oauth") return undefined;
  return value as Credential;
};

/** Shared Pi auth.json storage. Writes are serialized and replaced atomically. */
export class JsonCredentialStore implements CredentialStore {
  private writes: Promise<unknown> = Promise.resolve();

  constructor(readonly path: string) {}

  private async all(): Promise<Record<string, Credential>> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      return Object.fromEntries(
        Object.entries(parsed).flatMap(([providerId, value]) => {
          const valid = credential(value);
          return valid ? [[providerId, valid]] : [];
        }),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writes.then(operation, operation);
    this.writes = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async save(values: Record<string, Credential>) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(values, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.path);
  }

  async read(providerId: string, options?: AuthOperationOptions) {
    aborted(options);
    return (await this.all())[providerId];
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    aborted(options);
    return Object.entries(await this.all()).map(([providerId, value]) => ({
      providerId,
      type: value.type,
    }));
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ) {
    return this.serialize(async () => {
      aborted(options);
      const values = await this.all();
      const next = await fn(values[providerId]);
      aborted(options);
      if (next !== undefined) {
        values[providerId] = next;
        await this.save(values);
      }
      return next ?? values[providerId];
    });
  }

  async delete(providerId: string, options?: AuthOperationOptions) {
    await this.serialize(async () => {
      aborted(options);
      const values = await this.all();
      if (!(providerId in values)) return;
      delete values[providerId];
      await this.save(values);
    });
  }
}
