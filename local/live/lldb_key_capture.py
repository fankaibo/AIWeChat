import json
import os
import stat
import time
import lldb

TARGETS_PATH = os.environ.get("WEIXIN_KEYSCAN_TARGETS", "")
OUTPUT_PATH = os.environ.get("WEIXIN_KEYSCAN_OUTPUT", "")
TARGETS = {}
CAPTURED = {}


def _load_targets():
    global TARGETS
    with open(TARGETS_PATH, "r", encoding="utf-8") as handle:
        parsed = json.load(handle)
    TARGETS = {
        name: {
            "database": value.get("database", name.split("#", 1)[0]),
            "iv": bytes.fromhex(value["iv"]),
            "block": bytes.fromhex(value["block"]),
        }
        for name, value in parsed.get("targets", {}).items()
    }


def _load_captured():
    global CAPTURED
    try:
        with open(OUTPUT_PATH, "r", encoding="utf-8") as handle:
            parsed = json.load(handle)
        CAPTURED = parsed.get("keys", parsed) if isinstance(parsed, dict) else {}
    except Exception:
        CAPTURED = {}


def _save():
    directory = os.path.dirname(OUTPUT_PATH)
    os.makedirs(directory, mode=0o700, exist_ok=True)
    temporary = os.path.join(directory, ".keys-{}.tmp".format(os.getpid()))
    target_databases = set(value["database"] for value in TARGETS.values())
    payload = {"keys": CAPTURED, "captured": len(CAPTURED), "targets": len(target_databases), "updatedAt": int(time.time() * 1000)}
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(descriptor, (json.dumps(payload, indent=2) + "\n").encode("utf-8"))
        os.fchmod(descriptor, stat.S_IRUSR | stat.S_IWUSR)
    finally:
        os.close(descriptor)
    os.replace(temporary, OUTPUT_PATH)


def _memory(process, address, size):
    error = lldb.SBError()
    data = process.ReadMemory(address, size, error)
    if not error.Success() or data is None:
        return b""
    return bytes(data)


def _register(frame, name):
    value = frame.FindRegister(name)
    return value.GetValueAsUnsigned() if value and value.IsValid() else 0


def breakpoint_callback(frame, _location, _dictionary):
    try:
        process = frame.GetThread().GetProcess()
        if _register(frame, "x6") < 16:
            return False
        iv = _memory(process, _register(frame, "x4"), 16)
        block = _memory(process, _register(frame, "x5"), 16)
        if len(iv) != 16 or len(block) != 16:
            return False
        matches = [value["database"] for value in TARGETS.values() if value["iv"] == iv and value["block"] == block]
        if not matches:
            return False
        key = _memory(process, _register(frame, "x2"), 32)
        if len(key) != 32 or key == bytes(32):
            return False
        for name in set(matches):
            CAPTURED[name] = {"enc_key": key.hex(), "captured_at": int(time.time() * 1000)}
        _save()
        target_count = len(set(value["database"] for value in TARGETS.values()))
        print("KEYSCAN matched={} remaining={}".format(len(CAPTURED), max(0, target_count - len(CAPTURED))))
    except Exception as error:
        print("KEYSCAN callback_error={}".format(type(error).__name__))
    return False


def __lldb_init_module(debugger, _internal_dict):
    if not TARGETS_PATH or not OUTPUT_PATH:
        print("KEYSCAN configuration_missing")
        return
    _load_targets()
    _load_captured()
    target = debugger.GetSelectedTarget()
    breakpoint = target.BreakpointCreateByName("___lldb_unnamed_symbol_4c3068c", "wechat.dylib")
    breakpoint.SetScriptCallbackFunction("lldb_key_capture.breakpoint_callback")
    breakpoint.SetAutoContinue(True)
    print("KEYSCAN ready targets={} fingerprints={} captured={}".format(len(set(value["database"] for value in TARGETS.values())), len(TARGETS), len(CAPTURED)))
