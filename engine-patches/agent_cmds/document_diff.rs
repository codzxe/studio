//! `document.diff`: what changed between two revisions of a document.
//!
//! Callers that must show what an editing run did — a UI walking a user through a change,
//! or a check that nothing was silently destroyed — ask for the layers that were added,
//! removed, changed or moved between two revisions, as a table ordered by layer id:
//!
//! ```text
//! document.diff {"from": 41, "to": 46} →
//!   {"from": 41, "to": 46,
//!    "added":   [{"layer_id","name","kind","bounds_from","bounds_to","props_changed"}, …],
//!    "removed": […], "changed": […], "moved": […]}
//! ```
//!
//! Revisions are the monotonic counters every mutating command reports
//! (`revision_before` / `revision_after`, the way `document.inspect` reports the current
//! one), so the numbers a caller logged while editing are the numbers it diffs. The engine
//! holds exactly the revisions it can still produce: the current document, and — while an
//! agent transaction is open — the checkpoint `agent.begin` took (its `revision_before`,
//! the snapshot it returned as `transaction_id`). Undo states hold documents, not
//! revisions, so any other number is refused with the list of the revisions that are
//! held, never guessed at.
//!
//! Every row is a read-only view of the engine's own layer row (`inspect::layer`): each
//! property key that differs is listed by name (`opacity`, `fill`, `blend`, `text`,
//! `visible`, `bounds`, …), and `bounds_from` / `bounds_to` restate the geometry so a row
//! reads without a second call. A layer is *moved* when its position in the tree changed —
//! another parent, or another order among its siblings (reported as
//! `parent_from`/`parent_to`/`order_from`/`order_to`); pure geometry differences are
//! property changes, and a layer that moved and changed reports the property changes in
//! its moved row. Additions and removals between two survivors do not move the survivors:
//! the move test ranks each layer among the siblings both revisions share.
//!
//! The walk is bounded twice over, like `layer.list`'s depth limit plus a seen-set of
//! layer ids: a document that nests or repeats ids deeper than the limit loses the excess
//! layers identically on both sides, so a malformed tree can never invent a difference,
//! loop, or take the run down.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use photocraft_doc::{Document, Layer, LayerContent};
use serde_json::{Value, json};

use crate::agent_cmds::open_transaction;
use crate::commands::CommandSpec;
use crate::{EngineError, Result, Session};

const CMD: &str = "document.diff";

/// Groups nest at most this deep in a diff (`layer.list` keeps the same limit); deeper
/// layers are left out of both sides alike, so the limit can never read as a change.
const MAX_DEPTH: usize = 256;

/// Row keys that are not properties: `id` names the row, `children` is the tree the walk
/// itself compares, and `selected` is the caller's cursor, not document content.
const STRUCTURAL_KEYS: [&str; 3] = ["id", "children", "selected"];

/// One layer of one revision, flattened out of the tree: enough of the engine's own layer
/// row to report the layer, plus where in the tree it sits.
struct FlatLayer {
    name: String,
    kind: String,
    /// The engine's JSON row for the layer (`inspect::layer`), whose keys name the
    /// property changes.
    props: Value,
    /// The enclosing group's id, `None` at the panel's top level.
    parent: Option<u64>,
    /// The position among its siblings, topmost first (the Layers panel's order).
    order: usize,
}

/// A revision flattened: every layer by id (BTree order is the report order), plus each
/// parent's children in panel order for the move test.
struct FlatDoc {
    layers: BTreeMap<u64, FlatLayer>,
    siblings: BTreeMap<Option<u64>, Vec<u64>>,
}

/// Flatten a revision's layer tree.
fn flatten(doc: &Document) -> FlatDoc {
    let mut flat = FlatDoc { layers: BTreeMap::new(), siblings: BTreeMap::new() };
    let mut seen = BTreeSet::new();
    walk(&doc.layers, None, 0, &mut flat, &mut seen);
    flat
}

