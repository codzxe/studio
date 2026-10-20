//! Agent transactions: `agent.begin` / `agent.commit` / `agent.rollback`.
//!
//! An agent edits a document in many small steps, but the History panel must offer the whole
//! run as ONE step: a single undo returns the document to where it was before the run
//! (agents run one transaction per document at a time). The three commands are thin, recomputed
//! wrappers around the existing history machinery — on replay the collapse is derived from
//! history again, so no hidden state is needed:
//!
//! - `agent.begin` takes a History-panel snapshot (#2966) — a named copy of the document that
//!   outlives the states, addressed by an id that is never reused (`DocState::snapshots` /
//!   `DocState::next_snapshot`, allocated as `history_cmds::new_snapshot` does) — and remembers
//!   the history cursor (`History::past_len`) and the document revision beside it. The
//!   snapshot's tiles count against the history's pixel budget (`DocState::trim_history`,
//!   #4530), so a checkpointed run cannot balloon memory unseen.
//! - `agent.commit` folds every undo state above that checkpoint into the current step —
//!   `History::purge_last`, the fold `History::set_current_label` documents — and renames the
//!   step after the run: the next undo restores the checkpoint. (The per-command `"coalesce"`
//!   key of `Session::execute` cannot group a run: consecutive edits share it only while no
//!   other edit, undo or redo intervenes, and a run is many different commands.) When history
//!   no longer holds the checkpoint state (the history budget dropped it, or the run undid
//!   past it), the snapshot is recorded as the run's single undo state (`History::record`).
//! - `agent.rollback` returns to the checkpoint the way `history.selectState` moves (#2966):
//!   the history steps itself, the reached state becomes current once (one revision bump, one
//!   damage rect), and the skipped states — the run — are dropped (`History::clear_redo`), so
//!   the run leaves no history entry at all. When history no longer holds the checkpoint, the
//!   snapshot is restored as one undoable state, as `history.selectSnapshot` does.
//!
//! TODO: a first-class transaction concept would own this on `DocState` (an
//! `open_transaction: Option<Transaction>` field) instead of the crate-wide map below, and a
//! `History` folding primitive (`fold_to(&Arc<Document>, label)`) would replace the top-down
//! pointer walk in [`checkpoint_anchor`]. Until then [`Transaction`] pairs the snapshot id
//! with the cursor — a begin marker — and the registry of open transactions is keyed by
//! `DocId`, which `DocId::fresh` makes unique per open document, so entries cannot collide
//! across documents or sessions.
//!
//! `document.diff` — the companion command of this surface, in `document_diff.rs` — shares
//! [`Transaction`] and [`open_transaction`] from here.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use photocraft_doc::{DocId, Document};
use photocraft_geom::Rect;
use photocraft_ops::History;
use serde_json::{Value, json};

use crate::commands::CommandSpec;
use crate::history_cmds::Snapshot;
use crate::{DocState, EngineError, Result, Session};

/// Marker name when the caller gives none (cosmetic params never fail a run).
const DEFAULT_NAME: &str = "Agent Run";
/// Longest marker name accepted; the error never echoes the value, so huge input can't
/// balloon a message or a history label.
const MAX_NAME_CHARS: usize = 256;

/// Error-message prefixes are the wire contract for automation clients: they match on
/// `transaction_already_open`, `transaction_not_open`, `transaction_busy` and
/// `transaction_checkpoint_gone`.
const ALREADY_OPEN: &str = "transaction_already_open: an agent transaction is already open on this document; close it with agent.commit or agent.rollback first";
const NOT_OPEN: &str = "transaction_not_open: no agent transaction is open on this document; call agent.begin first";
const BUSY: &str = "transaction_busy: the history can't move while a command is still running on this document";
const CHECKPOINT_GONE: &str = "transaction_checkpoint_gone: the checkpoint snapshot of the open transaction was deleted; the transaction can no longer close";

