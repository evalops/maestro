//! JSON-driven lifecycle tests of the real actor with an incremental scripted provider.
//! Kept inside runtime tests so fixture hosts and inspection cannot enter production.
use super::*;
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, io::Write, path::Path};

const SCHEMA: &str = "evalops.maestro.session-scenario.v1";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Scenario {
    schema: String,
    name: String,
    context_window: u64,
    steps: Vec<Step>,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum Step {
    Turns {
        count: usize,
        prompt_bytes: usize,
        response_bytes: usize,
    },
    Cancel {
        count: usize,
        prompt_bytes: usize,
    },
    SeedHistory {
        messages: usize,
        message_bytes: usize,
    },
    Clear,
    Save,
    Restore,
    DropCheckpoint,
    Assert {
        bounds: BTreeMap<String, Bounds>,
    },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Bounds {
    min: Option<u64>,
    max: Option<u64>,
}

#[derive(Default, Serialize)]
pub(crate) struct Metrics {
    messages: usize,
    message_slots: usize,
    message_bytes: usize,
    message_tokens: u64,
    continuation_bytes: usize,
    retained_requests: usize,
    retained_request_bytes: usize,
    commands: usize,
    tool_outputs: usize,
    pending_prompts: usize,
    deferred_commands: usize,
    queued_system_prompts: usize,
}

type Checkpoint = (
    Vec<Message>,
    Option<crate::agent::compaction::ContinuationRecord>,
);

pub(crate) struct SessionState {
    metrics: Metrics,
    fingerprint: [u8; 32],
    checkpoint: Option<Checkpoint>,
}

// Count serialized bytes without constructing a second copy of the history.
#[derive(Default)]
struct ByteCount(usize);
impl Write for ByteCount {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0 += bytes.len();
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn json_bytes(value: &impl Serialize) -> usize {
    let mut count = ByteCount::default();
    serde_json::to_writer(&mut count, value).expect("serializable fixture state");
    count.0
}

fn fingerprint(value: &impl Serialize) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    struct HashWriter(Sha256);
    impl Write for HashWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.update(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut writer = HashWriter(Sha256::new());
    serde_json::to_writer(&mut writer, value).expect("serializable checkpoint");
    writer.0.finalize().into()
}

pub(crate) fn inspect(runner: &NativeAgentRunner, capture: bool) -> SessionState {
    let mut metrics = Metrics {
        messages: runner.messages.len(),
        message_slots: runner.messages.capacity(),
        message_bytes: json_bytes(&*runner.messages),
        message_tokens: runner.compactor.estimate_tokens(&runner.messages),
        pending_prompts: runner.pending_messages.len(),
        deferred_commands: runner.deferred_commands.len(),
        queued_system_prompts: runner.queued_system_prompts.len(),
        ..Default::default()
    };
    if let Some(record) = &runner.semantic_continuation {
        metrics.continuation_bytes = json_bytes(record);
        metrics.retained_requests = record.user_requests.len();
        metrics.retained_request_bytes = record.user_requests.iter().map(String::len).sum();
        metrics.commands = record.commands.len();
        metrics.tool_outputs = record.tool_outputs.len();
    }
    SessionState {
        fingerprint: fingerprint(&(&*runner.messages, &runner.semantic_continuation)),
        metrics,
        checkpoint: capture.then(|| {
            (
                (*runner.messages).clone(),
                runner.semantic_continuation.clone(),
            )
        }),
    }
}

async fn observe(agent: &super::super::NativeAgent, capture: bool) -> Result<SessionState> {
    let (reply, receiver) = tokio::sync::oneshot::channel();
    agent
        .command_tx
        .send(AgentCommand::InspectSession { capture, reply })?;
    Ok(tokio::time::timeout(Duration::from_secs(20), receiver).await??)
}

fn load(path: &Path) -> Result<Scenario> {
    use std::io::Read;
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 1024 * 1024, "scenario exceeds 1 MiB");
    let scenario: Scenario = serde_json::from_slice(&bytes).context("invalid session scenario")?;
    validate(&scenario)?;
    Ok(scenario)
}

fn validate(scenario: &Scenario) -> Result<()> {
    ensure!(
        scenario.schema == SCHEMA,
        "unsupported session scenario schema"
    );
    ensure!(
        !scenario.name.is_empty() && scenario.name.len() <= 128,
        "invalid scenario name"
    );
    ensure!(
        (1024..=1_000_000).contains(&scenario.context_window),
        "invalid context window"
    );
    ensure!(
        !scenario.steps.is_empty() && scenario.steps.len() <= 1000,
        "invalid step count"
    );
    let known = serde_json::to_value(Metrics::default())?;
    let mut turns = 0usize;
    let mut prompt_total = 0usize;
    let mut saved = false;
    let mut assertions = 0;
    for step in &scenario.steps {
        let (count, prompt, response) = match step {
            Step::Turns {
                count,
                prompt_bytes,
                response_bytes,
            } => {
                ensure!(*response_bytes > 0, "turn response must be nonempty");
                (*count, *prompt_bytes, *response_bytes)
            }
            Step::Cancel {
                count,
                prompt_bytes,
            } => (*count, *prompt_bytes, 0),
            Step::Save => {
                saved = true;
                continue;
            }
            Step::DropCheckpoint => {
                saved = false;
                continue;
            }
            Step::Restore => {
                ensure!(saved, "restore requires an earlier save");
                continue;
            }
            Step::SeedHistory {
                messages,
                message_bytes,
            } => {
                ensure!(
                    (1..=100_000).contains(messages),
                    "invalid seed message count"
                );
                ensure!(
                    (32..=64 * 1024).contains(message_bytes),
                    "invalid seed message size"
                );
                ensure!(
                    messages
                        .checked_mul(*message_bytes)
                        .is_some_and(|size| size <= 64 * 1024 * 1024),
                    "seed exceeds 64 MiB"
                );
                continue;
            }
            Step::Clear => continue,
            Step::Assert { bounds } => {
                ensure!(!bounds.is_empty(), "assert requires bounds");
                for (name, bound) in bounds {
                    ensure!(known.get(name).is_some(), "unknown metric: {name}");
                    ensure!(
                        bound.min.is_some() || bound.max.is_some(),
                        "empty bound: {name}"
                    );
                    if let (Some(min), Some(max)) = (bound.min, bound.max) {
                        ensure!(min <= max, "inverted bound: {name}");
                    }
                }
                assertions += 1;
                continue;
            }
        };
        ensure!((1..=100_000).contains(&count), "invalid turn count");
        ensure!(
            (32..=64 * 1024).contains(&prompt),
            "prompt_bytes must be 32..65536"
        );
        ensure!(response <= 1024 * 1024, "response_bytes exceeds 1 MiB");
        turns = turns.checked_add(count).context("turn count overflow")?;
        prompt_total = prompt_total
            .checked_add(count * prompt)
            .context("prompt size overflow")?;
    }
    ensure!(turns <= 100_000, "scenario exceeds 100000 turns");
    ensure!(
        prompt_total <= 64 * 1024 * 1024,
        "scenario prompts exceed 64 MiB"
    );
    ensure!(assertions > 0, "scenario must assert retained state");
    Ok(())
}

#[derive(Default, Serialize)]
struct EventStats {
    events: usize,
    compactions: usize,
    continuation_bytes_emitted: usize,
}
impl EventStats {
    fn observe(&mut self, event: &FromAgent) {
        self.events += 1;
        if let FromAgent::Compaction {
            continuation: Some(record),
            ..
        } = event
        {
            self.compactions += 1;
            self.continuation_bytes_emitted += json_bytes(record);
        }
    }
}

async fn terminal(
    events: &mut mpsc::UnboundedReceiver<FromAgent>,
    agent: &super::super::NativeAgent,
    cancel: bool,
    stats: &mut EventStats,
) -> Result<()> {
    tokio::time::timeout(Duration::from_secs(20), async {
        let mut cancelled = false;
        while let Some(event) = events.recv().await {
            stats.observe(&event);
            match event {
                FromAgent::ResponseChunk { .. } if cancel && !cancelled => {
                    agent.cancel();
                    cancelled = true;
                }
                FromAgent::TurnCompleted { .. } => {
                    ensure!(!cancel, "cancel scenario completed before cancellation");
                    return Ok(());
                }
                FromAgent::TurnInterrupted { .. } => {
                    ensure!(cancel && cancelled, "unexpected interruption");
                    return Ok(());
                }
                FromAgent::Error { message, .. } | FromAgent::ProviderError { message, .. } => {
                    bail!("{message}")
                }
                _ => {}
            }
        }
        bail!("event stream closed without a terminal event")
    })
    .await
    .context("turn deadline exceeded")?
}

async fn run(scenario: Scenario) -> Result<()> {
    ensure!(
        std::env::var("MAESTRO_SEMANTIC_COMPACTION").as_deref() != Ok("1"),
        "unset MAESTRO_SEMANTIC_COMPACTION: this scenario uses deterministic compaction"
    );
    let runtime_metrics = tokio::runtime::Handle::current().metrics();
    let baseline_tasks = runtime_metrics.num_alive_tasks();
    let workspace = tempfile::tempdir()?;
    let scripted = crate::ai::ScriptedClient::new("session-lifecycle", vec![]);
    let config = NativeAgentConfig {
        model: "openai/gpt-4o".into(),
        cwd: workspace.path().display().to_string(),
        context_window: Some(scenario.context_window),
        ..Default::default()
    };
    let host = RuntimeTestHost::new(
        config.cwd.clone(),
        UnifiedClient::Scripted(scripted.clone()),
    )
    .with_model_limits(512, scenario.context_window);
    let (agent, mut events) = new_runtime_test_agent_with_host(config, host)?;
    let started = Instant::now();
    let result = tokio::time::timeout(Duration::from_secs(1800), async {
        let mut saved = None;
        let mut turns = 0;
        let mut event_stats = EventStats::default();
        for (index, step) in scenario.steps.iter().enumerate() {
            match step {
                Step::Turns { count, prompt_bytes, .. } | Step::Cancel { count, prompt_bytes, .. } => {
                    let cancel = matches!(step, Step::Cancel { .. });
                    let response_bytes = match step { Step::Turns { response_bytes, .. } => *response_bytes, _ => 0 };
                    for _ in 0..*count {
                        let response = if cancel {
                            crate::ai::ScriptedResponse {
                                blocks: vec![crate::ai::ScriptedBlock::Text("cancel-ready".into()), crate::ai::ScriptedBlock::Pending],
                                stop_reason: crate::ai::StopReason::EndTurn,
                                error: None,
                            }
                        } else { crate::ai::ScriptedResponse::text("x".repeat(response_bytes)) };
                        scripted.push_response(response);
                        let prefix = format!("request-{turns}: ");
                        let prompt = format!("{prefix}{}", "local evidence ".repeat(prompt_bytes.div_ceil(15)));
                        agent.prompt(prompt[..*prompt_bytes].to_owned(), vec![]).await?;
                        terminal(&mut events, &agent, cancel, &mut event_stats).await?;
                        turns += 1;
                        ensure!(scripted.remaining() == 0, "unconsumed response at turn {turns}");
                        if turns % 100 == 0 {
                            let state = observe(&agent, false).await?;
                            eprintln!("SESSION_SAMPLE {}", serde_json::json!({"scenario": scenario.name, "turn": turns, "elapsed_ms": started.elapsed().as_millis(), "metrics": state.metrics}));
                        }
                    }
                }
                Step::SeedHistory { messages, message_bytes } => agent.replace_history(
                    (0..*messages).map(|index| Message {
                        role: if index % 2 == 0 { Role::User } else { Role::Assistant },
                        content: MessageContent::text("h".repeat(*message_bytes)),
                    }).collect(),
                ),
                Step::Clear => agent.clear_history(),
                Step::DropCheckpoint => saved = None,
                Step::Save => saved = observe(&agent, true).await?.checkpoint,
                Step::Restore => {
                    let (messages, continuation) = saved.as_ref().context("missing checkpoint")?;
                    agent.replace_history_with_continuation(messages.clone(), continuation.clone());
                    let restored = observe(&agent, false).await?;
                    ensure!(restored.fingerprint == fingerprint(&(messages, continuation)),
                        "step {index}: restore changed checkpoint contents or order");
                }
                Step::Assert { bounds } => {
                    let state = observe(&agent, false).await?;
                    let values = serde_json::to_value(&state.metrics)?;
                    for (metric, bound) in bounds {
                        let value = values[metric].as_u64().context("invalid metric")?;
                        ensure!(bound.min.is_none_or(|min| value >= min) && bound.max.is_none_or(|max| value <= max),
                            "step {index}: {metric}={value} outside {:?}..{:?}", bound.min, bound.max);
                    }
                }
            }
            let state = observe(&agent, false).await?;
            // Drain trailing notifications too; measurements must not retain snapshots.
            while let Ok(event) = events.try_recv() { event_stats.observe(&event); }
            eprintln!("SESSION_STEP {}", serde_json::json!({"scenario": scenario.name, "step": index, "turn": turns, "events": event_stats, "elapsed_ms": started.elapsed().as_millis(), "checkpoint_bytes": saved.as_ref().map_or(0, json_bytes), "metrics": state.metrics}));
        }
        Ok::<_, anyhow::Error>(())
    }).await;
    // Always stop the actor, including assertion failures and deadlines.
    tokio::time::timeout(Duration::from_secs(20), agent.shutdown())
        .await
        .context("shutdown deadline exceeded")?;
    tokio::time::timeout(Duration::from_secs(2), async {
        while runtime_metrics.num_alive_tasks() > baseline_tasks {
            tokio::task::yield_now().await;
        }
    })
    .await
    .context("scenario leaked background tasks after shutdown")?;
    result.context("scenario deadline exceeded")??;
    eprintln!(
        "SESSION_RESULT {}",
        serde_json::json!({"scenario":scenario.name,"status":"passed","elapsed_ms":started.elapsed().as_millis(),"background_tasks":runtime_metrics.num_alive_tasks()})
    );
    Ok(())
}

#[tokio::test]
#[ignore = "load MAESTRO_SESSION_SCENARIO for a manual lifecycle run"]
async fn load_session_scenario() {
    let path = std::env::var("MAESTRO_SESSION_SCENARIO")
        .expect("set MAESTRO_SESSION_SCENARIO to a JSON fixture");
    run(load(Path::new(&path)).unwrap()).await.unwrap();
}

#[tokio::test]
async fn session_lifecycle_fixture() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/session-scenarios/lifecycle.json");
    run(load(&path).unwrap()).await.unwrap();
}

#[tokio::test]
async fn interrupted_turns_remain_within_context_window() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/session-scenarios/interrupted-turns.json");
    run(load(&path).unwrap()).await.unwrap();
}

#[test]
fn session_scenarios_reject_invalid_contracts() {
    let valid = serde_json::json!({"schema":SCHEMA,"name":"validation","context_window":4096,"steps":[{"action":"assert","bounds":{"messages":{"max":0}}}]});
    for (field, value) in [
        ("schema", serde_json::json!("v2")),
        ("context_window", serde_json::json!(0)),
        ("steps", serde_json::json!([])),
    ] {
        let mut input = valid.clone();
        input[field] = value;
        assert!(validate(&serde_json::from_value(input).unwrap()).is_err());
    }
    for steps in [
        serde_json::json!([{"action":"restore"}]),
        serde_json::json!([{"action":"assert","bounds":{"typo":{"max":0}}}]),
        serde_json::json!([{"action":"assert","bounds":{"messages":{"min":2,"max":1}}}]),
        serde_json::json!([{"action":"turns","count":100001,"prompt_bytes":32,"response_bytes":1}]),
    ] {
        let mut input = valid.clone();
        input["steps"] = steps;
        assert!(validate(&serde_json::from_value(input).unwrap()).is_err());
    }
    let mut input = valid;
    input["typo"] = serde_json::json!(true);
    assert!(serde_json::from_value::<Scenario>(input).is_err());
}