/// The panel lists `layers` back to front, so the walk reverses each level: the first
/// sibling it meets is the topmost (`order` 0). The depth limit and the seen-set are
/// guards — the tree owns its children, so neither case occurs in a well-formed document,
/// and a malformed one is reported shallowly, never looped over.
fn walk(layers: &[Layer], parent: Option<u64>, depth: usize, flat: &mut FlatDoc, seen: &mut BTreeSet<u64>) {
    if depth >= MAX_DEPTH {
        return;
    }
    for (order, l) in layers.iter().rev().enumerate() {
        let id = l.id.0;
        if !seen.insert(id) {
            continue; // a repeated id: reported once, walked once
        }
        flat.layers.insert(
            id,
            FlatLayer {
                name: l.name.clone(),
                kind: l.content.kind_name().to_string(),
                props: crate::inspect::layer(l),
                parent,
                order,
            },
        );
        flat.siblings.entry(parent).or_default().push(id);
        if let LayerContent::Group(g) = &l.content {
            walk(&g.children, Some(id), depth + 1, flat, seen);
        }
    }
}

/// The property keys that differ between the two revisions of one layer, in BTree order.
/// A key one side lacks counts as changed: the row shape is part of the layer's state.
fn changed_props(from: &Value, to: &Value) -> Vec<String> {
    let mut keys: BTreeSet<String> = BTreeSet::new();
    for side in [from, to] {
        if let Some(obj) = side.as_object() {
            keys.extend(obj.keys().filter(|k| !STRUCTURAL_KEYS.contains(k.as_str())).cloned());
        }
    }
    keys.into_iter().filter(|k| from.get(k) != to.get(k)).collect()
}

/// The layer's rank among the siblings both revisions share: a layer added or removed
/// between two survivors does not move them.
fn shared_rank(
    siblings: &BTreeMap<Option<u64>, Vec<u64>>,
    parent: Option<u64>,
    shared: &BTreeSet<u64>,
    id: u64,
) -> Option<usize> {
    let list = siblings.get(&parent)?;
    list.iter().filter(|s| shared.contains(*s)).position(|s| *s == id)
}

/// One diff row: what the layer is, where it was and is, and which of the engine's own
/// layer-row properties changed. `name`/`kind` come from the newer side that still has
/// the layer (they sit in `props_changed` when they changed); a missing side leaves its
/// bounds `null`.
fn row(id: u64, from: Option<&FlatLayer>, to: Option<&FlatLayer>, props_changed: &[String]) -> Value {
    let (name, kind) = to
        .or(from)
        .map(|l| (l.name.clone(), l.kind.clone()))
        .unwrap_or_default();
    let bounds = |l: Option<&FlatLayer>| l.and_then(|l| l.props.get("bounds")).cloned().unwrap_or(Value::Null);
    json!({
        "layer_id": id,
        "name": name,
        "kind": kind,
        "bounds_from": bounds(from),
        "bounds_to": bounds(to),
        "props_changed": props_changed,
    })
}