/// One open agent transaction: the begin marker that pairs the checkpoint snapshot with the
/// history cursor and the document revision at `agent.begin`.
#[derive(Clone, Debug)]
pub struct Transaction {
    /// The document the transaction is open on (`DocId::fresh` keeps keys unique).
    pub doc: DocId,
    /// The checkpoint: a History-panel snapshot id (#2966), never reused within the document.
    pub snapshot: u64,
    /// The run's name; the collapsed history step takes it.
    pub name: String,
    /// `DocState::revision` at begin — the `revision_before` callers store with the command
    /// log for replay. The counter is monotonic by design (undo bumps it too), so "back to
    /// the checkpoint" means the document content — the snapshot `Arc` — never a smaller
    /// number; `revision_before`/`revision_after` stay monotonic for replay.
    pub revision_before: u64,
    /// Undo states at begin: everything above them is the run's.
    pub past_len: usize,
    /// Redo states at begin: a run that changes nothing leaves them untouched.
    pub redo_len: usize,
}

/// The open transactions, one per document (an agent edits one document per run).
static TRANSACTIONS: Mutex<HashMap<DocId, Transaction>> = Mutex::new(HashMap::new());

/// Lock the registry. A poisoned lock must not cascade: a panicked sibling thread still
/// leaves the map usable.
fn transactions() -> MutexGuard<'static, HashMap<DocId, Transaction>> {
    TRANSACTIONS.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The active document's open transaction, if any.
pub fn open_transaction(s: &Session) -> Option<Transaction> {
    let st = s.active()?;
    transactions().get(&st.doc.id).cloned()
}

fn bad(cmd: &str, msg: impl Into<String>) -> EngineError {
    EngineError::BadParams { cmd: cmd.into(), msg: msg.into() }
}

fn not_open(cmd: &str) -> EngineError {
    EngineError::Disabled(cmd.into(), NOT_OPEN.into())
}

fn busy() -> EngineError {
    EngineError::Other(BUSY.into())
}

fn has_doc(s: &Session) -> std::result::Result<(), String> {
    s.active().map(|_| ()).ok_or_else(|| "no document open".into())
}

/// `agent.begin` is offered when no transaction is open on the active document.
fn begin_enabled(s: &Session) -> std::result::Result<(), String> {
    has_doc(s)?;
    if s.active().is_some_and(|st| transactions().contains_key(&st.doc.id)) {
        return Err(ALREADY_OPEN.into());
    }
    Ok(())
}

/// `agent.commit` / `agent.rollback` are offered only with an open transaction. The `run`
/// closures check the same condition again (the same message), so direct callers get the
/// same error the dispatcher would give.
fn txn_enabled(s: &Session) -> std::result::Result<(), String> {
    has_doc(s)?;
    if s.active().is_some_and(|st| transactions().contains_key(&st.doc.id)) {
        Ok(())
    } else {
        Err(NOT_OPEN.into())
    }
}

/// The `name` param: a non-empty trimmed string. Absent, blank, null or wrong-typed values
/// default the name — a cosmetic param never fails the run — while an absurdly long one is
/// refused with a message that does not echo it.
fn name_param(p: &Value) -> Result<String> {
    let given = match p.get("name") {
        None | Some(Value::Null) => None,
        Some(Value::String(n)) => Some(n),
        Some(_) => None,
    };
    let Some(given) = given.filter(|n| !n.trim().is_empty()) else {
        return Ok(DEFAULT_NAME.to_string());
    };
    let trimmed = given.trim();
    if trimmed.chars().count() > MAX_NAME_CHARS {
        return Err(bad("agent.begin", format!("`name` is too long: at most {MAX_NAME_CHARS} characters")));
    }
    Ok(trimmed.to_string())
}

/// The checkpoint snapshot of `txn`: the document as it was at `agent.begin` (a clone; the
/// tiles are shared copy-on-write). `Err` when someone deleted it — `history.deleteSnapshot`
/// is a command too — and with it the exact content the transaction promised to restore. The
/// marker is forgotten with the error: a transaction that can never close must not wedge the
/// session, and its steps simply stay in the history as they are.
fn checkpoint(s: &Session, txn: &Transaction) -> Result<Snapshot> {
    let found = s
        .active()
        .ok_or(EngineError::NoDocument)?
        .snapshots
        .iter()
        .find(|snap| snap.id == txn.snapshot)
        .cloned();
    match found {
        Some(snap) => Ok(snap),
        None => {
            transactions().remove(&txn.doc);
            Err(EngineError::Other(CHECKPOINT_GONE.into()))
        }
    }
}

