"""Apply parameter changes to a VST3 plug-in's saved state with pedalboard.

Usage: python -I apply-state.py <plugin.vst3> <state_in.vstpreset> <changes.json> <out.json>
       python -I apply-state.py --selftest

The plug-in is loaded, given the preset's component (Comp) and controller (Cont) state as
pedalboard's raw_state, the changes are applied by parameter key, and the new state is read back.
changes.json: {"<param key>": value}; value is a number or bool (the plug-in's own units, as
pedalboard takes them), a string (display text, e.g. a choice), or {"normalized": 0..1}.
out.json: {"comp": base64, "cont": base64 | null, "applied": [keys], "missing": [keys]}.
Errors go to stderr with exit code 1.
"""
import base64
import json
import re
import struct
import sys

JUCE_B64 = ".ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+"


def juce_b64_decode(text):
    """JUCE MemoryBlock::fromBase64Encoding: "<size>.<chars>", 6 bits per char, LSB first."""
    dot = text.find(".")
    size = int(text[:dot])
    out = bytearray(size + 2)
    pos = 0
    for ch in text[dot + 1:]:
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
    """JUCE MemoryBlock::toBase64Encoding."""
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


def read_vstpreset(buf):
    if buf[:4] != b"VST3":
        raise ValueError("not a VST3 preset")
    list_off = struct.unpack_from("<q", buf, 40)[0]
    if buf[list_off:list_off + 4] != b"List":
        raise ValueError("not a VST3 preset: bad chunk list")
    count = struct.unpack_from("<i", buf, list_off + 4)[0]
    chunks = {}
    for i in range(count):
        p = list_off + 8 + i * 20
        cid = buf[p:p + 4].decode("latin1")
        off, size = struct.unpack_from("<qq", buf, p + 4)
        chunks[cid] = buf[off:off + size]
    return chunks


def to_raw_state(comp, cont):
    """JUCE VST3PluginInstance state: copyXmlToBinary(<VST3PluginState><IComponent/>[<IEditController/>])."""
    xml = '<?xml version="1.0" encoding="UTF-8"?>\n\n<VST3PluginState><IComponent>%s</IComponent>' % juce_b64_encode(comp)
    if cont:
        xml += "<IEditController>%s</IEditController>" % juce_b64_encode(cont)
    xml += "</VST3PluginState>"
    body = xml.encode("utf-8") + b"\x00"
    return b"VC2!" + struct.pack("<I", len(body)) + body


def from_raw_state(raw):
    text = raw.decode("utf-8", errors="replace")
    comp = re.search(r"<IComponent>(.*?)</IComponent>", text, re.S)
    cont = re.search(r"<IEditController>(.*?)</IEditController>", text, re.S)
    if not comp:
        raise ValueError("pedalboard state has no IComponent")
    return juce_b64_decode(comp.group(1).strip()), (juce_b64_decode(cont.group(1).strip()) if cont else None)


def apply_changes(plugin, changes):
    applied, missing = [], []
    params = plugin.parameters
    for key, value in changes.items():
        if key not in params:
            missing.append(key)
            continue
        try:
            if isinstance(value, dict) and "normalized" in value:
                params[key].raw_value = float(value["normalized"])
            else:
                setattr(plugin, key, value)
            applied.append(key)
        except Exception:
            missing.append(key)
    return applied, missing


def selftest():
    for data in [b"", b"a", b"ab", b"abc", bytes(range(256)) * 3]:
        assert juce_b64_decode(juce_b64_encode(data)) == data, data[:8]
    comp, cont = from_raw_state(to_raw_state(b"VC2!xyz", b"ctl"))
    assert (comp, cont) == (b"VC2!xyz", b"ctl")
    assert from_raw_state(to_raw_state(b"q", b""))[1] is None
    print(json.dumps({"ok": True}))


def main(argv):
    if argv[1:] == ["--selftest"]:
        return selftest()
    if len(argv) != 5:
        raise SystemExit(__doc__)
    plugin_path, state_in, changes_path, out_path = argv[1:]
    with open(state_in, "rb") as f:
        chunks = read_vstpreset(f.read())
    with open(changes_path, "r", encoding="utf-8") as f:
        changes = json.load(f)
    from pedalboard import load_plugin
    plugin = load_plugin(plugin_path)
    plugin.raw_state = to_raw_state(chunks.get("Comp", b""), chunks.get("Cont", b""))
    applied, missing = apply_changes(plugin, changes)
    comp, cont = from_raw_state(plugin.raw_state)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({
            "comp": base64.b64encode(comp).decode("ascii"),
            "cont": base64.b64encode(cont).decode("ascii") if cont is not None else None,
            "applied": applied,
            "missing": missing,
        }, f)


if __name__ == "__main__":
    try:
        main(sys.argv)
    except SystemExit:
        raise
    except Exception as e:
        sys.stderr.write("%s: %s\n" % (type(e).__name__, e))
        sys.exit(1)
