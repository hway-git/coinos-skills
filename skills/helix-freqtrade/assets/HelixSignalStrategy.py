"""Freqtrade execution adapter for Helix Signal Artifacts.

Strategy decisions belong to the Helix Engine. This adapter validates the
immutable artifact and maps its exact closed-candle timestamps to Freqtrade's
entry and exit columns. It must not contain indicators or strategy rules.
"""

from __future__ import annotations

import os
from pathlib import Path

from pandas import DataFrame
from freqtrade.strategy import IStrategy

from helix_signal_artifact import SignalArtifactError, load_artifacts, path_fingerprint, signals_for
from helix_signal_batch import (
    batch_path_fingerprint,
    load_batch_chain,
    require_worker_heartbeat,
    signals_for_batches,
)


class HelixSignalStrategy(IStrategy):
    INTERFACE_VERSION = 3

    timeframe = os.environ.get("HELIX_SIGNAL_TIMEFRAME", "").strip() or "1m"
    can_short = True
    # Forward batches may arrive after Freqtrade first processes a candle close.
    process_only_new_candles = False
    startup_candle_count = 0

    minimal_roi = {"0": 100.0}
    stoploss = -0.99
    trailing_stop = False
    use_exit_signal = True
    exit_profit_only = False
    ignore_roi_if_entry_signal = True

    _helix_artifact_fingerprint = None
    _helix_artifacts = None
    _helix_batch_fingerprint = None
    _helix_batches = None

    def _artifact_path(self) -> Path:
        environment_path = os.environ.get("HELIX_SIGNAL_ARTIFACT_PATH", "").strip()
        if self._artifact_override_enabled():
            if not environment_path:
                raise SignalArtifactError("HELIX_SIGNAL_ARTIFACT_OVERRIDE requires HELIX_SIGNAL_ARTIFACT_PATH")
            return Path(environment_path)
        configured = str(self.config.get("helix_signal_artifact_path", "")).strip()
        if not configured:
            configured = environment_path
        if configured:
            return Path(configured)
        user_data_dir = Path(self.config.get("user_data_dir", "."))
        return user_data_dir / "helix" / "signals" / "active.json"

    @staticmethod
    def _artifact_override_enabled() -> bool:
        return os.environ.get("HELIX_SIGNAL_ARTIFACT_OVERRIDE", "").strip() == "1"

    def _load_pinned_artifacts(self):
        artifact_path = self._artifact_path()
        fingerprint = path_fingerprint(artifact_path)
        if fingerprint != self._helix_artifact_fingerprint:
            self._helix_artifacts = load_artifacts(artifact_path)
            self._helix_artifact_fingerprint = fingerprint
        expected_hash = (
            os.environ.get("HELIX_SIGNAL_ARTIFACT_HASH", "").strip()
            if self._artifact_override_enabled()
            else str(self.config.get("helix_signal_artifact_hash", "")).strip()
        )
        if self._artifact_override_enabled() and not expected_hash:
            raise SignalArtifactError("artifact override requires HELIX_SIGNAL_ARTIFACT_HASH")
        if expected_hash and (
            len(self._helix_artifacts or []) != 1
            or self._helix_artifacts[0]["artifactHash"] != expected_hash
        ):
            raise SignalArtifactError(
                f"configured signal artifact hash {expected_hash} does not match {artifact_path}"
            )
        return self._helix_artifacts or []

    def _forward_paths(self) -> tuple[Path, Path, Path] | None:
        if self._artifact_override_enabled():
            return None
        deployment = str(self.config.get("helix_signal_forward_deployment_path", "")).strip()
        batches = str(self.config.get("helix_signal_batch_path", "")).strip()
        status = str(self.config.get("helix_signal_forward_status_path", "")).strip()
        if not deployment and not batches and not status:
            return None
        if not deployment or not batches or not status:
            raise SignalArtifactError("forward Signal mode requires deployment, batch, and status paths")
        return Path(deployment), Path(batches), Path(status)

    def _load_pinned_batches(self):
        paths = self._forward_paths()
        if not paths:
            return None
        deployment_path, batches_path, _status_path = paths
        fingerprint = batch_path_fingerprint(deployment_path, batches_path)
        if fingerprint != self._helix_batch_fingerprint:
            deployment, batches = load_batch_chain(deployment_path, batches_path)
            expected_hash = str(self.config.get("helix_signal_forward_deployment_hash", "")).strip()
            if not expected_hash or deployment["deploymentHash"] != expected_hash:
                raise SignalArtifactError("configured forward deployment hash does not match its file")
            self._helix_batches = batches
            self._helix_batch_fingerprint = fingerprint
        return self._helix_batches or []

    def _require_forward_health(self) -> None:
        paths = self._forward_paths()
        if not paths:
            return
        expected_hash = str(self.config.get("helix_signal_forward_deployment_hash", "")).strip()
        if not expected_hash:
            raise SignalArtifactError("forward Signal mode requires a configured deployment hash")
        require_worker_heartbeat(paths[2], expected_hash)

    def bot_start(self, **kwargs) -> None:
        if self._forward_paths():
            self._load_pinned_batches()
        else:
            self._load_pinned_artifacts()

    def _signal_index(self, pair: str):
        batches = self._load_pinned_batches()
        if batches is not None:
            return signals_for_batches(batches, pair, self.timeframe)
        return signals_for(self._load_pinned_artifacts(), pair, self.timeframe)

    def confirm_trade_entry(
        self, pair, order_type, amount, rate, time_in_force, current_time,
        entry_tag, side, **kwargs,
    ) -> bool:
        try:
            self._require_forward_health()
            return True
        except (SignalArtifactError, ValueError):
            return False

    def custom_exit(
        self, pair, trade, current_time, current_rate, current_profit, **kwargs,
    ):
        try:
            self._require_forward_health()
            return None
        except (SignalArtifactError, ValueError):
            return "helix_forward_unavailable"

    @staticmethod
    def _apply_signal_column(
        dataframe: DataFrame,
        signals: dict[int, str],
        signal_column: str,
        tag_column: str,
    ) -> None:
        dataframe[signal_column] = 0
        if not signals or dataframe.empty:
            return
        candle_open_ms = (
            dataframe["date"]
            .astype("datetime64[ns, UTC]")
            .astype("int64")
            // 1_000_000
        )
        tags = candle_open_ms.map(signals)
        matched = tags.notna()
        dataframe.loc[matched, signal_column] = 1
        dataframe.loc[matched, tag_column] = tags.loc[matched]

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        index = self._signal_index(metadata["pair"])
        dataframe["enter_tag"] = None
        self._apply_signal_column(dataframe, index[("ENTER", "LONG")], "enter_long", "enter_tag")
        self._apply_signal_column(dataframe, index[("ENTER", "SHORT")], "enter_short", "enter_tag")
        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        index = self._signal_index(metadata["pair"])
        dataframe["exit_tag"] = None
        self._apply_signal_column(dataframe, index[("EXIT", "LONG")], "exit_long", "exit_tag")
        self._apply_signal_column(dataframe, index[("EXIT", "SHORT")], "exit_short", "exit_tag")
        return dataframe
