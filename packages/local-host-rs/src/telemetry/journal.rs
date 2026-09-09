//! Pending observations live under the existing private outbox. One OS file
//! lease per producer prevents restart recovery from stealing a live turn.
//! A terminal update precedes promotion; retries retain the same event UUID.
//! This cannot account for events a process never delivered to its collector.
use super::*;
use std::collections::HashMap;

pub(crate) struct TurnJournal {
    outbox: PathBuf,
    directory: PathBuf,
    _lease: std::fs::File,
    records: HashMap<String, (PathBuf, Uuid)>,
}

impl TurnJournal {
    pub(crate) fn open() -> Option<Self> {
        if first_party_telemetry_disabled() {
            return None;
        }
        let journal = Self::open_at(first_party_outbox_dir())?;
        schedule_first_party_outbox_drain();
        Some(journal)
    }

    fn open_at(outbox: PathBuf) -> Option<Self> {
        let journals = outbox.join("pending");
        ensure_private_directory(&journals)?;
        Self::recover(&outbox, &journals);
        let directory = journals.join(Uuid::new_v4().to_string());
        ensure_private_directory(&directory)?;
        let lease = OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .open(directory.join("lease"))
            .ok()?;
        lease.try_lock().ok()?;
        Some(Self {
            outbox,
            directory,
            _lease: lease,
            records: HashMap::new(),
        })
    }

    fn recover(outbox: &Path, journals: &Path) {
        let Ok(entries) = fs::read_dir(journals) else {
            return;
        };
        for entry in entries.flatten() {
            if !entry.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let directory = entry.path();
            let Ok(lease) = OpenOptions::new()
                .read(true)
                .write(true)
                .open(directory.join("lease"))
            else {
                continue;
            };
            if lease.try_lock().is_err() {
                continue;
            }
            for path in outbox_paths(&directory) {
                if read_bounded_outbox_record(&path).is_some() {
                    let _ = promote(outbox, &path);
                }
            }
            if outbox_paths(&directory).is_empty() {
                let _ = fs::remove_file(directory.join("lease"));
                let _ = fs::remove_dir(directory);
            }
        }
    }

    fn write(&mut self, event: &CanonicalTurnEvent) -> Option<PathBuf> {
        let scope = event.identity_scope.as_ref().filter(|s| s.is_complete())?;
        let mut cloud = canonical_cloud_projection(event)?;
        if !cloud.is_server_valid() {
            return None;
        }
        let (path, id) = self
            .records
            .entry(event.turn_id.clone())
            .or_insert_with(|| {
                let id = Uuid::new_v4();
                (
                    self.directory.join(format!(
                        "{:020}_{id}.json",
                        chrono::Utc::now().timestamp_micros()
                    )),
                    id,
                )
            });
        cloud.event_id = *id;
        cloud.delivery = Some(delivery_snapshot(&self.outbox, scope));
        let record = FirstPartyOutboxRecord {
            identity_scope: scope.clone(),
            event: cloud.into(),
        };
        let bytes = serde_json::to_vec(&record).ok()?;
        if bytes.len() > OUTBOX_MAX_EVENT_BYTES {
            return None;
        }
        if crate::path_utils::atomic_private_write(path, &bytes).is_err() {
            let _ = with_outbox_lock(&self.outbox, || {
                delivery_accounting::update(&self.outbox, scope, |a| {
                    a.write_failures = a.write_failures.saturating_add(1);
                })
            });
            return None;
        }
        Some(path.clone())
    }

    pub(crate) fn observe(&mut self, events: &[CanonicalTurnEvent]) {
        for event in events {
            if event.identity_scope.is_some() && self.write(event).is_none() {
                tracing::warn!("telemetry pending observation could not be persisted");
            }
        }
    }

    pub(crate) fn finish(&mut self, event: &CanonicalTurnEvent) {
        record_canonical_turn_event_inner(event, false);
        if let Some(path) = self.write(event) {
            if promote(&self.outbox, &path).is_some() {
                self.records.remove(&event.turn_id);
                schedule_first_party_outbox_drain();
            }
        } else if event.identity_scope.is_some() {
            tracing::warn!("telemetry terminal observation could not be persisted");
        }
    }
}

fn promote(outbox: &Path, path: &Path) -> Option<()> {
    with_outbox_lock(outbox, || {
        let destination = outbox.join(path.file_name()?);
        let scope = read_bounded_outbox_record(path)?.identity_scope;
        fs::rename(path, &destination).ok()?;
        let _ =
            delivery_accounting::update(outbox, &scope, |a| a.queued = a.queued.saturating_add(1));
        trim_outbox_paths_to_capacity(outbox_paths(outbox), OUTBOX_CAPACITY, Some(&destination))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_preserves_a_terminal_update_before_promotion() {
        let root = tempfile::tempdir().unwrap();
        let outbox = root.path().join("outbox");
        let mut producer = TurnJournal::open_at(outbox.clone()).unwrap();
        let mut event = super::super::tests::canonical_event(TurnStatus::Success);
        event.diagnostics = Some(crate::telemetry::operation::OperationDiagnostics {
            completion_observed: false,
            ..Default::default()
        });
        let path = producer.write(&event).unwrap();
        let id = read_bounded_outbox_record(&path).unwrap().event.event_id();
        event.diagnostics.as_mut().unwrap().completion_observed = true;
        assert_eq!(producer.write(&event), Some(path));
        drop(producer);
        TurnJournal::recover(&outbox, &outbox.join("pending"));
        let paths = outbox_paths(&outbox);
        assert_eq!(paths.len(), 1);
        let record = read_bounded_outbox_record(&paths[0]).unwrap();
        assert_eq!(record.event.event_id(), id);
        let FirstPartyTelemetryEvent::Turn(turn) = record.event else {
            panic!("turn")
        };
        assert!(turn.diagnostics.unwrap().completion_observed);
        let scope = event.identity_scope.unwrap();
        assert_eq!(
            delivery_accounting::read(&outbox, &scope).unwrap().queued,
            1
        );
    }

    #[test]
    fn recovery_skips_live_producers_and_reuses_the_durable_event_id() {
        let root = tempfile::tempdir().unwrap();
        let outbox = root.path().join("outbox");
        let mut producer = TurnJournal::open_at(outbox.clone()).unwrap();
        let mut event = super::super::tests::canonical_event(TurnStatus::Error);
        event.diagnostics = Some(crate::telemetry::operation::OperationDiagnostics {
            completion_observed: false,
            ..Default::default()
        });
        let path = producer.write(&event).unwrap();
        let id = read_bounded_outbox_record(&path).unwrap().event.event_id();
        let other = TurnJournal::open_at(outbox.clone()).unwrap();
        assert!(
            outbox_paths(&outbox).is_empty(),
            "live producer retains ownership"
        );
        drop(producer);
        TurnJournal::recover(&outbox, &outbox.join("pending"));
        let paths = outbox_paths(&outbox);
        assert_eq!(paths.len(), 1);
        let record = read_bounded_outbox_record(&paths[0]).unwrap();
        assert_eq!(record.event.event_id(), id);
        let FirstPartyTelemetryEvent::Turn(turn) = record.event else {
            panic!("turn")
        };
        assert!(!turn.diagnostics.unwrap().completion_observed);
        assert_eq!(turn.reported_cost_usd, None);
        TurnJournal::recover(&outbox, &outbox.join("pending"));
        assert_eq!(outbox_paths(&outbox).len(), 1);
        drop(other);
    }
}
