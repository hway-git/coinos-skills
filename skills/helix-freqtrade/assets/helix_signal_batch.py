"""Validation and indexing for immutable Helix forward Signal Batch chains."""

from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path
from typing import Any

from helix_signal_artifact import (
    COMMIT_PATTERN,
    HASH_PATTERN,
    REASON_CODE_PATTERN,
    _canonical_json,
    _exact_record,
    _integer,
    _reject_duplicate_keys,
    _text,
    _timeframe_milliseconds,
)


FORWARD_SCHEMA_VERSION = "helix.forward-deployment/v1"
BATCH_SCHEMA_VERSION = "helix.signal-batch/v1"
FORWARD_FIELDS = (
    "schemaVersion", "deploymentId", "mode", "activatedAt", "provider",
    "instrumentId", "symbol", "strategy", "deploymentHash",
)
FORWARD_PAYLOAD_FIELDS = FORWARD_FIELDS[:-1]
STRATEGY_FIELDS = (
    "id", "version", "repoCommit", "configHash", "engineCommit",
    "lifecycle", "objectModel", "baseTimeframe",
)
BATCH_FIELDS = (
    "schemaVersion", "deploymentHash", "batchSequence", "previousBatchHash",
    "previousDecisionStateHash", "evaluatorStateHash", "decisionStateHash",
    "identity", "strategyLifecycle", "objectModel", "symbol", "baseTimeframe",
    "positionBefore", "positionAfter", "signal", "batchHash",
)
BATCH_PAYLOAD_FIELDS = BATCH_FIELDS[:-1]
IDENTITY_FIELDS = (
    "strategyId", "strategyVersion", "strategyRepoCommit", "strategyConfigHash",
    "engineCommit", "marketDataSnapshotId",
)
POSITION_FIELDS = ("object", "side", "entrySignalId")
SIGNAL_FIELDS = (
    "sequence", "signalId", "decisionId", "object", "action", "side",
    "sourceCandleOpenTime", "decisionTime", "reasonCodes",
)
DRY_RUN_LIFECYCLES = {"shadow", "canary", "production"}
OBJECT_MODELS = {"PRICE_EVENT", "TRADE_THESIS"}
SIDES = {"LONG", "SHORT"}
ACTIONS = {"ENTER", "EXIT"}


class SignalBatchError(ValueError):
    pass


def _hash(payload: dict[str, Any]) -> str:
    return "sha256:" + hashlib.sha256(_canonical_json(payload).encode("utf-8")).hexdigest()


def _load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=_reject_duplicate_keys)
    except (OSError, json.JSONDecodeError) as error:
        raise SignalBatchError(f"cannot read forward signal file {path}: {error}") from error


def validate_forward_deployment(value: Any) -> dict[str, Any]:
    deployment = _exact_record(value, "forward deployment", FORWARD_FIELDS)
    if deployment["schemaVersion"] != FORWARD_SCHEMA_VERSION:
        raise SignalBatchError(f"unsupported forward deployment schema {deployment['schemaVersion']}")
    _text(deployment["deploymentId"], "deploymentId")
    if deployment["mode"] != "dry_run" or deployment["provider"] != "okx":
        raise SignalBatchError("forward deployment must use dry_run mode and okx provider")
    _integer(deployment["activatedAt"], "activatedAt")
    _text(deployment["instrumentId"], "instrumentId")
    _text(deployment["symbol"], "symbol")
    strategy = _exact_record(deployment["strategy"], "forward strategy", STRATEGY_FIELDS)
    for field in ("id", "version", "repoCommit", "configHash", "engineCommit", "lifecycle", "objectModel"):
        _text(strategy[field], f"strategy.{field}")
    if not COMMIT_PATTERN.fullmatch(strategy["repoCommit"]) or not COMMIT_PATTERN.fullmatch(strategy["engineCommit"]):
        raise SignalBatchError("forward deployment requires full strategy and Engine commits")
    if not HASH_PATTERN.fullmatch(strategy["configHash"]):
        raise SignalBatchError("strategy.configHash must be a SHA-256 hash")
    if strategy["lifecycle"] not in DRY_RUN_LIFECYCLES:
        raise SignalBatchError(f"strategy lifecycle {strategy['lifecycle']} cannot run forward dry-run")
    if strategy["objectModel"] not in OBJECT_MODELS:
        raise SignalBatchError("strategy.objectModel is invalid")
    _timeframe_milliseconds(strategy["baseTimeframe"])
    actual_hash = _text(deployment["deploymentHash"], "deploymentHash")
    if not HASH_PATTERN.fullmatch(actual_hash):
        raise SignalBatchError("deploymentHash must be a SHA-256 hash")
    expected_hash = _hash({field: deployment[field] for field in FORWARD_PAYLOAD_FIELDS})
    if actual_hash != expected_hash:
        raise SignalBatchError(f"forward deployment hash mismatch: expected {expected_hash}")
    return deployment


