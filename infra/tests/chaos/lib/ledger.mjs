// Append-only, idempotent credits ledger on a JSONL file — the drill-level
// stand-in for the product's append-only credits ledger (§14) and the
// `GET /v1/credits` page (§13.1). "Refund via ledger query" in the chaos
// drills means: query this file and check the money math.
//
// Idempotency (§3.4): `apply()` refuses a second entry with the same
// (type, key) pair — a retried refund or charge can never double-apply.

import { appendFileSync, existsSync, readFileSync } from "node:fs";

export function openLedger(filePath) {
  /** @type {Array<any>} */
  const entries = [];
  if (existsSync(filePath)) {
    for (const line of readFileSync(filePath, "utf8").split("\n")) {
      if (line.trim()) entries.push(JSON.parse(line));
    }
  }

  let seq = entries.length;

  function append(entry) {
    const record = { seq: ++seq, at: new Date().toISOString(), ...entry };
    entries.push(record);
    appendFileSync(filePath, `${JSON.stringify(record)}\n`);
    return record;
  }

  function has(type, key) {
    return entries.some((e) => e.type === type && e.key === key);
  }

  return {
    file: filePath,
    /** Non-idempotent raw append (audit/wal entries). */
    append,
    /**
     * Idempotent mutation. Returns a result envelope per repo error law:
     * { ok:true, duplicate, entry } | { ok:false, code, message, hint }.
     */
    apply({ type, key, ...rest }) {
      if (type !== "reserve" && type !== "charge" && type !== "refund") {
        return { ok: false, code: "bad_ledger_type", message: `unknown ledger entry type "${type}"`, hint: "reserve | charge | refund" };
      }
      if (has(type, key)) {
        return { ok: false, code: "duplicate_entry", message: `${type} ${key} already applied`, hint: "ledger is idempotent by (type, key) — §3.4" };
      }
      return { ok: true, duplicate: false, entry: append({ type, key, ...rest }) };
    },
    /** Ledger query — the drill equivalent of GET /v1/credits filtering. */
    query(pred = () => true) {
      return entries.filter(pred);
    },
    of(key) {
      return entries.filter((e) => e.key === key);
    },
    /** Signed credit movement for a key: charges negative, refunds positive. */
    net(key) {
      return this.of(key).reduce((acc, e) => acc + (e.type === "charge" ? -e.credits : e.type === "refund" ? e.credits : 0), 0);
    },
    get size() {
      return entries.length;
    },
  };
}