/// The index of the topmost undo state whose document IS the checkpoint. States hold the
/// document a step replaced, so the first step of the run recorded the checkpoint there under
/// an id-identical `Arc` (undo and redo move the same `Arc`s, and a document `Arc` appears on
/// the undo stack at most once per step, so a pointer match is the checkpoint itself).
/// `None` when history no longer holds it — the budget may drop the oldest states
/// (`History::record` trims), or the run may have undone past it.
fn checkpoint_anchor(history: &History, checkpoint: &Arc<Document>) -> Option<usize> {
    (0..history.past_len())
        .rev()
        .find(|&i| history.state(i).is_some_and(|d| Arc::ptr_eq(&d, checkpoint)))
}

/// Close a run that changed nothing: drop only what the run left redoable (any new step
/// would clear redo too) and otherwise leave the panel as it was. Returns the revision after
/// closing.
fn close_nil_run(st: &mut DocState, txn: &Transaction) -> u64 {
    if st.history.redo_labels().count() != txn.redo_len {
        st.history.clear_redo();
        st.coalesce = None;
        st.revision += 1;
        st.last_damage = Some(Rect::EMPTY);
    }
    st.revision
}

/// End the transaction: drop its checkpoint snapshot — the collapsed history step holds the
/// same document — and forget the marker. Ids stay unique: `next_snapshot` never reuses one.
fn close_transaction(s: &mut Session, txn: &Transaction) {
    if let Some(st) = s.active_mut() {
        st.snapshots.retain(|snap| snap.id != txn.snapshot);
    }
    transactions().remove(&txn.doc);
}

/// `agent.begin { name }` — take the checkpoint and open the transaction.
fn begin(s: &mut Session, p: &Value) -> Result<Value> {
    const CMD: &str = "agent.begin";
    let name = name_param(p)?;
    let st = s.active_mut().ok_or(EngineError::NoDocument)?;
    let doc = st.doc.id;
    // One transaction per document: check and insert under one guard, so a refused begin
    // leaves nothing behind — no snapshot, no marker.
    let mut txns = transactions();
    if txns.contains_key(&doc) {
        return Err(EngineError::Disabled(CMD.into(), ALREADY_OPEN.into()));
    }
    let id = st.next_snapshot;
    st.next_snapshot = id.saturating_add(1);
    let snapshot = Snapshot { id, name: name.clone(), doc: st.doc.clone(), layers: st.layer_target() };
    st.snapshots.push(snapshot);
    let revision_before = st.revision;
    let txn = Transaction {
        doc,
        snapshot: id,
        name,
        revision_before,
        past_len: st.history.past_len(),
        redo_len: st.history.redo_labels().count(),
    };
    txns.insert(doc, txn);
    drop(txns);
    Ok(json!({ "transaction_id": id, "revision_before": revision_before }))
}

/// `agent.commit {}` — fold the run into one undoable history entry.
fn commit(s: &mut Session, _p: &Value) -> Result<Value> {
    const CMD: &str = "agent.commit";
    let txn = open_transaction(s).ok_or_else(|| not_open(CMD))?;
    let ck = checkpoint(s, &txn)?;
    // A background job is computing from the current state: the history must not move under it.
    if s.active_job().is_some() {
        return Err(busy());
    }
    let revision_after = {
        let st = s.active_mut().ok_or(EngineError::NoDocument)?;
        if Arc::ptr_eq(&st.doc, &ck.doc) {
            // The run left the document exactly as it found it: no history entry for it.
            close_nil_run(st, &txn)
        } else {
            match checkpoint_anchor(&st.history, &ck.doc) {
                Some(i) => {
                    // Fold every state above the checkpoint into the current step, then name
                    // that step after the run: one undo returns to the checkpoint.
                    while st.history.past_len() > i + 1 {
                        if !st.history.purge_last() {
                            break;
                        }
                    }
                    // What the run left redoable is gone too — a folded step is a new step.
                    st.history.clear_redo();
                    st.history.set_current_label(&txn.name);
                }
                None => {
                    // History no longer holds the checkpoint (trimmed, or the run undid past
                    // it): record the snapshot as the run's single undo state.
                    st.history.record(&txn.name, ck.doc.clone(), ck.layers.clone());
                }
            }
            st.coalesce = None;
            st.revision += 1; // the History panel changed; the pixels didn't
            st.last_damage = Some(Rect::EMPTY);
            st.revision
        }
    };
    close_transaction(s, &txn);
    Ok(json!({
        "transaction_id": txn.snapshot,
        "revision_before": txn.revision_before,
        "revision_after": revision_after,
    }))
}