def _object(value: Any, name: str, object_model: str) -> dict[str, Any]:
    reference = _exact_record(value, name, ("model", "id"))
    if reference["model"] != object_model:
        raise SignalBatchError(f"{name}.model must match objectModel")
    _text(reference["id"], f"{name}.id")
    return reference


def _position(value: Any, name: str, object_model: str) -> dict[str, Any] | None:
    if value is None:
        return None
    position = _exact_record(value, name, POSITION_FIELDS)
    _object(position["object"], f"{name}.object", object_model)
    if _text(position["side"], f"{name}.side") not in SIDES:
        raise SignalBatchError(f"{name}.side is invalid")
    _text(position["entrySignalId"], f"{name}.entrySignalId")
    return position


def validate_signal_batch(value: Any) -> dict[str, Any]:
    batch = _exact_record(value, "signal batch", BATCH_FIELDS)
    if batch["schemaVersion"] != BATCH_SCHEMA_VERSION:
        raise SignalBatchError(f"unsupported signal batch schema {batch['schemaVersion']}")
    if not HASH_PATTERN.fullmatch(_text(batch["deploymentHash"], "deploymentHash")):
        raise SignalBatchError("deploymentHash must be a SHA-256 hash")
    sequence = _integer(batch["batchSequence"], "batchSequence")
    previous = batch["previousBatchHash"]
    if previous is not None and not HASH_PATTERN.fullmatch(_text(previous, "previousBatchHash")):
        raise SignalBatchError("previousBatchHash must be a SHA-256 hash")
    previous_state = batch["previousDecisionStateHash"]
    if previous_state is not None and not HASH_PATTERN.fullmatch(_text(previous_state, "previousDecisionStateHash")):
        raise SignalBatchError("previousDecisionStateHash must be a SHA-256 hash")
    for field in ("evaluatorStateHash", "decisionStateHash"):
        if not HASH_PATTERN.fullmatch(_text(batch[field], field)):
            raise SignalBatchError(f"{field} must be a SHA-256 hash")
    identity = _exact_record(batch["identity"], "signal batch identity", IDENTITY_FIELDS)
    for field in IDENTITY_FIELDS:
        _text(identity[field], f"identity.{field}")
    if not COMMIT_PATTERN.fullmatch(identity["strategyRepoCommit"]) or not COMMIT_PATTERN.fullmatch(identity["engineCommit"]):
        raise SignalBatchError("signal batch identity requires full strategy and Engine commits")
    for field in ("strategyConfigHash", "marketDataSnapshotId"):
        if not HASH_PATTERN.fullmatch(identity[field]):
            raise SignalBatchError(f"identity.{field} must be a SHA-256 hash")
    object_model = _text(batch["objectModel"], "objectModel")
    if object_model not in OBJECT_MODELS:
        raise SignalBatchError("objectModel is invalid")
    timeframe, duration = _timeframe_milliseconds(batch["baseTimeframe"])
    signal = _exact_record(batch["signal"], "signal batch signal", SIGNAL_FIELDS)
    if _integer(signal["sequence"], "signal.sequence") != sequence:
        raise SignalBatchError("signal.sequence must equal batchSequence")
    _text(signal["signalId"], "signal.signalId")
    _text(signal["decisionId"], "signal.decisionId")
    reference = _object(signal["object"], "signal.object", object_model)
    action = _text(signal["action"], "signal.action")
    side = _text(signal["side"], "signal.side")
    if action not in ACTIONS or side not in SIDES:
        raise SignalBatchError("signal action or side is invalid")
    source_open = _integer(signal["sourceCandleOpenTime"], "signal.sourceCandleOpenTime")
    decision_time = _integer(signal["decisionTime"], "signal.decisionTime")
    if source_open % duration or decision_time != source_open + duration:
        raise SignalBatchError("signal decision must equal its aligned source candle close")
    reason_codes = signal["reasonCodes"]
    if not isinstance(reason_codes, list) or not reason_codes:
        raise SignalBatchError("signal.reasonCodes must be a non-empty array")
    normalized_reasons = [_text(code, "signal.reasonCodes") for code in reason_codes]
    if len(set(normalized_reasons)) != len(normalized_reasons) or any(
        not REASON_CODE_PATTERN.fullmatch(code) for code in normalized_reasons
    ):
        raise SignalBatchError("signal.reasonCodes must be unique registered-style codes")
    before = _position(batch["positionBefore"], "positionBefore", object_model)
    after = _position(batch["positionAfter"], "positionAfter", object_model)
    if action == "ENTER":
        expected = {"object": reference, "side": side, "entrySignalId": signal["signalId"]}
        if before is not None or after != expected:
            raise SignalBatchError("ENTER batch must transition a flat position to its signal position")
    elif after is not None or before is None or before["object"]["id"] != reference["id"] or before["side"] != side:
        raise SignalBatchError("EXIT batch must close its matching prior position")
    actual_hash = _text(batch["batchHash"], "batchHash")
    if not HASH_PATTERN.fullmatch(actual_hash):
        raise SignalBatchError("batchHash must be a SHA-256 hash")
    expected_hash = _hash({field: batch[field] for field in BATCH_PAYLOAD_FIELDS})
    if actual_hash != expected_hash:
        raise SignalBatchError(f"signal batch hash mismatch: expected {expected_hash}")
    return batch