/// The diff table. Every list is ordered by layer id: the two sides come out of BTree
/// maps, and the shared layers come out of a BTree set.
fn diff(from_doc: &Arc<Document>, to_doc: &Arc<Document>, from_rev: u64, to_rev: u64) -> Value {
    let (added, removed, changed, moved) = if Arc::ptr_eq(from_doc, to_doc) {
        // One revision of the document: nothing changed, and no walk is needed.
        (Vec::new(), Vec::new(), Vec::new(), Vec::new())
    } else {
        let from = flatten(from_doc);
        let to = flatten(to_doc);
        let shared: BTreeSet<u64> = from.layers.keys().filter(|id| to.layers.contains_key(*id)).copied().collect();
        let mut added = Vec::new();
        for (id, l) in &to.layers {
            if !from.layers.contains_key(id) {
                added.push(row(*id, None, Some(l), &[]));
            }
        }
        let mut removed = Vec::new();
        for (id, l) in &from.layers {
            if !to.layers.contains_key(id) {
                removed.push(row(*id, Some(l), None, &[]));
            }
        }
        let mut changed = Vec::new();
        let mut moved = Vec::new();
        for id in &shared {
            let (Some(f), Some(t)) = (from.layers.get(id), to.layers.get(id)) else { continue };
            let props = changed_props(&f.props, &t.props);
            let parent_moved = f.parent != t.parent;
            let order_moved = !parent_moved
                && shared_rank(&from.siblings, f.parent, &shared, *id)
                    .zip(shared_rank(&to.siblings, t.parent, &shared, *id))
                    .is_some_and(|(a, b)| a != b);
            if parent_moved || order_moved {
                let mut r = row(*id, Some(f), Some(t), &props);
                r["parent_from"] = json!(f.parent);
                r["parent_to"] = json!(t.parent);
                r["order_from"] = json!(f.order);
                r["order_to"] = json!(t.order);
                moved.push(r);
            } else if !props.is_empty() {
                changed.push(row(*id, Some(f), Some(t), &props));
            }
        }
        (added, removed, changed, moved)
    };
    json!({
        "from": from_rev,
        "to": to_rev,
        "added": added,
        "removed": removed,
        "changed": changed,
        "moved": moved,
    })
}

/// A required revision number. Absent, `null` and every non-number are refused — a
/// revision is an integer or it is nothing — and the message names the param and the kind
/// of value it got, never the value itself, so no input can balloon it.
fn revision_param(p: &Value, key: &str) -> Result<u64> {
    let refuse = |what: &str| -> Result<u64> {
        Err(EngineError::BadParams {
            cmd: CMD.into(),
            msg: format!("`{key}` must be a revision number, got {what}"),
        })
    };
    match p.get(key) {
        None => Err(EngineError::BadParams {
            cmd: CMD.into(),
            msg: format!(
                "`{key}` is required: a document revision, like the one document.inspect reports or the revision_before an agent.begin returns"
            ),
        }),
        Some(Value::Null) => refuse("null"),
        Some(Value::Bool(_)) => refuse("a boolean"),
        Some(Value::String(_)) => refuse("a string"),
        Some(Value::Array(_)) => refuse("an array"),
        Some(Value::Object(_)) => refuse("an object"),
        Some(Value::Number(n)) => match n.as_u64() {
            Some(rev) => Ok(rev),
            None if n.as_i64().is_some() => refuse("a negative number"),
            None => refuse("a fractional number"),
        },
    }
}

/// The document as it stood at revision `rev`. The current revision always resolves; an
/// open agent transaction adds the one its checkpoint was taken at — the same snapshot
/// lookup `agent.commit` / `agent.rollback` use — and nothing else survives in the engine.
/// A number the engine no longer holds is an error that lists the ones it does, so a
/// caller never guesses what it diffed.
fn resolve(s: &Session, rev: u64, param: &str) -> Result<Arc<Document>> {
    let st = s.active().ok_or(EngineError::NoDocument)?;
    if rev == st.revision {
        return Ok(st.doc.clone());
    }
    let txn = open_transaction(s);
    if let Some(txn) = txn.as_ref().filter(|t| t.revision_before == rev) {
        return match st.snapshots.iter().find(|snap| snap.id == txn.snapshot) {
            Some(snap) => Ok(snap.doc.clone()),
            None => Err(EngineError::Other(format!(
                "revision {rev} is the open transaction's checkpoint, but its snapshot was deleted; the checkpoint can no longer be diffed"
            ))),
        };
    }
    let mut held = format!("{} (the current revision)", st.revision);
    if let Some(txn) = txn.as_ref().filter(|t| st.snapshots.iter().any(|snap| snap.id == t.snapshot)) {
        held.push_str(&format!(", {} (the open transaction's checkpoint)", txn.revision_before));
    }
    Err(EngineError::BadParams {
        cmd: CMD.into(),
        msg: format!("`{param}` revision {rev} is not held: available revisions are {held}"),
    })
}

