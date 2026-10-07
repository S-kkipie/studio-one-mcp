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


def xml_attr_map(xml):
    """Map attribute keys of the XML state to their values.

    Plain attributes are keyed by bare name (first occurrence wins). Attributes of an
    element that carries an `id` (JUCE APVTS style: <PARAM id="x" value="..."/>) are keyed
    "TAG[id=x]@attr" so that a shared attribute name never collides.
    """
    import xml.etree.ElementTree as ET
    attrs = {}
    try:
        root = ET.fromstring(re.sub(r"^\s*<\?xml[^>]*\?>", "", xml).strip())
        for el in root.iter():
            ident = el.attrib.get("id")
            for n, v in el.attrib.items():
                if ident is not None and n != "id":
                    attrs.setdefault("%s[id=%s]@%s" % (el.tag, ident, n), v)
                else:
                    attrs.setdefault(n, v)
        return attrs
    except Exception:
        pass
    for m in re.finditer(r'([A-Za-z_][\w.\-:]*)="([^"]*)"', xml):
        attrs.setdefault(m.group(1), m.group(2))
    return attrs


def xml_attrs(xml):
    return xml_attr_map(xml)


def norm(s):
    return re.sub(r"[_\s]+", "", s).lower()


SYNONYMS = {"lo": "low", "hi": "high", "mid": "middle", "l": "left", "r": "right",
            "freq": "frequency"}


def signature(s):
    """Token signature: split on _/space/camelCase, lowercase, expand synonyms."""
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", s)
    toks = [t for t in re.split(r"[^A-Za-z0-9]+", s) if t]
    return "".join(SYNONYMS.get(t.lower(), t.lower()) for t in toks)


def unique_claims(candidates):
    """candidates: {param key: attr}. Drop every attr claimed by more than one key."""
    counts = {}
    for a in candidates.values():
        counts[a] = counts.get(a, 0) + 1
    return {k: a for k, a in candidates.items() if counts[a] == 1}


def plugin_binaries(path):
    import os
    if os.path.isfile(path):
        return [path]
    out = []
    for dp, _, fs in os.walk(os.path.join(path, "Contents")):
        out += [os.path.join(dp, f) for f in fs if f.lower().endswith((".vst3", ".dll"))]
    return out


def parameters_map(path):
    """Neural-DSP style embedded <parametersMap>: {externalName: stateAttr}. {} if absent."""
    import mmap
    text = None
    for f in plugin_binaries(path):
        try:
            with open(f, "rb") as fh, mmap.mmap(fh.fileno(), 0, access=mmap.ACCESS_READ) as mm:
                i = mm.find(b"<parametersMap")
                if i < 0:
                    continue
                j = mm.find(b"</parametersMap>", i)
                if j < 0:
                    continue
                text = mm[i:j + 16].decode("utf-8", errors="replace")
                break
        except Exception:
            continue
    if text is None:
        return {}
    text = re.sub(r"<!--.*?-->", "", text, flags=re.S)
    names = {}
    for m in re.finditer(r"<(\w+)\s([^>]*?property=\"[^\"]*\"[^>]*?)/?>", text, re.S):
        at = dict(re.findall(r'([\w.\-:]+)\s*=\s*"([^"]*)"', m.group(2)))
        prop = at.get("property", "")
        attr = prop.rsplit(":", 1)[-1].rsplit("/", 1)[-1]
        if not attr:
            continue
        ext = at.get("externalName") or at.get("externalID") or attr
        names.setdefault(ext, set()).add(attr)
    return {n: next(iter(a)) for n, a in names.items() if len(a) == 1}


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

    methods = []
    xml_attr_names = []
    unmapped = []
    if xml_state:
        base_attrs = xml_attr_map(base_xml)
        xml_attr_names = sorted(base_attrs)
        # (a) vendor adapter: embedded <parametersMap> (Neural DSP).
        vmap = parameters_map(path)
        if vmap:
            by_name = {}
            for k, prm in non_bypass:
                by_name.setdefault(get(prm, "name", k), []).append(k)
            cand = {}
            for ext, attr in vmap.items():
                ks = by_name.get(ext, [])
                if len(ks) == 1:
                    cand[ks[0]] = attr
            got = unique_claims(cand)
            if got:
                state_keys.update(got)
                methods.append("vendor-parametersMap")
        # (b) drive each param through the plug-in and diff the XML attributes.
        if state_round_trip and len(non_bypass) <= MAX_DIFF_PARAMS:
            cand = {}
            for k, prm in non_bypass:
                if k in state_keys:
                    continue
                try:
                    old = prm.raw_value
                    prm.raw_value = 0.37 if abs(old - 0.37) > 0.05 else 0.81
                    x = extract_xml(bytes(p.raw_state))
                    prm.raw_value = old
                    if x is None:
                        continue
                    a = xml_attr_map(x)
                    changed = [n for n in a if base_attrs.get(n) != a[n]]
                    if len(changed) == 1:
                        cand[k] = changed[0]
                except Exception:
                    continue
            taken = set(state_keys.values())
            got = {k: a for k, a in unique_claims(cand).items() if a not in taken}
            if got:
                state_keys.update(got)
                methods.append("state-diff")
        # (c) fallback: synonym-normalised signature match on key and display name,
        # accepted only when unique on both sides.
        sig_index = {}
        for n in base_attrs:
            if "[" not in n:
                sig_index.setdefault(signature(n), set()).add(n)
        for n in base_attrs:  # APVTS id values act as names too
            m = re.match(r"^[^\[]+\[id=(.*)\]@value$", n)
            if m:
                sig_index.setdefault(signature(m.group(1)), set()).add(n)
        taken = set(state_keys.values())
        cand = {}
        for k, prm in non_bypass:
            if k in state_keys:
                continue
            hits = set()
            for nm in (k, get(prm, "name", "") or ""):
                hits |= sig_index.get(signature(nm), set()) if nm else set()
            hits = {h for h in hits if h not in taken}
            if len(hits) == 1:
                cand[k] = next(iter(hits))
        got = unique_claims(cand)
        if got:
            state_keys.update(got)
            methods.append("name-match")
        unmapped = [k for k, _ in non_bypass if k not in state_keys]
    method = "+".join(methods) if methods else None

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
        "xmlAttrs": xml_attr_names,
        "unmappedKeys": unmapped,
    }
    sys.stdout.write(json.dumps(result) + "\n")


if __name__ == "__main__":
    try:
        main(sys.argv[1])
    except BaseException as e:  # noqa: BLE001
        sys.stdout.write(json.dumps({"error": f"{type(e).__name__}: {e}"}) + "\n")
        sys.exit(1)
