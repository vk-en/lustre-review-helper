"""Write the Gerrit worker's private lreview config to stdout."""

import json
import os
import sys
from pathlib import Path


def toml_value(value):
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False).replace("\x7f", "\\u007f")
    if isinstance(value, list):
        return "[" + ", ".join(map(toml_value, value)) + "]"
    if isinstance(value, dict):
        return "{ " + ", ".join(f"{toml_value(k)} = {toml_value(v)}" for k, v in value.items()) + " }"
    if isinstance(value, (bool, int, float)):
        return str(value).lower()
    return value.isoformat()  # TOML dates and times


def main():
    path = Path(os.environ.get("LREVIEW_CONFIG") or "~/.config/lreview/lreview-config.toml").expanduser()
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        return
    # Only a TOML boolean can enable posting. Keep the original file verbatim
    # when there is nothing to override, including lreview's own diagnostics.
    if b"true" in raw:
        import tomllib
        config = tomllib.loads(raw.decode("utf-8"))
        run = config.get("run", {})
        if isinstance(run, dict) and run.get("post", config.get("post")) is True:
            config["run"] = {**run, "post": False}
            raw = "".join(f"{toml_value(k)} = {toml_value(v)}\n" for k, v in config.items()).encode("utf-8")
    sys.stdout.buffer.write(raw)


if __name__ == "__main__":
    main()
