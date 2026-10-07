"""Scan ONE VST3 plug-in with pedalboard and print a JSON description to stdout.

Usage: python -I scan-plugin.py <path-to.vst3>
Errors are reported as {"error": "..."} with exit code 1.
"""
import json
import re
import struct
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


def juce_b64_encode(data):
    """JUCE MemoryBlock::toBase64Encoding (inverse of juce_b64_decode)."""
    nbits = len(data) * 8
    chars = []
    for i in range((nbits + 5) // 6):
        v = 0
        for b in range(6):
            bit = i * 6 + b
            if bit < nbits and data[bit >> 3] >> (bit & 7) & 1:
                v |= 1 << b
        chars.append(JUCE_B64[v])
    return "%d.%s" % (len(data), "".join(chars))


def vc2(xml_text):
    body = xml_text.encode("utf-8") + b"\x00"
    return b"VC2!" + struct.pack("<I", len(body)) + body


def raw_with_xml(raw, new_xml):
    """raw_state with the plug-in's XML state replaced by new_xml, or None if the layout is unknown.

    Handles JUCE's VST3 wrapper (VC2! <VST3PluginState><IComponent>base64(VC2! xml)</IComponent>...)
    and a direct VC2! XML state.
    """
    if raw[:4] != b"VC2!":
        return None
    size = struct.unpack_from("<I", raw, 4)[0]
    outer = raw[8:8 + size].rstrip(b"\x00").decode("utf-8", errors="replace")
    m = re.search(r"<IComponent>(.*?)</IComponent>", outer, re.S)
    if not m:
        return vc2(new_xml) if outer.lstrip().startswith("<") else None
    payload = m.group(1).strip()
    if re.match(r"^\d+\.", payload):
        dec = juce_b64_decode(payload)
        if dec[:4] != b"VC2!":
            return None
        inner = juce_b64_encode(vc2(new_xml))
    elif payload.startswith("<"):
        inner = new_xml
    else:
        return None
    return vc2(outer[:m.start(1)] + inner + outer[m.end(1):])


ID_KEY = re.compile(r"^([^\s\[\]@]+)\[id=(.*)\]@([^\s\[\]@=]+)$")


def set_xml_attr(xml, key, value):
    """Set one attribute (a key as xml_attr_map names it) in the XML text; None if not found."""
    m = ID_KEY.match(key)
    if not m:
        r = re.search(r'\s%s="([^"]*)"' % re.escape(key), xml)
        return xml[:r.start(1)] + value + xml[r.end(1):] if r else None
    tag, ident, attr = m.groups()
    for t in re.finditer(r"<%s(?=[\s/>])[^>]*>" % re.escape(tag), xml):
        idm = re.search(r'\sid="([^"]*)"', t.group(0))
        if not idm or idm.group(1) != ident:
            continue
        a = re.search(r'\s%s="([^"]*)"' % re.escape(attr), t.group(0))
        if not a:
            return None
        return xml[:t.start() + a.start(1)] + value + xml[t.start() + a.end(1):]
    return None


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


SCHEMA = 2
POWERS = [1e-3, 1e-2, 1e-1, 10.0, 100.0, 1000.0]


NUM_TEXT = re.compile(r"^\s*([-+]?(?:\d+\.?\d*|\.\d+))\s*([^\d\s.+-][^\d]*)?$")


def numeric_values(prm):
    """Choice texts that are all numbers with one shared unit ("-12 st", "135.0 BPM"):
    (sorted numbers, unit) or None."""
    nums, units = [], set()
    for v in get(prm, "valid_values", None) or []:
        m = NUM_TEXT.match(str(v))
        if not m:
            return None
        nums.append(float(m.group(1)))
        units.add((m.group(2) or "").strip())
    return (sorted(nums), units.pop()) if len(nums) >= 2 and len(units) == 1 else None


def ptype(prm):
    """float, bool, number (a choice list of numbers, used like a float) or choice (text)."""
    t = get(prm, "type", None)
    if t is str:
        return "number" if numeric_values(prm) else "choice"
    return "float" if t is float else "bool" if t is bool else None


def value_range(prm):
    """(min, max, step) of a float or number parameter, in display units."""
    if ptype(prm) == "number":
        nums = numeric_values(prm)[0]
        diffs = [b - a for a, b in zip(nums, nums[1:]) if b > a]
        return nums[0], nums[-1], min(diffs) if diffs else 0
    step = max(get(prm, "step_size", None) or 0, get(prm, "approximate_step_size", None) or 0)
    return get(prm, "min_value"), get(prm, "max_value"), step


def display(prm):
    """The parameter's current value as pedalboard shows it: a number, a bool or choice text."""
    from pedalboard._pedalboard import strip_common_float_suffixes
    t = ptype(prm)
    if t == "bool":
        return prm.raw_value >= 0.5
    if t == "float":
        return float(strip_common_float_suffixes(prm.string_value))
    if t == "number":
        return float(NUM_TEXT.match(str(prm.string_value)).group(1))
    return str(prm.string_value)


def quantum(prm):
    """The resolution of the displayed text ("15.2 kHz" -> 100), in display units."""
    try:
        text = str(prm.string_value)
    except Exception:
        return 0
    m = re.search(r"[-+]?\d+(?:\.(\d+))?", text)
    if not m:
        return 0
    q = 10.0 ** -len(m.group(1) or "")
    return q * 1000 if text.strip().lower().endswith("khz") else q


def num(text):
    try:
        v = float(text)
    except (TypeError, ValueError):
        return None
    return v if v == v and abs(v) != float("inf") else None


def fmt(v, like):
    """A state number as text, integral when the default value was written that way."""
    if abs(v - round(v)) < 1e-9 and re.match(r"^[-+]?\d+$", str(like or "")):
        return str(int(round(v)))
    return repr(round(v, 9))


def scale_out(a, b):
    """{a, b} -> the catalog's stateScale: a bare factor when b is 0."""
    a = float("%.10g" % a)
    b = float("%.10g" % b)
    return a if abs(b) < 1e-12 else {"a": a, "b": b}


class Prober:
    """Loads edited XML states into the plug-in and reads a parameter's display back."""

    def __init__(self, plugin, base_raw, base_xml):
        self.p = plugin
        self.raw = base_raw
        self.xml = base_xml.rstrip("\x00")
        self.ok = raw_with_xml(base_raw, self.xml) is not None
        self.dirty = False

    def read(self, prm, key, text):
        """Display of prm after setting state attribute `key` to `text`; None if it cannot be done."""
        if not self.ok:
            return None
        x = set_xml_attr(self.xml, key, text)
        raw = raw_with_xml(self.raw, x) if x is not None else None
        if raw is None:
            return None
        try:
            self.p.raw_state = raw
            self.dirty = True
            return display(prm)
        except Exception:
            return None

    def reset(self):
        if self.dirty:
            try:
                self.p.raw_state = self.raw
            except Exception:
                pass
            self.dirty = False


def verify_float(prm, attr, s0txt, d0, pr):
    s0 = num(s0txt)
    lo, hi, step = value_range(prm)
    if s0 is None or not isinstance(d0, float) or not isinstance(lo, (int, float)) or not isinstance(hi, (int, float)) or hi <= lo:
        return None
    lo, hi = float(lo), float(hi)
    span = hi - lo
    tol = max(step, span * 0.002) * 1.01
    cands = [(1.0, 0.0), (1.0 / span, -lo / span)] + [(k, 0.0) for k in POWERS]
    fits_default = [(a, b) for a, b in cands if abs(a * d0 + b - s0) <= abs(a) * tol + 1e-9 * max(1.0, abs(s0))]
    seen = []  # (state, display) pairs read inside the range, for a general linear fit

    def probe(a, b):
        for f in (0.25, 0.75):
            d = lo + f * span
            got = pr.read(prm, attr, fmt(a * d + b, s0txt))
            if got is None:
                return None
            if not isinstance(got, float):
                return False
            if lo + tol < got < hi - tol:
                seen.append((a * d + b, got))
            if abs(got - d) > max(tol, quantum(prm) * 1.01):
                return False
        return True

    if not pr.ok:
        # No way to load a state: accept only when the default point allows exactly one mapping.
        maps = {(round(a, 12), round(b, 12)) for a, b in fits_default}
        return scale_out(*fits_default[0]) if len(maps) == 1 and abs(d0) > tol else None
    for a, b in fits_default:
        r = probe(a, b)
        if r:
            return scale_out(a, b)
        if r is None:
            return None
    # A linear map other than the usual ones: fit it from what the probes read, then check it.
    pts = sorted(set((round(s, 12), round(d, 9)) for s, d in seen), key=lambda t: t[1])
    if len(pts) >= 2 and pts[-1][1] - pts[0][1] > tol * 4:
        (s1, d1), (s2, d2) = pts[0], pts[-1]
        a = (s2 - s1) / (d2 - d1)
        b = s1 - a * d1
        if a != 0 and abs(a * d0 + b - s0) <= abs(a) * tol + 1e-9 * max(1.0, abs(s0)):
            mid = lo + 0.5 * span
            got = pr.read(prm, attr, fmt(a * mid + b, s0txt))
            if isinstance(got, float) and abs(got - mid) <= tol:
                return scale_out(a, b)
    return None


def verify_bool(prm, attr, s0txt, d0, pr):
    t = str(s0txt).strip().lower()
    if t in ("true", "false"):
        cur, flip = t == "true", ("false" if t == "true" else "true")
    else:
        v = num(t)
        if v not in (0.0, 1.0):
            return None
        cur, flip = v == 1.0, fmt(1.0 - v, s0txt)
    if cur != bool(d0):
        return None
    if not pr.ok:
        return 1
    got = pr.read(prm, attr, flip)
    return 1 if isinstance(got, bool) and got != cur else None


def verify_choice(prm, attr, s0txt, d0, pr):
    vals = [str(v) for v in get(prm, "valid_values", None) or []]
    t = str(s0txt).strip().lower()
    s0 = 1.0 if t == "true" else 0.0 if t == "false" else num(s0txt)
    n = len(vals)
    if s0 is None or n < 2 or d0 not in vals:
        return None
    i0 = vals.index(d0)
    # index, normalised index, or index with an offset (a pan stored as -50..50 for 101 choices)
    opts = [(1.0, 0.0), (1.0 / (n - 1), 0.0), (1.0, float(round(s0 - i0)))]
    cands = []
    for a, b in opts:
        if abs(a * i0 + b - s0) <= abs(a) * 0.01 and (a, b) not in cands:
            cands.append((a, b))
    for a, b in cands:
        if not pr.ok:
            return scale_out(a, b) if len(cands) == 1 and i0 != 0 else None
        good = True
        for i in sorted({1, n - 2}):
            got = pr.read(prm, attr, fmt(a * i + b, s0txt))
            if got != str(vals[i]):
                good = False
                break
        if good:
            return scale_out(a, b)
    return None


def verify_scales(plugin, base_raw, base_xml, base_attrs, items, state_keys):
    """Per mapped key: how the state stores the value pedalboard displays (state = a * display + b).

    -> (stateScale {key: factor | {a, b}}, unverifiedKeys [key]). A key is verified when its default
    state value matches the displayed default and, where an edited state can be loaded into the
    plug-in, writing values through the mapping makes the plug-in display them.
    """
    scales, unverified = {}, []
    pr = Prober(plugin, base_raw, base_xml)
    defaults = {}
    for k, attr in state_keys.items():
        prm = items.get(k)
        try:
            defaults[k] = display(prm) if prm is not None else None
        except Exception:
            defaults[k] = None
    try:
        for k, attr in state_keys.items():
            prm = items.get(k)
            t = ptype(prm) if prm is not None else None
            s0txt = base_attrs.get(attr)
            res = None
            try:
                if t in ("float", "number"):
                    res = verify_float(prm, attr, s0txt, defaults[k], pr)
                elif t == "bool":
                    res = verify_bool(prm, attr, s0txt, defaults[k], pr)
                elif t == "choice":
                    res = verify_choice(prm, attr, s0txt, defaults[k], pr)
            except Exception:
                res = None
            pr.reset()
            if res is None:
                unverified.append(k)
            else:
                scales[k] = res
    finally:
        pr.reset()
    return scales, unverified


def main(path):
    from pedalboard import load_plugin

    p = load_plugin(path)
    params = []
    items = list(p.parameters.items())
    for key, prm in items:
        raw_default = get(prm, "default_raw_value", None)
        entry = {
            "key": key,
            "name": get(prm, "name", key),
            "label": get(prm, "label", "") or "",
            "min": get(prm, "min_value"),
            "max": get(prm, "max_value"),
            "default": raw_default,
            "isBoolean": bool(get(prm, "is_boolean", False)),
            "isDiscrete": bool(get(prm, "is_discrete", False)),
            "type": ptype(prm),
        }
        if entry["type"] in ("choice", "number"):
            entry["choices"] = len(get(prm, "valid_values", None) or [])
        if entry["type"] == "number":
            nv = numeric_values(prm)
            entry["min"], entry["max"] = nv[0][0], nv[0][-1]
            entry["label"] = entry["label"] or nv[1]
        params.append(entry)
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
    state_scale, unverified = {}, []
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
        # (d) how each mapped attribute stores the displayed value (e.g. 0..1 for a 0..100 %).
        state_scale, unverified = verify_scales(p, base_raw, base_xml, base_attrs, dict(items), state_keys)
    method = "+".join(methods) if methods else None

    result = {
        "schema": SCHEMA,
        "name": get(p, "name", None) or path.replace("\\", "/").split("/")[-1],
        "vendor": get(p, "manufacturer_name", None) or "",
        "isInstrument": bool(get(p, "is_instrument", False)),
        "params": params,
        "capabilities": {
            "hostParams": host_params,
            "stateRoundTrip": state_round_trip,
            "xmlState": xml_state,
        },
        "stateKeys": state_keys,
        "stateKeyMethod": method,
        "stateScale": state_scale,
        "unverifiedKeys": unverified,
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
