"""Scan ONE VST3 plug-in with pedalboard and print a JSON description to stdout.

Usage: python -I scan-plugin.py <path-to.vst3>
Errors are reported as {"error": "..."} with exit code 1.
"""
import json
import re
import sys

JUCE_B64 = ".ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+"
MAX_DIFF_PARAMS = 400


def juce_b64_decode(text):
    """Decode JUCE MemoryBlock::toBase64Encoding ("<size>.<data>", 6 bits per char, LSB first)."""
    dot = text.find(".")
    size = int(text[:dot])
    data = text[dot + 1:]
    out = bytearray(size + 2)
    pos = 0
    for ch in data:
        idx = JUCE_B64.find(ch)
        if idx < 0:
            continue
        for b in range(6):
            if idx >> b & 1:
                bit = pos + b
                if bit >> 3 < len(out):
                    out[bit >> 3] |= 1 << (bit & 7)
        pos += 6
    return bytes(out[:size])


def extract_xml(raw):
    """Return the plug-in's own XML state text from raw_state, or None."""
    try:
        text = raw.decode("utf-8", errors="replace")
    except Exception:
        return None
    m = re.search(r"<IComponent>(.*?)</IComponent>", text, re.S)
    if m:
        payload = m.group(1).strip()
        if re.match(r"^\d+\.", payload):
            try:
                dec = juce_b64_decode(payload)
            except Exception:
                return None
            j = dec.find(b"<")
            if dec[:4] == b"VC2!" and j >= 0:
                return dec[j:].decode("utf-8", errors="replace")
            if j >= 0 and dec.lstrip()[:5] == b"<?xml":
                return dec[j:].decode("utf-8", errors="replace")
            return None
        if payload.startswith("<?xml") or payload.startswith("<"):
            return payload
    # Direct JUCE state: "VC2!" + u32 + XML
    i = raw.find(b"VC2!")
    if i >= 0:
        j = raw.find(b"<", i)
        if j >= 0:
            return raw[j:].decode("utf-8", errors="replace")
    return None


def xml_attrs(xml):
    """Flat {attrName: value} of every attribute in the XML text (first occurrence wins)."""
    attrs = {}
    for m in re.finditer(r'([A-Za-z_][\w.\-:]*)="([^"]*)"', xml):
        attrs.setdefault(m.group(1), m.group(2))
    return attrs


def norm(s):
    return re.sub(r"[_\s]+", "", s).lower()


def is_bypass(key, prm):
    n = (getattr(prm, "name", "") or key).lower()
    return "bypass" in key.lower() or "bypass" in n


def get(prm, attr, default=None):
    try:
        return getattr(prm, attr)
    except Exception:
        return default


def main(path):
    from pedalboard import load_plugin

    p = load_plugin(path)
    params = []
    items = list(p.parameters.items())
    for key, prm in items:
        raw_default = get(prm, "default_raw_value", None)
        params.append({
            "key": key,
            "name": get(prm, "name", key),
            "label": get(prm, "label", "") or "",
            "min": get(prm, "min_value"),
            "max": get(prm, "max_value"),
            "default": raw_default,
            "isBoolean": bool(get(prm, "is_boolean", False)),
            "isDiscrete": bool(get(prm, "is_discrete", False)),
        })
    non_bypass = [(k, v) for k, v in items if not is_bypass(k, v)]
    host_params = len(non_bypass) > 0

    state_round_trip = False
    xml_state = False
    state_keys = {}
    method = None

    try:
        base_raw = bytes(p.raw_state)
    except Exception:
        base_raw = b""
    base_xml = extract_xml(base_raw) if base_raw else None
    xml_state = base_xml is not None

    if host_params:
        try:
            k, prm = non_bypass[0]
            old = prm.raw_value
            new = 0.73 if abs(old - 0.73) > 0.05 else 0.27
            prm.raw_value = new
            raw2 = bytes(p.raw_state)
            q = load_plugin(path)
            q.raw_state = raw2
            state_round_trip = abs(q.parameters[k].raw_value - new) < 0.02
            prm.raw_value = old
        except Exception:
            state_round_trip = False

    if xml_state:
        base_attrs = xml_attrs(base_xml)
        # Method 1: drive each param through the plug-in and diff the XML attributes.
        if state_round_trip and len(non_bypass) <= MAX_DIFF_PARAMS:
            for k, prm in non_bypass:
                try:
                    old = prm.raw_value
                    prm.raw_value = 0.37 if abs(old - 0.37) > 0.05 else 0.81
                    x = extract_xml(bytes(p.raw_state))
                    prm.raw_value = old
                    if x is None:
                        continue
                    a = xml_attrs(x)
                    changed = [n for n in a if base_attrs.get(n) != a[n]]
                    if len(changed) == 1:
                        state_keys[k] = changed[0]
                except Exception:
                    continue
            if state_keys:
                method = "state-diff"
        # Method 2: normalised-name match against XML attribute names.
        by_norm = {}
        for n in base_attrs:
            by_norm.setdefault(norm(n), n)
        added = 0
        for k, _ in non_bypass:
            if k in state_keys:
                continue
            hit = by_norm.get(norm(k))
            if hit:
                state_keys[k] = hit
                added += 1
        if added:
            method = "state-diff+name-match" if method else "name-match"

    result = {
        "name": get(p, "name", None) or path.replace("\\", "/").split("/")[-1],
        "vendor": get(p, "manufacturer_name", None) or "",
        "params": params,
        "capabilities": {
            "hostParams": host_params,
            "stateRoundTrip": state_round_trip,
            "xmlState": xml_state,
        },
        "stateKeys": state_keys,
        "stateKeyMethod": method,
    }
    sys.stdout.write(json.dumps(result) + "\n")


if __name__ == "__main__":
    try:
        main(sys.argv[1])
    except BaseException as e:  # noqa: BLE001
        sys.stdout.write(json.dumps({"error": f"{type(e).__name__}: {e}"}) + "\n")
        sys.exit(1)