/// `agent.rollback {}` — return to the checkpoint; the run disappears.
fn rollback(s: &mut Session, _p: &Value) -> Result<Value> {
    const CMD: &str = "agent.rollback";
    let txn = open_transaction(s).ok_or_else(|| not_open(CMD))?;
    let ck = checkpoint(s, &txn)?;
    if s.active_job().is_some() {
        return Err(busy());
    }
    let revision_after = {
        let st = s.active_mut().ok_or(EngineError::NoDocument)?;
        if Arc::ptr_eq(&st.doc, &ck.doc) {
            // The run left nothing: the document is the checkpoint again, and only the
            // redoable states the run left are cleared.
            close_nil_run(st, &txn)
        } else if let Some(i) = checkpoint_anchor(&st.history, &ck.doc) {
            // Step the history itself back to the checkpoint the way `history.selectState`
            // moves: one revision, one damage rect for the canvas.
            st.coalesce = None;
            let start = st.doc.clone();
            let mut doc = start.clone();
            let mut reached = None;
            while st.history.past_len() > i {
                match st.history.undo(doc.clone()) {
                    Some((d, layers)) => {
                        doc = d;
                        reached = Some(layers);
                    }
                    None => break,
                }
            }
            let Some(layers) = reached.filter(|_| Arc::ptr_eq(&doc, &ck.doc)) else {
                return Err(EngineError::Other(CHECKPOINT_GONE.into()));
            };
            // File › Save As changes identity outside history; returning to a checkpoint
            // keeps it, as Edit › Undo does.
            if doc.name != start.name {
                Arc::make_mut(&mut doc).name.clone_from(&start.name);
            }
            let damage = crate::layer_multi_cmds::step_damage(&start, &doc);
            st.doc = doc;
            crate::restore_target(st, layers);
            st.revision += 1;
            st.last_damage = damage;
            // The states the run recorded are redo states now: clearing them removes the run.
            st.history.clear_redo();
            st.revision
        } else {
            // History no longer holds the checkpoint (the run undid past it, or the budget
            // dropped it): restore the snapshot as one undoable state, as
            // `history.selectSnapshot` does. The pre-run states the run consumed are gone —
            // undoing is what consumed them.
            drop(st);
            let restored = (*ck.doc).clone();
            let layers = ck.layers.clone();
            let label = ck.name.clone();
            s.edit(&label, |doc, active| {
                let (id, name) = (doc.id, doc.name.clone());
                *doc = restored;
                doc.id = id;
                doc.name = name;
                *active = layers.active.filter(|l| doc.layer(*l).is_some()).or_else(|| doc.top_layer());
                Ok(())
            })?;
            s.active().ok_or(EngineError::NoDocument)?.revision
        }
    };
    close_transaction(s, &txn);
    Ok(json!({
        "transaction_id": txn.snapshot,
        "revision_before": txn.revision_before,
        "revision_after": revision_after,
        "restored": true,
    }))
}

