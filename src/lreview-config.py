"""Write the review worker's private lreview config to stdout."""

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
    if raw.strip():
        import tomllib
        config = tomllib.loads(raw.decode("utf-8"))
        run = config.get("run", {})
        changed = False
        if isinstance(run, dict) and run.get("post", config.get("post")) is True:
            run["post"] = False
            config["run"] = run
            changed = True
        # A lens model or effort is itself invalid without --lenses. Both
        # spellings are accepted by lreview. Other subcommands keep their tables.
        if "--lenses" not in sys.argv and isinstance(run, dict):
            for table in (config, run):
                for key in list(table):
                    if key.replace("-", "_") in {"lenses", "lens_model", "lens_effort"}:
                        del table[key]
                        changed = True
        if changed:
            raw = "".join(f"{toml_value(k)} = {toml_value(v)}\n" for k, v in config.items()).encode("utf-8")
    sys.stdout.buffer.write(raw)


if __name__ == "__main__":
    main()
