#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct MessageLayoutKey(u64);

impl MessageLayoutKey {
    pub(crate) const fn new(value: u64) -> Self {
        Self(value)
    }
}

#[derive(Clone, Copy, Debug)]
struct CachedEntry {
    key: MessageLayoutKey,
    height: usize,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct MessageLayout {
    heights: Vec<usize>,
    cumulative_bottoms: Vec<usize>,
}

impl MessageLayout {
    pub(crate) fn heights(&self) -> &[usize] {
        &self.heights
    }

    pub(crate) fn total_height(&self) -> usize {
        self.cumulative_bottoms.last().copied().unwrap_or_default()
    }

    pub(crate) fn first_visible(&self, window_top: usize) -> usize {
        self.cumulative_bottoms
            .partition_point(|bottom| *bottom <= window_top)
    }
}

#[derive(Debug, Default)]
pub(crate) struct MessageLayoutCache {
    width: Option<u16>,
    settings_key: u64,
    entries: Vec<CachedEntry>,
    #[cfg(test)]
    measurements: usize,
}

impl MessageLayoutCache {
    pub(crate) fn prepare<F>(
        &mut self,
        width: u16,
        settings_key: u64,
        keys: &[MessageLayoutKey],
        mut measure: F,
    ) -> MessageLayout
    where
        F: FnMut(usize) -> usize,
    {
        if self.width != Some(width) || self.settings_key != settings_key {
            self.entries.clear();
            self.width = Some(width);
            self.settings_key = settings_key;
        }

        for (index, key) in keys.iter().copied().enumerate() {
            if self
                .entries
                .get(index)
                .is_some_and(|entry| entry.key == key)
            {
                continue;
            }

            #[cfg(test)]
            {
                self.measurements += 1;
            }
            let entry = CachedEntry {
                key,
                height: measure(index),
            };
            if let Some(cached) = self.entries.get_mut(index) {
                *cached = entry;
            } else {
                self.entries.push(entry);
            }
        }
        self.entries.truncate(keys.len());

        let heights = self
            .entries
            .iter()
            .map(|entry| entry.height)
            .collect::<Vec<_>>();
        let mut total = 0usize;
        let cumulative_bottoms = heights
            .iter()
            .map(|height| {
                total = total.saturating_add(*height);
                total
            })
            .collect();

        MessageLayout {
            heights,
            cumulative_bottoms,
        }
    }

    #[cfg(test)]
    pub(crate) const fn measurements(&self) -> usize {
        self.measurements
    }
}

#[cfg(test)]
mod tests {
    use super::{MessageLayoutCache, MessageLayoutKey};

    fn key(value: u64) -> MessageLayoutKey {
        MessageLayoutKey::new(value)
    }

    #[test]
    fn reuses_unchanged_heights_and_remeasures_one_changed_entry() {
        let mut cache = MessageLayoutCache::default();
        let mut measurements = 0;
        let initial = cache.prepare(80, 0, &[key(1), key(2), key(3)], |_| {
            measurements += 1;
            10
        });
        assert_eq!(initial.heights(), &[10, 10, 10]);
        assert_eq!(measurements, 3);

        cache.prepare(80, 0, &[key(1), key(2), key(3)], |_| {
            measurements += 1;
            99
        });
        assert_eq!(measurements, 3);

        let updated = cache.prepare(80, 0, &[key(1), key(20), key(3)], |index| {
            measurements += 1;
            20 + index
        });
        assert_eq!(updated.heights(), &[10, 21, 10]);
        assert_eq!(measurements, 4);
    }

    #[test]
    fn append_measures_only_the_new_suffix() {
        let mut cache = MessageLayoutCache::default();
        cache.prepare(80, 0, &[key(1), key(2)], |_| 5);

        let mut measured = Vec::new();
        let layout = cache.prepare(80, 0, &[key(1), key(2), key(3), key(4)], |index| {
            measured.push(index);
            index + 1
        });

        assert_eq!(measured, vec![2, 3]);
        assert_eq!(layout.heights(), &[5, 5, 3, 4]);
    }

    #[test]
    fn width_and_settings_changes_invalidate_all_heights() {
        let mut cache = MessageLayoutCache::default();
        cache.prepare(80, 0, &[key(1), key(2)], |_| 5);

        let mut width_measurements = 0;
        cache.prepare(81, 0, &[key(1), key(2)], |_| {
            width_measurements += 1;
            6
        });
        assert_eq!(width_measurements, 2);

        let mut settings_measurements = 0;
        cache.prepare(81, 1, &[key(1), key(2)], |_| {
            settings_measurements += 1;
            7
        });
        assert_eq!(settings_measurements, 2);
    }

    #[test]
    fn cumulative_bottoms_find_the_first_visible_entry() {
        let mut cache = MessageLayoutCache::default();
        let layout = cache.prepare(80, 0, &[key(1), key(2), key(3)], |index| [3, 5, 7][index]);

        assert_eq!(layout.total_height(), 15);
        assert_eq!(layout.first_visible(0), 0);
        assert_eq!(layout.first_visible(2), 0);
        assert_eq!(layout.first_visible(3), 1);
        assert_eq!(layout.first_visible(7), 1);
        assert_eq!(layout.first_visible(8), 2);
        assert_eq!(layout.first_visible(15), 3);
    }

    #[test]
    fn totals_larger_than_u16_do_not_overflow() {
        let mut cache = MessageLayoutCache::default();
        let keys = (0..1_000).map(key).collect::<Vec<_>>();
        let layout = cache.prepare(80, 0, &keys, |_| 100);

        assert_eq!(layout.total_height(), 100_000);
        assert_eq!(layout.first_visible(99_950), 999);
    }
}