fn has_doc(s: &Session) -> std::result::Result<(), String> {
    s.active().map(|_| ()).ok_or_else(|| "no document open".into())
}

/// `document.diff { from, to }` — a pure query; the document, its history and its
/// revision are left exactly as they were.
fn run(s: &mut Session, p: &Value) -> Result<Value> {
    let from_rev = revision_param(p, "from")?;
    let to_rev = revision_param(p, "to")?;
    let from_doc = resolve(s, from_rev, "from")?;
    let to_doc = resolve(s, to_rev, "to")?;
    if from_rev > to_rev {
        return Err(EngineError::BadParams {
            cmd: CMD.into(),
            msg: format!(
                "`from` revision {from_rev} is after `to` revision {to_rev}; diff from the older revision to the newer one"
            ),
        });
    }
    Ok(diff(&from_doc, &to_doc, from_rev, to_rev))
}

pub fn specs() -> Vec<CommandSpec> {
    vec![CommandSpec {
        id: CMD,
        label: "Diff Document Revisions",
        menu: &[],
        shortcut: None,
        params: r##"{"from":rev,"to":rev} → {"from","to","added":[row],"removed":[row],"changed":[row],"moved":[row]} — row: {"layer_id","name","kind","bounds_from","bounds_to","props_changed":[prop,…]}, moved rows add {"parent_from","parent_to","order_from","order_to"}; "moved" is a tree-position change (another parent, or another order among the siblings both revisions share), geometry is a property change; props_changed lists the layer-row keys that differ (opacity, fill, blend, text, visible, bounds, name, …); revisions are the counters commands report: the current one (document.inspect) and, while an agent transaction is open, the checkpoint revision agent.begin returned as revision_before; from = to is an empty diff, a revision no longer held is an error listing the held ones"##,
        enabled: has_doc,
        run,
        journal: false,
    }]
}

#[cfg(test)]
mod tests {
    use super::*;
    use photocraft_doc::{Layer, LayerContent};
    use serde_json::json;

    /// A document with a background, a plain layer and a text layer, with the ids to
    /// add to, remove from, change and reorder.
    fn session() -> (Session, u64, u64) {
        let mut s = Session::new();
        s.execute("file.new", json!({"width": 64, "height": 48})).unwrap();
        let sky = s.execute("layer.new.layer", json!({"name": "Sky"})).unwrap()["layer"].as_u64().unwrap();
        let headline =
            s.execute("type.create", json!({"x": 4, "y": 16, "text": "Hello", "name": "Headline"})).unwrap()["layer"]
                .as_u64()
                .unwrap();
        (s, sky, headline)
    }

    /// The layer ids of one diff list, in report order.
    fn ids(diff: &Value, key: &str) -> Vec<u64> {
        diff[key].as_array().unwrap().iter().map(|r| r["layer_id"].as_u64().unwrap()).collect()
    }

