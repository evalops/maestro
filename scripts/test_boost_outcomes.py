import unittest
from boost_outcomes import summarize


class BoostOutcomesTest(unittest.TestCase):
    def test_missing_cost_and_legacy_records_do_not_become_zero_cost_controls(self):
        base = {"type": "canonical-turn", "model_provider": "test", "status": "success", "total_duration_ms": 10,
                "boost_suggested": False, "boost_requested": False, "boost_applied": False}
        result = summarize([
            {"type": "canonical-turn", "cost_usd": 0},
            dict(base, cost_usd=0),
            dict(base, boost_applied=True, reported_cost_usd=0.02),
            dict(base, boost_applied=True, status="error", reported_cost_usd=None),
        ])
        self.assertEqual(result["excluded_legacy_turns"], 1)
        boosted, ordinary = result["cohorts"]
        self.assertEqual(boosted["runtime_completion_rate"], 0.5)
        self.assertEqual(boosted["cost_coverage"], 0.5)
        self.assertEqual(boosted["mean_reported_cost_usd"], 0.02)
        self.assertIsNone(ordinary["mean_reported_cost_usd"])

    def test_suggested_unboosted_is_separate_and_real_zero_is_preserved(self):
        result = summarize([{"type": "canonical-turn", "boost_applied": False, "boost_requested": False,
                             "boost_suggested": True, "reported_cost_usd": 0, "status": "error"}])
        self.assertEqual(result["cohorts"][0]["cohort"], "suggested_unboosted")
        self.assertEqual(result["cohorts"][0]["mean_reported_cost_usd"], 0)


if __name__ == "__main__":
    unittest.main()
