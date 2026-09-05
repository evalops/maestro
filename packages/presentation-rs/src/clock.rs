//! An explicit clock for presentation; previews never wait for wall time.
use maestro_interaction::Reaction;
use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
pub enum ViewClock {
    Live(Instant),
    Fixed(Duration),
}
impl Default for ViewClock {
    fn default() -> Self {
        Self::Live(Instant::now())
    }
}
impl ViewClock {
    pub fn now(&self) -> Duration {
        match self {
            Self::Live(origin) => origin.elapsed(),
            Self::Fixed(now) => *now,
        }
    }
}
/// Shared reaction timing for production and component previews.
pub fn pet_frame(reaction: &Reaction, now: Duration) -> Option<u64> {
    reaction.frame(now, Duration::from_millis(100), Duration::from_millis(900))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reaction_boundaries_use_supplied_time() {
        let mut reaction = Reaction::default();
        reaction.start(Duration::ZERO);
        for (ms, expected) in [
            (0, Some(0)),
            (400, Some(4)),
            (650, Some(6)),
            (899, Some(8)),
            (900, None),
        ] {
            let clock = ViewClock::Fixed(Duration::from_millis(ms));
            assert_eq!(pet_frame(&reaction, clock.now()), expected);
        }
    }
}
