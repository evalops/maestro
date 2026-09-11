//! Native configuration receipts and optional categorical product feedback.
use super::App;
use crate::telemetry::{
    ConfigurationReceipt, FeedbackRating, OnboardingCollectionStatus, TelemetryIdentityScope,
    VisibilityEvent,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
};

const FEEDBACK_COOLDOWN_SECONDS: i64 = 7 * 24 * 60 * 60;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SavedRating {
    event: VisibilityEvent,
    queued_at: Option<i64>,
}

// Read the previous timestamp-only cooldown without allowing a release upgrade
// to reset a rating that has already been submitted.
#[derive(Deserialize)]
#[serde(untagged)]
enum StoredRating {
    Current(SavedRating),
    Legacy(i64),
}

struct FeedbackLock(File);

impl Drop for FeedbackLock {
    fn drop(&mut self) {
        // A concurrent fork can retain the open file description. Closing only
        // our descriptor would leave the lock held until that child exits.
        if let Err(error) = self.0.unlock() {
            tracing::warn!(%error, "Could not release feedback submission lock");
        }
    }
}

struct FeedbackCooldown {
    _lock: FeedbackLock,
    receipt_path: PathBuf,
    pending: Option<SavedRating>,
}
impl FeedbackCooldown {
    fn acquire(
        root: &Path,
        scope: &TelemetryIdentityScope,
        now: i64,
    ) -> anyhow::Result<Option<Self>> {
        let key = format!("{:x}", Sha256::digest(serde_json::to_vec(scope)?));
        std::fs::create_dir_all(root)?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let lock = options.open(root.join(format!("{key}.lock")))?;
        lock.try_lock()
            .map_err(|_| anyhow::anyhow!("Feedback is already being submitted."))?;
        let lock = FeedbackLock(lock);
        let receipt_path = root.join(format!("{key}.json"));
        let mut pending = None;
        match File::open(&receipt_path) {
            Ok(file) => {
                let mut text = String::new();
                file.take(4097).read_to_string(&mut text)?;
                anyhow::ensure!(text.len() <= 4096, "Invalid saved rating");
                let stored: StoredRating = serde_json::from_str(&text)?;
                let queued_at = match stored {
                    StoredRating::Legacy(at) => Some(at),
                    StoredRating::Current(saved) => {
                        anyhow::ensure!(
                            saved.event.is_server_valid() && saved.event.is_feedback(),
                            "Invalid saved rating"
                        );
                        let at = saved.queued_at;
                        if at.is_none() {
                            pending = Some(saved);
                        }
                        at
                    }
                };
                // Clock rollback must not shorten the cooldown.
                if queued_at.is_some_and(|at| now.saturating_sub(at) < FEEDBACK_COOLDOWN_SECONDS) {
                    return Ok(None);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        Ok(Some(Self {
            _lock: lock,
            receipt_path,
            pending,
        }))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum FeedbackSubmission {
    Queued,
    QueuedPending,
    Disabled,
    Unavailable,
    Failed,
    Cooldown,
    LocalFailure,
}
impl FeedbackSubmission {
    fn message(self) -> &'static str {
        match self {
            Self::Queued => maestro_ui::localization::tr(
                "Your saved rating is queued for the product team. Thank you.",
            ),
            Self::QueuedPending => maestro_ui::localization::tr(
                "Your rating is queued, but its cooldown could not be saved. Retrying will reuse this rating without submitting another response.",
            ),
            Self::Disabled => maestro_ui::localization::tr(
                "Rating was not sent because telemetry is turned off. Your pending rating is saved locally for an explicit retry.",
            ),
            Self::Unavailable => maestro_ui::localization::tr(
                "Rating was not sent because the signed-in workspace changed or is unavailable.",
            ),
            Self::Failed => maestro_ui::localization::tr(
                "Rating could not be queued. Retry the same /feedback rating command to send the saved rating.",
            ),
            Self::Cooldown => maestro_ui::localization::tr(
                "You already shared a rating for this workspace. You can share another after seven days.",
            ),
            Self::LocalFailure => maestro_ui::localization::tr(
                "Rating was not sent because its local submission state could not be saved. Try again later.",
            ),
        }
    }
}

fn submit_rating_with(
    root: &Path,
    scope: &TelemetryIdentityScope,
    rating: FeedbackRating,
    now: i64,
    enqueue: impl FnOnce(&VisibilityEvent, &TelemetryIdentityScope) -> OnboardingCollectionStatus,
    mut write: impl FnMut(&Path, &[u8]) -> anyhow::Result<()>,
) -> FeedbackSubmission {
    let mut cooldown = match FeedbackCooldown::acquire(root, scope, now) {
        Ok(Some(value)) => value,
        Ok(None) => return FeedbackSubmission::Cooldown,
        Err(_) => return FeedbackSubmission::LocalFailure,
    };
    let mut saved = match cooldown.pending.take() {
        Some(saved) => saved,
        None => {
            let saved = SavedRating {
                event: VisibilityEvent::feedback(rating),
                queued_at: None,
            };
            let Ok(bytes) = serde_json::to_vec(&saved) else {
                return FeedbackSubmission::LocalFailure;
            };
            if write(&cooldown.receipt_path, &bytes).is_err() {
                return FeedbackSubmission::LocalFailure;
            }
            saved
        }
    };
    match enqueue(&saved.event, scope) {
        OnboardingCollectionStatus::Queued => {
            saved.queued_at = Some(now);
            let Ok(bytes) = serde_json::to_vec(&saved) else {
                return FeedbackSubmission::QueuedPending;
            };
            if write(&cooldown.receipt_path, &bytes).is_err() {
                FeedbackSubmission::QueuedPending
            } else {
                FeedbackSubmission::Queued
            }
        }
        OnboardingCollectionStatus::Disabled => FeedbackSubmission::Disabled,
        OnboardingCollectionStatus::Unavailable => FeedbackSubmission::Unavailable,
        OnboardingCollectionStatus::Failed => FeedbackSubmission::Failed,
    }
}

impl App {
    pub(super) fn record_configuration_visibility(&self) {
        let event = VisibilityEvent::configuration(ConfigurationReceipt::from_managed_setup(
            &self.managed_setup,
            chrono::Utc::now().timestamp(),
        ));
        let origin = self.managed_setup_identity_scope.clone();
        tokio::spawn(async move {
            let _ = crate::telemetry::record_first_party_visibility_event(&event, origin).await;
        });
    }

    pub(super) fn poll_feedback_rating(&mut self) {
        let Some(receiver) = self.feedback_rating_rx.as_mut() else {
            return;
        };
        let result = match receiver.try_recv() {
            Ok(result) => result,
            Err(tokio::sync::oneshot::error::TryRecvError::Empty) => return,
            Err(tokio::sync::oneshot::error::TryRecvError::Closed) => FeedbackSubmission::Failed,
        };
        self.feedback_rating_rx = None;
        self.state.add_system_message(result.message().into());
    }

    pub(super) async fn handle_feedback_rating(&mut self, text: &str) {
        let rating = match text.trim() {
            "useful" => FeedbackRating::Useful,
            "partly_useful" => FeedbackRating::PartlyUseful,
            "not_useful" => FeedbackRating::NotUseful,
            _ => {
                self.state.add_system_message(self.state.locale.translate("Was Deixic Code useful? To share one optional rating with the product team, use /feedback rating useful, /feedback rating partly_useful, or /feedback rating not_useful. Only this category is sent. One rating per workspace every seven days. Retrying a pending submission reuses the previously saved rating.").into());
                return;
            }
        };
        if self.feedback_rating_rx.is_some() {
            self.state.add_system_message(
                self.state
                    .locale
                    .translate("A rating submission is already in progress.")
                    .into(),
            );
            return;
        }
        // Capture the local account before yielding. Network validation still
        // requires this exact scope inside the off-thread collection boundary.
        let Some(scope) = crate::telemetry::onboarding_identity_scope() else {
            self.state.add_system_message(
                self.state.locale.translate("Rating was not sent. Sign in to a Deixic workspace to share product feedback.")
                    .into(),
            );
            return;
        };
        let Some(home) = crate::path_utils::maestro_home_dir() else {
            self.state
                .add_system_message(FeedbackSubmission::LocalFailure.message().into());
            return;
        };
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.feedback_rating_rx = Some(rx);
        let runtime = tokio::runtime::Handle::current();
        tokio::task::spawn_blocking(move || {
            let result = submit_rating_with(
                &home.join("feedback-ratings"),
                &scope,
                rating,
                chrono::Utc::now().timestamp(),
                |event, origin| {
                    runtime.block_on(crate::telemetry::record_first_party_visibility_event(
                        event,
                        Some(origin.clone()),
                    ))
                },
                crate::path_utils::atomic_private_write,
            );
            let _ = tx.send(result);
        });
        self.state
            .add_system_message(self.state.locale.translate("Saving your rating…").into());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn scope(workspace: &str) -> TelemetryIdentityScope {
        TelemetryIdentityScope::new("org", Some(workspace)).unwrap()
    }
    fn submit(
        root: &Path,
        scope: &TelemetryIdentityScope,
        now: i64,
        status: OnboardingCollectionStatus,
    ) -> FeedbackSubmission {
        submit_rating_with(
            root,
            scope,
            FeedbackRating::Useful,
            now,
            |_, _| status,
            crate::path_utils::atomic_private_write,
        )
    }
    #[test]
    fn queued_submission_persists_cooldown_and_tenant_scope() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(
            submit(
                root.path(),
                &scope("a"),
                1000,
                OnboardingCollectionStatus::Queued
            ),
            FeedbackSubmission::Queued
        );
        assert_eq!(
            submit(
                root.path(),
                &scope("a"),
                999,
                OnboardingCollectionStatus::Queued
            ),
            FeedbackSubmission::Cooldown
        );
        assert_eq!(
            submit(
                root.path(),
                &scope("a"),
                1001,
                OnboardingCollectionStatus::Queued
            ),
            FeedbackSubmission::Cooldown
        );
        assert_eq!(
            submit(
                root.path(),
                &scope("b"),
                1001,
                OnboardingCollectionStatus::Queued
            ),
            FeedbackSubmission::Queued
        );
        assert_eq!(
            submit(
                root.path(),
                &scope("a"),
                1000 + FEEDBACK_COOLDOWN_SECONDS,
                OnboardingCollectionStatus::Queued
            ),
            FeedbackSubmission::Queued
        );
    }
    #[test]
    fn disabled_unavailable_and_failed_do_not_start_cooldown() {
        for (status, expected) in [
            (
                OnboardingCollectionStatus::Disabled,
                FeedbackSubmission::Disabled,
            ),
            (
                OnboardingCollectionStatus::Unavailable,
                FeedbackSubmission::Unavailable,
            ),
            (
                OnboardingCollectionStatus::Failed,
                FeedbackSubmission::Failed,
            ),
        ] {
            let root = tempfile::tempdir().unwrap();
            assert_eq!(submit(root.path(), &scope("a"), 1000, status), expected);
            assert!(
                FeedbackCooldown::acquire(root.path(), &scope("a"), 1001)
                    .unwrap()
                    .is_some()
            );
            assert_eq!(
                submit(
                    root.path(),
                    &scope("a"),
                    1001,
                    OnboardingCollectionStatus::Queued
                ),
                FeedbackSubmission::Queued
            );
        }
    }
    #[test]
    fn queued_marker_failure_reuses_immutable_event_across_restart() {
        let root = tempfile::tempdir().unwrap();
        let mut first_event = None;
        let mut writes = 0;
        let result = submit_rating_with(
            root.path(),
            &scope("a"),
            FeedbackRating::Useful,
            1000,
            |event, _| {
                first_event = Some(serde_json::to_value(event).unwrap());
                OnboardingCollectionStatus::Queued
            },
            |path, bytes| {
                writes += 1;
                if writes == 2 {
                    anyhow::bail!("injected marker failure");
                }
                crate::path_utils::atomic_private_write(path, bytes)
            },
        );
        assert_eq!(result, FeedbackSubmission::QueuedPending);
        // A fresh command with a different selection retries the accepted pending event.
        let result = submit_rating_with(
            root.path(),
            &scope("a"),
            FeedbackRating::NotUseful,
            1001,
            |event, _| {
                assert_eq!(Some(serde_json::to_value(event).unwrap()), first_event);
                OnboardingCollectionStatus::Queued
            },
            crate::path_utils::atomic_private_write,
        );
        assert_eq!(result, FeedbackSubmission::Queued);
        assert_eq!(
            submit(
                root.path(),
                &scope("a"),
                1002,
                OnboardingCollectionStatus::Queued
            ),
            FeedbackSubmission::Cooldown
        );
    }
    #[test]
    fn pending_write_failure_prevents_enqueue_and_lock_excludes_other_windows() {
        let root = tempfile::tempdir().unwrap();
        let result = submit_rating_with(
            root.path(),
            &scope("a"),
            FeedbackRating::Useful,
            1000,
            |_, _| panic!("must persist immutable event before enqueue"),
            |_, _| anyhow::bail!("injected pending failure"),
        );
        assert_eq!(result, FeedbackSubmission::LocalFailure);
        let _held = FeedbackCooldown::acquire(root.path(), &scope("a"), 1000)
            .unwrap()
            .unwrap();
        assert_eq!(
            submit(
                root.path(),
                &scope("a"),
                1000,
                OnboardingCollectionStatus::Queued
            ),
            FeedbackSubmission::LocalFailure
        );
    }

    #[cfg(unix)]
    #[test]
    fn cooldown_release_unlocks_inherited_file_description() {
        let root = tempfile::tempdir().unwrap();
        let held = FeedbackCooldown::acquire(root.path(), &scope("a"), 1000)
            .unwrap()
            .unwrap();
        // dup and fork retain the same open file description on Unix. Keep a
        // duplicate alive to deterministically model a concurrently forked child.
        let inherited = held._lock.0.try_clone().unwrap();
        assert!(FeedbackCooldown::acquire(root.path(), &scope("a"), 1001).is_err());
        drop(held);
        let retry = FeedbackCooldown::acquire(root.path(), &scope("a"), 1001)
            .unwrap()
            .unwrap();
        drop(retry);
        drop(inherited);
    }
}