pub fn specs() -> Vec<CommandSpec> {
    vec![
        CommandSpec {
            id: "agent.begin",
            label: "Begin Agent Transaction",
            menu: &[],
            shortcut: None,
            params: r##"{"name":str="Agent Run"} → {transaction_id,revision_before}: takes a named checkpoint snapshot (a History-panel snapshot id, never reused); agent.commit folds the steps after it into one undoable entry, agent.rollback returns to it"##,
            enabled: begin_enabled,
            run: begin,
            journal: true,
        },
        CommandSpec {
            id: "agent.commit",
            label: "Commit Agent Transaction",
            menu: &[],
            shortcut: None,
            params: r##"{} → {transaction_id,revision_before,revision_after}: every history step since agent.begin becomes one undoable entry named after the transaction"##,
            enabled: txn_enabled,
            run: commit,
            journal: true,
        },
        CommandSpec {
            id: "agent.rollback",
            label: "Roll Back Agent Transaction",
            menu: &[],
            shortcut: None,
            params: r##"{} → {transaction_id,revision_before,revision_after,restored}: the document returns to the checkpoint; the run's steps disappear"##,
            enabled: txn_enabled,
            run: rollback,
            journal: true,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A document with two steps after Open, so a run always has history under it.
    fn session() -> Session {
        let mut s = Session::new();
        s.execute("file.new", json!({"width": 64, "height": 32})).unwrap();
        s.execute("layer.new.layer", json!({})).unwrap();
        s.execute("edit.fill", json!({"color": "#ff0000"})).unwrap();
        s
    }

    #[test]
    fn commit_collapses_the_run_into_one_undoable_step() {
        let mut s = session();
        let n0 = s.active().unwrap().history.past_len();
        let before = s.active().unwrap().doc.clone();
        let b = s.execute("agent.begin", json!({"name": "Restyle headline"})).unwrap();
        let (txn, rev0) = (b["transaction_id"].as_u64().unwrap(), b["revision_before"].as_u64().unwrap());
        assert_eq!(s.active().unwrap().snapshots.last().unwrap().name, "Restyle headline");
        s.execute("edit.fill", json!({"color": "#00ff00"})).unwrap();
        s.execute("layer.new.layer", json!({"name": "Badge"})).unwrap();
        s.execute("edit.fill", json!({"color": "#0000ff"})).unwrap();
        let after = s.active().unwrap().doc.clone();
        let c = s.execute("agent.commit", json!({})).unwrap();
        assert_eq!(c["transaction_id"].as_u64(), Some(txn));
        assert!(c["revision_after"].as_u64().unwrap() >= rev0, "revisions stay monotonic");
        let st = s.active().unwrap();
        assert_eq!(st.history.past_len(), n0 + 1, "the run is one state");
        assert_eq!(st.history.entries().last().unwrap(), "Restyle headline");
        assert!(st.snapshots.is_empty(), "the checkpoint closed with the transaction");
        // Exactly one undo returns the pre-run document; one redo brings the run back.
        assert!(s.undo());
        assert!(*s.active().unwrap().doc == *before);
        assert_eq!(s.active().unwrap().history.past_len(), n0);
        assert!(s.redo());
        assert!(*s.active().unwrap().doc == *after);
    }

    #[test]
    fn rollback_restores_the_checkpoint_and_the_history() {
        let mut s = session();
        let (n0, before, entries) = {
            let st = s.active().unwrap();
            (st.history.past_len(), st.doc.clone(), st.history.entries())
        };
        let b = s.execute("agent.begin", json!({})).unwrap();
        let rev0 = b["revision_before"].as_u64().unwrap();
        assert_eq!(b["transaction_id"].as_u64(), Some(1), "snapshot ids start at 1");
        assert_eq!(s.active().unwrap().snapshots.last().unwrap().name, "Agent Run", "the name defaults");
        s.execute("edit.fill", json!({"color": "#00ff00"})).unwrap();
        s.execute("edit.fill", json!({"color": "#0000ff"})).unwrap();
        let r = s.execute("agent.rollback", json!({})).unwrap();
        assert_eq!(r["restored"], json!(true));
        let st = s.active().unwrap();
        assert!(Arc::ptr_eq(&st.doc, &before), "the checkpoint document is current again");
        assert_eq!(st.history.past_len(), n0);
        assert_eq!(st.history.entries(), entries, "the panel looks as it did before the run");
        assert!(!st.history.can_redo(), "the run left nothing redoable");
        assert!(st.revision >= rev0, "the revision counter is monotonic: undo steps bump it");
        assert!(st.snapshots.is_empty());
        assert!(open_transaction(&s).is_none());
    }

    #[test]
    fn a_second_begin_is_an_error_and_leaves_the_transaction_alone() {
        let mut s = session();
        let first = s.execute("agent.begin", json!({"name": "a"})).unwrap();
        let err = s.execute("agent.begin", json!({"name": "b"})).unwrap_err().to_string();
        assert!(err.contains("transaction_already_open"), "{err}");
        assert_eq!(s.active().unwrap().snapshots.len(), 1, "the refused begin took no snapshot");
        let still = s.execute("agent.commit", json!({})).unwrap();
        assert_eq!(still["transaction_id"], first["transaction_id"]);
    }

    #[test]
    fn commit_and_rollback_need_an_open_transaction() {
        let mut s = session();
        for cmd in ["agent.commit", "agent.rollback"] {
            let err = s.execute(cmd, json!({})).unwrap_err().to_string();
            assert!(err.contains("transaction_not_open"), "{cmd}: {err}");
        }
        s.execute("agent.begin", json!({})).unwrap();
        s.execute("agent.commit", json!({})).unwrap();
        for cmd in ["agent.rollback", "agent.commit"] {
            let err = s.execute(cmd, json!({})).unwrap_err().to_string();
            assert!(err.contains("transaction_not_open"), "{cmd}: {err}");
        }
    }

    #[test]
    fn an_empty_run_commits_without_a_new_history_entry() {
        let mut s = session();
        let (n0, entries, rev) = {
            let st = s.active().unwrap();
            (st.history.past_len(), st.history.entries(), st.revision)
        };
        let b = s.execute("agent.begin", json!({})).unwrap();
        assert_eq!(b["revision_before"].as_u64(), Some(rev));
        let c = s.execute("agent.commit", json!({})).unwrap();
        assert_eq!(c["revision_after"].as_u64(), Some(rev), "nothing changed: no revision bump");
        let st = s.active().unwrap();
        assert_eq!(st.history.past_len(), n0);
        assert_eq!(st.history.entries(), entries, "no step was renamed or added");
        assert!(st.snapshots.is_empty());
    }

    #[test]
    fn a_run_that_undoes_still_rolls_back_to_the_checkpoint() {
        let mut s = session();
        let before = s.active().unwrap().doc.clone();
        s.execute("agent.begin", json!({"name": "T"})).unwrap();
        s.execute("edit.fill", json!({"color": "#00ff00"})).unwrap();
        s.execute("edit.undo", json!({})).unwrap();
        s.execute("edit.fill", json!({"color": "#0000ff"})).unwrap();
        s.execute("agent.rollback", json!({})).unwrap();
        let st = s.active().unwrap();
        assert!(*st.doc == *before);
        assert!(!st.history.can_redo(), "the run left nothing redoable");
    }

    #[test]
    fn commit_survives_a_history_budget_that_dropped_the_checkpoint_state() {
        let mut s = session();
        let before = s.active().unwrap().doc.clone();
        s.execute("agent.begin", json!({"name": "Trim run"})).unwrap();
        // A tiny budget drops the oldest states — including the run's first one.
        s.active_mut().unwrap().history.max_states = 1;
        s.execute("edit.fill", json!({"color": "#00ff00"})).unwrap();
        s.execute("edit.fill", json!({"color": "#0000ff"})).unwrap();
        s.execute("agent.commit", json!({})).unwrap();
        assert!(s.undo(), "one undo still returns to the checkpoint");
        assert!(*s.active().unwrap().doc == *before);
    }

    #[test]
    fn transactions_are_tracked_per_document() {
        let mut s = session();
        s.execute("agent.begin", json!({"name": "on A"})).unwrap();
        s.execute("file.new", json!({"width": 8, "height": 8})).unwrap();
        s.execute("agent.begin", json!({"name": "on B"})).unwrap();
        s.execute("edit.fill", json!({"color": "#00ff00"})).unwrap();
        s.execute("agent.commit", json!({})).unwrap();
        assert!(s.execute("agent.rollback", json!({})).is_err(), "B's transaction is closed");
        assert!(s.set_active(0));
        s.execute("edit.fill", json!({"color": "#0000ff"})).unwrap();
        let r = s.execute("agent.commit", json!({})).unwrap();
        assert_eq!(r["transaction_id"].as_u64(), Some(1), "A's own transaction closed");
    }

    #[test]
    fn without_a_document_every_agent_command_fails() {
        let mut s = Session::new();
        for (cmd, p) in [("agent.begin", json!({"name": "x"})), ("agent.commit", json!({})), ("agent.rollback", json!({}))] {
            assert!(s.execute(cmd, p).is_err(), "{cmd}");
        }
    }

    #[test]
    fn a_transaction_on_a_closed_document_does_not_block_a_fresh_one() {
        let mut s = session();
        s.execute("agent.begin", json!({})).unwrap();
        s.execute("file.close", json!({})).unwrap();
        assert!(s.execute("agent.begin", json!({})).is_err(), "no document open");
        s.execute("file.new", json!({"width": 8, "height": 8})).unwrap();
        assert!(s.execute("agent.begin", json!({})).is_ok(), "a new document opens its own transaction");
    }

    #[test]
    fn names_default_or_refuse_but_never_panic() {
        let mut s = session();
        for p in [json!({}), json!({"name": ""}), json!({"name": "  "}), json!({"name": 42}), json!({"name": null}), json!({"name": ["a"]})] {
            s.execute("agent.begin", p).unwrap();
            assert_eq!(s.active().unwrap().snapshots.last().unwrap().name, "Agent Run", "{p}");
            s.execute("agent.commit", json!({})).unwrap();
        }
        // A huge name is refused without echoing it.
        let err = s.execute("agent.begin", json!({"name": "x".repeat(4000)})).unwrap_err().to_string();
        assert!(err.contains("name") && err.len() < 200, "{err}");
        // `MAX_NAME_CHARS` still fit; astral-plane characters count as one character each.
        s.execute("agent.begin", json!({"name": "a".repeat(MAX_NAME_CHARS)})).unwrap();
        s.execute("agent.commit", json!({})).unwrap();
        s.execute("agent.begin", json!({"name": "🦀".repeat(MAX_NAME_CHARS)})).unwrap();
        s.execute("agent.rollback", json!({})).unwrap();
        assert!(s.execute("agent.begin", json!({"name": "🦀".repeat(MAX_NAME_CHARS + 1)})).is_err());
        s.execute("agent.rollback", json!({})).unwrap_err();
        // Non-object params are refused by the dispatcher before the run closure.
        for p in [json!([]), json!(0), json!("str")] {
            assert!(s.execute("agent.begin", p).is_err(), "{p}");
        }
    }

    #[test]
    fn the_markers_journal_and_the_menu_state_follow_the_transaction() {
        let mut s = session();
        assert!(s.is_enabled("agent.begin"));
        assert!(!s.is_enabled("agent.commit"));
        assert!(!s.is_enabled("agent.rollback"));
        s.execute("agent.begin", json!({})).unwrap();
        assert!(!s.is_enabled("agent.begin"), "one transaction at a time");
        assert!(s.is_enabled("agent.commit"));
        assert!(s.is_enabled("agent.rollback"));
        s.execute("agent.commit", json!({})).unwrap();
        assert!(s.is_enabled("agent.begin"));
        assert!(!s.is_enabled("agent.commit"));
        let ids: Vec<&str> = s.journal.iter().map(|(id, _)| id.as_str()).collect();
        assert!(ids.contains(&"agent.begin") && ids.contains(&"agent.commit"), "replayable markers: {ids:?}");
    }

    #[test]
    fn repeated_transactions_never_wedge_the_history() {
        let mut s = session();
        for i in 0..20 {
            s.execute("agent.begin", json!({"name": format!("run {i}")})).unwrap();
            s.execute("edit.fill", json!({"color": "#00ff00"})).unwrap();
            if i % 2 == 0 {
                s.execute("agent.rollback", json!({})).unwrap();
            } else {
                s.execute("agent.commit", json!({})).unwrap();
            }
        }
        assert!(s.execute("agent.begin", json!({})).is_ok(), "the state machine never wedges");
    }
}