    #[test]
    fn classifies_added_removed_changed_and_moved_layers() {
        let (mut s, sky, headline) = session();
        let bg = s.active().unwrap().doc.layers[0].id.0;
        let from = s.execute("agent.begin", json!({"name": "Restyle"})).unwrap()["revision_before"].as_u64().unwrap();
        let badge = s.execute("layer.new.layer", json!({"name": "Badge"})).unwrap()["layer"].as_u64().unwrap();
        s.execute("layer.delete", json!({"layer": sky})).unwrap();
        s.execute("layer.setProps", json!({"layer": headline, "opacity": 0.5, "visible": false})).unwrap();
        s.execute("type.edit", json!({"layer": headline, "text": "Goodbye"})).unwrap();
        s.execute("layer.arrange.bringForward", json!({"layer": bg})).unwrap();
        let to = s.active().unwrap().revision;
        let d = s.execute(CMD, json!({"from": from, "to": to})).unwrap();
        assert_eq!((d["from"].as_u64(), d["to"].as_u64()), (Some(from), Some(to)));
        assert_eq!(ids(&d, "added"), [badge], "the run added the badge");
        assert_eq!(ids(&d, "removed"), [sky], "the run deleted the sky");
        // bringForward reordered the background above the headline: both survivors moved
        // (their shared order changed), and the headline's restyle rides along.
        assert_eq!(ids(&d, "moved"), [bg, headline]);
        assert_eq!(ids(&d, "changed"), []);
        let row = d["moved"].as_array().unwrap().iter().find(|r| r["layer_id"].as_u64() == Some(headline)).unwrap();
        for key in ["opacity", "visible", "text"] {
            assert!(row["props_changed"].as_array().unwrap().iter().any(|p| p.as_str() == Some(key)), "{key}: {row}");
        }
        assert!(row["bounds_from"].clone().is_null() == row["bounds_to"].clone().is_null(), "{row}");
        assert_eq!((row["order_from"].as_u64(), row["order_to"].as_u64()), (Some(0), Some(2)), "[Badge, Background, Headline]");
        let added = d["added"].as_array().unwrap()[0].clone();
        assert_eq!((added["name"].as_str(), added["bounds_from"].clone()), (Some("Badge"), Value::Null));
    }

    #[test]
    fn reports_property_changes_by_name() {
        let (mut s, _sky, headline) = session();
        let from = s.execute("agent.begin", json!({})).unwrap()["revision_before"].as_u64().unwrap();
        s.execute("layer.setProps", json!({"layer": headline, "opacity": 0.25})).unwrap();
        let to = s.active().unwrap().revision;
        let d = s.execute(CMD, json!({"from": from, "to": to})).unwrap();
        let changed = d["changed"].as_array().unwrap();
        assert_eq!(changed.len(), 1);
        assert_eq!(changed[0]["layer_id"].as_u64(), Some(headline));
        assert_eq!(changed[0]["props_changed"].clone(), json!(["opacity"]), "alphabetical, exact");
        assert_eq!(changed[0]["bounds_from"], changed[0]["bounds_to"], "opacity alone moves nothing");
        // The name is a property too, and the row shows the current one.
        s.execute("layer.setProps", json!({"layer": headline, "name": "Tagline"})).unwrap();
        let to = s.active().unwrap().revision;
        let d = s.execute(CMD, json!({"from": from, "to": to})).unwrap();
        let row = &d["changed"].as_array().unwrap()[0];
        assert_eq!(row["name"].as_str(), Some("Tagline"));
        assert_eq!(row["props_changed"].clone(), json!(["name", "opacity"]));
    }

    #[test]
    fn the_same_revision_and_a_nil_run_diff_to_nothing() {
        let (mut s, _sky, _headline) = session();
        let now = s.active().unwrap().revision;
        let d = s.execute(CMD, json!({"from": now, "to": now})).unwrap();
        for key in ["added", "removed", "changed", "moved"] {
            assert_eq!(d[key].as_array().map(|a| a.len()), Some(0), "{key}");
        }
        // An open transaction that changed nothing: the checkpoint is the current document.
        let from = s.execute("agent.begin", json!({"name": "No-op"})).unwrap()["revision_before"].as_u64().unwrap();
        let d = s.execute(CMD, json!({"from": from, "to": now})).unwrap();
        for key in ["added", "removed", "changed", "moved"] {
            assert_eq!(d[key].as_array().map(|a| a.len()), Some(0), "{key}");
        }
    }

