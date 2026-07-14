import unittest
from pathlib import Path
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from HelixIntradayStrategy import HelixIntradayStrategy


STRUCTURE_COLUMNS = [
    "latest_swing_high",
    "latest_swing_low",
    "structure_high",
    "structure_low",
    "divergence_event",
    "pa_market_cycle",
    "pa_always_in",
    "pa_setup_event",
    "pa_setup_recent",
]


def market_frame(length=80):
    index = np.arange(length, dtype=float)
    center = 100 + index * 0.04 + np.sin(index / 2.7) * 2.5
    return pd.DataFrame({
        "high": center + 0.8 + np.sin(index / 5) * 0.2,
        "low": center - 0.8 - np.cos(index / 4) * 0.2,
        "close": center + np.sin(index / 3) * 0.25,
        "macdhist": np.sin(index / 4.5),
    })


def hypothesis_frame(setup=1, selected_rsi=60.0, hourly_rsi=60.0):
    frame = pd.DataFrame({
        "close": [100.0, 100.5, 102.0],
        "volume": [100.0, 100.0, 100.0],
        "pa_market_cycle_1h": [2, 2, 2],
        "pa_always_in_1h": [1, 1, 1],
        "close_1h": [100.0, 100.5, 102.0],
        "ema20_1h": [99.5, 99.8, 100.0],
        "ema20_slope_atr_1h": [0.1, 0.1, 0.1],
        "rsi_1h": [hourly_rsi, hourly_rsi, hourly_rsi],
    })
    for suffix in ("", "_15m"):
        frame[f"pa_setup_recent{suffix}"] = [setup, setup, setup]
        frame[f"pa_setup_age{suffix}"] = [0, 0, 0]
        frame[f"pa_setup_quality{suffix}"] = [2, 2, 2]
        frame[f"pa_signal_high{suffix}"] = [101.0, 101.0, 101.0]
        frame[f"pa_signal_low{suffix}"] = [99.5, 99.5, 99.5]
        frame[f"pa_invalidation{suffix}"] = [99.5, 99.5, 99.5]
        frame[f"atr{suffix}"] = [1.0, 1.0, 1.0]
        frame[f"close{suffix}"] = frame["close"]
        frame[f"ema20{suffix}"] = [99.8, 100.0, 100.5]
        frame[f"ema20_slope_atr{suffix}"] = [0.1, 0.1, 0.1]
        frame[f"rsi{suffix}"] = [selected_rsi, selected_rsi, selected_rsi]
        frame[f"macdhist{suffix}"] = [-0.2, -0.1, 0.1]
        frame[f"divergence_recent{suffix}"] = [0, 0, 0]
        frame[f"divergence_age{suffix}"] = [999, 999, 999]
    return frame


class CausalMarketStructureTests(unittest.TestCase):
    def test_results_are_unchanged_when_future_bars_are_appended(self):
        source = market_frame()
        complete = source.copy()
        HelixIntradayStrategy._add_causal_market_structure(complete, 1e-8)

        for length in range(5, len(source) + 1):
            prefix = source.iloc[:length].copy()
            HelixIntradayStrategy._add_causal_market_structure(prefix, 1e-8)
            for column in STRUCTURE_COLUMNS:
                expected = complete[column].iloc[length - 1]
                actual = prefix[column].iloc[-1]
                if pd.isna(expected):
                    self.assertTrue(pd.isna(actual), f"{column} at prefix {length}")
                else:
                    self.assertEqual(actual, expected, f"{column} at prefix {length}")

    def test_swing_is_emitted_only_after_two_right_bars_close(self):
        source = pd.DataFrame({
            "high": [1.0, 2.0, 5.0, 2.0, 1.0],
            "low": [0.0, 0.5, 1.0, 0.5, 0.0],
            "close": [0.5, 1.5, 4.0, 1.5, 0.5],
            "macdhist": [0.1, 0.2, 0.3, 0.2, 0.1],
        })
        before_confirmation = source.iloc[:4].copy()
        HelixIntradayStrategy._add_causal_market_structure(before_confirmation, 1e-8)
        self.assertTrue(pd.isna(before_confirmation["latest_swing_high"].iloc[-1]))

        after_confirmation = source.copy()
        HelixIntradayStrategy._add_causal_market_structure(after_confirmation, 1e-8)
        self.assertEqual(after_confirmation["latest_swing_high"].iloc[-1], 5.0)


