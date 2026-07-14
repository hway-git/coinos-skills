from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd
from pandas import DataFrame, Series
import talib.abstract as ta

from freqtrade.persistence import PairLocks, Trade
from freqtrade.strategy import IStrategy, informative, stoploss_from_absolute


class HelixIntradayStrategy(IStrategy):
    """Brooks-style PA expectations with indicator evidence and hard risk limits."""

    INTERFACE_VERSION = 3

    timeframe = "5m"
    can_short = True
    process_only_new_candles = True
    startup_candle_count = 300

    minimal_roi = {"0": 100.0}
    stoploss = -0.05
    use_custom_stoploss = True
    trailing_stop = False
    use_exit_signal = True
    exit_profit_only = False
    ignore_roi_if_entry_signal = False

    CYCLE_TREND = 1
    CYCLE_CHANNEL = 2
    CYCLE_RANGE = 3
    CYCLE_BREAKOUT_MODE = 4

    SETUP_H2_L2 = 1
    SETUP_BREAKOUT_PULLBACK = 2
    SETUP_FAILED_BREAKOUT = 3

    EXPECTATION_SECOND_LEG = 1
    EXPECTATION_CONTINUATION = 2
    EXPECTATION_RANGE_ROTATION = 3

    SETUP_MAX_AGE = 2
    MIN_CONFIDENCE = 70
    MIN_STOP_DISTANCE_ATR = 1.0
    MAX_STOP_DISTANCE_ATR = 3.0
    MAX_ENTRY_DRIFT_ATR = 1.0
    BREAK_EVEN_TRIGGER_R = 1.0
    PROFIT_TARGET_R = 2.0
    BREAK_EVEN_FEE_BUFFER = 0.001
    RISK_PER_TRADE = 0.005
    MAX_LEVERAGE = 1.0
    DAILY_LOSS_LIMIT = 0.02
    MAX_PORTFOLIO_DRAWDOWN = 0.08
    CONSECUTIVE_LOSS_LIMIT = 3
    CONSECUTIVE_LOSS_PAUSE = timedelta(hours=6)
    MAX_CANDLE_AGE = timedelta(minutes=10)

    protections = [
        {"method": "CooldownPeriod", "stop_duration_candles": 3},
        {
            "method": "MaxDrawdown",
            "lookback_period_candles": 30 * 24 * 12,
            "trade_limit": 3,
            "stop_duration_candles": 24 * 12,
            "max_allowed_drawdown": MAX_PORTFOLIO_DRAWDOWN,
            "calculation_mode": "equity",
        },
    ]

    def _tick_size(self, pair: str, fallback_price: float) -> float:
        try:
            market = self.dp.market(pair) if self.dp else None
            precision = float((market or {}).get("precision", {}).get("price", 0))
            if np.isfinite(precision) and precision > 0:
                return precision
        except (TypeError, ValueError):
            pass
        return max(abs(fallback_price) * 1e-8, 1e-12)

    @staticmethod
    def _add_bar_features(dataframe: DataFrame) -> None:
        bar_range = (dataframe["high"] - dataframe["low"]).clip(lower=0)
        safe_range = bar_range.replace(0, np.nan)
        body = (dataframe["close"] - dataframe["open"]).abs()
        dataframe["bar_range"] = bar_range
        dataframe["body_ratio"] = (body / safe_range).fillna(0)
        dataframe["close_location"] = ((dataframe["close"] - dataframe["low"]) / safe_range).fillna(0.5)
        dataframe["top_tail_ratio"] = (
            (dataframe["high"] - dataframe[["open", "close"]].max(axis=1)) / safe_range
        ).fillna(0)
        dataframe["bottom_tail_ratio"] = (
            (dataframe[["open", "close"]].min(axis=1) - dataframe["low"]) / safe_range
        ).fillna(0)
        dataframe["inside_bar"] = (
            (dataframe["high"] <= dataframe["high"].shift(1))
            & (dataframe["low"] >= dataframe["low"].shift(1))
        )
        dataframe["outside_bar"] = (
            (dataframe["high"] >= dataframe["high"].shift(1))
            & (dataframe["low"] <= dataframe["low"].shift(1))
        )
        overlap = (
            np.minimum(dataframe["high"], dataframe["high"].shift(1))
            - np.maximum(dataframe["low"], dataframe["low"].shift(1))
        ).clip(lower=0)
        dataframe["overlap_ratio"] = (overlap / safe_range).fillna(0)
        reasonable_size = bar_range <= dataframe["atr"] * 1.8
        dataframe["bull_signal_quality"] = np.select(
            [
                (dataframe["close"] > dataframe["open"])
                & (dataframe["body_ratio"] >= 0.55)
                & (dataframe["close_location"] >= 0.75)
                & reasonable_size,
                (dataframe["close"] > dataframe["open"])
                & (dataframe["body_ratio"] >= 0.30)
                & (dataframe["close_location"] >= 0.60)
                & (bar_range <= dataframe["atr"] * 2.0),
            ],
            [2, 1],
            default=0,
        )
        dataframe["bear_signal_quality"] = np.select(
            [
                (dataframe["close"] < dataframe["open"])
                & (dataframe["body_ratio"] >= 0.55)
                & (dataframe["close_location"] <= 0.25)
                & reasonable_size,
                (dataframe["close"] < dataframe["open"])
                & (dataframe["body_ratio"] >= 0.30)
                & (dataframe["close_location"] <= 0.40)
                & (bar_range <= dataframe["atr"] * 2.0),
            ],
            [2, 1],
            default=0,
        )

    @classmethod
    def _add_brooks_price_action(cls, dataframe: DataFrame, epsilon: float) -> None:
        length = len(dataframe)
        high = dataframe["high"].to_numpy(dtype=float)
        low = dataframe["low"].to_numpy(dtype=float)
        open_ = dataframe["open"].to_numpy(dtype=float)
        close = dataframe["close"].to_numpy(dtype=float)
        atr = dataframe["atr"].replace(0, np.nan).to_numpy(dtype=float)
        macd_hist = dataframe["macdhist"].to_numpy(dtype=float)
        rsi = dataframe["rsi"].to_numpy(dtype=float)
        bull_quality = dataframe["bull_signal_quality"].to_numpy(dtype=int)
        bear_quality = dataframe["bear_signal_quality"].to_numpy(dtype=int)

        latest_high_values = np.full(length, np.nan)
        latest_low_values = np.full(length, np.nan)
        high_relations = np.zeros(length, dtype=int)
        low_relations = np.zeros(length, dtype=int)
        divergence_events = np.zeros(length, dtype=int)
        divergence_types = np.zeros(length, dtype=int)
        breakout_events = np.zeros(length, dtype=int)
        follow_through = np.zeros(length, dtype=int)
        failed_breakouts = np.zeros(length, dtype=int)
        market_cycle = np.full(length, cls.CYCLE_RANGE, dtype=int)
        market_direction = np.zeros(length, dtype=int)
        always_in = np.zeros(length, dtype=int)
        setup_events = np.zeros(length, dtype=int)
        setup_quality = np.zeros(length, dtype=int)
        expectation_types = np.zeros(length, dtype=int)
        invalidation = np.full(length, np.nan)

        prior_high = dataframe["high"].shift(1).rolling(20, min_periods=10).max().to_numpy(dtype=float)
        prior_low = dataframe["low"].shift(1).rolling(20, min_periods=10).min().to_numpy(dtype=float)
        overlap_mean = dataframe["overlap_ratio"].rolling(10, min_periods=5).mean().fillna(0).to_numpy(dtype=float)
        atr_baseline = dataframe["atr"].rolling(50, min_periods=20).mean().to_numpy(dtype=float)
        progress = ((dataframe["close"] - dataframe["close"].shift(10)) / dataframe["atr"].replace(0, np.nan)).fillna(0).to_numpy(dtype=float)

        latest_high = None
        previous_high = None
        latest_low = None
        previous_low = None
        high_relation = 0
        low_relation = 0
        current_always_in = 0
        active_breakout = None

        bull_pullback = False
        bull_attempts = 0
        bull_pullback_low = np.nan
        bull_last_attempt = -10
        bear_pullback = False
        bear_attempts = 0
        bear_pullback_high = np.nan
        bear_last_attempt = -10
        previous_context = 0

        for index in range(length):
            candidate = index - 2
            if candidate >= 2:
                neighbors = [cursor for cursor in range(candidate - 2, candidate + 3) if cursor != candidate]
                is_high = all(high[candidate] > high[cursor] for cursor in neighbors)
                is_low = all(low[candidate] < low[cursor] for cursor in neighbors)

                if is_high:
                    previous_high = latest_high
                    latest_high = (high[candidate], macd_hist[candidate], rsi[candidate])
                    if previous_high is not None:
                        high_relation = 1 if latest_high[0] > previous_high[0] + epsilon else -1 if latest_high[0] < previous_high[0] - epsilon else 0
                        regular = high_relation == 1 and (
                            latest_high[1] < previous_high[1] or latest_high[2] < previous_high[2]
                        )
                        hidden = high_relation == -1 and (
                            latest_high[1] > previous_high[1] or latest_high[2] > previous_high[2]
                        )
                        if regular or hidden:
                            divergence_events[index] = -1
                            divergence_types[index] = 1 if regular else 2

                if is_low:
                    previous_low = latest_low
                    latest_low = (low[candidate], macd_hist[candidate], rsi[candidate])
                    if previous_low is not None:
                        low_relation = 1 if latest_low[0] > previous_low[0] + epsilon else -1 if latest_low[0] < previous_low[0] - epsilon else 0
                        regular = low_relation == -1 and (
                            latest_low[1] > previous_low[1] or latest_low[2] > previous_low[2]
                        )
                        hidden = low_relation == 1 and (
                            latest_low[1] < previous_low[1] or latest_low[2] < previous_low[2]
                        )
                        if regular or hidden:
                            divergence_events[index] = 1
                            divergence_types[index] = 1 if regular else 2

            latest_high_values[index] = latest_high[0] if latest_high else np.nan
            latest_low_values[index] = latest_low[0] if latest_low else np.nan
            high_relations[index] = high_relation
            low_relations[index] = low_relation

            current_atr = atr[index] if np.isfinite(atr[index]) and atr[index] > 0 else max(abs(close[index]) * 1e-6, epsilon)
            bull_breakout = bool(
                np.isfinite(prior_high[index])
                and close[index] > prior_high[index] + current_atr * 0.10
                and bull_quality[index] == 2
            )
            bear_breakout = bool(
                np.isfinite(prior_low[index])
                and close[index] < prior_low[index] - current_atr * 0.10
                and bear_quality[index] == 2
            )
            if bull_breakout and not bear_breakout:
                breakout_events[index] = 1
            elif bear_breakout and not bull_breakout:
                breakout_events[index] = -1

            structure_direction = 1 if high_relation == 1 and low_relation >= 0 else -1 if high_relation <= 0 and low_relation == -1 else 0
            directional_progress = 1 if progress[index] >= 1.0 else -1 if progress[index] <= -1.0 else 0
            direction = structure_direction or directional_progress
            contraction = (
                index >= 20
                and np.isfinite(atr_baseline[index])
                and current_atr <= atr_baseline[index] * 0.75
                and overlap_mean[index] >= 0.55
            )
            if breakout_events[index]:
                cycle = cls.CYCLE_TREND
                direction = breakout_events[index]
            elif contraction:
                cycle = cls.CYCLE_BREAKOUT_MODE
                direction = 0
            elif structure_direction and abs(progress[index]) >= 2.0 and overlap_mean[index] <= 0.45:
                cycle = cls.CYCLE_TREND
            elif direction and abs(progress[index]) >= 0.8 and overlap_mean[index] < 0.65:
                cycle = cls.CYCLE_CHANNEL
            else:
                cycle = cls.CYCLE_RANGE
                if abs(progress[index]) < 0.75:
                    direction = 0

            market_cycle[index] = cycle
            market_direction[index] = direction
            if breakout_events[index]:
                current_always_in = breakout_events[index]
            elif structure_direction:
                current_always_in = structure_direction
            elif cycle == cls.CYCLE_RANGE and direction == 0:
                current_always_in = 0
            always_in[index] = current_always_in

            if breakout_events[index]:
                active_breakout = {
                    "direction": breakout_events[index],
                    "level": prior_high[index] if breakout_events[index] == 1 else prior_low[index],
                    "index": index,
                    "close": close[index],
                    "followed": False,
                    "origin_cycle": market_cycle[index - 1] if index > 0 else cls.CYCLE_RANGE,
                }
            elif active_breakout is not None:
                age = index - active_breakout["index"]
                breakout_direction = active_breakout["direction"]
                level = active_breakout["level"]
                if age > 10:
                    active_breakout = None
                elif breakout_direction == 1:
                    if not active_breakout["followed"] and close[index] > active_breakout["close"] and bull_quality[index] == 2:
                        active_breakout["followed"] = True
                        follow_through[index] = 1
                    elif not active_breakout["followed"] and age <= 3 and close[index] < level - current_atr * 0.25 and bear_quality[index] == 2:
                        failed_breakouts[index] = -1
                        if active_breakout["origin_cycle"] in (cls.CYCLE_RANGE, cls.CYCLE_BREAKOUT_MODE):
                            setup_events[index] = -cls.SETUP_FAILED_BREAKOUT
                            setup_quality[index] = bear_quality[index]
                            expectation_types[index] = cls.EXPECTATION_RANGE_ROTATION
                            invalidation[index] = high[index]
                        active_breakout = None
                    elif active_breakout["followed"] and low[index] <= level + current_atr * 0.25 and close[index] > level and bull_quality[index] == 2:
                        setup_events[index] = cls.SETUP_BREAKOUT_PULLBACK
                        setup_quality[index] = bull_quality[index]
                        expectation_types[index] = cls.EXPECTATION_CONTINUATION
                        invalidation[index] = min(low[index], level)
                        active_breakout = None
                else:
                    if not active_breakout["followed"] and close[index] < active_breakout["close"] and bear_quality[index] == 2:
                        active_breakout["followed"] = True
                        follow_through[index] = -1
                    elif not active_breakout["followed"] and age <= 3 and close[index] > level + current_atr * 0.25 and bull_quality[index] == 2:
                        failed_breakouts[index] = 1
                        if active_breakout["origin_cycle"] in (cls.CYCLE_RANGE, cls.CYCLE_BREAKOUT_MODE):
                            setup_events[index] = cls.SETUP_FAILED_BREAKOUT
                            setup_quality[index] = bull_quality[index]
                            expectation_types[index] = cls.EXPECTATION_RANGE_ROTATION
                            invalidation[index] = low[index]
                        active_breakout = None
                    elif active_breakout["followed"] and high[index] >= level - current_atr * 0.25 and close[index] < level and bear_quality[index] == 2:
                        setup_events[index] = -cls.SETUP_BREAKOUT_PULLBACK
                        setup_quality[index] = bear_quality[index]
                        expectation_types[index] = cls.EXPECTATION_CONTINUATION
                        invalidation[index] = max(high[index], level)
                        active_breakout = None

            context = current_always_in if cycle in (cls.CYCLE_TREND, cls.CYCLE_CHANNEL) else 0
            if context != previous_context:
                bull_pullback = False
                bull_attempts = 0
                bear_pullback = False
                bear_attempts = 0
                previous_context = context

            if context == 1 and index > 0:
                if breakout_events[index] == 1:
                    bull_pullback = False
                    bull_attempts = 0
                if close[index] < open_[index] or low[index] < low[index - 1]:
                    bull_pullback = True
                    bull_pullback_low = low[index] if not np.isfinite(bull_pullback_low) else min(bull_pullback_low, low[index])
                continuation_attempt = (
                    bull_pullback
                    and bull_quality[index] >= 1
                    and high[index] > high[index - 1] + epsilon
                    and index - bull_last_attempt > 1
                )
                if continuation_attempt:
                    bull_attempts += 1
                    bull_last_attempt = index
                    bull_pullback = False
                    if bull_attempts >= 2 and setup_events[index] == 0:
                        setup_events[index] = cls.SETUP_H2_L2
                        setup_quality[index] = 2 if bull_quality[index] == 2 else 1
                        expectation_types[index] = cls.EXPECTATION_SECOND_LEG
                        invalidation[index] = bull_pullback_low
                if latest_high and close[index] > latest_high[0] + current_atr * 0.10:
                    bull_attempts = 0
                    bull_pullback_low = np.nan

            elif context == -1 and index > 0:
                if breakout_events[index] == -1:
                    bear_pullback = False
                    bear_attempts = 0
                if close[index] > open_[index] or high[index] > high[index - 1]:
                    bear_pullback = True
                    bear_pullback_high = high[index] if not np.isfinite(bear_pullback_high) else max(bear_pullback_high, high[index])
                continuation_attempt = (
                    bear_pullback
                    and bear_quality[index] >= 1
                    and low[index] < low[index - 1] - epsilon
                    and index - bear_last_attempt > 1
                )
                if continuation_attempt:
                    bear_attempts += 1
                    bear_last_attempt = index
                    bear_pullback = False
                    if bear_attempts >= 2 and setup_events[index] == 0:
                        setup_events[index] = -cls.SETUP_H2_L2
                        setup_quality[index] = 2 if bear_quality[index] == 2 else 1
                        expectation_types[index] = cls.EXPECTATION_SECOND_LEG
                        invalidation[index] = bear_pullback_high
                if latest_low and close[index] < latest_low[0] - current_atr * 0.10:
                    bear_attempts = 0
                    bear_pullback_high = np.nan

        divergence_recent = np.zeros(length, dtype=int)
        divergence_age = np.full(length, 999, dtype=int)
        last_divergence = 0
        last_divergence_index = -1
        for index, event in enumerate(divergence_events):
            if event:
                last_divergence = event
                last_divergence_index = index
            age = index - last_divergence_index
            if last_divergence_index >= 0 and age <= 6:
                divergence_recent[index] = last_divergence
                divergence_age[index] = age

        dataframe["latest_swing_high"] = latest_high_values
        dataframe["latest_swing_low"] = latest_low_values
        dataframe["structure_high"] = high_relations
        dataframe["structure_low"] = low_relations
        dataframe["divergence_event"] = divergence_events
        dataframe["divergence_type"] = divergence_types
        dataframe["divergence_recent"] = divergence_recent
        dataframe["divergence_age"] = divergence_age
        dataframe["pa_breakout_event"] = breakout_events
        dataframe["pa_follow_through"] = follow_through
        dataframe["pa_failed_breakout"] = failed_breakouts
        dataframe["pa_market_cycle"] = market_cycle
        dataframe["pa_direction"] = market_direction
        dataframe["pa_always_in"] = always_in
        dataframe["pa_setup_event"] = setup_events
        dataframe["pa_setup_quality_event"] = setup_quality
        dataframe["pa_expectation_event"] = expectation_types
        dataframe["pa_invalidation_event"] = invalidation

    @classmethod
    def _carry_setups(cls, dataframe: DataFrame) -> None:
        events = dataframe["pa_setup_event"].fillna(0).to_numpy(dtype=int)
        quality_events = dataframe["pa_setup_quality_event"].fillna(0).to_numpy(dtype=int)
        expectation_events = dataframe["pa_expectation_event"].fillna(0).to_numpy(dtype=int)
        invalidation_events = dataframe["pa_invalidation_event"].to_numpy(dtype=float)
        high = dataframe["high"].to_numpy(dtype=float)
        low = dataframe["low"].to_numpy(dtype=float)
        close = dataframe["close"].to_numpy(dtype=float)

        recent = np.zeros(len(dataframe), dtype=int)
        ages = np.full(len(dataframe), 999, dtype=int)
        qualities = np.zeros(len(dataframe), dtype=int)
        expectations = np.zeros(len(dataframe), dtype=int)
        signal_highs = np.full(len(dataframe), np.nan)
        signal_lows = np.full(len(dataframe), np.nan)
        invalidations = np.full(len(dataframe), np.nan)

        current = 0
        current_index = -1
        current_quality = 0
        current_expectation = 0
        current_high = np.nan
        current_low = np.nan
        current_invalidation = np.nan
        for index, event in enumerate(events):
            if event:
                current = event
                current_index = index
                current_quality = quality_events[index]
                current_expectation = expectation_events[index]
                current_high = high[index]
                current_low = low[index]
                current_invalidation = invalidation_events[index]

            age = index - current_index
            invalidated = current > 0 and np.isfinite(current_invalidation) and close[index] <= current_invalidation
            invalidated = invalidated or (
                current < 0 and np.isfinite(current_invalidation) and close[index] >= current_invalidation
            )
            if current_index < 0 or age > cls.SETUP_MAX_AGE or invalidated:
                current = 0
                continue

            recent[index] = current
            ages[index] = age
            qualities[index] = current_quality
            expectations[index] = current_expectation
            signal_highs[index] = current_high
            signal_lows[index] = current_low
            invalidations[index] = current_invalidation

        dataframe["pa_setup_recent"] = recent
        dataframe["pa_setup_age"] = ages
        dataframe["pa_setup_quality"] = qualities
        dataframe["pa_expectation"] = expectations
        dataframe["pa_signal_high"] = signal_highs
        dataframe["pa_signal_low"] = signal_lows
        dataframe["pa_invalidation"] = invalidations

    @classmethod
    def _add_causal_market_structure(cls, dataframe: DataFrame, epsilon: float) -> None:
        """Compatibility entry point retained for causal PA tests."""
        if "open" not in dataframe:
            dataframe["open"] = dataframe["close"].shift(1).fillna(dataframe["close"])
        if "atr" not in dataframe:
            dataframe["atr"] = (dataframe["high"] - dataframe["low"]).rolling(14, min_periods=1).mean()
        if "rsi" not in dataframe:
            dataframe["rsi"] = 50.0
        cls._add_bar_features(dataframe)
        cls._add_brooks_price_action(dataframe, epsilon)
        cls._carry_setups(dataframe)

    def _populate_features(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        macd = ta.MACD(dataframe, fastperiod=12, slowperiod=26, signalperiod=9)
        dataframe["macd"] = macd["macd"]
        dataframe["macdsignal"] = macd["macdsignal"]
        dataframe["macdhist"] = macd["macdhist"]
        dataframe["rsi"] = ta.RSI(dataframe, timeperiod=14)
        dataframe["atr"] = ta.ATR(dataframe, timeperiod=14)
        dataframe["ema20"] = ta.EMA(dataframe, timeperiod=20)
        dataframe["ema20_slope_atr"] = (dataframe["ema20"] - dataframe["ema20"].shift(3)) / dataframe["atr"].replace(0, np.nan)
        dataframe["volume_mean20"] = dataframe["volume"].rolling(20, min_periods=20).mean()
        dataframe["volume_ratio"] = dataframe["volume"] / dataframe["volume_mean20"].replace(0, np.nan)
        self._add_bar_features(dataframe)
        fallback_price = float(dataframe["close"].iloc[-1]) if not dataframe.empty else 1.0
        self._add_brooks_price_action(dataframe, self._tick_size(metadata["pair"], fallback_price))
        dataframe = dataframe.copy()
        self._carry_setups(dataframe)
        return dataframe.copy()

    @informative("15m")
    def populate_indicators_15m(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        return self._populate_features(dataframe, metadata)

    @informative("1h")
    def populate_indicators_1h(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        return self._populate_features(dataframe, metadata)

    def _build_signal_columns(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe = dataframe.copy()
        use_15m = dataframe["pa_setup_recent_15m"].fillna(0).astype(int) != 0

        def selected(name: str) -> Series:
            return Series(
                np.where(use_15m, dataframe[f"{name}_15m"], dataframe[name]),
                index=dataframe.index,
            )

        setup = selected("pa_setup_recent").fillna(0).astype(int)
        setup_direction = np.sign(setup).astype(int)
        setup_type = setup.abs()
        setup_age = selected("pa_setup_age").fillna(999).astype(int)
        setup_quality = selected("pa_setup_quality").fillna(0).astype(int)
        signal_high = selected("pa_signal_high")
        signal_low = selected("pa_signal_low")
        invalidation = selected("pa_invalidation")
        selected_atr = selected("atr").replace(0, np.nan)
        selected_close = selected("close")
        selected_ema = selected("ema20")
        selected_ema_slope = selected("ema20_slope_atr").fillna(0)
        selected_rsi = selected("rsi")
        selected_hist = selected("macdhist")
        selected_divergence = selected("divergence_recent").fillna(0).astype(int)

        hourly_cycle = dataframe["pa_market_cycle_1h"].fillna(self.CYCLE_RANGE).astype(int)
        hourly_always_in = dataframe["pa_always_in_1h"].fillna(0).astype(int)
        continuation_setup = setup_type.isin([self.SETUP_H2_L2, self.SETUP_BREAKOUT_PULLBACK])
        range_setup = setup_type == self.SETUP_FAILED_BREAKOUT
        long_context = (setup_direction == 1) & (
            (continuation_setup & (hourly_always_in == 1) & hourly_cycle.isin([self.CYCLE_TREND, self.CYCLE_CHANNEL]))
            | (range_setup & ((hourly_cycle == self.CYCLE_RANGE) | ((hourly_cycle == self.CYCLE_CHANNEL) & (hourly_always_in == 1))))
        )
        short_context = (setup_direction == -1) & (
            (continuation_setup & (hourly_always_in == -1) & hourly_cycle.isin([self.CYCLE_TREND, self.CYCLE_CHANNEL]))
            | (range_setup & ((hourly_cycle == self.CYCLE_RANGE) | ((hourly_cycle == self.CYCLE_CHANNEL) & (hourly_always_in == -1))))
        )

        long_ema_support = (
            (selected_close >= selected_ema)
            & (selected_ema_slope >= 0)
            & (dataframe["close_1h"] >= dataframe["ema20_1h"])
            & (dataframe["ema20_slope_atr_1h"].fillna(0) >= 0)
        )
        short_ema_support = (
            (selected_close <= selected_ema)
            & (selected_ema_slope <= 0)
            & (dataframe["close_1h"] <= dataframe["ema20_1h"])
            & (dataframe["ema20_slope_atr_1h"].fillna(0) <= 0)
        )
        long_momentum_support = (
            (selected_hist > 0)
            | (selected_divergence == 1)
        )
        short_momentum_support = (
            (selected_hist < 0)
            | (selected_divergence == -1)
        )
        long_control_support = (selected_rsi > 55) & (dataframe["rsi_1h"] > 55)
        short_control_support = (selected_rsi < 45) & (dataframe["rsi_1h"] < 45)
        long_opposition = (selected_divergence == -1) & (selected("divergence_age").fillna(999) <= 6)
        short_opposition = (selected_divergence == 1) & (selected("divergence_age").fillna(999) <= 6)

        long_armed = long_context & (setup_quality == 2) & long_ema_support & long_momentum_support & long_control_support & ~long_opposition
        short_armed = short_context & (setup_quality == 2) & short_ema_support & short_momentum_support & short_control_support & ~short_opposition
        age_ready = use_15m | (setup_age >= 1)
        fallback_price = float(dataframe["close"].iloc[-1]) if not dataframe.empty else 1.0
        tick_size = self._tick_size(metadata["pair"], fallback_price)
        long_trigger = age_ready & (setup_direction == 1) & (dataframe["close"] > signal_high + tick_size)
        short_trigger = age_ready & (setup_direction == -1) & (dataframe["close"] < signal_low - tick_size)

        long_base = invalidation.where(invalidation < dataframe["close"], signal_low)
        short_base = invalidation.where(invalidation > dataframe["close"], signal_high)
        long_stop = np.minimum(long_base - selected_atr * 0.25, dataframe["close"] - selected_atr * self.MIN_STOP_DISTANCE_ATR)
        short_stop = np.maximum(short_base + selected_atr * 0.25, dataframe["close"] + selected_atr * self.MIN_STOP_DISTANCE_ATR)
        long_risk_atr = (dataframe["close"] - long_stop) / selected_atr
        short_risk_atr = (short_stop - dataframe["close"]) / selected_atr
        long_drift_atr = (dataframe["close"] - signal_high).abs() / selected_atr
        short_drift_atr = (dataframe["close"] - signal_low).abs() / selected_atr

        long_confidence = np.select(
            [long_armed & (setup_quality == 2) & continuation_setup, long_armed & (setup_quality == 2), long_armed],
            [85, 80, 70],
            default=0,
        )
        short_confidence = np.select(
            [short_armed & (setup_quality == 2) & continuation_setup, short_armed & (setup_quality == 2), short_armed],
            [85, 80, 70],
            default=0,
        )

        dataframe["helix_bias"] = hourly_always_in
        dataframe["helix_setup_type"] = setup
        dataframe["helix_setup_source"] = np.where(use_15m, 15, 5)
        dataframe["helix_long_armed"] = long_armed
        dataframe["helix_short_armed"] = short_armed
        dataframe["helix_long_confidence"] = long_confidence.astype(int)
        dataframe["helix_short_confidence"] = short_confidence.astype(int)
        dataframe["helix_stop_long"] = long_stop
        dataframe["helix_stop_short"] = short_stop
        dataframe["helix_long_risk_atr"] = long_risk_atr
        dataframe["helix_short_risk_atr"] = short_risk_atr
        dataframe["helix_long_entry_drift_atr"] = long_drift_atr
        dataframe["helix_short_entry_drift_atr"] = short_drift_atr
        dataframe["helix_long_entry"] = (
            long_armed
            & long_trigger
            & (long_confidence >= self.MIN_CONFIDENCE)
            & (long_risk_atr > 0)
            & (long_risk_atr <= self.MAX_STOP_DISTANCE_ATR)
            & (long_drift_atr <= self.MAX_ENTRY_DRIFT_ATR)
            & (dataframe["volume"] > 0)
        )
        dataframe["helix_short_entry"] = (
            short_armed
            & short_trigger
            & (short_confidence >= self.MIN_CONFIDENCE)
            & (short_risk_atr > 0)
            & (short_risk_atr <= self.MAX_STOP_DISTANCE_ATR)
            & (short_drift_atr <= self.MAX_ENTRY_DRIFT_ATR)
            & (dataframe["volume"] > 0)
        )
        return dataframe

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe = self._populate_features(dataframe, metadata)
        return self._build_signal_columns(dataframe, metadata)

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        long_entry = dataframe["helix_long_entry"] & ~dataframe["helix_long_entry"].shift(1, fill_value=False)
        short_entry = dataframe["helix_short_entry"] & ~dataframe["helix_short_entry"].shift(1, fill_value=False)
        dataframe.loc[long_entry, "enter_long"] = 1
        dataframe.loc[short_entry, "enter_short"] = 1

        labels = dataframe["helix_setup_type"].abs().map({
            self.SETUP_H2_L2: "second_entry",
            self.SETUP_BREAKOUT_PULLBACK: "breakout_pullback",
            self.SETUP_FAILED_BREAKOUT: "failed_breakout",
        }).fillna("unknown")
        dataframe.loc[long_entry, "enter_tag"] = (
            "helix_long_" + labels[long_entry] + "_" + dataframe.loc[long_entry, "helix_long_confidence"].astype(str)
        )
        dataframe.loc[short_entry, "enter_tag"] = (
            "helix_short_" + labels[short_entry] + "_" + dataframe.loc[short_entry, "helix_short_confidence"].astype(str)
        )
        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        exit_long = (dataframe["pa_always_in_1h"] == -1) & (dataframe["volume"] > 0)
        exit_short = (dataframe["pa_always_in_1h"] == 1) & (dataframe["volume"] > 0)
        dataframe.loc[exit_long, "exit_long"] = 1
        dataframe.loc[exit_short, "exit_short"] = 1
        dataframe.loc[exit_long, "exit_tag"] = "helix_pa_invalidation"
        dataframe.loc[exit_short, "exit_tag"] = "helix_pa_invalidation"
        return dataframe

    def _latest_row(self, pair: str):
        if not self.dp:
            return None
        dataframe, _ = self.dp.get_analyzed_dataframe(pair, self.timeframe)
        return None if dataframe.empty else dataframe.iloc[-1]

    @staticmethod
    def _as_utc(value: datetime) -> datetime:
        return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)

    @classmethod
    def _daily_loss_breached(cls, current_equity: float, daily_profit: float) -> bool:
        starting_equity = current_equity - daily_profit
        return starting_equity > 0 and daily_profit <= -(starting_equity * cls.DAILY_LOSS_LIMIT)

    @classmethod
    def _has_consecutive_losses(cls, profits: list[float]) -> bool:
        return len(profits) >= cls.CONSECUTIVE_LOSS_LIMIT and all(
            profit < 0 for profit in profits[:cls.CONSECUTIVE_LOSS_LIMIT]
        )

    @staticmethod
    def _lock_globally(until: datetime, reason: str, current_time: datetime) -> None:
        current = HelixIntradayStrategy._as_utc(current_time)
        lock_until = HelixIntradayStrategy._as_utc(until)
        if lock_until <= current:
            return
        existing = PairLocks.get_pair_longest_lock("*", now=current)
        if existing is None or HelixIntradayStrategy._as_utc(existing.lock_end_time) < lock_until:
            PairLocks.lock_pair("*", lock_until, reason=reason, now=current)

    def bot_loop_start(self, current_time: datetime, **kwargs) -> None:
        current = self._as_utc(current_time)
        day_start = current.replace(hour=0, minute=0, second=0, microsecond=0)
        closed_today = Trade.get_trades_proxy(is_open=False, close_date=day_start)
        daily_profit = sum(float(trade.close_profit_abs or 0) for trade in closed_today)
        current_equity = float(self.wallets.get_total_stake_amount()) if self.wallets else 0.0
        if self._daily_loss_breached(current_equity, daily_profit):
            self._lock_globally(
                day_start + timedelta(days=1),
                f"helix_daily_loss_{self.DAILY_LOSS_LIMIT:.0%}",
                current,
            )

        closed = sorted(
            Trade.get_trades_proxy(is_open=False),
            key=lambda trade: self._as_utc(trade.close_date),
            reverse=True,
        )
        recent = closed[:self.CONSECUTIVE_LOSS_LIMIT]
        if recent and self._has_consecutive_losses([float(trade.close_profit_abs or 0) for trade in recent]):
            latest_close = self._as_utc(recent[0].close_date)
            self._lock_globally(
                latest_close + self.CONSECUTIVE_LOSS_PAUSE,
                f"helix_{self.CONSECUTIVE_LOSS_LIMIT}_loss_pause",
                current,
            )

    def confirm_trade_entry(
        self,
        pair: str,
        order_type: str,
        amount: float,
        rate: float,
        time_in_force: str,
        current_time: datetime,
        entry_tag: str | None,
        side: str,
        **kwargs,
    ) -> bool:
        row = self._latest_row(pair)
        if row is None:
            return False
        candle_time = row.get("date")
        if candle_time is None:
            return False
        candle_date = self._as_utc(pd.Timestamp(candle_time).to_pydatetime())
        candle_age = self._as_utc(current_time) - candle_date
        if candle_age < timedelta(0) or candle_age > self.MAX_CANDLE_AGE:
            return False
        confidence_column = "helix_short_confidence" if side == "short" else "helix_long_confidence"
        armed_column = "helix_short_armed" if side == "short" else "helix_long_armed"
        stop_column = "helix_stop_short" if side == "short" else "helix_stop_long"
        confidence = float(row.get(confidence_column, 0))
        armed = bool(row.get(armed_column, False))
        stop = float(row.get(stop_column, np.nan))
        atr = float(row.get("atr", np.nan))
        if not armed or confidence < self.MIN_CONFIDENCE or not np.isfinite(stop) or not np.isfinite(atr) or atr <= 0:
            return False
        if abs(rate - float(row["close"])) > atr * self.MAX_ENTRY_DRIFT_ATR:
            return False
        return stop > rate if side == "short" else stop < rate

    def leverage(
        self,
        pair: str,
        current_time: datetime,
        current_rate: float,
        proposed_leverage: float,
        max_leverage: float,
        entry_tag: str | None,
        side: str,
        **kwargs,
    ) -> float:
        return min(self.MAX_LEVERAGE, max_leverage)

    def custom_stake_amount(
        self,
        pair: str,
        current_time: datetime,
        current_rate: float,
        proposed_stake: float,
        min_stake: float | None,
        max_stake: float,
        leverage: float,
        entry_tag: str | None,
        side: str,
        **kwargs,
    ) -> float:
        row = self._latest_row(pair)
        stop_column = "helix_stop_short" if side == "short" else "helix_stop_long"
        stop = float(row.get(stop_column, np.nan)) if row is not None else np.nan
        wallet = float(self.wallets.get_total_stake_amount()) if self.wallets else 0.0
        return self._risk_capped_stake(
            wallet,
            current_rate,
            stop,
            leverage,
            proposed_stake,
            min_stake,
            max_stake,
        )

    @classmethod
    def _risk_capped_stake(
        cls,
        wallet: float,
        current_rate: float,
        stop: float,
        leverage: float,
        proposed_stake: float,
        min_stake: float | None,
        max_stake: float,
    ) -> float:
        values = (wallet, current_rate, stop, leverage, proposed_stake, max_stake)
        if not all(np.isfinite(value) for value in values) or wallet <= 0 or current_rate <= 0 or leverage <= 0:
            return 0.0
        stop_fraction = abs(current_rate - stop) / current_rate
        if stop_fraction <= 0:
            return 0.0
        risk_stake = wallet * cls.RISK_PER_TRADE / (stop_fraction * max(leverage, 1.0))
        capped_stake = min(risk_stake, proposed_stake, max_stake)
        if capped_stake <= 0 or (min_stake is not None and capped_stake < float(min_stake)):
            return 0.0
        return capped_stake

    @staticmethod
    def _initial_stop(trade: Trade) -> float | None:
        stop = trade.get_custom_data("helix_initial_stop")
        if stop is None:
            return None
        value = float(stop)
        return value if np.isfinite(value) else None

    def custom_exit(
        self,
        pair: str,
        trade: Trade,
        current_time: datetime,
        current_rate: float,
        current_profit: float,
        **kwargs,
    ) -> str | None:
        row = self._latest_row(pair)
        if row is not None:
            always_in = int(row.get("pa_always_in_1h", 0))
            if (trade.is_short and always_in == 1) or (not trade.is_short and always_in == -1):
                return "helix_pa_invalidation"

        stop = self._initial_stop(trade)
        if stop is None:
            return None
        risk = abs(trade.open_rate - stop)
        if risk <= 0:
            return None
        target = trade.open_rate - risk * self.PROFIT_TARGET_R if trade.is_short else trade.open_rate + risk * self.PROFIT_TARGET_R
        if (trade.is_short and current_rate <= target) or (not trade.is_short and current_rate >= target):
            return "helix_target_2r"
        return None

    def custom_stoploss(
        self,
        pair: str,
        trade: Trade,
        current_time: datetime,
        current_rate: float,
        current_profit: float,
        after_fill: bool,
        **kwargs,
    ) -> float | None:
        stop = self._initial_stop(trade)
        if stop is None:
            row = self._latest_row(pair)
            column = "helix_stop_short" if trade.is_short else "helix_stop_long"
            candidate = float(row.get(column, np.nan)) if row is not None else np.nan
            if not np.isfinite(candidate):
                return None
            trade.set_custom_data("helix_initial_stop", candidate)
            stop = candidate
        risk = abs(trade.open_rate - float(stop))
        if risk > 0:
            break_even_trigger = trade.open_rate - risk * self.BREAK_EVEN_TRIGGER_R if trade.is_short else trade.open_rate + risk * self.BREAK_EVEN_TRIGGER_R
            reached_break_even = current_rate <= break_even_trigger if trade.is_short else current_rate >= break_even_trigger
            if reached_break_even:
                fee_buffer = -self.BREAK_EVEN_FEE_BUFFER if trade.is_short else self.BREAK_EVEN_FEE_BUFFER
                break_even_stop = trade.open_rate * (1 + fee_buffer)
                stop = min(float(stop), break_even_stop) if trade.is_short else max(float(stop), break_even_stop)
        return stoploss_from_absolute(
            float(stop),
            current_rate=current_rate,
            is_short=trade.is_short,
            leverage=trade.leverage,
        )