    #[test]
    fn the_same_diff_is_reported_twice_identically() {
        let (mut s, sky, headline) = session();
        let from = s.execute("agent.begin", json!({})).unwrap()["revision_before"].as_u64().unwrap();
        s.execute("layer.delete", json!({"layer": sky})).unwrap();
        s.execute("layer.setProps", json!({"layer": headline, "opacity": 0.5})).unwrap();
        let to = s.active().unwrap().revision;
        let a = s.execute(CMD, json!({"from": from, "to": to})).unwrap();
        let b = s.execute(CMD, json!({"from": from, "to": to})).unwrap();
        assert_eq!(a, b, "same rows, same order, twice");
        for key in ["added", "removed", "changed", "moved"] {
            let listed = ids(&a, key);
            let mut sorted = listed.clone();
            sorted.sort_unstable();
            assert_eq!(listed, sorted, "{key} is ordered by layer id");
        }
    }

    #[test]
    fn bad_params_are_errors_that_name_the_param() {
        let mut bare = Session::new();
        assert!(bare.execute(CMD, json!({"from": 1, "to": 1})).is_err(), "no document open");
        let (mut s, _sky, _headline) = session();
        let now = s.active().unwrap().revision;
        for p in [
            json!({}),
            json!({"from": now}),
            json!({"to": now}),
            json!({"from": null, "to": now}),
            json!({"from": now, "to": null}),
            json!({"from": "later", "to": now}),
            json!({"from": true, "to": now}),
            json!({"from": [now], "to": now}),
            json!({"from": {}, "to": now}),
            json!({"from": -1, "to": now}),
            json!({"from": 1.5, "to": now}),
            json!({"from": u64::MAX, "to": now}),
            json!([]),
            json!(0),
            json!("str"),
        ] {
            assert!(s.execute(CMD, p.clone()).is_err(), "{p}");
        }
        let err = s.execute(CMD, json!({"from": "later", "to": now})).unwrap_err().to_string();
        assert!(err.contains("`from` must be a revision number, got a string"), "{err}");
        assert!(s.execute(CMD, json!({"from": now, "to": now})).is_ok());
    }

    #[test]
    fn unknown_revisions_list_the_held_ones() {
        let (mut s, _sky, _headline) = session();
        let now = s.active().unwrap().revision;
        let err = s.execute(CMD, json!({"from": now + 1, "to": now + 2})).unwrap_err().to_string();
        assert!(err.contains("available revisions"), "{err}");
        assert!(err.contains("the current revision"), "{err}");
        assert!(!err.contains("checkpoint"), "{err}");
        // With a transaction open, the checkpoint revision joins the listing.
        let from = s.execute("agent.begin", json!({})).unwrap()["revision_before"].as_u64().unwrap();
        let err = s.execute(CMD, json!({"from": from + 1, "to": from + 2})).unwrap_err().to_string();
        assert!(err.contains(&format!("{from} (the open transaction's checkpoint)")), "{err}");
    }

    #[test]
    fn a_reversed_range_is_an_error_not_a_backwards_diff() {
        let (mut s, _sky, _headline) = session();
        let from = s.execute("agent.begin", json!({})).unwrap()["revision_before"].as_u64().unwrap();
        s.execute("layer.new.layer", json!({"name": "Later"})).unwrap();
        let to = s.active().unwrap().revision;
        let err = s.execute(CMD, json!({"from": to, "to": from})).unwrap_err().to_string();
        assert!(err.contains("after") && err.contains("older"), "{err}");
    }

    #[test]
    fn a_closed_transaction_no_longer_holds_its_checkpoint_revision() {
        let (mut s, _sky, _headline) = session();
        let from = s.execute("agent.begin", json!({"name": "Done"})).unwrap()["revision_before"].as_u64().unwrap();
        s.execute("layer.new.layer", json!({"name": "Later"})).unwrap();
        s.execute("agent.commit", json!({})).unwrap();
        let to = s.active().unwrap().revision;
        let err = s.execute(CMD, json!({"from": from, "to": to})).unwrap_err().to_string();
        assert!(err.contains("available revisions") && !err.contains("checkpoint"), "{err}");
    }

