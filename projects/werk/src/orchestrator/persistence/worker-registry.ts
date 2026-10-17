import { canonicalValue } from "../intake/successor.js";
import { publicWorkerPolicy } from "../../shared/protocol.js";
import { randomUUID } from "node:crypto";
import {
  profiles,
  identifier,
  workerPolicy,
  workerProfilesUpdate,
} from "../../shared/contracts.js";
import { DomainError } from "../../shared/errors.js";
import type {
  WorkerRecord,
  WorkerProfilesRequest,
  WorkerProfilesResponse,
  WorkerSummary,
} from "../../shared/protocol.js";
import type { StoreSession } from "./session.js";
import { hash } from "./digest.js";

/** Worker identities and configuration revisions. */
export class WorkerRegistryRepository {
  private readonly session: StoreSession;

  constructor(session: StoreSession) {
    this.session = session;
  }

  register(
    project: string,
    value: unknown,
    policy?: unknown,
  ): {
    id: string;
    token: string;
  } {
    const ps = profiles(value),
      id = randomUUID(),
      token = randomUUID() + randomUUID();
    this.session.db
      .prepare(
        "INSERT INTO workers(id,project,profiles,token_hash,seen,config) VALUES(?,?,?,?,?,?)",
      )
      .run(
        id,
        identifier(project, "project"),
        JSON.stringify(ps),
        hash(token),
        this.session.clock(),
        JSON.stringify(workerPolicy(policy)),
      );
    return { id, token };
  }
  updateProfiles(w: WorkerRecord, input: WorkerProfilesRequest): WorkerProfilesResponse {
    const update = workerProfilesUpdate(input);
    return this.session.transaction(() => {
      const row = this.session.db.prepare('SELECT project,profiles,config FROM workers WHERE id=?').get(w.id);
      if (!row || row.project !== w.project) throw new DomainError('unauthorized', 'Worker registration no longer exists.');
      const current = profiles(JSON.parse(String(row.profiles))), config = workerPolicy(JSON.parse(String(row.config)));
      if (config.configHash === update.configurationHash && canonicalValue(current) === canonicalValue(update.profiles))
        return { profiles: current, configurationHash: config.configHash };
      if (config.configHash !== update.expectedConfigurationHash || config.configHash === update.configurationHash)
        throw new DomainError('conflict', 'Worker configuration changed. Reload before editing profiles.');
      if (new Set(current.map(profile => profile.mode)).size !== 1 || current[0].mode !== update.profiles[0].mode)
        throw new DomainError('invalid_input', "Execution profiles must retain this worker's configured mode.");
      if (this.session.db.prepare("SELECT 1 FROM tasks WHERE worker=? AND status='running' LIMIT 1").get(w.id))
        throw new DomainError('conflict', 'Finish or abandon all accepted assignments before editing profiles.');
      if (this.session.db.prepare("SELECT 1 FROM attempts WHERE worker=? AND (provider IS NULL OR mode IS NULL OR provider NOT IN ('claude','codex') OR mode NOT IN ('mock','cli')) LIMIT 1").get(w.id))
        throw new DomainError('conflict', 'Historical profile authority is incomplete; profile edits are unavailable for this registration.');
      this.session.db.prepare('UPDATE workers SET profiles=?,config=? WHERE id=?').run(JSON.stringify(update.profiles), JSON.stringify({ ...config, configHash: update.configurationHash }), w.id);
      return { profiles: update.profiles, configurationHash: update.configurationHash };
    });
  }
  worker(token: string): WorkerRecord {
    const w = this.session.db
      .prepare(
        "SELECT id, project, profiles, seen, config FROM workers WHERE token_hash=?",
      )
      .get(hash(token)) as any;
    if (!w) throw new DomainError("unauthorized", "Invalid worker token");
    return {
      ...w,
      profiles: JSON.parse(w.profiles),
      config: JSON.parse(w.config),
    };
  }
  workers(): WorkerSummary[] {
    this.session.reapExpired();
    return this.session.db
      .prepare(
        "SELECT id, project, profiles, seen, config FROM workers ORDER BY seen DESC",
      )
      .all()
      .map((w: any) => ({
        ...w,
        profiles: JSON.parse(w.profiles),
        config: publicWorkerPolicy(JSON.parse(w.config)),
        online: this.session.clock() - w.seen < this.session.ttl,
      }));
  }
}