def load_batch_chain(deployment_path: str | Path, batches_path: str | Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    deployment = validate_forward_deployment(_load_json(Path(deployment_path)))
    directory = Path(batches_path)
    files = sorted(directory.glob("*.json")) if directory.exists() else []
    batches = [validate_signal_batch(_load_json(file)) for file in files]
    previous_hash = None
    position = None
    prior_decision_time = -1
    prior_decision_state_hash = None
    signal_ids: set[str] = set()
    decision_ids: set[str] = set()
    _, duration = _timeframe_milliseconds(deployment["strategy"]["baseTimeframe"])
    first_decision_time = (deployment["activatedAt"] // duration + 1) * duration
    for index, (file, batch) in enumerate(zip(files, batches)):
        expected_name = f"{index:012d}-{batch['batchHash'].replace(':', '-')}.json"
        if file.name != expected_name:
            raise SignalBatchError(f"signal batch filename does not match sequence {index}")
        if batch["deploymentHash"] != deployment["deploymentHash"]:
            raise SignalBatchError("signal batch deploymentHash does not match")
        if batch["batchSequence"] != index or batch["previousBatchHash"] != previous_hash:
            raise SignalBatchError(f"signal batch chain is broken at sequence {index}")
        strategy = deployment["strategy"]
        identity = batch["identity"]
        if (
            identity["strategyId"] != strategy["id"]
            or identity["strategyVersion"] != strategy["version"]
            or identity["strategyRepoCommit"] != strategy["repoCommit"]
            or identity["strategyConfigHash"] != strategy["configHash"]
            or identity["engineCommit"] != strategy["engineCommit"]
            or batch["strategyLifecycle"] != strategy["lifecycle"]
            or batch["objectModel"] != strategy["objectModel"]
            or batch["symbol"] != deployment["symbol"]
            or batch["baseTimeframe"] != strategy["baseTimeframe"]
        ):
            raise SignalBatchError(f"signal batch identity does not match deployment at sequence {index}")
        if batch["positionBefore"] != position:
            raise SignalBatchError(f"signal batch position chain is broken at sequence {index}")
        signal = batch["signal"]
        if signal["decisionTime"] < first_decision_time or signal["decisionTime"] <= prior_decision_time:
            raise SignalBatchError(f"signal batch decision time is invalid at sequence {index}")
        expected_decision_state_hash = _hash({
            "schemaVersion": "helix.forward-decision-state/v1",
            "deploymentHash": batch["deploymentHash"],
            "decisionTime": signal["decisionTime"],
            "marketDataSnapshotId": batch["identity"]["marketDataSnapshotId"],
            "previousDecisionStateHash": batch["previousDecisionStateHash"],
            "evaluatorStateHash": batch["evaluatorStateHash"],
            "position": batch["positionAfter"],
            "signal": {
                "signalId": signal["signalId"],
                "decisionId": signal["decisionId"],
                "object": signal["object"],
                "action": signal["action"],
                "side": signal["side"],
                "reasonCodes": signal["reasonCodes"],
            },
        })
        if batch["decisionStateHash"] != expected_decision_state_hash:
            raise SignalBatchError(f"signal batch decision state hash mismatch at sequence {index}")
        if (
            prior_decision_time >= 0
            and signal["decisionTime"] == prior_decision_time + duration
            and batch["previousDecisionStateHash"] != prior_decision_state_hash
        ):
            raise SignalBatchError(f"signal batch decision state chain is broken at sequence {index}")
        if batch["previousDecisionStateHash"] == batch["decisionStateHash"]:
            raise SignalBatchError(f"signal batch decision state self-cycle at sequence {index}")
        if signal["signalId"] in signal_ids or signal["decisionId"] in decision_ids:
            raise SignalBatchError(f"signal batch chain contains a duplicate decision at sequence {index}")
        signal_ids.add(signal["signalId"])
        decision_ids.add(signal["decisionId"])
        position = batch["positionAfter"]
        previous_hash = batch["batchHash"]
        prior_decision_time = signal["decisionTime"]
        prior_decision_state_hash = batch["decisionStateHash"]
    return deployment, batches


def signals_for_batches(
    batches: list[dict[str, Any]], symbol: str, timeframe: str
) -> dict[tuple[str, str], dict[int, str]]:
    result = {(action, side): {} for action in ACTIONS for side in SIDES}
    for batch in batches:
        if batch["symbol"] != symbol or batch["baseTimeframe"] != timeframe:
            continue
        signal = batch["signal"]
        result[(signal["action"], signal["side"])][signal["sourceCandleOpenTime"]] = signal["signalId"]
    return result


def batch_path_fingerprint(deployment_path: str | Path, batches_path: str | Path) -> tuple[Any, ...]:
    files = [Path(deployment_path)]
    directory = Path(batches_path)
    if directory.exists():
        files.extend(sorted(directory.glob("*.json")))
    fingerprint = []
    for file in files:
        if not file.exists():
            fingerprint.append((str(file), "missing"))
            continue
        stat = file.stat()
        fingerprint.append((str(file), stat.st_ino, stat.st_ctime_ns, stat.st_mtime_ns, stat.st_size))
    return tuple(fingerprint)


def require_worker_heartbeat(
    status_path: str | Path,
    deployment_hash: str,
    max_age_ms: int = 300_000,
) -> dict[str, Any]:
    status = _exact_record(_load_json(Path(status_path)), "forward worker status", (
        "schemaVersion", "deploymentHash", "state", "pid", "updatedAt", "lastDecisionTime",
        "lastMarketSnapshotId", "lastBatchHash", "batches", "error",
    ))
    if status["schemaVersion"] != "helix.forward-worker-status/v1":
        raise SignalBatchError("unsupported forward worker status schema")
    if status["deploymentHash"] != deployment_hash:
        raise SignalBatchError("forward worker heartbeat belongs to another deployment")
    if status["state"] not in {"waiting", "ready"}:
        raise SignalBatchError(f"forward worker is not healthy: {status['error'] or status['state']}")
    _integer(status["pid"], "forward worker pid")
    updated_at = _integer(status["updatedAt"], "forward worker updatedAt")
    if int(time.time() * 1000) - updated_at > max_age_ms:
        raise SignalBatchError("forward worker heartbeat is stale")
    return status


def _main() -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Verify a Helix forward Signal Batch chain")
    parser.add_argument("action", choices=("verify", "signals"))
    parser.add_argument("deployment")
    parser.add_argument("batches")
    parser.add_argument("symbol", nargs="?")
    parser.add_argument("timeframe", nargs="?")
    args = parser.parse_args()
    deployment, batches = load_batch_chain(args.deployment, args.batches)
    if args.action == "verify":
        print(json.dumps({
            "ok": True,
            "deploymentHash": deployment["deploymentHash"],
            "batches": len(batches),
            "lastBatchHash": batches[-1]["batchHash"] if batches else None,
        }, separators=(",", ":")))
        return 0
    if not args.symbol or not args.timeframe:
        parser.error("signals requires symbol and timeframe")
    indexed = signals_for_batches(batches, args.symbol, args.timeframe)
    rows = [
        {"action": action, "side": side, "sourceCandleOpenTime": open_time, "signalId": signal_id}
        for (action, side), signals in sorted(indexed.items())
        for open_time, signal_id in sorted(signals.items())
    ]
    print(json.dumps(rows, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(_main())
    except (SignalBatchError, ValueError) as error:
        raise SystemExit(str(error)) from error