    #[test]
    fn a_deleted_checkpoint_snapshot_is_reported_not_guessed() {
        let (mut s, _sky, _headline) = session();
        let begin = s.execute("agent.begin", json!({})).unwrap();
        let (from, snapshot) = (begin["revision_before"].as_u64().unwrap(), begin["transaction_id"].as_u64().unwrap());
        s.execute("layer.new.layer", json!({"name": "Later"})).unwrap();
        s.execute("history.deleteSnapshot", json!({"snapshot": snapshot})).unwrap();
        let to = s.active().unwrap().revision;
        let err = s.execute(CMD, json!({"from": from, "to": to})).unwrap_err().to_string();
        assert!(err.contains("deleted"), "{err}");
    }

    #[test]
    fn a_transaction_on_another_document_holds_no_revisions_here() {
        let (mut s, _sky, _headline) = session();
        for i in 0..3 {
            s.execute("layer.new.layer", json!({"name": format!("L{i}")})).unwrap();
        }
        let other = s.execute("agent.begin", json!({"name": "on A"})).unwrap()["revision_before"].as_u64().unwrap();
        s.execute("file.new", json!({"width": 8, "height": 8})).unwrap();
        let here = s.active().unwrap().revision;
        assert!(here < other, "each document counts its own revisions");
        let err = s.execute(CMD, json!({"from": other, "to": other})).unwrap_err().to_string();
        assert!(err.contains("available revisions"), "{err}");
        assert!(s.execute(CMD, json!({"from": here, "to": here})).is_ok());
    }

    #[test]
    fn an_empty_document_diffs_without_rows() {
        let mut s = Session::new();
        s.execute("file.new", json!({"width": 8, "height": 8})).unwrap();
        let from = s.execute("agent.begin", json!({})).unwrap()["revision_before"].as_u64().unwrap();
        let had = s.active().unwrap().doc.layers.len();
        s.edit("Clear", |doc, _| {
            doc.layers.clear();
            Ok(())
        })
        .unwrap();
        let to = s.active().unwrap().revision;
        let d = s.execute(CMD, json!({"from": from, "to": to})).unwrap();
        assert_eq!(ids(&d, "removed").len(), had, "everything the document had is reported");
        assert!(d["added"].as_array().unwrap().is_empty());
        let d = s.execute(CMD, json!({"from": to, "to": to})).unwrap();
        for key in ["added", "removed", "changed", "moved"] {
            assert!(d[key].as_array().unwrap().is_empty(), "{key}");
        }
    }

    #[test]
    fn additions_and_removals_do_not_move_the_survivors() {
        let mut s = Session::new();
        s.execute("file.new", json!({"width": 64, "height": 48})).unwrap();
        let a = s.execute("layer.new.layer", json!({"name": "A"})).unwrap()["layer"].as_u64().unwrap();
        let mid = s.execute("layer.new.layer", json!({"name": "Mid"})).unwrap()["layer"].as_u64().unwrap();
        let b = s.execute("layer.new.layer", json!({"name": "B"})).unwrap()["layer"].as_u64().unwrap();
        let from = s.execute("agent.begin", json!({})).unwrap()["revision_before"].as_u64().unwrap();
        s.execute("layer.delete", json!({"layer": mid})).unwrap();
        s.execute("layer.new.layer", json!({"name": "New"})).unwrap();
        let to = s.active().unwrap().revision;
        let d = s.execute(CMD, json!({"from": from, "to": to})).unwrap();
        assert_eq!(ids(&d, "removed"), [mid]);
        assert_eq!(ids(&d, "added").len(), 1);
        assert_eq!(ids(&d, "changed"), [], "nothing about the survivors changed");
        assert_eq!(ids(&d, "moved"), [], "removing Mid and adding a top layer keeps A and B in place");
    }