class HypothesisGateTests(unittest.TestCase):
    def setUp(self):
        self.strategy = object.__new__(HelixIntradayStrategy)
        self.strategy.dp = None
        self.metadata = {"pair": "BTC/USDT:USDT"}

    def test_indicators_cannot_create_an_entry_without_a_pa_setup(self):
        frame = hypothesis_frame(setup=0)
        result = self.strategy._build_signal_columns(frame, self.metadata)
        self.assertFalse(result["helix_long_armed"].any())
        self.assertFalse(result["helix_long_entry"].any())

    def test_rsi_control_failure_keeps_the_hypothesis_unarmed(self):
        frame = hypothesis_frame(selected_rsi=40.0, hourly_rsi=40.0)
        result = self.strategy._build_signal_columns(frame, self.metadata)
        self.assertFalse(result["helix_long_armed"].any())
        self.assertFalse(result["helix_long_entry"].any())

    def test_entry_waits_for_a_closed_bar_beyond_the_signal_bar(self):
        frame = hypothesis_frame()
        result = self.strategy._build_signal_columns(frame, self.metadata)
        self.assertFalse(result["helix_long_armed"].iloc[0])
        self.assertFalse(result["helix_long_armed"].iloc[:2].any())
        self.assertTrue(result["helix_long_armed"].iloc[2])
        self.assertFalse(result["helix_long_entry"].iloc[0])
        self.assertFalse(result["helix_long_entry"].iloc[1])
        self.assertTrue(result["helix_long_entry"].iloc[2])


class HardRiskRuleTests(unittest.TestCase):
    def test_daily_loss_uses_start_of_day_equity(self):
        self.assertTrue(HelixIntradayStrategy._daily_loss_breached(980.0, -20.0))
        self.assertFalse(HelixIntradayStrategy._daily_loss_breached(981.0, -19.0))

    def test_loss_streak_requires_three_most_recent_losses(self):
        self.assertTrue(HelixIntradayStrategy._has_consecutive_losses([-1.0, -0.5, -2.0]))
        self.assertFalse(HelixIntradayStrategy._has_consecutive_losses([-1.0, 0.1, -2.0]))
        self.assertFalse(HelixIntradayStrategy._has_consecutive_losses([-1.0, -0.5]))

    def test_position_size_is_capped_at_half_percent_risk(self):
        stake = HelixIntradayStrategy._risk_capped_stake(
            wallet=1000.0,
            current_rate=100.0,
            stop=99.0,
            leverage=1.0,
            proposed_stake=1000.0,
            min_stake=10.0,
            max_stake=1000.0,
        )
        self.assertAlmostEqual(stake, 500.0)
        self.assertAlmostEqual(stake * 0.01, 1000.0 * HelixIntradayStrategy.RISK_PER_TRADE)

    def test_trade_is_rejected_when_exchange_minimum_exceeds_risk_budget(self):
        stake = HelixIntradayStrategy._risk_capped_stake(
            wallet=1000.0,
            current_rate=100.0,
            stop=99.0,
            leverage=1.0,
            proposed_stake=1000.0,
            min_stake=600.0,
            max_stake=1000.0,
        )
        self.assertEqual(stake, 0.0)

    def test_trade_is_rejected_without_a_valid_structural_stop(self):
        stake = HelixIntradayStrategy._risk_capped_stake(
            wallet=1000.0,
            current_rate=100.0,
            stop=float("nan"),
            leverage=1.0,
            proposed_stake=1000.0,
            min_stake=10.0,
            max_stake=1000.0,
        )
        self.assertEqual(stake, 0.0)


if __name__ == "__main__":
    unittest.main()