    #[test]
    fn a_layer_moved_between_parents_reports_them() {
        let mut s = Session::new();
        s.execute("file.new", json!({"width": 64, "height": 48})).unwrap();
        let fmt = s.active().unwrap().doc.pixel_format();
        let inner = Layer::raster("inner", fmt);
        let group = Layer::group("G", vec![inner.clone()]);
        let (inner_id, group_id) = (inner.id.0, group.id.0);
        s.edit("Group", |doc, _| {
            doc.layers = vec![group.clone()];
            Ok(())
        })
        .unwrap();
        let from = s.execute("agent.begin", json!({})).unwrap()["revision_before"].as_u64().unwrap();
        // The inner layer leaves the (now empty) group and lands above it at the top
        // level; ids are kept, so the diff sees moves, not an add and a remove.
        let mut emptied = group.clone();
        if let LayerContent::Group(g) = &mut emptied.content {
            g.children.clear();
        }
        s.edit("Move out", |doc, _| {
            doc.layers = vec![emptied.clone(), inner.clone()];
            Ok(())
        })
        .unwrap();
        let to = s.active().unwrap().revision;
        let d = s.execute(CMD, json!({"from": from, "to": to})).unwrap();
        // The moved layer and the group it left behind changed their shared order.
        assert_eq!(ids(&d, "moved"), [inner_id, group_id], "ordered by layer id");
        let row = d["moved"].as_array().unwrap().iter().find(|r| r["layer_id"].as_u64() == Some(inner_id)).unwrap();
        assert_eq!((row["parent_from"].as_u64(), row["parent_to"].clone()), (Some(group_id), Value::Null));
        assert_eq!((row["order_from"].as_u64(), row["order_to"].as_u64()), (Some(0), Some(0)));
        assert_eq!(ids(&d, "changed"), []);
    }

    #[test]
    fn deep_trees_and_repeated_ids_are_bounded_not_looped() {
        let mut s = Session::new();
        s.execute("file.new", json!({"width": 8, "height": 8})).unwrap();
        let fmt = s.active().unwrap().doc.pixel_format();
        // A chain deeper than the limit: the excess layers are left out, identically on
        // both sides, so the limit never reads as a change.
        let mut chain = Layer::raster("leaf", fmt);
        for _ in 0..(MAX_DEPTH + 40) {
            chain = Layer::group("level", vec![chain]);
        }
        s.edit("Deep", |doc, _| {
            doc.layers = vec![chain];
            Ok(())
        })
        .unwrap();
        assert_eq!(flatten(&s.active().unwrap().doc).layers.len(), MAX_DEPTH, "the walk stops at the limit");
        // A repeated id (only a corrupted document has one) is reported once.
        let leaf = Layer::raster("twin", fmt);
        s.edit("Twins", |doc, _| {
            doc.layers = vec![leaf.clone(), leaf];
            Ok(())
        })
        .unwrap();
        assert_eq!(flatten(&s.active().unwrap().doc).layers.len(), 1, "the seen-set reports a repeated id once");
        let now = s.active().unwrap().revision;
        let d = s.execute(CMD, json!({"from": now, "to": now})).unwrap();
        assert_eq!(d["added"].as_array().map(|a| a.len()), Some(0));
    }

    #[test]
    fn diff_is_a_query_and_the_menu_state_follows_the_document() {
        let (mut s, _sky, _headline) = session();
        let now = s.active().unwrap().revision;
        let (rev, journal) = (s.active().unwrap().revision, s.journal.len());
        assert!(s.is_enabled(CMD));
        s.execute(CMD, json!({"from": now, "to": now})).unwrap();
        assert_eq!((s.active().unwrap().revision, s.journal.len()), (rev, journal), "a query changes nothing");
        let mut bare = Session::new();
        assert!(!bare.is_enabled(CMD), "nothing to diff without a document");
    }
}
